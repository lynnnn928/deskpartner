import type { Agent, Todo, TodoOwner } from '../types/todo'

/**
 * 执行者选择器里的一个候选项
 *
 * `selectable=false` 的只有一种来源：事项**已经**指派给了某个 agent，
 * 但它当前不是"已注册且已批准"。这一项必须显示出来（否则界面看起来像没指派），
 * 但不能被新选中——批准是人在设置页点的那一下，下拉不能绕过它。
 */
export interface ExecutorOption {
  id: TodoOwner
  selectable: boolean
}

/**
 * 计算执行者候选（61172cf3：执行体下拉）
 *
 * - 可新选的：agents 表里 `approved === true` 的主体，保持 agents 的原顺序。
 * - 当前已指派的 agent 若不在其中（未批准、被撤销、已从名单消失）：
 *   追加在末尾并标 `selectable=false`，保证"当前是谁"始终可见。
 * - 当前执行者是 human / null 时不追加：human 有自己的固定按钮。
 *
 * 纯函数，不读 store，便于单测。
 */
export function assignableExecutors(
  agents: readonly Agent[],
  current: TodoOwner | null | undefined
): ExecutorOption[] {
  const options: ExecutorOption[] = agents
    .filter((a) => a.approved)
    .map((a) => ({ id: a.id as TodoOwner, selectable: true }))

  if (
    current &&
    current.startsWith('agent:') &&
    !options.some((o) => o.id === current)
  ) {
    options.push({ id: current, selectable: false })
  }
  return options
}

/**
 * 这条事**实际由谁做**（b95e6bbb）
 *
 * `executedBy` 空着不是"没有执行者"，语义是"提出即执行"（执行者 = 提出者）——
 * 主进程侧的自验守卫（G10）比的也是同一个表达式 `executedBy ?? createdBy`，
 * 所以界面这一处必须同口径。空着的执行者若在界面上什么都不显示，
 * 就会被读成"这条没人管"（`8f881db6` 正是这么被读错的）。
 *
 * 纯函数，不读 store，便于单测。
 */
export function effectiveExecutor(todo: Pick<Todo, 'createdBy' | 'executedBy'>): TodoOwner {
  return todo.executedBy ?? todo.createdBy
}
