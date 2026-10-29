/**
 * 令牌工具类闸门（1.0.115，卡 5fdf9b6d 第二步）
 *
 * ── 这道闸门管什么 ──
 *
 * 第一步（1.0.114）把颜色拆成「通道变量 + 派生」之后，`bg-accent/10` 这类写法
 * 终于产出 CSS 了。但组件里还剩一批**绕过工具类、直接引用令牌**的写法：
 *
 *   · `border-[color:var(--color-success)]/30`、`bg-[var(--surface-muted)]`
 *     —— 能工作，但同一个令牌在组件里与 tailwind 配置里各写一遍，谁都不是唯一入口；
 *     令牌一改名，只有在用到它的组件里静默失效（构建不报、tsc 不管）；
 *   · `text-[--color-status-in-progress]` —— **这条压根不工作**。Tailwind 3 的
 *     任意值里裸写变量要 `var()`，`[--x]` 这种简写在 v3 里一条 CSS 都不产出
 *     （1.0.113/1.0.114 的产物实测：`.text-\[--color-status-in-progress\]` 零命中）。
 *     它的表现是"子任务全完成后图标不变绿"—— 没坏、只是设计意图没到界面上。
 *
 * 第二步把这些全部换成工具类（`border-success/30`、`bg-surface-muted`、
 * `text-status-in-progress`），这道闸门负责"不许长回来"。
 *
 * ── 判据（结构性，不锁具体色值）──
 *   A. 颜色 / 状态 / 派生面的令牌**只能经工具类**消费：class 串里 0 处 `[var(--color-…)]`；
 *   B. class 串里 0 处 `[--x]` 裸变量简写（v3 下必死，且死得没有信号）；
 *   C. 徽章五个 tone 用的颜色名都在配置里真实存在，且不再用任意值；
 *   D. 派生面（surface-*）没有 alpha 过体，就别写 `/NN`（同样静默失效）。
 *
 * 间距 / 尺寸令牌（`p-[var(--space-page)]`）**不在**本闸门范围内：它们是
 * 2f6f8082 那道闸门明确放过的"令牌引用"，不属于本卡的色彩层。
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import tailwindConfig from '../../../tailwind.config'

const ROOT = path.resolve(__dirname, '../../..')
const RENDERER = path.join(ROOT, 'src/renderer')

/** 颜色类令牌的引用型任意值：`[var(--color-x)]` / `[color:var(--status-x)]/30` / `[var(--surface-x)]` */
const COLOR_REF = /\[(?:color:)?var\(--(?:color|status|surface)-[a-z0-9-]+\)\](\/\d{1,3})?/g
/** 裸变量简写：`text-[--color-status-in-progress]`（Tailwind 3 不认，产出 0 条 CSS） */
const BARE_VAR = /\[--[a-z][a-z0-9-]*\]/g
/** 派生面上的 alpha：`bg-surface-muted/50` */
const SURFACE_ALPHA = /\b(?:bg|border|text)-surface-(?:subtle|muted)\/\d{1,3}/g

/** 去掉注释（跨行块注释 + 行尾 `//`），`design-allow:` 的整行豁免 */
function stripComments(source: string): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = []
  let inBlock = false
  source.split(/\r?\n/).forEach((raw, idx) => {
    let line = raw
    if (inBlock) {
      const end = line.indexOf('*/')
      if (end === -1) return
      line = line.slice(end + 2)
      inBlock = false
    }
    while (true) {
      const start = line.indexOf('/*')
      if (start === -1) break
      const end = line.indexOf('*/', start + 2)
      if (end === -1) {
        inBlock = true
        line = line.slice(0, start)
        break
      }
      line = line.slice(0, start) + line.slice(end + 2)
    }
    const slash = line.indexOf('//')
    if (slash !== -1) line = line.slice(0, slash)
    if (/design-allow:\s*\S/.test(raw)) return
    out.push({ line: idx + 1, text: line })
  })
  return out
}

/** 扫描一段源码，返回每个违规点（可注入的纯函数，供自检用） */
export function scanTokenRefs(source: string): { line: number; token: string; kind: string }[] {
  const hits: { line: number; token: string; kind: string }[] = []
  for (const { line, text } of stripComments(source)) {
    for (const re of [COLOR_REF, BARE_VAR, SURFACE_ALPHA] as const) {
      for (const m of text.matchAll(re)) {
        hits.push({ line, token: m[0], kind: re === COLOR_REF ? '引用令牌' : re === BARE_VAR ? '裸变量简写' : '派生面加 alpha' })
      }
    }
  }
  return hits
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name)
    if (fs.statSync(p).isDirectory()) walk(p, out)
    else if (/\.(tsx|ts)$/.test(name)) out.push(p)
  }
  return out
}

const extend = (tailwindConfig as any).theme.extend as Record<string, unknown>
const colorNames = new Set(Object.keys((extend.colors as Record<string, unknown>) ?? {}))
const bgNames = new Set(Object.keys((extend.backgroundColor as Record<string, unknown>) ?? {}))
const BUILTIN =
  /^(?:white|black|transparent|current|inherit|(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)(?:-\d{2,3})?)$/

describe('A / B. class 串里不再「绕过工具类」引用颜色令牌（卡 5fdf9b6d 第二步）', () => {
  it('src/renderer 全量扫描：0 处', () => {
    const offenders: string[] = []
    for (const file of walk(RENDERER)) {
      for (const h of scanTokenRefs(fs.readFileSync(file, 'utf8'))) {
        const rel = path.relative(ROOT, file).split(path.sep).join('/')
        offenders.push(`${rel}:${h.line}  ${h.token}  （${h.kind}）`)
      }
    }
    expect(
      offenders,
      `颜色令牌只能经工具类消费，这些地方又绕回去了：\n  ${offenders.join('\n  ')}\n` +
        `· \`border-[color:var(--color-success)]/30\` → \`border-success/30\`\n` +
        `· \`bg-[var(--surface-muted)]\` → \`bg-surface-muted\`\n` +
        `· \`text-[--color-status-in-progress]\` → \`text-status-in-progress\`（前者在 Tailwind 3 里产出 0 条 CSS）`
    ).toEqual([])
  })

  it('扫描器自检：三种写法都抓得到（否则闸门是假绿）', () => {
    expect(scanTokenRefs(`const a = 'bg-[var(--surface-muted)]'`)).toHaveLength(1)
    expect(scanTokenRefs(`const a = 'border-[color:var(--color-success)]/30'`)).toHaveLength(1)
    expect(scanTokenRefs(`const a = 'text-[--color-status-in-progress]'`)).toHaveLength(1)
    expect(scanTokenRefs(`const a = 'text-[color:var(--status-warning)]'`)).toHaveLength(1)
    expect(scanTokenRefs(`const a = 'bg-surface-muted/50'`)).toHaveLength(1)
    // 注释里的旧写法不算；工具类本身当然也不算
    expect(scanTokenRefs(`// 旧写法 bg-[var(--surface-muted)] 已换掉`)).toEqual([])
    expect(scanTokenRefs(`/* border-[color:var(--color-success)]/30 */ const a = 'border-success/30'`)).toEqual([])
    expect(scanTokenRefs(`const a = 'bg-accent/10 text-text-secondary/70'`)).toEqual([])
    // 间距 / 尺寸令牌不在本闸门范围（2f6f8082 明确放过令牌引用）
    expect(scanTokenRefs(`const a = 'p-[var(--space-page)]'`)).toEqual([])
    // 显式豁免仍然是逃生口
    expect(scanTokenRefs(`const a = 'bg-[var(--surface-muted)]' // design-allow: 待迁移`)).toEqual([])
  })
})

describe('C. 徽章 tone 表：颜色名都在配置里，且不再写任意值', () => {
  const src = fs.readFileSync(path.join(RENDERER, 'components/ui/Badge.tsx'), 'utf8')

  /** 从 Badge.tsx 里抽出五个 tone 的 class 串 */
  function toneClasses(): Record<string, string> {
    const out: Record<string, string> = {}
    for (const m of src.matchAll(/(neutral|accent|success|warning|danger):\s*'([^']*)'/g)) out[m[1]] = m[2]
    return out
  }

  it('五个 tone 都抽得到（解析失败会让下面几条恒真）', () => {
    expect(Object.keys(toneClasses()).sort()).toEqual(['accent', 'danger', 'neutral', 'success', 'warning'])
  })

  it('每个颜色类都指向配置里真实存在的名字（写错就是静默失效）', () => {
    const unknown: string[] = []
    for (const [tone, cls] of Object.entries(toneClasses())) {
      for (const m of cls.matchAll(/\b(?:bg|border|text)-([a-z0-9-]+)(?:\/\d{1,3})?/g)) {
        const name = m[1]
        const util = m[0].split('-')[0]
        if (util === 'bg' && (bgNames.has(name) || colorNames.has(name) || BUILTIN.test(name))) continue
        if (util !== 'bg' && (colorNames.has(name) || BUILTIN.test(name))) continue
        unknown.push(`${tone}: ${m[0]}（${util} 里没有 ${name}）`)
      }
    }
    expect(unknown, `徽章 tone 表里有不存在的颜色名：\n  ${unknown.join('\n  ')}`).toEqual([])
  })

  it('成功 / 警告 / 危险 / 强调四档仍是「淡底 + 描边 + 同色字」（色源自通道，可加 alpha）', () => {
    const tones = toneClasses()
    for (const tone of ['accent', 'success', 'warning', 'danger']) {
      expect(tones[tone], `${tone} 缺 bg-<名>/10`).toMatch(/\bbg-[a-z0-9-]+\/10\b/)
      expect(tones[tone], `${tone} 缺 border-<名>/30`).toMatch(/\bborder-[a-z0-9-]+\/30\b/)
      expect(tones[tone], `${tone} 缺 text-<名>`).toMatch(/\btext-[a-z0-9-]+\b/)
    }
  })

  it('neutral 的底是派生面，不写 alpha（它没有 alpha 过体）', () => {
    expect(toneClasses().neutral).toBe('border-border bg-surface-muted text-text-secondary')
  })
})

describe('D. 派生面没有 alpha 过体（写了就是 0 条 CSS）', () => {
  it('tailwind 的 backgroundColor 里登记了面，且值指向 variables.css 的变量', () => {
    expect(bgNames.has('surface-subtle')).toBe(true)
    expect(bgNames.has('surface-muted')).toBe(true)
    const css = fs.readFileSync(path.join(RENDERER, 'styles/variables.css'), 'utf8')
    expect(css).toMatch(/--surface-subtle:\s*\S/)
    expect(css).toMatch(/--surface-muted:\s*\S/)
  })

  it('面不进 colors（进了就得是通道形态，它做不到 —— 代价是加不了 alpha）', () => {
    expect(colorNames.has('surface-subtle')).toBe(false)
    expect(colorNames.has('surface-muted')).toBe(false)
  })
})
