import type { Todo } from '../types/todo'
import type { TodoStatus } from '../types/enums'
import type { WorkspaceMode, WorkItemScope } from '../stores/ui.store'
import { BOARD_COLUMNS } from './constants'
import {
  matchesTodoFilter,
  matchesViewScope,
  matchesWorkspaceStatus,
  type TodoFilter
} from './todo-filter'
import { matchesDueScope, type DueScope } from './due-scope'

/**
 * 「这一屏上到底看得见哪些卡」的单源判据（f6f78ada）
 *
 * ── 要消灭的是什么 ──
 *
 * 角标、空态提示、列里的卡片都得回答同一个问题：「现在屏幕上到底有几张卡」。
 * 三处各写一份判断链（先滤工作空间状态、再滤视角、再滤筛选、再滤截止时间），
 * 改一处忘一处就会出现"数字与卡片对不上" —— 而人对不上的第一反应是"数字是错的"。
 *
 * 所以判断链只在这里写一次：`visibleColumns` 回答"哪几列看得见"，
 * `isCardVisible` 回答"这张卡看得见吗"，`countVisibleCards` 是它的和。
 * 看板用它们渲染列与卡，窗口层与 chips 回显行用同一个数显示角标。
 *
 * ── 为什么列也要判一次 ──
 *
 * 「当前工作 / 已结束 / 全部」决定哪些列存在（matchesWorkspaceStatus），
 * `filterStatus` 是列之上的精确筛选 —— 两者都是**列的**可见性，不属于单张卡。
 * 少了这一层，「当前工作」这一屏会把已完成、挂起的卡也算进数字里。
 *
 * 列序单源仍是 lib/constants.ts 的 BOARD_COLUMNS：调用方可以把自己那份传进来
 * （看板就传它的 COLUMNS），不传就用单源。
 */
export interface BoardVisibility {
  workspaceMode: WorkspaceMode
  workItemScope: WorkItemScope
  /** 状态精确筛选（null = 全部状态） */
  filterStatus: TodoStatus | null
  /** 视角：'all' / 'mine' / 'agent:xxx'（谁的事） */
  viewScope: string
  /** 关键字 + 标签 + 归属 + 项目 + 优先级 + 类型 + 版本 + 创建时间 */
  filter: TodoFilter
  /** 今天 / 逾期 / 全部（按截止时间） */
  dueScope: DueScope
}

/** 这一列本身在不在屏幕上（列序由 columns 给出） */
function columnIsVisible(
  status: TodoStatus,
  v: BoardVisibility,
  columns: TodoStatus[]
): boolean {
  return (
    columns.includes(status) &&
    matchesWorkspaceStatus(status, v.workspaceMode, v.workItemScope) &&
    (!v.filterStatus || status === v.filterStatus)
  )
}

/** 屏幕上真正渲染出来的列（顺序即列序） */
export function visibleColumns(
  v: BoardVisibility,
  columns: TodoStatus[] = BOARD_COLUMNS
): TodoStatus[] {
  return columns.filter((status) => columnIsVisible(status, v, columns))
}

/**
 * 这张卡会不会出现在看板上
 *
 * 逐条对应看板渲染列内卡片的那串判断：在可见列里 → 视角 → 筛选 → 截止时间。
 */
export function isCardVisible(
  todo: Todo,
  v: BoardVisibility,
  columns: TodoStatus[] = BOARD_COLUMNS
): boolean {
  return (
    columnIsVisible(todo.status, v, columns) &&
    matchesViewScope(todo, v.viewScope) &&
    matchesTodoFilter(todo, v.filter) &&
    matchesDueScope(todo, v.dueScope)
  )
}

/** 屏幕上真正渲染出来的卡片 */
export function visibleCards(
  todos: Todo[],
  v: BoardVisibility,
  columns: TodoStatus[] = BOARD_COLUMNS
): Todo[] {
  return todos.filter((todo) => isCardVisible(todo, v, columns))
}

/** 屏幕上真正渲染出来的卡片数 —— 角标上那个 N */
export function countVisibleCards(
  todos: Todo[],
  v: BoardVisibility,
  columns: TodoStatus[] = BOARD_COLUMNS
): number {
  return visibleCards(todos, v, columns).length
}
