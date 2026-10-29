import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '../../../src/main/database/migrations'
import { executeOne, executeApproved } from '../../../src/main/cli/commands'
import { AgentRepository } from '../../../src/main/database/agent.repository'
import { TodoRepository } from '../../../src/main/database/todo.repository'
import { CategoryRepository } from '../../../src/main/database/category.repository'
import { ProjectRepository } from '../../../src/main/database/project.repository'
import { CommentRepository } from '../../../src/main/database/comment.repository'

const db = new Database(':memory:')
vi.mock('../../../src/main/database/index', () => ({ getDatabase: () => db }))

describe('人工批准的 G10 回放（1.0.91）', () => {
  let todos: TodoRepository
  let agents: AgentRepository
  let comments: CommentRepository
  let credential = ''
  beforeAll(() => runMigrations(db))
  beforeEach(() => {
    for (const table of ['todos', 'todo_comments', 'todo_transitions', 'agent_grants', 'categories', 'projects']) db.prepare(`DELETE FROM ${table}`).run()
    new CategoryRepository().create({ name: '默认', color: '#111', sortOrder: 0 })
    new ProjectRepository().create({ name: 'P' })
    agents = new AgentRepository()
    agents.register({ id: 'agent:executor', displayName: 'Executor', color: '#111' } as never)
    agents.setApproved('agent:executor', true)
    credential = agents.issueCredential('agent:executor')?.token ?? ''
    todos = new TodoRepository()
    comments = new CommentRepository()
  })
  it('没有人工批准时，执行者自验仍被 G10 拒绝且无副作用', async () => {
    const t = todos.create({ title: 'review', projectId: null, status: 'awaiting_review', createdBy: 'agent:executor', executedBy: 'agent:executor' } as never)
    const ctx = { deps: { todoRepo: todos, commentRepo: comments, categoryRepo: new CategoryRepository(), projectRepo: new ProjectRepository(), agentRepo: agents, memoRepo: { }, settingsRepo: { }, notificationRepo: { }, events: { append() {} }, telemetry: { record() {} } }, meta: { version: '1.0.91', schemaVersion: 35, via: 'pipe' }, actor: 'agent:executor', credential } as never
    const r = await executeOne(ctx, ['todo', 'close', t.id, '--did', 'x', '--verified', 'y', '--pass-criteria', 'z'])
    expect(r.ok).toBe(false)
    expect(r.code).toBe(4)
    expect(comments.listByTodo(t.id)).toEqual([])
    expect(todos.getById(t.id)!.status).toBe('awaiting_review')
  })
  it('人工批准的回放允许执行者收口，且保留原 agent 归属', () => {
    const t = todos.create({ title: 'review', projectId: null, status: 'awaiting_review', createdBy: 'agent:executor', executedBy: 'agent:executor' } as never)
    const requestedArgv = ['todo', 'close', t.id, '--did', 'x', '--verified', 'y', '--pass-criteria', 'z', '--leftover', 'none']
    const grant = agents.requestGrant({ agentId: 'agent:executor', scope: 'destructive', command: 'todo close', summary: 'close review', targetIds: [t.id], requestArgv: requestedArgv })
    // todo close 虽落在写档路径，但不接受删除确认参数；回放使用申请中保存的原始 argv。
    agents.resolveGrant(grant.id, true)
    const ctx = { deps: { todoRepo: todos, commentRepo: comments, categoryRepo: new CategoryRepository(), projectRepo: new ProjectRepository(), agentRepo: agents, memoRepo: { }, settingsRepo: { }, notificationRepo: { }, events: { append() {} }, telemetry: { record() {} } }, meta: { version: '1.0.91', schemaVersion: 35, via: 'pipe' } } as never
    return executeApproved(ctx, grant.requestArgv, { agentId: 'agent:executor', grantId: grant.id }).then((r) => {
      expect(r, JSON.stringify(r)).toMatchObject({ ok: true })
      expect(todos.getById(t.id)!.status).toBe('done')
      expect(comments.listByTodo(t.id)).toHaveLength(1)
      expect(comments.listByTodo(t.id)[0].authorId).toBe('agent:executor')
    })
  })
})
