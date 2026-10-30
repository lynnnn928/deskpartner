import { UsageError, NotFoundError, GuardError, ConflictError } from '../lib/domain-errors'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { v4 as uuidv4 } from 'uuid'
import { getDatabase } from './index'
import type {
  Project,
  ProjectDetail,
  ProjectOverviewItem,
  ProjectSearchResult,
  ProjectSearchPage,
  HandoffRevision,
  HandoffRevisionSummary,
  CreateProjectInput,
  UpdateProjectInput,
  ProjectPurgeResult,
  ProjectDocEntry,
  ProjectDocListResult,
  ProjectDocContent
} from '../../renderer/types/project'

/** 回执类型定义在共享类型里（渲染层也要用），这里转出保持既有引用不断 */
export type { ProjectPurgeResult }
import type { TodoStatus } from '../../renderer/types/enums'
import { nowVersion } from '../lib/version-stamp'
import { DB_VERSION } from '../../renderer/lib/constants'
import {
  clearHandoffDirty,
  coverageOf,
  freshnessOf,
  markHandoffDirty,
  parseFacts,
  readHandoffDirty
} from './handoff-state'
import type { HandoffCoverage, HandoffFacts, HandoffFreshness, HandoffSnapshot } from './handoff-state'

const DEFAULT_PROJECT_COLOR = '#5388F6'

/** 每个项目最多保留多少版接手说明修订（超出删最旧，基线行同样适用） */
export const HANDOFF_REVISION_LIMIT = 50
/** 基线行作者：保存时库里已有说明但从没有修订行（修订历史上线前写的内容） */
export const HANDOFF_BASELINE_AUTHOR = '迁移前'
/** 基线行作者：已有修订，但当前说明与最新一版对不上（绕开仓储层改过列） */
export const HANDOFF_DRIFT_AUTHOR = '未知来源'

export interface HandoffSaveResult {
  project: Project
  /** 这次保存写下的那一版；内容未变化时为 null */
  revision: HandoffRevision | null
  changed: boolean
}

export interface ProjectReadPageOptions {
  /** 返回事项的最大条数；不传表示兼容旧调用的全量读取 */
  limit?: number
  /** 从按 updated_at 倒序结果的第几条开始 */
  offset?: number
}

function revisionPreview(body: string): string {
  const line = body.split(/\r?\n/).find((l) => l.trim() !== '') ?? ''
  const t = line.trim()
  return t.length > 60 ? `${t.slice(0, 60)}…` : t
}

function snippetAround(text: string, query: string): string {
  const lower = text.toLowerCase()
  const index = lower.indexOf(query.toLowerCase())
  const start = Math.max(0, (index < 0 ? 0 : index) - 80)
  const end = Math.min(text.length, (index < 0 ? 0 : index) + query.length + 120)
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`
}

const ensuredProjectDbs = new WeakSet<object>()

/** 项目仓库（顶层容器） */
export class ProjectRepository {
  private get db() {
    const db = getDatabase()
    if (!ensuredProjectDbs.has(db)) {
      try {
        const cols = db.prepare('PRAGMA table_info(projects)').all() as Array<{ name: string }>
        if (cols.length > 0 && !cols.some((c) => c.name === 'docs_dir')) {
          db.exec('ALTER TABLE projects ADD COLUMN docs_dir TEXT;')
        }
        ensuredProjectDbs.add(db)
      } catch {
        /* 仅在 projects 表已存在时幂等补齐 docs_dir 列 */
      }
    }
    return db
  }

  /** 新建项目 */
  create(input: CreateProjectInput): Project {
    const name = input.name.trim()
    if (!name) throw new UsageError('[ProjectRepository] 项目名不能为空')

    /**
     * id / archived / createdAt 可由调用方指定（备份导入），否则取默认。
     *
     * 导入必须能指定 id：待办的 projectId 指向它，id 一换，
     * 那些待办就只能落 null（此前导入后 204 条待办的 projectId 全空的根因之一）。
     * 与 CategoryRepository.create 允许指定 id 是同一个道理。
     */
    const id = input.id?.trim() || uuidv4()
    const project: Project = {
      id,
      name,
      color: input.color ?? DEFAULT_PROJECT_COLOR,
      archived: input.archived ?? false,
      /** 未传时由下面那条写语句按 `MAX(sort_order)+1` 定，随后回读真实值 */
      sortOrder: input.sortOrder ?? 0,
      createdAt: input.createdAt ?? new Date().toISOString(),
      handoffMarkdown: input.handoffMarkdown ?? ''
    }

    /**
     * `sort_order` 不传就取 `MAX+1`（1.0.109，卡 `681528e5`）。
     *
     * 此前默认 `this.list().length` —— 条数不是末尾：归档或删掉一个项目之后条数会退回
     * 已经用过的值，新项目就和别人**撞序**，而 `list()` 正是项目清单（新建事项的候选）的主顺序。
     * 默认值在写语句里算（一条语句内完成，不与并发写打架）；传了值仍照办（备份导入要保住原顺序）。
     */
    const docsDir = input.docsDir?.trim() ? input.docsDir.trim() : null
    this.db
      .prepare(
        `INSERT INTO projects (id, name, color, archived, sort_order, created_at, handoff_markdown, docs_dir)
         VALUES (?, ?, ?, ?, COALESCE(?, (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM projects)), ?, ?, ?)`
      )
      .run(
        project.id,
        project.name,
        project.color,
        project.archived ? 1 : 0,
        input.sortOrder ?? null,
        project.createdAt,
        project.handoffMarkdown,
        docsDir
      )

    /** 回读：排序值可能是数据库算的，不能拿"我以为写了多少"当事实 */
    const saved = this.getById(project.id) ?? project

    // 带着说明建出来的项目（备份导入）：这就是它的第 1 版，之后的覆盖才找得回
    if (saved.handoffMarkdown !== '') {
      this.insertHandoffRevision(saved.id, saved.handoffMarkdown, input.actor ?? 'human', 'save')
    }

    return saved
  }

  /**
   * 更新项目
   *
   * 接手说明（handoffMarkdown）的写入统一经 `writeHandoff`：内容有变化才写，
   * 且同一事务里留下修订 —— 界面、CLI、IPC 共用这一个入口，没有绕开历史的写法。
   */
  update(input: UpdateProjectInput, meta: { version?: string | null } = {}): Project {
    const existing = this.getById(input.id)
    if (!existing) throw new NotFoundError(`[ProjectRepository] 项目不存在: ${input.id}`)

    const updated: Project = {
      ...existing,
      name: input.name?.trim() || existing.name,
      color: input.color ?? existing.color,
      archived: input.archived ?? existing.archived,
      sortOrder: input.sortOrder ?? existing.sortOrder
    }

    const nextDocsDir =
      input.docsDir === undefined
        ? existing.docsDir ?? null
        : input.docsDir?.trim()
          ? input.docsDir.trim()
          : null

    this.db.transaction(() => {
      this.db
        .prepare('UPDATE projects SET name = ?, color = ?, archived = ?, sort_order = ?, docs_dir = ? WHERE id = ?')
        .run(updated.name, updated.color, updated.archived ? 1 : 0, updated.sortOrder, nextDocsDir, updated.id)
      if (input.handoffMarkdown !== undefined) {
        this.writeHandoff(
          updated.id,
          input.handoffMarkdown,
          input.actor ?? 'human',
          'save',
          null,
          undefined,
          meta.version ?? null
        )
      }
    })()

    return this.getById(updated.id) as Project
  }

  // ── 接手说明修订历史（schema v35，36b44adb）──

  /** 保存接手说明（带作者）。内容与当前完全相同则**不写修订也不报错**（changed=false） */
  saveHandoff(
    idOrPrefix: string,
    body: string,
    actor = 'human',
    expectedRevision?: number,
    meta: { version?: string | null } = {}
  ): HandoffSaveResult {
    const id = this.resolveId(idOrPrefix)
    return this.db.transaction(() =>
      this.writeHandoff(id, body, actor, 'save', null, expectedRevision, meta.version ?? null)
    )()
  }

  /**
   * 回滚：把某一版的全文作为**新的一次保存**写回（kind=rollback，留痕），不删任何中间版本。
   * 该版内容已等于当前说明时不写（changed=false）。
   */
  rollbackHandoff(
    idOrPrefix: string,
    revisionRef: string,
    actor = 'human',
    meta: { version?: string | null } = {}
  ): HandoffSaveResult {
    const id = this.resolveId(idOrPrefix)
    return this.db.transaction(() => {
      const source = this.requireHandoffRevision(id, revisionRef)
      return this.writeHandoff(id, source.body, actor, 'rollback', source, undefined, meta.version ?? null)
    })()
  }

  listHandoffProposals(
    status: 'pending' | 'all' = 'pending',
    meta: { version?: string | null } = {}
  ): import('../../renderer/types/project').HandoffProposal[] {
    const where = status === 'pending' ? "WHERE status = 'pending'" : ''
    const factsByProject = new Map<string, HandoffFacts>()
    const getFacts = (projectId: string): HandoffFacts => {
      const hit = factsByProject.get(projectId)
      if (hit) return hit
      const computed = this.buildHandoffFacts(projectId, meta.version ?? null)
      factsByProject.set(projectId, computed)
      return computed
    }
    // `, id ASC` 是兜底次序键（卡 07015c7e）：同刻提交的提议，顺序不能交给 SQLite 的隐式行为
    return (this.db.prepare(`SELECT * FROM project_handoff_proposals ${where} ORDER BY created_at ASC, id ASC`).all() as Array<Record<string, unknown>>).map((row) => {
      const proposal = this.mapHandoffProposal(row)
      const current = this.getById(proposal.projectId)
      const latest = this.latestRevisionSeq(proposal.projectId) ?? 0
      return {
        ...proposal,
        currentBody: current?.handoffMarkdown ?? '',
        currentFacts: current ? getFacts(proposal.projectId) : null,
        stale: latest !== proposal.baseRevision || (current?.handoffMarkdown ?? '') !== proposal.originalBody
      }
    })
  }

  proposeHandoff(
    idOrPrefix: string,
    body: string,
    proposer = 'human',
    meta: { version?: string | null } = {}
  ): import('../../renderer/types/project').HandoffProposal {
    const projectId = this.resolveId(idOrPrefix)
    const project = this.getById(projectId)
    if (!project) throw new NotFoundError(`[ProjectRepository] 项目不存在: ${idOrPrefix}`)
    const trimmed = body.trim()
    if (!trimmed) throw new UsageError('接手说明提议不能为空')
    /**
     * 事实快照与来源事项（卡 `b83f9476`）：复核人要能直接看出"这条提议基于什么"，
     * 不必回查库。快照是**提交那一刻**的，之后事实再变也不改它 —— 那正是"依据"的意义。
     */
    const facts = this.buildHandoffFacts(projectId, meta.version ?? null)
    const proposal = {
      id: uuidv4(), project_id: projectId, body: trimmed, original_body: project.handoffMarkdown,
      base_revision: this.latestRevisionSeq(projectId) ?? 0, decided_body: null, proposer,
      status: 'pending', created_at: new Date().toISOString(),
      facts_snapshot: JSON.stringify(facts),
      source_todo_ids: JSON.stringify(this.topOpenTodoIds(projectId))
    }
    this.db.prepare(`INSERT INTO project_handoff_proposals
      (id, project_id, body, original_body, base_revision, decided_body, proposer, status, created_at, facts_snapshot, source_todo_ids)
      VALUES (@id, @project_id, @body, @original_body, @base_revision, NULL, @proposer, @status, @created_at, @facts_snapshot, @source_todo_ids)`).run(proposal)
    return this.mapHandoffProposal(proposal as unknown as Record<string, unknown>)
  }

  decideHandoffProposal(
    id: string,
    decision: 'approved' | 'rejected',
    actor = 'human',
    editedBody?: string,
    meta: { version?: string | null } = {}
  ): import('../../renderer/types/project').HandoffProposal {
    const tx = this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM project_handoff_proposals WHERE id = ?').get(id) as Record<string, unknown> | undefined
      if (!row) throw new NotFoundError(`接手说明提议不存在：${id}`)
      if (row.status !== 'pending') throw new UsageError('接手说明提议已经处理过')
      const proposal = this.mapHandoffProposal(row)
      const current = this.getById(proposal.projectId)
      const latest = this.latestRevisionSeq(proposal.projectId) ?? 0
      if (decision === 'approved') {
        if (!current || latest !== proposal.baseRevision || current.handoffMarkdown !== proposal.originalBody) {
          throw new ConflictError('接手说明在提议后已发生变化，请重新读取并提交提议')
        }
        const body = (editedBody ?? proposal.body).trim()
        if (!body) throw new UsageError('采纳后的接手说明正文不能为空')
        this.writeHandoff(proposal.projectId, body, actor, 'save', null, proposal.baseRevision, meta.version ?? null)
        this.db.prepare('UPDATE project_handoff_proposals SET status = ?, decided_by = ?, decided_at = ?, decided_body = ? WHERE id = ? AND status = ?')
          .run('approved', actor, new Date().toISOString(), body, id, 'pending')
      } else {
        this.db.prepare('UPDATE project_handoff_proposals SET status = ?, decided_by = ?, decided_at = ? WHERE id = ? AND status = ?')
          .run('rejected', actor, new Date().toISOString(), id, 'pending')
        /**
         * 拒绝 ≠ 事情结束：说明仍是旧的、而库里已经变了。标一条待复核（按项目去重），
         * 让人下次首读看得见 —— 不然"被拒"会静默变成"没人管"。
         */
        markHandoffDirty(this.db, proposal.projectId, `接手说明提议被拒（${new Date().toISOString().slice(0, 10)}）`)
      }
    })
    tx()
    return this.mapHandoffProposal(this.db.prepare('SELECT * FROM project_handoff_proposals WHERE id = ?').get(id) as Record<string, unknown>)
  }

  withdrawHandoffProposal(
    idOrPrefix: string,
    actor: string
  ): import('../../renderer/types/project').HandoffProposal & { withdrawn: boolean } {
    const ref = String(idOrPrefix ?? '').trim()
    if (!ref) throw new UsageError('缺少接手说明提议 id')
    const now = new Date().toISOString()
    let targetId = ''
    const tx = this.db.transaction(() => {
      const rows = this.db
        .prepare('SELECT * FROM project_handoff_proposals WHERE id = ? OR id LIKE ? ORDER BY created_at DESC, id ASC')
        .all(ref, `${ref}%`) as Array<Record<string, unknown>>
      const exact = rows.find((r) => r.id === ref)
      if (!exact && rows.length === 0) throw new NotFoundError(`接手说明提议不存在：${ref}`)
      if (!exact && rows.length > 1) throw new UsageError(`接手说明提议 id 前缀不唯一：${ref}`)
      const row = exact ?? rows[0]
      if (row.proposer !== actor) {
        throw new GuardError(`不能撤回别人提交的接手说明提议（提议人：${String(row.proposer)}，当前身份：${actor}）`)
      }
      if (row.status !== 'pending') {
        throw new GuardError(`不能撤回已处理的接手说明提议（当前状态：${String(row.status)}）`)
      }
      targetId = String(row.id)
      this.db
        .prepare('UPDATE project_handoff_proposals SET status = ?, decided_by = ?, decided_at = ? WHERE id = ? AND status = ?')
        .run('rejected', actor, now, targetId, 'pending')
    })
    tx()
    const mapped = this.mapHandoffProposal(
      this.db.prepare('SELECT * FROM project_handoff_proposals WHERE id = ?').get(targetId) as Record<string, unknown>
    )
    return { ...mapped, withdrawn: true }
  }

  private mapHandoffProposal(row: Record<string, unknown>): import('../../renderer/types/project').HandoffProposal {
    let sourceTodoIds: string[] = []
    if (typeof row.source_todo_ids === 'string' && row.source_todo_ids.trim()) {
      try {
        const parsed = JSON.parse(row.source_todo_ids) as unknown
        if (Array.isArray(parsed)) sourceTodoIds = parsed.filter((x): x is string => typeof x === 'string')
      } catch {
        /* 坏数据当"没有来源" —— 不抛错，界面照样能看正文 */
      }
    }
    const withdrawn = row.status === 'rejected' && Boolean(row.decided_by) && row.decided_by === row.proposer
    return {
      id: row.id as string, projectId: row.project_id as string, body: row.body as string,
      originalBody: (row.original_body as string) ?? '', baseRevision: row.base_revision as number,
      decidedBody: (row.decided_body as string | null) ?? null, proposer: row.proposer as string,
      status: row.status as 'pending' | 'approved' | 'rejected', decidedBy: (row.decided_by as string | null) ?? null,
      decidedAt: (row.decided_at as string | null) ?? null, createdAt: row.created_at as string,
      factsSnapshot: parseFacts(row.facts_snapshot),
      sourceTodoIds,
      ...(withdrawn ? { withdrawn: true } : {})
    }
  }

  /** 修订列表（最新在前；limit 缺省 = 全部，最多 50 版）。含全文，给界面做差异用 */
  listHandoffRevisions(idOrPrefix: string, limit?: number): HandoffRevision[] {
    const id = this.resolveId(idOrPrefix)
    const capped = limit && limit > 0 ? Math.floor(limit) : null
    const rows = (
      capped === null
        ? this.db
            .prepare('SELECT * FROM project_handoff_revisions WHERE project_id = ? ORDER BY seq DESC')
            .all(id)
        : this.db
            .prepare(
              'SELECT * FROM project_handoff_revisions WHERE project_id = ? ORDER BY seq DESC LIMIT ?'
            )
            .all(id, capped)
    ) as Array<Record<string, unknown>>
    const latestSeq = this.latestRevisionSeq(id)
    return rows.map((r) => this.mapRevision(r, latestSeq))
  }

  /** 修订摘要（不带全文）：CLI 列表用，避免一次吐 50 份全文 */
  listHandoffRevisionSummaries(idOrPrefix: string, limit?: number): HandoffRevisionSummary[] {
    return this.listHandoffRevisions(idOrPrefix, limit).map(({ body, ...rest }) => ({
      ...rest,
      length: body.length,
      preview: revisionPreview(body)
    }))
  }

  /** 取某一版（全文）。ref：修订 id / id 前缀 / 序号（`3` 或 `#3`）；找不到返回 null */
  getHandoffRevision(idOrPrefix: string, revisionRef: string): HandoffRevision | null {
    const id = this.resolveId(idOrPrefix)
    return this.findHandoffRevision(id, revisionRef)
  }

  countHandoffRevisions(projectId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM project_handoff_revisions WHERE project_id = ?')
      .get(projectId) as { n: number }
    return row.n
  }

  /**
   * 自动事实（v47，卡 `e2a06fd7`）：版本 / schema / 事项计数 / 当前主线。
   *
   * 判据：**运行时可算的一律现算，不落库当判断** —— 落库就会过期，
   * 而过期没人发现正是这张卡要治的病。
   */
  buildHandoffFacts(projectId: string, version: string | null = null): HandoffFacts {
    const statusCounts: Record<TodoStatus, number> = {
      proposed: 0,
      todo: 0,
      in_progress: 0,
      suspended: 0,
      awaiting_review: 0,
      done: 0,
      discarded: 0
    }
    const rows = this.db
      .prepare('SELECT status, COUNT(*) AS n FROM todos WHERE project_id = ? GROUP BY status')
      .all(projectId) as Array<{ status: TodoStatus; n: number }>
    for (const row of rows) {
      if (Object.prototype.hasOwnProperty.call(statusCounts, row.status)) {
        statusCounts[row.status] = row.n
      }
    }
    const openTotal =
      statusCounts.proposed +
      statusCounts.todo +
      statusCounts.in_progress +
      statusCounts.suspended +
      statusCounts.awaiting_review

    /**
     * 当前主线 = 未完成里"最该被接的那一条"：进行中优先，其次待验收、待办、待确认；
     * 同状态按优先级、最近改动、id。**派生而不是新增可写字段** —— 没人会去填一个
     * "主任务"下拉框，而派生规则每次都能给出同一个答案。
     */
    const mainRow = this.db
      .prepare(
        `SELECT id, title, status, updated_at FROM todos
          WHERE project_id = ? AND status IN ('in_progress', 'awaiting_review', 'todo', 'proposed')
          ORDER BY CASE status
                     WHEN 'in_progress' THEN 0 WHEN 'awaiting_review' THEN 1
                     WHEN 'todo' THEN 2 ELSE 3 END,
                   CASE priority
                     WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
                   updated_at DESC, id ASC
          LIMIT 1`
      )
      .get(projectId) as
      | { id: string; title: string; status: TodoStatus; updated_at: string }
      | undefined

    return {
      version,
      schemaVersion: DB_VERSION,
      statusCounts,
      openTotal,
      mainTodo: mainRow
        ? { id: mainRow.id, title: mainRow.title, status: mainRow.status, updatedAt: mainRow.updated_at }
        : null
    }
  }

  /** 提议里"依据事项"：当前主线优先，再补前几条未完成的（最多 5 条） */
  private topOpenTodoIds(projectId: string, limit = 5): string[] {
    const rows = this.db
      .prepare(
        `SELECT id FROM todos
          WHERE project_id = ? AND status IN ('in_progress', 'awaiting_review', 'todo', 'proposed')
          ORDER BY CASE status
                     WHEN 'in_progress' THEN 0 WHEN 'awaiting_review' THEN 1
                     WHEN 'todo' THEN 2 ELSE 3 END,
                   CASE priority
                     WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
                   updated_at DESC, id ASC
          LIMIT ?`
      )
      .all(projectId, limit) as Array<{ id: string }>
    return rows.map((r) => r.id)
  }

  /**
   * 首读用的接手状态（卡 `e2a06fd7` / `caa0d1c1`）：
   * 实时事实 + 最近一版说明的覆盖声明 + 新鲜度判定。**只读**，不改任何东西。
   */
  getHandoffState(
    idOrPrefix: string,
    opts: { version?: string | null } = {}
  ): {
    facts: HandoffFacts
    handoff: {
      revisionSeq: number | null
      savedAt: string | null
      confirmedBy: string | null
      coverage: HandoffCoverage | null
      bodyBytes: number
    }
    freshness: HandoffFreshness
  } {
    const projectId = this.resolveId(idOrPrefix)
    const project = this.getById(projectId)
    if (!project) throw new NotFoundError(`[ProjectRepository] 项目不存在: ${idOrPrefix}`)
    const facts = this.buildHandoffFacts(projectId, opts.version ?? null)
    const row = this.db
      .prepare(
        `SELECT seq, created_at, confirmed_by, facts_snapshot
           FROM project_handoff_revisions
          WHERE project_id = ?
          ORDER BY seq DESC LIMIT 1`
      )
      .get(projectId) as
      | { seq: number; created_at: string; confirmed_by: string | null; facts_snapshot: string | null }
      | undefined
    const snapshotFacts = row ? parseFacts(row.facts_snapshot) : null
    const snapshot: HandoffSnapshot | null =
      row && snapshotFacts
        ? { facts: snapshotFacts, savedAt: row.created_at, confirmedBy: row.confirmed_by ?? null }
        : null
    const freshness = freshnessOf({
      body: project.handoffMarkdown,
      snapshot,
      dirty: readHandoffDirty(this.db, projectId),
      current: facts
    })
    return {
      facts,
      handoff: {
        revisionSeq: row?.seq ?? null,
        savedAt: row?.created_at ?? null,
        confirmedBy: row?.confirmed_by ?? null,
        coverage: coverageOf(snapshot),
        bodyBytes: Buffer.byteLength(project.handoffMarkdown, 'utf8')
      },
      freshness
    }
  }

  private latestRevisionSeq(projectId: string): number | null {
    const row = this.db
      .prepare('SELECT MAX(seq) AS m FROM project_handoff_revisions WHERE project_id = ?')
      .get(projectId) as { m: number | null }
    return row.m
  }

  private requireHandoffRevision(projectId: string, ref: string): HandoffRevision {
    const hit = this.findHandoffRevision(projectId, ref)
    if (!hit) {
      const seqs = this.db
        .prepare('SELECT seq FROM project_handoff_revisions WHERE project_id = ? ORDER BY seq DESC')
        .all(projectId) as Array<{ seq: number }>
      throw new NotFoundError(
        `[ProjectRepository] 接手说明修订不存在: ${ref}。` +
          (seqs.length ? `现有序号：${seqs.map((r) => `#${r.seq}`).join(' ')}` : '该项目还没有任何修订')
      )
    }
    return hit
  }

  /**
   * 解析修订引用：`#3` / 6 位以内纯数字按项目内序号；其余按 id 或 id 前缀（须唯一）。
   * 6 位以内的纯数字不会和 uuid 前缀混淆（前缀习惯取 8 位）。
   */
  private findHandoffRevision(projectId: string, ref: string): HandoffRevision | null {
    const raw = ref.trim()
    if (!raw) return null
    const latestSeq = this.latestRevisionSeq(projectId)
    const seqMatch = /^#?(\d{1,6})$/.exec(raw)
    if (seqMatch) {
      const row = this.db
        .prepare('SELECT * FROM project_handoff_revisions WHERE project_id = ? AND seq = ?')
        .get(projectId, Number(seqMatch[1])) as Record<string, unknown> | undefined
      return row ? this.mapRevision(row, latestSeq) : null
    }
    // instr 做字面前缀匹配，避免 LIKE 通配符改变输入语义
    const rows = this.db
      .prepare(
        'SELECT * FROM project_handoff_revisions WHERE project_id = ? AND instr(id, ?) = 1 LIMIT 2'
      )
      .all(projectId, raw) as Array<Record<string, unknown>>
    const exact = rows.find((r) => r.id === raw)
    if (exact) return this.mapRevision(exact, latestSeq)
    if (rows.length > 1) {
      throw new UsageError(`[ProjectRepository] 修订 id 前缀 "${raw}" 匹配到多个版本，请写更长一些`)
    }
    return rows[0] ? this.mapRevision(rows[0], latestSeq) : null
  }

  /**
   * 接手说明唯一写入口（须在事务内调用）。
   *
   * 1. 内容与当前相同 → 什么都不写；
   * 2. 库里有说明、却没有与之对应的最新一版（修订历史上线前写的 / 绕开仓储层改的）
   *    → 先把**被覆盖的旧内容存成基线行**，否则这一版永远找不回；
   * 3. 写入新一版（save / rollback），更新当前列；
   * 4. 只留最近 HANDOFF_REVISION_LIMIT 版，超出删最旧。
   */
  private writeHandoff(
    projectId: string,
    body: string,
    actor: string,
    kind: 'save' | 'rollback',
    source: HandoffRevision | null,
    expectedRevision?: number,
    version: string | null = null
  ): HandoffSaveResult {
    const current = this.getById(projectId)
    if (!current) throw new NotFoundError(`[ProjectRepository] 项目不存在: ${projectId}`)
    if (expectedRevision !== undefined) {
      const latestRevision = this.latestRevisionSeq(projectId) ?? 0
      if (latestRevision !== expectedRevision) {
        throw new ConflictError(
          `接手说明在读取后已发生变化（当前修订 ${latestRevision}，提交基准 ${expectedRevision}），请重新读取后再提交`
        )
      }
    }
    if (body === current.handoffMarkdown) {
      return { project: current, revision: null, changed: false }
    }

    if (current.handoffMarkdown !== '') {
      const latest = this.db
        .prepare(
          'SELECT body FROM project_handoff_revisions WHERE project_id = ? ORDER BY seq DESC LIMIT 1'
        )
        .get(projectId) as { body: string } | undefined
      if (!latest) {
        this.insertHandoffRevision(projectId, current.handoffMarkdown, HANDOFF_BASELINE_AUTHOR, 'save')
      } else if (latest.body !== current.handoffMarkdown) {
        this.insertHandoffRevision(projectId, current.handoffMarkdown, HANDOFF_DRIFT_AUTHOR, 'save')
      }
    }

    /**
     * 保存那一刻的自动事实（v47）：这一版说明从此自称"覆盖于这些事实"。
     * 版本由调用方传（主进程拿得到 `app.getVersion()`，仓储层不猜）。
     */
    const facts = this.buildHandoffFacts(projectId, version)
    this.db.prepare('UPDATE projects SET handoff_markdown = ? WHERE id = ?').run(body, projectId)
    const revision = this.insertHandoffRevision(projectId, body, actor, kind, source, facts, actor)
    // 内容已是人看过的新版：待复核标记随之清掉（不清就会一直亮着）
    clearHandoffDirty(this.db, projectId)
    this.pruneHandoffRevisions(projectId)
    return { project: this.getById(projectId) as Project, revision, changed: true }
  }

  private insertHandoffRevision(
    projectId: string,
    body: string,
    author: string,
    kind: 'save' | 'rollback',
    source: HandoffRevision | null = null,
    facts: HandoffFacts | null = null,
    confirmedBy: string | null = null
  ): HandoffRevision {
    const seq = (this.latestRevisionSeq(projectId) ?? 0) + 1
    const row = {
      id: uuidv4(),
      project_id: projectId,
      seq,
      body,
      author,
      kind,
      source_revision_id: source?.id ?? null,
      source_seq: source?.seq ?? null,
      created_at: new Date().toISOString(),
      coverage_version: facts?.version ?? null,
      coverage_schema: facts?.schemaVersion ?? null,
      facts_snapshot: facts ? JSON.stringify(facts) : null,
      confirmed_by: confirmedBy ?? author
    }
    this.db
      .prepare(
        `INSERT INTO project_handoff_revisions
           (id, project_id, seq, body, author, kind, source_revision_id, source_seq, created_at,
            coverage_version, coverage_schema, facts_snapshot, confirmed_by)
         VALUES (@id, @project_id, @seq, @body, @author, @kind, @source_revision_id, @source_seq, @created_at,
                 @coverage_version, @coverage_schema, @facts_snapshot, @confirmed_by)`
      )
      .run(row)
    return this.mapRevision(row, seq)
  }

  private pruneHandoffRevisions(projectId: string): void {
    const latest = this.latestRevisionSeq(projectId)
    if (latest === null) return
    this.db
      .prepare('DELETE FROM project_handoff_revisions WHERE project_id = ? AND seq <= ?')
      .run(projectId, latest - HANDOFF_REVISION_LIMIT)
  }

  private mapRevision(row: Record<string, unknown>, latestSeq: number | null): HandoffRevision {
    return {
      id: row.id as string,
      projectId: row.project_id as string,
      seq: row.seq as number,
      body: row.body as string,
      author: row.author as string,
      kind: row.kind as 'save' | 'rollback',
      sourceRevisionId: (row.source_revision_id as string | null) ?? null,
      sourceSeq: (row.source_seq as number | null) ?? null,
      createdAt: row.created_at as string,
      isCurrent: latestSeq !== null && (row.seq as number) === latestSeq,
      confirmedBy: (row.confirmed_by as string | null) ?? null
    }
  }

  /**
   * 永久删除项目：**在一个事务里**把它拥有的东西全清掉（卡 `c177e466`，2026-10-09 已定口径）
   *
   * ## 口径（主用户 2026-10-09 拍板，原话见卡上的"已定口径"）
   *
   * 界面**优先建议归档**；若坚持永久删除，就**清空整个项目数据，不保留**。
   * 所以这里没有"迁到别的项目"这条路 —— 那条路是旧实现（"先迁走再删"），
   * 它的默认落点让"不选承接项目也能删"，而且会把事项的 project_id 置空，
   * 与"事项必须归项目"这条数据层约束冲突（主用户 2026-10-22 复核时又提了一次）。
   *
   * ## 为什么自己逐个表删，而不是靠外键 CASCADE
   *
   * 真库的外键关系（`PRAGMA foreign_key_list` 实测，2026-10-22 核过）分三类：
   *
   * | 关系 | 实测 |
   * |---|---|
   * | 13 张项目级表（releases / 协作规则 / 权限矩阵 / 接手说明与提议 / 档案与协议块…） | `project_id → projects.id ON DELETE CASCADE` |
   * | 事项的子表（`todo_comments` / `todo_categories`） | `todo_id → todos.id ON DELETE CASCADE` |
   * | `todos.project_id` | `ON DELETE SET NULL` —— **正是"事项掉进无项目状态"的来源** |
   * | `todo_transitions` | **没有外键** —— 级联删不掉，只能自己删 |
   *
   * 外键在生产里是开的（`index.ts` 的 `foreign_keys = ON`），但**单测里常常关着** ——
   * 两级级联在这种情况下会静默失效，于是"清零了"只是看着像。逐个表显式删有两个好处：
   * 不依赖那个开关（结果确定），以及回执能**逐表报数**（"清了多少条"是可核对的事实）。
   *
   * ⚠️ 通知（`notifications.ref_id`）**不是外键**，指向已删事项的通知会悬空 ——
   * 这里一并清掉，并在墓碑里记数：留着指向不存在卡片的通知，只会让收件箱点进去是空的。
   *
   * ## 留痕
   *
   * 与 `TodoRepository.delete` 同源：删之前往 `events` 写一条 `project_deleted` 墓碑
   * （项目名 + 逐表条数）。删项目是这个应用里破坏面最大的动作，事后要能回答"删了什么"。
   */
  delete(idOrPrefix: string): ProjectPurgeResult {
    const id = this.resolveId(idOrPrefix)
    const project = this.getById(id)
    if (!project) throw new NotFoundError(`[ProjectRepository] 项目不存在: ${idOrPrefix}`)

    /**
     * 至少保留一个项目：删掉最后一个，`todo add` 就没有项目可选了
     * （`--project` 是必填，1.0.40 起不存在的项目名会报错而不是静默新建）。
     * 归档不受这条限制 —— 归档后项目还在，只是不进候选（`listActive`）。
     */
    if (this.list().length <= 1) {
      throw new GuardError(
        '[ProjectRepository] 这是本机最后一个项目，删掉它事项就无处可归（--project 是必填项）。\n' +
          '  两个办法：①改用归档（`project archive <id>`，可逆、数据都在）；②先新建一个项目再删。'
      )
    }

    const todoIds = (
      this.db.prepare('SELECT id FROM todos WHERE project_id = ?').all(id) as { id: string }[]
    ).map((r) => r.id)
    const marks = todoIds.map(() => '?').join(',')

    return this.db.transaction(() => {
      const removed: ProjectPurgeResult['removed'] = {
        todos: 0,
        comments: 0,
        transitions: 0,
        todoCategories: 0,
        notifications: 0,
        releases: 0,
        handoffRevisions: 0,
        handoffProposals: 0,
        collaborationRules: 0,
        permissionMatrix: 0,
        profileBlocks: 0,
        profileProposals: 0,
        profileRevisions: 0,
        protocolBlocks: 0,
        protocolProposals: 0,
        ruleProposals: 0,
        ruleRevisions: 0
      }

      const del = (key: keyof ProjectPurgeResult['removed'], sql: string, params: unknown[]) => {
        removed[key] = this.db.prepare(sql).run(...(params as never[])).changes
      }
      const byProject = (table: string) => `DELETE FROM ${table} WHERE project_id = ?`

      /**
       * 先写墓碑再删：万一事务回滚，墓碑也跟着回滚（它记的是"真的删掉了什么"，
       * 不该在没删成的时候留下一条）。所以顺序是"算数 → 删 → 最后写墓碑"，
       * 这里先把数算出来，写在同一个事务的末尾。
       */
      if (todoIds.length) {
        del('comments', `DELETE FROM todo_comments WHERE todo_id IN (${marks})`, todoIds)
        del('transitions', `DELETE FROM todo_transitions WHERE todo_id IN (${marks})`, todoIds)
        del('todoCategories', `DELETE FROM todo_categories WHERE todo_id IN (${marks})`, todoIds)
        del('notifications', `DELETE FROM notifications WHERE ref_id IN (${marks})`, todoIds)
        del('todos', `DELETE FROM todos WHERE project_id = ?`, [id])
      }
      del('releases', byProject('releases'), [id])
      del('handoffRevisions', byProject('project_handoff_revisions'), [id])
      del('handoffProposals', byProject('project_handoff_proposals'), [id])
      del('collaborationRules', byProject('collaboration_rules'), [id])
      del('permissionMatrix', byProject('permission_matrix'), [id])
      del('profileBlocks', byProject('profile_blocks'), [id])
      del('profileProposals', byProject('profile_proposals'), [id])
      del('profileRevisions', byProject('profile_revisions'), [id])
      del('protocolBlocks', byProject('protocol_blocks'), [id])
      del('protocolProposals', byProject('protocol_proposals'), [id])
      del('ruleProposals', byProject('rule_proposals'), [id])
      del('ruleRevisions', byProject('rule_revisions'), [id])
      this.db.prepare('DELETE FROM projects WHERE id = ?').run(id)

      this.db
        .prepare('INSERT INTO events (type, actor, payload, created_at) VALUES (?, ?, ?, ?)')
        .run(
          'project_deleted',
          'unknown',
          JSON.stringify({ projectId: id, projectName: project.name, removed }),
          new Date().toISOString()
        )

      return { projectId: id, projectName: project.name, removed }
    })()
  }


  /**
   * 全部项目（含已归档）
   *
   * `, id ASC` 是兜底次序键（1.0.109，卡 `681528e5`）：`sort_order` 撞值的行
   * 历史库里已经存在（来源是 `create` 修掉的那个"条数"默认值），读的这一侧要有定数。
   */
  list(): Project[] {
    const rows = this.db
      .prepare('SELECT * FROM projects ORDER BY archived ASC, sort_order ASC, id ASC')
      .all() as Record<string, unknown>[]
    return rows.map(this.mapRow)
  }

  /** 未归档的项目——新建事项时的候选 */
  listActive(): Project[] {
    return this.list().filter((p) => !p.archived)
  }

  getById(id: string): Project | null {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined
    return row ? this.mapRow(row) : null
  }

  /** 项目详情：Markdown 是可编辑的静态背景，概览完全从当前事项表计算。 */
  getDetail(id: string, options: ProjectReadPageOptions = {}): ProjectDetail | null {
    const project = this.getById(id)
    if (!project) return null

    const statusCounts: Record<TodoStatus, number> = {
      proposed: 0,
      todo: 0,
      in_progress: 0,
      suspended: 0,
      awaiting_review: 0,
      done: 0,
      discarded: 0
    }
    const counts = this.db
      .prepare('SELECT status, COUNT(*) AS n FROM todos WHERE project_id = ? GROUP BY status')
      .all(id) as Array<{ status: TodoStatus; n: number }>
    for (const row of counts) {
      if (Object.prototype.hasOwnProperty.call(statusCounts, row.status)) {
        statusCounts[row.status] = row.n
      }
    }

    const totalRow = this.db
      .prepare('SELECT COUNT(*) AS n FROM todos WHERE project_id = ?')
      .get(id) as { n: number }
    const total = totalRow.n
    /**
     * `0` = 不做条数收窄（同 `searchPage`，1.0.107 修 `8d78af0d`）：与"没传"同义。
     * 从前 `limit: 0` 会走到下面的 `Math.max(1, …)` —— `project get` 是 CLI 侧
     * 刻意不把 0 传下来才没暴露；在这里定死，免得下一个人再踩。
     */
    const hasLimit = options.limit !== undefined && options.limit > 0
    const limit = hasLimit ? Math.max(1, Math.floor(options.limit as number)) : undefined
    const offset = Math.max(0, Math.floor(options.offset ?? 0))
    const sql = `SELECT id, title, status, created_by, executed_by, verifier, updated_at
           FROM todos
          WHERE project_id = ?
          ORDER BY updated_at DESC, id ASC${hasLimit ? ' LIMIT ? OFFSET ?' : ''}`
    const rows = (hasLimit
      ? this.db.prepare(sql).all(id, limit, offset)
      : this.db.prepare(sql).all(id)) as Array<Record<string, unknown>>
    const items: ProjectOverviewItem[] = rows.map((row) => ({
      id: row.id as string,
      title: row.title as string,
      status: row.status as TodoStatus,
      executedBy: (row.executed_by as string | null) ?? (row.created_by as string),
      verifier: (row.verifier as string | null) ?? '',
      updatedAt: row.updated_at as string
    }))
    const truncated = hasLimit ? offset + items.length < total : false

    return {
      project,
      overview: {
        total,
        statusCounts,
        items,
        returned: items.length,
        truncated,
        nextOffset: truncated ? offset + items.length : null
      },
      handoffRevisionCount: this.countHandoffRevisions(id)
    }
  }

  /**
   * 在一个项目内搜索说明、事项标题/描述与评论正文。
   * 用 instr 做字面子串匹配，避免 LIKE 的 % / _ 通配符改变用户输入语义。
   * 不按状态过滤；done / suspended / discarded 同样是可找回的历史。
   */
  search(projectId: string, rawQuery: string): ProjectSearchResult[] {
    const project = this.getById(projectId)
    if (!project) throw new NotFoundError(`[ProjectRepository] 项目不存在: ${projectId}`)
    const query = rawQuery.trim()
    if (!query) throw new UsageError('[ProjectRepository] 搜索关键字不能为空')

    const results: ProjectSearchResult[] = []
    const docMatch = this.db
      .prepare(
        'SELECT handoff_markdown FROM projects WHERE id = ? AND instr(lower(handoff_markdown), lower(?)) > 0'
      )
      .get(projectId, query) as { handoff_markdown: string } | undefined
    if (docMatch) {
      results.push({
        source: 'handoff_markdown',
        snippet: snippetAround(docMatch.handoff_markdown, query)
      })
    }

    const titleRows = this.db
      .prepare(
        `SELECT id, title, status FROM todos
          WHERE project_id = ? AND instr(lower(title), lower(?)) > 0
          ORDER BY updated_at DESC, id ASC`
      )
      .all(projectId, query) as Array<Record<string, unknown>>
    for (const row of titleRows) {
      results.push({
        source: 'todo_title',
        snippet: snippetAround(row.title as string, query),
        todoId: row.id as string,
        todoTitle: row.title as string,
        todoStatus: row.status as TodoStatus
      })
    }

    const descriptionRows = this.db
      .prepare(
        `SELECT id, title, status, description FROM todos
          WHERE project_id = ? AND description IS NOT NULL
            AND instr(lower(description), lower(?)) > 0
          ORDER BY updated_at DESC, id ASC`
      )
      .all(projectId, query) as Array<Record<string, unknown>>
    for (const row of descriptionRows) {
      results.push({
        source: 'todo_description',
        snippet: snippetAround(row.description as string, query),
        todoId: row.id as string,
        todoTitle: row.title as string,
        todoStatus: row.status as TodoStatus
      })
    }

    const commentRows = this.db
      .prepare(
        `SELECT c.id AS comment_id, c.body, c.author_type, c.author_id, c.created_at,
                t.id AS todo_id, t.title AS todo_title, t.status AS todo_status
           FROM todo_comments c
           JOIN todos t ON t.id = c.todo_id
          WHERE t.project_id = ? AND instr(lower(c.body), lower(?)) > 0
          ORDER BY c.created_at DESC, c.id ASC`
      )
      .all(projectId, query) as Array<Record<string, unknown>>
    for (const row of commentRows) {
      results.push({
        source: 'comment',
        snippet: snippetAround(row.body as string, query),
        todoId: row.todo_id as string,
        todoTitle: row.todo_title as string,
        todoStatus: row.todo_status as TodoStatus,
        commentId: row.comment_id as string,
        author: (row.author_id as string | null) ?? (row.author_type as string),
        authorType: row.author_type as 'human' | 'agent' | 'system',
        createdAt: row.created_at as string
      })
    }
    return results
  }

  /**
   * 有界项目搜索。底层搜索保持旧的完整仓储口径以兼容 GUI，CLI/MCP 通过此页接口
   * 明确返回数量和下一页偏移；调用方不会把截断结果误当成全量。
   */
  searchPage(projectId: string, rawQuery: string, options: ProjectReadPageOptions = {}): ProjectSearchPage {
    const all = this.search(projectId, rawQuery)
    /**
     * `--limit 0` = 不做条数收窄（1.0.107，修 `8d78af0d`）。
     *
     * 这里原来是 `Math.max(1, …)` —— 传 0 会被**静默夹成 1 条**：调用方按说明书
     * 传 `--limit 0` 想拿全量，实际只拿到 1 条，而回执里 `matched: 195` 与
     * `returned: 1` 并排出现，看着像"就筛出一条"（`8d78af0d` 报的就是它）。
     */
    const limit = options.limit === undefined ? 20 : Math.max(0, Math.floor(options.limit))
    const offset = Math.max(0, Math.floor(options.offset ?? 0))
    const results = limit === 0 ? all.slice(offset) : all.slice(offset, offset + limit)
    const truncated = offset + results.length < all.length
    return {
      results,
      matched: all.length,
      returned: results.length,
      truncated,
      nextOffset: truncated ? offset + results.length : null
    }
  }

  /**
   * 跨项目搜索。单项目搜索仍复用同一套仓储口径，结果补充项目名称，
   * 这样搜索页不需要在渲染层复制查询逻辑。
   */
  searchMany(rawQuery: string, projectIds?: string[]): ProjectSearchResult[] {
    const ids = projectIds ?? this.list().map((project) => project.id)
    const projects = new Map(this.list().map((project) => [project.id, project.name]))
    return ids.flatMap((id) =>
      this.search(id, rawQuery).map((result) => ({
        ...result,
        projectId: id,
        projectName: projects.get(id)
      }))
    )
  }

  /**
   * 按 id、id 前缀或项目名查项目
   *
   * 支持短 id 是因为：CLI 输出里 id 是 36 位全串，而 agent 回传、
   * 人手敲的时候几乎总是截取前 8 位。要么支持前缀，要么每次都得先
   * `project list` 拿全串再复制 —— 多一次往返还容易粘错。
   *
   * 前缀撞到多个（截太短）时抛错而不是随便挑一个：宁可让调用方重来，
   * 也不能默默删错项目。名字同理（见下面「也接受项目名」那段）。
   */
  resolveId(idOrPrefix: string): string {
    const raw = idOrPrefix.trim()
    const hit = this.getById(raw)
    if (hit) return hit.id

    const all = this.list()
    const byIdPrefix = all.filter((p) => p.id.startsWith(raw))
    if (byIdPrefix.length === 1) return byIdPrefix[0].id
    if (byIdPrefix.length > 1) {
      throw new UsageError(
        `[ProjectRepository] id 前缀 "${raw}" 匹配到 ${byIdPrefix.length} 个项目，请写更长一些`
      )
    }

    /**
     * 🚨 **也接受项目名**（1.0.65 修 `749e09df`）：`project rm --to` 的参数说明
     * 一直写着「名字或 id 前缀」，但这里只认 id —— 于是照文档传名字必然抛
     * 「项目不存在」。它最难受的地方在于**批准即执行会放大**：
     * agent 申请时人只看到「project rm「X」」就点了允许，回放时才炸，
     * 结果是"人批了、系统啥也没删、那条授权还已被记成用过"。
     * 命令说明与实现对不上，等于把故障推迟到最贵的那一刻才暴露。
     *
     * 顺序：完整 id → id 前缀 → **完整名** → 名字前缀（唯一命中时）。
     * 名字精确匹配必须排在名字前缀前面，否则「测试」这种短名会误吃掉
     * 「测试项目B」—— 而那正是要迁事项的目标项目，选错等于把数据搬错地方。
     */
    if (raw) {
      const byName = all.filter((p) => p.name === raw)
      if (byName.length === 1) return byName[0].id
      if (byName.length > 1) {
        throw new UsageError(
          `[ProjectRepository] 项目名 "${raw}" 匹配到 ${byName.length} 个项目，请写完整一些`
        )
      }

      const byNamePrefix = all.filter((p) => p.name.startsWith(raw))
      if (byNamePrefix.length === 1) return byNamePrefix[0].id
      if (byNamePrefix.length > 1) {
        throw new UsageError(
          `[ProjectRepository] 项目名前缀 "${raw}" 匹配到 ${byNamePrefix.length} 个项目，请写完整一些`
        )
      }
    }

    const available = all.map((p) => p.name).join('、') || '（暂无项目）'
    throw new NotFoundError(`[ProjectRepository] 项目不存在: ${raw}。已有项目：${available}`)
  }

  /**
   * 列出项目关联本地文档目录下的 .md 文件（方案 C：只读索引与跳转，卡 a3bd40d8 / 095b2006）
   */
  listProjectDocs(idOrPrefix: string): ProjectDocListResult {
    const projectId = this.resolveId(idOrPrefix)
    const project = this.getById(projectId)
    if (!project) throw new NotFoundError(`[ProjectRepository] 项目不存在: ${idOrPrefix}`)
    const docsDir = project.docsDir?.trim() ? path.resolve(project.docsDir.trim()) : null
    if (!docsDir) {
      return { projectId: project.id, projectName: project.name, docsDir: null, available: false, docs: [] }
    }
    let available = false
    try {
      available = fs.existsSync(docsDir) && fs.statSync(docsDir).isDirectory()
    } catch {
      available = false
    }
    if (!available) {
      return { projectId: project.id, projectName: project.name, docsDir, available: false, docs: [] }
    }

    const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'coverage', 'build'])
    const docs: ProjectDocEntry[] = []

    const walk = (dir: string, depth: number): void => {
      if (depth > 4 || docs.length >= 200) return
      let entries: fs.Dirent[] = []
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (docs.length >= 200) break
        if (entry.name.startsWith('.')) continue
        const abs = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          if (IGNORED_DIRS.has(entry.name)) continue
          walk(abs, depth + 1)
        } else if (entry.isFile() && /\.(md|html?)$/i.test(entry.name)) {
          try {
            const stat = fs.statSync(abs)
            if (stat.size > 2 * 1024 * 1024) continue
            const buf = fs.readFileSync(abs)
            const text = buf.toString('utf8')
            const isHtml = /\.html?$/i.test(entry.name)
            const kind: 'md' | 'html' = isHtml ? 'html' : 'md'
            let title = ''
            if (isHtml) {
              const titleMatch =
                text.match(/<title[^>]*>([\s\S]*?)<\/title>/i) ??
                text.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)
              if (titleMatch?.[1]) {
                title = titleMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
              }
            } else {
              const headingMatch = text.split(/\r?\n/).find((l) => /^#\s+.+/.test(l.trim()))
              if (headingMatch) {
                title = headingMatch.trim().replace(/^#+\s+/, '').trim()
              }
            }
            if (!title) {
              title = path.basename(entry.name, path.extname(entry.name))
            }
            const rel = path.relative(docsDir, abs).replace(/\\/g, '/')
            docs.push({
              file: rel,
              name: entry.name,
              kind,
              title,
              bytes: buf.length,
              updatedAt: stat.mtime.toISOString(),
              sha256: createHash('sha256').update(buf).digest('hex')
            })
          } catch {
            /* 跳过无法读取的单文件 */
          }
        }
      }
    }

    walk(docsDir, 0)
    docs.sort((a, b) => a.file.localeCompare(b.file))
    return {
      projectId: project.id,
      projectName: project.name,
      docsDir,
      available: true,
      docs
    }
  }

  /**
   * 只读读取项目关联文档目录中的某篇 Markdown 正文（严格校验路径不越出 docsDir）
   */
  readProjectDoc(idOrPrefix: string, target: string): ProjectDocContent {
    const rawTarget = String(target ?? '').trim()
    const listRes = this.listProjectDocs(idOrPrefix)
    if (!listRes.docsDir) {
      throw new UsageError(
        `项目「${listRes.projectName}」尚未关联本地文档目录（可用 project add --name "${listRes.projectName}" --docs-dir <目录> 或在界面「文档」页签关联）`
      )
    }
    if (!listRes.available) {
      throw new NotFoundError(`项目「${listRes.projectName}」关联的文档目录不可访问：${listRes.docsDir}`)
    }
    if (!rawTarget) {
      const uniqueNames = [...new Set(listRes.docs.map((d) => d.name))]
      const sampleNames = uniqueNames.slice(0, 10).join('、') || '（目录下暂无 .md 文件）'
      throw new UsageError(
        `缺少文档路径或文件名。请按 doc list --project "${listRes.projectName}" 返回的 name 字段查询；该项目可用 name 清单（前 ${Math.min(10, uniqueNames.length)} 个）：${sampleNames}`
      )
    }

    const rootResolved = path.resolve(listRes.docsDir)
    const candidateAbs = path.resolve(rootResolved, rawTarget)
    const relCheck = path.relative(rootResolved, candidateAbs)
    if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
      throw new UsageError(`非法文档路径「${rawTarget}」：不允许越出项目关联的文档目录`)
    }

    const normalized = rawTarget.replace(/\\/g, '/').replace(/^\.\/+/, '')
    let hit = listRes.docs.find(
      (d) =>
        d.file === normalized ||
        d.file === `${normalized}.md` ||
        d.file === `${normalized}.html`
    )
    if (!hit) {
      const byName = listRes.docs.filter(
        (d) =>
          d.name === normalized ||
          d.name === `${normalized}.md` ||
          d.name === `${normalized}.html`
      )
      if (byName.length === 1) {
        hit = byName[0]
      } else if (byName.length > 1) {
        throw new UsageError(
          `文件名「${rawTarget}」在项目「${listRes.projectName}」下匹配到多篇文档：${byName.map((d) => d.file).join('、')}，请传相对路径`
        )
      }
    }
    if (!hit) {
      const uniqueNames = [...new Set(listRes.docs.map((d) => d.name))]
      const sampleNames = uniqueNames.slice(0, 10).join('、') || '（目录下暂无 .md 文件）'
      const q = normalized.toLowerCase()
      const qBase = path.posix.basename(q)
      const qStem = qBase.replace(/\.md$/i, '')
      const bigrams = (s: string): Set<string> => {
        const set = new Set<string>()
        for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2))
        return set
      }
      const qBi = bigrams(qStem)
      const nearest = listRes.docs
        .map((d) => {
          const dName = d.name.toLowerCase()
          const dFile = d.file.toLowerCase()
          const dStem = dName.replace(/\.md$/i, '')
          let score = 0
          if (dName === qBase || dStem === qStem) score = 1000 - dFile.length
          else if (qStem.length > 0 && (dName.includes(qStem) || qStem.includes(dStem) || dFile.includes(q) || q.includes(dFile))) {
            score = 500 - Math.abs(dStem.length - qStem.length)
          } else if (qBi.size > 0) {
            const dBi = bigrams(dStem)
            let hitCount = 0
            for (const b of qBi) if (dBi.has(b)) hitCount++
            score = Math.round((200 * hitCount) / (qBi.size + dBi.size))
          }
          return { doc: d, score }
        })
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score || a.doc.name.localeCompare(b.doc.name))
        .slice(0, 3)
        .map((x) => x.doc.name)
      const fallbackTop3 = nearest.length > 0 ? [...new Set(nearest)] : uniqueNames.slice(0, 3)
      const didYouMean = fallbackTop3.length > 0 ? `最接近的候选（did you mean）：${fallbackTop3.join('、')}。` : ''
      throw new NotFoundError(
        `项目「${listRes.projectName}」文档目录中找不到「${rawTarget}」。${didYouMean}请按 doc list --project "${listRes.projectName}" 返回的 name 字段（文件名）或目录内相对路径查询；该项目可用 name 清单（前 ${Math.min(10, uniqueNames.length)} 个，共 ${uniqueNames.length} 个）：${sampleNames}`
      )
    }

    const abs = path.resolve(rootResolved, hit.file)
    const content = fs.readFileSync(abs, 'utf8')
    return {
      ...hit,
      projectId: listRes.projectId,
      projectName: listRes.projectName,
      docsDir: listRes.docsDir,
      content
    }
  }

  private mapRow(row: Record<string, unknown>): Project {
    const docsDir = typeof row.docs_dir === 'string' && row.docs_dir.trim() ? row.docs_dir.trim() : null
    return {
      id: row.id as string,
      name: row.name as string,
      color: (row.color as string) ?? DEFAULT_PROJECT_COLOR,
      archived: Boolean(row.archived),
      sortOrder: (row.sort_order as number) ?? 0,
      createdAt: row.created_at as string,
      handoffMarkdown: (row.handoff_markdown as string | null) ?? '',
      ...(docsDir ? { docsDir } : {})
    }
  }
}
