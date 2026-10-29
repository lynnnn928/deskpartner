/**
 * 「本次变更」聚合（1.0.73，主用户提单 `482e4b03`）
 *
 * ── 它要回答的问题 ──
 *
 * 主用户的原话：「agent 提交待验收时，生成"本次变更"（描述追加 / 状态 / 字段）
 * 的 diff 视图，人可逐条批注后通过/驳回。」现状是「人验收时看不到 agent
 * 这次到底改了什么，只有描述追加后的文本」。
 *
 * 所以这个模块的判据只有一条：**把"这一次交付"里发生的事，单独挑出来**。
 * 不是"这条事项的历史"（那是变更记录，已经有了），而是
 * **「从我上次点头/退回之后，到现在为止，动过什么」**。
 *
 * ── 边界怎么定 ──
 *
 * 「本次」= **最近一次「进入待验收」之后**的所有变更。
 *
 * 为什么不是"最近 N 天"：时间是绝对量，与"这次交付"没有因果关系 ——
 * 一条卡挂了一周才被推验收，按时间切会把一周前别人做的事也算成"本次"。
 *
 * 为什么不是"最近一次流转之后"：那样一来「进行中 → 待验收」这条流转本身
 * 会把边界切在自己的时间点上，于是**交付动作之前改的描述全部落选** ——
 * 而 agent 的典型姿势恰恰是"改完描述、顺手推验收"，
 * 两者时间差在毫秒级。判据用 `to === 'awaiting_review'` 的**那一步**，
 * 并且取它的时间戳作为下界、用它之后的事件。
 *
 * ⚠️ 从没进过待验收（还在进行中/待办）：没有"本次交付"可言，
 * 返回 null 让调用方**不渲染这一块**，而不是渲染一个空框。
 * 空框会让人以为"这次什么都没改" —— 而事实是"还没交付过"，
 * 两者不是一回事（本项目反复在治的"缺失 ≠ 否定"）。
 *
 * ── 三类怎么归 ──
 *
 * - **描述追加**：`description_changed` 事件。追加时用 `appendedFrom`
 *   切出新增部分（`after.slice(appendedFrom)`）；替换时用 before/after 对照。
 * - **状态**：`todo_transitions`。含驳回（`isRejection === true`）。
 * - **字段**：`fields_changed` 事件（1.0.73 新增的数据源）。
 *
 * 三类各自保留自己的形状，**不拍平成一种**：描述 diff 要展示行级新增、
 * 状态要展示箭头、字段要展示 `优先级：普通 → 高`。拍平会丢掉每一类
 * 最有价值的那部分信息，最终渲染出来的东西反而更少。
 */

import type { FieldChange } from './field-changes'

/** 本次变更里的一条（三类的统一外壳） */
export interface ReviewDiffItem {
  /** 归类：描述追加 / 状态变更 / 字段变更 */
  kind: 'desc' | 'status' | 'field'
  /** 发生时间（ISO） */
  at: string
  /** 动作人；空串 = 未记录 */
  actor: string
  /**
   * 人话摘要，一行说清这条变更是"什么变成什么"。
   *
   * 与 `audit-text.ts` 同一分工：**翻译在主进程做完，渲染层只显示**。
   * 拼一份到渲染层，就是下一个"写了却读不出"。
   */
  summary: string
  /**
   * 逐行 diff（仅 `kind === 'desc'` 且能算出来时才有）
   *
   * 每行带 `type`：`add` = 本次新增 / `same` = 原有（**只在需要上下文时
   * 少量带上**，不是整篇回放）。
   */
  lines?: DiffLine[]
  /** 状态变更的结构化数据（渲染箭头用，比解析 summary 可靠） */
  status?: { from: string | null; to: string; isRejection: boolean }
  /** 字段变更的结构化数据 */
  fields?: FieldChange[]
}

/** 描述 diff 的一行 */
export interface DiffLine {
  type: 'add' | 'same'
  text: string
}

/** 输入：一个事项的审计事件 + 流转（与 `mergeTimeline` 收的东西同源，便于一处取数） */
export interface ReviewDiffInput {
  events: readonly {
    type: string
    actor: string | null
    payload: unknown
    createdAt: string
  }[]
  transitions: readonly {
    fromStatus: string | null
    toStatus: string
    actor: string | null
    createdAt: string
    isRejection?: boolean | null
  }[]
}

/** 状态码 → 中文（与 renderer 的 STATUS_META / audit-text 同口径） */
const STATUS_LABELS: Record<string, string> = {
  proposed: '待确认',
  todo: '待办',
  in_progress: '进行中',
  suspended: '挂起',
  awaiting_review: '待验收',
  done: '已完成',
  discarded: '已废弃'
}

/** 显示名兜底：未记录时不猜（与动态/变更记录同一口径） */
function actorLabel(actor: string | null): string {
  return actor && actor.trim() ? actor : '未记录'
}

function statusLabel(s: string | null | undefined): string {
  if (!s) return '新建'
  return STATUS_LABELS[s] ?? s
}

/**
 * 聚合出「本次变更」
 *
 * @returns null = 这条还没交付过（没有可供验收的"本次"）
 */
export function buildReviewDiff(input: ReviewDiffInput): ReviewDiffItem[] | null {
  // ① 找最近一次「进入待验收」——它是"本次交付"的分界线
  const arrivals = input.transitions.filter((t) => t.toStatus === 'awaiting_review')
  if (!arrivals.length) return null
  // 用最大时间戳而不是数组最后一个：listTransitions 是旧→新，
  // 但本函数**不该依赖调用方的排序**（换个取数实现就会错）。
  // 判据是"最近一次进入待验收"，那是时间上的最大值，不是数组位置。
  const since = arrivals.reduce((latest, t) => (t.createdAt > latest ? t.createdAt : latest), '')

  const items: ReviewDiffItem[] = []

  // ② 审计侧：描述追加 + 字段变更
  for (const e of input.events) {
    /**
     * 边界用 `>` 还是 `>=`：
     *
     * 用 `>` ——「进入待验收」那一刻**之前**的改动才算"本次要验的东西"。
     * 那条流转本身不该进入本次清单（它是提交动作，不是提交内容；
     * 状态那一路会在下面单独描述"已交付待验收"）。
     *
     * ⚠️ 但同一毫秒的先后靠毫秒差不可靠（本项目已经栽过：
     * is_rejection 的判据曾经靠 `.142` / `.143` 的差来决定）。
     * 所以这里**不赌毫秒**：进入待验收之后的**下一次**流转才算"动过"，
     * 而同毫秒的审计事件按 `>` 排除在外 —— 宁可漏掉一条同毫秒的
     * 描述追加（它紧接着就会被别的改动带出来），
     * 也不要把"提交动作"本身当成"提交内容"列给人看。
     */
    if (!(e.createdAt > since)) continue

    const p = (e.payload ?? {}) as Record<string, unknown>

    if (e.type === 'todo' && p.action === 'description_changed') {
      const after = typeof p.after === 'string' ? p.after : ''
      const before = typeof p.before === 'string' ? p.before : null
      const appendedFrom = typeof p.appendedFrom === 'number' ? p.appendedFrom : undefined
      const isAppend = String(p.mode ?? 'replace') === 'append'

      if (isAppend && appendedFrom !== undefined && after.length >= appendedFrom) {
        // 能切出精确的新增部分 —— 这是追加场景最要紧的信息
        const added = after.slice(appendedFrom)
        items.push({
          kind: 'desc',
          at: e.createdAt,
          actor: e.actor ?? '',
          summary: `${actorLabel(e.actor)} 追加了描述（+${added.length} 字）`,
          lines: buildAddedLines(added)
        })
      } else if (isAppend) {
        /**
         * 追加，但**没有切片下标** —— 这是 1.0.73 之前写的老事件。
         * 退路是显示全文，并**如实说明**为什么没能只显示新增部分。
         * 不假装："看起来像新增部分"的一段文本，比明说"这是全文"更危险。
         */
        items.push({
          kind: 'desc',
          at: e.createdAt,
          actor: e.actor ?? '',
          summary: `${actorLabel(e.actor)} 追加了描述（+${after.length} 字；老记录没有追加起点，以下为全文）`,
          lines: after.split('\n').map((text): DiffLine => ({ type: 'same', text }))
        })
      } else {
        // 替换：before/after 都在，直接展示对照
        items.push({
          kind: 'desc',
          at: e.createdAt,
          actor: e.actor ?? '',
          summary: `${actorLabel(e.actor)} 覆写了描述整篇`,
          lines: [
            ...(before ?? '').split('\n').map((text): DiffLine => ({ type: 'same', text })),
            { type: 'add', text: '—— 以下为覆写后的新文 ——' },
            ...after.split('\n').map((text): DiffLine => ({ type: 'same', text }))
          ]
        })
      }
      continue
    }

    if (e.type === 'todo' && p.action === 'fields_changed') {
      const changes = Array.isArray(p.changes) ? (p.changes as FieldChange[]) : []
      if (!changes.length) continue
      items.push({
        kind: 'field',
        at: e.createdAt,
        actor: e.actor ?? '',
        summary: `${actorLabel(e.actor)} 改了 ${changes.length} 个字段`,
        fields: changes
      })
    }
  }

  // ③ 流转侧：进入待验收之后的每一次状态变化
  for (const t of input.transitions) {
    if (!(t.createdAt > since)) continue
    const rejected = t.isRejection === true
    items.push({
      kind: 'status',
      at: t.createdAt,
      actor: t.actor ?? '',
      summary: rejected
        ? `${actorLabel(t.actor)} 驳回了这条（退回「${statusLabel(t.toStatus)}」）`
        : `${actorLabel(t.actor)} 把状态从「${statusLabel(t.fromStatus)}」推到「${statusLabel(t.toStatus)}」`,
      status: { from: t.fromStatus, to: t.toStatus, isRejection: rejected }
    })
  }

  /**
   * 排序：按时间升序，**同一时刻审计在前、流转在后** ——
   * 与 `mergeTimeline` 的约定一致（先说"内容变成了什么"，再说"状态怎么变的"）。
   *
   * ⚠️ 不在同一函数里做两套排序：展示层如果按 `at` 重排，同一毫秒的先后
   * 会随机（本项目已经因为这件事加过 `timelineSeq`）。
   * 这里把顺序**在产出时定死**，调用方按数组顺序渲染即可。
   */
  items.sort((a, b) => {
    const ta = Date.parse(a.at)
    const tb = Date.parse(b.at)
    if (Number.isNaN(ta) || Number.isNaN(tb)) return 0
    if (ta !== tb) return ta - tb
    const rank = (x: ReviewDiffItem): number => (x.kind === 'status' ? 1 : 0)
    return rank(a) - rank(b)
  })

  return items
}

/**
 * 把新增文本切成 diff 行
 *
 * 新增部分整体都是 `add` —— 不做"行内字符级 diff"。判据：
 * 追加场景下新增部分是**一整块新写的文字**（不是对原有文字的修改），
 * 逐字符比对只会把"补充说明："这类通用词匹配到原文里去，
 * 反而让人看不出"到底加了哪一段"。
 *
 * 空行保留（它是排版的一部分），不裁掉。
 */
function buildAddedLines(added: string): DiffLine[] {
  const text = added.replace(/^\n+/, '')
  if (!text.trim()) return []
  return text.split('\n').map((line) => ({ type: 'add' as const, text: line }))
}
