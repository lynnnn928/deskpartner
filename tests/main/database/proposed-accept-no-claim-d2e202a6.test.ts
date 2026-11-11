import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '../../../src/main/database/migrations'
import { TodoRepository } from '../../../src/main/database/todo.repository'
import { CategoryRepository } from '../../../src/main/database/category.repository'
import { ProjectRepository } from '../../../src/main/database/project.repository'

const db = new Database(':memory:')
vi.mock('../../../src/main/database/index', () => ({ getDatabase: () => db }))

/**
 * 「接受提议」＝把卡从待确认推到待办（G4 只放行界面路径，所以带 source: 'gui'），
 * 界面路径由 IPC 层盖 source 与 actor 章。
 */
describe('接受提议不算认领（卡片 d2e202a6）', () => {
  let todos: TodoRepository
  beforeAll(() => runMigrations(db))
  beforeEach(() => {
    for (const table of ['todos', 'todo_transitions', 'categories', 'projects']) db.prepare(`DELETE FROM ${table}`).run()
    new CategoryRepository().create({ name: '默认', color: '#111', sortOrder: 0 })
    new ProjectRepository().create({ name: 'P' })
    todos = new TodoRepository()
  })

  it('主用户接受 agent 提的提议后，执行者仍留空（不再被记成 human）', () => {
    const t = todos.create({ title: '提议', projectId: null, createdBy: 'agent:author', status: 'proposed' } as never)
    todos.update({ id: t.id, status: 'todo', actor: 'human', source: 'gui' })
    const after = todos.getById(t.id)!
    expect(after.status).toBe('todo')
    expect(after.executedBy).toBeNull()
  })

  it('同一步里显式指派仍然作数（接受并派给谁，就记谁）', () => {
    const t = todos.create({ title: '提议', projectId: null, createdBy: 'agent:author', status: 'proposed' } as never)
    todos.update({ id: t.id, status: 'todo', executedBy: 'agent:worker', actor: 'human', source: 'gui' })
    expect(todos.getById(t.id)!.executedBy).toBe('agent:worker')
  })

  it('接受之后真正动手的推进仍认领（推到进行中）', () => {
    const t = todos.create({ title: '提议', projectId: null, createdBy: 'agent:author', status: 'proposed' } as never)
    todos.update({ id: t.id, status: 'todo', actor: 'human', source: 'gui' })
    todos.update({ id: t.id, status: 'in_progress', actor: 'human' })
    expect(todos.getById(t.id)!.executedBy).toBe('human')
  })

  it('例外只覆盖「待确认 → 待办」，其余推进的自动认领不变', () => {
    const t = todos.create({ title: '别人的活', projectId: null, createdBy: 'agent:author' } as never)
    todos.update({ id: t.id, status: 'awaiting_review', actor: 'human' })
    expect(todos.getById(t.id)!.executedBy).toBe('human')
  })

  it('提出人自己推进不重复认领（有效执行者本来就是他）', () => {
    const t = todos.create({ title: '自己的活', projectId: null, createdBy: 'agent:worker' } as never)
    todos.update({ id: t.id, status: 'in_progress', actor: 'agent:worker' })
    expect(todos.getById(t.id)!.executedBy).toBeNull()
  })
})
