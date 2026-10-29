import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { getDatabase } from './index'
import { nowVersion } from '../lib/version-stamp'
import { markHandoffDirty } from './handoff-state'

export const PROTOCOL_BLOCK_KEYS = ['roles', 'handoff', 'recording', 'communication', 'language'] as const
export type ProtocolBlockKey = (typeof PROTOCOL_BLOCK_KEYS)[number]
export type ProtocolScope = { scope: 'global' } | { scope: 'project'; projectId: string }

export const DEFAULT_PROTOCOL_BLOCKS: Record<ProtocolBlockKey, string> = {
  roles: '每项工作尽量明确提出者、执行者和验收者；执行者不验收自己完成的工作。',
  handoff: '开发完成后写结论评论、记录真实验证证据并推进 awaiting_review；不要自行宣布人工验收通过。',
  recording: '描述只写原始规格，进度、讨论和结论写入评论；命令、返回和退出码使用真实证据。',
  communication: '不确定时先说明卡点和选项；涉及产品取舍、权限或破坏性操作时先请求主用户确认。',
  language: '面向用户的回复优先使用简体中文；代码、命令、API 名称和路径保持原文。'
}

const COLLABORATION_MAP: Record<string, ProtocolBlockKey> = {
  '分工：每张卡记三个角色': 'roles',
  '谁验什么': 'roles',
  '提卡与留痕': 'recording',
  '收口与发版': 'handoff',
  '改这份文件': 'communication'
}

export interface ProtocolBlock {
  scope: 'global' | 'project'
  projectId: string | null
  blockKey: ProtocolBlockKey
  body: string
  confirmed: boolean
  updatedBy: string
  updatedAt: string
  source: 'global' | 'project' | 'default'
}

export class ProtocolRepository {
  private get db() {
    return getDatabase()
  }

  private ensureRevisionTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS protocol_revisions (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL CHECK (scope IN ('global', 'project')),
        project_id TEXT,
        block_key TEXT NOT NULL,
        body TEXT NOT NULL,
        confirmed INTEGER NOT NULL CHECK (confirmed IN (0, 1)),
        present INTEGER NOT NULL CHECK (present IN (0, 1)),
        author TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_protocol_revisions_scope ON protocol_revisions(scope, project_id, block_key, created_at DESC);
    `)
  }

  seedGlobalDefaults(actor = 'system'): void {
    const now = nowVersion()
    const stmt = this.db.prepare(`
      INSERT INTO protocol_blocks
        (scope, project_id, block_key, body, confirmed, updated_by, updated_at)
      SELECT 'global', NULL, ?, ?, 0, ?, ?
      WHERE NOT EXISTS (
        SELECT 1 FROM protocol_blocks WHERE scope = 'global' AND project_id IS NULL AND block_key = ?
      )
    `)
    const tx = this.db.transaction(() => {
      for (const key of PROTOCOL_BLOCK_KEYS) stmt.run(key, DEFAULT_PROTOCOL_BLOCKS[key], actor, now, key)
    })
    tx()
    this.importCollaborationIfAvailable()
  }

  private importCollaborationIfAvailable(): void {
    const imported = this.db.prepare(`SELECT value FROM settings WHERE key = 'collaboration_import_v1'`).get() as { value: string } | undefined
    if (imported) return
    const roots = [process.env.DESKPARTNER_PROJECT_ROOT, process.cwd()]
      .filter((value): value is string => Boolean(value?.trim()))
      .map((value) => path.resolve(value))
    const file = roots.map((root) => path.join(root, 'COLLABORATION.md')).find((candidate) => fs.existsSync(candidate))
    if (!file) return
    let body: string
    try {
      body = fs.readFileSync(file, 'utf8')
    } catch {
      return
    }
    const sections = parseCollaboration(body)
    const now = nowVersion()
    const tx = this.db.transaction(() => {
      const update = this.db.prepare(`UPDATE protocol_blocks SET body = ?, updated_by = ?, updated_at = ? WHERE scope = 'global' AND project_id IS NULL AND block_key = ? AND confirmed = 0 AND updated_by = 'system'`)
      for (const [key, value] of Object.entries(sections)) update.run(value, `import:${file}`, now, key)
      this.db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES ('collaboration_import_v1', ?)`).run(file)
    })
    tx()
  }

  list(scope: ProtocolScope): ProtocolBlock[] {
    this.seedGlobalDefaults()
    const globals = this.db.prepare(`SELECT * FROM protocol_blocks WHERE scope = 'global' AND project_id IS NULL`).all() as any[]
    const globalByKey = new Map<string, any>(globals.map((row) => [row.block_key, row]))
    const overrides = scope.scope === 'project'
      ? this.db.prepare(`SELECT * FROM protocol_blocks WHERE scope = 'project' AND project_id = ?`).all(scope.projectId) as any[]
      : []
    const projectByKey = new Map<string, any>(overrides.map((row) => [row.block_key, row]))
    return PROTOCOL_BLOCK_KEYS.map((key) => {
      const row = projectByKey.get(key) ?? globalByKey.get(key)
      const fallback = !row
      return {
        scope: row?.scope ?? 'global',
        projectId: row?.project_id ?? (scope.scope === 'project' ? scope.projectId : null),
        blockKey: key,
        body: row?.body ?? DEFAULT_PROTOCOL_BLOCKS[key],
        confirmed: Boolean(row?.confirmed),
        updatedBy: row?.updated_by ?? 'system',
        updatedAt: row?.updated_at ?? '',
        source: fallback ? 'default' : row.scope
      }
    })
  }

  save(scope: ProtocolScope, blockKey: ProtocolBlockKey, body: string, actor = 'human', confirmed = true): ProtocolBlock {
    if (!PROTOCOL_BLOCK_KEYS.includes(blockKey)) throw new Error(`未知协作协议区块：${blockKey}`)
    const trimmed = body.trim()
    if (!trimmed) throw new Error('协作协议正文不能为空')
    this.ensureRevisionTable()
    const now = nowVersion()
    const projectId = scope.scope === 'project' ? scope.projectId : null
    const tx = this.db.transaction(() => {
      const current = this.db.prepare(`
        SELECT * FROM protocol_blocks WHERE scope = ? AND project_id IS ? AND block_key = ?
      `).get(scope.scope, projectId, blockKey) as any
      if (current?.body === trimmed && Boolean(current.confirmed) === confirmed) return

      const hasHistory = this.db.prepare(`
        SELECT 1 FROM protocol_revisions WHERE scope = ? AND project_id IS ? AND block_key = ? LIMIT 1
      `).get(scope.scope, projectId, blockKey)
      if (!hasHistory && current) {
        this.insertRevision(
          scope,
          projectId,
          blockKey,
          current.body ?? '',
          Boolean(current.confirmed),
          true,
          current.updated_by ?? actor,
          current.updated_at || now
        )
      }

      if (scope.scope === 'global') {
        const updated = this.db.prepare(`
          UPDATE protocol_blocks SET body = ?, confirmed = ?, updated_by = ?, updated_at = ?
          WHERE scope = 'global' AND project_id IS NULL AND block_key = ?
        `).run(trimmed, confirmed ? 1 : 0, actor, now, blockKey).changes
        if (!updated) {
          this.db.prepare(`
            INSERT INTO protocol_blocks (scope, project_id, block_key, body, confirmed, updated_by, updated_at)
            VALUES ('global', NULL, ?, ?, ?, ?, ?)
          `).run(blockKey, trimmed, confirmed ? 1 : 0, actor, now)
        }
      } else {
        this.db.prepare(`
          INSERT INTO protocol_blocks (scope, project_id, block_key, body, confirmed, updated_by, updated_at)
          VALUES ('project', ?, ?, ?, ?, ?, ?)
          ON CONFLICT(scope, project_id, block_key) DO UPDATE SET
            body = excluded.body, confirmed = excluded.confirmed,
            updated_by = excluded.updated_by, updated_at = excluded.updated_at
        `).run(projectId, blockKey, trimmed, confirmed ? 1 : 0, actor, now)
      }

      this.insertRevision(scope, projectId, blockKey, trimmed, confirmed, true, actor, now)
    })
    tx()
    /**
     * 项目级协作方式变了 → 接手说明该复核（卡 `233cd5f6`）。只标标记，不改正文。
     * 采纳提议也走这里（`decideProposal` 内部调 save），所以两条路都覆盖。
     */
    if (scope.scope === 'project') {
      markHandoffDirty(this.db, scope.projectId, `项目协作协议有更新（${blockKey}）`)
    }
    return this.list(scope).find((item) => item.blockKey === blockKey)!
  }

  private insertRevision(
    scope: ProtocolScope,
    projectId: string | null,
    blockKey: ProtocolBlockKey,
    body: string,
    confirmed: boolean,
    present: boolean,
    actor: string,
    createdAt: string
  ): void {
    this.db.prepare(`
      INSERT INTO protocol_revisions
        (id, scope, project_id, block_key, body, confirmed, present, author, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), scope.scope, projectId, blockKey, body, confirmed ? 1 : 0, present ? 1 : 0, actor, createdAt)
  }

  listRevisions(scope: ProtocolScope, blockKey?: ProtocolBlockKey): ProtocolRevision[] {
    this.ensureRevisionTable()
    const projectId = scope.scope === 'project' ? scope.projectId : null
    if (blockKey) {
      const hasHistory = this.db.prepare(`
        SELECT 1 FROM protocol_revisions WHERE scope = ? AND project_id IS ? AND block_key = ? LIMIT 1
      `).get(scope.scope, projectId, blockKey)
      if (!hasHistory) {
        const current = this.db.prepare(`
          SELECT * FROM protocol_blocks WHERE scope = ? AND project_id IS ? AND block_key = ?
        `).get(scope.scope, projectId, blockKey) as any
        if (current) {
          this.insertRevision(
            scope,
            projectId,
            blockKey,
            current.body ?? '',
            Boolean(current.confirmed),
            true,
            current.updated_by ?? 'system',
            current.updated_at || nowVersion()
          )
        }
      }
    }
    const rows = this.db.prepare(`
      SELECT * FROM protocol_revisions
      WHERE scope = ? AND project_id IS ? ${blockKey ? 'AND block_key = ?' : ''}
      ORDER BY created_at DESC, rowid DESC LIMIT 50
    `).all(...(blockKey ? [scope.scope, projectId, blockKey] : [scope.scope, projectId])) as any[]
    return rows.map((row) => ({
      id: row.id,
      scope: row.scope,
      projectId: row.project_id ?? null,
      blockKey: row.block_key,
      body: row.body,
      confirmed: Boolean(row.confirmed),
      present: Boolean(row.present),
      author: row.author,
      createdAt: row.created_at
    }))
  }

  rollbackRevision(id: string, actor = 'human'): ProtocolBlock {
    this.ensureRevisionTable()
    const row = this.db.prepare('SELECT * FROM protocol_revisions WHERE id = ?').get(id) as any
    if (!row) throw new Error(`协作协议修订不存在：${id}`)
    const scope: ProtocolScope = row.scope === 'project'
      ? { scope: 'project', projectId: row.project_id }
      : { scope: 'global' }
    const blockKey = row.block_key as ProtocolBlockKey
    if (!PROTOCOL_BLOCK_KEYS.includes(blockKey)) {
      throw new Error('该协议修订不属于可回滚范围')
    }
    return this.save(scope, blockKey, row.body, actor, true)
  }

  listProposals(status: 'pending' | 'all' = 'pending'): ProtocolProposal[] {
    const where = status === 'pending' ? "WHERE status = 'pending'" : ''
    // `, id ASC` 是兜底次序键（卡 07015c7e）：同刻提交的提议，顺序不能交给 SQLite 的隐式行为
    return (this.db.prepare(`SELECT * FROM protocol_proposals ${where} ORDER BY created_at ASC, id ASC`).all() as any[]).map((row) => {
      const proposal = toProposal(row)
      const scope: ProtocolScope = proposal.scope === 'project' ? { scope: 'project', projectId: proposal.projectId! } : { scope: 'global' }
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

  propose(scope: ProtocolScope, blockKey: ProtocolBlockKey, body: string, proposer: string): ProtocolProposal {
    if (!PROTOCOL_BLOCK_KEYS.includes(blockKey)) throw new Error(`未知协作协议区块：${blockKey}`)
    const trimmed = body.trim()
    if (!trimmed) throw new Error('协作协议提议不能为空')
    const current = this.list(scope).find((block) => block.blockKey === blockKey)!
    const proposal: ProtocolProposal = {
      id: randomUUID(), scope: scope.scope, projectId: scope.scope === 'project' ? scope.projectId : null,
      blockKey, body: trimmed, originalBody: current.body, baseUpdatedAt: current.updatedAt || '∅',
      decidedBody: null, proposer, status: 'pending', decidedBy: null, decidedAt: null, createdAt: nowVersion()
    }
    this.db.prepare(`INSERT INTO protocol_proposals (id, scope, project_id, block_key, body, original_body, base_updated_at, decided_body, proposer, status, created_at) VALUES (@id,@scope,@projectId,@blockKey,@body,@originalBody,@baseUpdatedAt,NULL,@proposer,@status,@createdAt)`).run(proposal)
    return proposal
  }

  decideProposal(id: string, decision: 'approved' | 'rejected', actor = 'human', editedBody?: string): ProtocolProposal {
    const now = nowVersion()
    const tx = this.db.transaction(() => {
      const row = this.db.prepare(`SELECT * FROM protocol_proposals WHERE id = ?`).get(id) as any
      if (!row) throw new Error(`协作协议提议不存在：${id}`)
      if (row.status !== 'pending') throw new Error('协作协议提议已经处理过')
      const scope: ProtocolScope = row.scope === 'project' ? { scope: 'project', projectId: row.project_id } : { scope: 'global' }
      const proposedBody = (editedBody ?? row.body).trim()
      if (decision === 'approved') {
        if (!proposedBody) throw new Error('采纳后的协作协议正文不能为空')
        const current = this.list(scope).find((block) => block.blockKey === row.block_key)
        if (!row.base_updated_at) throw new Error('这条旧提议未保存当时内容版本，无法安全覆盖；请让 agent 基于当前协议重新提交')
        if ((current?.updatedAt || '∅') !== row.base_updated_at) {
          throw new Error('协作协议在提议后已发生变化，请重新核对当前内容后再处理')
        }
        this.save(scope, row.block_key as ProtocolBlockKey, proposedBody, actor, true)
      }
      const changed = this.db.prepare(`
        UPDATE protocol_proposals SET status = ?, decided_by = ?, decided_at = ?, decided_body = ?
        WHERE id = ? AND status = 'pending'
      `).run(decision, actor, now, decision === 'approved' ? proposedBody : null, id).changes
      if (changed !== 1) throw new Error('协作协议提议已被其他操作处理')
    })
    tx()
    return toProposal(this.db.prepare(`SELECT * FROM protocol_proposals WHERE id = ?`).get(id))
  }
}

export interface ProtocolProposal {
  id: string
  scope: 'global' | 'project'
  projectId: string | null
  blockKey: ProtocolBlockKey
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

export interface ProtocolRevision {
  id: string
  scope: 'global' | 'project'
  projectId: string | null
  blockKey: ProtocolBlockKey
  body: string
  confirmed: boolean
  present: boolean
  author: string
  createdAt: string
}

function toProposal(row: any): ProtocolProposal {
  return {
    id: row.id, scope: row.scope, projectId: row.project_id ?? null, blockKey: row.block_key,
    body: row.body, originalBody: row.original_body ?? null, baseUpdatedAt: row.base_updated_at ?? null,
    decidedBody: row.decided_body ?? null, proposer: row.proposer, status: row.status,
    decidedBy: row.decided_by ?? null, decidedAt: row.decided_at ?? null, createdAt: row.created_at
  }
}

function parseCollaboration(body: string): Partial<Record<ProtocolBlockKey, string>> {
  const sections: Partial<Record<ProtocolBlockKey, string>> = {}
  const matches = [...body.matchAll(/^##\s+(.+)$/gm)]
  for (let index = 0; index < matches.length; index++) {
    const title = matches[index][1].trim()
    const key = Object.entries(COLLABORATION_MAP).find(([prefix]) => title.startsWith(prefix))?.[1]
    if (!key) continue
    const start = (matches[index].index ?? 0) + matches[index][0].length
    const end = matches[index + 1]?.index ?? body.length
    const text = body.slice(start, end).trim()
    if (text) sections[key] = sections[key] ? `${sections[key]}\n\n## ${title}\n\n${text}` : text
  }
  return sections
}
