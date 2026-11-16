import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runMigrations } from '../../../src/main/database/migrations'

/**
 * `todo set-owner` 的冒名旁路（卡 `7c347b4b`，评审第 1 条）
 *
 * ── 要堵的是什么 ──
 *
 * `todo update --created-by` 早就走 `assertCreatedByNotImpersonating`（1.0.109 / `b95e6bbb`），
 * 而同样改提出者的 `todo set-owner`（1.0.9x 加的补救命令）**漏了这一段**：
 * 它以 `agent:a` 的身份跑，就能把任意事项的提出者改成 `agent:b`，
 * 动作人、动态、提出人整条链一起错 —— 与 update 那条守的是同一件事，却是一道敞开的后门。
 *
 * ── 做法：复用同一条守卫，不删命令 ──
 *
 * 删掉命令会动命令契约（schema / help / MCP 基线），而它本身是"登记时忘了带
 * `--created-by` 的补救手段"，还留着有用 —— 所以只让它与 update 走同一段校验。
 *
 * 判据与 update 完全一致（守卫自身的语义，见 `assertCreatedByNotImpersonating`）：
 * ① 声明 a + 写 b → 拒绝，且不许写进去；
 * ② 声明 a + 写 a → 放行（这就是补救的正确用法）；
 * ③ 声明 a + 写 human → 放行（代录一条人提的事）；
 * ④ 未声明身份（启动器按本机凭据自动带上）→ 放行，1.0.37 的兼容路径保留。
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
  v4: () => `so-uuid-${++seq}`
}))

const { TodoRepository } = await import('../../../src/main/database/todo.repository')
const { CategoryRepository } = await import('../../../src/main/database/category.repository')
const { ProjectRepository } = await import('../../../src/main/database/project.repository')
const { MemoRepository } = await import('../../../src/main/database/memo.repository')
const { SettingsRepository } = await import('../../../src/main/database/settings.repository')
const { AgentRepository } = await import('../../../src/main/database/agent.repository')
const { ReleaseRepository } = await import('../../../src/main/database/release.repository')
const { executeOne } = await import('../../../src/main/cli/commands')

const todoRepo = new TodoRepository()
const categoryRepo = new CategoryRepository()
const projectRepo = new ProjectRepository()
const memoRepo = new MemoRepository()
const settingsRepo = new SettingsRepository()
const agentRepo = new AgentRepository()
const releaseRepo = new ReleaseRepository()

const tmpCred = path.join(os.tmpdir(), `deskpartner-set-owner-cred-${process.pid}.json`)

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

describe('`todo set-owner` 与 `todo update --created-by` 走同一条冒名校验（7c347b4b）', () => {
  it('① 声明 agent:alice 却把提出者改成 agent:bob → usage_error，且真的没改动', async () => {
    const todo = todoRepo.create({ title: '被人惦记的那条', createdBy: 'human' })

    const res = await executeOne(asDeclared('agent:alice') as never, [
      'todo',
      'set-owner',
      todo.id,
      '--owner',
      'agent:bob'
    ])
    expect(res.ok).toBe(false)
    expect(res.code).toBe(2)
    expect(res.errorCode).toBe('usage_error')
    // 报错要能照着改：说清"你写了谁""你是谁"
    expect(res.message).toContain('agent:bob')
    expect(res.message).toContain('agent:alice')
    expect(todoRepo.getById(todo.id)!.createdBy, '拦下了却还是改了 —— 报了错还写进去是最坏的一种').toBe(
      'human'
    )
    // 反向验证：把 todo.ts 里 set-owner 那行 assertCreatedByNotImpersonating 删掉
    // → ok=true、提出者被改成 alice，本条红。
  })

  it('② 改成自己 → 放行（这正是 set-owner 的补救用法）', async () => {
    const todo = todoRepo.create({ title: '记错提出者的那条', createdBy: 'human' })

    const res = await executeOne(asDeclared('agent:alice') as never, [
      'todo',
      'set-owner',
      todo.id,
      '--owner',
      'agent:alice'
    ])
    expect(res.ok).toBe(true)
    expect(todoRepo.getById(todo.id)!.createdBy).toBe('agent:alice')
  })

  it('③ 改成 human 不受限：agent 代录一条用户提的事仍然可以', async () => {
    const todo = todoRepo.create({ title: '其实是用户提的', createdBy: 'agent:alice' })

    const res = await executeOne(asDeclared('agent:alice') as never, [
      'todo',
      'set-owner',
      todo.id,
      '--owner',
      'human'
    ])
    expect(res.ok).toBe(true)
    expect(todoRepo.getById(todo.id)!.createdBy).toBe('human')
  })

  it('④ 未声明身份（启动器按本机凭据自动带上）→ 放行：与 update 同一条兼容路径', async () => {
    const todo = todoRepo.create({ title: '自动带上凭据时的补救', createdBy: 'human' })

    const res = await executeOne(asAutoLoaded('agent:alice') as never, [
      'todo',
      'set-owner',
      todo.id,
      '--owner',
      'agent:bob'
    ])
    expect(res.ok).toBe(true)
    expect(todoRepo.getById(todo.id)!.createdBy).toBe('agent:bob')
    // 反向验证：把守卫里的 `if (!ctx.identityDeclared) return` 摘掉 → 本条红。
  })
})
