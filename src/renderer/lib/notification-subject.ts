/**
 * 通知的"未读 / 已知晓"是**按主体**的（卡 `c13dbb16`）
 *
 * ## 为什么 GUI 里也有"主体"这回事
 *
 * 数据层从 1.0.68（schema 28）起就把"谁读过"存成 `read_by` 这个集合，
 * agent 侧早就在按它算（`notification list --to-me`）。界面却一直只看全局那一份
 * `status`/`read_at` —— 而全局位**只有一份**：谁先把它翻过去，别人的未读就一起没了
 * （实测那条链路：agent `memo ack` → `markReadByRef` 写全局位 →
 * 主用户铃铛上那条当场消失）。
 *
 * PRD 2.1 把「主用户」与「agent」列为**并列的主体**，并写明主用户的主要通道是
 * **GUI**、agent 是 CLI/MCP；同一份 PRD 又要求通知的未读/已读按主体分别记。
 * 所以 GUI 窗口里的"我"就是主用户 —— 界面里根本没有"当前 agent"这个身份
 * （渲染层拿不到 `DESKPARTNER_AGENT`，设置里也没有这一项），
 * 看板的「视角切换器」把 `mine` 映射成 `human` 也是同一个口径。
 *
 * ## 主用户在 `read_by` 里叫什么
 *
 * `'human'` —— 与 CLI 侧同一个字面量：`actorOf()` 在调用方没声明身份时返回的就是它
 * （人在终端里敲 `notification list --ack-mine`，记的也是这个名字）。
 */
export const GUI_READER = 'human'

/**
 * `read_by` 这个逗号集合里都有谁
 *
 * 判据与 SQL 侧**逐字同义**（`instr(',' || read_by || ',', ',' || ? || ',')`）：
 * 空 / `null` = 没人读过；不做 trim、不折叠大小写 —— 与 `pageWhere`（CLI 那一路）
 * 和 `inboxWhere`（界面那一路）保持一致。
 * ⚠️ 两处判据一旦不同源，"这条到底算不算未读"就会有两个答案。
 */
export function readUsers(n: { readBy?: string | null }): string[] {
  return (n.readBy ?? '').split(',').filter(Boolean)
}

/** 这个人读过没有（"已知晓"） */
export function isKnownTo(n: { readBy?: string | null }, reader: string): boolean {
  return readUsers(n).includes(reader)
}

/** 这个人还没读过没有 —— 界面据此画"未读绿点 / 加粗"、决定按钮点不点得动 */
export function isUnreadFor(n: { readBy?: string | null }, reader: string): boolean {
  return !isKnownTo(n, reader)
}

/**
 * 记下"某人读过"之后的 `read_by`（界面乐观更新用；真值以主进程回执为准）
 *
 * 与 `NotificationRepository.markReadBy` 同一个语义：**集合追加、幂等、不覆盖别人**。
 */
export function withReader(readBy: string | null | undefined, reader: string): string {
  const users = readUsers({ readBy })
  if (!users.includes(reader)) users.push(reader)
  return users.join(',')
}
