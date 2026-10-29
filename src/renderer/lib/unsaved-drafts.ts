import type { QuickAddRoute } from '../components/quick-add/useQuickAddRoute'
import type { Todo, TodoOwner } from '../types/todo'
import type { TodoPriority, TodoStatus, TodoType } from '../types/enums'
import { STATUS_META } from './constants'

/**
 * 没保存的输入先存哪儿（卡 6a595ad0）
 *
 * ── 为什么需要它 ──
 *
 * QuickAdd 表单和驳回理由弹窗都会"一关就没"：
 *
 * - 驳回理由原先只活在弹窗自己的 state 里：遮罩一点就是 onClose → 弹窗卸载 → 没了。
 *   没有提示，也没有任何地方能找回来。
 * - QuickAdd 表单更麻烦：**换一条事项时主进程是整页重载**（见 windows.ts 复用分支的
 *   说明，2026-10-22 实测：loadFile 打到与当前**完全相同**的 URL 也会整页重载）。
 *   所以"把草稿放在内存里"在这条路上不管用 —— 页面一起没了，草稿得活过重载。
 *
 * ── 为什么是 sessionStorage，不是 localStorage ──
 *
 * 它保护的是"**这一次会话里没保存的输入**"，不是长期状态：
 * 换一条事项再回来（页面已重载）应该还在，应用重启后就该没了 ——
 * 否则几天后打开一条事项会突然冒出一段早就忘了的旧文字。
 * sessionStorage 正是这个生命周期（跟着窗口的会话走，重载不丢、关窗即散）。
 *
 * 这里所有函数**都不抛**：草稿是多一层保险，它坏掉顶多退回旧行为，
 * 不该反过来把表单或弹窗弄崩（隐私模式、存储写满都要扛得住）。
 */

/** QuickAdd 表单这一刻的完整样子：既用来判"改没改"，也用来当草稿 */
export interface QuickAddDraft {
  title: string
  remindAt: string | null
  categoryIds: string[]
  showOptions: boolean
  projectId: string | null
  parentId: string | null
  status: TodoStatus
  owner: TodoOwner
  executedBy: TodoOwner | null
  todoType: TodoType
  showDetail: boolean
  description: string
  priority: TodoPriority
  dueAt: string | null
  fixedInVersion: string | null
}

const QUICK_ADD_PREFIX = 'deskpartner.quickAdd.draft.'
const REJECT_REASON_PREFIX = 'deskpartner.reject.draft.'

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage
  } catch {
    // 取不到存储（某些沙箱里访问本身就抛）就当没有草稿，不影响本来的功能
    return null
  }
}

function readRaw(key: string): string | null {
  const s = storage()
  if (!s) return null
  try {
    return s.getItem(key)
  } catch {
    return null
  }
}

function writeRaw(key: string, value: string): void {
  const s = storage()
  if (!s) return
  try {
    s.setItem(key, value)
  } catch {
    /* 存不下就算了：丢的是那层保险，不是用户已经看得到的内容 */
  }
}

function dropRaw(key: string): void {
  const s = storage()
  if (!s) return
  try {
    s.removeItem(key)
  } catch {
    /* 同上 */
  }
}

/**
 * 表单这份草稿属于哪一次打开
 *
 * 编辑按**事项**记：回来找的就是同一条。
 * 新增按"从哪一列来 + 落在哪个项目"记：没有 id 可用，而这两项决定了这份草稿
 * 提交出来是什么样子（从两列分别起的两条，不该互相顶掉）。
 */
export function quickAddRouteKey(route: QuickAddRoute): string {
  if (route.todoId) return `edit:${route.todoId}`
  return `new:${route.status ?? ''}:${route.projectId ?? ''}`
}

/**
 * 一条事项装载进表单后的样子
 *
 * 它同时是**基准**（装载完成时表单就等于它，之后只要有人动了输入框就对不上 =
 * 有未保存的修改）和**"库里那份"**（点「放弃这些修改」回到的就是它）。
 *
 * 必须与 QuickAddForm 里装载时铺进表单的字段同源 —— 所以那段 setState 直接吃
 * 这个对象，而不是各自写一遍。`showOptions`/`showDetail` 那两个默认展开的口径
 * 也在这里：它们曾经写在装载的 setState 里。
 */
export function quickAddDraftFromTodo(todo: Todo): QuickAddDraft {
  return {
    title: todo.title,
    remindAt: todo.remindAt,
    categoryIds: todo.categoryIds,
    showOptions: !!(
      todo.remindAt ||
      todo.categoryIds.length ||
      todo.createdBy !== 'human' ||
      todo.executedBy
    ),
    projectId: todo.projectId,
    parentId: todo.parentId,
    status: todo.status,
    owner: todo.createdBy,
    executedBy: todo.executedBy,
    todoType: todo.type,
    // 已有详细信息的任务，编辑时直接展开，避免用户以为数据丢了
    showDetail: !!(
      todo.description ||
      todo.dueAt ||
      todo.priority !== 'normal' ||
      todo.type !== 'task'
    ),
    description: todo.description ?? '',
    priority: todo.priority,
    dueAt: todo.dueAt,
    fixedInVersion: todo.fixedInVersion
  }
}

/** 两份表单是不是同一份内容（判"改没改"用的就是它） */
export function sameQuickAddDraft(a: QuickAddDraft, b: QuickAddDraft): boolean {
  return (
    a.title === b.title &&
    a.remindAt === b.remindAt &&
    // 标签是多值：逐项比，别指望数组引用相等
    a.categoryIds.length === b.categoryIds.length &&
    a.categoryIds.every((id, i) => id === b.categoryIds[i]) &&
    a.showOptions === b.showOptions &&
    a.projectId === b.projectId &&
    a.parentId === b.parentId &&
    a.status === b.status &&
    a.owner === b.owner &&
    a.executedBy === b.executedBy &&
    a.todoType === b.todoType &&
    a.showDetail === b.showDetail &&
    a.description === b.description &&
    a.priority === b.priority &&
    a.dueAt === b.dueAt &&
    a.fixedInVersion === b.fixedInVersion
  )
}

/** 是不是一份能用的表单草稿（版本升级/手改过的旧数据要认得出来） */
function isQuickAddDraft(v: unknown): v is QuickAddDraft {
  if (!v || typeof v !== 'object') return false
  const d = v as Record<string, unknown>
  const nullableString = (x: unknown) => x === null || typeof x === 'string'
  return (
    typeof d.title === 'string' &&
    nullableString(d.remindAt) &&
    Array.isArray(d.categoryIds) &&
    d.categoryIds.every((c) => typeof c === 'string') &&
    typeof d.showOptions === 'boolean' &&
    nullableString(d.projectId) &&
    nullableString(d.parentId) &&
    // 状态必须是真存在的：编辑模式那一行状态按钮要拿它去查 STATUS_META
    typeof d.status === 'string' &&
    Object.prototype.hasOwnProperty.call(STATUS_META, d.status) &&
    typeof d.owner === 'string' &&
    nullableString(d.executedBy) &&
    typeof d.todoType === 'string' &&
    typeof d.showDetail === 'boolean' &&
    typeof d.description === 'string' &&
    typeof d.priority === 'string' &&
    nullableString(d.dueAt) &&
    nullableString(d.fixedInVersion)
  )
}

export function readQuickAddDraft(route: QuickAddRoute): QuickAddDraft | null {
  const raw = readRaw(QUICK_ADD_PREFIX + quickAddRouteKey(route))
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    // 形状不对就当没有：旧版本写下的草稿不该把表单带崩
    return isQuickAddDraft(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function writeQuickAddDraft(route: QuickAddRoute, draft: QuickAddDraft): void {
  writeRaw(QUICK_ADD_PREFIX + quickAddRouteKey(route), JSON.stringify(draft))
}

export function clearQuickAddDraft(route: QuickAddRoute): void {
  dropRaw(QUICK_ADD_PREFIX + quickAddRouteKey(route))
}

/**
 * 驳回理由的草稿
 *
 * 按 todoId 记：同一张卡被退回两次，第二次打开要把上次没说出口的理由还给他。
 * 空字符等同于没有（"填了又删干净"不该再算一段没提交的理由）。
 */
export function readRejectReason(todoId: string): string {
  return readRaw(REJECT_REASON_PREFIX + todoId) ?? ''
}

export function writeRejectReason(todoId: string, text: string): void {
  if (!text) {
    dropRaw(REJECT_REASON_PREFIX + todoId)
    return
  }
  writeRaw(REJECT_REASON_PREFIX + todoId, text)
}

export function clearRejectReason(todoId: string): void {
  dropRaw(REJECT_REASON_PREFIX + todoId)
}
