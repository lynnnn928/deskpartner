import { UsageError, ConflictError, NotFoundError, GuardError } from '../lib/domain-errors'
import { getDatabase } from './index'
import { markHandoffDirty } from './handoff-state'
import type {
  Release,
  ReleaseDetail,
  CreateReleaseInput,
  UpdateReleaseInput
} from '../../renderer/types/release'

/**
 * 版本仓库（1.0.73，主用户 10-07 提；1.0.76 起版本是项目下的二级概念）
 *
 * 「版本应该不只是一个字段，它应该是一个对象」——
 * 本类就是那个对象：登记"这一版是什么、做了什么、关联了哪些卡片"。
 *
 * ## 定位键是 (项目, 版本号)，不是版本号（a2ea95f8）
 *
 * 主用户 10-09 纠正了 v31 的设计错误：
 * 「怎么可能 A 用了一个版本号，B 就不能用了呢？版本号本来就应该跟产品、项目、模块去关联。」
 * —— 两个项目可以各有自己的 1.0.76，它们是**两个不同的版本**。
 * 所以查重、定位、删除、反查全部按 (project_id, version) 走。
 *
 * ## 三条判据（逐条对着迁移 31 的理由写的）
 *
 * 1. **(项目, 版本号) 是版本的身份，不另造 id。** 「DeskPartner 的 1.0.73」
 *    天然唯一，再造一个 uuid 只会让人在两个标识之间来回查。
 * 2. **不回填历史。** 没有行就是没有行 —— `list()` 只回登记过的版本，
 *    不用 `todos.fixed_in_version` 里出现过的字符串去"补齐"版本列表。
 *    那样会把"某版只是有事项标了它"伪装成"某版被登记过"。
 * 3. **不联动改事项。** 登记一个版本不会给任何事项打标，
 *    改事项也不会自动建版本行。两件事各有各的动作（见 CLI 的 release 命令）。
 *    自动联动看起来省事，实际会让"谁改了归属"这件事查不出来。
 */
export class ReleaseRepository {
  private get db() {
    return getDatabase()
  }

  /**
   * 登记一个版本（同项目下已存在则报错，不静默覆盖）
   *
   * 为什么不 upsert：`release add 1.0.73` 打错字成已有版本号时，
   * 静默覆盖会把那一版原来的 summary / highlights 抹掉 ——
   * 而这正是"版本对象"唯一要保存的东西。
   */
  create(input: CreateReleaseInput): Release {
    const version = input.version.trim()
    if (!version) throw new UsageError('[ReleaseRepository] 版本号不能为空')
    /**
     * 版本是**项目下的二级概念**（主用户 10-09）：不挂项目的版本不登记。
     * CLI 管入口提示，这里管最后一道 —— IPC / 界面也能走到这。
     */
    const projectId = (input.projectId ?? '').trim()
    if (!projectId) throw new UsageError('[ReleaseRepository] 版本必须挂到项目上：projectId 不能为空')
    if (this.getByProjectAndVersion(projectId, version)) {
      throw new ConflictError(
        `[ReleaseRepository] 该项目下的版本 ${version} 已登记过；要改内容用 release update，不要重复 add`
      )
    }

    const release: Release = {
      version,
      projectId,
      shippedAt: input.shippedAt ?? null,
      summary: input.summary ?? null,
      highlights: input.highlights ?? [],
      createdAt: new Date().toISOString(),
      // 不传 = 不知道（NULL），**不猜"应该是跑过测试的"** —— 那是编造
      tested: input.tested ?? null
    }

    this.db
      .prepare(
        `INSERT INTO releases (version, project_id, shipped_at, summary, highlights, created_at, tested)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        release.version,
        release.projectId,
        release.shippedAt,
        release.summary,
        JSON.stringify(release.highlights),
        release.createdAt,
        release.tested
      )

    /**
     * 发布是"接手说明该复核了"最硬的一个信号（卡 `233cd5f6`）：
     * 那一版说明写的版本、schema、主线大概率已经过时。只标标记，**不改正文** ——
     * 叙述权归人，机器只负责提醒。
     */
    markHandoffDirty(this.db, release.projectId, `发布了 ${release.version}`)

    return release
  }

  /**
   * 更新版本（只改内容字段；undefined = 不动）
   *
   * `projectId` 在这里是**定位键**（哪一项目的哪一版），不是可改字段 ——
   * (项目, 版本号) 是版本的身份，换了项目就是另一个版本了。
   * 要"挪"一个版本只能删了重建：宁可麻烦一点，不让人把「知彼的 1.0.76」
   * 一改变成「DeskPartner 的 1.0.76」然后查不出它原本是谁的。
   */
  update(input: UpdateReleaseInput): Release {
    const projectId = (input.projectId ?? '').trim()
    if (!projectId) throw new UsageError('[ReleaseRepository] projectId 不能为空（版本按 (项目, 版本号) 定位）')
    const existing = this.getByProjectAndVersion(projectId, input.version)
    if (!existing) {
      throw new NotFoundError(`[ReleaseRepository] 版本不存在: ${projectId} 下的 ${input.version}`)
    }

    const updated: Release = {
      ...existing,
      shippedAt: input.shippedAt === undefined ? existing.shippedAt : input.shippedAt,
      summary: input.summary === undefined ? existing.summary : input.summary,
      highlights: input.highlights === undefined ? existing.highlights : input.highlights,
      tested: input.tested === undefined ? existing.tested : input.tested
    }

    this.db
      .prepare(
        `UPDATE releases SET shipped_at = ?, summary = ?, highlights = ?, tested = ?
          WHERE project_id = ? AND version = ?`
      )
      .run(
        updated.shippedAt,
        updated.summary,
        JSON.stringify(updated.highlights),
        updated.tested,
        projectId,
        updated.version
      )

    return updated
  }

  /**
   * 删除版本登记。
   *
   * 选项②：只要仍有事项关联该版本，就拒绝删除；版本登记不能静默抹掉
   * 事项的 `fixed_in_version` 历史。调用方必须先逐条解除关联，再重试删除。
   * 关联统计严格限定在当前项目，避免同名版本跨项目串台。
   *
   * `orphanTodos` 保留在回执类型中以兼容 CLI，但成功删除时恒为 0。
   *
   * `orphanTodos` 的统计**在项目语境内**（a2ea95f8）：
   * 「标着 1.0.76 的事项」在两个项目下是两批事，删 DeskPartner 的 1.0.76
   * 不该把知彼那批算进来。
   */
  delete(projectId: string, version: string): { deleted: string; orphanTodos: number } {
    const existing = this.getByProjectAndVersion(projectId, version)
    if (!existing) throw new NotFoundError(`[ReleaseRepository] 版本不存在: ${projectId} 下的 ${version}`)

    const { n } = this.db
      .prepare('SELECT COUNT(*) AS n FROM todos WHERE fixed_in_version = ? AND project_id = ?')
      .get(version, projectId) as { n: number }

    if (n > 0) {
      throw new GuardError(
        `[ReleaseRepository] 版本 ${version} 仍关联 ${n} 条事项；请先逐条解除事项的 fixed_in_version，再删除版本`
      )
    }

    this.db
      .prepare('DELETE FROM releases WHERE project_id = ? AND version = ?')
      .run(projectId, version)
    return { deleted: version, orphanTodos: 0 }
  }

  /** 登记过的全部版本，新发布在前（未填 shipped_at 的按登记时间排） */
  list(): Release[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM releases
          ORDER BY COALESCE(shipped_at, created_at) DESC, version DESC`
      )
      .all() as Record<string, unknown>[]
    return rows.map(this.mapRow)
  }

  /**
   * 按 (项目, 版本号) 取一条 —— 版本的定位键（a2ea95f8）
   *
   * 不能只按版本号查：两个项目各有自己的 1.0.76 是常态
   * （主用户：「总有一天会撞上同一个版本号」）。
   */
  getByProjectAndVersion(projectId: string, version: string): Release | null {
    const row = this.db
      .prepare('SELECT * FROM releases WHERE project_id = ? AND version = ?')
      .get(projectId, version) as Record<string, unknown> | undefined
    return row ? this.mapRow(row) : null
  }

  /**
   * 版本详情：版本对象 + 它收口的事项
   *
   * `todos` 是**派生**的（来自 `fixed_in_version = version`），
   * 不另存一份 —— 存了就一定会和事项自身的版本字段对不上。
   *
   * 反查**在项目语境内**（a2ea95f8）：事项的版本号引用跟着项目走，
   * 「标着 1.0.76」指的是"我这个项目里的 1.0.76"。
   */
  detail(projectId: string, version: string): ReleaseDetail | null {
    const release = this.getByProjectAndVersion(projectId, version)
    if (!release) return null

    const todos = this.db
      .prepare(
        `SELECT id, title, status, project_id FROM todos
          WHERE fixed_in_version = ? AND project_id = ?
          ORDER BY created_at ASC, id ASC`
      )
      .all(version, projectId) as Record<string, unknown>[]

    return {
      ...release,
      todos: todos.map((t) => ({
        id: t.id as string,
        title: t.title as string,
        status: t.status as string,
        projectId: (t.project_id as string | null) ?? null
      })),
      todoCount: todos.length
    }
  }

  /**
   * 一个项目的所有版本（版本与项目关联的读法）
   *
   * 「这个版本又可以跟项目关联起来」—— 关联的用处就是这一条查询：
   * 从项目出发问"它发过哪些版"。
   */
  listByProject(projectId: string): Release[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM releases WHERE project_id = ?
          ORDER BY COALESCE(shipped_at, created_at) DESC, version DESC`
      )
      .all(projectId) as Record<string, unknown>[]
    return rows.map(this.mapRow)
  }

  /**
   * 发版对账：版本登记与卡片标注**两个差集**（卡 `c291b93a`）
   *
   * ## 为什么要有这一步
   *
   * 1.0.111 的登记里写了摘要、写了 highlights、`tested=yes` 也记了，
   * 唯独 `todoCount = 0` —— 九张 UX 卡一张都没标版本，而**没有任何一步因此变红**。
   * 登记校验只看"有没有摘要"，不看"这一版到底收了哪些卡"。
   *
   * ## 三个差集：两个硬、一个软
   *
   * - `unmarked`（硬）：**上一版之后**已收口、却一个版本都没标的卡。
   *   这正是 1.0.111 的形状 —— 九张卡都在板上，就是没人把它们归到这一版。
   *   窗口从上一版的发布时刻算起：更早的漏标属于历史账，不该让每一版都红
   *   （真库实测：1.0.59~1.0.69 那批卡标的是"当年没登记过的版本号"，
   *   按全历史算会永久红，那种闸门最后只会被人绕过去）。
   * - `unregistered`（硬）：项目里有卡标了这个版本号，但该版本没登记。
   *   这是"先标卡、后忘了登记"的形状 —— 看起来发过，其实查不到。
   * - `empty`（软，只报不拦）：登记了、但一张卡都没有。
   *   它**不能硬拦**：1.0.106 就是零卡版本，那是合法的（只有内部改动、没有卡）。
   *   真正的硬判据是它和 `unmarked` 同时非空 —— "这一版一张卡都没收，
   *   而窗口里明明有做完的卡"，两句话合起来才是事故。
   *
   * ⚠️ 反查一律在项目语境内（`a2ea95f8`）：两个项目各有自己的 1.0.76。
   */
  audit(projectId: string, version?: string): ReleaseAudit {
    const all = this.listByProject(projectId)
    /** 审计的那一版：给了就用，没给就取最新的一版（按发布/登记时刻） */
    const target = version
      ? this.getByProjectAndVersion(projectId, version)
      : (all[0] ?? null)
    if (version && !target) {
      /**
       * 版本没登记，但项目里已经有卡标了它 —— 这正是 `unregistered` 要报的形状
       * （先标卡、后忘了登记：看起来发过，查 `release show` 却是"没登记过"）。
       * 一张都没有时才报"版本不存在"：那时对账本身没有对象。
       */
      const marked = (
        this.db
          .prepare(
            `SELECT COUNT(*) AS n FROM todos WHERE project_id = ? AND fixed_in_version = ?`
          )
          .get(projectId, version) as { n: number }
      ).n
      if (marked > 0) {
        return {
          projectId,
          version,
          windowStart: null,
          unregistered: [version],
          empty: [],
          unmarked: [],
          consistent: false,
          message: `有 ${marked} 张卡标着 ${version}，但这个版本没有登记 —— 先 release add，或把这些卡的标注改掉`
        }
      }
      throw new NotFoundError(
        `[ReleaseRepository] 版本不存在: ${projectId} 下的 ${version}（对账要对着一条已登记的版本做）`
      )
    }
    if (!target) {
      return {
        projectId,
        version: null,
        windowStart: null,
        unregistered: [],
        empty: [],
        unmarked: [],
        consistent: true,
        message: '这个项目还没有登记过任何版本，无从对账'
      }
    }

    const anchorOf = (r: Release): string => r.shippedAt ?? r.createdAt
    const anchor = anchorOf(target)
    /** 上一版 = 锚点严格早于本版的最近一条；没有就是首版（窗口不设下界） */
    const previous = all
      .filter((r) => r.version !== target.version && anchorOf(r) < anchor)
      .sort((a, b) => (anchorOf(a) < anchorOf(b) ? 1 : -1))[0]
    const windowStart = previous ? anchorOf(previous) : null

    /** 差集 1（硬）：卡标了本版，本版却没登记 —— 能走到这里说明本版已登记，所以为空 */
    const unregistered: string[] = []

    /** 差集 2（软）：本版零卡 */
    const linked = this.detail(projectId, target.version)?.todoCount ?? 0
    const empty = linked === 0 ? [target.version] : []

    /** 差集 3（硬）：窗口内已收口、却没有版本可归的卡 */
    const rows = (
      windowStart
        ? this.db.prepare(
            `SELECT id, title, completed_at FROM todos
               WHERE project_id = ? AND status = ?
                 AND (fixed_in_version IS NULL OR fixed_in_version = '')
                 AND COALESCE(completed_at, updated_at) >= ?
               ORDER BY COALESCE(completed_at, updated_at) ASC, id ASC LIMIT 50`
          ).all(projectId, 'done', windowStart)
        : this.db.prepare(
            `SELECT id, title, completed_at FROM todos
               WHERE project_id = ? AND status = ?
                 AND (fixed_in_version IS NULL OR fixed_in_version = '')
               ORDER BY COALESCE(completed_at, updated_at) ASC, id ASC LIMIT 50`
          ).all(projectId, 'done')
    ) as { id: string; title: string; completed_at: string | null }[]
    const unmarked = rows.map((r) => ({
      id: r.id,
      title: r.title,
      completedAt: r.completed_at ?? null
    }))

    const consistent = unregistered.length === 0 && unmarked.length === 0
    const parts: string[] = [
      consistent
        ? `版本 ${target.version} 与卡片的标注一致（关联 ${linked} 张）`
        : `版本 ${target.version} 对不上账`
    ]
    if (unmarked.length) {
      parts.push(
        `${windowStart ? `上一版（${windowStart.slice(0, 10)}）之后` : '项目里'}有 ${unmarked.length} 张已收口的卡没标版本`
      )
    }
    if (empty.length && unmarked.length === 0) {
      parts.push('这一版零卡 —— 如果确实只有内部改动、没有卡，忽略这条')
    }

    return {
      projectId,
      version: target.version,
      windowStart,
      unregistered,
      empty,
      unmarked,
      consistent,
      message: parts.join('；')
    }
  }

  /** 将数据库行映射为 Release 对象 */
  private mapRow(row: Record<string, unknown>): Release {
    return {
      version: row.version as string,
      // v33 起 NOT NULL；容错读法保留 ?? ''（不给 null 这个假值）
      projectId: (row.project_id as string | null) ?? '',
      shippedAt: (row.shipped_at as string | null) ?? null,
      summary: (row.summary as string | null) ?? null,
      highlights: ReleaseRepository.parseHighlights(row.highlights),
      createdAt: row.created_at as string,
      // 三值外的一律归 null（"不知道"），不猜 —— 坏值不编造（与 parseHighlights 同判据）
      tested: ReleaseRepository.parseTested(row.tested)
    }
  }

  /** 解析 tested：只认 yes/no/skipped，其余（NULL、坏值）一律 null = 不知道 */
  private static parseTested(raw: unknown): 'yes' | 'no' | 'skipped' | null {
    return raw === 'yes' || raw === 'no' || raw === 'skipped' ? raw : null
  }

  /**
   * 解析 highlights（容错）
   *
   * ⚠️ 坏 JSON 一律归零，不抛错：它是**附加信息**，
   * 一条 highlights 解析不出来不该让整个版本列表读不出来
   * （那是"读取入口比写入入口脆"的老毛病）。
   * 但要**归零而不是编造** —— 拿不到就是 []，不给一个猜的默认值。
   */
  private static parseHighlights(raw: unknown): string[] {
    if (typeof raw !== 'string' || !raw.trim()) return []
    try {
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
    } catch {
      return []
    }
  }
}

/** 发版对账结果（卡 `c291b93a`）：两个硬差集 + 一个软线索 */
export interface ReleaseAudit {
  projectId: string
  /** 对账对着的那一版；项目还没有任何版本时为 null */
  version: string | null
  /** 未标版本的卡的窗口起点（上一版的发布时刻）；首版为 null = 不设下界 */
  windowStart: string | null
  /** 硬差集 1：项目里有卡标了这个版本号，但该版本没登记 */
  unregistered: string[]
  /** 软线索：登记了但一张卡都没有的版本（零卡可以合法，不拦） */
  empty: string[]
  /** 硬差集 2：窗口内已收口、却没标任何版本的卡 */
  unmarked: { id: string; title: string; completedAt: string | null }[]
  /** 硬差集都为空即一致 */
  consistent: boolean
  /** 人读的一句话 */
  message: string
}
