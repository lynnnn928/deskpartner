import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '../../../src/main/database/migrations'
import { TodoRepository } from '../../../src/main/database/todo.repository'
import { CategoryRepository } from '../../../src/main/database/category.repository'
import { ProjectRepository } from '../../../src/main/database/project.repository'

const db = new Database(':memory:')
vi.mock('../../../src/main/database/index', () => ({ getDatabase: () => db }))

/**
 * 提议人能自撤自己的「待确认」卡（`e0ec5f32`，qwen 提，主用户 10-06 拍板）
 *
 * ## 它治的病（主用户 10-05 原话）
 *
 * 「待确认列堆着大量没拍板的卡，不拍就不能动工，等于每一步都要她推。」
 * 而 G4 原来对 agent 一律禁止 —— **连提议人自己都撤不掉自己提的过度提议**。
 *
 * ## 核心判断：两件事必须分开
 *
 * | | 是什么 | 该谁做 |
 * |---|---|---|
 * | **收回自己的请求** | 不产生任何决定 | 提议人自己 |
 * | **替别人做决定** | 决策 | 人在界面 |
 *
 * 原来的守卫把两者当成一件，于是前者也要等人。
 *
 * ## 边界（刻意收窄，不许含糊）
 *
 * 放开：提议人把自己的 proposed **降级为待办**或**撤回（挂起）**
 * 不许：放行**别人**的 proposed、把 proposed 往右推（进「进行中」及以上）
 * **降级 ≠ 批准** —— 待办还要执行方去做
 */
describe('提议人能自撤自己的待确认卡（e0ec5f32）', () => {
  let todos: TodoRepository

  beforeAll(() => {
    runMigrations(db)
  })

  beforeEach(() => {
    // ⚠️ categories/projects 必须每次重建 —— 建卡要解析分类，
    // 删了它会抛「还没有任何分类」，而报错指向的是"字段没存进去"这类无关方向。
    db.prepare('DELETE FROM todos').run()
    db.prepare('DELETE FROM todo_transitions').run()
    db.prepare('DELETE FROM categories').run()
    db.prepare('DELETE FROM projects').run()
    new CategoryRepository().create({ name: '默认', color: '#111', sortOrder: 0 })
    new ProjectRepository().create({ name: 'P' })
    todos = new TodoRepository()
  })

  const seed = (over: Record<string, unknown> = {}) =>
    todos.create({ title: '一条提议', projectId: null, status: 'proposed', ...over } as never)

  it('提议人可把自己的 proposed 降级为「待办」', () => {
    const t = seed({ createdBy: 'agent:qwen' })
    expect(() =>
      todos.update({ id: t.id, status: 'todo', actor: 'agent:qwen' })
    ).not.toThrow()
    expect(todos.getById(t.id)!.status).toBe('todo')
  })

  it('提议人可撤回（挂起）自己的 proposed', () => {
    const t = seed({ createdBy: 'agent:qwen' })
    expect(() =>
      todos.update({ id: t.id, status: 'suspended', actor: 'agent:qwen' })
    ).not.toThrow()
    expect(todos.getById(t.id)!.status).toBe('suspended')
  })

  it('【边界1】放行别人的 proposed 仍被拦（这不是撤回，是替人拍板）', () => {
    const t = seed({ createdBy: 'agent:qwen' })
    expect(() =>
      todos.update({ id: t.id, status: 'todo', actor: 'agent:alice' })
    ).toThrow(/G4/)
    expect(todos.getById(t.id)!.status, '拒绝后状态不变').toBe('proposed')
  })

  it('【边界2】提议人也不能把自己的 proposed 往右推（降级≠批准）', () => {
    const t = seed({ createdBy: 'agent:qwen' })
    for (const to of ['in_progress', 'awaiting_review', 'done'] as const) {
      expect(
        () => todos.update({ id: t.id, status: to, actor: 'agent:qwen' }),
        `提议人不该能直接把待确认推到 ${to} —— 那是批准`
      ).toThrow(/G4/)
    }
    expect(todos.getById(t.id)!.status).toBe('proposed')
  })

  it('GUI 侧不受影响（人在界面点一律放行，那是"人"不是"角色"）', () => {
    const t = seed({ createdBy: 'agent:qwen' })
    expect(() =>
      todos.update({ id: t.id, status: 'in_progress', source: 'gui' } as never)
    ).not.toThrow()
  })

  it('报错要说清"只有提议人自己能降级"（不是只说拒绝）', () => {
    const t = seed({ createdBy: 'agent:qwen' })
    try {
      todos.update({ id: t.id, status: 'in_progress', actor: 'agent:alice' })
      throw new Error('本该被拒')
    } catch (e) {
      const msg = (e as Error).message
      expect(msg).toContain('G4')
      expect(msg, '报错要指路').toMatch(/提议人/)
      expect(msg, '要说清降级不等于批准').toMatch(/不构成批准|降级/)
    }
  })

  it('非 proposed 事项不受本守卫管（守卫只管候选池那道闸）', () => {
    const t = seed({ createdBy: 'agent:qwen', status: 'in_progress' })
    expect(() =>
      todos.update({ id: t.id, status: 'done', actor: 'agent:qwen' })
    ).not.toThrow()
  })
})
