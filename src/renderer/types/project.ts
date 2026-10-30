import type { TodoStatus } from './enums'

/** 新项目的基础接手说明模板：GUI、CLI、MCP 共享同一份起始结构。 */
export const PROJECT_HANDOFF_TEMPLATE = `# 项目接手说明

## 项目目标
<!-- 这个项目要解决什么问题，交付到什么结果？ -->

## 当前决定
<!-- 已确认的方向、明确不做的事，以及决定依据。 -->

## 工作入口
<!-- 代码、资料、运行命令或关键链接从哪里开始？ -->

## 下一步
<!-- 新接手的 agent 先做什么？ -->
`

/** 项目：顶层容器 */
export interface Project {
  id: string
  name: string
  /** 展示色，如 #5388F6 */
  color: string
  /** 归档的项目不出现在新建下拉里，但历史事项仍挂得住 */
  archived: boolean
  sortOrder: number
  createdAt: string
  /** 人机接手时的背景说明；动态状态另从事项数据计算 */
  handoffMarkdown: string
  /** 关联的本地 Markdown 文档目录（方案 C：只读索引与渲染，不同步不改写；卡 a3bd40d8 / 095b2006） */
  docsDir?: string | null
}

/** 项目关联文档目录中的单篇 Markdown 索引项（卡 a3bd40d8 / 095b2006） */
export interface ProjectDocEntry {
  /** 相对项目文档目录的路径（统一正斜杠） */
  file: string
  /** 文件名 */
  name: string
  /** 文档类型：md 或 html（卡 46c7d51d） */
  kind: 'md' | 'html'
  /** 文档标题（首个 # 标题行或 HTML <title>/<h1>，无则回退为去后缀文件名） */
  title: string
  /** 字节数 */
  bytes: number
  /** 文件最后修改时间（ISO 8601） */
  updatedAt: string
  /** 内容 SHA-256 指纹 */
  sha256: string
}

export interface ProjectDocListResult {
  projectId: string
  projectName: string
  docsDir: string | null
  available: boolean
  docs: ProjectDocEntry[]
}

export interface ProjectDocContent extends ProjectDocEntry {
  projectId: string
  projectName: string
  docsDir: string
  content: string
}

/**
 * 永久删除项目的回执（卡 `c177e466`）：逐表报数。
 *
 * 报数不是装饰 —— "清了多少条"是这次破坏性动作**唯一可核对的事实**，
 * 也正是"别误删别的项目数据"那条验收要看的证据（配合"其他项目的行数不变"）。
 */
export interface ProjectPurgeResult {
  projectId: string
  projectName: string
  removed: {
    todos: number
    comments: number
    transitions: number
    todoCategories: number
    notifications: number
    releases: number
    handoffRevisions: number
    handoffProposals: number
    collaborationRules: number
    permissionMatrix: number
    profileBlocks: number
    profileProposals: number
    profileRevisions: number
    protocolBlocks: number
    protocolProposals: number
    ruleProposals: number
    ruleRevisions: number
  }
}

export interface ProjectOverviewItem {
  id: string
  title: string
  status: TodoStatus
  /** 实际执行者；未显式指派时等于提出者 */
  executedBy: string
  verifier: string
  updatedAt: string
}

export interface ProjectOverview {
  /** 项目事项总数，不受本次返回上限影响 */
  total: number
  statusCounts: Record<TodoStatus, number>
  /** 当前事项入口。状态与执行/验收角色均来自 todos 表 */
  items: ProjectOverviewItem[]
  /** 本次返回的事项数 */
  returned?: number
  /** 是否还有未返回的事项 */
  truncated?: boolean
  /** 下一页偏移；没有下一页时为 null */
  nextOffset?: number | null
}

export interface ProjectDetail {
  project: Project
  overview: ProjectOverview
  /** 接手说明已有多少版修订（最多保留 50 版）；「修订历史（N）」按钮用 */
  handoffRevisionCount: number
}

/**
 * 接手说明的一版修订（schema v35，36b44adb）
 *
 * - `save`：一次内容有变化的保存；`rollback`：把某旧版写回成新的一次保存（`sourceSeq` 记来自哪一版）。
 * - 「迁移前」/「未知来源」是**基线行**的作者：首次在「已有说明但没有对应修订」时保存，
 *   先把被覆盖的旧内容存下来，它当初是谁写的、什么时候写的已无从追溯，如实标注而不编造。
 * - JSON 导出（备份 v2）**不含**修订历史；SQLite 备份文件包含。
 */
export type HandoffRevisionKind = 'save' | 'rollback'

export interface HandoffRevision {
  id: string
  projectId: string
  /** 项目内单调递增的版本序号；修剪旧版后不回收、不重排 */
  seq: number
  body: string
  author: string
  kind: HandoffRevisionKind
  sourceRevisionId: string | null
  sourceSeq: number | null
  createdAt: string
  /** 最新一版（内容等于项目当前接手说明） */
  isCurrent: boolean
  /** 这一版是谁确认的（v47 起；旧版为 null） */
  confirmedBy?: string | null
}

/**
 * 接手说明的事实模型（schema v47，卡 `e2a06fd7`）
 *
 * 为什么放在共享类型里：CLI、IPC、界面都要用同一份形状；
 * 判据（diff / freshness）在 `src/main/database/handoff-state.ts`，类型不该只长在主进程。
 */
export interface HandoffMainTodo {
  id: string
  title: string
  status: TodoStatus
  updatedAt: string
}

export interface HandoffFacts {
  /** 应用版本；调用方不知道时不猜，写 null */
  version: string | null
  schemaVersion: number
  statusCounts: Record<TodoStatus, number>
  /** 未完成（不含 done / discarded） */
  openTotal: number
  /** 当前主线：派生规则见 `ProjectRepository.buildHandoffFacts` */
  mainTodo: HandoffMainTodo | null
}

export interface HandoffCoverage {
  version: string | null
  schemaVersion: number | null
  mainTodoId: string | null
}

export interface HandoffDirty {
  reasons: string[]
  at: string
}

export interface HandoffSnapshot {
  facts: HandoffFacts
  savedAt: string
  confirmedBy: string | null
}

export type HandoffFreshnessState = 'fresh' | 'review_required' | 'stale'

export interface HandoffFreshness {
  state: HandoffFreshnessState
  /** 为什么是这个状态（空数组 = fresh） */
  reasons: string[]
  coverage: HandoffCoverage | null
  dirty: HandoffDirty | null
  checkedAt: string
}

export interface HandoffProposal {
  id: string
  projectId: string
  body: string
  originalBody: string
  baseRevision: number
  decidedBody: string | null
  proposer: string
  status: 'pending' | 'approved' | 'rejected'
  decidedBy: string | null
  decidedAt: string | null
  createdAt: string
  currentBody?: string
  stale?: boolean
  /** 提议提交那一刻的事实快照（schema v47）：复核人不用回查库就知道它基于什么 */
  factsSnapshot?: HandoffFacts | null
  /** 当前项目的实时事实（由 listHandoffProposals 现算带回，供审批页与 factsSnapshot 并排对照） */
  currentFacts?: HandoffFacts | null
  /** 这条提议依据的事项（当前主线 + 前几条未完成）；空数组 = 没有可引用的 */
  sourceTodoIds?: string[]
  /** 发起人自行撤回的提议标记 */
  withdrawn?: boolean
}

/** 列表摘要：不带全文，CLI 与大列表用 */
export type HandoffRevisionSummary = Omit<HandoffRevision, 'body'> & {
  /** 全文字符数 */
  length: number
  /** 首个非空行，截断到 60 字 */
  preview: string
}

export type ProjectSearchSource = 'handoff_markdown' | 'todo_title' | 'todo_description' | 'comment'

export interface ProjectSearchResult {
  source: ProjectSearchSource
  /** 从原文截取的命中片段，保留原有文本 */
  snippet: string
  todoId?: string
  todoTitle?: string
  todoStatus?: TodoStatus
  commentId?: string
  author?: string | null
  authorType?: 'human' | 'agent' | 'system'
  /** 评论来源时为评论创建时间 */
  createdAt?: string
  /** 跨项目搜索时用于标注归属与跳转 */
  projectId?: string
  projectName?: string
  todoUpdatedAt?: string
}

/** 有界项目搜索结果；结果正文与分页元数据分开，避免调用方误把截断当全量。 */
export interface ProjectSearchPage {
  results: ProjectSearchResult[]
  matched: number
  returned: number
  truncated: boolean
  nextOffset: number | null
}

export interface CreateProjectInput {
  name: string
  color?: string
  sortOrder?: number
  // ── 以下三个字段**只给备份导入用**（1.0.46） ──
  // 普通新建不传：id 由仓库生成、archived 恒为 false、createdAt 取当下。
  // 备份恢复要还原的是"那一刻的项目列表"，包括已归档的与原始创建时间。
  /** 指定 id（备份导入用）。不传则自己生成 */
  id?: string
  /** 是否归档（备份导入用）。不传为 false */
  archived?: boolean
  /** 原始创建时间（备份导入用）。不传取当下 */
  createdAt?: string
  /** 接手说明 Markdown；旧备份缺少时留空 */
  handoffMarkdown?: string
  /** 带说明建项目时，第 1 版修订的作者；不传 = human */
  actor?: string
  /** 关联的本地 Markdown 文档目录（可选） */
  docsDir?: string | null
}

export interface UpdateProjectInput {
  id: string
  name?: string
  color?: string
  archived?: boolean
  sortOrder?: number
  /** 保持原样保存 Markdown；空字符串表示清空 */
  handoffMarkdown?: string
  /** 关联的本地 Markdown 文档目录；传 null 或空串表示取消关联 */
  docsDir?: string | null
  /**
   * 这次保存是谁写的（落进接手说明修订的作者）。不传 = `human`（界面保存）。
   * 只影响 `handoffMarkdown` 变化时留下的修订，不参与其它字段。
   */
  actor?: string
}
