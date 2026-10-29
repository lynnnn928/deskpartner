import { UsageError } from '../lib/domain-errors'
import { randomUUID } from 'node:crypto'
import { getDatabase } from './index'

/** 通知五类（v3 设计拍板：五类全收） */
/**
 * 通知类型
 *
 * - `decision`（1.0.65 加）：事项进了「待确认」，等人拍板。
 *   🚨 此前**这一类一个通知都不发**，于是 proposed 只会安静地堆积 ——
 *   而"待确认"顾名思义就是在等人表态，没人通知就等于没人知道（`68b9102a`）。
 *   它与 `grant` 是两种不同的"等人"：grant 是"授权这一次动作"，
 *   decision 是"这件事该不该做"，不能互相顶替。
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
  /** 源记录 id：todo / grant / memo —— 通知是索引，详情回到源数据 */
  refId: string | null
  /** 触发者（agent:xxx / human / null=系统） */
  actor: string | null
  status: 'unread' | 'read'
  /** JSON 字符串：类型相关的附加信息（如 exec_result 的 ok 标志） */
  meta: string | null
  createdAt: string
  /** 全局已读时间（**界面铃铛**用："人看过了没"） */
  readAt: string | null
  /**
   * 给谁（1.0.68，schema 28）
   *
   * ⚠️ 与 `actor`（谁触发的）是**两个身份**。此前表里只有 actor，
   * 所以"这条是给我的"根本查不出来 —— **通知进了谁的收件箱无人知道**。
   *
   * null = 没指定收件人（广播，或人自己产生的）
   */
  recipient: string | null
  /**
   * 谁读过（1.0.68）：逗号分隔的 `actor:xxx` 集合
   *
   * ⚠️ **已读位不是布尔，是"谁读过"这个集合。**
   * 塞进单个字段就只能存"最后是谁读的"，而两人交替读会互相覆盖 ——
   * 那正是原设计（全局 `read_at`）的问题，只是不再影响 agent 侧。
   */
  readBy: string | null
}

/**
 * 分页读取的查询条件（`329c7bab`）：**筛选全部属于 SQL**，
 * `limit` / `offset` 只负责收窗口 —— 见 `NotificationRepository.listPage`。
 */
export interface NotificationPageQuery {
  /** 只列"待给我"的：`recipient IS NULL OR recipient = ?`（`--to-me` / `--ack-mine`） */
  recipientFor?: string
  /** 类型过滤（`--type`） */
  type?: string
  /**
   * 未读口径 —— 两个名字对应两种不同的"未读"，别混：
   * - `global` = 全局未读（`status`，**界面铃铛**那个口径）：不带 `--to-me` 时的 `--unread`
   * - `mine` = 我还没看过（`read_by` 里没有我）：带 `--to-me` 时的 `--unread`，以及 `--ack-mine`
   */
  unread?: 'global' | 'mine'
  /** `unread: 'mine'` 时"我"是谁 */
  reader?: string
  /** 从第几条开始（默认 0） */
  offset?: number
  /** 缺省 = 不收窄（能取多少取多少） */
  limit?: number
}

/**
 * 收件箱（GUI）的查询条件 —— 与 CLI 的 `NotificationPageQuery` **同一条判据**：
 * **筛选属于 WHERE，窗口属于 LIMIT**（卡 `cba46119`）。
 *
 * 三条筛选各答一个问题，互不代劳：
 * - `projectId`：范围（`undefined` = 不分项目；`null` = 只系统；字符串 = 该项目）
 * - `type`：只看哪一类（对应界面上的分类 chip）
 * - `unreadOnly`：只看未读
 */
export interface InboxQuery {
  projectId?: string | null
  type?: NotificationType | null
  /**
   * 只看**这个人还没看过**的（卡 `c13dbb16`）—— 给的是**主体**，不是给界面的布尔。
   *
   * ⚠️ 与 `unreadOnly` 的区别就一句话：
   * - `unreadOnly` 问全局那一份 `status`（**谁先读都算读过** —— 界面铃铛的老口径）；
   * - `unreadFor` 问"**这个人**读过没有"（`read_by` 这个集合里有没有他）。
   *
   * 两个都给时**以本字段为准**。主用户与 agent 是并列的主体，
   * PRD 的实体表写着「通知 —— 未读 / 已读（**按主体分别记**）」：
   * 谁读过只该清掉谁的那一份，A 翻过去不能把 B 的未读也吃掉。
   */
  unreadFor?: string
  /** 全局未读（`status`，CLI 不带 `--to-me` 的口径）；与 `unreadFor` 二选一 */
  unreadOnly?: boolean
}

/** 收件箱查询 + 窗口（`limit` 缺省 = 不收窄，与 `NotificationPageQuery` 同款） */
export interface InboxPageQuery extends InboxQuery {
  limit?: number
  offset?: number
}

/** 收件箱一行：通知本体 + 读侧反查出来的归属 */
export type InboxRow = AppNotification & { projectId: string | null; todoId: string | null }

/** 一页收件箱：`rows` 被窗口截过，`matched` 是命中总数（不含窗口） */
export interface InboxPage {
  rows: InboxRow[]
  matched: number
}

/**
 * 分类计数（`countsByTypeWithProject`）：`total` 与 `unread` 都按**整个范围**数，不含窗口。
 *
 * 用 `Partial` 而不是给每一类补 0：**没有这一类**与"这一类有 0 条"在界面上都该不显示 chip，
 * 补齐 0 只会让人以为存在一个空分类。
 */
export type InboxTypeCounts = Partial<Record<NotificationType, { total: number; unread: number }>>

/**
 * 收件箱一页连同三个计数（卡 `cba46119`）—— 界面拿到的那一份回执就是它。
 *
 * 与渲染侧的 `InboxPage` 字段一一对应；两处都存在，是因为主进程与渲染进程
 * 各有各的类型空间（`AppNotification` 也是这么分着的）。
 */
export interface InboxPageResult extends InboxPage {
  /** 这一页回了几条 */
  returned: number
  /** 这一页之后还有没有 */
  truncated: boolean
  /** 下一页的起点；读到底了是 null */
  nextOffset: number | null
  /** 整个范围里每一类各多少条（分类 chip 的数字） */
  byType: InboxTypeCounts
  /** 当前范围里**当前这一类**的未读（页头「未读 N」） */
  unread: number
}

export interface CreateNotificationInput {
  type: NotificationType
  title: string
  summary?: string
  refId?: string | null
  actor?: string | null
  meta?: Record<string, unknown> | null
  /**
   * 给谁（1.0.68，schema 28）
   *
   * ⚠️ 与 `actor`（谁触发的）是**两个身份**。
   * 此前只有 actor，所以"这条是给我的"查不出来 —— 通知进了谁的收件箱无人知道。
   */
  recipient?: string | null
}

/**
 * 通知仓储（1.0.48，schema v21）
 *
 * 写时落表：五类事件的写入口在事情发生时顺手 create 一行，
 * 已读口径就是这张表自己的 status —— 不做读时五表聚合
 * （聚合的未读数会跟着各表各自的状态漂，对不齐角标）。
 *
 * 通知是**索引不是操作台**：行里没有动作，动作在源数据那边
 * （备忘的「转为待办/删除」走 memo 通道，审批的「允许/拒绝」走 agent 通道）。
 */
export class NotificationRepository {
  private get db() {
    return getDatabase()
  }

  create(input: CreateNotificationInput): AppNotification {
    const title = input.title.trim()
    if (!title) throw new UsageError('notification title 不能为空')

    const row: AppNotification = {
      id: randomUUID(),
      type: input.type,
      title,
      summary: input.summary ?? '',
      refId: input.refId ?? null,
      actor: input.actor ?? null,
      status: 'unread',
      meta: input.meta ? JSON.stringify(input.meta) : null,
      createdAt: new Date().toISOString(),
      readAt: null,
      /**
       * 给谁（1.0.68）。不传 = 广播/人自己产生的。
       * ⚠️ `CreateNotificationInput` 里刻意**没有**这个字段的默认值 ——
       * 由调用方显式给，避免"忘了传就当成给所有人"这类含糊。
       */
      recipient: input.recipient ?? null,
      /** 新建时没人读过 ⇒ 空串（null 在存量里表示"历史行不知道是谁读的"） */
      readBy: ''
    }

      this.db
        .prepare(
          `INSERT INTO notifications
             (id, type, title, summary, ref_id, actor, status, meta, created_at, read_at, recipient, read_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          row.id,
          row.type,
          row.title,
          row.summary,
          row.refId,
          row.actor,
          row.status,
          row.meta,
          row.createdAt,
          row.readAt,
          /**
           * ⚠️ `recipient` 与 `read_by` 是 1.0.68 加的两列。
           * 我第一版改了对象但**漏了 INSERT 的参数列表** ——
           * 症状很安静：`recipient` 全是 null，**测试要的"按收件人筛"全部失效**，
           * 而 `tsc` 与类型检查都过（SQL 里的列名不参与类型检查）。
           * **判据：加了列之后，一定要有一条断言真的从库里读出那列。**
           */
          row.recipient,
          row.readBy
        )
      return row
    }

  /**
   * 已退役的通知类型：不再进收件箱、不再计未读（1.0.55，主用户驳回 2ccc6fc6）
   *
   * 她的原话：「审批通知还在通知里，应该迁移到审批中」。
   *
   * 为什么确实该退役：1.0.52 给审批做了一级入口（待表态队列 + 审批日志），
   * 审批申请在那里能看到、顶部横幅还会当场提醒 —— 收件箱再存一份就是
   * **同一件事两个目的地**（违反"一个目的地一个入口"）。
   * 更糟的是：审批面里点了「允许」之后，收件箱那条仍是 unread，
   * 角标**永远消不掉**（没有任何代码路径会去标它已读）。
   *
   * 保留 `grant` 在类型联合里只为兼容库里的历史行；列表与计数一律排除，
   * 历史行由启动时的 `pruneRetired()` 清掉。
   */
  static readonly RETIRED_TYPES = ['grant'] as const

  /**
   * 「已失效」的 SQL 片段（1.0.67 修 `182271c2`）
   *
   * ## 为什么需要
   *
   * 实测（10-06，只读查库）：**未读 review 通知 148 条**，其中
   * - 「验收未通过，已退回」类 20 条，**15 条指向的卡已经是 `done`**
   * - 「交付待验收」类 126 条，**85 条的卡也已经是 `done`**
   *
   * 也就是说这些通知在**说一件已经不成立的事** —— 它们指向的卡早就收口了，
   * 而人打开收件箱看到的是「验收未通过」。
   *
   * ⚠️ **它们不报错、不消失，就躺在那儿冒充待办。**
   * 判据：**沉默的失败态是最贵的失败态。**
   *
   * ## 判据是什么
   *
   * 通知的 `ref_id` 指向那条事项。**若那张卡已不在「触发这条通知时的状态」，
   * 这条通知就已失效** —— 不占未读、不在列表里冒头。
   *
   * ⚠️ 判据写成 `NOT EXISTS(卡在有效态)` 而不是 `EXISTS(卡不在有效态)` ——
   * 后者对「卡已被删」返回 false，那条通知就留下来了。
   * **而通知指向一张不存在的卡，比指向一张已完成的卡更该扫掉**：
   * 前者是"指向空气"，后者顶多是"过期"。我第一版写反了，被测试当场抓住。
   *
   * ## 为什么不存触发时状态、而是读当前状态
   *
   * 实测 148 条通知的 `meta` **全是 NULL** —— 没存触发时状态。
   * 所以只能读当前状态比对。这也让判据**能同时接住存量与增量**：
   * 存量那些不需要回填就能被接住（实测能 JOIN 上 139/148）。
   *
   * ## 为什么只对 `review` 类型生效
   *
   * `review` 的语义是「这条事项进/出待验收」，与卡状态强绑定；
   * 其他类型（memo / decision / reminder）说的是"发生过的事"，
   * **事情发生过就不过期**，不该被这条判据扫掉。
   */
  private static readonly STALE_REVIEW = `
    type = 'review' AND ref_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM todos t
      WHERE t.id = notifications.ref_id
        AND t.status IN ('awaiting_review', 'in_progress')
    )`

  /**
   * 有效通知的 SQL 片段（列表与计数共用，**避免两处口径走偏**）
   *
   * ⚠️ 这条与 `NOT_RETIRED` 必须成对使用 —— 少一处，
   * 就会出现"列表里没有但未读数还在"这种最烦人的不一致。
   */
  private static readonly NOT_STALE = `NOT (${NotificationRepository.STALE_REVIEW})`

  /** 排除退役类型的 SQL 片段（列表与计数共用，避免两处口径走偏） */
  private static readonly NOT_RETIRED = `type NOT IN (${NotificationRepository.RETIRED_TYPES.map(
    (t) => `'${t}'`
  ).join(', ')})`

  /**
   * 列表与计数的**完整**有效条件。
   *
   * 抽成两个私有常量拼装，而不是各处直接写 `NOT_RETIRED` ——
   * 因为要加"已失效"这一条时，散着写就一定会漏掉某处（我今天写第一版时就漏了计数）。
   */
  private static readonly LIVE = `${NotificationRepository.NOT_RETIRED} AND ${NotificationRepository.NOT_STALE}`

  /** 收件箱列表：新→旧，rowid 兜底同毫秒次序 */
  list(limit = 200): AppNotification[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM notifications WHERE ${NotificationRepository.LIVE}
          ORDER BY created_at DESC, rowid DESC LIMIT ?`
      )
      .all(limit) as Record<string, unknown>[]
    return rows.map(NotificationRepository.mapRow)
  }

  /**
   * 读一页通知：**筛选先于窗口**，并把命中总数一并带回来（1.0.107，修 `329c7bab`）。
   *
   * ## 为什么必须新开一条读法，而不是接着用 `list()`
   *
   * `list(limit)` 是"先去最新 N 条、再由调用方筛"。用下来会出三种病，
   * 而它们的共同点是**回执里看不出来**：
   *
   * 1. 窗口写死（CLI 里是 `list(200)`）：调用方要 500 条也只拿到 200 条；
   * 2. 筛选在窗口之内：`--type memo` 实际是"最新 200 条里的 memo" ——
   *    实测 487 条有效通知、308 条 memo 时它回 **21** 条，`total` 也是 21，
   *    看着像"一共就 21 条"；
   * 3. 计数与列表不同源：`unreadCount()` 走全表、列表走窗口，
   *    同一条回执里 `unread: 467` 而只列 180 条。
   *
   * 判据：**筛选属于 WHERE，窗口属于 LIMIT** —— 窗口只能在筛选**之后**收窄。
   * 这里把两者都下推，并把"命中总数"（不含 limit/offset）一起返回，
   * 调用方据此就知道还有没有更多。
   *
   * ⚠️ 行查询与计数查询共用同一份 WHERE（`pageWhere`）—— 两处各写一遍，
   * 迟早会出现"列表里有、计数里没有"（或反过来），那正是上面第 3 条的根因。
   */
  listPage(query: NotificationPageQuery = {}): { rows: AppNotification[]; matched: number } {
    const { where, params } = NotificationRepository.pageWhere(query)
    // 计数用同一条 WHERE，但不带 limit/offset —— 它答的是"命中多少"，不是"回了多少"
    const matched = (
      this.db.prepare(`SELECT COUNT(*) AS n FROM notifications WHERE ${where}`).get(...params) as {
        n: number
      }
    ).n
    const offset = Math.max(0, Math.floor(query.offset ?? 0))
    let sql = `SELECT * FROM notifications WHERE ${where} ORDER BY created_at DESC, rowid DESC`
    const pageParams = [...params]
    if (query.limit !== undefined) {
      sql += ' LIMIT ? OFFSET ?'
      pageParams.push(query.limit, offset)
    } else if (offset > 0) {
      // 不收窄（limit 缺省）但要跨过前 offset 条：SQLite 里 `LIMIT -1` 就是"不限"
      sql += ' LIMIT -1 OFFSET ?'
      pageParams.push(offset)
    }
    const rows = (this.db.prepare(sql).all(...pageParams) as Record<string, unknown>[]).map(
      NotificationRepository.mapRow
    )
    return { rows, matched }
  }

  /**
   * 只数命中，不取行 —— 给"命中集合里未读的有几条"这类同源读数用。
   *
   * 与 `listPage().matched` **同一份 WHERE**：调用方拿它配一个未读计数，
   * 才不会出现"列表 180 条、未读 467 条"那种自相矛盾的回执。
   */
  countPage(query: NotificationPageQuery = {}): number {
    const { where, params } = NotificationRepository.pageWhere(query)
    return (
      this.db.prepare(`SELECT COUNT(*) AS n FROM notifications WHERE ${where}`).get(...params) as {
        n: number
      }
    ).n
  }

  /** 分页查询的 WHERE 与参数 —— 行与计数**唯一一处**拼装（见 `listPage` 的注释） */
  private static pageWhere(query: NotificationPageQuery): { where: string; params: unknown[] } {
    const where: string[] = [NotificationRepository.LIVE]
    const params: unknown[] = []
    if (query.recipientFor !== undefined) {
      // `--to-me` / `--ack-mine`：待给我的（没指定收件人的广播也算）
      where.push('(recipient IS NULL OR recipient = ?)')
      params.push(query.recipientFor)
    }
    if (query.type) {
      where.push('type = ?')
      params.push(query.type)
    }
    if (query.unread === 'global') {
      where.push(`status = 'unread'`)
    } else if (query.unread === 'mine') {
      /**
       * "我还没看过" = `read_by` 这个逗号集合里没有我。
       *
       * 用 `instr(',' || read_by || ',', ',' || ? || ',')` 而不是 `LIKE '%me%'`：
       * 后者会把 `agent:me2` 当成 `agent:me` 命中。也不做 trim ——
       * 必须与原来 JS 侧 `(readBy ?? '').split(',').filter(Boolean).includes(me)`
       * **逐字同义**，否则这次搬家会顺手改掉"谁没读过"的判定。
       */
      where.push(`(read_by IS NULL OR instr(',' || read_by || ',', ',' || ? || ',') = 0)`)
      params.push(query.reader ?? '')
    }
    return { where: where.join(' AND '), params }
  }

  /**
   * 收件箱的 FROM / JOIN —— **行、计数、分类计数、"全部已读"范围唯一一处拼装**（卡 `cba46119`）。
   *
   * 归属靠**读侧反查**（通知表没有 `project_id`，也不加，不动 schema）：
   * - reminder / review / decision：`ref_id` 就是事项 id → 事项的 `project_id`
   * - memo：`ref_id` 是备忘 id → `memos.linked_todo_id` → 事项的 `project_id`
   * - 其余（exec_result 回执）反查不到，project_id / todo_id 为 null
   *   （`exec_result` 的归属另存在 `meta.projectId` 里，由 `inboxWhere` 单独接住）
   *
   * 与 `list()` **同一个有效条件**（LIVE）：外层 JOIN 之前先在子查询里筛，
   * 这样列表与未读数口径不会走偏，也避免 `type` 等列名与 todos 表撞名。
   */
  private static readonly INBOX_FROM = `
    FROM (SELECT *, rowid AS rid FROM notifications WHERE ${NotificationRepository.LIVE}) n
    LEFT JOIN todos t
           ON n.type IN ('reminder', 'review', 'decision') AND t.id = n.ref_id
    LEFT JOIN memos m
           ON n.type = 'memo' AND m.id = n.ref_id
    LEFT JOIN todos mt
           ON mt.id = m.linked_todo_id`

  /**
   * 收件箱的 WHERE —— 行查询、计数、分类计数、"全部已读"的范围**共用这一份**。
   *
   * ⚠️ 与 `pageWhere` 同一个道理：两处各写一遍，迟早出现"列表里有、计数里没有"，
   * 而界面上就是"角标说 633 条、列表只列得出 500 条"那种自相矛盾。
   */
  private static inboxWhere(query: InboxQuery): { sql: string; params: unknown[] } {
    const where: string[] = []
    const params: unknown[] = []
    if (query.projectId !== undefined) {
      if (query.projectId === null) {
        // 系统页：只看没有项目归属的
        where.push(`COALESCE(t.project_id, mt.project_id) IS NULL`)
        where.push(
          `NOT (n.type = 'exec_result' AND json_extract(CASE WHEN json_valid(n.meta) THEN n.meta ELSE '{}' END, '$.projectId') IS NOT NULL)`
        )
      } else {
        where.push(
          `(COALESCE(t.project_id, mt.project_id) = ? OR (n.type = 'exec_result' AND json_extract(CASE WHEN json_valid(n.meta) THEN n.meta ELSE '{}' END, '$.projectId') = ?))`
        )
        params.push(query.projectId, query.projectId)
      }
    }
    if (query.type) {
      where.push('n.type = ?')
      params.push(query.type)
    }
    if (query.unreadFor !== undefined) {
      /**
       * "这个人还没看过" = `read_by` 这个逗号集合里没有他。
       *
       * 用 `instr(',' || read_by || ',', ',' || ? || ',')` 而不是 `LIKE '%me%'`：
       * 后者会把 `agent:me2` 当成 `agent:me` 命中。也不做 trim ——
       * 必须与 `pageWhere`（CLI 那一路）**逐字同义**：同一个"谁没读过"各写一套判据，
       * 迟早出现"列表里算未读、角标里算已读"。
       */
      where.push(`(n.read_by IS NULL OR instr(',' || n.read_by || ',', ',' || ? || ',') = 0)`)
      params.push(query.unreadFor)
    } else if (query.unreadOnly) {
      where.push(`n.status = 'unread'`)
    }
    return { sql: where.length > 0 ? `WHERE ${where.join(' AND ')}` : '', params }
  }

  /**
   * 读一页收件箱：**筛选先于窗口**，并把命中总数（不含 limit/offset）一起带回来。
   *
   * 与 CLI 的 `listPage` 是同一套读法（`329c7bab` / `cba46119`）：
   * "先取最新 N 条、再由调用方过滤"在这里不成立 —— 筛选进 WHERE，窗口只收条数。
   */
  listWithProjectPage(query: InboxPageQuery = {}): InboxPage {
    const { sql: whereSql, params } = NotificationRepository.inboxWhere(query)
    const matched = this.countWithProject(query)
    const offset = Math.max(0, Math.floor(query.offset ?? 0))
    let sql = `SELECT n.*, m.author AS memo_author, COALESCE(t.id, mt.id) AS todo_id, COALESCE(t.project_id, mt.project_id) AS project_id ${NotificationRepository.INBOX_FROM} ${whereSql} ORDER BY n.created_at DESC, n.rid DESC`
    const pageParams = [...params]
    if (query.limit !== undefined) {
      sql += ' LIMIT ? OFFSET ?'
      pageParams.push(query.limit, offset)
    } else if (offset > 0) {
      // 不收窄但要跨过前 offset 条：SQLite 里 `LIMIT -1` 就是"不限"
      sql += ' LIMIT -1 OFFSET ?'
      pageParams.push(offset)
    }
    const rows = (this.db.prepare(sql).all(...pageParams) as Record<string, unknown>[]).map((row) =>
      NotificationRepository.mapInboxRow(row)
    )
    return { rows, matched }
  }

  /** 只数命中，不取行 —— 与 `listWithProjectPage().matched` **同一份 WHERE** */
  countWithProject(query: InboxQuery = {}): number {
    const { sql: whereSql, params } = NotificationRepository.inboxWhere(query)
    return (
      this.db
        .prepare(`SELECT COUNT(*) AS n ${NotificationRepository.INBOX_FROM} ${whereSql}`)
        .get(...params) as { n: number }
    ).n
  }

  /**
   * 分类计数：**整个范围**里每一类有多少条、其中多少条未读。
   *
   * ⚠️ 调用方**不要**传 `type` —— 它的用途正是"每一类各多少"，带上 type 就只在答一类了。
   */
  countsByTypeWithProject(query: InboxQuery = {}): InboxTypeCounts {
    const { sql: whereSql, params } = NotificationRepository.inboxWhere(query)
    const rows = this.db
      .prepare(
        `SELECT n.type AS type, COUNT(*) AS total,
                SUM(CASE WHEN n.status = 'unread' THEN 1 ELSE 0 END) AS unread
           ${NotificationRepository.INBOX_FROM} ${whereSql}
          GROUP BY n.type`
      )
      .all(...params) as Array<{ type: NotificationType; total: number; unread: number }>
    const counts: InboxTypeCounts = {}
    for (const row of rows) counts[row.type] = { total: row.total, unread: row.unread }
    return counts
  }

  /**
   * 收件箱**一页连同它的三个计数** —— 这是界面真正拿到的那一份回执（卡 `cba46119`）。
   *
   * 之所以把"拼回执"这一步放进仓储、而不是留在 IPC handler 里：
   * 这一份数据结构就是界面依赖的契约，**能被测试就必须被测**。
   * handler 只做参数搬运，形状与语义都在这里，一条用例就能钉住。
   *
   * 三个数的口径（都不含窗口，都有同一份 WHERE 兜着）：
   * - `rows` / `matched` / `truncated` / `nextOffset`：列表与"还有没有更多"
   * - `byType`：**整个范围**里每一类各多少条（分类 chip）
   * - `unread`：当前范围 ∩ **当前这一类的**未读（页头「未读 N」）
   */
  inboxPage(query: InboxPageQuery = {}): InboxPageResult {
    /**
     * ⚠️ `unreadFor` 只喂给下面"未读那几个数"，**不能**进列表那一趟：
     * 它是"只看未读"的判据，混进去列表就只剩未读行 ——
     * 已经读过的那批（"我已知晓"）会整批从界面上消失（卡 `c13dbb16`）。
     */
    const { unreadFor, ...listQuery } = query
    const { rows, matched } = this.listWithProjectPage(listQuery)
    const offset = Math.max(0, Math.floor(query.offset ?? 0))
    const returned = rows.length
    const truncated = offset + returned < matched
    return {
      rows,
      matched,
      returned,
      truncated,
      nextOffset: truncated ? offset + returned : null,
      /**
       * ⚠️ 这里**刻意不传 `type`**：chip 要答的是"每一类各有多少条"，
       * 跟着当前分类走的话，切到某一类之后其它类的数字就全没了。
       */
      byType: this.countsByTypeWithProject({ projectId: query.projectId }),
      unread: this.countWithProject({
        projectId: query.projectId,
        ...(query.type ? { type: query.type } : {}),
        // 主体口径跟着走：不给 `unreadFor` 才是旧的全局 `status`（卡 `c13dbb16`）
        ...(unreadFor !== undefined ? { unreadFor } : { unreadOnly: true })
      })
    }
  }

  /**
   * 带归属项目的列表（GUI 信息架构重设计，21ac3b3e）：新→旧。
   *
   * 保留这个形状是因为旧调用点与既有测试都按"给我一个数组"读它；
   * 新读法一律走 `listWithProjectPage` / `inboxPage`（它们多给一个命中总数）。
   */
  listWithProject(limit = 500, projectId?: string | null): InboxRow[] {
    return this.listWithProjectPage({ projectId, limit }).rows
  }

  /**
   * 把某人加进 `read_by` 这个集合的 SQL 片段（卡 `c13dbb16`）
   *
   * 三个分支都要有，少一个都会出错：
   * - 空 / 未知 → 就他一个读者；
   * - 已经有他 → 原样返回（**幂等**：重复"全部已读"不该把集合越写越长）；
   * - 别人读过 → **追加**，不覆盖 —— 覆盖就退回"只记得最后是谁读的"那个老毛病。
   */
  private static readonly APPEND_READER = `read_by = CASE
      WHEN read_by IS NULL OR read_by = '' THEN ?
      WHEN instr(',' || read_by || ',', ',' || ? || ',') > 0 THEN read_by
      ELSE read_by || ',' || ? END`

  /**
   * 把某个范围里**未读的**标掉，返回实际改动条数。
   *
   * ⚠️ 范围与列表**同一份 WHERE**：此前走的是 `listWithProject(100000)` ——
   * 一个自己编的数字上限，于是界面显示 500 条却能清掉 633 条。
   * 现在是一条 `UPDATE ... WHERE id IN (同一条 FROM/WHERE)`：
   * **清掉的就是它宣称的那个范围**，不多不少。
   *
   * ⚠️ 给了 `unreadFor`（主用户或某个 agent）时有两件事同时变（卡 `c13dbb16`）：
   * ① "未读"按**那个人的** `read_by` 判（`unreadFor` 在 `inboxWhere` 里优先于
   *    `unreadOnly`）；② 顺手把他的名字写进 `read_by`。
   * 少了 ②，点完"全部已读"角标归零、下一次刷新又全回来；
   * 少了 ①，就还是"A 一点全部已读，B 的未读也没了"。
   *
   * `status`/`read_at` 一并照写：CLI 的 `unread` 字段与备忘 ack 那条链路还按它走
   * （见 `markReadFor` 的说明）。
   */
  private markScopeRead(query: InboxQuery): number {
    const { sql: whereSql, params } = NotificationRepository.inboxWhere({
      ...query,
      // `unreadFor` 在 `inboxWhere` 里优先 —— 这里照样传 `unreadOnly`，只为不带主体时兜底
      unreadOnly: true
    })
    const reader = query.unreadFor
    return this.db
      .prepare(
        `UPDATE notifications SET status = 'read', read_at = ?${
          reader ? `, ${NotificationRepository.APPEND_READER}` : ''
        }
          WHERE id IN (SELECT n.id ${NotificationRepository.INBOX_FROM} ${whereSql})`
      )
      .run(new Date().toISOString(), ...(reader ? [reader, reader, reader] : []), ...params).changes
  }

  /** 行的映射：通知本体 + 归属（`exec_result` 的 `meta.projectId` 兜底也在这一处） */
  private static mapInboxRow(row: Record<string, unknown>): InboxRow {
    const notification = NotificationRepository.mapRow(row)
    if (notification.type === 'memo' && row.memo_author === 'unknown:pre-1.0.68') {
      notification.actor = 'unknown:pre-1.0.68'
    }
    let projectId = (row.project_id as string | null) ?? null
    // 执行回执的 ref_id 是 grant id，不是 todo id；写入时把项目放进 meta，
    // 读取侧必须消费它，否则项目业务通知会被误分到全局系统收件箱。
    if (!projectId && notification.type === 'exec_result' && notification.meta) {
      try {
        const meta = JSON.parse(notification.meta) as { projectId?: unknown }
        if (typeof meta.projectId === 'string' && meta.projectId) projectId = meta.projectId
      } catch {
        // 历史坏 meta 不应阻塞其它通知显示
      }
    }
    return {
      ...notification,
      projectId,
      todoId: (row.todo_id as string | null) ?? null
    }
  }

  /**
   * 「本项目全部已读」：只标这个项目名下的通知，不碰别的项目与系统级。
   *
   * 项目归属与列表**同一份 WHERE**（`inboxWhere`），并可再按 `type` 收窄 ——
   * 界面上的「本类已读」走的就是这条（卡 `cba46119`：此前项目页只在可见的那几条上逐条标，
   * 与系统页"整片清"的语义不一致）。
   */
  /**
   * 「本项目全部已读」：只标这个项目名下的通知，不碰别的项目与系统级。
   *
   * 项目归属与列表**同一份 WHERE**（`inboxWhere`），并可再按 `type` 收窄 ——
   * 界面上的「本类已读」走的就是这条（卡 `cba46119`：此前项目页只在可见的那几条上逐条标，
   * 与系统页"整片清"的语义不一致）。
   *
   * `reader`（卡 `c13dbb16`）= 这是**谁**的"已读"：清了谁的那一份、就把谁写进 `read_by`，
   * 不传才是旧的全局口径。
   */
  markProjectRead(
    projectId: string,
    type: NotificationType | null = null,
    reader?: string
  ): number {
    return this.markScopeRead({
      projectId,
      ...(type ? { type } : {}),
      ...(reader !== undefined ? { unreadFor: reader } : {})
    })
  }

  unreadCount(): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM notifications
          WHERE status = 'unread' AND ${NotificationRepository.LIVE}`
      )
      .get() as { n: number }
    return row.n
  }

  /**
   * 系统通知未读数（侧栏「通知」角标那个数）：排除可归属项目的事项通知。
   *
   * ⚠️ 与列表**同一份 WHERE、且不含窗口**（卡 `cba46119`）——
   * 此前走 `listWithProject(100000)`，于是角标与页头是两个数
   * （实测：角标 633 而页头 484）。
   *
   * ⚠️ `reader`（卡 `c13dbb16`）：角标是**给主用户看的**，所以界面必须带 `'human'` ——
   * 数"**他**还没看过的"。不带才是旧的全局口径（`status`），留着只为不破坏旧调用点。
   */
  unreadSystemCount(reader?: string): number {
    return this.countWithProject({
      projectId: null,
      unreadOnly: true,
      ...(reader !== undefined ? { unreadFor: reader } : {})
    })
  }

  /**
   * 全局收件箱全部已读：只处理没有项目归属的系统通知；可只清某一类。
   *
   * 清掉的**就是它宣称的范围**（与列表同一份 WHERE，没有窗口）。
   * `reader`（卡 `c13dbb16`）同上：清谁的那一份，就把谁写进 `read_by`。
   */
  markSystemAllRead(type: NotificationType | null = null, reader?: string): number {
    return this.markScopeRead({
      projectId: null,
      ...(type ? { type } : {}),
      ...(reader !== undefined ? { unreadFor: reader } : {})
    })
  }

  /**
   * 清掉退役类型的历史行（启动时调用一次）。
   *
   * 不做这一步的话，1.0.55 之前产生的 grant 行会一直躺在库里：
   * 虽然已从列表与计数里排除，但 `notification:list` 的 limit 是 200，
   * 这些行会白占名额、把真正该看见的通知挤出首页。
   */
  pruneRetired(): number {
    return this.db
      .prepare(`DELETE FROM notifications WHERE type IN (${NotificationRepository.RETIRED_TYPES.map((t) => `'${t}'`).join(', ')})`)
      .run().changes
  }

  /** 标记已读（幂等） */
  markRead(id: string): boolean {
    return (
      this.db
        .prepare(
          `UPDATE notifications SET status = 'read', read_at = ? WHERE id = ? AND status = 'unread'`
        )
        .run(new Date().toISOString(), id).changes > 0
    )
  }

  /**
   * 全部标为已读；给 `type` 时只标这一类（1.0.49 通知分类筛选）
   *
   * 为什么需要按类：筛选后按钮写着"全部已读"，人手边只有这一类的内容，
   * 一点却把别类也消掉了 —— 动作范围超出了他看得见的范围。
   * 传 type 让"清掉的"与"看见的"对齐。
   */
  markAllRead(type?: NotificationType | null): number {
    const now = new Date().toISOString()
    if (type) {
      return this.db
        .prepare(
          `UPDATE notifications SET status = 'read', read_at = ?
            WHERE status = 'unread' AND type = ?`
        )
        .run(now, type).changes
    }
    return this.db
      .prepare(
        `UPDATE notifications SET status = 'read', read_at = ? WHERE status = 'unread'`
      )
      .run(now).changes
  }

  /**
   * 按源记录同步已读：备忘在别处被 ack / 待办被点开时，
   * 对应的通知行不该继续亮着未读 —— 角标数的是"还没人知道的事"。
   *
   * `reader` **必填**（卡 `15557194`，1.0.132）：按 `c13dbb16` 的口径，
   * 「全局已读」必须同时记下是谁读的。此前这个参数不存在，调用方（`memo ack`）
   * 每跑一次就写出一行 `status='read'` 而 `read_by` 为空的记录 ——
   * 主用户那边按自己的 `read_by` 算仍是未读，等于"清了又亮"。
   * 追加走 `APPEND_READER`：幂等，且不会覆盖别人那份。
   */
  markReadByRef(refId: string, reader: string): number {
    const who = reader.trim()
    if (!who) return 0
    return this.db
      .prepare(
        `UPDATE notifications
            SET status = 'read', read_at = ?, ${NotificationRepository.APPEND_READER}
          WHERE ref_id = ? AND status = 'unread'`
      )
      .run(new Date().toISOString(), who, who, who, refId).changes
  }

  /* ── agent 侧：按收件人定向 + 按人记已读（1.0.68，schema 28）── */

  /**
   * 只看待给某人（或"没指定给谁"）的通知
   *
   * ⚠️ **与 `--unread` 正交**："给我的" ≠ "我还没看"。
   * 而此前没有这一层 —— agent 只能每轮全量拉回来自己认哪条是给自己的。
   *
   * @param actor 谁（传 `null` 看"没指定收件人"的那些）
   */
  listFor(actor: string | null, opts?: { unreadBy?: string }): AppNotification[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM notifications
          WHERE ${NotificationRepository.LIVE}
            AND (recipient IS NULL OR recipient = ?)
          ORDER BY created_at DESC, rowid DESC`
      )
      .all(actor) as Record<string, unknown>[]
    const all = rows.map(NotificationRepository.mapRow)
    if (!opts?.unreadBy) return all
    const me = opts.unreadBy
    return all.filter((n) => !(n.readBy ?? '').split(',').filter(Boolean).includes(me))
  }

  /**
   * 标记"某个人读过"，**不动全局 status**
   *
   * ## 为什么要与 `markRead` 分开
   *
   * `markRead` 改的是全局 `status`/`read_at` ——
   * 那是**界面铃铛**用的（"人看过了没"）。
   * 而 agent 之间需要的是"**我**看过了没"：
   * ① Bob读一条，不该让 alice 的未读数少一个
   * ② 反之亦然
   *
   * ⚠️ 共用 `read_at` 就会互相覆盖 —— 两个人交替读，未读数永远只对最后一个读者成立。
   */
  markReadBy(id: string, actor: string): boolean {
    const row = this.db
      .prepare('SELECT read_by FROM notifications WHERE id = ?')
      .get(id) as { read_by: string | null } | undefined
    if (!row) return false
    const set = new Set((row.read_by ?? '').split(',').filter(Boolean))
    if (set.has(actor)) return false // 幂等
    set.add(actor)
    return this.db
      .prepare('UPDATE notifications SET read_by = ? WHERE id = ?')
      .run([...set].join(','), id).changes > 0
  }

  /**
   * 让某人读过一条：**同时**记进 `read_by` 与全局 `status`（卡 `c13dbb16`）
   *
   * ## 为什么不直接用 `markReadBy`
   *
   * `markReadBy` 只动 `read_by`（agent 侧要的"我看过没有"，且必须不动界面那份）。
   * 而主用户在 GUI 点开一条，是**两个口径同时成立**：
   * - `read_by`：通知的未读/已读**按主体分别记**，主用户是其中一个主体 ——
   *   界面的"未读绿点 / 加粗"从此按它算，别的写方翻全局位不再吃掉他的未读；
   * - `status`/`read_at`：CLI `notification list` 的 `unread` 字段与
   *   备忘 ack 的"索引不该继续亮着"仍按全局位走 —— 不写它，那些数就再也不动了。
   *
   * 判据：**这次换的是"界面按谁的口径算"，不是把旧字段废掉**，两个都写、各取所需。
   * `markRead` 自带幂等（`WHERE status = 'unread'`），重复点不会刷新 `read_at`。
   */
  markReadFor(id: string, actor: string): boolean {
    const global = this.markRead(id)
    const mine = this.markReadBy(id, actor)
    return global || mine
  }

  /**
   * 某人视角的未读数（`read_by` 里没有他）
   *
   * ⚠️ 与 `unreadCount()`（全局 status）**不是一回事**：
   * 那个答"人还有几条没看"，这个答"某个 agent 还有几条没看"。
   */
  unreadCountFor(actor: string | null, reader: string): number {
    const rows = this.listFor(actor)
    return rows.filter((n) => !(n.readBy ?? '').split(',').filter(Boolean).includes(reader)).length
  }

  /** 按源记录删除：源记录没了（如备忘被删），索引不该留着指向空气 */
  removeByRef(refId: string): number {
    return this.db.prepare('DELETE FROM notifications WHERE ref_id = ?').run(refId).changes
  }

  remove(id: string): boolean {
    return this.db.prepare('DELETE FROM notifications WHERE id = ?').run(id).changes > 0
  }

  private static mapRow(row: Record<string, unknown>): AppNotification {
    return {
      id: row.id as string,
      type: row.type as NotificationType,
      title: row.title as string,
      summary: (row.summary as string) ?? '',
      refId: (row.ref_id as string) ?? null,
      actor: (row.actor as string) ?? null,
      status: (row.status as AppNotification['status']) ?? 'unread',
      meta: (row.meta as string) ?? null,
      createdAt: row.created_at as string,
      readAt: (row.read_at as string) ?? null,
      recipient: (row.recipient as string) ?? null,
      readBy: (row.read_by as string) ?? null
    }
  }
}
