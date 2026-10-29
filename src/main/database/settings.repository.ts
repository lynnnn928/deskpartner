import { UsageError } from '../lib/domain-errors'
import { getDatabase } from './index'
import type { AppSettings, CustomColors } from '../../renderer/types/settings'
import {
  DEFAULT_BG_OPACITY,
  DEFAULT_COLORS,
  DEFAULT_FLOAT_BALL,
  DEFAULT_KANBAN,
  DEFAULT_QUICK_ADD,
  DEFAULT_TELEMETRY
} from '../../renderer/lib/constants'

/**
 * 系统级/窗口级设置：不随备份导入，也不对 agent 开放
 *
 * 与 CLI 侧 `UI_EXCLUDED`（commands.ts）是同一条边界的两种表述 ——
 * 那边管"agent 能不能改"，这边管"备份能不能带进来"。
 * 理由一致：这些项要么属于操作系统（开机自启、全局快捷键），
 * 要么属于"人此刻的桌面状态"（窗口坐标、悬浮球位置），
 * 换台机器导入备份时不该把旧机器的坐标一起带过来。
 */
const SYSTEM_SETTING_KEYS = new Set([
  'autoStart',
  'autoCheckUpdate',
  'globalShortcut',
  'telemetryEnabled',
  'floatBallPosition',
  'kanbanWindowBounds',
  'kanbanAlwaysOnTop',
  'customColors',
  'appName',
  'appIcon',
  'lastSkillExportedVersion',
  'lastSkillExportedAt'
])

/** 从备份导入设置的过滤结果 */
export interface SettingsImportResult {
  /** 实际接受的字段 */
  accepted: string[]
  /** 被丢弃的字段及其原因，供界面如实告知，不静默 */
  rejected: { key: string; why: string }[]
}

/** 应用设置数据仓库 */
export class SettingsRepository {
  private get db() {
    return getDatabase()
  }

  /** 获取应用设置（自动填充默认值） */
  get(): AppSettings {
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as {
      key: string
      value: string
    }[]

    const map = new Map<string, string>()
    for (const row of rows) {
      map.set(row.key, row.value)
    }

    return this.fillDefaults(map)
  }

  /**
   * 部分更新设置
   *
   * ⚠️ 顶层值为 `undefined` 的键会被**先滤掉**再合并（1.0.38）。
   *
   * 对象展开 `{...current, ...partial}` 会把显式传进来的 undefined 当作
   * "我要把它改成没有"，于是 `merged` 里该字段变 undefined，
   * 最后被 `String(undefined)` 落成字面量 `"undefined"` 写进库 ——
   * 读取时 `Number("undefined")` 得到 NaN，悬浮球尺寸/不透明度直接坏掉。
   * 残缺备份（老版本导出或手工编辑过的 JSON）几乎必然缺字段，一定会撞上。
   *
   * 注：`customColors` **内部**的 undefined 仍保留语义（= 该项恢复默认色），
   * 那里的处理在下面单独做，不受这次过滤影响。
   */
  update(partial: Partial<AppSettings>): AppSettings {
    const current = this.get()
    const clean = Object.fromEntries(
      Object.entries(partial).filter(([, v]) => v !== undefined)
    ) as Partial<AppSettings>
    const merged = { ...current, ...clean }

    // 处理嵌套对象 customColors 的合并
    if (clean.customColors) {
      const mergedColors = { ...current.customColors, ...clean.customColors }

      // 值为 undefined 表示该项恢复默认色，直接从自定义集合中移除
      for (const [key, value] of Object.entries(clean.customColors)) {
        if (value === undefined) {
          delete mergedColors[key as keyof CustomColors]
        }
      }

      merged.customColors = mergedColors
    }

    this.saveAll(merged)
    return merged
  }

  /**
   * 从备份文件导入设置（1.0.38）
   *
   * 与 `update` 的区别是**它不信任输入**：备份 JSON 可能是老版本导出的、
   * 被手工编辑过的，甚至是别处传来的任意 JSON。三道过滤：
   *
   * 1. **白名单**：只认 `getDefaultSettings()` 里存在的键。
   *    没这道过滤，备份里多出一个键就会原样写进 settings 表，
   *    等于让任意 JSON 能够改写应用的内部开关。
   * 2. **排除系统项**：见 SYSTEM_SETTING_KEYS。
   *    否则导入一份备份就能改掉 autoStart / globalShortcut，
   *    而这两项连 agent 走 `ui set` 都是被 `config` 档拦住的 ——
   *    备份导入反而成了绕过那道门禁的旁路。
   * 3. **类型校验**：与默认值的 typeof 不一致就丢弃。
   *    避免备份里 `floatBallSize: "大"` 之类写进去，读回时变成 NaN。
   *
   * @returns 接受了哪些、丢了哪些 —— 丢掉的一定要能报出来，
   *          静默吞掉正是"备份导入坏得没声音"的成因。
   */
  importFrom(raw: unknown): SettingsImportResult {
    const defaults = this.getDefaultSettings()
    const accepted: string[] = []
    const rejected: { key: string; why: string }[] = []

    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { accepted, rejected: [{ key: '(整体)', why: '设置不是对象，已忽略' }] }
    }

    const source = raw as Record<string, unknown>
    const patch: Record<string, unknown> = {}

    for (const [key, value] of Object.entries(source)) {
      if (value === undefined) continue
      if (!(key in defaults)) {
        rejected.push({ key, why: '不是已知的设置项' })
        continue
      }
      if (SYSTEM_SETTING_KEYS.has(key)) {
        rejected.push({ key, why: '系统级/窗口级设置，不随备份导入' })
        continue
      }
      const expected = typeof (defaults as unknown as Record<string, unknown>)[key]
      if (expected !== typeof value) {
        rejected.push({ key, why: `类型不对（应为 ${expected}，收到 ${typeof value}）` })
        continue
      }
      patch[key] = value
      accepted.push(key)
    }

    if (accepted.length) {
      this.update(patch as Partial<AppSettings>)
    }
    return { accepted, rejected }
  }

  /** 重置所有视觉参数到默认值 */
  resetVisual(): AppSettings {
    const current = this.get()
    const defaults = this.getDefaultSettings()

    // 只重置视觉相关字段，保留系统设置
    const reset: AppSettings = {
      ...current,
      // 主题与风格
      stylePreset: defaults.stylePreset,
      // 悬浮球
      floatBallSize: defaults.floatBallSize,
      floatBallOpacity: defaults.floatBallOpacity,
      floatBallColor: defaults.floatBallColor,
      floatBallEdgeHide: defaults.floatBallEdgeHide,
      floatBallShowIcon: defaults.floatBallShowIcon,
      floatBallShowGlow: defaults.floatBallShowGlow,
      // 磨砂底色：回到跟随预设（不是"回到某个数"—— 预设才是那条唯一来源）
      bgOpacityOverride: defaults.bgOpacityOverride,
      // 看板
      kanbanBorderRadius: defaults.kanbanBorderRadius,
      kanbanColumnHeaderHeight: defaults.kanbanColumnHeaderHeight,
      cardBorderRadius: defaults.cardBorderRadius,
      cardSpacing: defaults.cardSpacing,
      cardActionsAlwaysVisible: defaults.cardActionsAlwaysVisible,
      // 弹窗
      quickAddBorderRadius: defaults.quickAddBorderRadius,
      quickAddPadding: defaults.quickAddPadding,
      // 字体与动画
      fontSizeScale: defaults.fontSizeScale,
      // 自定义颜色
      customColors: {}
    }

    this.saveAll(reset)
    return reset
  }

  /**
   * 只把**一个**视觉参数恢复默认（`ui reset --key <key>`）
   *
   * 为什么单独开一个方法、而不是让调用方自己算出默认值再 update：
   * 默认值只有这里知道（getDefaultSettings 是私有的），
   * 调用方重算一份，迟早会和界面上「恢复默认」按钮漂出两种默认。
   *
   * 为什么需要它：`ui reset` 不带 --key 是全量复位，而 agent 想复位单个键时
   * 只能拿到这个更大的动作 —— Bob实测它传了 `--key theme`，flag 被静默忽略、
   * 整组视觉参数被拉回默认，还回报成功。作用范围被悄悄放大比做错更坏。
   *
   * 系统级与隐私项即使传进来也拒绝，与 CLI 侧 UI_EXCLUDED 同一条边界。
   */
  resetVisualKey(key: string): { settings: AppSettings; affected: string[] } {
    const defaults = this.getDefaultSettings()
    if (!(key in defaults) || SYSTEM_SETTING_KEYS.has(key)) {
      throw new UsageError(`不能复位「${key}」：它不是可单独复位的视觉参数`)
    }

    const current = this.get()
    const merged = { ...current, [key]: defaults[key as keyof AppSettings] } as AppSettings
    this.saveAll(merged)
    return { settings: merged, affected: [key] }
  }

  /** 保存所有设置到数据库 */
  private saveAll(settings: AppSettings): void {
    const upsert = this.db.prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )

    const flat = this.flatten(settings)
    const transaction = this.db.transaction(() => {
      for (const [key, value] of Object.entries(flat)) {
        /**
         * 缺的字段直接跳过，不写库（1.0.38）。
         *
         * `String(undefined)` 得到的是字符串 `"undefined"`，读回来
         * `Number("undefined")` 是 NaN —— 一个"没提供值"会变成
         * 一个看起来合法但算不出来的数字。宁可保留库里的旧值。
         * `null` 是有语义的（比如 floatBallPosition 允许为空），照常写。
         */
        if (value === undefined) continue
        upsert.run(key, String(value))
      }
    })
    transaction()
  }

  /** 将设置对象扁平化为 key-value 对 */
  private flatten(settings: AppSettings): Record<string, unknown> {
    return {
      theme: settings.theme,
      stylePreset: settings.stylePreset,
      floatBallSize: settings.floatBallSize,
      floatBallOpacity: settings.floatBallOpacity,
      floatBallColor: settings.floatBallColor,
      floatBallEdgeHide: settings.floatBallEdgeHide,
      floatBallShowIcon: settings.floatBallShowIcon,
      floatBallShowGlow: settings.floatBallShowGlow,
      floatBallPosition: settings.floatBallPosition
        ? JSON.stringify(settings.floatBallPosition)
        : null,
      /**
       * null 落库写成空串（与 floatBallColor 同一套表示法）。
       * 写成空串而不是删掉这一行，是为了让"用户主动回到跟随预设"能被持久化 ——
       * 删行的话，下次读到的是缺省值（恰好也是 null），行为碰巧一致，
       * 但备份里的语义就丢了（导入时会以为从来没设置过）。
       */
      bgOpacityOverride:
        settings.bgOpacityOverride === null ? '' : settings.bgOpacityOverride,
      kanbanAlwaysOnTop: settings.kanbanAlwaysOnTop,
      kanbanWindowBounds: settings.kanbanWindowBounds
        ? JSON.stringify(settings.kanbanWindowBounds)
        : null,
      kanbanBorderRadius: settings.kanbanBorderRadius,
      kanbanColumnHeaderHeight: settings.kanbanColumnHeaderHeight,
      cardBorderRadius: settings.cardBorderRadius,
      cardSpacing: settings.cardSpacing,
      cardActionsAlwaysVisible: settings.cardActionsAlwaysVisible,
      quickAddBorderRadius: settings.quickAddBorderRadius,
      quickAddPadding: settings.quickAddPadding,
      fontSizeScale: settings.fontSizeScale,
      autoStart: settings.autoStart,
      autoCheckUpdate: String(settings.autoCheckUpdate),
      globalShortcut: settings.globalShortcut ?? '',
      telemetryEnabled: String(settings.telemetryEnabled),
      customColors: JSON.stringify(settings.customColors),
      humanName: settings.humanName,
      humanNameAsked: String(settings.humanNameAsked),
      welcomeShown: String(settings.welcomeShown),
      appName: settings.appName,
      appIcon: settings.appIcon === null ? '' : settings.appIcon,
      lastSkillExportedVersion: settings.lastSkillExportedVersion === null ? '' : settings.lastSkillExportedVersion,
      lastSkillExportedAt: settings.lastSkillExportedAt === null ? '' : settings.lastSkillExportedAt
    }
  }

  /** 从 key-value 映射填充默认值，构建完整 AppSettings */
  private fillDefaults(map: Map<string, string>): AppSettings {
    const defaults = this.getDefaultSettings()
    const get = <T>(key: string, fallback: T): T => {
      const val = map.get(key)
      if (val === undefined || val === null) return fallback
      return val as unknown as T
    }

    const parseJSON = <T>(key: string, fallback: T): T => {
      const val = map.get(key)
      if (!val) return fallback
      try {
        return JSON.parse(val) as T
      } catch {
        return fallback
      }
    }

    return {
      theme: get('theme', defaults.theme) as AppSettings['theme'],
      stylePreset: get('stylePreset', defaults.stylePreset) as AppSettings['stylePreset'],
      floatBallSize: Number(get('floatBallSize', defaults.floatBallSize)),
      floatBallOpacity: Number(get('floatBallOpacity', defaults.floatBallOpacity)),
      // 空串 = 跟随全局强调色（v22 起；旧品牌蓝已由迁移置空）
      floatBallColor: (() => {
        const v = get('floatBallColor', defaults.floatBallColor)
        return v === null || v === '' ? null : v
      })(),
      floatBallEdgeHide: get('floatBallEdgeHide', String(defaults.floatBallEdgeHide)) === 'true',
      floatBallShowIcon: get('floatBallShowIcon', String(defaults.floatBallShowIcon)) === 'true',
      floatBallShowGlow: get('floatBallShowGlow', String(defaults.floatBallShowGlow)) === 'true',
      floatBallPosition: parseJSON('floatBallPosition', defaults.floatBallPosition),
      /**
       * 空串 = 跟随预设（1.0.59，与 floatBallColor 同一套表示法）。
       * 直接读原始字符串：库里存的是 '' 或数字字符串，非法值一律回退 null，
       * 绝不能让界面拿到 NaN（滑块会直接坏掉）。
       */
      bgOpacityOverride: (() => {
        const raw = map.get('bgOpacityOverride')
        if (raw === undefined || raw === null || raw === '') return null
        const n = Number(raw)
        return Number.isFinite(n) ? n : null
      })(),
      kanbanAlwaysOnTop:
        get('kanbanAlwaysOnTop', String(defaults.kanbanAlwaysOnTop)) === 'true',
      kanbanWindowBounds: parseJSON('kanbanWindowBounds', defaults.kanbanWindowBounds),
      kanbanBorderRadius: Number(get('kanbanBorderRadius', defaults.kanbanBorderRadius)),
      kanbanColumnHeaderHeight: get(
        'kanbanColumnHeaderHeight',
        defaults.kanbanColumnHeaderHeight
      ) as AppSettings['kanbanColumnHeaderHeight'],
      cardBorderRadius: Number(get('cardBorderRadius', defaults.cardBorderRadius)),
      cardSpacing: get('cardSpacing', defaults.cardSpacing) as AppSettings['cardSpacing'],
      cardActionsAlwaysVisible:
        get('cardActionsAlwaysVisible', String(defaults.cardActionsAlwaysVisible)) === 'true',
      quickAddBorderRadius: Number(
        get('quickAddBorderRadius', defaults.quickAddBorderRadius)
      ),
      quickAddPadding: get('quickAddPadding', defaults.quickAddPadding) as AppSettings['quickAddPadding'],
      fontSizeScale: get('fontSizeScale', defaults.fontSizeScale) as AppSettings['fontSizeScale'],
      autoStart: get('autoStart', String(defaults.autoStart)) === 'true',
      autoCheckUpdate: get('autoCheckUpdate', String(defaults.autoCheckUpdate)) === 'true',
      globalShortcut: get('globalShortcut', defaults.globalShortcut) || null,
      telemetryEnabled:
        get('telemetryEnabled', String(defaults.telemetryEnabled)) === 'true',
      customColors: parseJSON<CustomColors>('customColors', {}),
      humanName: get('humanName', defaults.humanName),
      humanNameAsked: get('humanNameAsked', String(defaults.humanNameAsked)) === 'true',
      welcomeShown: get('welcomeShown', String(defaults.welcomeShown)) === 'true',
      appName: get('appName', defaults.appName),
      appIcon: (() => {
        const v = get('appIcon', defaults.appIcon)
        return v === null || v === '' ? null : v
      })(),
      lastSkillExportedVersion: (() => {
        const v = get('lastSkillExportedVersion', defaults.lastSkillExportedVersion)
        return v === null || v === '' ? null : v
      })(),
      lastSkillExportedAt: (() => {
        const v = get('lastSkillExportedAt', defaults.lastSkillExportedAt)
        return v === null || v === '' ? null : v
      })()
    }
  }

  /** 获取默认设置 */
  private getDefaultSettings(): AppSettings {
    return {
      theme: 'light',
      stylePreset: 'frosted',
      floatBallSize: DEFAULT_FLOAT_BALL.size,
      floatBallOpacity: DEFAULT_FLOAT_BALL.opacity,
      // null = 跟随全局强调色（默认），不再是写死的旧品牌蓝
      floatBallColor: null,
      floatBallEdgeHide: DEFAULT_FLOAT_BALL.edgeHide,
      floatBallShowIcon: DEFAULT_FLOAT_BALL.showIcon,
      floatBallShowGlow: DEFAULT_FLOAT_BALL.showGlow,
      floatBallPosition: null,
      // 默认跟随风格预设（1.0.59）
      bgOpacityOverride: DEFAULT_BG_OPACITY.override,
      kanbanAlwaysOnTop: DEFAULT_KANBAN.alwaysOnTop,
      kanbanWindowBounds: null,
      kanbanBorderRadius: DEFAULT_KANBAN.borderRadius,
      kanbanColumnHeaderHeight: DEFAULT_KANBAN.columnHeaderHeight,
      cardBorderRadius: DEFAULT_KANBAN.cardBorderRadius,
      cardSpacing: DEFAULT_KANBAN.cardSpacing,
      cardActionsAlwaysVisible: DEFAULT_KANBAN.cardActionsAlwaysVisible,
      quickAddBorderRadius: DEFAULT_QUICK_ADD.borderRadius,
      quickAddPadding: DEFAULT_QUICK_ADD.padding,
      fontSizeScale: 'normal',
      autoStart: false,
      autoCheckUpdate: true,
      globalShortcut: 'Ctrl+Shift+N',
      telemetryEnabled: DEFAULT_TELEMETRY.enabled,
      customColors: {},
      humanName: '',
      humanNameAsked: false,
      /**
       * 默认 false（= 还没看过引导）—— 老库升级上来也是这个值，
       * 于是已有一堆卡的用户升级后会看到一次引导。这是有意的：
       * 这次引导讲的是"怎么把 AI 接进来"，老用户同样需要知道，
       * 而它只出现一次、关掉即止，成本可接受。
       */
      welcomeShown: false,
      appName: '',
      appIcon: null,
      lastSkillExportedVersion: null,
      lastSkillExportedAt: null
    }
  }
}
