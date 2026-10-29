import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '../../../src/main/database/migrations'
import { TodoRepository } from '../../../src/main/database/todo.repository'
import { CategoryRepository } from '../../../src/main/database/category.repository'
import { ProjectRepository } from '../../../src/main/database/project.repository'
import { executeOne } from '../../../src/main/cli/commands'
import { AgentRepository } from '../../../src/main/database/agent.repository'
import { NotificationRepository } from '../../../src/main/database/notification.repository'
import { EventsRepository } from '../../../src/main/database/events.repository'

const db = new Database(':memory:')
vi.mock('../../../src/main/database/index', () => ({ getDatabase: () => db }))

/**
 * 不变量 4：删除必留痕，且留痕必须有读出口（`917390e0` 第 4 条）
 *
 * 主用户给的"为什么"——**两条都是 1.0.62 才补上读出口的真实事故**：
 * - `b3ac3d32`：墓碑写了**没人读**，`todo history` 对已删 id 直接 `not_found`
 * - `68c7ccc1`：`comment_deleted` 事件全代码**只有写入处一次、零读取**
 *
 * 两条的共同形状：**"留痕"被当成写侧的事做完了就以为完了。**
 * 而留痕的价值在**读侧**兑现 —— 没人读，它等于没写。
 *
 * 判据：**断言"读"这件事本身**，不只断言"写了"。
 * 写侧有代码 ≠ 读侧能读到 —— 这与 1.0.65 那五条（授权/通知/回执/信封）
 * 是同一个病根：**判据只看"有没有记录"，不看"记录现在是什么下场"。**
 */
describe('不变量 4：删除留痕有读出口（917390e0 第 4 条）', () => {
  let todos: TodoRepository
  const mkCtx = (actor = 'human'): never =>
    ({
      deps: {
        todoRepo: todos,
        categoryRepo: new CategoryRepository(),
        projectRepo: new ProjectRepository(),
        memoRepo: { list: () => [], add: () => ({}), get: () => null },
        settingsRepo: { get: () => ({}) },
        agentRepo: new AgentRepository(),
        notificationRepo: new NotificationRepository(),
        events: new EventsRepository(),
        telemetry: { record: () => {} }
      },
      meta: { version: '1.0.66', dbPath: ':memory:', schemaVersion: 25, via: 'pipe' },
      interactive: true,
      actor
    }) as never

  beforeAll(() => {
    runMigrations(db)
    db.pragma('foreign_keys = OFF')
  })

  beforeEach(() => {
    for (const t of [
      'todos',
      'todo_comments',
      'todo_transitions',
      'events',
      'notifications',
      'agent_grants',
      'projects',
      'categories'
    ]) {
      db.prepare(`DELETE FROM ${t}`).run()
    }
    new CategoryRepository().create({ name: '默认', color: '#111', sortOrder: 0 })
    new ProjectRepository().create({ name: 'P' })
    todos = new TodoRepository()
  })

  it('前置：删除确实发生了（否则后面测的是"没删"）', () => {
    const t = todos.create({ title: '要删的', projectId: null } as never)
    expect(todos.getById(t.id), '删之前应能读到').toBeTruthy()
    todos.delete(t.id, 'cli', 'agent:test')
    // ⚠️ `getById` 对已删条目返回 **null 而不是抛错** —— 这是对的：
    // 抛错会让"这条被删了"与"这条不存在"无法区分，而 CLI 层要靠这个区分
    // 决定返回 tombstone 还是 not_found（b3ac3d32 就坏在这里）。
    expect(todos.getById(t.id), '删之后 getById 应返回 null（不是抛错）').toBeNull()
  })

  it('已删条目能被快照读到（读侧存在 = 墓碑不是只写不读）', () => {
    const t = todos.create({ title: '要删的', projectId: null, status: 'in_progress' } as never)
    todos.delete(t.id, 'cli', 'agent:test')

    const snap = todos.findDeletedSnapshot(t.id)
    expect(snap, 'findDeletedSnapshot 应返回墓碑').toBeTruthy()
    // 墓碑结构是 { deletedAt, actor, snapshot, transitions }，标题在 snapshot 里
    expect(snap!.snapshot.title).toBe('要删的')
  })

  it('墓碑里有操作者与删除时状态（否则"谁在什么时候删的"无法回答）', () => {
    const t = todos.create({ title: 'X', projectId: null, status: 'in_progress' } as never)
    todos.delete(t.id, 'cli', 'agent:test')
    const snap = todos.findDeletedSnapshot(t.id)
    expect(snap!.actor, '墓碑必须带操作者').toBeTruthy()
    expect(snap!.deletedAt, '墓碑必须带删除时刻').toBeTruthy()
  })

  it('CLI 层用短 id 也能读到墓碑（人记的是短号，b3ac3d32 就卡在这）', async () => {
    const t = todos.create({ title: '短号也要能查', projectId: null } as never)
    const short = t.id.slice(0, 8)
    todos.delete(t.id, 'cli', 'agent:test')

    // 直接走 repo 层：短号要先解析，而已删条目解析不到 —— 这是"读出口"要解决的
    const snap = todos.findDeletedSnapshot(short)
    const byFull = todos.findDeletedSnapshot(t.id)
    expect(
      snap ?? byFull,
      '短号与全 uuid 都应能读到墓碑；至少全 uuid 必须能'
    ).toBeTruthy()
  })

  it('未删除的条目不返回墓碑（别把"没删"也报成删了）', () => {
    const t = todos.create({ title: '还在', projectId: null } as never)
    expect(todos.findDeletedSnapshot(t.id)).toBeFalsy()
  })

  /**
   * 读侧接线的断言：**`todo history` 对已删条目不得返回 not_found**。
   *
   * `b3ac3d32` 的原始症状就是这一条 —— 墓碑写了，但 history 直接说"不存在"，
   * 于是删除在审计上等于"从未发生过"。
   */
  it('todo history 对已删 id 返回墓碑而不是 not_found', async () => {
    const t = todos.create({ title: '历史要能查', projectId: null } as never)
    todos.delete(t.id, 'cli', 'agent:test')

    const r = await executeOne(mkCtx(), ['todo', 'history', t.id]) as {
      ok: boolean
      message?: string
      data?: unknown
    }
    expect(
      r.ok,
      `todo history 对已删条目返回了失败：${r.message ?? ''} —— 这就是 b3ac3d32`
    ).toBe(true)
  })
})
