import fs from 'node:fs'
import { TodoRepository, type TodoTransition } from '../database/todo.repository'
import { CommentRepository, type TodoComment } from '../database/comment.repository'
import { CategoryRepository } from '../database/category.repository'
import { ProjectRepository } from '../database/project.repository'
import { MemoRepository } from '../database/memo.repository'
import { AgentRepository } from '../database/agent.repository'
import { SettingsRepository, type SettingsImportResult } from '../database/settings.repository'
import { getDatabase, getDatabasePath } from '../database/index'
import { pruneOldBackups } from '../database/migrations'
import type { Todo } from '../../renderer/types/todo'
import type { Category } from '../../renderer/types/category'
import type { Project } from '../../renderer/types/project'
import type { AppSettings } from '../../renderer/types/settings'

/**
 * 备份格式版本
 *
 * v1：只有 todos / categories / settings（且导入只恢复三个字段）
 * v2（1.0.46）：补齐 projects / agents / memos，并让导入逐字段还原
 * v3（1.0.93）：补齐 comments / transitions，保证接手材料可随 JSON 交接
 * v4（1.0.104）：补齐档案、协议、接手说明修订、版本、协作规则及提议审计
 * v5（1.0.105）：补齐 profile/rules 修订历史（含空档与继承覆盖状态）
 *
 * 保持 v1/v2/v3/v4 可导入 —— 老备份文件仍然要能读。
 */
export const BACKUP_FORMAT_VERSION = 5

/** 导出数据的 JSON 结构 */
export interface ExportData {
  version: number
  exportedAt: string
  todos: Todo[]
  categories: Category[]
  settings: AppSettings
  /** v2 起：项目定义。缺了它，待办的 projectId 导入后无处可指 */
  projects?: Project[]
  /** v2 起：agent 身份（**不含凭据哈希**，见下方说明） */
  agents?: ExportedAgent[]
  /** v2 起：备忘 */
  memos?: ExportedMemo[]
  /** v3 起：事项评论（接手材料的一部分） */
  comments?: TodoComment[]
  /** v3 起：事项流转历史（接手材料的一部分） */
  transitions?: TodoTransition[]
  /** v4/v5 起：用户/项目协作上下文、审批提议与可回滚修订历史 */
  auxiliary?: {
    profileBlocks: Record<string, unknown>[]
    profileProposals: Record<string, unknown>[]
    profileRevisions: Record<string, unknown>[]
    protocolBlocks: Record<string, unknown>[]
    protocolProposals: Record<string, unknown>[]
    handoffRevisions: Record<string, unknown>[]
    handoffProposals: Record<string, unknown>[]
    releases: Record<string, unknown>[]
    collaborationRules: Record<string, unknown>[]
    permissionMatrix: Record<string, unknown>[]
    ruleProposals: Record<string, unknown>[]
    ruleRevisions: Record<string, unknown>[]
    agentApprovalEvents: Record<string, unknown>[]
  }
}

/**
 * 导出用的 agent 身份
 *
 * ⚠️ 刻意**不含 `credentialHash`**：备份文件是用户随手放的文件，
 * 而凭据哈希是认证材料 —— 导出它等于把"谁持有有效凭据"这件事
 * 抄送进一个不受保护的文件里。恢复身份后由用户重新发一次凭据即可，
 * 这也符合既有的"三步接入都由人做"的设计。
 */
export interface ExportedAgent {
  id: string
  displayName: string
  color: string | null
  approved: boolean
  createdAt: string
}

/** 导出用的备忘 */
export interface ExportedMemo {
  id: string
  author: string
  text: string
  linkedTodoId: string | null
  status: 'unread' | 'read'
  createdAt: string
  readAt: string | null
  recipient?: string | null
  replies?: import('../database/memo.repository').MemoReply[]
}

/** 导入结果 */
export interface ImportResult {
  imported: number
  skipped: number
  /** 各表分别导入了多少（1.0.46）—— 一个总数说明不了"哪里没进来" */
  detail?: {
    projects: number
    categories: number
    todos: number
    agents: number
    memos: number
    comments: number
    transitions: number
    profileBlocks: number
    profileProposals: number
    profileRevisions: number
    protocolBlocks: number
    protocolProposals: number
    handoffRevisions: number
    handoffProposals: number
    releases: number
    collaborationRules: number
    permissionMatrix: number
    ruleProposals: number
    ruleRevisions: number
    agentApprovalEvents: number
  }
  /** 设置里被接受的字段（1.0.38，仅导入设置时才有） */
  settingsAccepted?: string[]
  /** 设置里被丢弃的字段及原因 —— 丢掉的必须能报出来，不能静默 */
  settingsRejected?: { key: string; why: string }[]
  /**
   * 导入前自动备份的库文件路径（1.0.46）
   *
   * 导入是**破坏性**操作（叠加数据、不可回滚），所以先留一份原件。
   * 复用迁移那套 `user.db.backup-*` 命名（卡 71270463：实现曾少掉中间那个 `.db`，
   * 既不轮转、也不出现在"可用快照"清单里），用户的清理习惯不用变。
   */
  preImportBackup?: string | null
  /** 导入过程中被跳过的条目及原因 —— 不能只给一个数字 */
  skippedItems?: { kind: string; title: string; why: string }[]
  /**
   * 按**名字**复用（而非新建）的已有分类数量（1.0.46）
   *
   * 换机恢复时会命中：目标库启动时已由 `initializeDefaults()` 写好
   * 四条默认分类，备份里那四条按名字复用到它们身上，不再重复建。
   * 这件事**必须报出来** —— 用户看到"分类进了 0 条"时需要知道
   * 不是丢了，而是本来就在。
   */
  reusedCategories?: number
}

/** v4 durable tables that must travel with a project handoff backup. */
const AUXILIARY_TABLES = {
  profileBlocks: ['profile_blocks', ['scope', 'project_id', 'block_key', 'body', 'confirmed', 'updated_by', 'updated_at']],
  profileProposals: ['profile_proposals', ['id', 'scope', 'project_id', 'block_key', 'body', 'proposer', 'status', 'decided_by', 'decided_at', 'created_at', 'original_body', 'base_updated_at', 'decided_body']],
  profileRevisions: ['profile_revisions', ['id', 'scope', 'project_id', 'block_key', 'body', 'confirmed', 'present', 'author', 'created_at']],
  protocolBlocks: ['protocol_blocks', ['scope', 'project_id', 'block_key', 'body', 'confirmed', 'updated_by', 'updated_at']],
  protocolProposals: ['protocol_proposals', ['id', 'scope', 'project_id', 'block_key', 'body', 'proposer', 'status', 'decided_by', 'decided_at', 'created_at', 'original_body', 'base_updated_at', 'decided_body']],
  handoffRevisions: ['project_handoff_revisions', ['id', 'project_id', 'seq', 'body', 'author', 'kind', 'source_revision_id', 'source_seq', 'created_at', 'coverage_version', 'coverage_schema', 'facts_snapshot', 'confirmed_by']],
  handoffProposals: ['project_handoff_proposals', ['id', 'project_id', 'body', 'original_body', 'base_revision', 'decided_body', 'proposer', 'status', 'decided_by', 'decided_at', 'created_at', 'facts_snapshot', 'source_todo_ids']],
  releases: ['releases', ['version', 'project_id', 'shipped_at', 'summary', 'highlights', 'created_at', 'tested']],
  collaborationRules: ['collaboration_rules', ['scope', 'project_id', 'rule_key', 'category', 'enforcement', 'updated_by', 'updated_at']],
  permissionMatrix: ['permission_matrix', ['scope', 'project_id', 'action', 'subject', 'decision', 'updated_by', 'updated_at']],
  ruleProposals: ['rule_proposals', ['id', 'scope', 'project_id', 'category', 'rule_key', 'proposed_enforcement', 'original_enforcement', 'base_updated_at', 'decided_enforcement', 'proposer', 'status', 'decided_by', 'decided_at', 'created_at']],
  ruleRevisions: ['rule_revisions', ['id', 'scope', 'project_id', 'rule_key', 'category', 'enforcement', 'has_override', 'author', 'created_at']],
  agentApprovalEvents: ['agent_approval_events', ['id', 'agent_id', 'agent_name', 'action', 'actor', 'created_at']]
} as const

function readAuxiliaryTables(): ExportData['auxiliary'] {
  const db = getDatabase()
  const output = {} as Record<string, Record<string, unknown>[]>
  for (const [key, [table]] of Object.entries(AUXILIARY_TABLES)) {
    output[key] = db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[]
  }
  return output as ExportData['auxiliary']
}

/** 数据备份服务 */
export class BackupService {
  constructor(
    private todoRepo: TodoRepository,
    private categoryRepo: CategoryRepository,
    private settingsRepo: SettingsRepository,
    private projectRepo: ProjectRepository,
    private memoRepo: MemoRepository,
    private agentRepo: AgentRepository,
    private commentRepo: CommentRepository = new CommentRepository()
  ) {}

  /** 导出全部数据为 JSON 字符串 */
  exportData(): string {
    const data: ExportData = {
      version: BACKUP_FORMAT_VERSION,
      exportedAt: new Date().toISOString(),
      todos: this.todoRepo.list(),
      categories: this.categoryRepo.list(),
      settings: this.settingsRepo.get(),
      /**
       * 这三张表是 1.0.46 补的。
       *
       * 此前只导出 todos / categories / settings，而库里有 13 张表 ——
       * 最直接的后果：待办全都带着 projectId，而 projects 不在备份里，
       * 导入后那些 id 指向不存在的项目，只能落 null。
       * agents 缺失则让"恢复环境后 agent 全部变成未注册"。
       */
      projects: this.projectRepo.list(),
      agents: this.agentRepo.list().map((a) => ({
        id: a.id,
        displayName: a.displayName,
        color: a.color,
        approved: a.approved,
        createdAt: a.createdAt
      })),
      memos: this.memoRepo.list().map((m) => ({
        id: m.id,
        author: m.author,
        text: m.text,
        linkedTodoId: m.linkedTodoId,
        status: m.status,
        createdAt: m.createdAt,
        readAt: m.readAt
      })),
      // 评论和流转是接手者判断“为什么这样做”的长期材料，不能只备份事项当前状态。
      comments: this.todoRepo.list().flatMap((todo) => this.commentRepo.listByTodo(todo.id)),
      transitions: this.todoRepo.list().flatMap((todo) => this.todoRepo.listTransitions(todo.id)),
      auxiliary: readAuxiliaryTables()
    }
    return JSON.stringify(data, null, 2)
  }

  /**
   * 导入前把当前库复制一份
   *
   * 导入会叠加数据且无法回滚，所以先留原件 —— 这与迁移前的自动备份
   * 是同一个理由（见 migrations.ts 的 backupBeforeMigrate）。
   * 命名沿用 `user.db.backup-*`，用户的清理习惯不用变。
   *
   * ⚠️ 先做一次 TRUNCATE checkpoint：只拷主文件会丢掉还在 -wal 里
   * 尚未 checkpoint 的事务（这是实测踩过的坑）。
   */
  private backupBeforeImport(): string | null {
    try {
      const dbPath = getDatabasePath()
      if (!dbPath) return null

      // 通过仓库拿连接做 checkpoint；拿不到就跳过（不阻断导入）
      this.todoRepo.checkpointWal()

      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      /**
       * ⚠️ 命名必须与迁移快照同族：`<库文件>.backup-<种类>-<时间戳>`（卡 71270463）
       *
       * 原先写的是 `${path.basename(dbPath, '.db')}.backup-preimport-${stamp}.db`，
       * 得到 `user.backup-preimport-….db` —— 与 `pruneOldBackups` / `listSnapshots`
       * 认的前缀 `user.db.backup-` **差一个 `.db`**。后果两条，都不是小事：
       *
       * 1. **永不轮转**：每导入一次就多留一份完整库（本机约 5 MB），只增不减；
       * 2. **界面看不见**：设置里那份"可用快照"清单走 `listSnapshots`，同一前缀 ——
       *    于是人以为手里没有导入前备份，实际磁盘上堆着好几份。
       *
       * 注释与 `preImportBackup` 的文档一直写的就是"沿用 `user.db.backup-*`"，
       * 是实现没做到，所以这里改命名（而不是给 pre-import 另立一套前缀）：
       * 人要记的清理规则只有一条 —— 认 `user.db.backup-*`。
       */
      const dest = `${dbPath}.backup-preimport-${stamp}`
      fs.copyFileSync(dbPath, dest)
      // 与迁移前的备份共用同一套保留窗口（keep = 2）：两者都是"上一份库"，
      // 最新的那份才是退路。清理失败不阻断导入（见 pruneOldBackups 内部）。
      pruneOldBackups(dbPath)
      console.log(`[Backup] 导入前已备份当前库: ${dest}`)
      return dest
    } catch (err) {
      // 备份失败不阻断导入，但必须让人看见 —— 静默失败等于没有备份
      console.warn(
        '[Backup] 导入前备份失败:',
        err instanceof Error ? err.message : String(err)
      )
      return null
    }
  }

  /** 从 JSON 字符串导入数据，处理 ID 冲突 */
  importData(json: string): ImportResult {
    let data: ExportData
    try {
      data = JSON.parse(json) as ExportData
    } catch {
      throw new Error('[BackupService] 无效的 JSON 数据')
    }

    if (!data.version || !data.todos || !data.categories) {
      throw new Error('[BackupService] 数据格式不正确，缺少必要字段')
    }

    // 先备份再动 —— 这是破坏性操作
    const preImportBackup = this.backupBeforeImport()

    const skippedItems: ImportResult['skippedItems'] = []

    const existingTodoIds = new Set(this.todoRepo.list().map((t) => t.id))
    const existingCategoryIds = new Set(this.categoryRepo.list().map((c) => c.id))
    const existingProjectIds = new Set(this.projectRepo.list().map((p) => p.id))

    let imported = 0
    let skipped = 0
    /** 按名字复用了多少条已有分类（换机恢复时会出现，不是错误） */
    let reusedCategories = 0
    let settingsImport: SettingsImportResult | undefined

    // ID 冲突映射表：旧 ID → 新 ID
    const categoryIdMap = new Map<string, string>()
    const projectIdMap = new Map<string, string>()
    const importedProjectIds = new Set<string>()

    // ── 1) 项目（必须最先：待办的 projectId 指向它） ──
    const detail = {
      projects: 0,
      categories: 0,
      todos: 0,
      agents: 0,
      memos: 0,
      comments: 0,
      transitions: 0,
      profileBlocks: 0,
      profileProposals: 0,
      profileRevisions: 0,
      protocolBlocks: 0,
      protocolProposals: 0,
      handoffRevisions: 0,
      handoffProposals: 0,
      releases: 0,
      collaborationRules: 0,
      permissionMatrix: 0,
      ruleProposals: 0,
      ruleRevisions: 0,
      agentApprovalEvents: 0
    }

    for (const proj of data.projects ?? []) {
      if (existingProjectIds.has(proj.id)) {
        /**
         * 已存在：沿用，**不重复建、也不计"新建"**（1.0.46）。
         *
         * 这里曾经只 `continue` 却不计 skipped —— 于是重复导入同一份备份时
         * `detail.projects` 报 2、`imported` 报 2，而库里一个新项目都没有。
         * 回执要能反映"实际发生了什么"，不能把"已存在"混进"新建"里。
         */
        projectIdMap.set(proj.id, proj.id)
        skipped++
        skippedItems.push({
          kind: '项目',
          title: proj.name,
          why: '同 id 已存在，跳过（重复导入同一份备份时属正常）'
        })
        continue
      }
      try {
        this.projectRepo.create({
          id: proj.id,
          name: proj.name,
          color: proj.color,
          archived: proj.archived,
          sortOrder: proj.sortOrder,
          createdAt: proj.createdAt,
          // 接手说明修订在 v4 auxiliary 中单独恢复，避免 create() 先写一条重复的初始修订。
          handoffMarkdown: ''
        })
        projectIdMap.set(proj.id, proj.id)
        importedProjectIds.add(proj.id)
        detail.projects++
        imported++
      } catch (err) {
        skipped++
        skippedItems.push({
          kind: '项目',
          title: proj.name,
          why: err instanceof Error ? err.message : String(err)
        })
      }
    }

    // ── 2) 分类 ──
    /**
     * 分类的三种归宿（1.0.46）
     *
     * ① **同 id 已存在** → 沿用，不重建（重复导入同一份备份时属正常）
     * ② **同名已存在** → 复用已有的那条，把备份里的 id 映射过去
     * ③ 都没有 → 用备份里的 id 新建
     *
     * 为什么要有 ②：**换一台新机器恢复**时，目标库启动时就由
     * `initializeDefaults()` 写好了「工作/生活/学习/其他」四条默认分类 ——
     * 它们的 id 与新机器无关、每次都是新的。若只按 id 判冲突，
     * 导入会把备份里那四条**再建一遍**，界面上就出现两组同名分类
     * （"工作"挨着"工作"），而用户完全不知道多出来的那组是干什么的。
     *
     * 为什么不能像从前那样"冲突就换新 id 重建"：那样**不幂等**
     * （同一份备份导两次多出一整套重名分类），而且会覆盖用户对分类的改名。
     * 沿用/复用之后，待办引用的 id 在库里真实存在、标签照样带上，
     * 同时"导入是幂等的"与"用户的改动不被抹掉"两件事都成立。
     */
    const existingByName = new Map(
      this.categoryRepo.list().map((c) => [c.name.trim(), c.id] as const)
    )

    for (const cat of data.categories) {
      if (existingCategoryIds.has(cat.id)) {
        categoryIdMap.set(cat.id, cat.id)
        continue
      }
      const sameName = existingByName.get(cat.name.trim())
      if (sameName) {
        // 同名复用：映射到已有那条，稍后不新建
        categoryIdMap.set(cat.id, sameName)
        reusedCategories++
        continue
      }
      categoryIdMap.set(cat.id, cat.id)
    }

    for (const cat of data.categories) {
      /**
       * 已按 id 或名字命中已有的那条 → 不重复建，计入 skipped。
       *
       * 为什么不静默 continue：`imported + skipped` 必须等于备份里的总条目数，
       * 否则用户对不上账 —— "导出了 216 条，回执只说进了 215 条，
       * 剩下那条去哪了"。按名字复用的条数另有 `reusedCategories` 说明。
       */
      if (existingCategoryIds.has(cat.id) || categoryIdMap.get(cat.id) !== cat.id) {
        skipped++
        continue
      }
      const mappedId = categoryIdMap.get(cat.id)!
      try {
        /**
         * ⚠️ 必须把映射后的 id 传进去（1.0.38 修）。
         *
         * 此前这里只传 name/color/sortOrder，id 由仓库内部 uuidv4() 另生成 ——
         * 于是库里分类的真实 id 与 categoryIdMap 里记的值毫无关系。
         * 待办导入时拿映射表去查，拿到的是库里不存在的 id，
         * 插 todo_categories 撞外键，被下面的 catch 静默吞掉：
         * **带标签的待办一条都进不来，界面只显示一个 skipped 数字。**
         */
        this.categoryRepo.create({
          id: mappedId,
          name: cat.name,
          color: cat.color,
          sortOrder: cat.sortOrder
        })
        existingCategoryIds.add(cat.id)
        detail.categories++
        imported++
      } catch (err) {
        skipped++
        skippedItems.push({
          kind: '分类',
          title: cat.name,
          why: err instanceof Error ? err.message : String(err)
        })
      }
    }

    /**
     * 兜底：确认库里至少有一个分类（1.0.46）
     *
     * `todoRepo.create()` 在"一个分类都没有"时直接抛错 ——
     * 而待办的标签是可选的，正常库里靠 `initializeDefaults()` 保证
     * 至少有 4 个默认分类，所以平时碰不到。
     *
     * 但导入是**另一条进入路径**：库里若是空的（换机器恢复、或备份本身
     * 没带分类），待办会**逐条**撞上这个错、被 catch 成 skipped ——
     * 表现是"导入成功，但一条待办都没进来"，而原因完全看不出来。
     * 恢复历史数据不该被当前库的状态挡住，所以这里先补上默认分类。
     *
     * 放在分类导入**之后**：备份带了分类时库已非空，`initializeDefaults`
     * 会自己跳过（它内部判 `existing.length > 0`），不会污染用户数据。
     */
    this.categoryRepo.initializeDefaults()

    // ── 3) 待办（父任务必须先于子任务落库，否则 G1 会拦下子任务） ──
    //
    // 按 parentId 分层：先导所有没有父的，再导有父的，再导孙辈…… 
    // 深度一般很浅（实测最深 2 层），用轮转即可，不做通用拓扑排序。
    const ordered = orderByDepth(data.todos)

    for (const todo of ordered) {
      /**
       * 旧备份里是单值 categoryId，新的是 categoryIds 数组 —— 两种都要认，
       * 否则老备份导入后会丢标签。
       */
      const legacyId = (todo as { categoryId?: string }).categoryId
      const sourceIds = todo.categoryIds ?? (legacyId ? [legacyId] : [])
      const mappedIds = sourceIds.map((id) => categoryIdMap.get(id) ?? id)

      /**
       * ⚠️ 1.0.46 起**沿用备份里的 id**，冲突才跳过。
       *
       * 此前导入走 `create()` 而它内部硬编码 uuidv4()，于是这个冲突判断
       * 永远命中不了 —— 重复导入会不断翻倍（204 → 408 → 612），
       * 冲突检测形同虚设。现在 id 保住了，判断才真的起作用。
       */
      if (existingTodoIds.has(todo.id)) {
        skipped++
        skippedItems.push({
          kind: '待办',
          title: todo.title,
          why: '同 id 已存在，跳过（重复导入同一份备份时属正常）'
        })
        continue
      }

      // projectId 要过映射表：项目若因冲突被重建，旧 id 已失效
      const mappedProjectId = todo.projectId
        ? (projectIdMap.get(todo.projectId) ?? null)
        : null
      // 父任务 id 不变（我们保 id），所以 parentId 可以原样用
      const mappedParentId = todo.parentId ?? null

      try {
        this.todoRepo.create({
          id: todo.id,
          title: todo.title,
          // ── 以下这些字段此前**全都没传**，是"导入后只剩标题"的根因 ──
          description: todo.description ?? null,
          projectId: mappedProjectId,
          parentId: mappedParentId,
          ...(mappedIds.length ? { categoryIds: mappedIds } : {}),
          status: todo.status,
          priority: todo.priority,
          type: todo.type,
          createdBy: todo.createdBy,
          executedBy: todo.executedBy ?? null,
          dueAt: todo.dueAt ?? null,
          remindAt: todo.remindAt ?? null,
          isPinned: todo.isPinned ?? false,
          // v24 新增；旧备份里没有这个键，`?? null` 让老格式照样能导
          fixedInVersion: todo.fixedInVersion ?? null,
          createdAt: todo.createdAt,
          updatedAt: todo.updatedAt,
          completedAt: todo.completedAt ?? null,
          // 恢复历史数据，不走"现在提出一件事"的候选池守卫
          skipGuards: true,
          // 流转记录的动作人：导入是数据搬运，不是"某人在某个时刻提出了它"
          actor: null
        })
        existingTodoIds.add(todo.id)
        detail.todos++
        imported++
      } catch (err) {
        skipped++
        skippedItems.push({
          kind: '待办',
          title: todo.title,
          why: err instanceof Error ? err.message : String(err)
        })
      }
    }

    // ── 4) agent 身份（**不含凭据**：恢复后需重新签发） ──
    const existingAgentIds = new Set(this.agentRepo.list().map((a) => a.id))

    for (const agent of data.agents ?? []) {
      /**
       * 同 id 已存在就跳过（1.0.46）。
       *
       * 不能走 `register()` 的 upsert 路径：那是**普通注册**的语义
       * （"我又来了，顺手更新一下展示名"），而导入是**还原历史**。
       * 两者混在一起会有两个后果：
       * ① 回执失真：`detail.agents` 说"身份进了 2 个"，其实一个都没新建；
       * ② 更实际的：用户可能在备份之后改过展示名、或**撤销过批准**，
       *    upsert 会把备份里那份旧值盖回去 —— 恢复数据不该顺手改权限。
       *
       * 与待办、备忘的冲突处理保持一致。
       */
      if (existingAgentIds.has(agent.id)) {
        skipped++
        skippedItems.push({
          kind: 'agent',
          title: agent.displayName || agent.id,
          why: '同 id 已存在，跳过（重复导入同一份备份时属正常）'
        })
        continue
      }

      try {
        // 直接还原身份行，不调用 register/setApproved：这两个业务入口会写入
        // agent_approval_events，而审批审计已在 auxiliary 中单独恢复。
        getDatabase().prepare(`
          INSERT INTO agents (id, display_name, color, approved, created_at, last_seen_at)
          VALUES (?, ?, ?, ?, ?, NULL)
        `).run(agent.id, agent.displayName, agent.color ?? null, agent.approved ? 1 : 0, agent.createdAt)
        existingAgentIds.add(agent.id)
        detail.agents++
        imported++
      } catch (err) {
        skipped++
        skippedItems.push({
          kind: 'agent',
          title: agent.displayName || agent.id,
          why: err instanceof Error ? err.message : String(err)
        })
      }
    }

    // ── 5) 备忘 ──
    const existingMemoIds = new Set(this.memoRepo.list().map((m) => m.id))

    for (const memo of data.memos ?? []) {
      /**
       * 同 id 已存在就跳过（1.0.46）。
       *
       * 此前没有这一步：靠 `memoRepo.create()` 撞主键报错、被下面的 catch
       * 兜住。结果**虽然正确**（不会翻倍），但走的是异常路径 ——
       * 用户会在回执里看到一条 "UNIQUE constraint failed: memos.id"，
       * 那是数据库在报错，不是"这条已经在了"。与待办的处理保持一致。
       */
      if (existingMemoIds.has(memo.id)) {
        skipped++
        skippedItems.push({
          kind: '备忘',
          title: memo.text.slice(0, 40),
          why: '同 id 已存在，跳过（重复导入同一份备份时属正常）'
        })
        continue
      }

      try {
        this.memoRepo.create({
          id: memo.id,
          author: memo.author,
          text: memo.text,
          // 关联的待办若没导进来（或本来就不在备份里），置空而不是留一个死引用
          linkedTodoId:
            memo.linkedTodoId && existingTodoIds.has(memo.linkedTodoId)
              ? memo.linkedTodoId
              : null,
          status: memo.status,
          createdAt: memo.createdAt,
          readAt: memo.readAt,
          recipient: memo.recipient ?? null,
          replies: memo.replies
        })
        existingMemoIds.add(memo.id)
        detail.memos++
        imported++
      } catch (err) {
        skipped++
        skippedItems.push({
          kind: '备忘',
          title: memo.text.slice(0, 40),
          why: err instanceof Error ? err.message : String(err)
        })
      }
    }

    // ── 6) 评论与流转（接手材料；旧 v1/v2 备份没有这两项） ──
    // 事项已先导入，因此外键和回复 parent_id 都可以按原 id 还原。
    for (const comment of data.comments ?? []) {
      if (!existingTodoIds.has(comment.todoId)) {
        skipped++
        skippedItems.push({ kind: '评论', title: comment.body.slice(0, 40), why: '所属事项未导入，跳过' })
        continue
      }
      try {
        const result = getDatabase()
          .prepare(
            `INSERT OR IGNORE INTO todo_comments
              (id, todo_id, parent_id, author_type, author_id, body, kind, created_at, recipient)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            comment.id,
            comment.todoId,
            comment.parentId,
            comment.authorType,
            comment.authorId,
            comment.body,
            comment.kind,
            comment.createdAt,
            comment.recipient
          )
        if (result.changes > 0) {
          detail.comments++
          imported++
        } else {
          skipped++
        }
      } catch (err) {
        skipped++
        skippedItems.push({ kind: '评论', title: comment.body.slice(0, 40), why: err instanceof Error ? err.message : String(err) })
      }
    }

    for (const transition of data.transitions ?? []) {
      if (!existingTodoIds.has(transition.todoId)) {
        skipped++
        skippedItems.push({ kind: '流转', title: transition.todoId, why: '所属事项未导入，跳过' })
        continue
      }
      try {
        const result = getDatabase()
          .prepare(
            `INSERT OR IGNORE INTO todo_transitions
              (id, todo_id, from_status, to_status, actor, created_at, is_rejection)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            transition.id,
            transition.todoId,
            transition.fromStatus,
            transition.toStatus,
            transition.actor,
            transition.createdAt,
            transition.isRejection === null ? null : transition.isRejection ? 1 : 0
          )
        if (result.changes > 0) {
          detail.transitions++
          imported++
        } else {
          skipped++
        }
      } catch (err) {
        skipped++
        skippedItems.push({ kind: '流转', title: transition.todoId, why: err instanceof Error ? err.message : String(err) })
      }
    }

    // ── 7) 协作上下文与审批审计（v4；旧备份没有 auxiliary 时跳过） ──
    // 这些表是接手所需的长期上下文，必须和事项/评论/流转一起恢复。
    // 统一使用 INSERT OR IGNORE：重复导入不覆盖用户在目标库已有的最新内容，
    // 并且每一行都进入 imported/skipped 对账，不能静默丢失。
    if (data.auxiliary) {
      const projectScopedColumns = new Set(['project_id'])
      for (const [key, [table, columns]] of Object.entries(AUXILIARY_TABLES)) {
        const rows = data.auxiliary[key as keyof NonNullable<ExportData['auxiliary']>] ?? []
        const placeholders = columns.map(() => '?').join(', ')
        const insert = getDatabase().prepare(
          `INSERT OR IGNORE INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`
        )
        for (const source of rows) {
          const row = { ...source }
          if (projectScopedColumns.has('project_id') && 'project_id' in row && row.project_id) {
            const mapped = projectIdMap.get(String(row.project_id))
            if (!mapped) {
              skipped++
              skippedItems.push({ kind: key, title: String(row.id ?? row.rule_key ?? row.version ?? ''), why: '所属项目未导入，跳过' })
              continue
            }
            row.project_id = mapped
          }
          try {
            const result = insert.run(...columns.map((column) => row[column] ?? null))
            if (result.changes > 0) {
              detail[key as keyof typeof detail]++
              imported++
            } else {
              skipped++
            }
          } catch (err) {
            skipped++
            skippedItems.push({
              kind: key,
              title: String(row.id ?? row.rule_key ?? row.version ?? ''),
              why: err instanceof Error ? err.message : String(err)
            })
          }
        }
      }
      // 项目正文与修订历史分开恢复：这里还原当前正文，不额外制造修订记录。
      for (const proj of data.projects ?? []) {
        const mappedId = projectIdMap.get(proj.id)
        if (mappedId && importedProjectIds.has(proj.id)) {
          getDatabase().prepare('UPDATE projects SET handoff_markdown = ? WHERE id = ?')
            .run(proj.handoffMarkdown ?? '', mappedId)
        }
      }
    }

    // ── 8) 设置（覆盖当前设置） ──
    /**
     * 走 `importFrom` 而不是 `update`（1.0.38 修）。
     *
     * `update` 会把备份 JSON 里的键原样写进库：
     * ① 缺的字段变 undefined → 被 String() 落成 `"undefined"` → 读回 NaN；
     * ② 没有白名单 → 一份备份就能改掉 autoStart / globalShortcut，
     *    而这两项连 agent 走 `ui set` 都被 `config` 档拦着，
     *    备份导入反倒成了绕过那道门禁的旁路。
     * 被丢弃的项要能报出来，静默吞掉正是"导入坏得没声音"的成因。
     */
    if (data.settings) {
      settingsImport = this.settingsRepo.importFrom(data.settings)
    }

    return {
      imported,
      skipped,
      detail,
      ...(settingsImport ?? {}),
      preImportBackup,
      ...(reusedCategories ? { reusedCategories } : {}),
      ...(skippedItems.length ? { skippedItems } : {})
    }
  }
}

/**
 * 按层级给待办排序：父任务排在子任务之前
 *
 * 为什么要排：子任务的 `parentId` 指向父任务，而父任务若还没落库，
 * 外键会失败（或在开启 G1 时被拦）。备份里的顺序不保证父在前。
 *
 * 用"轮转剥离"而不是通用拓扑排序：层级实测很浅（最深 2 层），
 * 环状 parentId 属损坏数据，用轮转能自然终止而不会死循环 ——
 * 拓扑排序遇到环要么报错要么需要额外处理，对这个场景是过度设计。
 */
function orderByDepth(todos: Todo[]): Todo[] {
  const byId = new Map(todos.map((t) => [t.id, t]))
  const result: Todo[] = []
  const placed = new Set<string>()
  let remaining = todos.slice()

  // 最多转 todos.length 轮，保证有环时也能退出
  for (let round = 0; round < todos.length && remaining.length; round++) {
    const next: Todo[] = []
    for (const t of remaining) {
      // 父已落库（或没有父）→ 本轮可以放
      const ready = !t.parentId || placed.has(t.parentId) || !byId.has(t.parentId)
      if (ready) {
        result.push(t)
        placed.add(t.id)
      } else {
        next.push(t)
      }
    }
    // 本轮一个都没放下（成环或父不存在于备份里）→ 剩下的直接按原序收尾，
    // 不因为排序问题让数据导不进来
    if (next.length === remaining.length) {
      result.push(...next)
      break
    }
    remaining = next
  }

  return result
}
