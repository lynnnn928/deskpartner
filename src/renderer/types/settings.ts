import type { ThemeMode, StylePreset, FontSizeScale, SpacingPreset } from './enums'

/** 窗口位置 */
export interface WindowPosition {
  x: number
  y: number
}

/** 窗口边界（含尺寸） */
export interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
}

/**
 * 自定义颜色
 *
 * key 会被 useTheme 转换为 CSS 变量 `--color-{kebab-case}`，
 * 因此 key 必须与 variables.css 中的变量名后缀严格对应（如 textDone → --color-text-done）。
 */
export interface CustomColors {
  // 品牌色
  accent?: string
  success?: string
  reminderGlow?: string
  // 界面
  /** 窗口与浮层的底色（磨砂背景的实际颜色） */
  bgPrimary?: string
  // 文字
  textPrimary?: string
  textSecondary?: string
  textDone?: string
  // 看板列底色（1.0.48 起废弃：看板列底色早已统一，四字段无消费方；界面入口已移除，类型保留仅为兼容旧设置值）
  columnTodo?: string
  columnInProgress?: string
  columnSuspended?: string
  columnDone?: string
  // 分隔线
  border?: string
}

/** 应用设置 */
export interface AppSettings {
  // 主题与风格
  theme: ThemeMode
  stylePreset: StylePreset

  // 悬浮球
  floatBallSize: number
  floatBallOpacity: number
  /**
   * 悬浮球颜色。null = **跟随全局强调色**（2026-09-25，修 86921424）。
   * 此前它是一个写死的旧品牌蓝，而全局强调色早已改成冷中性 ——
   * 两处各说一套，界面上就是"青色的球配墨黑的强调色"。
   */
  floatBallColor: string | null
  floatBallEdgeHide: boolean
  floatBallShowIcon: boolean
  floatBallShowGlow: boolean
  floatBallPosition: WindowPosition | null

  /**
   * 窗口磨砂底色的不透明度覆盖值（1.0.59）
   *
   * `null` = **跟随当前风格预设**（默认）。此时行内不写 `--frosted-bg-opacity`，
   * 值由 themes/*.css 决定 —— 全库只有一条来源，不会出现"预设值其实没生效"。
   * 数值 = 用户显式拖过滑块，行内写入并覆盖预设（行内优先级最高正是想要的行为）。
   *
   * 与 `floatBallColor`（null = 跟随全局强调色）同一个模式。
   * 详见 lib/constants.ts 的 DEFAULT_BG_OPACITY。
   */
  bgOpacityOverride: number | null

  // 看板
  kanbanAlwaysOnTop: boolean
  kanbanWindowBounds: WindowBounds | null
  kanbanBorderRadius: number
  kanbanColumnHeaderHeight: SpacingPreset
  cardBorderRadius: number
  cardSpacing: SpacingPreset
  cardActionsAlwaysVisible: boolean

  // 弹窗
  quickAddBorderRadius: number
  quickAddPadding: SpacingPreset

  // 字体与动画
  fontSizeScale: FontSizeScale

  // 系统
  autoStart: boolean
  autoCheckUpdate: boolean
  globalShortcut: string | null

  /**
   * 是否记录本地使用埋点。
   * 数据只写本地、永不自动外发；关掉即停止记录，且可一键清空已记录的数据。
   */
  telemetryEnabled: boolean

  // 自定义颜色
  customColors: CustomColors

  /**
   * 人的名字 —— human 身份的展示名
   *
   * 为什么需要它：agent 注册时都有一个展示名（agent register --name "Bob"），
   * 唯独人这边是硬编码的 `human`，界面上一律显示成「我」。
   * 看板给自己看还行，动态页就出问题了：动态是**两边都读**的时间线，
   * 「我验收通过了」里的「我」对 agent 是歧义的 —— 它不知道这个「我」是谁。
   * 有了名字，同一条记录对人和对 agent 说的是同一句话。
   *
   * 空串 = 还没取名字，此时界面回退显示「我」（不强迫用户非填不可）。
   */
  humanName: string

  /**
   * 是否已经问过名字（首次启动引导用）
   *
   * 单独一个标记而不是拿 humanName 是否为空来判断：用户可以选「就叫我『我』」，
   * 那是**明确决定不要名字**，和「还没问过」是两回事。混成一个字段的话，
   * 每次启动都会再弹一次，逼着人填。
   */
  humanNameAsked: boolean

  /**
   * 是否已经看过「首次见面」引导（1.0.64）
   *
   * 这个引导回答的是新用户的第一个问题：**装完之后我拿它干嘛？**
   * 它只在第一次出现一次，关掉即置 true，之后不再打扰。
   *
   * ── 为什么不做成「不勾选就一直弹」──
   *
   * 曾经设计过带「下次不再弹出」勾选框、不勾就反复弹的版本。否掉了，因为
   * 用户点 X 关掉窗口表达的是"我现在不想看"（这次），不等于"我永远不需要"；
   * 让一个 X 同时承担这两件事，必然错一个 —— 而错了的那半会让软件显得烦人。
   * 反复弹的收益（极少数想看第二次的人）远小于代价（每个新用户都被骚扰）。
   *
   * ── 想再看怎么办 ──
   *
   * 用户页的「AI 助手接入」区块是常驻的，那里随时能拿到同一份接入说明。
   * **入口一直在，所以"再弹一次"这件事根本不需要存在。**
   * 这也是它敢做成"只看一次"的底气。
   */
  welcomeShown: boolean

  /**
   * 自定义应用名称（空串 = 使用默认名称 DeskPartner）
   */
  appName: string

  /**
   * 自定义应用图标（base64 PNG Data URL，null = 使用默认品牌图标）
   */
  appIcon: string | null

  /**
   * 上次在界面复制/导出接入说明（Skill）时的应用版本号（卡 3559c27d）
   */
  lastSkillExportedVersion: string | null

  /**
   * 上次在界面复制/导出接入说明（Skill）时的 ISO 时间（卡 3559c27d）
   */
  lastSkillExportedAt: string | null
}
