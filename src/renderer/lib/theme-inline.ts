/**
 * 主题行内样式的"陈旧值抹除"（1.0.55，修一致性 B3）
 *
 * ── 要解决的问题 ──
 *
 * `useTheme` 会把一批主题变量写成 `<html>` 的**行内样式**，例如：
 *   `--font-scale`          ← settings.fontSizeScale
 *
 * （`--frosted-bg-opacity` 也曾是其中之一，由 `settings.windowOpacity` 驱动；
 *   1.0.56 该设置项已删除，此变量归 CSS 主题文件所有，
 *   1.0.57 又把 frosted 预设漏改的 0.72 补成 0.88。
 *   1.0.59 起改为**条件性覆盖**：`bgOpacityOverride` 非 null 时才写行内，
 *   null 时完全交给预设 —— 见下面清单里的说明。）
 *
 * 行内样式的优先级**永远高于**任何 CSS 规则（包括 `[data-preset='x']`）。
 * 于是只要它被写过一次，主题文件（`themes/frosted.css`、
 * `themes/japanese.css`）里给同名变量声明的值就**再也读不到** ——
 * 预设里那一项等于从未生效。
 *
 * 这类"写进 DOM 却没人读到"的失效**不会报错**：tsc 绿、lint 绿、
 * 单元测试绿，只有到界面上一项项比对才发现。所以它必须由测试锁住。
 *
 * ── 本函数做什么 ──
 *
 * 在**应用主题变量之前**，先把上一次运行留下的、由 CSS 侧权威负责的
 * 行内变量**抹掉**，让 CSS 重新拿到控制权；只有当前确实该由设置项
 * 驱动的变量才重新写上。
 *
 * 注意它与"用户已被替换掉的那次行内残留"是两回事：
 * 不做这一步，切预设时旧行内值会一直压着新预设的值。
 *
 * @param root      要清理的根元素（测试里可传任意实现了 style 接口的对象）
 * @param managed   本次要由 JS 写上去的变量名（这些**不清理**，稍后会被覆盖）
 * @param ownedByCss 由 CSS 主题文件负责权威的变量名（这些**必须清理**）
 * @returns 实际被移除的变量名列表（按传入顺序）
 */
export function pruneThemeInline(
  root: { style: { removeProperty(name: string): void } },
  managed: readonly string[],
  ownedByCss: readonly string[]
): string[] {
  const keep = new Set(managed)
  const removed: string[] = []
  for (const name of ownedByCss) {
    if (keep.has(name)) continue
    root.style.removeProperty(name)
    removed.push(name)
  }
  return removed
}

/**
 * 由 CSS 主题文件（`themes/*.css`）负责权威的变量清单。
 *
 * 判据：这个变量在主题文件里有 `[data-preset='…']` / `[data-theme='…']` 声明，
 * 且**不应**由设置项行内覆盖。任何一项要从这里移走，必须同时确认
 * 它在主题文件里的声明已删除，否则会变成"无人负责"的悬空值。
 */
/**
 * 磨砂底色不透明度的**唯一写入口**（1.0.59）
 *
 * 抽成纯函数而不是写在 useTheme 里，是为了让这条判据能被单测试直接锁住：
 * `null` → 行内**不写**（值归预设，唯一来源）；数值 → 写行内覆盖预设。
 *
 * 这正是 1.0.57 那个用户可见回归的反面：那时行内值恒在、恒赢，
 * 预设里的值永远读不到也永远没人核对。现在"不写"是默认且可被断言的状态。
 *
 * @param override null = 跟随预设；数值 = 覆盖
 * @returns 是否写入了行内覆盖（供调用方/测试判断当前是否处于覆盖态）
 */
export function applyBgOpacityOverride(
  root: { style: { setProperty(name: string, value: string): void; removeProperty(name: string): void } },
  override: number | null | undefined
): boolean {
  if (override === null || override === undefined || !Number.isFinite(override)) {
    root.style.removeProperty('--frosted-bg-opacity')
    return false
  }
  root.style.setProperty('--frosted-bg-opacity', String(override))
  return true
}

/**
 * 可自定义颜色的变量名清单（与设置面板 `ColorSection` 的 8 项一一对应）
 *
 * 为什么要在**这里**维护一份：1.0.114 起颜色存的是 R G B 三段通道，
 * 行内覆盖必须写通道变量（`--color-accent-rgb`）才既能让 `var(--color-accent)`
 * 生效、又能让 `bg-accent/10` 这类带透明度的类跟着走。
 * 只写完整色值时，`bg-accent`（主按钮底色）压根读的是通道变量 —— 设了颜色却不生效。
 */
export const CUSTOM_COLOR_VARS = [
  'accent',
  'success',
  'reminder-glow',
  'bg-primary',
  'border',
  'text-primary',
  'text-secondary',
  'text-done'
] as const

/**
 * 把颜色值转成 `R G B` 三段通道（1.0.114，卡 5fdf9b6d）
 *
 * 支持 `#abc` / `#aabbcc` / `#aabbccdd`（忽略 alpha：通道只描述色相）与 `rgb()/rgba()`。
 * 解析不了返回 null —— 调用方退回"写完整色值"，至少 `var(--color-x)` 那条路还对，
 * 不会因为一个怪异色值把整个面板的颜色写坏。
 */
export function toRgbChannels(value: string): string | null {
  const v = value.trim()
  const hex = v.match(/^#([0-9a-fA-F]{3,8})$/)
  if (hex) {
    let h = hex[1]
    if (h.length === 3 || h.length === 4) h = h.slice(0, 3).split('').map((c) => c + c).join('')
    if (h.length !== 6 && h.length !== 8) return null
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)).join(' ')
  }
  const rgb = v.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/)
  if (rgb) {
    const parts = [rgb[1], rgb[2], rgb[3]].map(Number)
    if (parts.some((n) => n < 0 || n > 255)) return null
    return parts.join(' ')
  }
  return null
}

/**
 * 把「设置里的自定义颜色」写进根元素（1.0.114）
 *
 * 两件事一起做：
 *  1. 先抹掉**两种**形态（完整色值 + 通道），否则上一次的覆盖会一直压着主题
 *     —— 这是 1.0.57「预设改了却读不到」的同一种结构（行内恒赢），只是变量换了个名字；
 *  2. 能解析成通道的，只写通道变量：完整色值由 `variables.css` 的 :root 派生一次，
 *     一个值只有一个存放点。解析不了的退回写完整色值（此时 `/alpha` 不跟随，属已知边界）。
 *
 * @returns 实际写上的变量名（`--color-x-rgb` 或 `--color-x`），供测试与排查
 */
export function applyCustomColors(
  root: { style: { setProperty(name: string, value: string): void; removeProperty(name: string): void } },
  colors: object | null | undefined
): string[] {
  for (const v of CUSTOM_COLOR_VARS) {
    root.style.removeProperty(`--color-${v}`)
    root.style.removeProperty(`--color-${v}-rgb`)
  }
  const written: string[] = []
  for (const [key, raw] of Object.entries(colors ?? {})) {
    if (typeof raw !== 'string' || !raw) continue
    const value = raw
    const name = `--color-${key.replace(/([A-Z])/g, '-$1').toLowerCase()}`
    const channels = toRgbChannels(value)
    if (channels) {
      root.style.setProperty(`${name}-rgb`, channels)
      written.push(`${name}-rgb`)
    } else {
      root.style.setProperty(name, value)
      written.push(name)
    }
  }
  return written
}

export const CSS_OWNED_THEME_VARS = [
  /**
   * frosted 0.88 / japanese 0.88 —— 权威归主题预设。
   *
   * ⚠️ 1.0.56 删掉行内写入后暴露：frosted.css 里还是 1.0.48 该改而漏改的 0.72，
   * 于是默认预设的背景变透明（用户可见回归）。1.0.57 补齐为 0.88，
   * 并由 tests/renderer/styles/theme-vars.test.ts 锁住"默认预设必须等于 :root"。
   *
   * ⚠️ 1.0.59（主用户拍板「显式调过才覆盖预设」）：设置项回来了，但它是
   * `bgOpacityOverride: number | null` —— **null 时不写行内**，此变量仍由
   * 预设单独负责（唯一来源）；只有用户拖过滑块才写行内覆盖。
   *
   * 所以它**仍然留在这份清单里**：每次应用主题前先抹掉，再由 useTheme
   * 按"本次是否覆盖"决定要不要重新写。抹掉是必要的 ——
   * 否则上一次的覆盖会一直压着"跟随预设"之后应有的预设值。
   */
  '--frosted-bg-opacity'
] as const
