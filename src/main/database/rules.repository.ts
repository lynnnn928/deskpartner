import { randomUUID } from 'node:crypto'
import { getDatabase } from './index'
import { nowVersion } from '../lib/version-stamp'
import { markHandoffDirty } from './handoff-state'
import { GuardError, NotFoundError, UsageError } from '../lib/domain-errors'
import {
  RULE_SPECS,
  PERMISSION_ACTIONS,
  defaultPermission,
  ruleSpecByKey,
  permissionActionSpec,
  type RuleEnforcement,
  type RuleCategory,
  type PermissionDecision,
  type PermissionAction,
  type ResolvedRule,
  type ResolvedPermission
} from './rules'

export type RulesScope = { scope: 'global' } | { scope: 'project'; projectId: string }

export interface RuleRevision {
  id: string
  scope: 'global' | 'project'
  projectId: string | null
  ruleKey: string
  category: RuleCategory
  /** null 表示该层没有覆盖，实际值继承自更高层或出厂默认 */
  enforcement: RuleEnforcement | null
  hasOverride: boolean
  author: string
  createdAt: string
}

function toRevision(row: any): RuleRevision {
  return {
    id: row.id,
    scope: row.scope,
    projectId: row.project_id ?? null,
    ruleKey: row.rule_key,
    category: row.category,
    enforcement: row.enforcement ?? null,
    hasOverride: Boolean(row.has_override),
    author: row.author,
    createdAt: row.created_at
  }
}

export interface RuleProposal {
  id: string
  scope: 'global' | 'project'
  projectId: string | null
  category: RuleCategory
  ruleKey: string
  proposedEnforcement: RuleEnforcement
  originalEnforcement: RuleEnforcement
  baseUpdatedAt: string | null
  decidedEnforcement: RuleEnforcement | null
  proposer: string
  status: 'pending' | 'approved' | 'rejected'
  decidedBy: string | null
  decidedAt: string | null
  createdAt: string
  withdrawn?: boolean
}

export class RulesRepository {
  private get db() {
    return getDatabase()
  }

  // ── 流转规则 / 提醒 ─────────────────────────────────

  /** 三层解析：项目覆盖 → 全局 → 出厂默认 */
  listRules(scope: RulesScope): ResolvedRule[] {
    const globals = this.db
      .prepare(`SELECT * FROM collaboration_rules WHERE scope = 'global' AND project_id IS NULL`)
      .all() as any[]
    const globalByKey = new Map<string, any>(globals.map((row) => [row.rule_key, row]))
    const overrides =
      scope.scope === 'project'
        ? (this.db
            .prepare(`SELECT * FROM collaboration_rules WHERE scope = 'project' AND project_id = ?`)
            .all(scope.projectId) as any[])
        : []
    const projectByKey = new Map<string, any>(overrides.map((row) => [row.rule_key, row]))

    return RULE_SPECS.map((spec) => {
      const projectRow = projectByKey.get(spec.key)
      const globalRow = globalByKey.get(spec.key)
      const row = projectRow ?? globalRow
      return {
        key: spec.key,
        category: spec.category,
        what: spec.what,
        enforcement: (row?.enforcement ?? spec.defaultEnforcement) as RuleEnforcement,
        source: projectRow ? 'project' : globalRow ? 'global' : 'default'
      }
    })
  }

  /** 保存单条规则配置（主用户 GUI 直接改；agent 走提议） */
  saveRule(
    scope: RulesScope,
    ruleKey: string,
    enforcement: RuleEnforcement,
    actor = 'human'
  ): ResolvedRule {
    const spec = ruleSpecByKey(ruleKey)
    if (!spec) throw new Error(`未知协作规则：${ruleKey}`)
    if (!spec.allowedEnforcements.includes(enforcement)) {
      throw new Error(`规则 ${ruleKey} 不支持强度 ${enforcement}`)
    }
    const now = nowVersion()
    const projectId = scope.scope === 'project' ? scope.projectId : null
    const tx = this.db.transaction(() => {
      const current = this.db.prepare(`
        SELECT * FROM collaboration_rules WHERE scope = ? AND project_id IS ? AND rule_key = ?
      `).get(scope.scope, projectId, ruleKey) as any
      if (current?.enforcement === enforcement) return

      const hasHistory = this.db.prepare(`
        SELECT 1 FROM rule_revisions WHERE scope = ? AND project_id IS ? AND rule_key = ? LIMIT 1
      `).get(scope.scope, projectId, ruleKey)
      if (!hasHistory) {
        this.insertRevision(scope, projectId, ruleKey, spec.category, current?.enforcement ?? null, Boolean(current), actor, now)
      }

      this.db.prepare(`
        INSERT INTO collaboration_rules (scope, project_id, rule_key, category, enforcement, updated_by, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(scope, project_id, rule_key) DO UPDATE SET
          enforcement = excluded.enforcement, updated_by = excluded.updated_by, updated_at = excluded.updated_at
      `).run(scope.scope, projectId, ruleKey, spec.category, enforcement, actor, now)
      this.insertRevision(scope, projectId, ruleKey, spec.category, enforcement, true, actor, now)
    })
    tx()
    /** 项目级规则变了 → 接手说明该复核（卡 `233cd5f6`）；采纳提议同样走这里 */
    if (scope.scope === 'project') {
      markHandoffDirty(this.db, scope.projectId, `项目协作规则有更新（${ruleKey}）`)
    }
    return this.listRules(scope).find((r) => r.key === ruleKey)!
  }

  private insertRevision(
    scope: RulesScope,
    projectId: string | null,
    ruleKey: string,
    category: RuleCategory,
    enforcement: RuleEnforcement | null,
    hasOverride: boolean,
    actor: string,
    createdAt: string
  ): void {
    this.db.prepare(`
      INSERT INTO rule_revisions
        (id, scope, project_id, rule_key, category, enforcement, has_override, author, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), scope.scope, projectId, ruleKey, category, enforcement, hasOverride ? 1 : 0, actor, createdAt)
  }

  listRevisions(scope: RulesScope, ruleKey?: string): RuleRevision[] {
    const projectId = scope.scope === 'project' ? scope.projectId : null
    const rows = this.db.prepare(`
      SELECT * FROM rule_revisions
      WHERE scope = ? AND project_id IS ? ${ruleKey ? 'AND rule_key = ?' : ''}
      ORDER BY created_at DESC, rowid DESC LIMIT 50
    `).all(...(ruleKey ? [scope.scope, projectId, ruleKey] : [scope.scope, projectId])) as any[]
    return rows.map(toRevision)
  }

  rollbackRevision(id: string, actor = 'human'): ResolvedRule {
    const tx = this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM rule_revisions WHERE id = ?').get(id) as any
      if (!row) throw new Error(`协作规则修订不存在：${id}`)
      const spec = ruleSpecByKey(row.rule_key)
      if (!spec || spec.category !== row.category) throw new Error('该协作规则修订已不再有效')
      const scope: RulesScope = row.scope === 'project'
        ? { scope: 'project', projectId: row.project_id }
        : { scope: 'global' }
      const projectId = scope.scope === 'project' ? scope.projectId : null
      const now = nowVersion()
      if (row.has_override) {
        const enforcement = row.enforcement as RuleEnforcement
        if (!spec.allowedEnforcements.includes(enforcement)) throw new Error('该历史强度已不再受支持')
        this.db.prepare(`
          INSERT INTO collaboration_rules (scope, project_id, rule_key, category, enforcement, updated_by, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(scope, project_id, rule_key) DO UPDATE SET
            enforcement = excluded.enforcement, updated_by = excluded.updated_by, updated_at = excluded.updated_at
        `).run(scope.scope, projectId, row.rule_key, spec.category, enforcement, actor, now)
        this.insertRevision(scope, projectId, row.rule_key, spec.category, enforcement, true, actor, now)
      } else {
        this.db.prepare(`DELETE FROM collaboration_rules WHERE scope = ? AND project_id IS ? AND rule_key = ?`)
          .run(scope.scope, projectId, row.rule_key)
        this.insertRevision(scope, projectId, row.rule_key, spec.category, null, false, actor, now)
      }
      return { scope, ruleKey: row.rule_key as string }
    })
    const result = tx()
    return this.listRules(result.scope).find((r) => r.key === result.ruleKey)!
  }

  /** 恢复出厂默认（删掉该层的覆盖） */
  resetRule(scope: RulesScope, ruleKey: string, actor = 'human'): void {
    const spec = ruleSpecByKey(ruleKey)
    if (!spec) throw new Error(`未知协作规则：${ruleKey}`)
    const projectId = scope.scope === 'project' ? scope.projectId : null
    const tx = this.db.transaction(() => {
      const current = this.db.prepare(`
        SELECT 1 FROM collaboration_rules WHERE scope = ? AND project_id IS ? AND rule_key = ?
      `).get(scope.scope, projectId, ruleKey)
      if (!current) return
      const now = nowVersion()
      this.db.prepare(`DELETE FROM collaboration_rules WHERE scope = ? AND project_id IS ? AND rule_key = ?`)
        .run(scope.scope, projectId, ruleKey)
      this.insertRevision(scope, projectId, ruleKey, spec.category, null, false, actor, now)
    })
    tx()
  }

  // ── 权限矩阵 ─────────────────────────────────────────

  /**
   * 解析权限矩阵。⚠️ 权限矩阵**仅 GUI 可改** —— 没有 CLI/MCP 写入口。
   */
  listPermissions(scope: RulesScope, subjects?: string[]): ResolvedPermission[] {
    const globals = this.db
      .prepare(`SELECT * FROM permission_matrix WHERE scope = 'global' AND project_id IS NULL`)
      .all() as any[]
    const globalByKey = new Map<string, any>(
      globals.map((row) => [`${row.action}::${row.subject}`, row])
    )
    const overrides =
      scope.scope === 'project'
        ? (this.db
            .prepare(`SELECT * FROM permission_matrix WHERE scope = 'project' AND project_id = ?`)
            .all(scope.projectId) as any[])
        : []
    const projectByKey = new Map<string, any>(
      overrides.map((row) => [`${row.action}::${row.subject}`, row])
    )

    // 主体列表：human + all_agents + 传入的具体 agent
    const allSubjects = ['human', 'all_agents', ...(subjects ?? [])].filter(
      (v, i, a) => a.indexOf(v) === i
    )

    const results: ResolvedPermission[] = []
    for (const spec of PERMISSION_ACTIONS) {
      for (const subject of allSubjects) {
        const key = `${spec.action}::${subject}`
        const projectRow = projectByKey.get(key)
        const globalRow = globalByKey.get(key)
        const row = projectRow ?? globalRow
        results.push({
          action: spec.action,
          what: spec.what,
          subject,
          decision: (row?.decision ?? defaultPermission(spec.action, subject)) as PermissionDecision,
          source: projectRow ? 'project' : globalRow ? 'global' : 'default'
        })
      }
    }
    return results
  }

  /** 保存权限决定（⚠️ 仅 GUI 调用 —— CLI/MCP 没有这个入口） */
  savePermission(
    scope: RulesScope,
    action: string,
    subject: string,
    decision: PermissionDecision,
    actor = 'human'
  ): ResolvedPermission {
    if (!permissionActionSpec(action)) throw new Error(`未知权限动作：${action}`)
    const now = nowVersion()
    const projectId = scope.scope === 'project' ? scope.projectId : null
    if (scope.scope === 'global') {
      const updated = this.db
        .prepare(
          `UPDATE permission_matrix SET decision = ?, updated_by = ?, updated_at = ?
           WHERE scope = 'global' AND project_id IS NULL AND action = ? AND subject = ?`
        )
        .run(decision, actor, now, action, subject).changes
      if (!updated) {
        this.db
          .prepare(
            `INSERT INTO permission_matrix (scope, project_id, action, subject, decision, updated_by, updated_at)
             VALUES ('global', NULL, ?, ?, ?, ?, ?)`
          )
          .run(action, subject, decision, actor, now)
      }
    } else {
      this.db
        .prepare(
          `INSERT INTO permission_matrix (scope, project_id, action, subject, decision, updated_by, updated_at)
           VALUES ('project', ?, ?, ?, ?, ?, ?)
           ON CONFLICT(scope, project_id, action, subject) DO UPDATE SET
             decision = excluded.decision, updated_by = excluded.updated_by, updated_at = excluded.updated_at`
        )
        .run(projectId, action, subject, decision, actor, now)
    }
    return this.listPermissions(scope, [subject])
      .find((p) => p.action === action && p.subject === subject)!
  }

  resetPermission(scope: RulesScope, action: string, subject: string): void {
    const projectId = scope.scope === 'project' ? scope.projectId : null
    this.db
      .prepare(
        `DELETE FROM permission_matrix WHERE scope = ? AND project_id IS ? AND action = ? AND subject = ?`
      )
      .run(scope.scope, projectId, action, subject)
  }

  // ── 规则提议（agent → 审批页）────────────────────────

  listProposals(status: 'pending' | 'all' = 'pending'): RuleProposal[] {
    const where = status === 'pending' ? "WHERE status = 'pending'" : ''
    // `, id ASC` 是兜底次序键（卡 07015c7e）：同刻提交的提议，顺序不能交给 SQLite 的隐式行为
    return (
      this.db
        .prepare(`SELECT * FROM rule_proposals ${where} ORDER BY created_at ASC, id ASC`)
        .all() as any[]
    ).map(toProposal)
  }

  propose(
    scope: RulesScope,
    ruleKey: string,
    enforcement: RuleEnforcement,
    proposer: string
  ): RuleProposal {
    const spec = ruleSpecByKey(ruleKey)
    if (!spec) throw new Error(`未知协作规则：${ruleKey}`)
    if (!spec.allowedEnforcements.includes(enforcement)) {
      throw new Error(`规则 ${ruleKey} 不支持强度 ${enforcement}`)
    }
    const current = this.listRules(scope).find((r) => r.key === ruleKey)!
    const proposal: RuleProposal = {
      id: randomUUID(),
      scope: scope.scope,
      projectId: scope.scope === 'project' ? scope.projectId : null,
      category: spec.category,
      ruleKey,
      proposedEnforcement: enforcement,
      originalEnforcement: current.enforcement,
      baseUpdatedAt: current.source === 'default' ? null : nowVersion(),
      decidedEnforcement: null,
      proposer,
      status: 'pending',
      decidedBy: null,
      decidedAt: null,
      createdAt: nowVersion()
    }
    this.db
      .prepare(
        `INSERT INTO rule_proposals (id, scope, project_id, category, rule_key, proposed_enforcement, original_enforcement, base_updated_at, decided_enforcement, proposer, status, created_at)
         VALUES (@id, @scope, @projectId, @category, @ruleKey, @proposedEnforcement, @originalEnforcement, @baseUpdatedAt, NULL, @proposer, @status, @createdAt)`
      )
      .run(proposal)
    return proposal
  }

  decideProposal(
    id: string,
    decision: 'approved' | 'rejected',
    actor = 'human',
    editedEnforcement?: RuleEnforcement
  ): RuleProposal {
    const now = nowVersion()
    const tx = this.db.transaction(() => {
      const row = this.db.prepare(`SELECT * FROM rule_proposals WHERE id = ?`).get(id) as any
      if (!row) throw new Error(`规则提议不存在：${id}`)
      if (row.status !== 'pending') throw new Error('规则提议已经处理过')
      const scope: RulesScope =
        row.scope === 'project'
          ? { scope: 'project', projectId: row.project_id }
          : { scope: 'global' }
      const proposed = (editedEnforcement ?? row.proposed_enforcement) as RuleEnforcement
      if (decision === 'approved') {
        this.saveRule(scope, row.rule_key, proposed, actor)
      }
      const changed = this.db
        .prepare(
          `UPDATE rule_proposals SET status = ?, decided_by = ?, decided_at = ?, decided_enforcement = ?
           WHERE id = ? AND status = 'pending'`
        )
        .run(decision, actor, now, decision === 'approved' ? proposed : null, id).changes
      if (changed !== 1) throw new Error('规则提议已被其他操作处理')
    })
    tx()
    return toProposal(this.db.prepare(`SELECT * FROM rule_proposals WHERE id = ?`).get(id))
  }

  withdrawProposal(idOrPrefix: string, actor: string): RuleProposal {
    const ref = String(idOrPrefix ?? '').trim()
    if (!ref) throw new UsageError('缺少协作规则提议 id')
    const now = nowVersion()
    let targetId = ''
    const tx = this.db.transaction(() => {
      const rows = this.db
        .prepare(`SELECT * FROM rule_proposals WHERE id = ? OR id LIKE ? ORDER BY created_at DESC, id ASC`)
        .all(ref, `${ref}%`) as any[]
      const exact = rows.find((r) => r.id === ref)
      if (!exact && rows.length === 0) throw new NotFoundError(`规则提议不存在：${ref}`)
      if (!exact && rows.length > 1) throw new UsageError(`规则提议 id 前缀不唯一：${ref}`)
      const row = exact ?? rows[0]
      if (row.proposer !== actor) {
        throw new GuardError(`不能撤回别人提交的规则提议（提议人：${row.proposer}，当前身份：${actor}）`)
      }
      if (row.status !== 'pending') {
        throw new GuardError(`不能撤回已处理的规则提议（当前状态：${row.status}）`)
      }
      targetId = row.id
      this.db
        .prepare(`UPDATE rule_proposals SET status = 'rejected', decided_by = ?, decided_at = ? WHERE id = ? AND status = 'pending'`)
        .run(actor, now, targetId)
    })
    tx()
    return toProposal(this.db.prepare(`SELECT * FROM rule_proposals WHERE id = ?`).get(targetId))
  }
}

function toProposal(row: any): RuleProposal {
  const withdrawn = row.status === 'rejected' && Boolean(row.decided_by) && row.decided_by === row.proposer
  return {
    id: row.id,
    scope: row.scope,
    projectId: row.project_id ?? null,
    category: row.category,
    ruleKey: row.rule_key,
    proposedEnforcement: row.proposed_enforcement,
    originalEnforcement: row.original_enforcement,
    baseUpdatedAt: row.base_updated_at ?? null,
    decidedEnforcement: row.decided_enforcement ?? null,
    proposer: row.proposer,
    status: row.status,
    decidedBy: row.decided_by ?? null,
    decidedAt: row.decided_at ?? null,
    createdAt: row.created_at,
    ...(withdrawn ? { withdrawn: true } : {})
  }
}
