import { randomUUID } from 'node:crypto'
import { getDatabase } from './index'
import { nowVersion } from '../lib/version-stamp'
import { markHandoffDirty } from './handoff-state'

export const PROFILE_BLOCK_KEYS = ['basics', 'habits', 'boundaries', 'completion'] as const
export type ProfileBlockKey = (typeof PROFILE_BLOCK_KEYS)[number]
export type ProfileScope = { scope: 'global' } | { scope: 'project'; projectId: string }

const PROJECT_PROFILE_KEYS = new Set<ProfileBlockKey>(['boundaries', 'completion'])

export const DEFAULT_PROFILE_BLOCKS: Record<ProfileBlockKey, string> = {
  basics: '',
  habits: '',
  boundaries: '',
  completion: ''
}

export interface ProfileBlock {
  scope: 'global' | 'project'
  projectId: string | null
  blockKey: ProfileBlockKey
  body: string
  confirmed: boolean
  updatedBy: string
  updatedAt: string
  source: 'global' | 'project' | 'empty'
}

export class ProfileRepository {
  private get db() {
    return getDatabase()
  }

  list(scope: ProfileScope): ProfileBlock[] {
    const globals = this.db.prepare(`
      SELECT * FROM profile_blocks WHERE scope = 'global' AND project_id IS NULL
    `).all() as any[]
    const globalByKey = new Map<string, any>(globals.map((row) => [row.block_key, row]))
    const overrides = scope.scope === 'project'
      ? this.db.prepare(`SELECT * FROM profile_blocks WHERE scope = 'project' AND project_id = ?`).all(scope.projectId) as any[]
      : []
    const projectByKey = new Map<string, any>(overrides.map((row) => [row.block_key, row]))

    return PROFILE_BLOCK_KEYS.map((key) => {
      const projectAllowed = scope.scope === 'project' && PROJECT_PROFILE_KEYS.has(key)
      const row = projectAllowed ? (projectByKey.get(key) ?? globalByKey.get(key)) : globalByKey.get(key)
      const source = row ? (row.scope as 'global' | 'project') : 'empty'
      return {
        scope: row?.scope ?? 'global',
        projectId: row?.project_id ?? (source === 'project' && scope.scope === 'project' ? scope.projectId : null),
        blockKey: key,
        body: row?.body ?? DEFAULT_PROFILE_BLOCKS[key],
        // 没有任何记录表示“尚未填写”，不能伪装成用户已确认的空内容。
        confirmed: row ? Boolean(row.confirmed) : false,
        updatedBy: row?.updated_by ?? 'system',
        updatedAt: row?.updated_at ?? '',
        source
      }
    })
  }

  save(scope: ProfileScope, blockKey: ProfileBlockKey, body: string, actor = 'human', confirmed = true): ProfileBlock {
    if (!PROFILE_BLOCK_KEYS.includes(blockKey)) throw new Error(`未知用户档案区块：${blockKey}`)
    if (scope.scope === 'project' && !PROJECT_PROFILE_KEYS.has(blockKey)) {
      throw new Error(`用户档案区块「${blockKey}」只能在全局范围维护`)
    }
    const trimmed = body.trim()
    if (!trimmed) throw new Error('用户档案正文不能为空')
    const now = nowVersion()
    const projectId = scope.scope === 'project' ? scope.projectId : null
    const tx = this.db.transaction(() => {
      const current = this.db.prepare(`
        SELECT * FROM profile_blocks WHERE scope = ? AND project_id IS ? AND block_key = ?
      `).get(scope.scope, projectId, blockKey) as any
      if (current?.body === trimmed && Boolean(current.confirmed) === confirmed) return

      // 升级旧库时由迁移写入已有基线；新建区块则显式保存“此前不存在”。
      const hasHistory = this.db.prepare(`
        SELECT 1 FROM profile_revisions WHERE scope = ? AND project_id IS ? AND block_key = ? LIMIT 1
      `).get(scope.scope, projectId, blockKey)
      if (!hasHistory) {
        this.insertRevision(scope, projectId, blockKey, current?.body ?? '', Boolean(current?.confirmed), Boolean(current), actor, now)
      }

      this.db.prepare(`
        INSERT INTO profile_blocks (scope, project_id, block_key, body, confirmed, updated_by, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(scope, project_id, block_key) DO UPDATE SET
          body = excluded.body, confirmed = excluded.confirmed,
          updated_by = excluded.updated_by, updated_at = excluded.updated_at
      `).run(scope.scope, projectId, blockKey, trimmed, confirmed ? 1 : 0, actor, now)
      this.insertRevision(scope, projectId, blockKey, trimmed, confirmed, true, actor, now)
    })
    tx()
    /** 项目级档案变了 → 接手说明该复核（卡 `233cd5f6`）；采纳提议同样走这里 */
    if (scope.scope === 'project' && projectId) {
      markHandoffDirty(this.db, projectId, `项目档案有更新（${blockKey}）`)
    }
    return this.list(scope).find((item) => item.blockKey === blockKey)!
  }

  private insertRevision(
    scope: ProfileScope,
    projectId: string | null,
    blockKey: ProfileBlockKey,
    body: string,
    confirmed: boolean,
    present: boolean,
    actor: string,
    createdAt: string
  ): void {
    this.db.prepare(`
      INSERT INTO profile_revisions
        (id, scope, project_id, block_key, body, confirmed, present, author, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), scope.scope, projectId, blockKey, body, confirmed ? 1 : 0, present ? 1 : 0, actor, createdAt)
  }

  listRevisions(scope: ProfileScope, blockKey?: ProfileBlockKey): ProfileRevision[] {
    const projectId = scope.scope === 'project' ? scope.projectId : null
    const rows = this.db.prepare(`
      SELECT * FROM profile_revisions
      WHERE scope = ? AND project_id IS ? ${blockKey ? 'AND block_key = ?' : ''}
      ORDER BY created_at DESC, rowid DESC LIMIT 50
    `).all(...(blockKey ? [scope.scope, projectId, blockKey] : [scope.scope, projectId])) as any[]
    return rows.map(toRevision)
  }

  rollbackRevision(id: string, actor = 'human'): ProfileBlock {
    const tx = this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM profile_revisions WHERE id = ?').get(id) as any
      if (!row) throw new Error(`用户档案修订不存在：${id}`)
      const scope: ProfileScope = row.scope === 'project'
        ? { scope: 'project', projectId: row.project_id }
        : { scope: 'global' }
      const blockKey = row.block_key as ProfileBlockKey
      if (!PROFILE_BLOCK_KEYS.includes(blockKey) || (scope.scope === 'project' && !PROJECT_PROFILE_KEYS.has(blockKey))) {
        throw new Error('该档案修订不属于可回滚范围')
      }
      const now = nowVersion()
      const projectId = scope.scope === 'project' ? scope.projectId : null
      if (row.present) {
        this.db.prepare(`
          INSERT INTO profile_blocks (scope, project_id, block_key, body, confirmed, updated_by, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(scope, project_id, block_key) DO UPDATE SET
            body = excluded.body, confirmed = excluded.confirmed,
            updated_by = excluded.updated_by, updated_at = excluded.updated_at
        `).run(scope.scope, projectId, blockKey, row.body, row.confirmed, actor, now)
      } else {
        this.db.prepare(`DELETE FROM profile_blocks WHERE scope = ? AND project_id IS ? AND block_key = ?`)
          .run(scope.scope, projectId, blockKey)
      }
      this.insertRevision(scope, projectId, blockKey, row.body, Boolean(row.confirmed), Boolean(row.present), actor, now)
      return scope
    })
    const scope = tx()
    return this.list(scope).find((item) => item.blockKey === this.revisionBlockKey(id))!
  }

  private revisionBlockKey(id: string): ProfileBlockKey {
    const row = this.db.prepare('SELECT block_key FROM profile_revisions WHERE id = ?').get(id) as { block_key: ProfileBlockKey }
    return row.block_key
  }

  listProposals(status: 'pending' | 'all' = 'pending'): ProfileProposal[] {
    const where = status === 'pending' ? "WHERE status = 'pending'" : ''
    // `, id ASC` 是兜底次序键（卡 07015c7e）：同刻提交的提议，顺序不能交给 SQLite 的隐式行为
    return (this.db.prepare(`
      SELECT * FROM profile_proposals ${where} ORDER BY created_at ASC, id ASC
    `).all() as any[]).map((row) => {
      const proposal = toProposal(row)
      const scope: ProfileScope = proposal.scope === 'project' ? { scope: 'project', projectId: proposal.projectId! } : { scope: 'global' }
      const current = this.list(scope).find((block) => block.blockKey === proposal.blockKey)
      const currentUpdatedAt = current?.updatedAt || '∅'
      return {
        ...proposal,
        currentBody: current?.body ?? null,
        currentUpdatedAt,
        stale: !proposal.baseUpdatedAt || currentUpdatedAt !== proposal.baseUpdatedAt
      }
    })
  }

  propose(scope: ProfileScope, blockKey: ProfileBlockKey, body: string, proposer: string): ProfileProposal {
    if (!PROFILE_BLOCK_KEYS.includes(blockKey)) throw new Error(`未知用户档案区块：${blockKey}`)
    if (scope.scope === 'project' && !PROJECT_PROFILE_KEYS.has(blockKey)) {
      throw new Error(`用户档案区块「${blockKey}」只能在全局范围维护`)
    }
    const trimmed = body.trim()
    if (!trimmed) throw new Error('用户档案提议不能为空')
    const current = this.list(scope).find((block) => block.blockKey === blockKey)!
    const proposal: ProfileProposal = {
      id: randomUUID(),
      scope: scope.scope,
      projectId: scope.scope === 'project' ? scope.projectId : null,
      blockKey,
      body: trimmed,
      originalBody: current.body,
      baseUpdatedAt: current.updatedAt || '∅',
      decidedBody: null,
      proposer,
      status: 'pending',
      decidedBy: null,
      decidedAt: null,
      createdAt: nowVersion()
    }
    this.db.prepare(`
      INSERT INTO profile_proposals
        (id, scope, project_id, block_key, body, original_body, base_updated_at, decided_body, proposer, status, created_at)
      VALUES (@id, @scope, @projectId, @blockKey, @body, @originalBody, @baseUpdatedAt, NULL, @proposer, @status, @createdAt)
    `).run(proposal)
    return proposal
  }

  decideProposal(id: string, decision: 'approved' | 'rejected', actor = 'human', editedBody?: string): ProfileProposal {
    const now = nowVersion()
    const tx = this.db.transaction(() => {
      const row = this.db.prepare(`SELECT * FROM profile_proposals WHERE id = ?`).get(id) as any
      if (!row) throw new Error(`用户档案提议不存在：${id}`)
      if (row.status !== 'pending') throw new Error('用户档案提议已经处理过')
      const scope: ProfileScope = row.scope === 'project' ? { scope: 'project', projectId: row.project_id } : { scope: 'global' }
      const proposedBody = (editedBody ?? row.body).trim()
      if (decision === 'approved') {
        if (!proposedBody) throw new Error('采纳后的用户档案正文不能为空')
        const current = this.list(scope).find((block) => block.blockKey === row.block_key)
        if (!row.base_updated_at) throw new Error('这条旧提议未保存当时内容版本，无法安全覆盖；请让 agent 基于当前档案重新提交')
        if ((current?.updatedAt || '∅') !== row.base_updated_at) {
          throw new Error('用户档案在提议后已发生变化，请重新核对当前内容后再处理')
        }
        this.save(scope, row.block_key as ProfileBlockKey, proposedBody, actor, true)
      }
      const changed = this.db.prepare(`
        UPDATE profile_proposals SET status = ?, decided_by = ?, decided_at = ?, decided_body = ?
        WHERE id = ? AND status = 'pending'
      `).run(decision, actor, now, decision === 'approved' ? proposedBody : null, id).changes
      if (changed !== 1) throw new Error('用户档案提议已被其他操作处理')
    })
    tx()
    return toProposal(this.db.prepare(`SELECT * FROM profile_proposals WHERE id = ?`).get(id))
  }
}

export interface ProfileRevision {
  id: string
  scope: 'global' | 'project'
  projectId: string | null
  blockKey: ProfileBlockKey
  body: string
  confirmed: boolean
  /** false 表示该层当时没有独立内容，项目层回滚后将重新沿用全局值 */
  present: boolean
  author: string
  createdAt: string
}

function toRevision(row: any): ProfileRevision {
  return {
    id: row.id,
    scope: row.scope,
    projectId: row.project_id ?? null,
    blockKey: row.block_key,
    body: row.body,
    confirmed: Boolean(row.confirmed),
    present: Boolean(row.present),
    author: row.author,
    createdAt: row.created_at
  }
}

export interface ProfileProposal {
  id: string
  scope: 'global' | 'project'
  projectId: string | null
  blockKey: ProfileBlockKey
  body: string
  originalBody: string | null
  baseUpdatedAt: string | null
  decidedBody: string | null
  currentBody?: string | null
  currentUpdatedAt?: string | null
  stale?: boolean
  proposer: string
  status: 'pending' | 'approved' | 'rejected'
  decidedBy: string | null
  decidedAt: string | null
  createdAt: string
}

function toProposal(row: any): ProfileProposal {
  return {
    id: row.id,
    scope: row.scope,
    projectId: row.project_id ?? null,
    blockKey: row.block_key,
    body: row.body,
    originalBody: row.original_body ?? null,
    baseUpdatedAt: row.base_updated_at ?? null,
    decidedBody: row.decided_body ?? null,
    proposer: row.proposer,
    status: row.status,
    decidedBy: row.decided_by ?? null,
    decidedAt: row.decided_at ?? null,
    createdAt: row.created_at
  }
}

export function isProjectProfileKey(key: string): key is ProfileBlockKey {
  return PROFILE_BLOCK_KEYS.includes(key as ProfileBlockKey) && PROJECT_PROFILE_KEYS.has(key as ProfileBlockKey)
}

export function isProfileBlockKey(key: string): key is ProfileBlockKey {
  return PROFILE_BLOCK_KEYS.includes(key as ProfileBlockKey)
}

