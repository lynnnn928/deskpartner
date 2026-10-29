import { describe, it, expect } from 'vitest'
import { matchesViewScope } from '../../../src/renderer/lib/todo-filter'
import type { Todo } from '../../../src/renderer/types/todo'

/**
 * 视角只关心"这条跟谁有关"，所以用例只需要身份字段。
 * 依赖类型用 Pick<真实类型>：待办结构再怎么长，这里也不会被无关字段的改动波及。
 */
function todo(createdBy: string, executedBy: string | null = null): Pick<Todo, 'createdBy' | 'executedBy'> {
  return { createdBy, executedBy }
}

describe('matchesViewScope（视角：在看谁的事）', () => {
  it('all = 全部，谁的事都留着', () => {
    expect(matchesViewScope(todo('human'), 'all')).toBe(true)
    expect(matchesViewScope(todo('agent:bob'), 'all')).toBe(true)
  })

  it('mine 命中"我提的"', () => {
    expect(matchesViewScope(todo('human'), 'mine')).toBe(true)
  })

  it('mine 命中"别人提的、派给我的" —— 这是它存在的理由', () => {
    // agent 报给你的 bug：提出者是 agent、执行者是你。
    // 按提出者筛（filterOwner）永远筛不出来，但它在「我的」里必须出现。
    expect(matchesViewScope(todo('agent:bob', 'human'), 'mine')).toBe(true)
  })

  it('mine 不命中跟人无关的事', () => {
    expect(matchesViewScope(todo('agent:bob'), 'mine')).toBe(false)
    expect(matchesViewScope(todo('agent:alice', 'agent:bob'), 'mine')).toBe(false)
  })

  it('agent 视角：提出者与执行者任一命中', () => {
    expect(matchesViewScope(todo('agent:bob'), 'agent:bob')).toBe(true)
    expect(matchesViewScope(todo('human', 'agent:bob'), 'agent:bob')).toBe(true)
    expect(matchesViewScope(todo('human'), 'agent:bob')).toBe(false)
  })

  it('视角与"处理人筛选"不混：执行者命中但提出者不是它，也留着', () => {
    // 显式写这条是为了防止后人把它退化成 `todo.createdBy === scope`
    const t = todo('human', 'agent:alice')
    expect(t.createdBy).not.toBe('agent:alice')
    expect(matchesViewScope(t, 'agent:alice')).toBe(true)
  })
})
