import type { TodoStatus } from '../types/enums'

/** 默认色值 */
export const DEFAULT_COLORS = {
  accent: '#5388F6',
  success: '#65C19C',
  reminderGlow: '#82B1FF',
  textPrimary: '#333333',
  textSecondary: '#868E96',
  textDone: '#9CA3AF',
  border: '#E5E7EB',
  bgPrimary: '#F5F7FA',
  bgSecondary: '#FFFFFF',
  bgCard: '#FFFFFF',
  columnTodo: '#EDF2F7',
  columnInProgress: '#F0F7F4',
  columnSuspended: '#F8F5F0',
  columnDone: '#F1F1F1'
} as const

/** 默认悬浮球参数 */
export const DEFAULT_FLOAT_BALL = {
  size: 48,
  /** 默认完全不透明；用户可在设置中自行调低 */
  opacity: 1,
  color: '#5388F6',
  edgeHide: true,
  showIcon: true,
  showGlow: true
} as const

/**
 * 窗口磨砂底色的不透明度（1.0.59，恢复可调，语义改为「显式调过才覆盖预设」）
 *
 * ── 为什么默认不是"跟随预设"就写死一个数 ──
 *
 * 1.0.56 删掉这个设置项后，`--frosted-bg-opacity` 完全归主题预设所有；
 * 1.0.57 修的正是那次删除暴露出来的回归（frosted 预设里 1.0.48 漏改的 0.72）。
 * 所以**默认必须是 null（= 跟随预设）**，而不是"默认 0.88 的第二个硬编码值" ——
 * 否则又回到「同一个效果两条来源」，且那条被掩护的来源迟早再次没人核对。
 *
 * ── 覆盖语义 ──
 *
 * - `null`：行内**不写** `--frosted-bg-opacity`，值由 `themes/*.css` 的预设决定
 *   （此时全库只有一条来源，不会出现"预设值其实没生效"那种静默失效）。
 * - 数值：行内写入并覆盖预设。这是**用户显式拖过滑块**的结果，
 *   行内优先级最高在这里正是想要的行为，不再是意外。
 *
 * 界面提供「跟随预设」复位：把值置回 null，覆盖消失，回到纯预设。
 *
 * 与 `floatBallColor: string | null`（null = 跟随全局强调色）是同一个模式。
 */
export const DEFAULT_BG_OPACITY = {
  /** null = 跟随当前风格预设（默认） */
  override: null as number | null,
  min: 0.3,
  max: 1
} as const

/** 默认看板参数 */
export const DEFAULT_KANBAN = {
  alwaysOnTop: true,
  borderRadius: 20,
  columnHeaderHeight: 'standard' as const,
  cardBorderRadius: 14,
  cardSpacing: 'standard' as const,
  cardActionsAlwaysVisible: false
} as const

/** 默认弹窗参数 */
export const DEFAULT_QUICK_ADD = {
  borderRadius: 18,
  padding: 'standard' as const
} as const

/** 默认分类 */
export const DEFAULT_CATEGORIES = [
  { name: '工作', color: '#5388F6', isDefault: true, sortOrder: 0 },
  { name: '生活', color: '#65C19C', isDefault: true, sortOrder: 1 },
  { name: '学习', color: '#F5A623', isDefault: true, sortOrder: 2 },
  { name: '其他', color: '#CBD5E1', isDefault: true, sortOrder: 3 }
] as const

/** 数据库文件名 */
export const DB_FILENAME = 'user.db'

/**
 * 数据库迁移版本
 *
 * v24（1.0.59）：`todos.fixed_in_version` —— 事项"解决于哪个版本"。
 * 用于回答主用户 2026-09-29 提的两个问题：
 * 「当前版本准备处理哪些」/「发布后具体解决了哪些」。
 *
 * v31（1.0.73）：`releases` 表 —— 版本从"一个字段"涨成"一个对象"。
 * 主用户 2026-10-07 原话：「版本应该不只是一个字段，它应该是一个对象，
 * 那你就可以在这个对象上面去记录说这个版本里边做了什么、关联了哪些卡片」。
 * 与 `todos.fixed_in_version` 靠 version 字符串对齐，各自独立（不编造历史元信息）。
 *
 * v32（1.0.75）：`releases.tested` —— 这一版发版前**跑没跑测试**。
 * `yes`=跑了且过了测试闸门 / `no`=跑了没过 / `skipped`=`--skip-tests` 跳过 / NULL=历史行不知道。
 * 修 `065dcde4`（Carol f6c186b8 验收时指出：skip-tests 的产物事后无从查证）。存量不回填。
 *
 * v33（a2ea95f8）：releases 表重建 —— 版本从"整库一个版本号库"改成**项目下的二级概念**：
 * `PRIMARY KEY (project_id, version)`，跨项目同名版本各是各的（主用户 10-09：「怎么可能
 * A 用了一个版本号，B 就不能用了呢？」）。project_id 变 NOT NULL + 外键 CASCADE
 * （删除项目 = 彻底清空，不留脱钩的孤儿版本）。存量无归属行回填到第一个项目（她已批）。
 *
 * v34：projects.handoff_markdown —— 每个项目一份可编辑接手说明，不存动态状态副本。
 *
 * v35：project_handoff_revisions —— 接手说明的修订历史（36b44adb）。保存即覆盖会让误写无法找回；
 * 现在每次内容有变化的保存留一版全文（含作者/时间/种类），回滚 = 把旧版写成新的一次保存。
 *
 * v37：protocol_blocks —— 用户页协作协议，分全局与项目两级；可编辑约定与代码硬关口分离。
 *
 * v38：profile_blocks —— 主用户档案，分全局与项目两级；项目层只覆盖授权边界与完成标准。
 *
 * v39：profile_proposals —— agent 提议档案修改，待主用户在用户页确认后生效。
 */
export const DB_VERSION = 48

/**
 * 数据变更事件的保留策略
 *
 * 这张表只用于"别的进程改了数据，我要不要刷新"这一件事，
 * 所以只需要保留很短一段时间，超了就没有任何意义。
 */
export const DEFAULT_EVENTS = {
  retentionDays: 7,
  maxRows: 2000,
  /** 轮询间隔（毫秒）。约 1 秒内可见，对桌面工具够用 */
  pollIntervalMs: 800
} as const

/**
 * 本地使用埋点的默认值
 *
 * 数据只写本地、永不外发，所以默认开启是有意义的（自己用就是要拿这份数据）。
 * 但仍然提供关闭开关与一键清空 —— 这是"纯本地"承诺下仍然该有的控制权。
 */
export const DEFAULT_TELEMETRY = {
  enabled: true,
  /** 事件保留天数，超出自动清理 */
  retentionDays: 30,
  /** 事件条数上限，超出自动清理最旧的 */
  maxRows: 50000
} as const

/**
 * 优先级元数据
 *
 * normal / low 不在卡片上显示色点 —— 整屏都是点就等于没有点，
 * 色点只留给真正需要抢注意力的 urgent / high。
 */
/**
 * 归属者展示元数据
 *
 * 约定见 Todo["owner"]：'human' 或 `agent:<id>`。
 * 这里是纯展示用的人读标签，不参与存储。
 */
export const OWNER_LABELS = {
  human: '我',
  agent: 'AI'
} as const

export const PRIORITY_META = {
  urgent: { label: '紧急', color: '#EF4444' },
  high: { label: '高', color: '#F59E0B' },
  normal: { label: '普通', color: '#9CA3AF' },
  low: { label: '低', color: '#9CA3AF' }
} as const

/**
 * 事项类型元数据
 *
 * task 刻意不配色 —— 界面上 task 不显示徽标（与优先级色点同一原则：
 * 整屏都是标记等于没有标记）。bug 红是"出了问题"，feature 蓝是"新想法"，
 * 颜色沿用品牌主色系，不引入新的视觉噪音。
 */
export const TYPE_META = {
  bug: { label: 'Bug', color: '#EF4444' },
  feature: { label: '需求', color: '#5388F6' },
  task: { label: '普通事项', color: '#9CA3AF' }
} as const

/**
 * 筛选下拉用的有序取值
 *
 * 从 META 的键派生而不是另写一份数组 —— 枚举只有一处定义，
 * 改 META 时下拉自动跟上，不会出现"卡片上有的优先级筛选里没有"。
 * 顺序是**从重到轻**（与 CLI --priority 的枚举顺序一致）。
 */
export const PRIORITY_ORDER = ['urgent', 'high', 'normal', 'low'] as const
export const TYPE_ORDER = ['bug', 'feature', 'task'] as const

/**
 * 状态的展示配置
 *
 * 放在这里是因为**看板列头和「方向」视图都要用** ——
 * 两边各写一份的话，改一处忘一处就会出现"同一个状态两个叫法"。
 */
export const STATUS_META = {
  proposed: { label: '待确认', colorVar: '--color-status-proposed' },
  todo: { label: '待办', colorVar: '--color-status-todo' },
  in_progress: { label: '进行中', colorVar: '--color-status-in-progress' },
  suspended: { label: '挂起', colorVar: '--color-status-suspended' },
  awaiting_review: { label: '待验收', colorVar: '--color-status-awaiting-review' },
  done: { label: '已完成', colorVar: '--color-status-done' },
  /**
   * 废弃（1.0.68，`a6032512` 的 e 项）
   *
   * 标签用「已废弃」而不是「废弃」—— 前者读起来是**已有结论**，
   * 后者读起来像"还没决定要不要扔"。这正是它与「挂起」的分界。
   */
  discarded: { label: '已废弃', colorVar: '--color-status-suspended' }
} as const

/**
 * 看板全部列（单源，53d252ea）
 *
 * KanbanBoard 的渲染与 useDragSort 的拖拽判定（"overId 是不是列"）共用这一份 ——
 * 此前两边各写一个数组、注释里互相嘱咐"保持同一顺序"，那不是机制是自觉。
 * 「已废弃」在列时只改一处漏一处的下场：废弃列渲染出来了、
 * 却拖不进卡（overId 判不成列，被当成"拖到某张卡上"）。
 *
 * 顺序即工作流的推进方向：提议 → 确认 → 执行 → （挂起）→ 验收 → 归档 → 不做。
 * 「已废弃」固定排在 done 之后（主用户 2026-10-08 拍板：
 * "就是在完成列的后面给一列废弃列"）。列序变了，"从左往右推"的心智模型就没了。
 */
export const BOARD_COLUMNS: TodoStatus[] = [
  'proposed',
  'todo',
  'in_progress',
  'suspended',
  'awaiting_review',
  'done',
  'discarded'
]
