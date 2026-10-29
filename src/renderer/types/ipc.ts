import type {
  Todo,
  CreateTodoInput,
  UpdateTodoInput,
  TodoTransition,
  TodoRestoreResult,
  TodoComment,
  CommentKind,
  TimelineEntry,
  ReviewDiffItem,
  Agent,
  AgentGrant,
  GrantScope,
  GrantStatus
} from './todo'
import type { Category, CategoryCreateInput } from './category'
import type {
  Project,
  ProjectDetail,
  ProjectSearchResult,
  HandoffRevision,
  HandoffProposal,
  CreateProjectInput,
  UpdateProjectInput,
  ProjectPurgeResult,
  ProjectDocListResult,
  ProjectDocContent
} from './project'
import type {
  Release,
  ReleaseDetail,
  CreateReleaseInput,
  UpdateReleaseInput
} from './release'
import type { AppNotification, InboxNotification, InboxPage, NotificationType } from './notification'
import type { AppSettings, WindowBounds, WindowPosition } from './settings'
import type { TodoStatus } from './enums'
import type { Memo } from './memo'

/** IPC 通道类型映射 */
export interface UpdateStatus {
  status: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error'
  currentVersion: string
  availableVersion: string | null
  releaseDate: string | null
  progressPercent: number | null
  errorMessage: string | null
  checkedAt: string | null
}

export interface IPCChannels {
  // ── 待办事项 ──
  'todo:create': { input: CreateTodoInput; result: Todo }
  'todo:update': { input: UpdateTodoInput; result: Todo }
  'todo:delete': { input: { id: string }; result: void }
  /**
   * 撤销删除（1.0.48）：把删除时的完整快照原样放回库里。
   * 走"快照回插"而不是软删 —— 见 TodoRepository.restore 的取舍说明。
   */
  /**
   * 回执是"主体 + 上下文"的账（1.0.111，卡 `df06e4d7`）：评论恢复了几条、
   * 哪些子事项挂回了旧父级、哪些因为已被改派而没挂回去（`conflicts`）——
   * 界面要照着它如实反馈，不能只回一句"成功"。
   */
  'todo:restore': { input: { todo: Todo }; result: TodoRestoreResult }
  /** 挂了几个子任务 —— 删父任务前用它弹二次确认 */
  'todo:childCount': { input: { id: string }; result: number }
  'todo:batchUpdateStatus': { input: { ids: string[]; status: TodoStatus }; result: void }
  /** 批量改（逐条执行；failed 说清哪几条没成、为什么）—— 2026-09-24 主用户拍板的批量能力 */
  'todo:batchUpdate': {
    input: { ids: string[]; patch: Omit<UpdateTodoInput, 'id'> }
    result: { updated: string[]; failed: { id: string; title: string; reason: string }[] }
  }
  'todo:batchDelete': {
    input: { ids: string[] }
    result: { deleted: string[]; failed: { id: string; title: string; reason: string }[] }
  }
  'todo:list': {
    input: { status?: TodoStatus; categoryId?: string; keyword?: string }
    result: Todo[]
  }
  'todo:getById': { input: { id: string }; result: Todo | null }
  /**
   * 状态流转（动态视图的"中间流转"节点用 / 详情抽屉的"这件事怎么走过来的"用）
   *
   * 不传 limit 走主进程默认（300 条，append-only 表上够动态回看很久）。
   * 传 todoId 则只看这一条的流转（旧→新）；不传是全局最近流转。
   */
  'todo:listTransitions': {
    input: { limit?: number; todoId?: string }
    result: TodoTransition[]
  }
  /**
   * 一条事项的完整变更时序（1.0.62）：流转 + 审计合并成一条线，旧→新。
   *
   * 与上面的 `todo:listTransitions` 的分工：那条只给**状态流转**（动态视图与
   * 详情抽屉各在用），这条额外合并了**审计事件**（谁改了描述、谁删了哪条评论），
   * 并已翻译成人话（`what` 字段可直接渲染，不要再在渲染层拼句子）。
   *
   * ⚠️ `timelineSeq` 是权威顺序（同一毫秒时按稳定序），**不要按 `at` 重排**。
   */
  'todo:timeline': {
    input: { todoId: string }
    result: TimelineEntry[]
  }
  /**
   * 事项评论（1.0.54）：规格留在 description，往来都走评论。
   * 读：某条事项的评论线程（旧→新）；写：发评论 / 删除评论。
   * 计数：看板一次算完多条事项的评论数，避免逐卡查询。
   */
  'todo:comments': { input: { todoId: string }; result: TodoComment[] }
  'todo:commentCounts': { input: { todoIds: string[] }; result: Record<string, number> }
  'todo:addComment': {
    input: {
      todoId: string
      body: string
      parentId?: string | null
      kind?: CommentKind
    }
    result: TodoComment
  }
  'todo:deleteComment': { input: { id: string }; result: void }

  /**
   * 「本次变更」（1.0.73，主用户提单 `482e4b03`）
   *
   * 验收时看**这一次交付改了什么**（描述追加 / 状态 / 字段），
   * 而不是这条事项的全部历史。`null` = 这条还没交付过（从没进过待验收）。
   */
  'todo:reviewDiff': { input: { todoId: string }; result: ReviewDiffItem[] | null }

  // ── 分类标签 ──
  'category:create': { input: CategoryCreateInput; result: Category }
  'category:update': { input: { id: string; name?: string; color?: string }; result: Category }
  /**
   * 删除标签不会带走待办（多值下删除一个标签，待办照常存在），
   * affectedTodos 是有多少条待办失去了这个标签
   */
  'category:delete': { input: { id: string }; result: { affectedTodos: number } }
  /**
   * 合并分类：把 fromId 下所有待办转挂到 toId，再删掉 fromId
   *
   * 这是收拾同义标签（"竞争调研"/"竞品调研"）的唯一手段 ——
   * 只能删不能并的话，删掉一个标签，其下待办就变成没标签的孤儿。
   */
  'category:merge': {
    input: { fromId: string; toId: string }
    result: { movedTodos: number; merged: Category }
  }
  'category:list': { input: void; result: Category[] }
  'category:reorder': { input: { ids: string[] }; result: void }

  // ── 项目（顶层容器）──
  'project:create': { input: CreateProjectInput; result: Project }
  'project:update': { input: UpdateProjectInput; result: Project }
  /** **永久删除**项目：其下事项与全部项目内记录一并清掉（1.0.111 改口径，卡 `c177e466`） */
  'project:delete': { input: { id: string }; result: ProjectPurgeResult }
  'project:list': { input: void; result: Project[] }
  'project:detail': { input: { id: string }; result: ProjectDetail | null }
  'project:search': { input: { id: string; query: string }; result: ProjectSearchResult[] }
  /** 全局关键词搜索，可限定多个项目；覆盖事项历史与评论。 */
  'project:searchAll': { input: { query: string; projectIds?: string[] }; result: ProjectSearchResult[] }
  /** 接手说明修订历史（36b44adb）：倒序，含全文（界面做行级差异要用） */
  'project:handoffRevisions': {
    input: { id: string; limit?: number }
    result: HandoffRevision[]
  }
  /** 回滚 = 把某一版写成**新的一次保存**（kind=rollback，不删中间版本）；changed=false 表示该版已是当前内容 */
  'project:handoffRollback': {
    input: { id: string; revisionId: string }
    result: { project: Project; revision: HandoffRevision | null; changed: boolean }
  }
  /** Agent 提议接手说明修改；审批页查询与主用户决定。 */
  'project:handoffProposals': { input: void; result: HandoffProposal[] }
  'project:handoffDecide': {
    input: { id: string; decision: 'approved' | 'rejected'; body?: string }
    result: HandoffProposal
  }
  /** 选择并关联项目的本地 Markdown 文档目录（方案 C：只读索引与渲染；卡 a3bd40d8 / 095b2006） */
  'project:pickDocsDir': { input: { id: string }; result: Project | null }
  /** 列出项目关联文档目录下的 .md 文件 */
  'project:listDocs': { input: { id: string }; result: ProjectDocListResult }
  /** 读取项目关联文档目录下的某篇 .md 文件正文 */
  'project:readDoc': { input: { id: string; file: string }; result: ProjectDocContent }
  /** 用系统程序打开项目的文档目录或其中某篇文档 */
  'project:openDocExternal': { input: { id: string; file?: string }; result: { opened: string } }

  // ── 版本（1.0.73：版本从"一个字段"涨成"一个对象"）──
  'release:list': { input: { projectId?: string | null } | void; result: Release[] }
  'release:detail': { input: { projectId: string; version: string }; result: ReleaseDetail | null }
  'release:create': { input: CreateReleaseInput; result: Release }
  'release:update': { input: UpdateReleaseInput; result: Release }
  /** 按项目与版本删除登记；有关联事项时拒绝删除，orphanTodos 保留兼容字段 */
  'release:delete': {
    input: { projectId: string; version: string }
    result: { deleted: string; orphanTodos: number }
  }

  // ── 备忘（memo，AI 给人递的纸条）──
  'memo:list': { input: void; result: Memo[] }
  'memo:ack': { input: { id: string }; result: Memo | null }
  'memo:unreadCount': { input: void; result: number }
  /** 备忘转待办（R4-5）：把一条备忘落成正式待办，并把备忘标为已读 */
  'memo:toTodo': {
    input: { id: string }
    result: { id: string; title: string; memoId: string }
  }
  /** 备忘删除（1.0.48 给通知详情页；此前只有 CLI 能删） */
  'memo:delete': { input: { id: string }; result: boolean }

  // ── 通知中心（1.0.48，五类事件一个收件箱：提醒/审批申请/执行回执/备忘/待验收交付）──
  'notification:list': { input: { limit?: number } | void; result: AppNotification[] }
  /**
   * 角标（侧栏「通知」那个数）。`reader` = **这是谁**的未读（卡 `c13dbb16`）：
   * 界面一律传 `'human'`；不传 = 旧的全局口径（一份 `status`，谁先读都算读过）。
   */
  'notification:unreadCount': { input: { reader?: string } | void; result: number }
  /** 点开一条：带 `reader` 时同时记进 `read_by`（按主体）与全局位 */
  'notification:markRead': { input: { id: string; reader?: string }; result: boolean }
  'notification:markAllRead': { input: { type?: NotificationType | null; reader?: string } | void; result: number }
  /**
   * 通知按事项反查项目，供项目动态与全局系统通知分流。
   * 1.0.107 起给的是**一页 + 三个计数**（卡 `cba46119`）：`rows` 之外还有
   * `matched` / `truncated` / `nextOffset` / `byType` / `unread`，
   * 界面才说得清"还有 N 条"，也才不用在渲染侧对一页去数。
   * `reader`（卡 `c13dbb16`）只影响**未读那几个数**：列表照旧把已读的也列出来。
   */
  'notification:listWithProject': {
    input: { limit?: number; offset?: number; projectId?: string | null; type?: NotificationType | null; reader?: string } | void
    result: InboxPage
  }
  /** 只将指定项目的通知标为已读；`type` 给"本类已读"用，`reader` 给"清谁的那一份"用。 */
  'notification:markProjectRead': {
    input: { projectId: string; type?: NotificationType | null; reader?: string }; result: number
  }
  /** 评论中明确 @ 某人的待回应入口。 */
  'comment:waitingFor': { input: { actor: string; repliedOnly?: boolean }; result: TodoComment[] }

  // ── 设置 ──
  'settings:get': { input: void; result: AppSettings }
  /** warning：副作用失败时的提示（如全局快捷键已被其它程序占用） */
  'settings:update': {
    input: Partial<AppSettings>
    result: { settings: AppSettings; warning?: string }
  }
  'settings:resetVisual': { input: void; result: AppSettings }

  // ── 窗口控制 ──
  'window:showQuickAdd': {
    /** status 用于"在某一列内新增"，projectId 指定新增事项归属；commentId 将抽屉定位到原评论 */
    input: { todoId?: string; status?: TodoStatus; projectId?: string; commentId?: string }
    result: void
  }
  /** 1.0.48：主窗口是多视图容器，view 落对应内容区（board/notifications/stats/settings/user） */
  'window:showKanban': { input: { view?: string } | void; result: void }
  'window:hideQuickAdd': { input: void; result: void }
  /**
   * 按内容高度调整快速新增窗口
   *
   * 窗口高度此前写死 380，而内容在"详细版 + 选填项"全展开时超过 500px，
   * 加上容器是垂直居中 —— 超出部分**上下同时**被裁（打开已有任务详情时必现）。
   * 所以让渲染层量出真实高度再回报，而不是猜一个够大的固定值。
   */
  'window:resizeQuickAdd': { input: { height: number; width?: number }; result: void }
  'window:hideKanban': { input: void; result: void }
  /**
   * 开关悬浮面板
   *
   * 由主进程判可见性（渲染层读不到别的窗口状态），anchor 是悬浮球的
   * 屏幕坐标，面板据此决定往左还是往右展开。
   */
  'window:togglePanel': { input: { anchor?: { x: number; y: number } }; result: void }
  'window:showPanel': { input: { anchor?: { x: number; y: number } }; result: void }
  'window:hidePanel': { input: void; result: void }
  /**
   * 1.0.48：设置/统计独立窗口退役，通道保留做语义映射——
   * section='agent-approval' 落用户页，其余落设置视图；showStats 落统计视图。
   */
  'window:showSettings': { input: { section?: string } | void; result: void }
  'window:showStats': { input: void; result: void }
  'window:hideReminderBanner': { input: void; result: void },
  /**
   * 横幅按内容高度自适应（1.0.117，卡 `21f171f1`）
   *
   * 高度此前写死 104 —— 授权横幅的"谁想干什么 + 目标 + 回执 + 五个按钮"放不下，
   * 标题被 line-clamp-2 截掉的那一截恰好是目标名，人等于在看不全的信息上点头。
   * 渲染层量自己，主进程夹到 [104, 360] 并保持宽度与位置不变。
   */
  'window:fitReminderBanner': { input: { height: number }; result: void }
  'window:savePosition': {
    input: { window: string; bounds: WindowBounds | WindowPosition }
    result: void
  }
  'window:setIgnoreMouseEvents': { input: { ignore: boolean }; result: void }
  /** 无边框窗口的自定义控制按钮，作用于发起调用的窗口自身。回传最新最大化状态，省掉渲染层猜 */
  'window:control': {
    input: { action: 'minimize' | 'toggleMaximize' | 'close' }
    result: { maximized: boolean }
  }
  /** 当前窗口是否最大化（挂载时同步一次，避免按钮图标与实际状态相反） */
  'window:state': { input: void; result: { maximized: boolean } }

  // ── 应用 ──
  /** 退出整个应用（含托盘与定时器），不是只关掉当前窗口 */
  'app:quit': { input: void; result: void }

  // ── 提醒 ──
  'reminder:snooze': { input: { todoId: string; minutes: number }; result: void }
  'reminder:dismiss': { input: { todoId: string }; result: void }

  // ── 本地使用埋点（只写本地，出口仅「导出」，无自动上传） ──
  'telemetry:stats': {
    input: { since?: string; until?: string; category?: string }
    result: unknown
  }
  'telemetry:export': {
    input: { since?: string; until?: string; category?: string; limit?: number }
    result: Array<Record<string, unknown>>
  }
  'telemetry:clear': { input: { before?: string }; result: { removed: number } }

  /** 给其他 AI 助手的接入说明（Markdown，路径由主进程按本机实际安装位置生成） */
  'cli:agentGuide': { input: void; result: string }
  /**
   * 本机真实接入地址（1.0.132，卡 `25caac02`）：供开场提示词自带入口用。
   *
   * 产品不写用户 PATH（2cc71a13），所以 dp 在没接过 DeskPartner 的机器上**不存在** ——
   * 提示词若只说"运行 dp skill"，第一次接入的 agent 第一步就会拿到
   * command not found。路径一律由主进程推导，界面不参与拼接。
   */
  'cli:connectInfo': {
    input: void
    result: { cliPath: string; cliEnvVar: string; cliEnvAvailable: boolean; mcpCommand: string }
  }
  /** 用户页协作协议；global 是默认值，project 只覆盖指定区块 */
  'protocol:get': { input: { projectId?: string } | void; result: { scope: string; blocks: Array<Record<string, unknown>>; gates: unknown } }
  'protocol:set': { input: { projectId?: string; blockKey: string; body: string; confirmed?: boolean }; result: Record<string, unknown> }
  'protocol:proposals': { input: void; result: Array<Record<string, unknown>> }
  'protocol:revisions': { input: { projectId?: string; blockKey?: string } | void; result: Array<Record<string, unknown>> }
  'protocol:rollback': { input: { id: string }; result: Record<string, unknown> }
  'protocol:decide': { input: { id: string; decision: 'approved' | 'rejected'; body?: string }; result: Record<string, unknown> }
  /** 用户页主用户档案；项目范围只覆盖 boundaries / completion */
  'profile:get': { input: { projectId?: string } | void; result: { scope: string; blocks: Array<Record<string, unknown>> } }
  'profile:set': { input: { projectId?: string; blockKey: string; body: string }; result: Record<string, unknown> }
  'profile:proposals': { input: void; result: Array<Record<string, unknown>> }
  'profile:revisions': { input: { projectId?: string; blockKey?: string } | void; result: Array<Record<string, unknown>> }
  'profile:rollback': { input: { id: string }; result: Record<string, unknown> }
  'profile:decide': { input: { id: string; decision: 'approved' | 'rejected'; body?: string }; result: Record<string, unknown> }
  'rules:get': { input: { projectId?: string } | void; result: { scope: string; projectId: string | null; rules: Array<Record<string, unknown>>; permissions: Array<Record<string, unknown>> } }
  'rules:setRule': { input: { projectId?: string; ruleKey: string; enforcement: string }; result: Record<string, unknown> }
  'rules:setPermission': { input: { projectId?: string; action: string; subject: string; decision: string }; result: Record<string, unknown> }
  'rules:resetRule': { input: { projectId?: string; ruleKey: string }; result: Record<string, unknown> }
  'rules:revisions': { input: { projectId?: string; ruleKey?: string } | void; result: Array<Record<string, unknown>> }
  'rules:rollback': { input: { id: string }; result: Record<string, unknown> }
  'rules:proposals': { input: void; result: Array<Record<string, unknown>> }
  'rules:decide': { input: { id: string; decision: 'approved' | 'rejected'; enforcement?: string }; result: Record<string, unknown> }
  /** 版本与数据目录（设置·系统组展示与迁移） */
  'app:info': { input: void; result: { version: string; dataDir: string } }
  'app:openDataDir': { input: void; result: { opened: boolean; dataDir: string } }
  'app:pickDataDir': { input: void; result: { canceled: boolean; targetDir: string | null } }
  'app:changeDataDir': { input: { targetDir?: string } | void; result: { changed: boolean; dataDir: string; previousDir?: string } }
  'app:pickAppIcon': { input: void; result: { canceled: boolean; dataUrl: string | null } }
  'app:getUpdateState': { input: void; result: UpdateStatus }
  'app:checkForUpdates': { input: void; result: UpdateStatus }
  'app:downloadUpdate': { input: void; result: UpdateStatus }
  'app:quitAndInstallUpdate': { input: void; result: { quitting: boolean } }

  /** 已注册的 agent 身份（视角切换的选项来源）—— 选项问数据要，不写死 */
  'agent:list': { input: void; result: Agent[] }
  /** 批准 / 收回 agent 的写权限；只能由界面发起（CLI 没有对应命令，防自批） */
  'agent:setApproved': { input: { id: string; approved: boolean }; result: Agent | null }
  /**
   * 拒绝 / 撤销拒绝一个未批准的身份（同上，只能由界面发起）。
   * 「不想批准它」也得是一次能做完结的动作，否则它永远挂在角标上。
   */
  'agent:setRejected': { input: { id: string; rejected: boolean }; result: Agent | null }
  /** 授权记录（撤销与审计）：谁申请过改界面/删除、批了没、用掉没有 */
  'agent:listGrants': {
    input: { agentId?: string; scope?: GrantScope; status?: GrantStatus; activeOnly?: boolean; limit?: number } | void
    result: AgentGrant[]
  }
  /** 审批历史：在数据层筛选并分页，不使用固定上限的前端切片。 */
  'agent:listGrantHistory': {
    input: { agentId?: string; scope?: GrantScope; status?: GrantStatus; activeOnly?: boolean; offset: number; limit: number; from?: string; until?: string; query?: string; execution?: 'ok' | 'error' | 'none'; resolvedBy?: string; createdFrom?: string; createdUntil?: string; agentQuery?: string }
    result: { rows: AgentGrant[]; total: number; offset: number; limit: number }
  }
  /** 四类审批事项统一的服务端分页历史。 */
  'approval:listHistory': {
    input: { offset: number; limit: number; type?: 'agent' | 'grant' | 'profile' | 'protocol' | 'handoff' | 'rules'; decision?: 'pending' | 'approved' | 'rejected' | 'expired' | 'revoked'; execution?: 'success' | 'failure' | 'unknown' | 'not_required'; agentQuery?: string; projectId?: string; from?: string; until?: string; query?: string }
    result: { rows: Array<{ id: string; type: 'agent' | 'grant' | 'profile' | 'protocol' | 'handoff'; agentId: string; agentName: string; projectId: string | null; createdAt: string; activityAt: string; decision: 'pending' | 'approved' | 'rejected' | 'expired' | 'revoked'; decidedBy: string | null; decidedAt: string | null; scope: string | null; summary: string; originalBody: string | null; proposedBody: string | null; decidedBody: string | null; execution: 'success' | 'failure' | 'unknown' | 'not_required'; execError: string | null; execSummary: string | null; requestArgv: string[] }>; total: number; offset: number; limit: number }
  }
  /**
   * 人对一条授权申请表态；只能由界面发起。
   *
   * 1.0.45 起 allow=true 的语义是「**允许并执行**」—— 主进程会立刻把
   * 这条申请记录的命令跑掉，并把回执放在 `execution` 里。界面上必须显示它，
   * 否则人不知道自己点的这一下到底做成了什么。
   */
  'agent:resolveGrant': {
    input: { grantId: string; allow: boolean; longTerm?: boolean; withForce?: boolean }
    result: {
      grant: AgentGrant | null
      /**
       * `message` 是**给人看**的那一句（1.0.117，卡 `0dfff6df`）：
       * 批准之后要回答的是"删掉了什么、子任务怎么办"，不是把命令行再念一遍。
       * `details` 是命令行原文，界面上折在回执下面的小字里 ——
       * 审计要原文，但人读回执时不该先看到 uuid。
       */
      execution: {
        ok: boolean
        skipped: boolean
        message: string
        details?: string
        canForce?: boolean
      } | null
    } | null
  }
  /** 撤销：收回还没用掉的授权 */
  'agent:revokeGrants': { input: { id: string; scope?: GrantScope }; result: number }

  // ── 数据备份 ──
  'backup:export': { input: void; result: string }
  /**
   * 导入回执（1.0.46 补齐）
   *
   * 此前只有 imported/skipped 两个数字 —— 而"导入成功"和"导入了一部分"
   * 在界面上长得一模一样。演练时正是靠这个含糊的回执误判了恢复结果。
   * 现在把"各表进了多少 / 哪些被跳过、为什么 / 原件备份在哪"都带出来。
   */
  'backup:import': {
    input: { data: string }
    result: {
      imported: number
      skipped: number
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
      settingsAccepted?: string[]
      settingsRejected?: { key: string; why: string }[]
      preImportBackup?: string | null
      skippedItems?: { kind: string; title: string; why: string }[]
      /** 按名字复用（而非新建）的已有分类数量：换机恢复时会命中 */
      reusedCategories?: number
    }
  }

  // ── 事件推送（主进程→渲染进程） ──
  'event:reminderTriggered': {
    input: void
    result: { todoId: string; title: string; categoryName: string }
  }
  'event:dataChanged': {
    input: void
    result: {
      /**
       * 'agent_register'（1.0.63）：新 agent 自助注册完了，界面该重拉身份名册。
       * 它没有"写入"语义，但同样属于"别的进程改了库、你该刷新"——
       * 漏掉它的后果是用户页/审批页要等下一次 5 秒轮询才看得到新成员。
       */
      type:
        | 'todo'
        | 'category'
        | 'project'
        | 'settings'
        | 'memo'
        | 'grant'
        | 'notification'
        | 'agent_register'
    }
  }
  /** 窗口最大化状态变化（双击标题栏、系统快捷键都会触发，渲染层靠它同步按钮图标） */
  'event:windowState': { input: void; result: { maximized: boolean } }
}

/** IPC 通道名称类型 */
export type IPCChannelName = keyof IPCChannels

/** 获取通道的输入类型 */
export type IPCInput<K extends IPCChannelName> = IPCChannels[K]['input']

/** 获取通道的返回类型 */
export type IPCResult<K extends IPCChannelName> = IPCChannels[K]['result']
