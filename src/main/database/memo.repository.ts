import { UsageError } from '../lib/domain-errors'
import { randomUUID } from 'node:crypto'
import { getDatabase } from './index'
import { NotificationRepository } from './notification.repository'

/** 备忘回复（卡 14ae42e5）：归属在同一条备忘线程下，不另建独立备忘条目 */
export interface MemoReply {
  id: string
  author: string
  recipient: string | null
  text: string
  createdAt: string
}

/** 备忘（memo）：AI 给人或跨身份递的纸条，不是待办 */
export interface Memo {
  id: string
  /** 递这张的人（1.0.68 起与 recipient 分开），与 todos.owner 同约定：human / agent:<id> */
  author: string
  /**
   * 给谁（1.0.68，schema 27）
   *
   * ⚠️ **与 author 是两个身份**。它们曾经共用一列 ——
   * `memo add --owner agent:x` 会把 author 写成收件人，
   * 于是"这张纸条是谁递的"查不出来，**审计链反了而且不报错**。
   *
   * null = 没指定收件人（自己记的备忘，或历史行没记）。
   */
  recipient: string | null
  text: string
  /** 关联的待办（可选）；待办删除时置空，备忘本身仍成立 */
  linkedTodoId: string | null
  /** unread | read */
  status: 'unread' | 'read'
  createdAt: string
  readAt: string | null
  /** 同一线程内的回复记录（有回复时带出；存量无回复的单条不带此字段以保持向后兼容） */
  replies?: MemoReply[]
}

export interface CreateMemoInput {
  /** 递这张的人 */
  author: string
  /** 给谁；不传 = 没指定收件人（1.0.68 起与 author 分开） */
  recipient?: string | null
  text: string
  linkedTodoId?: string | null
  // ── 以下字段**只给备份导入用**（1.0.46） ──
  // 普通新建不传：id 由仓库生成、恒为未读、时间取当下。
  /** 指定 id（备份导入用） */
  id?: string
  /** 已读/未读（备份导入用）。不传为 unread */
  status?: 'unread' | 'read'
  /** 原始创建时间（备份导入用） */
  createdAt?: string
  /** 原始阅读时间（备份导入用） */
  readAt?: string | null
  /** 备份导入恢复线程回复 */
  replies?: MemoReply[]
}

export interface ReplyMemoInput {
  author: string
  recipient?: string | null
  text: string
  createdAt?: string
}

const ensuredDbs = new WeakSet<object>()

/**
 * 备忘仓储
 *
 * 设计约束：备忘与待办分表，因为它们的生命周期完全不同——
 * 待办有状态机（待办/进行中/挂起/完成），备忘只有"读过没读过"。
 * 混进 todos 表会让看板、统计、"今天/逾期"全都多出一堆例外。
 */
export class MemoRepository {
  private get db() {
    const db = getDatabase()
    if (!ensuredDbs.has(db)) {
      try {
        const cols = db.prepare('PRAGMA table_info(memos)').all() as Array<{ name: string }>
        if (cols.length > 0 && !cols.some((c) => c.name === 'replies')) {
          db.exec(`ALTER TABLE memos ADD COLUMN replies TEXT NOT NULL DEFAULT '[]';`)
        }
        ensuredDbs.add(db)
      } catch {
        /* 仅在 memos 表存在时自动补齐 replies 列 */
      }
    }
    return db
  }

  create(input: CreateMemoInput): Memo {
    const text = input.text.trim()
    if (!text) throw new UsageError('memo text 不能为空')

    const replies = Array.isArray(input.replies) ? input.replies : []

    /**
     * id / status / 时间戳可由调用方指定（备份导入）。
     * 普通新建一律走默认 —— 导入要还原的是"当时那条备忘"，
     * 包括它是否已读、什么时候读的。
     */
    const memo: Memo = {
      id: input.id?.trim() || randomUUID(),
      author: input.author,
      /**
       * 收件人（1.0.68，schema 27）
       *
       * ⚠️ 与 `author` **是两个身份**：我是谁递的 vs 我给谁的。
       * 它们曾经是同一列 —— 于是"这张纸条是谁递的"查不出来，**审计链反了且不报错**。
       */
      recipient: input.recipient ?? null,
      text,
      linkedTodoId: input.linkedTodoId ?? null,
      status: input.status ?? 'unread',
      createdAt: input.createdAt ?? new Date().toISOString(),
      readAt: input.readAt ?? null,
      ...(replies.length > 0 ? { replies } : {})
    }

    this.db
      .prepare(
        `INSERT INTO memos (id, author, recipient, text, linked_todo_id, status, created_at, read_at, replies)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        memo.id,
        memo.author,
        memo.recipient ?? null,
        memo.text,
        memo.linkedTodoId,
        memo.status,
        memo.createdAt,
        memo.readAt,
        JSON.stringify(replies)
      )

    /**
     * 通知中心（1.0.48）：备忘是五类通知之一，产生时顺手写索引。
     * 备份导入走的也是这条路 —— 但导入的是历史，不该刷屏，
     * 所以只有未读的新备忘才进收件箱（导入可指定 status=read）。
     */
    if (memo.status === 'unread') {
      try {
        new NotificationRepository().create({
          type: 'memo',
          title: memo.text.length > 60 ? `${memo.text.slice(0, 60)}…` : memo.text,
          summary: memo.text,
          refId: memo.id,
          actor: memo.author,
          meta: replies.length > 0 ? { replies } : null,
          /**
           * 给谁（1.0.68，schema 28）
           *
           * ⚠️ 此前**通知不记收件人** —— 于是"这条是给我的"查不出来，
           * 两个 agent 只能每轮全量拉回来自己认。
           * 而"谁在什么时候提醒我什么"正是这个产品对 agent 的核心卖点。
           */
          recipient: memo.recipient
        })
      } catch (e) {
        // 通知是索引，写不进去不该让备忘本身失败
        console.warn('[Notification] 备忘索引写入失败:', e instanceof Error ? e.message : e)
      }
    }
    return memo
  }

  /**
   * 在同一条备忘线程下追加回复（卡 `14ae42e5`）：
   * - 不新建独立备忘条目，也不在通知收件箱增加新行；
   * - 对回复方视为已处理原备忘，并将线程收件人与未读状态转向被回复方。
   */
  reply(id: string, input: ReplyMemoInput): { memo: Memo; reply: MemoReply } | null {
    const existing = this.get(id)
    if (!existing) return null

    const text = input.text.trim()
    if (!text) throw new UsageError('memo reply text 不能为空')

    // 若未显式传收件人，默认回给原线程的另一方（若我是收件人则回给原发件人，若我是发件人则发给原收件人）
    const inferredRecipient =
      input.recipient !== undefined
        ? input.recipient
        : existing.author !== input.author && !existing.author.startsWith('unknown:')
          ? existing.author
          : existing.recipient

    const replyItem: MemoReply = {
      id: randomUUID(),
      author: input.author,
      recipient: inferredRecipient ?? null,
      text,
      createdAt: input.createdAt ?? new Date().toISOString()
    }

    const nextReplies = [...(existing.replies ?? []), replyItem]
    const nextRecipient = replyItem.recipient ?? existing.recipient
    // 若明确回复给另一方，线程对新收件人呈未读；否则视为已读闭环
    const hasOtherRecipient = Boolean(nextRecipient && nextRecipient !== input.author)
    const nextStatus: 'unread' | 'read' = hasOtherRecipient ? 'unread' : 'read'
    const nextReadAt = hasOtherRecipient ? null : existing.readAt ?? replyItem.createdAt

    this.db
      .prepare(
        `UPDATE memos
            SET replies = ?,
                recipient = ?,
                status = ?,
                read_at = ?
          WHERE id = ?`
      )
      .run(JSON.stringify(nextReplies), nextRecipient, nextStatus, nextReadAt, id)

    // 同步更新收件箱中该条备忘的唯一索引行（不新增通知行，且将回复方记入 read_by）
    try {
      const latestSummary = `${existing.text}\n\n[最新回复 · ${replyItem.author}] ${replyItem.text}`
      this.db
        .prepare(
          `UPDATE notifications
              SET summary = ?,
                  actor = ?,
                  recipient = ?,
                  status = ?,
                  read_at = ?,
                  read_by = ?,
                  meta = ?
            WHERE type = 'memo' AND ref_id = ?`
        )
        .run(
          latestSummary,
          replyItem.author,
          nextRecipient,
          nextStatus,
          nextReadAt,
          input.author,
          JSON.stringify({ replies: nextReplies }),
          id
        )
    } catch {
      /* 通知索引更新失败不影响备忘本体 */
    }

    const updated: Memo = {
      ...existing,
      recipient: nextRecipient,
      status: nextStatus,
      readAt: nextReadAt,
      replies: nextReplies
    }
    return { memo: updated, reply: replyItem }
  }

  /** 全量清单（铃铛面板用），新→旧 */
  list(): Memo[] {
    // 同毫秒创建的两条 memo created_at 相同，ORDER BY 会退化成不确定顺序 ——
    // 补 rowid 作次序 tiebreak：rowid 大 = 后插入 = 更新
    const rows = this.db
      .prepare('SELECT * FROM memos ORDER BY created_at DESC, rowid DESC')
      .all() as Record<string, unknown>[]
    return rows.map(MemoRepository.mapRow)
  }

  get(id: string): Memo | null {
    const row = this.db.prepare('SELECT * FROM memos WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined
    return row ? MemoRepository.mapRow(row) : null
  }

  /**
   * 标记已读（幂等：重复 ack 不改已读时间）
   *
   * `reader` **必填**（卡 `15557194`，1.0.132）：ack 会把收件箱里那条的全局位标成已读，
   * 而按 `c13dbb16` 的口径「全局已读」必须同时记下**是谁**读的，否则主用户那边
   * 仍按自己的 `read_by` 算未读，收件箱把它重新亮出来。
   *
   * 此前这里调的是 `markReadByRef(id)` —— 只写全局位、不写 `read_by`，于是
   * **每 ack 一条备忘就造一行「已读却没人记名」**（2026-10-29 真库里积了 5 条）。
   * 参数改成必填而不是默认 `'human'`：这正是「规范由机制保证，不由调用方自觉」——
   * 默认值会让下一个调用点悄悄退化成同一个 bug。
   */
  ack(id: string, reader: string): Memo | null {
    const existing = this.get(id)
    if (!existing) return null
    if (existing.status === 'read') return existing

    const readAt = new Date().toISOString()
    this.db.prepare(`UPDATE memos SET status = 'read', read_at = ? WHERE id = ?`).run(readAt, id)
    // 通知中心的同源已读：备忘已读，它的索引不该继续亮着（读者一并记下）
    try {
      new NotificationRepository().markReadByRef(id, reader)
    } catch {
      /* 索引同步失败不影响备忘本身 */
    }
    return { ...existing, status: 'read', readAt }
  }

  remove(id: string): boolean {
    const changes = this.db.prepare('DELETE FROM memos WHERE id = ?').run(id).changes
    if (changes > 0) {
      // 源记录没了，收件箱里的索引一并撤（不指向空气）
      try {
        new NotificationRepository().removeByRef(id)
      } catch {
        /* 同上 */
      }
    }
    return changes > 0
  }

  /** 未读数：铃铛角标用 */
  unreadCount(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM memos WHERE status = 'unread'`)
      .get() as { n: number }
    return row.n
  }

  private static mapRow(row: Record<string, unknown>): Memo {
    let replies: MemoReply[] = []
    if (typeof row.replies === 'string' && row.replies.trim()) {
      try {
        const parsed = JSON.parse(row.replies)
        if (Array.isArray(parsed)) replies = parsed as MemoReply[]
      } catch {
        replies = []
      }
    }
    return {
      id: row.id as string,
      author: row.author as string,
      // 存量行的 recipient 可能为 NULL（迁移 27 里"历史行没记发起方"就置空）
      recipient: (row.recipient as string) ?? null,
      text: row.text as string,
      linkedTodoId: (row.linked_todo_id as string) ?? null,
      status: (row.status as Memo['status']) ?? 'unread',
      createdAt: row.created_at as string,
      readAt: (row.read_at as string) ?? null,
      ...(replies.length > 0 ? { replies } : {})
    }
  }
}
