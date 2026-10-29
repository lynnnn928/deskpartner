import { getDatabase } from './index'
import { DEFAULT_TELEMETRY } from '../../renderer/lib/constants'

/** 埋点事件（读出的形态） */
export interface UsageEvent {
  id: number
  ts: string
  sessionId: string
  actor: string
  surface: string
  category: string
  event: string
  ok: boolean | null
  durationMs: number | null
  props: Record<string, unknown> | null
}

/** 写入一条埋点 */
export interface RecordUsageInput {
  sessionId: string
  /** 谁触发的：human / system，v2 起会有 agent:<id> */
  actor: string
  /** 从哪触发的：float_ball / kanban / settings / quick_add / cli / tray / system */
  surface: string
  /** 大类：app / window / todo / category / settings / cli / error */
  category: string
  /** 具体事件名，如 app.start / todo.create */
  event: string
  ok?: boolean | null
  durationMs?: number | null
  /**
   * 事件参数。
   * 只放结构化的元数据（如状态值、数量、错误码），
   * **绝不放置待办标题、描述等正文内容** —— 埋点是行为记录，不是内容备份。
   */
  props?: Record<string, unknown> | null
}

export interface UsageQuery {
  since?: string
  until?: string
  category?: string
  event?: string
  surface?: string
  limit?: number
  /**
   * 跳过排在最前面的 N 条（1.0.109，修 `7f21841f`）。
   *
   * 与 `order` 一起才成立：**先定顺序，再切片**。`order: 'newest'` 时
   * `offset: 50` 是"跳过最新的 50 条、取再往前的一段"（翻旧账用它）。
   */
  offset?: number
  /**
   * 取数方向（1.0.37 起有意义）。
   *
   * 默认 'newest'：**先按时间倒序截取，再把结果翻回正序**。
   * 此前一律 `ORDER BY id ASC LIMIT n`，即"取最旧的 n 条"——
   * Bob排障时 `export --limit 3` 拿到的是 09-16 的老记录，
   * 据此写的"最近 40 条"结论整段作废。排障时"看刚刚发生了什么"是最高频诉求，
   * 默认必须与之相符；翻旧账的场景用 'oldest' 显式声明。
   */
  order?: 'newest' | 'oldest'
}

/** 埋点数据仓库 */
export class TelemetryRepository {
  private get db() {
    return getDatabase()
  }

  record(input: RecordUsageInput): void {
    this.db
      .prepare(
        `INSERT INTO usage_events (ts, session_id, actor, surface, category, event, ok, duration_ms, props)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        new Date().toISOString(),
        input.sessionId,
        input.actor,
        input.surface,
        input.category,
        input.event,
        input.ok === undefined || input.ok === null ? null : input.ok ? 1 : 0,
        input.durationMs ?? null,
        input.props ? JSON.stringify(input.props) : null
      )
  }

  query(filter: UsageQuery = {}): UsageEvent[] {
    let sql = 'SELECT * FROM usage_events WHERE 1=1'
    const params: unknown[] = []

    if (filter.since) {
      sql += ' AND ts >= ?'
      params.push(filter.since)
    }
    if (filter.until) {
      sql += ' AND ts <= ?'
      params.push(filter.until)
    }
    if (filter.category) {
      sql += ' AND category = ?'
      params.push(filter.category)
    }
    if (filter.event) {
      sql += ' AND event = ?'
      params.push(filter.event)
    }
    if (filter.surface) {
      sql += ' AND surface = ?'
      params.push(filter.surface)
    }

    /**
     * 取数方向：默认最新优先（见 UsageQuery.order 的说明）。
     *
     * 为什么先倒序再翻回来、而不是 `ORDER BY id DESC` 直接返回：
     * 返回值的语义是"一段时间内的流水"，**行内顺序应始终按时间正序**，
     * 调用方不该因为"要最新几条"就得反过来读。倒序只用于选哪几条。
     */
    const newestFirst = filter.order !== 'oldest'
    sql += this.windowClause(filter, params)

    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[]
    if (newestFirst) rows.reverse()
    return rows.map(this.mapRow)
  }

  /**
   * 汇总统计：总量、各维度分布、时间跨度
   *
   * ⚠️ 1.0.38：不再走 `query()` 把全表读进内存。
   *
   * 原实现的开销远不止"读 5 万行" —— `query()` 会对每一行做
   * `mapRow`，而 mapRow 里有 `JSON.parse(props)`：
   * **5 万次 JSON 解析 + 5 万个对象**，每次打开「使用数据」都跑一遍，
   * 而且 better-sqlite3 是同步 API，这一整段会阻塞主进程。
   * 统计其实只需要几个聚合值，不需要任何一行的 props。
   *
   * 改成在 SQL 里聚合。两处语义必须严格保持，否则数字会悄悄变：
   * 1. **LIMIT**：query 是"先选最新 N 条、再翻回正序"，
   *    所以统计的是那 N 条，不是全表 —— 用 CTE 把选行和统计分开。
   * 2. **firstTs / lastTs**：是**结果集的首末行**（正序后），
   *    不是全表 MIN/MAX(ts)。ts 与 id 未必严格同序（同毫秒插入），
   *    所以按 id 取首末行，而不是用 MIN/MAX。
   */
  stats(filter: UsageQuery = {}) {
    const { sql: scopedSql, params: scopedParams } = this.buildScopedQuery(filter)

    const agg = this.db
      .prepare(
        `WITH scoped AS (${scopedSql})
         SELECT
           COUNT(*)                                        AS total,
           COUNT(DISTINCT session_id)                      AS sessions,
           COALESCE(SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END), 0) AS failed,
           (SELECT ts FROM scoped ORDER BY id ASC  LIMIT 1) AS firstTs,
           (SELECT ts FROM scoped ORDER BY id DESC LIMIT 1) AS lastTs
         FROM scoped`
      )
      .get(...scopedParams) as {
      total: number
      sessions: number
      failed: number
      firstTs: string | null
      lastTs: string | null
    }

    const groupBy = (expr: string): Record<string, number> => {
      const rows = this.db
        .prepare(
          `WITH scoped AS (${scopedSql}) SELECT ${expr} AS k, COUNT(*) AS n FROM scoped GROUP BY k`
        )
        .all(...scopedParams) as Array<{ k: string; n: number }>
      const out: Record<string, number> = {}
      for (const r of rows) out[r.k] = r.n
      return out
    }

    const byCategory = groupBy('category')
    const bySurface = groupBy('surface')
    // 统计口径与原实现一致：key 是 "category.event"
    const byEvent = groupBy(`category || '.' || event`)

    /**
     * ── 失败分两桶（1.0.49，修 4d1dfb6e）──
     *
     * 主用户实测 1876 条 cli 事件、270 次失败，手算后发现近一半不是"出错"：
     * 近期 555 次调用里 108 次失败，其中 53 次（49%）是
     * grant_required / identity_required / credential_invalid / ambiguous_identity
     * 这类**守卫按设计拒绝**。
     *
     * 混在一个 failed 里的代价是真实的：看板上会读成"agent 用得乱七八糟"，
     * 而实际上将近一半是流程摩擦的正常代价（该批的没批、该声明的没声明），
     * 剩下才是接口误用。两者的处置方向完全相反 ——
     * 前者要改授权粒度，后者要改参数文案 —— 所以必须分桶。
     *
     * 判据用 errorCode 白名单而不是"看 message 里有没有守卫字样"：
     * 白名单是可枚举的事实，而文案随时会改。
     */
    const guardCodes = [
      'grant_required',
      'identity_required',
      'identity_unregistered',
      'identity_pending',
      'credential_missing',
      'credential_invalid',
      'ambiguous_identity',
      'guard_blocked',
      /**
       * `human_required` 是 1.0.47 之前的错误码（当时有"仅人可执行"的闸门），
       * 现已移除。但**历史事件里还留着它** —— 不列进来，那些记录会被
       * 归到"真错误"，而它们当时同样是"守卫按设计拒绝"。
       * 分桶是给历史数据看的，历史错误码就该留在白名单里。
       */
      'human_required'
    ]

    const inGuard = `COALESCE(json_extract(props, '$.errorCode'), '') IN (${guardCodes.map(() => '?').join(',')})`

    /**
     * 守卫拒绝 / 真错误 各自按命令与错误码展开
     *
     * `, cmd ASC, code ASC` 是兜底次序键（1.0.109，卡 `681528e5`）：同票数时行序由
     * SQLite 的隐式顺序定，而这里的行序**会传出去** —— 结果按行序建 `byCmd` /
     * `byErrorCode` 两个对象，JSON 的键顺序就是它。同一份数据两次读出不同的键序，
     * 读的人会以为数据变了；同票时按名字排也更可读。
     */
    const bucket = (guard: boolean) => {
      const rows = this.db
        .prepare(
          `WITH scoped AS (${scopedSql})
           SELECT
             COALESCE(json_extract(props, '$.cmd'), '(unknown)')       AS cmd,
             COALESCE(json_extract(props, '$.errorCode'), '(unknown)') AS code,
             COUNT(*)                                                  AS n
           FROM scoped
           WHERE ok = 0 AND ${guard ? inGuard : `NOT (${inGuard})`}
           GROUP BY cmd, code ORDER BY n DESC, cmd ASC, code ASC`
        )
        .all(...scopedParams, ...guardCodes) as Array<{ cmd: string; code: string; n: number }>

      const byCmd: Record<string, number> = {}
      const byErrorCode: Record<string, number> = {}
      let total = 0
      for (const r of rows) {
        byCmd[r.cmd] = (byCmd[r.cmd] ?? 0) + r.n
        byErrorCode[r.code] = (byErrorCode[r.code] ?? 0) + r.n
        total += r.n
      }
      return { total, byCmd, byErrorCode }
    }

    const guardRejections = bucket(true)
    const errors = bucket(false)

    /**
     * ── 归因覆盖率（1.0.49，修 4d1dfb6e 的"读数的坑"）──
     *
     * 主用户指出的坑：cmd 归因上线之前的事件里，`props.cmd` 是 `(unknown)`。
     * 拿全量算比例会把"归因没上线"当成"agent 乱来"。
     *
     * 她原本建议 stats 默认 `--since` 从归因生效那天起算 ——
     * 但那等于把一个**具体日期**写死进代码：日期是这一台机器的历史事实，
     * 不是产品规律，换台机器、清过库就不对了。
     *
     * 改成报**事实**而不是猜起点：告诉读数的人"这批数据里有多少条
     * 归因不上"，他自己决定要不要收窄时间窗。这比替他决定更诚实，
     * 也不会因为时间流逝而过期。
     */
    const attribution = this.db
      .prepare(
        `WITH scoped AS (${scopedSql})
         SELECT
           COUNT(*) AS total,
           COALESCE(SUM(CASE WHEN COALESCE(json_extract(props, '$.cmd'), '') = '' THEN 1 ELSE 0 END), 0) AS unattributed
         FROM scoped`
      )
      .get(...scopedParams) as { total: number; unattributed: number }

    const attributionCoverage = {
      total: attribution.total,
      /** props.cmd 缺失或为空 = 归因不上（多为 cmd 归因上线前的事件） */
      unattributed: attribution.unattributed,
      /** 已归因占比，0~1；total 为 0 时记 1（空集不该读成"全都没归因"） */
      rate: attribution.total ? 1 - attribution.unattributed / attribution.total : 1
    }

    /**
     * 分位数只取 duration_ms 一列，不再把整行拉进内存排序。
     * 用 LIMIT/OFFSET 各取一个值 —— 三次小查询，比物化 5 万个对象便宜得多。
     */
    const durations = this.db
      .prepare(
        `WITH scoped AS (${scopedSql}) SELECT COUNT(*) AS n FROM scoped WHERE duration_ms IS NOT NULL`
      )
      .get(...scopedParams) as { n: number }

    const pick = (p: number): number | null => {
      if (!durations.n) return null
      const offset = Math.min(durations.n - 1, Math.floor(durations.n * p))
      const row = this.db
        .prepare(
          `WITH scoped AS (${scopedSql})
           SELECT duration_ms AS v FROM scoped WHERE duration_ms IS NOT NULL
           ORDER BY duration_ms ASC LIMIT 1 OFFSET ?`
        )
        .get(...scopedParams, offset) as { v: number } | undefined
      return row ? row.v : null
    }

    return {
      total: agg.total,
      sessions: agg.sessions,
      failed: agg.failed,
      firstTs: agg.firstTs,
      lastTs: agg.lastTs,
      byCategory,
      bySurface,
      byEvent,
      /** 失败按性质分两桶（1.0.49）：守卫拒绝 vs 真错误，各自再按 cmd/errorCode 展开 */
      guardRejections,
      errors,
      /** 归因覆盖率（1.0.49）：读失败分布前先看这个，别把"归因没上线"当"乱来" */
      attributionCoverage,
      durationMs: durations.n
        ? { p50: pick(0.5), p95: pick(0.95), max: pick(1) }
        : null
    }
  }

  /**
   * 构造"应该统计哪些行"的子查询（stats 专用）
   *
   * 必须与 `query()` 的过滤与取数方向完全一致，否则统计口径会和
   * 流水列表对不上 —— 界面上"共 N 条"与列表长度不一致最难排查。
   */
  private buildScopedQuery(filter: UsageQuery): { sql: string; params: unknown[] } {
    let sql = `SELECT id, ts, session_id, category, surface, event, ok, duration_ms, props
               FROM usage_events WHERE 1=1`
    const params: unknown[] = []

    if (filter.since) {
      sql += ' AND ts >= ?'
      params.push(filter.since)
    }
    if (filter.until) {
      sql += ' AND ts <= ?'
      params.push(filter.until)
    }
    if (filter.category) {
      sql += ' AND category = ?'
      params.push(filter.category)
    }
    if (filter.event) {
      sql += ' AND event = ?'
      params.push(filter.event)
    }
    if (filter.surface) {
      sql += ' AND surface = ?'
      params.push(filter.surface)
    }

    sql += this.windowClause(filter, params)
    return { sql, params }
  }

  /**
   * 取数方向 + 窗口（ORDER BY / LIMIT / OFFSET）—— **只此一处**（1.0.109，修 `7f21841f`）。
   *
   * `query()` 与 `buildScopedQuery()` 必须给出同一批行，否则"共 N 条"与列表长度
   * 对不上。此前这段在两处各写一遍（只有 ORDER BY + LIMIT），而加 `--offset`
   * 正是那种"改一处忘一处"的时刻：`telemetry export --offset 50` 与统计口径
   * 会各说各话。所以窗口收成这一份，两处都调它。
   *
   * ⚠️ SQLite 的 `OFFSET` 必须跟 `LIMIT` 一起出现 —— 没有条数上限时写 `LIMIT -1`
   * （SQLite 里 -1 = 不限）：这也就是"只传 `--offset`"的语义，跳过前面几条、其余全给。
   */
  private windowClause(filter: UsageQuery, params: unknown[]): string {
    let sql = filter.order === 'oldest' ? ' ORDER BY id ASC' : ' ORDER BY id DESC'
    const offset = filter.offset && filter.offset > 0 ? filter.offset : 0
    if (filter.limit && filter.limit > 0) {
      sql += ' LIMIT ?'
      params.push(filter.limit)
      if (offset > 0) {
        sql += ' OFFSET ?'
        params.push(offset)
      }
    } else if (offset > 0) {
      sql += ' LIMIT -1 OFFSET ?'
      params.push(offset)
    }
    return sql
  }

  /**
   * 按保留策略清理旧数据（条数上限与天数上限双管齐下）
   * 返回删除的条数
   */
  prune(retentionDays = DEFAULT_TELEMETRY.retentionDays, maxRows = DEFAULT_TELEMETRY.maxRows): number {
    const cutoff = new Date(Date.now() - retentionDays * 86400000).toISOString()
    const byAge = this.db.prepare('DELETE FROM usage_events WHERE ts < ?').run(cutoff).changes

    const count = (this.db.prepare('SELECT COUNT(*) AS n FROM usage_events').get() as { n: number }).n
    let byRows = 0
    if (count > maxRows) {
      byRows = this.db
        .prepare(
          `DELETE FROM usage_events WHERE id IN (
             SELECT id FROM usage_events ORDER BY id ASC LIMIT ?
           )`
        )
        .run(count - maxRows).changes
    }
    return byAge + byRows
  }

  /** 清空（可只清某时间点之前的） */
  clear(before?: string): number {
    if (before) {
      return this.db.prepare('DELETE FROM usage_events WHERE ts < ?').run(before).changes
    }
    return this.db.prepare('DELETE FROM usage_events').run().changes
  }

  private mapRow(row: Record<string, unknown>): UsageEvent {
    let props: Record<string, unknown> | null = null
    if (row.props) {
      try {
        props = JSON.parse(row.props as string)
      } catch {
        props = null
      }
    }
    return {
      id: row.id as number,
      ts: row.ts as string,
      sessionId: row.session_id as string,
      actor: row.actor as string,
      surface: row.surface as string,
      category: row.category as string,
      event: row.event as string,
      ok: row.ok === null || row.ok === undefined ? null : Boolean(row.ok),
      durationMs: (row.duration_ms as number | null) ?? null,
      props
    }
  }
}
