/**
 * 界面设置命令（1.0.112 域切，卡 d1b71d28）
 *
 * 从 `command-table.ts` 里**整块搬来**的，条目逐字节未改 —— 参数声明与 `run` 都在
 * 这里，`schema` 直接序列化它（接口文档不可能与实现脱节）。
 *
 * ⚠️ 数组**顺序是外部契约**的一部分：`dp help` 的排列、`dp schema` 的命令清单、
 * MCP `tools/list` 的工具顺序都由 `command-table.ts` 里那张表的顺序决定。
 *
 * 这一段原来是独立的一块（`type UiSpec` 与它的白名单 / 取值校验都是 ui 命令专用的），
 * 原样搬来：白名单之外的项 `ui get` 会解释为什么不放，改前要过 `parseUiValue` 的校验。
 */

import { UsageError } from '../../lib/domain-errors'
import type { AppSettings } from '../../../renderer/types/settings'
import { strValue } from '../command-core'
import type { CommandSpec } from '../command-core'

type UiSpec =
  | { key: keyof AppSettings; desc: string; kind: 'enum'; values: readonly string[] }
  | { key: keyof AppSettings; desc: string; kind: 'number'; min: number; max: number }
  | { key: keyof AppSettings; desc: string; kind: 'boolean' }
  | { key: keyof AppSettings; desc: string; kind: 'color' }

export const UI_WHITELIST: UiSpec[] = [
  { key: 'theme', desc: '明暗主题', kind: 'enum', values: ['light', 'dark'] },
  { key: 'stylePreset', desc: '风格预设', kind: 'enum', values: ['frosted', 'japanese'] },
  /**
   * 磨砂底色不透明度（1.0.59）。
   *
   * 语义是**覆盖值**而非绝对值：设为 null（用 `ui reset --key bgOpacityOverride`
   * 或界面「跟随预设」）= 交还给风格预设，此时行内不写、由 themes/*.css 单独负责。
   * 与 floatBallColor 一样，`null` 是这一项最重要的取值 —— 默认就该是它。
   */
  { key: 'bgOpacityOverride', desc: '磨砂底色不透明度覆盖（null/留空 = 跟随风格预设）', kind: 'number', min: 0.3, max: 1 },
  { key: 'fontSizeScale', desc: '全局字号', kind: 'enum', values: ['small', 'normal', 'large'] },

  { key: 'kanbanBorderRadius', desc: '看板圆角', kind: 'number', min: 0, max: 32 },
  { key: 'cardBorderRadius', desc: '卡片圆角', kind: 'number', min: 0, max: 24 },
  { key: 'kanbanColumnHeaderHeight', desc: '列头高度', kind: 'enum', values: ['compact', 'standard', 'spacious'] },
  { key: 'cardSpacing', desc: '卡片间距', kind: 'enum', values: ['compact', 'standard', 'spacious'] },
  { key: 'cardActionsAlwaysVisible', desc: '卡片操作按钮常显', kind: 'boolean' },

  { key: 'quickAddBorderRadius', desc: '快速新增弹窗圆角', kind: 'number', min: 0, max: 24 },
  { key: 'quickAddPadding', desc: '快速新增弹窗内边距', kind: 'enum', values: ['compact', 'standard', 'spacious'] },

  { key: 'floatBallSize', desc: '悬浮球大小', kind: 'number', min: 32, max: 96 },
  { key: 'floatBallOpacity', desc: '悬浮球不透明度', kind: 'number', min: 0.3, max: 1 },
  { key: 'floatBallColor', desc: '悬浮球颜色', kind: 'color' },
  { key: 'floatBallEdgeHide', desc: '悬浮球贴边隐藏', kind: 'boolean' },
  { key: 'floatBallShowIcon', desc: '悬浮球显示图标', kind: 'boolean' },
  { key: 'floatBallShowGlow', desc: '悬浮球显示光晕', kind: 'boolean' }
]

/** 白名单里没放的项，说明为什么 —— ui get 时一并输出，省得 agent 反复试 */
const UI_EXCLUDED = [
  { key: 'autoStart', why: '系统级（开机自启），无头模式下改了也不生效' },
  { key: 'autoCheckUpdate', why: '系统级联网开关，是否自动检查更新由人决定' },
  { key: 'globalShortcut', why: '系统级（全局快捷键），需注册服务且可能与其它程序冲突' },
  { key: 'telemetryEnabled', why: '隐私开关，不允许 agent 关掉对自己行为的记录' },
  { key: 'kanbanAlwaysOnTop', why: '窗口行为，会挡住人正在做的事' },
  { key: 'kanbanWindowBounds', why: '窗口坐标，界面怎么摆是人的地盘' },
  { key: 'floatBallPosition', why: '同上，坐标不开放' },
  { key: 'customColors', why: '嵌套对象，改错一处很难定位' }
]

function describeSpec(spec: UiSpec) {
  if (spec.kind === 'enum') return { type: 'enum', values: spec.values }
  if (spec.kind === 'number') return { type: 'number', min: spec.min, max: spec.max }
  if (spec.kind === 'boolean') return { type: 'boolean', values: ['true', 'false'] }
  return { type: 'color', format: '#RGB 或 #RRGGBB' }
}

/** 把 agent 给的字符串按白名单声明转成真值；不合法直接抛 UsageError（退出码 2） */
function parseUiValue(spec: UiSpec, raw: string): unknown {
  if (spec.kind === 'enum') {
    if (!spec.values.includes(raw)) {
      throw new UsageError(`${spec.key} 只能取 ${spec.values.join(' / ')}，收到「${raw}」`)
    }
    return raw
  }

  if (spec.kind === 'boolean') {
    const v = raw.toLowerCase()
    if (['true', '1', 'yes', 'on'].includes(v)) return true
    if (['false', '0', 'no', 'off'].includes(v)) return false
    throw new UsageError(`${spec.key} 是布尔值，用 true / false，收到「${raw}」`)
  }

  if (spec.kind === 'number') {
    const n = Number(raw)
    if (raw.trim() === '' || !Number.isFinite(n)) {
      throw new UsageError(`${spec.key} 需要数字，收到「${raw}」`)
    }
    if (n < spec.min || n > spec.max) {
      throw new UsageError(`${spec.key} 范围 ${spec.min}~${spec.max}，收到 ${n}`)
    }
    return n
  }

  const s = raw.trim()
  if (!/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(s)) {
    throw new UsageError(`${spec.key} 需要颜色值（#RGB 或 #RRGGBB），收到「${raw}」`)
  }
  return s
}

/** 只回显白名单内的值，避免把系统级设置整包吐出去 */
function pickUi(settings: AppSettings) {
  const out: Record<string, unknown> = {}
  for (const spec of UI_WHITELIST) out[spec.key] = settings[spec.key]
  return out
}

export const uiCommands: CommandSpec[] = [
  {
    name: 'ui get',
    dataShape: 'object',
    readOnly: true,
    desc: '查看 agent 可改的界面参数与当前值（白名单）',
    args: [{ flag: '--key', type: 'string', desc: '只看某一个参数；不传则列出全部' }],
    run: (ctx, flags) => {
      const settings = ctx.deps.settingsRepo.get()
      const rawKey = flags['--key']

      if (rawKey !== undefined) {
        const key = String(rawKey)
        const spec = UI_WHITELIST.find((s) => s.key === key)
        if (!spec) {
          throw new UsageError(
            `参数不在可改白名单内: ${key}（不带 --key 运行 ui get 看全部可改项）`
          )
        }
        return { key: spec.key, desc: spec.desc, value: settings[spec.key], ...describeSpec(spec) }
      }

      return {
        note: '只列 agent 可改的纯视觉参数；系统级与隐私项不开放，见 excluded',
        params: UI_WHITELIST.map((spec) => ({
          key: spec.key,
          desc: spec.desc,
          value: settings[spec.key],
          ...describeSpec(spec)
        })),
        excluded: UI_EXCLUDED
      }
    }
  },
  {
    /**
     * 改界面 = config 档（1.0.36）：批准**仅本次会话有效**。
     *
     * 待办内容是数据，界面是**人每天要盯着的那个东西** ——
     * 配色、字号、布局被一个无人值守的进程悄悄改掉，比多一条待办刺眼得多。
     * 所以这一档不并进"写入批准"，要单独点头，且点头只管这一轮对话。
     */
    name: 'ui set',
    dataShape: 'object',
    risk: 'config',
    desc: '改一个界面参数（限白名单，越界直接拒绝）',
    args: [
      { flag: '--key', type: 'string', required: true, desc: '参数名，如 theme' },
      { flag: '--value', type: 'string', required: true, desc: '新值，如 dark' }
    ],
    run: (ctx, flags) => {
      const key = String(flags['--key'] ?? '').trim()
      if (!key) throw new UsageError('--key 不能为空')

      const rawValue = flags['--value']
      if (rawValue === undefined) throw new UsageError('--value 不能为空')

      const spec = UI_WHITELIST.find((s) => s.key === key)
      if (!spec) {
        throw new UsageError(`参数不在可改白名单内: ${key}（ui get 可看全部可改项）`)
      }

      const value = parseUiValue(spec, strValue(rawValue))
      const before = ctx.deps.settingsRepo.get()[spec.key]
      const settings = ctx.deps.settingsRepo.update({ [spec.key]: value } as Partial<AppSettings>)

      // 让正在运行的 GUI 察觉到这次改动（失败不能拖垮命令本身）
      try {
        ctx.deps.events.append('settings', 'cli', { cmd: 'ui set', key: spec.key })
      } catch {
        /* 广播失败不影响写入结果 */
      }

      return {
        key: spec.key,
        before,
        after: settings[spec.key],
        changed: before !== settings[spec.key],
        note: '界面下次渲染即生效；若界面未刷新，说明改动未被 GUI 轮询到，可稍等 1 秒'
      }
    }
  },
  {
    /**
     * ui reset：全量复位 / 单键复位
     *
     * 回报里带 `affected`（这次真正动过哪些键）——
     * Bob实测：它传了 `--key theme`，flag 被静默忽略、整组参数被拉回默认，
     * 回报还是 ok:true。破坏性范围被悄悄放大、且无从核对，是这类命令最坏的失败方式。
     * 现在：--key 真的只动一个键，不带 --key 才全量，两种情况都列出 affected 供回读。
     */
    name: 'ui reset',
    dataShape: 'object',
    risk: 'config',
    desc: '把界面视觉参数恢复默认（不动系统级与隐私项）；带 --key 则只复位指定的一个参数',
    args: [
      {
        flag: '--key',
        type: 'string',
        desc: '只复位这一个参数（须在 ui get 列出的白名单内）；不传则复位全部视觉参数'
      }
    ],
    run: (ctx, flags) => {
      const raw = flags['--key']
      let result: { settings: AppSettings; affected: string[] }

      if (raw !== undefined) {
        const key = String(raw).trim()
        const spec = UI_WHITELIST.find((s) => s.key === key)
        if (!spec) {
          throw new UsageError(
            `--key 只能是白名单内的参数，收到「${key}」。可用：${UI_WHITELIST.map((s) => s.key).join(', ')}`
          )
        }
        result = ctx.deps.settingsRepo.resetVisualKey(key)
      } else {
        /**
         * 全量复位不含 theme：主题是人的长期偏好，改它是"复位"这个词不该cover的动作。
         * 想复位主题请显式 `ui reset --key theme` —— 范围由调用方点名，不由默认值决定。
         */
        const settings = ctx.deps.settingsRepo.resetVisual()
        result = { settings, affected: UI_WHITELIST.map((s) => s.key).filter((k) => k !== 'theme') }
      }

      try {
        ctx.deps.events.append('settings', 'cli', { cmd: 'ui reset', key: raw ?? null })
      } catch {
        /* 同上 */
      }
      return { reset: true, affected: result.affected, settings: pickUi(result.settings) }
    }
  }
]

