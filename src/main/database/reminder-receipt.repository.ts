import { createHash } from 'node:crypto'
import { getDatabase } from './index'

/**
 * 跨 CLI 子进程持久化"这批提醒已经推给谁了"，不改变通知的全局或各主体已读状态。
 *
 * ## 未声明会话时也记账（1.0.111，卡 `48f4e326`）
 *
 * 原先是"没有会话声明就一律重复推"（`return summary.length > 0`），
 * 理由写的是"无法可靠判定'同一会话'，宁可重复，不静默漏报"。
 * Bob 1.0.106 实测的代价：**连续两条命令的 notice 完全相同（各 223 字节）**，
 * 照旧每条重复推「38 条指派 + 未读纸条」—— 而绝大多数调用方**根本不声明会话**：
 * 要它自己 `export DESKPARTNER_SESSION` 才生效，等于这条机制默认关着。
 *
 * 判据改成：**"同一会话"用"同一个身份的上一次提醒"来近似**。
 * 这不是在猜会话，是换个粒度记账 —— 同一身份、同一批内容只推一次。
 * 而摘要**每次现算**，内容一变（多了一条未读纸条、多了一张指派给它的卡）
 * 指纹就变、**立刻重新展开**；所以"静默漏报"只剩"内容一字未变"那一种情况，
 * 而那种情况正是要压掉的噪音。
 *
 * 七天过期：临时会话状态不无限增长，也不写入事件审计通道。
 */
export class ReminderReceiptRepository {
  /** 未声明会话时的兜底记账键（一个身份一行） */
  static readonly NO_SESSION_KEY = '(no-session)'
  /** Agent 已读说明书版本的持久化键（卡 `842a9879`） */
  static readonly SKILL_VERSION_KEY = '__skill_version__'

  private static keyOf(session?: string): string {
    return session?.trim() || ReminderReceiptRepository.NO_SESSION_KEY
  }

  /**
   * 记下"这批已经推给这个身份了"，并回答"与上一批相同吗"。
   *
   * 空摘要也要记：同一批提醒消失后**再次出现**时必须重新展开。
   *
   * @returns `same = true` 表示与上次推给它的那批一字不差（不必再展开）
   */
  record(actor: string, session: string | undefined, summary: string): { same: boolean } {
    const db = getDatabase()
    const key = ReminderReceiptRepository.keyOf(session)
    const fingerprint = createHash('sha256').update(summary).digest('hex')
    return db.transaction(() => {
      const now = new Date()
      const cutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString()
      const previous = db
        .prepare(
          'SELECT fingerprint FROM cli_reminder_receipts WHERE actor = ? AND session_id = ? AND updated_at >= ?'
        )
        .get(actor, key, cutoff) as { fingerprint: string } | undefined
      db.prepare('DELETE FROM cli_reminder_receipts WHERE updated_at < ?').run(cutoff)
      db.prepare(`INSERT INTO cli_reminder_receipts (actor, session_id, fingerprint, updated_at)
        VALUES (?, ?, ?, ?) ON CONFLICT(actor, session_id) DO UPDATE SET
        fingerprint = excluded.fingerprint, updated_at = excluded.updated_at`
      ).run(actor, key, fingerprint, now.toISOString())
      return { same: summary.length > 0 && previous?.fingerprint === fingerprint }
    })()
  }

  /** 这一批该不该展开（true = 与上次推给它的那批不同） */
  shouldExpand(actor: string, session: string | undefined, summary: string): boolean {
    if (summary.length === 0) {
      // 没有提醒也要记一笔：它重新出现时必须是"新的"
      this.record(actor, session, summary)
      return false
    }
    return !this.record(actor, session, summary).same
  }

  /**
   * snooze：把**当前这一批**标成"已知晓，别再推"（卡 `48f4e326` 的后半）。
   *
   * 语义刻意收窄成"同一批不再出现"：
   * - 内容一变（新纸条 / 新指派）→ 照旧推，snooze 不会把后来的东西一起吞掉；
   * - 与"已读"无关：它不动通知的全局或各主体已读位，只压回执顶部那一段摘要。
   *
   * @returns `changed` = 这次是否真的把一批新的标记掉了（同一批重复 snooze 为 false）
   */
  markSeen(
    actor: string,
    session: string | undefined,
    summary: string
  ): { changed: boolean; same: boolean; key: string } {
    const { same } = this.record(actor, session, summary)
    return {
      changed: !same && summary.length > 0,
      same,
      key: ReminderReceiptRepository.keyOf(session)
    }
  }

  /**
   * 登记该 Agent 已读取当前版本的内置说明书（卡 `842a9879`）。
   */
  recordSkillRead(actor: string, version: string): void {
    const trimmedActor = actor.trim()
    const trimmedVer = version.trim()
    if (!trimmedActor || !trimmedVer) return
    const db = getDatabase()
    const now = new Date().toISOString()
    db.prepare(
      `INSERT INTO cli_reminder_receipts (actor, session_id, fingerprint, updated_at)
       VALUES (?, ?, ?, ?) ON CONFLICT(actor, session_id) DO UPDATE SET
       fingerprint = excluded.fingerprint, updated_at = excluded.updated_at`
    ).run(trimmedActor, ReminderReceiptRepository.SKILL_VERSION_KEY, trimmedVer, now)
  }

  /** 读取该 Agent 最近登记已读的说明书版本（卡 `842a9879`） */
  getSkillReadVersion(actor: string): string | null {
    const trimmedActor = actor.trim()
    if (!trimmedActor) return null
    const db = getDatabase()
    const row = db
      .prepare('SELECT fingerprint FROM cli_reminder_receipts WHERE actor = ? AND session_id = ?')
      .get(trimmedActor, ReminderReceiptRepository.SKILL_VERSION_KEY) as
      | { fingerprint: string }
      | undefined
    return row?.fingerprint?.trim() || null
  }
}
