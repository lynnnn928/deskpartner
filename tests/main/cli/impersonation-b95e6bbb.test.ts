import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runMigrations } from '../../../src/main/database/migrations'

/**
 * 冒名治理第 1 层：声明了身份就不能填别的 agent（b95e6bbb）
 *
 * ── 要拦的是什么 ──
 *
 * 启动器把 `--created-by agent:xxx` 当成**身份声明**，再据此去凭据文件里挑那一份
 * 来完成调用（1.0.37 给 bob 补的兼容）。于是 `DESKPARTNER_AGENT=agent:a`
 * 的一次调用带上 `--created-by agent:b` 时，动作人、动态、提出人**整条链**一起
 * 记成 b —— 卡「谁提的、谁做的」一起错，事后无法还原（601f8ee6）。
 *
 * ── 判据：比的是"这次调用自己给出的两个说法" ──
 *
 * 不信任任何声明，也不需要第三个信息源：矛盾就在这次调用内部。
 * 所以下面每一条用例都在钉**同一件事的不同侧面**：
 *
 * ① 声明 a + 写 b → usage_error，并指路 --executed-by（而且要真的没写进去）；
 * ② 声明 a + 写 a / 不写 → 放行（规则不是"禁止传 --created-by"，是"不许写别人"）；
 * ③ 声明 a + 写 human → 放行（代录一条人提的事是真实用法，本层不管）；
 * ④ 未声明身份（启动器按本机凭据自动带上）→ 放行，1.0.37 的兼容路径原样保留；
 * ⑤ 只传 --created-by 声明身份（launcher 从 argv 推）→ 两个说法一致，放行；
 * ⑥ update 改提出者同样拦，且"改回自己"这条补救路留着；
 * ⑦ batch 逐行走同一条链路，所以 batch 里也拦得住。
 *
 * 每条都写了反向验证（把哪一行拿掉会红）。
 */

const db = new Database(':memory:')
vi.mock('../../../src/main/database/index', () => ({
  getDatabase: () => db
}))

/** 同 commands.test.ts：拦住"写真实凭据文件"那一步（测试不该有宿主副作用） */
vi.mock('../../../src/cli/credentials', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/cli/credentials')>()
  return { ...actual, writeCredential: vi.fn() }
})

let seq = 0
vi.mock('uuid', () => ({
  v4: () => `imp-uuid-${++seq}`
}))

const { TodoRepository } = await import('../../../src/main/database/todo.repository')
const { CategoryRepository } = await import('../../../src/main/database/category.repository')
const { ProjectRepository } = await import('../../../src/main/database/project.repository')
const { MemoRepository } = await import('../../../src/main/database/memo.repository')
const { SettingsRepository } = await import('../../../src/main/database/settings.repository')
const { AgentRepository } = await import('../../../src/main/database/agent.repository')
const { ReleaseRepository } = await import('../../../src/main/database/release.repository')
const { executeOne, buildSchema, findCommand } = await import('../../../src/main/cli/commands')
const { buildAgentGuide } = await import('../../../src/main/cli/agent-guide')

const todoRepo = new TodoRepository()
const categoryRepo = new CategoryRepository()
const projectRepo = new ProjectRepository()
const memoRepo = new MemoRepository()
const settingsRepo = new SettingsRepository()
const agentRepo = new AgentRepository()
const releaseRepo = new ReleaseRepository()

const tmpCred = path.join(os.tmpdir(), `deskpartner-imp-cred-${process.pid}.json`)

const ctx = {
  deps: {
    todoRepo,
    categoryRepo,
    projectRepo,
    memoRepo,
    settingsRepo,
    agentRepo,
    releaseRepo,
    events: { append: vi.fn() },
    telemetry: { record: vi.fn(), stats: vi.fn(), query: vi.fn(), clear: vi.fn() }
  },
  meta: {
    version: 'test',
    dbPath: ':memory:',
    schemaVersion: 11,
    busyTimeoutMs: 5000,
    channels: ['headless' as const],
    via: 'headless' as const,
    startedAt: Date.now()
  },
  interactive: false
}

const countTodos = (): number =>
  (db.prepare('SELECT COUNT(*) AS c FROM todos').get() as { c: number }).c

const tokens = new Map<string, string>()
/** 声明了身份的调用方（launcher 把 DESKPARTNER_AGENT 带进来时就是这个形状） */
const asDeclared = (actor: string) => {
  if (!tokens.has(actor)) tokens.set(actor, agentRepo.issueCredential(actor)!.token)
  return { ...ctx, actor, identityDeclared: true, credential: tokens.get(actor)! }
}
/** 未声明身份：启动器按本机唯一凭据自动带上（identityDeclared=false） */
const asAutoLoaded = (actor: string) => {
  if (!tokens.has(actor)) tokens.set(actor, agentRepo.issueCredential(actor)!.token)
  return { ...ctx, actor, identityDeclared: false, credential: tokens.get(actor)! }
}

beforeAll(() => {
  process.env.DESKPARTNER_CREDENTIALS_FILE = tmpCred
  runMigrations(db)
  for (const [id, name] of [
    ['agent:carol', 'Carol'],
    ['agent:alice', 'Alice'],
    ['agent:bob', 'Bob']
  ]) {
    agentRepo.register({ id, displayName: name })
    agentRepo.setApproved(id, true)
  }
})

afterAll(() => {
  delete process.env.DESKPARTNER_CREDENTIALS_FILE
  try {
    fs.unlinkSync(tmpCred)
  } catch {
    /* 没生成就算了 */
  }
})

beforeEach(() => {
  db.prepare('DELETE FROM todo_transitions').run()
  db.prepare('DELETE FROM todo_categories').run()
  db.prepare('DELETE FROM todos').run()
  db.prepare('DELETE FROM projects').run()
  db.prepare('DELETE FROM categories').run()
  seq = 0
  projectRepo.create({ name: '测试项目' })
  categoryRepo.create({ name: '方向', color: '#1', sortOrder: 0 })
})

describe('冒名治理第 1 层（b95e6bbb）：声明了身份就不能填别的 agent', () => {
  it('① 声明 agent:carol 却写 --created-by agent:alice → usage_error，且真的没写进去', async () => {
    const res = await executeOne(asDeclared('agent:carol') as never, [
      'todo',
      'add',
      '--title',
      '冒名一条',
      '--category',
      '方向',
      '--project',
      '测试项目',
      '--created-by',
      'agent:alice'
    ])
    expect(res.ok).toBe(false)
    expect(res.errorCode).toBe('usage_error')
    // 报错要能照着改：说清"你写了谁""你是谁""该用什么"
    expect(res.message).toContain('agent:alice')
    expect(res.message).toContain('agent:carol')
    expect(res.message).toContain('--executed-by')
    expect(countTodos(), '拦下了却留了一条 —— 报了错还写进去是最坏的一种').toBe(0)
    // 反向验证：把 assertCreatedByNotImpersonating 那一行删掉 → ok=true，本条红。
  })

  it('② 声明 agent:carol 写自己的名字 / 不写：都照常（规则是"不许写别人"）', async () => {
    const mine = await executeOne(asDeclared('agent:carol') as never, [
      'todo',
      'add',
      '--title',
      '我自己提的',
      '--category',
      '方向',
      '--project',
      '测试项目',
      '--created-by',
      'agent:carol'
    ])
    expect(mine.ok).toBe(true)
    expect(todoRepo.getById((mine.data as { id: string }).id)!.createdBy).toBe('agent:carol')

    const omitted = await executeOne(asDeclared('agent:carol') as never, [
      'todo',
      'add',
      '--title',
      '不写提出者',
      '--category',
      '方向',
      '--project',
      '测试项目'
    ])
    expect(omitted.ok).toBe(true)
    expect(todoRepo.getById((omitted.data as { id: string }).id)!.createdBy).toBe('agent:carol')
  })

  it('③ --created-by human 不受限：agent 代录一条用户提的事仍然可以', async () => {
    const res = await executeOne(asDeclared('agent:carol') as never, [
      'todo',
      'add',
      '--title',
      '用户说的事',
      '--category',
      '方向',
      '--project',
      '测试项目',
      '--created-by',
      'human'
    ])
    expect(res.ok).toBe(true)
    expect(todoRepo.getById((res.data as { id: string }).id)!.createdBy).toBe('human')
  })

  it('④ 未声明身份（启动器按本机凭据自动带上）→ 放行：1.0.37 的兼容路径原样保留', async () => {
    const res = await executeOne(asAutoLoaded('agent:carol') as never, [
      'todo',
      'add',
      '--title',
      '未声明身份时的代录',
      '--category',
      '方向',
      '--project',
      '测试项目',
      '--created-by',
      'agent:alice'
    ])
    expect(res.ok).toBe(true)
    expect(todoRepo.getById((res.data as { id: string }).id)!.createdBy).toBe('agent:alice')
    // 反向验证：把 `if (!ctx.identityDeclared) return` 摘掉 → 本条红（会误伤自动带上凭据的路径）。
  })

  it('⑤ 只传 --created-by 声明身份（launcher 从 argv 推）→ 两个说法一致，放行', async () => {
    // 这一档是真实现状：没有环境变量身份时，actor 就是 --created-by 那个值
    const res = await executeOne(asDeclared('agent:bob') as never, [
      'todo',
      'add',
      '--title',
      '以 bob 的身份调用',
      '--category',
      '方向',
      '--project',
      '测试项目',
      '--created-by',
      'agent:bob'
    ])
    expect(res.ok).toBe(true)
    expect(todoRepo.getById((res.data as { id: string }).id)!.createdBy).toBe('agent:bob')
  })

  it('⑥ update 改提出者同样拦，且"改回自己 / 改回 human"这两条补救路留着', async () => {
    const todo = todoRepo.create({ title: '记错人的那条', createdBy: 'human' })
    const bad = await executeOne(asDeclared('agent:carol') as never, [
      'todo',
      'update',
      todo.id,
      '--created-by',
      'agent:bob'
    ])
    expect(bad.ok).toBe(false)
    expect(bad.errorCode).toBe('usage_error')
    expect(todoRepo.getById(todo.id)!.createdBy, '拦下之后不许改动').toBe('human')

    const fixMine = await executeOne(asDeclared('agent:carol') as never, [
      'todo',
      'update',
      todo.id,
      '--created-by',
      'agent:carol'
    ])
    expect(fixMine.ok).toBe(true)
    expect(todoRepo.getById(todo.id)!.createdBy).toBe('agent:carol')

    const fixHuman = await executeOne(asDeclared('agent:carol') as never, [
      'todo',
      'update',
      todo.id,
      '--created-by',
      'human'
    ])
    expect(fixHuman.ok).toBe(true)
    expect(todoRepo.getById(todo.id)!.createdBy).toBe('human')
  })

  it('⑦ batch 逐行走同一条链路：批量里也拦得住', async () => {
    const res = await executeOne(
      {
        ...asDeclared('agent:carol'),
        stdin: JSON.stringify({
          cmd: 'todo add',
          args: { '--title': '批量冒名', '--category': '方向', '--project': '测试项目', '--created-by': 'agent:alice' }
        })
      } as never,
      ['batch']
    )
    expect(res.ok).toBe(false)
    const rows = (res.data as { results: { errorCode?: string; message?: string }[] }).results
    expect(rows[0].errorCode).toBe('usage_error')
    expect(rows[0].message).toContain('--executed-by')
    expect(countTodos()).toBe(0)
  })
})

describe('这条规则在 agent 读得到的地方都写到了（b95e6bbb）', () => {
  it('--created-by 的说明本身不许再教人冒名', () => {
    const add = findCommand(['todo', 'add'])!.cmd
    const addFlag = (add.args ?? []).find((a) => a.flag === '--created-by')!
    expect(String(addFlag.desc)).toContain('不能填别的 agent')
    expect(String(addFlag.desc)).toContain('--executed-by')

    const update = findCommand(['todo', 'update'])!.cmd
    const updateFlag = (update.args ?? []).find((a) => a.flag === '--created-by')!
    expect(String(updateFlag.desc)).toContain('usage_error')
    // 反向验证：把说明改回"要记成别人提的（代录）才显式传"→ 本条红（文案在教人踩新规则）。
  })

  it('schema 的归属规则与边界都说清了（不是只拦不解释）', () => {
    const schema = buildSchema() as unknown as {
      agentGuide?: { ownership?: { rule?: string[]; boundary?: string } }
    }
    const rule = (schema.agentGuide?.ownership?.rule ?? []).join('\n')
    expect(rule).toContain('不许填别的 agent')
    expect(rule).toContain('--executed-by')
    // 边界不许吹：本层拦的是自相矛盾，不是认证
    expect(String(schema.agentGuide?.ownership?.boundary)).toContain('不是身份认证')
    expect(String(schema.agentGuide?.ownership?.boundary)).toContain('换一份凭据自称')
  })

  it('说明书同步：agent 手上那份不许还写着"代录别人"没事', () => {
    const guide = buildAgentGuide('C:/x/deskpartner.cjs', '1.0.108')
    expect(guide).toContain('声明了身份时不能填别的 agent')
    expect(guide).toContain('--executed-by')
    // 反向验证：把 agent-guide.ts 里那句摘掉 → 本条红。
  })
})
