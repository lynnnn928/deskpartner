import type { TodoStatus, TodoPriority, TodoType } from './enums'

/**
 * 归属者
 *
 * 约定与埋点 `usage_events.actor` 一致，将来做统计时可直接关联：
 *   'human'            用户自己
 *   'agent:<id>'       某个 agent，如 agent:alice
 *
 * 这是**归属标注，不是身份认证** —— 本机任何进程都能自称某个 agent。
 */
export type TodoOwner = 'human' | `agent:${string}`

/**
 * 提出者 / 执行者（v12 起，拆自原 owner）
 *
 * owner 此前混着两层语义："这条是谁记的"和"这条该谁干"。
 * agent 帮人登记的事（owner=agent:x）实际是"agent 提出、人去执行"，
 * 只看 owner 会把它错读成 agent 自己的活。
 *
 * - createdBy：提出者 = 谁把这条记下来的（原 owner 的真正语义，迁移时全量回填）
 * - executedBy：执行者 = 谁去干。**null 表示执行者就是提出者**（提出即执行，
 *   绝大多数事项如此），只有显式指派给别人才写 —— "agent 报了 bug 给我修"
 *   才会出现 createdBy=agent:x、executedBy=human。
 *
 * 依旧是**归属标注，不是身份认证**。
 */

/** 待办事项 */
export interface Todo {
  id: string
  title: string
  /**
   * 解决于哪个版本（1.0.59，schema v24）
   *
   * 回答「这个版本收口了哪些问题」/「这条在哪个版本修好的」。
   * null = 尚未标注（存量数据全是 null）。
   *
   * 它不是"状态"：标注版本不代表已验收，验收仍是 awaiting_review → done。
   * 两者合起来才回答完整 —— 版本说"哪一版收口"，状态说"验没验收"。
   *
   * 标注时机的两种读法（都对，靠 status 区分）：
   * - 立项时就标 = 「这一版计划做它」→ 发版前筛该版本即可看"准备处理哪些"；
   * - 做完再标     = 「这一版收口了它」→ 发版后筛该版本即为改版清单。
   */
  fixedInVersion: string | null
  /** 详细描述，仅详细版编辑弹窗可见，卡片上不展示 */
  description: string | null
  /** 所属项目（顶层容器），null 表示未归入任何项目 */
  projectId: string | null
  /** 父需求（自引用）。null 表示这是顶层事项 */
  parentId: string | null
  /**
   * 所属标签（多值）
   *
   * 一条待办可以同时关联多个方向：既属于某个大类，又服务于某个功能模块。
   * 单值分类表达不了这种"一石多鸟"，所以 v9 起改为数组。
   */
  categoryIds: string[]
  /**
   * 主标签 = categoryIds[0]，**派生属性，勿写**
   *
   * 卡片要显示颜色/名字时总得挑一个，就取第一个。
   * 它是从 categoryIds 算出来的、不落库（库里已无 category_id 列），
   * 所以不存在"两处存储不一致"的问题 —— 这是派生，不是第二份真相。
   */
  categoryId: string
  status: TodoStatus
  priority: TodoPriority
  /** 事项类型：bug / feature / task（默认 task，task 在界面上不显示徽标） */
  type: TodoType
  /** 提出者：谁记的这条（原 owner，v12 起拆分） */
  createdBy: TodoOwner
  /** 执行者：谁去干。null = 执行者即提出者（提出即执行） */
  executedBy: TodoOwner | null
  /**
   * 验收者：谁来判断"这件事做完了、可以收口"（`a6032512`，schema 26 起）
   *
   * 三个角色：**提出者**（记下这件事）/ **执行者**（去干）/ **验收者**（判它做完了）
   *
   * 为什么要第三个角色：原先按「身份」定权 —— 验收通过只能由人点，
   * 而人能验的只有界面/体验类，CLI 与内部机制类缺陷验不了
   * （实测 7 张待验收里 5 张卡在"等人点完成"）。改为按角色定权：
   * **运动员不当裁判**（验收者 ≠ 执行者），而不是"人一律得当裁判"。
   *
   * 默认 = 提出者（多数卡是 agent 提、人执行 → 默认验收者就是 agent 自己，
   * 于是"验收者 ≠ 执行者"天然成立）。要防的"自己提出自己验收"
   * 只在**显式指定** verifier 时才可能出现。
   *
   * 同样是**归属标注，不是身份认证**。
   */
  verifier: TodoOwner
  /** 截止时间，null 表示未设置 */
  dueAt: string | null
  remindAt: string | null
  isPinned: boolean
  createdAt: string
  updatedAt: string
  completedAt: string | null
}

/**
 * 撤销删除时"没能一起回来"的那一条（1.0.111，卡 `df06e4d7`）
 *
 * 撤销**不是全有全无**：4 秒窗口内子事项可能已经被改派给别人，
 * 那时把它的 `parent_id` 拨回旧父级，等于用旧关系覆盖人的新决定。
 * 所以这里的处置是"保留新关系 + 报回来"，但绝不静默 —— 见
 * `TodoRestoreResult.conflicts`。
 */
export interface TodoRestoreConflict {
  id: string
  /** 界面上认得出来的名字（对象已被删时回落成 id） */
  title: string
  /** 说清是哪一种：已被指派给 xxx / 子事项已不存在 */
  reason: string
}

/**
 * 撤销删除的回执（1.0.111，卡 `df06e4d7`）
 *
 * 起因是一次"撤销了、上下文却丢了"的故障：`todo_comments` 随事项级联删除、
 * 子事项的 `parent_id` 被置空，而撤销只把**主体**放回来 ——
 * 人得到的是"看着一样、其实少了一半"的事项，界面上还没有任何痕迹。
 *
 * 所以回执不再只是那一条 `Todo`：评论恢复了几条、哪些子事项挂回了旧父级、
 * 哪些因为已被改派而**没**挂回去，都要能说清，界面照着它如实反馈。
 */
export interface TodoRestoreResult {
  todo: Todo
  /** 恢复回来的评论条数（老墓碑里没有评论数据时为 0） */
  commentsRestored: number
  /** 被重新挂回旧父级的子事项 id */
  childrenRelinked: string[]
  /** 保留了新关系、没挪回去的子事项；空数组 = 全部恢复 */
  conflicts: TodoRestoreConflict[]
}

/**
 * 一次状态流转（v14 起，todo_transitions 表）
 *
 * 动态里"中间的流转"的数据来源：谁在什么时候把这条事项从哪个状态推到了哪个。
 * append-only —— 改标题、改优先级不记，只有状态真的变了才多一行。
 *
 * 与主进程 `TodoRepository.TodoTransition` 结构一致（IPC 传 JSON，各声明各的，
 * 用测试锁住两侧字段不漂移）。
 */
export interface TodoTransition {
  id: string
  todoId: string
  /** 流转前的状态；null = 新建（此前没有状态） */
  fromStatus: TodoStatus | null
  toStatus: TodoStatus
  /** 动作人（human / agent:<id>）；null = 未记录，动态里如实显示，不猜 */
  actor: string | null
  createdAt: string
  /**
   * 这次「待验收 → 进行中」是不是**驳回**（1.0.72，迁移 30）
   *
   * 三态：`true` 驳回 / `false` 只是自己收回 / `null` 未记录（老数据）。
   * 动态里必须区分 `false` 与 `null` —— 前者是"推进"，后者是"不知道"。
   */
  isRejection: boolean | null
}

/** 评论作者类型：人 / agent / 系统 */
export type CommentAuthorType = 'human' | 'agent' | 'system'

/** 评论种类：普通 / 驳回 / 返工 / 系统 */
export type CommentKind = 'comment' | 'reject' | 'rework' | 'system'

/**
 * 一条变更时序（1.0.62）：流转 + 审计合并成一条线，旧→新
 *
 * `what` 已在主进程翻译成人话（谁·何时·对什么做了什么），**渲染层直接显示，
 * 不要再拼句子** —— 拼一份到第二个地方，就是下一个"写了却读不出"。
 *
 * 与主进程 `lib/audit-text.ts` 的 `TimelineEntry` 结构一致（IPC 传 JSON，
 * 各声明各的，用测试锁住两侧字段不漂移）。
 */
export interface TimelineEntry {
  /** ISO 时间；绝对时间由 `formatTime` 渲染 */
  at: string
  /** 动作人（human / agent:<id> / 进程标识）；空串 = 未记录，如实显示不猜 */
  actor: string
  /** 粗分类：流转 / 改描述 / 删评论 / 删事项 / 其他事件类型原样 */
  kind: string
  /** 人话描述，可直接渲染 */
  what: string
  /** 权威顺序（同一毫秒时按稳定序）；**展示时按它排，不要按 at 重排** */
  timelineSeq: number
}

/**
 * 事项评论（1.0.54）
 *
 * 与 `description` 的边界：description = 规格（可编辑、应稳定），
 * 评论 = 往来（只增不改，是审计线索）。
 * 与主进程 `CommentRepository.TodoComment` 结构一致（IPC 传 JSON，各声明各的，
 * 用测试锁住两侧字段不漂移）。
 */
export interface TodoComment {
  id: string
  todoId: string
  /** 回复的父评论 id（楼中楼）；顶层为 null */
  parentId: string | null
  authorType: CommentAuthorType
  /** 具体身份：agent:<id> 或 human；系统评论为 null */
  authorId: string | null
  body: string
  kind: CommentKind
  createdAt: string
}

/**
 * 一次字段变化（1.0.73，`482e4b03`）
 *
 * 与主进程 `lib/field-changes.ts` 的 `FieldChange` 结构一致
 * （IPC 传 JSON，各声明各的，用测试锁住两侧字段不漂移）。
 */
export interface FieldChange {
  /** 字段名（与 Todo 结构的 camelCase 一致） */
  field: string
  /** 改之前的值；null = 原先没有 */
  before: string | null
  /** 改之后的值；null = 清空 */
  after: string | null
}

/** 描述 diff 的一行（1.0.73） */
export interface DiffLine {
  /** `add` = 本次新增；`same` = 原有（只在需要上下文时少量带上） */
  type: 'add' | 'same'
  text: string
}

/**
 * 「本次变更」里的一条（1.0.73，`482e4b03`）
 *
 * `summary` 已在主进程翻译成人话（谁·做了什么），**渲染层直接显示，
 * 不要再拼句子** —— 与 `TimelineEntry.what` 同一条判据。
 *
 * 三类各自的**结构**保留在 `lines` / `status` / `fields` 里：
 * 描述要展示逐行新增、状态要展示箭头、字段要展示 before → after。
 * 拍平成一种会把每一类最有价值的那部分信息丢掉。
 *
 * 与主进程 `lib/review-diff.ts` 的 `ReviewDiffItem` 结构一致
 * （IPC 传 JSON，各声明各的，用测试锁住两侧字段不漂移）。
 */
export interface ReviewDiffItem {
  kind: 'desc' | 'status' | 'field'
  /** 发生时间（ISO） */
  at: string
  /** 动作人；空串 = 未记录，如实显示不猜 */
  actor: string
  /** 人话摘要，可直接渲染 */
  summary: string
  /** 逐行 diff（仅 kind === 'desc' 且能算出来时才有） */
  lines?: DiffLine[]
  /** 状态变更的结构化数据（渲染箭头用） */
  status?: { from: TodoStatus | null; to: TodoStatus; isRejection: boolean }
  /** 字段变更的结构化数据 */
  fields?: FieldChange[]
}

/** 新增待办输入 */
export interface CreateTodoInput {  title: string
  description?: string | null
  /**
   * 解决于哪个版本（v24）。普通新建一般不传；
   * agent 补登记"这条其实在 X 版就修好了"时可用。
   */
  fixedInVersion?: string | null
  /** 项目 id；不传表示不归入项目 */
  projectId?: string | null
  /** 父需求 id；不传表示这是顶层事项 */
  parentId?: string | null
  /** 标签 id 列表；不传则回退到第一个分类（见 TodoRepository.resolveCategoryIds） */
  categoryIds?: string[]
  /** 初始状态，默认 todo。agent 登记"已经做完的事"时传 done */
  status?: TodoStatus
  priority?: TodoPriority
  /** 事项类型，默认 task */
  type?: TodoType
  /** 提出者，默认 human */
  createdBy?: TodoOwner
  /**
   * 验收者。不传 = 默认取提出者（见 Todo.verifier）。
   */
  verifier?: TodoOwner
  /**
   * 执行者。不传 = 执行者即提出者（提出即执行）；
   * null = 显式回到"提出者执行"。
   */
  executedBy?: TodoOwner | null
  dueAt?: string | null
  remindAt?: string | null
  /**
   * 动作人（新建这条流转记录是谁操作的）。
   * 不传回退到提出者 —— 提出者默认 human，agent 不带 --created-by
   * 登记时若无 actor 会把"agent 新建了"错记成"human 新建了"。
   */
  actor?: string | null

  // ── 以下字段**只给备份导入用**（1.0.46） ──
  //
  // 普通新建（界面 / CLI）一律不传：id 由仓库生成、时间戳取当下。
  // 备份恢复是另一回事 —— 它要还原的是**那一刻的库**，不是"重新建一条"。
  // 之前的实现没区分这两种语义，导入走的也是普通 create()，
  // 于是 id 全部重生成、时间戳全部变成导入时刻，历史完全失真。

  /**
   * 指定 id（备份导入用）。
   *
   * 为什么必须能指定：不沿用备份里的 id，`existingTodoIds` 的冲突检测
   * **永远命中不了** —— 每导入一次所有 id 都是新的，重复导入会不断翻倍
   * （204 → 408 → 612），而冲突检测形同虚设。
   */
  id?: string
  /** 原始创建时间（备份导入用）；不传取当下 */
  createdAt?: string
  /** 原始更新时间（备份导入用）；不传取当下 */
  updatedAt?: string
  /** 原始完成时间（备份导入用）；不传按 status 推断 */
  completedAt?: string | null
  /** 是否置顶（备份导入用）；普通新建恒为 false */
  isPinned?: boolean
  /**
   * 跳过候选池守卫（备份导入用）。
   *
   * 恢复的是**已经存在过的数据**，不是"现在提出一件事"：
   * 用 G1/G2 去审一遍历史数据，会让"父需求是 proposed 时子任务导不进来"
   * 这类荒谬结果出现 —— 而这些数据本来就该原样回来。
   */
  skipGuards?: boolean
}

/** 更新待办输入 */
export interface UpdateTodoInput {
  id: string
  title?: string
  description?: string | null
  projectId?: string | null
  parentId?: string | null
  categoryIds?: string[]
  status?: TodoStatus
  priority?: TodoPriority
  type?: TodoType
  /** 改提出者（记错人时的补救） */
  createdBy?: TodoOwner
  /**
   * 验收者。不传 = 保持不变。
   */
  verifier?: TodoOwner
  /**
   * 改执行者：undefined = 未提及（保持原值）；
   * null = 明确清掉指派（回到提出者执行）；具体值 = 指派给某人
   */
  executedBy?: TodoOwner | null
  dueAt?: string | null
  remindAt?: string | null
  /**
   * 解决于哪个版本（v24）。
   *
   * 三态：不传 = 未提及（保持原值）；`null` 或空串 = 清空标注；
   * 字符串 = 标到该版本。发版收口时由人/agent 标上，
   * 之后按版本筛选即可回答"这一版解决了哪些问题"。
   */
  fixedInVersion?: string | null
  isPinned?: boolean
  /**
   * 人已批准这次动作的凭证 id（executeApproved 回放时带上，f5e76697）。
   * 有值 = 这个动作已经过人拍板，G4「离开待确认」的要求已满足 ——
   * 判据从「谁在动」改为「带没带人的批准」，与 088282b2 的承诺对齐。
   * 不落库、不算字段变更（与 ifUpdatedAt 同类：调用方声明的通道事实）。
   */
  preApprovedGrantId?: string
  /**
   * **动作人**：谁做的这次操作（动态里"谁把这条拖到挂起的"要显示的是它）。
   *
   * 与 createdBy（提出者）/ executedBy（执行者）是三个不同的维度：
   * 一条事项可以是 A 提的、B 去干的、C 把它推进到下一列的。
   *
   * 不传则留 NULL —— 动态里如实显示"未记录"，不猜。
   */
  actor?: string | null
  /**
   * 乐观锁（1.0.73，`9947bf5a`）：只在"我还看着这个版本"时才允许改。
   *
   * ## 它治的是什么病
   *
   * 多主体同时改同一条时会**互相覆盖，后写的赢且无人察觉**。
   * 本机有四个写入方（alice / Bob / human / kimi）共写同一份 SQLite
   * 是**当前事实**；`withWriteRetry` 只保证"两个写不打架"，
   * **不保证第二个写的人看到的是第一个写的结果** ——
   * 它把 A 刚改的内容原样盖掉，而 A 和你都不知道。
   * **"无人察觉"正是本项目反复在治的那类病。**
   *
   * ## 用法
   *
   * 先 `todo get <id>` 拿到 `updatedAt`，改的时候带上它：
   * 不一致说明这条在你读之后被别人动过，返回冲突码让你自己决定
   * **重读再改**还是**放弃** —— 而不是替你猜"以谁为准"。
   *
   * ## 为什么是精确字符串比对，而不是解析成时间再比
   *
   * 库里 `updated_at` 存在**两种写法**（实测本机真实库）：
   * JS 路径写 `2026-10-07T09:23:21.587818`（6 位、无 Z），
   * 也有 `2026-10-05T05:30:12.750Z`（3 位、带 Z）—— 历史脚本直改过库。
   * 解析后比较会把"同格式微秒差"与"格式不同"混进同一个语义，
   * 且毫秒截断会让两个不同的 6 位微秒值被当成同一版本。
   * 精确比对天然满足：**没被动过 => 字符串一模一样**。
   *
   * 不传 = 不做这个检查（保持原行为，向后兼容）。
   */
  ifUpdatedAt?: string
  /**
   * 调用来源（G4 候选池闸门用，勿随意传）
   *
   * 'gui' = 界面路径（IPC handler 标注；渲染进程只被人操作，视为人的拍板）；
   * 'cli' = 命令行路径。**不传 = 按 CLI 对待（更严）**：
   * proposed 移出「待确认」会被 G4 硬拦。
   * 渲染层 updateTodo 不需要传——IPC handler 统一盖章，
   * 防止这个标注被调用方伪造或漏传。
   */
  source?: 'gui' | 'cli'
}

/**
 * 已注册的 agent 身份（R3-1）
 *
 * 渲染层不 import 主进程的类型定义（会把 better-sqlite3 那套依赖带进渲染进程），
 * 这里只声明界面真正用到的字段，与主进程 agents 表的列一一对应。
 *
 * `id` 与 todos.createdBy 同形（如 `agent:bob`），关联时不用再拼前缀。
 */
export interface Agent {
  id: string
  displayName: string
  color: string | null
  /** 是否已批准写入：注册只是有名字，批准才给写权限（1.0.35） */
  approved: boolean
  /** 人拒绝过它的时刻：null=还没表态或已批准，有值=已结案，不再算"等你点头" */
  rejectedAt: string | null
  /** 是否已签发凭据：有凭据 = 调用时能自证身份，不再只是自称 */
  hasCredential: boolean
  createdAt: string
  lastSeenAt: string | null
  /** 审计：最近一次**写入**的时刻（读不算 —— 要回答的是"它动过我的数据吗"） */
  lastWriteAt: string | null
  /** 审计：最近一次写入用的命令 */
  lastWriteCmd: string | null
}

/** 授权档位：config=改界面，destructive=删除（1.0.36 分级授权） */
export type GrantScope = 'config' | 'destructive'

/**
 * 授权记录状态。
 *
 * `expired` 是**虚拟状态**（1.0.40）：库里仍存原 status（pending/granted），
 * 读取时按 expiresAt 判定后呈现。带上它而不是静默过滤掉 ——
 * "它申请过、没人理、自己过期了"本身就是审计要的信息。
 */
export type GrantStatus =
  | 'pending'
  | 'granted'
  | 'consumed'
  | 'denied'
  | 'revoked'
  | 'expired'

/** 一条授权记录：谁申请、想干什么、批了没、用掉没有 —— 同时就是审计日志 */
export interface AgentGrant {
  id: string
  agentId: string
  scope: GrantScope
  /** 绑定的会话；NULL = 不限会话（长期授权） */
  sessionId: string | null
  status: GrantStatus
  command: string | null
  /**
   * 申请目标的可读摘要（v18），如 `todo rm「某待办标题」`。
   * v18 之前写入的历史记录为 null，界面需自行降级显示。
   */
  summary: string | null
  /**
   * 本次动作的确切目标集合（v19）。
   * 空数组 = 没有目标概念（旧记录 / 该命令解析不出目标），不参与校验。
   */
  targetIds: string[]
  /** 完整命令行（v20）：批准即执行靠它重建动作 */
  requestArgv: string[]
  /** 服务端代人执行的结果（v20）：null=还没执行，'ok'/'error'=已执行 */
  execStatus: 'ok' | 'error' | null
  /** 执行失败的原因 */
  execError: string | null
  /** 执行成功的输出摘要（v25）：null=老数据没有留下"做成了什么" */
  execSummary: string | null
  executedAt: string | null
  createdAt: string
  resolvedAt: string | null
  resolvedBy: string | null
  /** 到期时间；NULL = 不过期 */
  expiresAt: string | null
}
