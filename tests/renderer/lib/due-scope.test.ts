import { describe, it, expect } from 'vitest'
import dayjs from 'dayjs'
import { matchesDueScope, countDueScope } from '../../../src/renderer/lib/due-scope'
import type { Todo } from '../../../src/renderer/types/todo'
import type { TodoStatus } from '../../../src/renderer/types/enums'

/** 相对今天的时刻，避免写死日期后随时间失效 */
const at = (days: number, hour = 10) =>
  dayjs().startOf('day').add(days, 'day').add(hour, 'hour').format('YYYY-MM-DDTHH:mm:ss')

/**
 * 今天内的某个时刻：hour 不传取 23:59（当天末尾）。
 *
 * 直接写死 at(0)（今天 10:00）的时间脆弱点：真实时钟过了上午 10 点，
 * 这条"今天到期"在产品口径里就该算逾期（isBefore(now)），测试下午跑必挂。
 * 用 endOf('day') 表达"今天到期"，任何时刻跑都稳定。
 */
const atToday = () => dayjs().endOf('day').format('YYYY-MM-DDTHH:mm:ss')

function make(over: {
  id: string
  status?: TodoStatus
  dueAt?: string | null
  remindAt?: string | null
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
    priority: 'normal',
    type: 'task',
    createdBy: 'human',
    executedBy: null,
    dueAt: over.dueAt ?? null,
    remindAt: over.remindAt ?? null,
    isPinned: false,
    createdAt: at(0),
    updatedAt: at(0),
    completedAt: null
  }
}

describe('matchesDueScope', () => {
  it('all 不做过滤', () => {
    const t = make({ id: 'a', dueAt: at(-30) })
    expect(matchesDueScope(t, 'all')).toBe(true)
  })

  it('today 收今天到期的', () => {
    expect(matchesDueScope(make({ id: 'a', dueAt: atToday() }), 'today')).toBe(true)
  })

  /** 这条锁的是"提醒也算今天" —— 只认 dueAt 会漏掉这类事 */
  it('today 也收今天提醒的（哪怕没设截止）', () => {
    expect(matchesDueScope(make({ id: 'a', remindAt: at(0, 9) }), 'today')).toBe(true)
  })

  it('today 不含明天/昨天', () => {
    expect(matchesDueScope(make({ id: 'a', dueAt: at(1) }), 'today')).toBe(false)
    expect(matchesDueScope(make({ id: 'a', dueAt: at(-1) }), 'today')).toBe(false)
  })

  it('已完成的不再算"今天该处理"', () => {
    expect(
      matchesDueScope(make({ id: 'a', dueAt: at(0), status: 'done' }), 'today')
    ).toBe(false)
  })

  /** 提议还没拍板，不该虚增"今天要处理"的压力 */
  it('待确认（proposed）的提议不算"今天该处理"', () => {
    expect(
      matchesDueScope(make({ id: 'a', dueAt: atToday(), status: 'proposed' }), 'today')
    ).toBe(false)
    expect(
      matchesDueScope(make({ id: 'b', dueAt: at(-3), status: 'proposed' }), 'overdue')
    ).toBe(false)
  })

  it('overdue 收过期未完成的', () => {
    expect(matchesDueScope(make({ id: 'a', dueAt: at(-3) }), 'overdue')).toBe(true)
  })

  /** 迟到做完了就别再标红了 */
  it('overdue 不含已完成的', () => {
    expect(
      matchesDueScope(make({ id: 'a', dueAt: at(-3), status: 'done' }), 'overdue')
    ).toBe(false)
  })

  it('overdue 不含没设截止的', () => {
    expect(matchesDueScope(make({ id: 'a' }), 'overdue')).toBe(false)
  })

  it('边界：今天 00:00 与 23:59 都算今天', () => {
    expect(matchesDueScope(make({ id: 'a', dueAt: at(0, 0) }), 'today')).toBe(true)
    expect(matchesDueScope(make({ id: 'b', dueAt: atToday() }), 'today')).toBe(true)
  })
})

describe('countDueScope', () => {
  it('按档计数', () => {
    const todos = [
      make({ id: '今天', dueAt: atToday() }),
      make({ id: '逾期', dueAt: at(-5) }),
      make({ id: '没期限' })
    ]
    expect(countDueScope(todos, 'all')).toBe(3)
    expect(countDueScope(todos, 'today')).toBe(1)
    expect(countDueScope(todos, 'overdue')).toBe(1)
  })
})
