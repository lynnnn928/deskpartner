import { describe, it, expect } from 'vitest'
import { compareForPanel } from '../../../src/renderer/lib/panel-sort'
import type { Todo } from '../../../src/renderer/types/todo'
import type { TodoPriority, TodoStatus } from '../../../src/renderer/types/enums'

/** 造一条用于排序的待办；只填影响排序的字段，其余给固定值 */
function make(over: {
  id: string
  status?: TodoStatus
  priority?: TodoPriority
  createdAt?: string
  createdBy?: string
}): Todo {
  return {
    id: over.id,
    title: over.id,
    description: null,
    projectId: null,
    parentId: null,
    categoryIds: [],
    categoryId: '',
    status: over.status ?? 'todo',
    priority: over.priority ?? 'normal',
    type: 'task',
    createdBy: (over.createdBy ?? 'human') as Todo['createdBy'],
    executedBy: null,
    dueAt: null,
    remindAt: null,
    isPinned: false,
    createdAt: over.createdAt ?? '2026-09-01T00:00:00.000Z',
    updatedAt: over.createdAt ?? '2026-09-01T00:00:00.000Z',
    completedAt: over.status === 'done' ? '2026-09-01T00:00:00.000Z' : null
  }
}

describe('compareForPanel', () => {
  it('按记录时间正序：先记的排在前面', () => {
    const older = make({ id: 'old', createdAt: '2026-09-01T00:00:00.000Z' })
    const newer = make({ id: 'new', createdAt: '2026-09-10T00:00:00.000Z' })
    const sorted = [newer, older].sort(compareForPanel)
    expect(sorted.map((t) => t.id)).toEqual(['old', 'new'])
  })

  /**
   * 这条锁的是"不按归属者排序"。
   * 若人的事无条件排在前面，人机共享就退化成"人的事优先"。
   */
  it('不按归属者排序：AI 先记的排在人后记的前面', () => {
    const agentFirst = make({
      id: 'agent',
      createdBy: 'agent:alice',
      createdAt: '2026-09-01T00:00:00.000Z'
    })
    const humanLater = make({ id: 'human', createdBy: 'human', createdAt: '2026-09-09T00:00:00.000Z' })
    const sorted = [humanLater, agentFirst].sort(compareForPanel)
    expect(sorted.map((t) => t.id)).toEqual(['agent', 'human'])
  })

  /**
   * 这条锁的是"排序依据必须是界面上看得见的"。
   * 面板不显示优先级，所以优先级不该影响顺序。
   */
  it('不受优先级影响：面板上看不到优先级，排序也不该认它', () => {
    const low = make({ id: 'low', priority: 'low', createdAt: '2026-09-01T00:00:00.000Z' })
    const urgent = make({
      id: 'urgent',
      priority: 'urgent',
      createdAt: '2026-09-05T00:00:00.000Z'
    })
    const sorted = [urgent, low].sort(compareForPanel)
    expect(sorted.map((t) => t.id)).toEqual(['low', 'urgent'])
  })

  it('排序是稳定的：条件相同的两条保持原次序', () => {
    const a = make({ id: 'a' })
    const b = make({ id: 'b' })
    const sorted = [a, b].sort(compareForPanel)
    expect(sorted.map((t) => t.id)).toEqual(['a', 'b'])
  })
})
