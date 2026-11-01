import dayjs from 'dayjs'
import { GUI_READER, readUsers } from '../../lib/notification-subject'

/**
 * 备忘「谁已经处理了」——界面上的唯一出处（卡 `5fd2b595`）
 *
 * ## 为什么「已看过」与「已处理」共用一个字段，不拆 `acked_by`
 *
 * `notifications.read_by` 是两个写方的**并集**，而写方本身就把语义分开了：
 * - `human` 只由界面打开写（`NotificationsView` 的 `GUI_READER`）—— 那是「已看过」；
 * - `agent:*` 只由 `memo ack` 写（`memo.repository.ts` 的 `ack()` →
 *   `notification.markReadByRef()`）—— 那是「已处理」，卡 `15557194` 起 reader 必填。
 *
 * 但「agent 看过」与「agent 接手」在 `read_by` 里长得一样，差别在**有没有顺手把
 * 全局已读位翻过去**（`markReadByRef` 翻、`markReadBy` 不翻，见 `processedReaders`）。
 * 所以「谁处理了这条」= 这件事已了结时，集合里非 `human` 的那些 —— 加一列 `acked_by`
 * 只会让同一个事实有两个存处、并多出一次迁移，换不来任何界面读不出来的东西。
 *
 * ## 时间从哪来
 *
 * 备忘的 ack 时间在 `memos.read_at`；`markReadByRef` 在**同一次 ack 里**把
 * `notifications.read_at` 也写成那一瞬（两句 `new Date()` 相隔毫秒）。
 * 渲染层拿不到备忘表那一列，就用通知行这一列 —— 不为一个可由别的行推出的时间
 * 再开一条 IPC。`read_at` 为空的老行（迁移前就了结的那些）**只写「已处理」不写时间**，
 * 不编造。
 *
 * ## 筛选档位（`待接手` / `全部`）为什么不在这个模块里判
 *
 * 这一档是**查询条件**，不是渲染判断：在 `items` 上 `.filter` 一遍就是
 * `cba46119` 那个坑（`matched` / `unread` / `byType` 仍是整范围的数、列表只剩子集），
 * 那条闸门就明写着「对一页 `.filter` 就是"筛选落在窗口之内"」。
 * 判据在 `InboxQuery.unhandled` → `inboxWhere` 的 SQL 里（卡 `5fd2b595` 的下推），
 * 这里只留界面要用的档位定义，不复制第二份判据。
 */
/**
 * 两档：待接手 / 全部
 *
 * 「只看已接手的」需要 WHERE 的另一半（`read_by` 里**有** agent），
 * 而 `unhandled: boolean` 只表达一个方向 —— 所以界面上只给它这一档的补集。
 * 已接手的记录在「全部」里照样看得见，行上有「谁已处理」。
 */
export type HandledFilter = 'open' | 'all'

/**
 * 默认档位 = 「待接手」
 *
 * 卡的诉求：已全处理完的别占注意力。导出成常量而不是在组件里写字符串 ——
 * 这条口径要被一条断言钉住（改了默认档位，用例就红）。
 */
export const DEFAULT_HANDLED_FILTER: HandledFilter = 'open'

/** 三档的呈现顺序与文案（界面与用例共用同一份，避免各写一套） */
export const HANDLED_FILTER_OPTIONS: ReadonlyArray<{ value: HandledFilter; label: string }> = [
  { value: 'open', label: '待接手' },
  { value: 'all', label: '全部' }
]

/** 「待接手」那一行行尾的字样：没人 ack 过（含 1.0.68 前的 `read_by` 为 NULL 的历史行） */
export const UNHANDLED_LABEL = '无人接手'

type HandledSource = { readBy?: string | null; readAt?: string | null; status?: string | null }

/**
 * 处理过这条的主体（**不含**主用户）
 *
 * ## 为什么还要看 `status`，而不是光看 `read_by` 的前缀
 *
 * `read_by` 里的 `agent:*` 有两个写方：
 * - `markReadByRef`（`memo ack`）：追加读者 **并且**把全局位翻成已读 ——「接手了」；
 * - `markReadBy`（CLI `notification list --ack-mine`）：只追加读者 ——「看过了」，
 *   并不等于有人处理（卡 `c13dbb16` 就是用这条路径证明"agent 看过 ≠ 我已读过"）。
 *
 * 只看前缀会把后者也叫成「已处理」：列表说没人接手、行尾却说别人处理了，
 * 两个读数互相打脸。所以判据取两者的合取，与 SQL 侧 `inboxWhere` 的 `unhandled`
 * 分支**逐字同义**（那边是 `status <> 'read' OR read_by IS NULL OR '' OR 'human'`）。
 * 一旦两处不同源，「这条到底算不算已处理」就会有两个答案。
 */
export function processedReaders(n: HandledSource): string[] {
  if (n.status !== 'read') return []
  return readUsers(n).filter((reader) => reader !== GUI_READER)
}

/** 有没有 agent 接手过（主用户自己点开过 ≠ 有人处理了） */
export function isHandled(n: HandledSource): boolean {
  return processedReaders(n).length > 0
}

/**
 * 处理时间：**绝对时间**，不写「刚刚」/「3 小时前」
 *
 * 行尾那一列已经是「创建时间的相对说法」了，这里再来一个相对值，
 * 两个读数会互相打架（而且"多久以前"答不了卡要的"什么时候处理的"）。
 * 同年省掉年份、跨年补上 —— 与卡里给的例子（`10-31 14:02`）同一个形状。
 */
export function fmtHandledAt(iso: string | null | undefined): string | null {
  if (!iso) return null
  const at = dayjs(iso)
  if (!at.isValid()) return null
  return at.isSame(dayjs(), 'year') ? at.format('MM-DD HH:mm') : at.format('YYYY-MM-DD HH:mm')
}

/**
 * 行上那句话：`alice 已处理 10-31 14:02` / `alice 已处理` / `无人接手`
 *
 * `nameOf` 由调用方注入（界面里是 `resolveActorDisplay`：先查 agent 的
 * displayName，查不到退回去掉 `agent:` 前缀的 id）—— 纯函数不碰 store，
 * 判据才能单独测。
 */
export function handledSummary(
  n: HandledSource,
  nameOf: (reader: string) => string
): { handled: boolean; text: string } {
  const readers = processedReaders(n)
  if (readers.length === 0) return { handled: false, text: UNHANDLED_LABEL }
  const names = readers.map(nameOf).join('、')
  const at = fmtHandledAt(n.readAt)
  return { handled: true, text: at ? `${names} 已处理 ${at}` : `${names} 已处理` }
}
