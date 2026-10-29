import dayjs from 'dayjs'
import type { Todo } from '../types/todo'

/**
 * 「今天 / 逾期」视角
 *
 * 看板按状态分列，答的是"一共有多少事"；
 * 这个视角答的是"**我今天该处理哪些**"。
 * 事一多，前者就变成一堵墙 —— 人打开看板最想知道的其实是后者。
 */
export type DueScope = 'all' | 'today' | 'overdue'

export const DUE_SCOPE_LABEL: Record<DueScope, string> = {
  all: '全部',
  today: '今天',
  overdue: '逾期'
}

/** 三个档的顺序，也是筛选栏上的排列顺序 */
export const DUE_SCOPES: DueScope[] = ['all', 'today', 'overdue']

/**
 * 是否落在所选范围内
 *
 * 两个口径都**只收未完成的事**：做完的不必再"今天处理"，
 * 逾期才做完的更不该再红着脸出现（卡片上也是同一个判断，见 isOverdue 的用法）。
 *
 * 「待确认」(proposed) 也排除：它是 agent 的提议，人还没拍板要不要做 ——
 * "我今天该处理哪些"问的是已立项的事，把提议混进来会虚增今日压力。
 *
 * 「今天」= 今天到期 **或** 今天提醒。
 * 只算 dueAt 会漏掉那些"没设截止、只设了提醒"的事，
 * 而对很多人来说，提醒时间才是真正的行动信号。
 */
export function matchesDueScope(todo: Todo, scope: DueScope): boolean {
  if (scope === 'all') return true
  // 废弃的卡不参与"今天/逾期"—— 它不是要做的事，只是一条结论
  if (todo.status === 'done' || todo.status === 'discarded') return false
  if (todo.status === 'proposed') return false

  const now = dayjs()
  const dayStart = now.startOf('day')
  const dayEnd = now.endOf('day')

  if (scope === 'overdue') {
    return !!todo.dueAt && dayjs(todo.dueAt).isBefore(now)
  }

  // today：用 isBefore/isAfter 而不是 isBetween —— 后者要装 dayjs 插件
  const inToday = (v: string | null) =>
    !!v && !dayjs(v).isBefore(dayStart) && !dayjs(v).isAfter(dayEnd)

  return inToday(todo.dueAt) || inToday(todo.remindAt)
}

/** 计数：给筛选栏上快捷档后面的数字用 */
export function countDueScope(todos: Todo[], scope: DueScope): number {
  if (scope === 'all') return todos.length
  return todos.filter((t) => matchesDueScope(t, scope)).length
}
