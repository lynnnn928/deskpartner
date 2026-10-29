/**
 * 通知中心（1.0.48，schema v21）
 *
 * 五类事件一个收件箱：待办提醒 / 审批申请 / 执行回执 / agent 备忘 / 待验收交付。
 * 通知是**索引不是操作台**：行内不做动作，详情与操作回到源数据
 * （备忘走 memo 通道、审批走 agent 通道、待办走详情抽屉）。
 *
 * `decision`（1.0.65 加，schema 仍是 v25 —— `type` 是无约束 TEXT 列，
 * 加一类值不需要迁移）：事项进「待确认」等人拍板。缺了它，
 * proposed 会无限堆积而没人知道。
 */
export type NotificationType =
  | 'reminder'
  | 'grant'
  | 'exec_result'
  | 'memo'
  | 'review'
  | 'decision'

export interface AppNotification {
  id: string
  type: NotificationType
  title: string
  summary: string
  /** 源记录 id：todo / grant / memo */
  refId: string | null
  /** 触发者（agent:xxx / human / null=系统） */
  actor: string | null
  status: 'unread' | 'read'
  /** JSON 字符串：类型相关的附加信息（exec_result 的 ok 标志等） */
  meta: string | null
  createdAt: string
  /** 全局已读时间（**界面铃铛的老口径**；界面现在按 `readBy` 算，见下） */
  readAt: string | null
  /**
   * 给谁（1.0.68）：`agent:xxx` / `human` / null = 广播或人自己产生的
   *
   * ⚠️ 与 `actor`（谁触发的）是**两个身份**。
   */
  recipient: string | null
  /**
   * 谁读过（1.0.68）：逗号分隔的主体集合（`agent:xxx` / `human`）
   *
   * ⚠️ **已读位不是布尔，是"谁读过"这个集合**（卡 `c13dbb16`）。
   * 界面里的"未读"必须问"**我**读过没有"（`lib/notification-subject.ts`），
   * 不能再只看全局 `status`：那个位只有一份，谁先读都算读过 ——
   * agent 的 `memo ack` 一走，主用户的未读就被吃掉了。
   *
   * `null` = 1.0.68 之前的历史行，不知道是谁读的（迁移 28 的原话）。
   */
  readBy: string | null
}

/**
 * 带「归属项目」的通知（GUI 信息架构重设计，21ac3b3e）
 *
 * 通知表没有 `project_id`（也不加）。归属靠**读侧反查**：
 * 通知所指事项（`ref_id`；备忘走 `linked_todo_id`）的 `project_id`。
 * 反查不到（备忘没关联事项 / 事项已删 / 回执类）就是 null。
 */
export interface InboxNotification extends AppNotification {
  /** 通知所指事项所属项目；反查不到为 null */
  projectId: string | null
  /** 点开要打开的事项（审批回执等没有事项的为 null） */
  /** 点开要打开的事项（审批回执等没有事项的为 null） */
  todoId: string | null
}

/**
 * 收件箱的一页（1.0.107 修 `cba46119`）
 *
 * ⚠️ `rows` 之外那几个数**都不含窗口**，由主进程用与列表**同一份 WHERE** 数出来。
 * 只给一页的话，界面就只能对那一页去数 —— 那正是"角标 633、页头 484、
 * 列表只列得出 500"的来源。
 */
export interface InboxPage {
  rows: InboxNotification[]
  /** 命中总数（不含窗口）：界面据此说"还有 N 条"，也据此决定能不能继续读 */
  matched: number
  /** 这一页回了几条 */
  returned: number
  /** 这一页之后还有没有 */
  truncated: boolean
  /** 下一页的起点；读到底了是 null */
  nextOffset: number | null
  /** **整个范围**里每一类各多少条、其中多少条未读（分类 chip 的数字） */
  byType: Partial<Record<NotificationType, { total: number; unread: number }>>
  /** 当前范围里**当前这一类**的未读（页头的「未读 N」） */
  unread: number
}
