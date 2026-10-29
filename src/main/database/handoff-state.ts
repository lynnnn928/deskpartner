/**
 * 接手说明的**状态模型**：自动事实 / 覆盖声明 / 新鲜度（卡 `e2a06fd7`）
 *
 * ## 病
 *
 * 接手说明是一段自由 Markdown，**谁也不知道它基于哪一版事实写的**。
 * 现场（卡 `607871b2`）：DeskPartner 的说明写"正式发布为 1.0.97，schema v42"，
 * 而实际已是 1.0.109/schema v45 —— 落后 12 个版本，首读的人看不出来。
 *
 * ## 三层，各管各的
 *
 * 1. **自动事实**（`HandoffFacts`）：版本、schema、事项计数、当前主线 —— **运行时可算**。
 *    它**永不落库改写正文**：叙述权归人，机器只负责说"事实现在是这个"。
 * 2. **覆盖声明**（`HandoffSnapshot`）：保存那一刻的事实快照 + 确认人。
 *    它回答"这一版说明自称覆盖到什么"，旧行没有快照就是"无法核对"，不编一个出来。
 * 3. **待复核标记**（`HandoffDirty`）：发布、提议被拒这类**事实之外**的变化。
 *    按项目一条、按原因集去重 —— 同一批变化只提醒一次。
 *
 * ## 判据（三态，含"为什么"）
 *
 * - `fresh`：有快照、事实没漂、没有待复核标记；
 * - `review_required`：快照缺失 / 版本/ schema / 主线变了 / 有标记 —— 回到人手上看一眼；
 * - `stale`：没有说明，或待复核已超过 7 天（挂着没人管本身就是一种状态，要说出来）。
 *
 * ## 为什么不按"事项计数变了"判
 *
 * 计数每天都在变（新建一条、关一条），拿它当理由等于天天喊"要复核"，
 * 喊久了就没人看 —— 那正是"不刷屏"要防的。计数照常作为**事实**展示，但不进判定。
 */

import type Database from 'better-sqlite3'
import type { TodoStatus } from '../../renderer/types/enums'
import type {
  HandoffCoverage,
  HandoffDirty,
  HandoffFacts,
  HandoffFreshness,
  HandoffSnapshot
} from '../../renderer/types/project'

/** 待复核挂多久算 stale（只提醒，不硬判过期 —— 见卡 e2a06fd7 的边界） */
export const HANDOFF_STALE_AFTER_DAYS = 7

/** 回执里最多列几条原因（再多也没人看；完整原因在标记里） */
export const HANDOFF_MAX_REASONS = 5

/**
 * 类型住在共享类型里（CLI / IPC / 界面同一份形状），这里转出一次：
 * 判据模块自己不带第二套定义，免得两边各改各的。
 */
export type {
  HandoffCoverage,
  HandoffDirty,
  HandoffFacts,
  HandoffFreshness,
  HandoffMainTodo,
  HandoffSnapshot,
  HandoffFreshnessState
} from '../../renderer/types/project'

const STATUS_LABELS: Record<TodoStatus, string> = {
  proposed: '待确认',
  todo: '待办',
  in_progress: '进行中',
  suspended: '挂起',
  awaiting_review: '待验收',
  done: '已完成',
  discarded: '已废弃'
}

/** 快照的覆盖声明（旧版没有快照时返回 null） */
export function coverageOf(snapshot: HandoffSnapshot | null): HandoffCoverage | null {
  if (!snapshot) return null
  return {
    version: snapshot.facts.version,
    schemaVersion: snapshot.facts.schemaVersion,
    mainTodoId: snapshot.facts.mainTodo?.id ?? null
  }
}

/**
 * 快照与当前事实的差异 —— **只列会改变判断的**。
 *
 * 判据：版本与 schema 决定"说明讲的是哪一代产品"；主线决定"它讲的还是不是当前那件事"。
 * 计数不列（每天都变，列了就是噪音）。
 */
export function diffFacts(snapshot: HandoffFacts, current: HandoffFacts): string[] {
  const reasons: string[] = []
  if (snapshot.version && current.version && snapshot.version !== current.version) {
    reasons.push(`说明基于 ${snapshot.version}，当前 ${current.version}`)
  }
  if (snapshot.schemaVersion !== current.schemaVersion) {
    reasons.push(`说明基于 schema v${snapshot.schemaVersion}，当前 v${current.schemaVersion}`)
  }
  const before = snapshot.mainTodo
  const after = current.mainTodo
  if (!before && after) {
    reasons.push(`说明里没有主线，当前主线是「${after.title}」`)
  } else if (before && !after) {
    reasons.push(`说明写着主线「${before.title}」，但当前没有未完成主线`)
  } else if (before && after && before.id !== after.id) {
    reasons.push(`主线换了：从「${before.title}」到「${after.title}」`)
  } else if (before && after && before.status !== after.status) {
    reasons.push(
      `主线「${after.title}」的状态从${STATUS_LABELS[before.status] ?? before.status}变成${STATUS_LABELS[after.status] ?? after.status}`
    )
  }
  return reasons
}

/**
 * 判新鲜度。
 *
 * @param input.body 当前接手说明正文（空 = 还没有说明）
 * @param input.snapshot 最近一版说明保存时的事实快照（旧版为 null）
 * @param input.dirty 项目上的待复核标记（触发器的产物，事实之外的变量）
 * @param input.current 当前事实
 */
export function freshnessOf(input: {
  body: string
  snapshot: HandoffSnapshot | null
  dirty: HandoffDirty | null
  current: HandoffFacts
  now?: number
}): HandoffFreshness {
  const now = input.now ?? Date.now()
  const checkedAt = new Date(now).toISOString()
  const base = {
    coverage: coverageOf(input.snapshot),
    dirty: input.dirty,
    checkedAt
  }

  if (!input.body.trim()) {
    /**
     * 没有说明本身就是 stale，但**别把待复核的原因吞掉**：
     * 一条被拒的提议、一次发布，都是"为什么还没有/仍是旧说明"的线索。
     */
    const reasons = ['还没有接手说明', ...(input.dirty?.reasons ?? [])]
    return { ...base, state: 'stale', reasons: [...new Set(reasons)].slice(0, HANDOFF_MAX_REASONS) }
  }

  const reasons: string[] = []
  if (!input.snapshot) {
    reasons.push('说明没有事实快照（旧版），无法核对它基于什么')
  } else {
    reasons.push(...diffFacts(input.snapshot.facts, input.current))
  }
  if (input.dirty) reasons.push(...input.dirty.reasons)

  const unique = [...new Set(reasons)].slice(0, HANDOFF_MAX_REASONS)
  if (!unique.length) return { ...base, state: 'fresh', reasons: [] }

  const dirtyDays = input.dirty
    ? (now - Date.parse(input.dirty.at)) / (24 * 60 * 60 * 1000)
    : 0
  if (input.dirty && dirtyDays >= HANDOFF_STALE_AFTER_DAYS) {
    return {
      ...base,
      state: 'stale',
      reasons: [...new Set([...unique, `待复核已超过 ${HANDOFF_STALE_AFTER_DAYS} 天`])].slice(
        0,
        HANDOFF_MAX_REASONS
      )
    }
  }
  return { ...base, state: 'review_required', reasons: unique }
}

/** 宽松解析：库里存的是 JSON，坏数据当"没有快照"处理，不抛错 */
export function parseFacts(raw: unknown): HandoffFacts | null {
  if (typeof raw !== 'string' || !raw.trim()) return null
  try {
    const parsed = JSON.parse(raw) as HandoffFacts
    if (!parsed || typeof parsed !== 'object') return null
    if (typeof parsed.schemaVersion !== 'number') return null
    if (!parsed.statusCounts || typeof parsed.statusCounts !== 'object') return null
    return parsed
  } catch {
    return null
  }
}

function parseReasons(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw.trim()) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/**
 * 读项目上的待复核标记。**一条**（不是一列表）—— 刷屏的反面就是这里。
 */
export function readHandoffDirty(
  db: Database.Database,
  projectId: string
): HandoffDirty | null {
  const row = db
    .prepare('SELECT handoff_dirty_reasons, handoff_dirty_at FROM projects WHERE id = ?')
    .get(projectId) as { handoff_dirty_reasons: string | null; handoff_dirty_at: string | null } | undefined
  if (!row) return null
  const reasons = parseReasons(row.handoff_dirty_reasons)
  if (!reasons.length) return null
  return { reasons, at: row.handoff_dirty_at ?? new Date(0).toISOString() }
}

/**
 * 标一条待复核（卡 `233cd5f6`）。
 *
 * **同一批变化只产生一个标记**：判据是"原因集"的指纹 —— 已有标记的原因集没变就不写。
 * 新原因进来只**追加**并更新指纹，仍是一行（按项目去重，不会刷屏）。
 *
 * @returns 这次是否真的写了（false = 同一批，什么都没变）
 */
export function markHandoffDirty(
  db: Database.Database,
  projectId: string,
  reason: string,
  now = new Date()
): boolean {
  const trimmed = reason.trim()
  if (!trimmed) return false
  const row = db
    .prepare(
      'SELECT handoff_dirty_key, handoff_dirty_reasons, handoff_dirty_at FROM projects WHERE id = ?'
    )
    .get(projectId) as
    | { handoff_dirty_key: string | null; handoff_dirty_reasons: string | null; handoff_dirty_at: string | null }
    | undefined
  if (!row) return false
  const reasons = [...new Set([...parseReasons(row.handoff_dirty_reasons), trimmed])]
  const key = reasons.slice().sort().join('|')
  if (row.handoff_dirty_key === key) return false
  db.prepare(
    `UPDATE projects
        SET handoff_dirty_reasons = ?, handoff_dirty_key = ?, handoff_dirty_at = ?
      WHERE id = ?`
  ).run(JSON.stringify(reasons), key, now.toISOString(), projectId)
  return true
}

/** 说明被重新保存/采纳/回滚后，标记清掉（内容已经是人看过的新版） */
export function clearHandoffDirty(db: Database.Database, projectId: string): void {
  db.prepare(
    `UPDATE projects
        SET handoff_dirty_reasons = NULL, handoff_dirty_key = NULL, handoff_dirty_at = NULL
      WHERE id = ?`
  ).run(projectId)
}
