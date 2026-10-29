import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '../../../src/main/database/migrations'
import { TodoRepository } from '../../../src/main/database/todo.repository'
import { CategoryRepository } from '../../../src/main/database/category.repository'
import { ProjectRepository } from '../../../src/main/database/project.repository'

const db = new Database(':memory:')
vi.mock('../../../src/main/database/index', () => ({ getDatabase: () => db }))

/**
 * G4 批准后当场执行（`f5e76697`）：带人批准凭证的动作回放必须放行
 *
 * ## 它治的病（假承诺）
 *
 * 088282b2（主用户 2026-09-28 拍板）承诺「删除可发起申请、人批准后当场执行」，
 * 但实测批准回放（executeApproved）仍被 G4 断言拦下（exit 4 / guard_blocked）——
 * 人点了允许却什么都没发生，且授权被消费。同款假承诺还覆盖「改状态」。
 *
 * ## 修法判据：从「谁在动」改为「带没带人的批准」
 *
 * 回放路径 actor 仍是发起申请的 agent（executeApproved 的设计注释明写
 * 「动作人仍是发起申请的 agent，只是由人代按了确认」——身份不能伪造，
 * 那会加重 e09d3832）。放行依据是 preApprovedGrantId：授权绑目标（v19），
 * 批的是 A 就只放行 A。
 *
 * 反向验证：把 proposed-guards.ts 里的 `if (preApprovedGrantId) return` 摘掉，
 * 下面「人批准」两条立即变红（已实测）。
 */
describe('G4 批准后当场执行：带人批准凭证的动作回放必须放行（f5e76697）', () => {
  let todos: TodoRepository

  beforeAll(() => {
    runMigrations(db)
  })

  beforeEach(() => {
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

  it('人批准的删除放行：回放带 preApprovedGrantId 的 delete 不被拦，卡真删掉', () => {
    const t = seed({ createdBy: 'agent:qwen' })
    // actor 用非提议人，确保只走批准分支（不被提议人撤回分支救）
    expect(() =>
      todos.delete(t.id, 'cli', 'agent:alice', 'grant-abc')
    ).not.toThrow()
    expect(todos.getById(t.id)).toBeNull()
  })

  it('无批准凭证的删除仍拦（G4 不退化：没拍板就删 proposed 依旧禁止）', () => {
    const t = seed({ createdBy: 'agent:qwen' })
    expect(() => todos.delete(t.id, 'cli', 'agent:alice')).toThrow(/G4/)
    expect(todos.getById(t.id)).not.toBeNull()
  })

  it('人批准的改状态放行：同族假承诺一并修透（update 带凭证）', () => {
    const t = seed({ createdBy: 'agent:qwen' })
    // ⚠️ actor 必须是**非提议人**：否则会被「提议人撤回」分支救了，
    // 这条就证明不了批准分支（反向验证时假绿，实测踩过一次）。
    expect(() =>
      todos.update({ id: t.id, status: 'todo', actor: 'agent:alice', preApprovedGrantId: 'grant-abc' })
    ).not.toThrow()
    expect(todos.getById(t.id)!.status).toBe('todo')
  })

  it('无凭证、非提议人改状态仍拦（既有语义不退化）', () => {
    const t = seed({ createdBy: 'agent:qwen' })
    expect(() => todos.update({ id: t.id, status: 'todo', actor: 'agent:alice' })).toThrow(/G4/)
  })

  it('提议人撤回/降级仍放行（e0ec5f32 语义不因新分支退化）', () => {
    const t1 = seed({ createdBy: 'agent:qwen', title: '撤回1' })
    const t2 = seed({ createdBy: 'agent:qwen', title: '撤回2' })
    expect(() => todos.update({ id: t1.id, status: 'todo', actor: 'agent:qwen' })).not.toThrow()
    expect(() => todos.update({ id: t2.id, status: 'suspended', actor: 'agent:qwen' })).not.toThrow()
  })

  it('界面路径仍放行（gui 是合法拍板通道，不因新分支退化）', () => {
    const t = seed({ createdBy: 'agent:qwen' })
    expect(() => todos.update({ id: t.id, status: 'todo', source: 'gui' })).not.toThrow()
  })
})
