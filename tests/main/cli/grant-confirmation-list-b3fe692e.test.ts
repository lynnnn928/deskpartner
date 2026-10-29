/**
 * 「批准即执行」补 `--yes` 的名单必须是**推出来的**（1.0.107，修 `b3fe692e`）
 *
 * ## 它治的病：名单里有两个永远走不到的登记
 *
 * `normalizeGrantArgv` 开头有一道 `riskOf(cmd) !== 'destructive'` 的早返回，
 * 之后的名单却是手写的 8 条 —— 其中 `todo delete-comment` 与 `category merge`
 * 静态档位是 `write`（只有按目标才升级到删除档），**永远走不到那一步**。
 * 读代码的人会以为"这两条也会被补 `--yes`"，而它们其实靠另一条路
 * （`run` 里的 `ctx.preApprovedGrantId`）。
 *
 * 实测 1.0.107：静态删除档恰好 6 条且都声明了 `--yes`；声明了 `--yes` 的命令恰好 8 条
 * —— 与那份手写名单逐字相同。**手写的那份是在抄一个可以从命令表推出来的事实。**
 *
 * ## 本文件盯的四件事
 *
 * ① 推导结果就是那 6 条静态删除档，**不含**两条动态档位（死登记的反面）；
 * ② 每条静态删除档命令都必须声明 `--yes` —— 漏了就会被推导**静默漏掉**
 *    （那正是当年 `814ad86d` 那一类"批了也做不成"）；
 * ③ **行为与改前逐字节一致**：静态删除档命令在"没带 `--yes`"的申请里仍然被补上；
 * ④ 手写名单不再存在（源码闸门）+ 判据认得出残缺（反向验证）。
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { readCliChain } from './cli-chain'
import Database from 'better-sqlite3'
import { runMigrations } from '../../../src/main/database/migrations'

const db = new Database(':memory:')
vi.mock('../../../src/main/database/index', () => ({ getDatabase: () => db }))
vi.mock('../../../src/cli/credentials', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/cli/credentials')>()
  return { ...actual, writeCredential: vi.fn() }
})

const { confirmationCommands, commands, executeOne, riskOf } = await import(
  '../../../src/main/cli/commands'
)
const { TodoRepository } = await import('../../../src/main/database/todo.repository')
const { CategoryRepository } = await import('../../../src/main/database/category.repository')
const { ProjectRepository } = await import('../../../src/main/database/project.repository')
const { MemoRepository } = await import('../../../src/main/database/memo.repository')
const { SettingsRepository } = await import('../../../src/main/database/settings.repository')
const { AgentRepository } = await import('../../../src/main/database/agent.repository')
const { ReleaseRepository } = await import('../../../src/main/database/release.repository')

const todoRepo = new TodoRepository()
const categoryRepo = new CategoryRepository()
const projectRepo = new ProjectRepository()
const agentRepo = new AgentRepository()

const deps = {
  todoRepo,
  categoryRepo,
  projectRepo,
  memoRepo: new MemoRepository(),
  settingsRepo: new SettingsRepository(),
  agentRepo,
  releaseRepo: new ReleaseRepository(),
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

/** 持证 + 已批准的无人值守调用（删除档要过调用方门禁） */
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
  agentRepo.setApproved(AGENT, true)
})

beforeEach(() => {
  db.prepare('DELETE FROM todo_categories').run()
  db.prepare('DELETE FROM todos').run()
  db.prepare('DELETE FROM projects').run()
  db.prepare('DELETE FROM categories').run()
  db.prepare('DELETE FROM agent_grants').run()
  projectRepo.create({ name: '补 yes 名单测试项目' })
  categoryRepo.create({ name: '凑数分类', color: '#111', sortOrder: 0 })
})

/** 一条可删的待办（TodoRepository 找不到兜底分类会 GuardError，所以上面先建一个） */
function aTodo() {
  return todoRepo.create({
    title: '待删',
    categoryIds: [],
    projectId: projectRepo.list()[0].id,
    priority: 'normal'
  })
}

describe('补 --yes 的名单从命令表推导（b3fe692e）', () => {
  /**
   * ① 推导结果 == 静态删除档那 6 条。
   *
   * 期望值写死在这里是**故意的**：它就是改前手写名单减去两条死登记剩下的那些，
   * 逐字相同。哪天有人给某条命令去掉 `--yes` 声明，这条会红，而不是静默少补一个参数。
   */
  it('推导出 6 条静态删除档，且不含两条按目标升级的命令', () => {
    expect([...confirmationCommands()].sort()).toEqual([
      'category rm',
      'memo rm',
      'project rm',
      'release rm',
      'telemetry clear',
      'todo rm'
    ])
    expect(
      confirmationCommands(),
      '按目标升级到删除档的命令不该在这一跳被补 --yes（它们走 preApprovedGrantId）'
    ).not.toContain('category merge')
    expect(confirmationCommands()).not.toContain('todo delete-comment')

    /**
     * 行为口径（比写死清单更直白）：**每一条静态删除档命令都会被补 `--yes`**。
     * 与上面那条合起来就等价于改前的效果 —— 改的那份名单本来也只对静态删除档生效。
     */
    expect(confirmationCommands().sort(), '静态删除档的每一条都必须被补 --yes').toEqual(
      commands
        .filter((c) => riskOf(c) === 'destructive')
        .map((c) => c.name)
        .sort()
    )
  })

  /**
   * 两条动态档位命令**仍然声明着 `--yes`**、静态档位仍然是 write。
   *
   * 这两条断言是"死登记为什么会长出来"的现场证据：名单的隐含判据其实是
   * "有没有 `--yes`"，而函数的前置条件只放静态删除档过去 —— 两个判据错开一格，
   * 那两条就永远走不到。留着它们，是为了让日后改回手写的人看得见这个错位。
   */
  it('两条动态档位命令仍是 write 档、仍声明 --yes（死登记的成因）', () => {
    for (const name of ['category merge', 'todo delete-comment']) {
      const c = commands.find((x) => x.name === name)!
      expect(c, `命令表里没有 ${name}`).toBeTruthy()
      expect(riskOf(c), `${name} 的静态档位变了 —— 死登记的成因描述要跟着改`).toBe('write')
      expect(
        c.args.some((a) => a.flag === '--yes'),
        `${name} 不再声明 --yes —— 本文件第 ① 条与成因描述都要重新看`
      ).toBe(true)
      expect(typeof c.dynamicRisk, `${name} 没有动态档位？`).toBe('function')
    }
  })

  /**
   * ② 每条静态删除档命令都声明 `--yes`。
   *
   * 推导的**前置条件**：漏声明 = 推导漏掉它 = 批准回放仍然缺 `--yes` = "批了也做不成"。
   * 这条闸门把"忘记声明"挡在提交前，而不是等用户在界面上点完允许才发现。
   */
  it('每条静态删除档命令都必须声明 --yes（漏了会被推导静默漏掉）', () => {
    const missing = commands
      .filter((c) => riskOf(c) === 'destructive')
      .filter((c) => !c.args.some((a) => a.flag === '--yes'))
      .map((c) => c.name)
    expect(
      missing,
      '这些删除档命令没有声明 --yes：推导会把它们漏掉，' +
        '而批准即执行回放的 argv 里本来就没有 --yes —— 结果就是"批了也做不成"'
    ).toEqual([])
  })

  /** 反向验证：判据认得出两类残缺（只看 `--yes`、以及删除档但没有 `--yes`） */
  it('反向验证：判据把"只看有没有 --yes"和"删除档但没声明"都判得出来', () => {
    const fake = (over: Record<string, unknown>) =>
      ({ name: 'fake', desc: '', args: [], run: () => ({}), ...over }) as never

    // 只看"有没有 --yes"的写法（死登记就是这么长出来的）：会把 write 档的条目算进来
    const wrongJudge = (list: never[]) =>
      list.filter((c: { args: { flag: string }[] }) => c.args.some((a) => a.flag === '--yes')).map((c: { name: string }) => c.name)
    expect(
      wrongJudge([fake({ name: 'category merge', risk: 'write', args: [{ flag: '--yes', type: 'boolean', desc: 'x' }] })]),
      '按"有没有 --yes"判竟然没把 write 档条目算进来 —— 反向验证本身失效了'
    ).toEqual(['category merge'])

    // 真判据：write 档（哪怕声明了 --yes）不算 —— 死登记的定义
    expect(
      confirmationCommands([
        fake({ name: 'category merge', risk: 'write', args: [{ flag: '--yes', type: 'boolean', desc: 'x' }] })
      ]),
      'write 档的条目被算进来了 —— 名单里又会长出走不到的登记'
    ).toEqual([])

    // 真判据：删除档但没声明 --yes 也不算（闸门 ② 盯的就是这种残缺）
    expect(
      confirmationCommands([fake({ name: 'rm', risk: 'destructive', args: [] })]),
      '没声明 --yes 的删除档条目被算进来了 —— 它会拿到一个命令根本不认识的参数'
    ).toEqual([])

    // 真判据：两个条件都满足才算
    expect(
      confirmationCommands([
        fake({ name: 'rm', risk: 'destructive', args: [{ flag: '--yes', type: 'boolean', desc: 'x' }] })
      ])
    ).toEqual(['rm'])
  })

  /**
   * ③ 行为与改前逐字节一致（真执行路径）。
   *
   * 判据落在**授权记录里的 `requestArgv`** 上：它是账面，也是批准后真正回放的东西。
   */
  it('删除档命令的申请里仍然被补上 --yes（批准回放才跑得通）', async () => {
    const todo = aTodo()
    const res = await executeOne(await withCredential(), ['todo', 'rm', todo.id])
    expect(res.errorCode, '删除档没授权该被拦下').toBe('grant_required')

    const [grant] = pendingDestructive()
    expect(grant, '没有落下删除档申请').toBeTruthy()
    expect(grant.requestArgv[0], '账面记的该是这条命令本身').toBe('todo rm')
    expect(
      grant.requestArgv,
      '申请里没有 --yes —— 批准回放会撞上"删除是破坏性操作，需显式加 --yes"'
    ).toContain('--yes')
  })

  /** 已经带了的**不重复加**（两个 `--yes` 会让解析器犯迷糊） */
  it('调用方已带 --yes 时不再追加一个', async () => {
    const todo = aTodo()
    await executeOne(await withCredential(), ['todo', 'rm', todo.id, '--yes'])
    const [grant] = pendingDestructive()
    expect(grant.requestArgv.filter((a) => a === '--yes').length, '--yes 出现了不止一次').toBe(1)
  })

  /**
   * ④ 源码闸门：手写名单不再存在。
   *
   * 判据是"`normalizeGrantArgv` 的函数体里不出现命令名字面量" ——
   * 留一份手写清单，就留了一条会长出死登记的路（本文件治的正是它）。
   */
  it('normalizeGrantArgv 里没有手写的命令名清单（源码闸门）', () => {
    const src = readCliChain()
    const start = src.indexOf('function normalizeGrantArgv(')
    expect(start, '找不到 normalizeGrantArgv —— 源码闸门失效').toBeGreaterThan(-1)
    /**
     * 切到函数结尾：仓库是 CRLF，且同一文件里也混着纯 LF 行 ——
     * 只认 `\n}\n` 会切不到（切到文件尾，于是把后面所有命令名都算成"手写"）。
     * 用"行首的 `}`"两种换行都认。
     */
    const rest = src.slice(start)
    const end = rest.search(/\r?\n\}\r?\n/)
    expect(end, '找不到 normalizeGrantArgv 的结尾 —— 切法要跟着改').toBeGreaterThan(-1)
    const body = rest.slice(0, end)
    const names = commands.map((c) => c.name)
    const hardCoded = names.filter((n) => body.includes(`'${n}'`))
    expect(
      hardCoded,
      'normalizeGrantArgv 里又出现了手写的命令名 —— 它会与命令表分叉，长出"走不到的登记"'
    ).toEqual([])
    expect(
      body.includes('confirmationCommands'),
      'normalizeGrantArgv 没有走推导 —— 又改回手写了？'
    ).toBe(true)
  })
})
