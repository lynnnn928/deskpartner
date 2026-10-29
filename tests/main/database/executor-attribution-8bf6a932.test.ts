import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '../../../src/main/database/migrations'
import { TodoRepository } from '../../../src/main/database/todo.repository'
import { CategoryRepository } from '../../../src/main/database/category.repository'
import { ProjectRepository } from '../../../src/main/database/project.repository'
import { AgentRepository } from '../../../src/main/database/agent.repository'
import { NotificationRepository } from '../../../src/main/database/notification.repository'
import { CommentRepository } from '../../../src/main/database/comment.repository'
import { EventsRepository } from '../../../src/main/database/events.repository'
import { ReleaseRepository } from '../../../src/main/database/release.repository'
import { executeOne, EXIT_CODES } from '../../../src/main/cli/commands'

/**
 * 收口时的执行者归属与判定（卡 `8bf6a932`，Bob提）
 *
 * ## 卡上的两个洞
 *
 * 1. **close 不认领执行者** —— 一条 `executedBy` 为 NULL 的卡，提出者亲自推到
 *    待验收后，实际干活的人（非执行者身份）可以 `close` 收口，归属一直飘着；
 * 2. **存量 NULL 的口径没定** —— 谁在管这条，从数据上看不出来。
 *
 * ## Bob 1.0.81 实测的死锁（本文件第 3 组的由来）
 *
 * > executedBy 为 NULL 时，G10 会把它回落成提出者，于是**提出者既当默认执行者又当验收者**，
 * > 谁都收不了口。
 *
 * 根因是两条各自合理的设计撞在一起：`verifier` 不传时默认取提出者（`todo.repository.ts`
 * 的 create），而执行者字段靠"回落成提出者"来推定。本轮的修法：判定改成
 * **证据优先**（`attributedExecutor()`：显式指派 → 谁推进到待验收 → 提出者），
 * 收口本身**不改归属**（签名的人不该被记成干活的人）。
 *
 * ⚠️ 存量卡（1.0.92 之前建的）`executedBy` 仍是 NULL，且当时的"推进即认领"还没上线 ——
 * 所以本文件用「造出卡 → 手动把 executed_by 置回 NULL」来复现那一批的形状。
 */
const db = new Database(':memory:')
vi.mock('../../../src/main/database/index', () => ({ getDatabase: () => db }))

const AUTHOR = 'agent:author'
const WORKER = 'agent:worker'

let todos: TodoRepository

const projectRepo = new ProjectRepository()
const agentRepo = new AgentRepository()

function mkCtx(actor: string): never {
  return {
    deps: {
      todoRepo: todos,
      categoryRepo: new CategoryRepository(),
      projectRepo,
      memoRepo: { list: () => [], add: () => ({}), get: () => null },
      settingsRepo: { get: () => ({}) },
      agentRepo,
      commentRepo: new CommentRepository(),
      notificationRepo: new NotificationRepository(),
      releaseRepo: new ReleaseRepository(),
      events: new EventsRepository(),
      telemetry: { record: () => {}, stats: () => {}, query: () => {}, clear: () => {} }
    },
    meta: {
      version: 'test',
      dbPath: ':memory:',
      schemaVersion: 99,
      busyTimeoutMs: 5000,
      channels: ['headless' as const],
      via: 'headless' as const,
      startedAt: Date.now()
    },
    interactive: true,
    actor
  } as never
}

const run = (actor: string, args: string[]) => executeOne(mkCtx(actor), args)

beforeAll(() => {
  runMigrations(db)
  for (const id of [AUTHOR, WORKER]) agentRepo.register({ id, displayName: id })
})

beforeEach(() => {
  for (const t of ['todos', 'todo_transitions', 'todo_comments', 'notifications', 'projects', 'categories']) {
    db.prepare(`DELETE FROM ${t}`).run()
  }
  new CategoryRepository().create({ name: '默认', color: '#111', sortOrder: 0 })
  projectRepo.create({ name: 'P' })
  todos = new TodoRepository()
})

/**
 * 造一条"待验收"的卡，并模拟**存量形状**：`executed_by` 置回 NULL。
 *
 * 走 `update` 推到 awaiting_review 会按 1.0.92 起的"推进即认领"落成推进人 ——
 * 之后再把 executed_by 抹回 NULL，就得到 1.0.92 之前那种"流转里有记录、
 * 字段上是空的"的老卡。
 */
function legacyCard(pushedBy: string, createdBy = AUTHOR) {
  const t = todos.create({ title: '存量卡', projectId: null, createdBy: createdBy as never } as never)
  todos.update({ id: t.id, status: 'awaiting_review', actor: pushedBy as never })
  db.prepare('UPDATE todos SET executed_by = NULL WHERE id = ?').run(t.id)
  return todos.getById(t.id)!
}

describe('8bf6a932 谁不能签：证据优先的判定', () => {
  it('显式指派优先于流转记录', () => {
    const t = todos.create({
      title: '指派给 worker',
      projectId: null,
      createdBy: AUTHOR as never,
      executedBy: WORKER as never
    } as never)
    todos.update({ id: t.id, status: 'awaiting_review', actor: AUTHOR as never })
    expect(todos.attributedExecutor(todos.getById(t.id)!)).toBe(WORKER)
  })

  it('没记执行者时，取"谁把它推进到待验收"（不是提出者）', () => {
    const t = legacyCard(WORKER)
    expect(t.executedBy).toBeNull()
    expect(todos.attributedExecutor(t)).toBe(WORKER)
  })

  it('提出者自己推的，判据落在提出者身上（自证闭环照样拦）', () => {
    const t = legacyCard(AUTHOR)
    expect(todos.attributedExecutor(t)).toBe(AUTHOR)
  })

  it('没有流转可查时回落提出者（否则"直接建成待验收再自签"变成自由通道）', () => {
    const t = todos.create({
      title: '直接建成待验收',
      projectId: null,
      createdBy: AUTHOR as never,
      status: 'awaiting_review'
    } as never)
    expect(todos.attributedExecutor(todos.getById(t.id)!)).toBe(AUTHOR)
  })

  it('第三个办法以外的身份不受影响：第三方仍是第三方', () => {
    const t = legacyCard(WORKER)
    expect(todos.attributedExecutor(t)).not.toBe('agent:someone-else')
  })
})

describe('8bf6a932 Bob实测的死锁：写明验收者必须能收口', () => {
  it('别人干的活 + 提出者验收（存量 NULL）→ 提出者可以收口（修之前会被 G10 拦）', async () => {
    const t = legacyCard(WORKER)
    const r = (await run(AUTHOR, [
      'todo',
      'close',
      t.id,
      '--did',
      'd',
      '--verified',
      'v',
      '--pass-criteria',
      'p'
    ])) as { ok?: boolean; code?: number; errorCode?: string }
    expect(r.ok, `提出者（=卡上的验收者）被自己拦住了：${r.code}:${r.errorCode ?? ''}`).toBe(true)
  })

  it('干活的人自己不能签（他要走收口，会被拦）', async () => {
    const t = legacyCard(WORKER)
    const viaCli = (await run(WORKER, [
      'todo',
      'close',
      t.id,
      '--did',
      'd',
      '--verified',
      'v',
      '--pass-criteria',
      'p'
    ])) as { ok?: boolean; code?: number }
    expect(viaCli.ok).toBe(false)
    expect(viaCli.code).toBe(EXIT_CODES.guard)
    // 界面/主进程那条路（无门禁）由数据层拦
    expect(() => todos.update({ id: t.id, status: 'done', actor: WORKER as never })).toThrow()
  })

  it('收口不改归属：签的人不会被记成干活的人', async () => {
    const t = legacyCard(WORKER)
    await run(AUTHOR, ['todo', 'close', t.id, '--did', 'd', '--verified', 'v', '--pass-criteria', 'p'])
    const after = todos.getById(t.id)!
    expect(after.executedBy, '收口把归属顺手改了 —— 那是把签名的人当成干活的人').toBeNull()
    expect(todos.attributedExecutor(after), '归属判定仍然按流转里的证据').toBe(WORKER)
  })

  it('显式执行者的卡：提出者验收照旧放行，执行者照旧被拦', async () => {
    const t = todos.create({
      title: '显式指派',
      projectId: null,
      createdBy: AUTHOR as never,
      executedBy: WORKER as never
    } as never)
    todos.update({ id: t.id, status: 'awaiting_review', actor: WORKER as never })
    const byAuthor = (await run(AUTHOR, [
      'todo',
      'update',
      t.id,
      '--status',
      'done',
      '--comment',
      '验收通过'
    ])) as { ok?: boolean }
    expect(byAuthor.ok).toBe(true)
  })
})
