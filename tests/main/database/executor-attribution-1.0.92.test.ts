import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '../../../src/main/database/migrations'
import { TodoRepository } from '../../../src/main/database/todo.repository'
import { CategoryRepository } from '../../../src/main/database/category.repository'
import { ProjectRepository } from '../../../src/main/database/project.repository'
import { todosForExecutor } from '../../../src/main/cli/commands'

const db = new Database(':memory:')
vi.mock('../../../src/main/database/index', () => ({ getDatabase: () => db }))

describe('1.0.92 执行者归属', () => {
  let todos: TodoRepository
  beforeAll(() => runMigrations(db))
  beforeEach(() => {
    for (const table of ['todos', 'todo_transitions', 'categories', 'projects']) db.prepare(`DELETE FROM ${table}`).run()
    new CategoryRepository().create({ name: '默认', color: '#111', sortOrder: 0 })
    new ProjectRepository().create({ name: 'P' })
    todos = new TodoRepository()
  })
  it('未显式指派时，推进类写入记录实际 actor 为执行者', () => {
    const t = todos.create({ title: 'agent 提出', projectId: null, createdBy: 'agent:author' } as never)
    todos.update({ id: t.id, status: 'in_progress', actor: 'human' })
    expect(todos.getById(t.id)!.executedBy).toBe('human')
  })
  it('已显式指派时，不被实际推进者覆盖', () => {
    const t = todos.create({ title: '已指派', projectId: null, createdBy: 'agent:author', executedBy: 'human' } as never)
    todos.update({ id: t.id, status: 'in_progress', actor: 'agent:worker' })
    expect(todos.getById(t.id)!.executedBy).toBe('human')
  })
  it('纯标题编辑不冒充执行接手', () => {
    const t = todos.create({ title: '标题', projectId: null, createdBy: 'agent:author' } as never)
    todos.update({ id: t.id, title: '新标题', actor: 'human' })
    expect(todos.getById(t.id)!.executedBy).toBeNull()
  })
  it('纯描述或版本标注编辑不冒充执行接手', () => {
    const t = todos.create({ title: '规格', projectId: null, createdBy: 'agent:author' } as never)
    todos.update({ id: t.id, description: '补充说明', actor: 'human' })
    expect(todos.getById(t.id)!.executedBy).toBeNull()
    todos.update({ id: t.id, fixedInVersion: '1.0.92', actor: 'human' })
    expect(todos.getById(t.id)!.executedBy).toBeNull()
  })
  it('按执行者查询包含“提出即执行”的有效执行者', () => {
    const own = todos.create({ title: '自己的活', projectId: null, createdBy: 'agent:worker' } as never)
    const assigned = todos.create({ title: '指派的活', projectId: null, createdBy: 'human', executedBy: 'agent:worker' } as never)
    const other = todos.create({ title: '别人的活', projectId: null, createdBy: 'agent:other' } as never)
    expect(todosForExecutor([own, assigned, other], 'agent:worker').map((x) => x.id)).toEqual([own.id, assigned.id])
    expect(todosForExecutor([own, assigned, other], 'unset').map((x) => x.id)).toEqual([own.id, other.id])
  })
})
