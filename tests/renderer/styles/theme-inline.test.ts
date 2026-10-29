import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { toRgbChannels, applyCustomColors } from '../../../src/renderer/lib/theme-inline'

/**
 * 主题行内样式的"越权"闸门（1.0.55，修一致性 B3）
 *
 * ── 为什么需要这道测试 ──
 *
 * `useTheme` 会把主题变量写成 `<html>` 的**行内样式**。行内样式的
 * 优先级**永远高于**任何 CSS 规则，所以一个变量只要被 JS 写过一次，
 * 主题文件（`themes/*.css`）里给它的声明就**再也读不到**。
 *
 * 这类失效**不报错**：tsc 绿、lint 绿、单元测试绿，只有人到界面上逐项
 * 比对才发现"切了预设跟没切一样"。1.0.50 就是在这个坑里翻车的：
 * `--frosted-bg-opacity` 被 `settings.windowOpacity` 行内永久压住，
 * 主题文件里 frosted 0.72 / japanese 0.88 两个值从未生效。
 *
 * 所以闸门锁的是**权威的唯一性**（与 `theme-vars.test.ts` 同一套思路）：
 *
 *   1. 主题文件负责权威的变量，`useTheme` 不得写行内；
 *   2. 每个 `[data-preset]` 里声明的变量都要有真实消费方 ——
 *      否则是"写了没人读"的悬空声明（B3 的另一半）。
 *
 * 判据是结构性的：不把颜色/数值写死进测试，改配色不必改测试。
 */

const ROOT = path.resolve(__dirname, '../../..')
const STYLES = path.join(ROOT, 'src/renderer/styles')
const HOOK = path.join(ROOT, 'src/renderer/hooks/useTheme.ts')
const THEME_INLINE = path.join(ROOT, 'src/renderer/lib/theme-inline.ts')

/** 从 CSS 文本里抽出所有 `--var: value` 声明的变量名 */
function declaredVars(css: string): string[] {
  const cleaned = css.replace(/\/\*[\s\S]*?\*\//g, '')
  return [...cleaned.matchAll(/^\s*(--[a-zA-Z0-9-]+)\s*:/gm)].map((m) => m[1])
}

/** 从 `[data-preset='x'] { ... }` 块里抽出声明的变量名 */
function presetVars(css: string): string[] {
  const m = css.match(/\[data-preset='[^']+'\]\s*\{([\s\S]*?)\}/)
  return m ? declaredVars(m[1]) : []
}

const read = (rel: string) => fs.readFileSync(path.join(STYLES, rel), 'utf8')

/** 两个预设声明的变量并集 */
const presetVarsAll = (): string[] => [
  ...new Set([
    ...presetVars(read('themes/frosted.css')),
    ...presetVars(read('themes/japanese.css'))
  ])
]

describe('主题行内样式的越权闸门', () => {
  it('解析得到基础数据（防止闸门因解析失败而假通过）', () => {
    // 若主题文件被改名/改格式导致解析出 0 条，下文的"没有越权"断言会
    // **静默变成永远通过**，闸门就废了。
    expect(presetVars(read('themes/frosted.css')).length).toBeGreaterThan(5)
    expect(presetVars(read('themes/japanese.css')).length).toBeGreaterThan(5)
  })

  it('useTheme 不得写行内样式覆盖"主题文件负责"的变量', () => {
    const hook = fs.readFileSync(HOOK, 'utf8')

    // theme-inline.ts 里登记的、由 CSS 负责权威的变量
    const inlineSrc = fs.readFileSync(THEME_INLINE, 'utf8')
    const block = inlineSrc.match(/CSS_OWNED_THEME_VARS\s*=\s*\[([\s\S]*?)\]/)
    expect(block, '在 theme-inline.ts 里找不到 CSS_OWNED_THEME_VARS 清单').toBeTruthy()
    const owned = [...block![1].matchAll(/'(--[a-zA-Z0-9-]+)'/g)].map((m) => m[1])
    expect(owned.length, '清单为空，闸门失去意义').toBeGreaterThan(0)

    // 逐个确认 useTheme 里没有 setProperty('--xxx', ...) 直接写这些变量
    const offenders = owned.filter((v) =>
      new RegExp(`setProperty\\(\\s*['"\`]${v}['"\`]`).test(hook)
    )
    expect(
      offenders,
      `useTheme 把 ${offenders.join(', ')} 写成了行内样式。\n` +
        `行内优先级高于 [data-preset] 规则 → 主题文件里的值再也读不到，\n` +
        `切预设时这一项不会变化（B3 的根因，1.0.50 已经踩过一次）。\n` +
        `如确实需要 JS 驱动，请从 CSS_OWNED_THEME_VARS 里移除并同步删除主题文件声明。`
    ).toEqual([])
  })

  it('每个预设声明的变量都要真的到达界面（不许写了没人读）', () => {
    /**
     * ── 为什么这道断言要写成"到达界面"，而不是"有没有 var(--x)" ──
     *
     * 1.0.50 那份一致性报告在这里判错过：它只查"别处出现过 var(--x) 吗"，
     * 于是 `--radius-kanban` 因为在 `tailwind.config.ts` 里被引用而被判成
     * "有消费方"。**但没有任何组件用过 `rounded-kanban` 这个类** ——
     * 变量接进了工具类，工具类却没人用，值依然到不了界面。
     *
     * 所以判据必须是**整条链**：
     *   主题文件声明 → tailwind 工具类（或 CSS 直接用）→ 组件里真的用了这个类
     * 缺最后一步，就是"写了没人读"。
     *
     * 覆盖面：src/ 全量 + tailwind.config.ts。
     * **只扫 src/ 会漏掉 tailwind.config.ts**（4 个变量曾被误判为悬空）。
     */
    const tailwind = fs.readFileSync(path.join(ROOT, 'tailwind.config.ts'), 'utf8')

    // src/ 下所有 ts/tsx/css 的正文（tool class 的使用点在这里）
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name)
        if (e.isDirectory()) walk(full, out)
        else if (/\.(ts|tsx|css)$/.test(e.name)) out.push(fs.readFileSync(full, 'utf8'))
      }
      return out
    }
    const srcText = walk(path.join(ROOT, 'src')).join('\n')

    /**
     * 从 tailwind `theme.extend` 里抽出 `key: 'var(--xxx, fallback)'`，
     * 并按属性族推出"该 key 对应哪些工具类前缀"。
     * 只列本配置里真实存在、且前缀无歧义的族。
     */
    const FAMILY_PREFIXES: Record<string, string[]> = {
      borderRadius: ['rounded'],
      boxShadow: ['shadow'],
      fontSize: ['text'],
      width: ['w'],
      height: ['h'],
      // spacing 的前缀很多，逐个列全，避免"用了 p-card 却判它没消费"
      spacing: ['p', 'px', 'py', 'pt', 'pb', 'pl', 'pr', 'm', 'mx', 'my', 'mt', 'mb', 'ml', 'mr', 'gap', 'gap-x', 'gap-y', 'space-x', 'space-y']
    }

    /** 找出 tailwind 里所有 `key: 'var(--xxx…'` 的接线 */
    const wiring: Array<{ key: string; variable: string; family: string }> = []
    for (const [family, _prefixes] of Object.entries(FAMILY_PREFIXES)) {
      const block = tailwind.match(new RegExp(`${family}:\\s*\\{([\\s\\S]*?)\\n\\s*\\}`))
      if (!block) continue
      const cleaned = block[1].replace(/\/\*[\s\S]*?\*\//g, '')
      for (const m of cleaned.matchAll(/['"]?([\w-]+)['"]?\s*:\s*['"`]var\((--[\w-]+)/g)) {
        wiring.push({ key: m[1], variable: m[2], family })
      }
    }

    expect(wiring.length, 'tailwind 里没解析到任何变量接线，闸门失效').toBeGreaterThan(5)

    /** 类名在组件里是否出现过（含 hover:/focus: 等变体前缀） */
    const classUsed = (cls: string) =>
      new RegExp(`(?<![\\w-])${cls.replace(/[-/]/g, '[-/]')}(?![\\w-])`).test(srcText)

    // 只有"变量确实接到 tailwind"的那些才走这条链；
    // 直接写在 CSS 里的（如 --frosted-blur）由下面的兜底分支处理。
    const unreachable = wiring
      .filter(({ variable, family, key }) => {
        if (!presetVarsAll().includes(variable)) return false
        // 是否有 CSS 直接消费（非 tailwind）：有就算到达
        const direct = new RegExp(`var\\(\\s*${variable}\\b`).test(
          walk(path.join(ROOT, 'src/renderer/styles')).join('\n')
        )
        if (direct) return false
        const prefixes = FAMILY_PREFIXES[family]
        // 任一前缀 + key 的组合被用过，就算到达
        return !prefixes.some((p) => classUsed(`${p}-${key}`))
      })
      .map(({ variable, family, key }) => `${variable}（tailwind 键 \`${key}\`，族 ${family}）`)

    expect(
      unreachable,
      `这些变量接到了 tailwind 工具类，但没有任何组件用过那个类 —— 值到不了界面：\n` +
        `  ${unreachable.join('\n  ')}\n` +
        `接进 tailwind 只是中间一步，"有人用这个类"才算真的到达（B4 的死类就是这个）。\n` +
        `请二选一：删掉声明与接线，或让组件真的用上这个工具类。`
    ).toEqual([])

    // 兜底：更早的"完全没人引用"检查仍然保留，两档都过才算干净
    const allSrc = srcText + '\n' + tailwind
    const orphans = presetVarsAll().filter((v) => {
      const re = new RegExp(`var\\(\\s*${v}\\b`, 'g')
      return (allSrc.match(re) ?? []).length === 0
    })
    expect(
      orphans,
      `这些变量在 [data-preset] 里声明了，但全仓找不到 var(--xxx) 消费方：\n` +
        `  ${orphans.join(', ')}\n` +
        `属于"写了没人读"的悬空声明。请删掉声明，或接到真实消费方上。`
    ).toEqual([])
  })
})

/**
 * 自定义颜色的行内覆盖（1.0.114，卡 5fdf9b6d 第一步）
 *
 * ── 为什么要单独锁这一组 ──
 *
 * 颜色层改成「通道变量 + 派生完整色值」之后，工具类生成的是
 * `rgb(var(--color-accent-rgb) / <alpha-value>)`。此时如果设置里的自定义颜色
 * 还按老写法写行内 `--color-accent: #xxxxxx`，那么：
 *   · `var(--color-accent)`（少数直写 CSS 的地方）跟着变；
 *   · `bg-accent`（主按钮底色）、`bg-accent/10` 却读通道变量 → **纹丝不动**。
 * 也就是"在设置里换了主题色，按钮还是原来的颜色"，而且不报错。
 *
 * 所以判据落在"写哪个变量"上：能解析成通道的，只写 `-rgb`；两种形态的旧值都要先抹掉。
 */
describe('自定义颜色：只写通道变量（卡 5fdf9b6d）', () => {
  const fakeRoot = () => {
    const written = new Map<string, string>()
    return {
      written,
      style: {
        setProperty: (n: string, v: string) => void written.set(n, v),
        removeProperty: (n: string) => void written.delete(n)
      }
    }
  }

  it('十六进制能转成 R G B 三段（3 位/6 位/带 alpha/大写）', () => {
    expect(toRgbChannels('#111827')).toBe('17 24 39')
    expect(toRgbChannels('#fff')).toBe('255 255 255')
    expect(toRgbChannels('#7BA4F7')).toBe('123 164 247')
    expect(toRgbChannels('#7BA4F7FF')).toBe('123 164 247')
    expect(toRgbChannels('#abcd')).toBe('170 187 204')
  })

  it('rgb()/rgba() 也认；认不出的返回 null（调用方退回完整色值）', () => {
    expect(toRgbChannels('rgb(1, 2, 3)')).toBe('1 2 3')
    expect(toRgbChannels('rgba(255,0,10,0.5)')).toBe('255 0 10')
    expect(toRgbChannels('not-a-color')).toBeNull()
    expect(toRgbChannels('#12')).toBeNull()
    expect(toRgbChannels('rgb(300,0,0)')).toBeNull()
  })

  it('写的是通道变量，不是完整色值', () => {
    const root = fakeRoot()
    const written = applyCustomColors(root, { accent: '#111827', reminderGlow: '#82b1ff' })
    expect(written).toEqual(['--color-accent-rgb', '--color-reminder-glow-rgb'])
    expect(root.written.get('--color-accent-rgb')).toBe('17 24 39')
    expect(root.written.has('--color-accent')).toBe(false)
    expect(root.written.get('--color-reminder-glow-rgb')).toBe('130 177 255')
  })

  it('重置某项（undefined）时两种形态的行内值都被抹掉，回落到主题', () => {
    const root = fakeRoot()
    applyCustomColors(root, { accent: '#111827' })
    expect(root.written.has('--color-accent-rgb')).toBe(true)

    applyCustomColors(root, { accent: undefined })
    expect(root.written.has('--color-accent-rgb')).toBe(false)
    expect(root.written.has('--color-accent')).toBe(false)
  })

  it('解析不了的色值退回写完整色值（不做静默丢弃）', () => {
    const root = fakeRoot()
    const written = applyCustomColors(root, { accent: 'oklch(0.6 0.1 200)' })
    expect(written).toEqual(['--color-accent'])
    expect(root.written.get('--color-accent')).toBe('oklch(0.6 0.1 200)')
  })
})
