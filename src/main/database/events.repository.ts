import { getDatabase } from './index'
import { DEFAULT_EVENTS } from '../../renderer/lib/constants'

/** 数据变更事件 */
export interface ChangeEvent {
  id: number
  type: string
  actor: string
  payload: Record<string, unknown> | null
  createdAt: string
}

/**
 * 数据变更事件仓储
 *
 * 存在的唯一理由：让**别的进程**的数据改动能被本进程看到。
 * 同一进程内的改动走 Electron 的 webContents.send 就够了，
 * 不需要绕数据库；只有当 CLI 这种独立进程改了库时，
 * 正在运行的 GUI 才会通过轮询这张表察觉到。
 */
export class EventsRepository {
  private get db() {
    return getDatabase()
  }

  /** 追加一条变更事件 */
  append(type: string, actor: string, payload?: Record<string, unknown> | null): number {
    const result = this.db
      .prepare(
        `INSERT INTO events (type, actor, payload, created_at) VALUES (?, ?, ?, ?)`
      )
      .run(type, actor, payload ? JSON.stringify(payload) : null, new Date().toISOString())
    return Number(result.lastInsertRowid)
  }

  /** 取 lastId 之后的事件（轮询用） */
  listSince(lastId: number): ChangeEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM events WHERE id > ? ORDER BY id ASC')
      .all(lastId) as Record<string, unknown>[]
    return rows.map(this.mapRow)
  }

  /** 当前最大 id，用于初始化轮询游标 */
  maxId(): number {
    const row = this.db.prepare('SELECT MAX(id) AS m FROM events').get() as
      | { m: number | null }
      | undefined
    return row?.m ?? 0
  }

  /**
   * 取某个事项的审计事件（1.0.60，主用户驳回 68c7ccc1）
   *
   * ── 为什么需要它 ──
   *
   * 她的驳回原话：「留痕写进去了，但**没有任何地方读得出**，实际效果仍是无痕」。
   * 判据（验收方给的）：「`todo history` 能看到'某某在何时删了哪条评论'，
   * 不需要碰数据库」。
   *
   * 问题在于 events 表**只有"给轮询用的增量读法"**（`listSince`）：
   * 它回答的是"自游标以来发生了什么"，是**进程间同步**的机制，
   * 根本不是给人回溯用的。而 `comment_deleted` / `todo_deleted`
   * 这类审计事件的 payload 里带着 `todoId`，却被埋在 JSON 里没人查得动。
   *
   * 所以补一个**按事项查审计**的读法：payload 里 todoId 匹配即命中。
   * 用 `json_extract` 而不是 LIKE：LIKE '%"todoId":"x"%' 会在
   * 描述文本里恰好出现同样串时误命中，而 json_extract 只在字段层比对。
   *
   * ⚠️ events 有保留策略（7 天 / 2000 条），它是**审计线索不是备份** ——
   * 调用方（todo history）必须把"可能已被清理"如实说出来，不能假装完整。
   *
   * ⚠️ 最后那个 OR 是 1.0.62 补的：`todo update` 改描述时写的 payload 用 `id`
   * 而不是 `todoId`（见 commands.ts 的 description_changed），于是这类事件
   * **从来没被这里命中过** —— 就算把翻译层写对了，也拿不到它，仍是假留痕。
   * 限定 `type = 'todo'` 是为了收窄口径：顶层带 `id` 的 payload 不止这一种，
   * 无差别按 `$.id` 匹配会把别处的 id 误当成事项 id。
   */
  listForTodo(todoId: string, limit = 100): ChangeEvent[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM events
         WHERE json_extract(payload, '$.todoId') = ?
            OR json_extract(payload, '$.comment.todoId') = ?
            OR json_extract(payload, '$.snapshot.id') = ?
            OR (type = 'todo' AND json_extract(payload, '$.id') = ?)
         ORDER BY id DESC
         LIMIT ?`
      )
      .all(todoId, todoId, todoId, todoId, limit) as Record<string, unknown>[]
    return rows.map((r) => this.mapRow(r))
  }

  /**
   * 墓碑事件：不参与按保留策略的清理（1.0.62）
   *
   * `todo_deleted` 不是一条"变更通知"，它是被删对象**留在世上唯一的证据** ——
   * `findDeletedSnapshot` 就是从这个事件里把快照读回来的。把它套进 7 天保留，
   * 等于给历史装上定时失效：同一个 `todo history`，今天还答得出、
   * 下周就变成 not_found，而界面上没有任何东西告诉用户"痕迹过期了"。
   *
   * b3ac3d32 修好的墓碑查询（resolveId allowDeleted）因此只在 7 天内成立。
   * 代价是这类事件会一直留着 —— 删事项是低频动作（远低于评论/改状态），
   * 换来的是"查得到"这个唯一判据永远成立，这笔交换是值的。
   */
  private static readonly IMMORTAL_TYPES = ['todo_deleted']

  /** 按保留策略清理（7 天 / 2000 条），墓碑除外（见 IMMORTAL_TYPES） */
  prune(
    retentionDays = DEFAULT_EVENTS.retentionDays,
    maxRows = DEFAULT_EVENTS.maxRows
  ): number {
    const exempt = EventsRepository.IMMORTAL_TYPES
    const placeholders = exempt.map(() => '?').join(',')
    const cutoff = new Date(Date.now() - retentionDays * 86400000).toISOString()

    const byAge = this.db
      .prepare(
        `DELETE FROM events WHERE created_at < ? AND type NOT IN (${placeholders})`
      )
      .run(cutoff, ...exempt).changes

    const count = (this.db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n
    let byRows = 0
    if (count > maxRows) {
      byRows = this.db
        .prepare(
          `DELETE FROM events WHERE id IN (
             SELECT id FROM events WHERE type NOT IN (${placeholders}) ORDER BY id ASC LIMIT ?
           )`
        )
        .run(...exempt, count - maxRows).changes
    }
    return byAge + byRows
  }

  private mapRow(row: Record<string, unknown>): ChangeEvent {
    let payload: Record<string, unknown> | null = null
    if (row.payload) {
      try {
        payload = JSON.parse(row.payload as string)
      } catch {
        payload = null
      }
    }
    return {
      id: row.id as number,
      type: row.type as string,
      actor: row.actor as string,
      payload,
      createdAt: row.created_at as string
    }
  }
}
