/**
 * `category merge` 的档位错位（1.0.107，修 `28a13efe`）
 *
 * ## 它治的病
 *
 * `category merge` 声明 write 档，产物却是**源分类消失** —— 与 `category rm`
 * （destructive 档）做的是同一个动作的另一半。后果：只有常规写入批准的 agent
 * 能把一个**还有待办在用的分类**合并掉，全程没有人点头、授权记录里也没有
 * "把哪个并进了哪里"。
 *
 * 三处判据当时还互不自洽：档位是 write、`normalizeGrantArgv` 的 `needsConfirmation`
 * 集合里列着它（删除档才用得上）、目标解析表里没有它（因为没有一档会用到）。
 *
 * ## 修法（卡上建议 ②）
 *
 * 挂 `dynamicRisk`：**源分类下还有待办** → 删除档（不可逆地抹掉一个有人用过的标签）；
 * 源分类是空的 → 仍是写档（那只是标签整理，不该为此打扰人）。
 * 同时补上它自己的目标解析分支（源 → 目标），否则结构闸门会红、
 * 而且授权横幅上会看不到"并进哪里"。
 *
 * ## 本文件盯的是一条链，不是一个点
 *
 * 档位判定 → 门禁 → 授权申请（摘要 + 目标集合）→ 批准 → 真的执行。
 * 少任何一环，症状都是"看起来修了"：要么拦不住，要么批了也做不成。
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '../../../src/main/database/migrations'
import { commands, grantTargetResolverNames } from '../../../src/main/cli/commands'

const db = new Database(':memory:')
vi.mock('../../../src/main/database/index', () => ({
  getDatabase: () => db
}))

/**
 * 拦掉真写凭据文件那一步（原因与 `commands.test.ts` 相同：
 * `writeCredential` 写的是 `~/.deskpartner/credentials.json`，与内存库无关）。
 */
vi.mock('../../../src/cli/credentials', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/cli/credentials')>()
  return { ...actual, writeCredential: vi.fn() }
})

let seq = 0
vi.mock('uuid', () => ({
  v4: () => `cm-uuid-${++seq}`
}))

const { TodoRepository } = await import('../../../src/main/database/todo.repository')
const { CategoryRepository } = await import('../../../src/main/database/category.repository')
const { ProjectRepository } = await import('../../../src/main/database/project.repository')
const { MemoRepository } = await import('../../../src/main/database/memo.repository')
const { SettingsRepository } = await import('../../../src/main/database/settings.repository')
const { AgentRepository } = await import('../../../src/main/database/agent.repository')
const { ReleaseRepository } = await import('../../../src/main/database/release.repository')
const { executeOne, executeApproved } = await import('../../../src/main/cli/commands')

const todoRepo = new TodoRepository()
const categoryRepo = new CategoryRepository()
const projectRepo = new ProjectRepository()
const memoRepo = new MemoRepository()
const settingsRepo = new SettingsRepository()
const agentRepo = new AgentRepository()
const releaseRepo = new ReleaseRepository()

/**
 * deps 必须凑齐门禁那条路要用的仓库：`assertCallerAllowed` 会读 `agentRepo`、
 * 写命令成功后还会 `markWrite` 落审计 —— 少一个就在门禁里 TypeError，
 * 而那种失败看起来像"命令坏了"，其实只是夹具不全。
 */
const deps = {
  todoRepo,
  categoryRepo,
  projectRepo,
  memoRepo,
  settingsRepo,
  agentRepo,
  releaseRepo,
  events: { append: vi.fn() },
  telemetry: { record: vi.fn(), stats: vi.fn(), query: vi.fn(), clear: vi.fn() }
}

const ctx = {
  deps,
  meta: {
    version: 'test',
    dbPath: ':memory:',
    schemaVersion: 45,
    busyTimeoutMs: 5000,
    channels: ['headless' as const],
    via: 'headless' as const,
    startedAt: Date.now()
  },
  interactive: true
}

const AGENT = 'agent:alice'

/** 持证 + 已批准的无人值守调用（写命令要过调用方门禁） */
async function withCredential(extra: Record<string, unknown> = {}) {
  const { token } = agentRepo.issueCredential(AGENT)!
  return { ...ctx, actor: AGENT, interactive: false, credential: token, ...extra } as never
}

function pendingDestructive() {
  return agentRepo.listGrants({ agentId: AGENT, scope: 'destructive', status: 'pending' })
}

beforeAll(() => {
  runMigrations(db)
  agentRepo.register({ id: AGENT, displayName: 'Alice' })
  /**
   * 批准这一步只能由人做（CLI 没有对应命令，`agent:setApproved` 只注册在 IPC 上），
   * 所以夹具里直接调仓储 —— 夹具模拟的是"用户已经在界面上点过同意"。
   */
  agentRepo.setApproved(AGENT, true)
})

beforeEach(() => {
  db.prepare('DELETE FROM todo_categories').run()
  db.prepare('DELETE FROM todos').run()
  db.prepare('DELETE FROM projects').run()
  db.prepare('DELETE FROM categories').run()
  db.prepare('DELETE FROM agent_grants').run()
  seq = 0
  projectRepo.create({ name: '合并测试项目' })
})

/** 建两个分类：源（可选地挂一条待办）+ 目标 */
function twoCategories(opts: { sourceHasTodos: boolean }) {
  const from = categoryRepo.create({ name: '竞争调研', color: '#1', sortOrder: 0 })
  const to = categoryRepo.create({ name: '竞品调研', color: '#2', sortOrder: 1 })
  const todo = opts.sourceHasTodos
    ? todoRepo.create({
        title: '挂在源分类上的待办',
        categoryIds: [from.id],
        projectId: projectRepo.list()[0].id,
        priority: 'normal'
      })
    : null
  return { from, to, todo }
}

describe('category merge 的档位由目标决定（28a13efe）', () => {
  /**
   * 结构闸门（卡上点的"三处判据互不自洽"）。
   *
   * 判据取自实现自己的表，不另写一份名单 —— 另写一份等于把漂移换个地方发生。
   */
  it('挂上了动态档位，且在目标解析表里有自己的分支', () => {
    const cmd = commands.find((c) => c.name === 'category merge')!
    expect(cmd, '命令表里没有 category merge？').toBeTruthy()
    expect(typeof cmd.dynamicRisk, '没有动态档位 —— 档位又只写在静态声明里').toBe('function')
    expect(
      grantTargetResolverNames(),
      '没有目标解析分支 —— 授权横幅上看不出"并进哪里"，且结构闸门该红'
    ).toContain('category merge')
  })

  it('源分类是空的 → 写档：直接执行，不打扰人', async () => {
    const { from, to } = twoCategories({ sourceHasTodos: false })
    const res = await executeOne(
      await withCredential(),
      ['category', 'merge', from.id, to.id, '--yes']
    )

    expect(res.ok, `实际：${res.errorCode} / ${res.message}`).toBe(true)
    expect(
      pendingDestructive().length,
      '空的源分类只是一次标签整理，不该生成删除档申请'
    ).toBe(0)
    expect(categoryRepo.getById(from.id), '合并完成，源分类该没了').toBeNull()
  })

  it('源分类下还有待办 → 删除档：没授权就拦下，且什么都没发生', async () => {
    const { from, to, todo } = twoCategories({ sourceHasTodos: true })
    const res = await executeOne(
      await withCredential({ session: 's1' }),
      ['category', 'merge', from.id, to.id, '--yes']
    )

    expect(res.ok, '还有待办在用的分类被合并掉，不该无声发生').toBe(false)
    expect(res.errorCode).toBe('grant_required')
    expect(categoryRepo.getById(from.id), '被拦下 = 真的没动').not.toBeNull()
    expect(todoRepo.getById(todo!.id)!.categoryIds).toEqual([from.id])
    expect(pendingDestructive().length, '应当落下一条待表态的删除档申请').toBe(1)
  })

  it('申请里写清了"把哪个并进哪里"（摘要两个名字 + 两个目标 id）', async () => {
    const { from, to } = twoCategories({ sourceHasTodos: true })
    await executeOne(await withCredential({ session: 's2' }), [
      'category', 'merge', from.id, to.id, '--yes'
    ])

    const [grant] = pendingDestructive()
    // 横幅与审计记录读的都是它：只写源不写目标，人看不出"并进哪里"
    expect(grant.summary).toContain('竞争调研')
    expect(grant.summary).toContain('竞品调研')
    expect(grant.targetIds.sort()).toEqual([from.id, to.id].sort())
  })

  it('人点头后重试即放行：待办改挂到目标，源分类消失', async () => {
    const { from, to, todo } = twoCategories({ sourceHasTodos: true })
    const c = await withCredential({ session: 's3' })
    await executeOne(c, ['category', 'merge', from.id, to.id, '--yes'])

    const [grant] = pendingDestructive()
    agentRepo.resolveGrant(grant.id, true)

    const retry = await executeOne(c, ['category', 'merge', from.id, to.id, '--yes'])
    expect(retry.ok, `实际：${retry.errorCode} / ${retry.message}`).toBe(true)
    expect(todoRepo.getById(todo!.id)!.categoryIds).toEqual([to.id])
    expect(categoryRepo.getById(from.id)).toBeNull()
  })

  /**
   * 批准即执行（`executeApproved`）那条路：回放的 argv 里**没有 `--yes`**。
   *
   * 授权记录存的是"真正会被执行的东西"，而 `--yes` 是"我确认要删"的语义、
   * 属于批准方的话 —— 调用方在被批准前不会带它。所以执行这一侧必须放行，
   * 否则就是"批了也做不成"（1.0.49 修过一次的同一个坑，`todo delete-comment` 同形状）。
   */
  it('批准即执行放行（回放 argv 里没有 --yes）', async () => {
    const { from, to, todo } = twoCategories({ sourceHasTodos: true })
    const c = await withCredential({ session: 's4' })
    const blocked = await executeOne(c, ['category', 'merge', from.id, to.id])
    expect(blocked.errorCode).toBe('grant_required')

    const [grant] = pendingDestructive()
    expect(grant.requestArgv[0], '申请里记的就是这条命令本身').toBe('category merge')
    // 这条断言是本用例的关键：argv 里真的没有 --yes，才谈得上"执行侧放行"
    expect(grant.requestArgv, '--yes 是批准方的话，调用方在被批准前不会带它').not.toContain('--yes')

    agentRepo.resolveGrant(grant.id, true)
    const executed = await executeApproved(
      ctx as never,
      grant.requestArgv,
      { agentId: AGENT, grantId: grant.id }
    )

    expect(executed.ok, `实际：${executed.errorCode} / ${executed.message}`).toBe(true)
    expect(todoRepo.getById(todo!.id)!.categoryIds).toEqual([to.id])
    expect(categoryRepo.getById(from.id)).toBeNull()
  })

  it('按名字写法（--from / --to）同样认得出档位与目标', async () => {
    const { from, to, todo } = twoCategories({ sourceHasTodos: true })
    const res = await executeOne(
      await withCredential({ session: 's5' }),
      ['category', 'merge', '--from', '竞争调研', '--to', '竞品调研', '--yes']
    )

    expect(res.errorCode, '名字写法也要升级到删除档').toBe('grant_required')
    const [grant] = pendingDestructive()
    expect(grant.targetIds.sort()).toEqual([from.id, to.id].sort())

    agentRepo.resolveGrant(grant.id, true)
    const retry = await executeOne(
      await withCredential({ session: 's5' }),
      ['category', 'merge', '--from', '竞争调研', '--to', '竞品调研', '--yes']
    )
    expect(retry.ok, `实际：${retry.errorCode} / ${retry.message}`).toBe(true)
    expect(todoRepo.getById(todo!.id)!.categoryIds).toEqual([to.id])
  })

  /**
   * 默认分类**不升级**（有意与卡上的那条条件不同）。
   *
   * `CategoryRepository.merge` 对默认分类直接拒（GuardError）—— 升级只会让人
   * 为一件注定失败的事点一次头，正是"不能为注定失败的事去要授权"的反面。
   */
  it('源是默认分类（repo 会直接拒）→ 不制造那次白点头', async () => {
    const { from, to } = twoCategories({ sourceHasTodos: true })
    db.prepare('UPDATE categories SET is_default = 1 WHERE id = ?').run(from.id)

    const res = await executeOne(
      await withCredential({ session: 's6' }),
      ['category', 'merge', from.id, to.id, '--yes']
    )

    expect(res.ok, '默认分类不可被合并掉 —— repo 的守卫该拦住它').toBe(false)
    expect(pendingDestructive().length, '注定失败的事不该生成申请').toBe(0)
    expect(categoryRepo.getById(from.id), '被拒 = 没动').not.toBeNull()
  })

  it('目标解析不出来（id 打错）→ 退回写档，由命令自己报 not_found，不要授权', async () => {
    const { to } = twoCategories({ sourceHasTodos: true })
    const res = await executeOne(
      await withCredential({ session: 's7' }),
      ['category', 'merge', 'deadbeef', to.id, '--yes']
    )

    expect(res.errorCode, '报"找不到分类"比"你没权限"准确').toBe('not_found')
    expect(pendingDestructive().length).toBe(0)
  })

  /**
   * ── 1.0.108：两个端点**读法收口**（bob 驳回 `28a13efe` 的那一半） ──
   *
   * 驳回的通过判据就是这条：**用名字能合并成功**。
   * 此前位置参数走 `resolveId`（只认 id 与前缀）、`--from/--to` 走名字精确匹配 ——
   * 同一条命令两种写法两套读法，而报错还说"找不到分类"，于是 agent 以为分类不存在。
   */
  it('位置参数写**名字**也能合并（驳回的通过判据）', async () => {
    const { from, to } = twoCategories({ sourceHasTodos: false })
    const res = await executeOne(await withCredential({ session: 's8' }), [
      'category', 'merge', '竞争调研', '竞品调研', '--yes'
    ])

    expect(res.ok, `实际：${res.errorCode} / ${res.message}`).toBe(true)
    expect(res.data, '回执要写得清"并进了哪里"').toMatchObject({ merged: '竞争调研', into: '竞品调研' })
    expect(categoryRepo.getById(from.id), '合并完成，源分类该没了').toBeNull()
    expect(categoryRepo.getById(to.id)).not.toBeNull()
  })

  it('名字走位置参数时，**档位判定同样认名字**（不是只有命令本体认得）', async () => {
    const { from, to, todo } = twoCategories({ sourceHasTodos: true })
    const res = await executeOne(await withCredential({ session: 's9' }), [
      'category', 'merge', '竞争调研', '竞品调研', '--yes'
    ])

    expect(
      res.errorCode,
      '名字写法要是判不出档位，就会变成"有名字就没守卫"的第二条路'
    ).toBe('grant_required')
    expect(categoryRepo.getById(from.id), '被拦下 = 真的没动').not.toBeNull()
    expect(todoRepo.getById(todo!.id)!.categoryIds).toEqual([from.id])

    // 混着写（一端名字、一端 id）也是同一套读法
    agentRepo.resolveGrant(pendingDestructive()[0].id, true)
    const mixed = await executeOne(await withCredential({ session: 's9' }), [
      'category', 'merge', '竞争调研', to.id, '--yes'
    ])
    expect(mixed.ok, `实际：${mixed.errorCode} / ${mixed.message}`).toBe(true)
  })

  it('按名字找不到时，报错要**指路**（说清三种写法都收），不是只说"找不到分类"', async () => {
    twoCategories({ sourceHasTodos: false })
    const res = await executeOne(await withCredential({ session: 's10' }), [
      'category', 'merge', '并不存在的分类', '竞品调研', '--yes'
    ])

    expect(res.errorCode).toBe('not_found')
    expect(res.message, '报错里要点出哪一端错了').toContain('第一个参数')
    expect(
      res.message,
      '驳回的原文就是"报错不告诉你只认 id" —— 现在要么收名字，要么说清只收什么：两种都得写出来'
    ).toContain('名字')
    expect(res.message, '还要给出下一步：去哪儿看').toContain('category list')
  })

  it('名字重名时不猜：报错并列出候选 id', async () => {
    const { to } = twoCategories({ sourceHasTodos: false })
    const dup = categoryRepo.create({ name: '竞争调研', color: '#3', sortOrder: 2 })
    const res = await executeOne(await withCredential({ session: 's11' }), [
      'category', 'merge', '竞争调研', to.id, '--yes'
    ])

    expect(res.errorCode, '重名挑了其中一个 = 合并了没被指定的那个分类').toBe('usage_error')
    expect(res.message).toContain('同名')
    expect(res.message, '得把候选 id 摆出来，否则调用方只能去猜').toContain(dup.id)
  })

  it('只给一个位置参数：报错要说清这一条怎么用（含按名字的写法）', async () => {
    twoCategories({ sourceHasTodos: false })
    const res = await executeOne(await withCredential({ session: 's12' }), [
      'category', 'merge', '竞争调研', '--yes'
    ])

    expect(res.errorCode).toBe('usage_error')
    expect(res.message).toContain('--from')
    expect(res.message, '三种写法都要写在提示里').toContain('名字')
  })
})
