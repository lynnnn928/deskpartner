import { UsageError } from '../lib/domain-errors'
import { randomUUID } from 'node:crypto'
import { hasClosureSections } from './closure-structure'
import { getDatabase } from './index'

/** 评论作者类型：人 / agent / 系统（迁移/自动动作） */
export type CommentAuthorType = 'human' | 'agent' | 'system'

/**
 * 评论种类（1.0.54）
 *
 * - `comment` 普通往来；
 * - `reject` 验收驳回（带"哪里做的不好"），配合「待验收→进行中」流转；
 * - `rework` 执行方返工说明；
 * - `system` 状态流转/迁移自动留下的记录。
 */
export type CommentKind = 'comment' | 'reject' | 'rework' | 'system'

export interface TodoComment {
  id: string
  todoId: string
  /** 回复的父评论 id（楼中楼）；顶层为 null */
  parentId: string | null
  authorType: CommentAuthorType
  /** 具体身份：agent:<id> 或 human；系统评论为 null */
  authorId: string | null
  body: string
  kind: CommentKind
  createdAt: string
  /**
   * 给谁（1.0.68，schema 29）
   *
   * ⚠️ 与 `parentId` **是两件事**：
   * - `parentId` = 我**知道有那条评论**才回它（pull）
   * - `recipient` = **你在评论上留话，他被动能看到**（push / 叫醒）
   *
   * null = 没指定给谁（对着卡说的，回应者自己看）
   */
  recipient: string | null
}

export interface CreateCommentInput {
  todoId: string
  body: string
  parentId?: string | null
  authorType?: CommentAuthorType
  authorId?: string | null
  kind?: CommentKind
  /** 给谁（1.0.68）；不传 = 对着卡说，回应者自己看 */
  recipient?: string | null
}

/**
 * 事项评论仓储（1.0.54，schema v23）
 *
 * 与 `NotificationRepository` 的分工：
 * - 通知是**全局收件箱**（跨事项、有未读角标、生命周期"产生-被读-没了"）；
 * - 评论是**单条事项内的对话上下文**（不参与未读计数、不随读而消失）；
 * - 驳回两边都写：通知告诉执行方"你有活被退回"，评论留下"为什么退回"。
 *
 * `description` 与评论的边界：description = 规格（可编辑、应当稳定），
 * 评论 = 往来（只增不改，是审计线索）。
 */
export class CommentRepository {
  private get db() {
    return getDatabase()
  }

  create(input: CreateCommentInput): TodoComment {
    const body = input.body.trim()
    if (!body) throw new UsageError('comment body 不能为空')
    if (!input.todoId) throw new UsageError('comment 必须挂在某条事项上')

    const row: TodoComment = {
      id: randomUUID(),
      todoId: input.todoId,
      parentId: input.parentId ?? null,
      authorType: input.authorType ?? 'human',
      authorId: input.authorId ?? null,
      body,
      kind: input.kind ?? 'comment',
      createdAt: new Date().toISOString(),
      /** 给谁（1.0.68）；不传 = 对着卡说，回应者自己看 */
      recipient: input.recipient ?? null
    }

    this.db
      .prepare(
        `INSERT INTO todo_comments
           (id, todo_id, parent_id, author_type, author_id, body, kind, created_at, recipient)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        row.id,
        row.todoId,
        row.parentId,
        row.authorType,
        row.authorId,
        row.body,
        row.kind,
        row.createdAt,
        /**
         * 给谁（1.0.68，schema 29）
         *
         * ⚠️ 这一行与上面 8 个**必须同时改** ——
         * 我今天已经在 `memos` 与 `notifications` 上各栽过一次
         * （改了对象、漏了 INSERT 参数，症状是"那列全是 null"，
         * 而 tsc 与类型检查都过，**因为 SQL 里的列名不参与类型检查**）。
         * 所以判据是：**加了列一定要有一条断言从库里读出它。**
         */
        row.recipient ?? null
      )
    return row
  }

  /**
   * 撤销删除时把评论**原样**放回（1.0.111，卡 `df06e4d7`）
   *
   * 与 `create()` 的区别就在"原样"两个字：id、作者、时间、楼中楼关系
   * 全部照抄删除时留下的那份。`create()` 做不到这件事 —— 它每次
   * `randomUUID()` + `new Date()`，放回来的评论会变成"刚刚有人说"、
   * 时间线整体错位，而回复的 `parent_id` 还会指向一个不存在的 id。
   *
   * 入参顺序即插入顺序：传进来那份来自 `listByTodo`（created_at ASC, rowid ASC），
   * 被回复者必然先于回复存在 —— `parent_id` 上有外键，顺序颠倒会直接撞约束。
   *
   * **幂等**：库里已有同 id 的评论就跳过，返回**真正插入**的条数。
   * 重复撤销（界面连点、撤销完又点一次）因此既不会因主键冲突整批失败，
   * 也不会插出两份 —— 表单里那条"加了列一定要有断言从库里读出来"的教训
   * 在这里是"回执里的条数要是真的插入数，不是传进来的长度"。
   */
  restoreAll(comments: readonly TodoComment[]): number {
    if (!comments.length) return 0
    const exists = this.db.prepare('SELECT 1 FROM todo_comments WHERE id = ?')
    const insert = this.db.prepare(
      `INSERT INTO todo_comments
         (id, todo_id, parent_id, author_type, author_id, body, kind, created_at, recipient)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    let inserted = 0
    for (const c of comments) {
      if (exists.get(c.id)) continue
      insert.run(
        c.id,
        c.todoId,
        c.parentId,
        c.authorType,
        c.authorId,
        c.body,
        c.kind,
        c.createdAt,
        // 存量行（迁移 29 之前）没记收件人 —— 保持 null，不编造
        c.recipient ?? null
      )
      inserted++
    }
    return inserted
  }

  /**
   * 列出某条事项的评论：旧→新（对话正序，回复跟在被回复者之后由前端排）。
   *
   * 用 rowid 兜底同毫秒次序 —— 同一秒内人连续发两条时，只按 created_at
   * 排会不稳定（内容顺序可能颠倒）。
   */
  listByTodo(todoId: string): TodoComment[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM todo_comments WHERE todo_id = ?
          ORDER BY created_at ASC, rowid ASC`
      )
      .all(todoId) as Record<string, unknown>[]
    return rows.map(CommentRepository.mapRow)
  }

  /** 统计某条事项的评论数（列表页显示"3 条评论"用） */
  countByTodo(todoId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM todo_comments WHERE todo_id = ?')
      .get(todoId) as { n: number }
    return row.n
  }

  /** 多条事项的评论数映射（看板一次算完，避免 N 次查询） */
  countsByTodo(todoIds: string[]): Record<string, number> {
    if (!todoIds.length) return {}
    const placeholders = todoIds.map(() => '?').join(',')
    const rows = this.db
      .prepare(
        `SELECT todo_id, COUNT(*) AS n FROM todo_comments
          WHERE todo_id IN (${placeholders}) GROUP BY todo_id`
      )
      .all(...todoIds) as { todo_id: string; n: number }[]
    const out: Record<string, number> = {}
    for (const r of rows) out[r.todo_id] = r.n
    return out
  }

  /**
   * 批量问"这条有没有收口结论"（1.0.68，修 `40294c81`）
   *
   * ## 判据是什么
   *
   * **与 G5 同一份判据**（`hasClosureSections`，1.0.110 收 `eec2e1e7`）：
   * 收口文本里要出现 `todo close` 写的四段标记里的至少一个
   * （【做了什么】【验证】【什么算通过】【取舍与遗留】）。
   * 收口文本 = **描述 ∪ 非驳回评论正文** —— 描述在这一档也算数：
   * 它同样是"这条为什么算完了"的书面依据（1.0.54 起边界是"描述=规格、往来=评论"，
   * 老卡有把结论写在描述里的）。
   *
   * ⚠️ **为什么不看"有没有评论"**：Bob实测过一次批量关 30 张卡，
   * G5 全部放行，而其中一半当初只有一行字。
   * **"有评论"不等于"交代过了"** —— 判据必须落在内容上。
   * ⚠️ **判据只此一处**：原来这里是 SQL `LIKE '%【做了什么】%'`（只认一段），
   * 而 G5 那边判"有没有评论"，两处口径不同 —— 同一件事两处判，必然漂。
   *
   * ## 为什么批量
   *
   * `todo list --fixed-in <版本>` 一次要回几十条，逐条 `listByTodo` 是 N+1。
   * 与 `countsByTodo` 同一个套路 —— 这里仍然**一次查询**：
   * SQL 只负责把该判的文本拼回来，判定本身调共用函数。
   * 起点是 `todos`（LEFT JOIN）：一条评论都没有的卡也要出现在结果里，
   * 否则调用方拿到的是"缺键"而不是"没有收口结论"。
   */
  closureByTodo(todoIds: string[]): Record<string, { hasClosure: boolean; rejected: boolean }> {
    if (!todoIds.length) return {}
    const placeholders = todoIds.map(() => '?').join(',')
    const rows = this.db
      .prepare(
        `SELECT t.id AS todo_id,
                t.description AS description,
                GROUP_CONCAT(CASE WHEN c.kind <> 'reject' THEN c.body END, char(10)) AS bodies,
                SUM(CASE WHEN c.kind = 'reject' THEN 1 ELSE 0 END) AS rejected
           FROM todos t
           LEFT JOIN todo_comments c ON c.todo_id = t.id
          WHERE t.id IN (${placeholders})
          GROUP BY t.id`
      )
      .all(...todoIds) as {
      todo_id: string
      description: string | null
      bodies: string | null
      rejected: number | null
    }[]
    const out: Record<string, { hasClosure: boolean; rejected: boolean }> = {}
    for (const r of rows) {
      out[r.todo_id] = {
        hasClosure: hasClosureSections([r.description, r.bodies]),
        rejected: (r.rejected ?? 0) > 0
      }
    }
    return out
  }

  /** 删除单条评论（连带其回复，靠外键 CASCADE） */
  remove(id: string): boolean {
    return this.db.prepare('DELETE FROM todo_comments WHERE id = ?').run(id).changes > 0
  }

  /**
   * 按**前缀**解析评论 id（与 `todo.resolveId` 同口径，CLI 全程支持短号）。
   *
   * 返回 null 而不是空对象 —— 调用方必须显式处理"查不到"。
   * 教训（`f159d799`）：凡是"查不到就静默返回空结果"的写操作，
   * 最后都会变成"退出码 0 + 回执说成功 + 一条没删"的假成功。
   */
  resolveId(input: string): TodoComment | null {
    const raw = String(input ?? '').trim()
    if (!raw) return null
    const exact = this.db
      .prepare('SELECT * FROM todo_comments WHERE id = ?')
      .get(raw) as Record<string, unknown> | undefined
    if (exact) return CommentRepository.mapRow(exact)
    // 前缀匹配：短号找回；命中多条时取最早的一条（与 todo 的解析口径一致）
    const rows = this.db
      .prepare('SELECT * FROM todo_comments WHERE id LIKE ? ORDER BY rowid ASC LIMIT 2')
      .all(raw + '%') as Record<string, unknown>[]
    return rows.length === 1 ? CommentRepository.mapRow(rows[0]) : null
  }

  /** 某条事项的全部评论（事项删除时由 FK CASCADE 自动清理，这里供显式清理用） */
  removeByTodo(todoId: string): number {
    return this.db.prepare('DELETE FROM todo_comments WHERE todo_id = ?').run(todoId).changes
  }

  /**
   * 「哪些事在等某人回应」（1.0.68，`b097ca99` 的 push）
   *
   * ## 为什么需要这个查询面
   *
   * `--to` 写进去只是**存**了；要让"叫醒"成立，
   * 得能**按人查出"我在哪些事上被点名了"** ——
   * 否则 agent 每轮还是只能全量拉回来自己认
   *（和通知那个洞同源，10-07 才补上）。
   *
   * ## 为什么不算"未读"
   *
   * 「被点名回应」与「我读过了」**不是同一件事**：
   * - 通知的已读位在 `notifications.read_by`（1.0.68 刚加）
   * - 评论的"我回过没有"在这里单独判（`NOT EXISTS` 我自己那条回复）
   *
   * ⚠️ 合并成一个"已处理"会丢信息：读过了但还没回，和压根没读，是两回事。
   *
   * @param actor 被点名的人
   * @param opts.repliedOnly 只要**还没回过**的（`--to-me` 的常用形态）
   */
  listWaitingFor(actor: string, opts?: { repliedOnly?: boolean }): TodoComment[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM todo_comments
          WHERE recipient = ?
          ORDER BY created_at DESC, rowid DESC`
      )
      .all(actor) as Record<string, unknown>[]
    const all = rows.map(CommentRepository.mapRow)
    if (!opts?.repliedOnly) return all
    // 我在这条评论下回过 ⇒ 不再算"等我回应"
    const replied = new Set(
      (
        this.db
          .prepare(
            `SELECT DISTINCT parent_id FROM todo_comments
              WHERE parent_id IS NOT NULL AND author_id = ?`
          )
          .all(actor) as { parent_id: string }[]
      ).map((r) => r.parent_id)
    )
    return all.filter((c) => !replied.has(c.id))
  }

  private static mapRow(row: Record<string, unknown>): TodoComment {
    return {
      id: row.id as string,
      todoId: row.todo_id as string,
      parentId: (row.parent_id as string) ?? null,
      authorType: (row.author_type as CommentAuthorType) ?? 'human',
      authorId: (row.author_id as string) ?? null,
      body: (row.body as string) ?? '',
      kind: (row.kind as CommentKind) ?? 'comment',
      createdAt: row.created_at as string,
      // 存量行为 NULL —— 迁移 29 没回填（**历史评论没记"给谁"，不编造**）
      recipient: (row.recipient as string) ?? null
    }
  }
}
