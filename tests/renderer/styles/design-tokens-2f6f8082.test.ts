import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import tailwindConfig from '../../../tailwind.config'
import { cn } from '../../../src/renderer/lib/utils'
import {
  FONT_FAMILY_TOKENS,
  FONT_SIZE_TOKENS,
  LETTER_SPACING_TOKENS,
  MAX_HEIGHT_TOKENS,
  MAX_WIDTH_TOKENS,
  RADIUS_TOKENS,
  WIDTH_TOKENS
} from '../../../src/renderer/lib/design-tokens'

/**
 * 设计令牌闸门（1.0.114，卡 2f6f8082）
 *
 * ── 为什么要有这道闸门 ──
 *
 * 令牌层（variables.css + tailwind.config.ts）一直是齐的，缺的是**执法**：
 * 35 个组件文件里 115 处绕开令牌直接写 `text-[11px]` / `w-[248px]` /
 * `shadow-[0_18px_45px_rgba(17,24,39,0.16)]`。代价不是"不好看"，而是
 * **四套主题在这些地方长得一模一样** —— 换主题时得人工比对 115 处。
 *
 * 1.0.114 把存量的 115 处清完（值一律照原样进令牌，只归一了几处差 ≤8px 的宽度），
 * 这道闸门负责"不许长回来"。
 *
 * ── 判据（四条，都是结构性的，不锁具体数值）──
 *
 *   A. `src/renderer` 的 class 串里**没有任意值**（magic number / 裸色值）；
 *   B. tailwind 里每个 `var(--x)` 都指向 variables.css 里真实存在的变量
 *      （否则工具类静默失效 —— 这类故障 tsc 与构建都不报）；
 *   C. 登记给 `cn()` 的令牌名（lib/design-tokens.ts）与 tailwind 配置的键一一对应；
 *   D. `cn()` 认得这些名字：同组会互相覆盖、跨组共存。
 *
 * ⚠️ 不加"某个令牌等于多少像素"的断言：那会让"调一档间距"被迫先改测试
 * （theme-vars.test.ts 里同一条判据已写过一遍）。值的正确性靠 diff 评审，
 * 靠"换主题时表现一致"来验。
 */

const ROOT = path.resolve(__dirname, '../../..')
const RENDERER = path.join(ROOT, 'src/renderer')
const VARIABLES = path.join(RENDERER, 'styles/variables.css')

/** 任意值里"要拦"的东西：magic number / 裸色值 / 颜色函数 */
const MAGIC = /(?:\d(?:\.\d+)?(?:px|rem|em|ch|vh|vw|%|pt))|(?:#[0-9a-fA-F]{3,8}\b)|(?:(?:rgba?|hsla?)\(\)?)/

/**
 * 从一个源文件里抽出所有"看起来像 class 串"的 token 与任意值
 *
 * 三条刻意的宽容（都有理由，不是漏网）：
 *  1. 注释里的例子不算（`// 例如 w-[240px]` 是解释，不是样式）；
 *  2. `[var(--token)]` / `[color:var(--x)]` 这类**引用令牌**的写法不算 magic number；
 *  3. 行内写了 `design-allow: <理由>` 的，整行豁免 —— 闸门会把它数出来
 *     （card 里说的"真要写任意值必须显式留痕"就是这个）。
 */
export function scanArbitraryValues(source: string): { line: number; token: string }[] {
  const found: { line: number; token: string }[] = []
  const lines = source.split(/\r?\n/)
  let inBlockComment = false

  lines.forEach((rawLine, idx) => {
    let line = rawLine
    // 去掉块注释（跨行的也算）
    if (inBlockComment) {
      const end = line.indexOf('*/')
      if (end === -1) return
      line = line.slice(end + 2)
      inBlockComment = false
    }
    while (true) {
      const start = line.indexOf('/*')
      if (start === -1) break
      const end = line.indexOf('*/', start + 2)
      if (end === -1) {
        inBlockComment = true
        line = line.slice(0, start)
        break
      }
      line = line.slice(0, start) + line.slice(end + 2)
    }
    const lineComment = line.indexOf('//')
    if (lineComment !== -1) line = line.slice(0, lineComment)
    if (/design-allow:\s*\S/.test(rawLine)) return

    // 按方括号组切，而不是按空白切：`shadow-[0_8px_24px_rgba(17,24,39,0.05)]`
    // 里面的逗号与圆括号会把 token 切碎（第一版就是这么漏掉阴影的）
    for (const m of line.matchAll(/\[([^\]\n]*)\]/g)) {
      const inner = m[1]
      if (inner.includes('var(--')) continue
      if (!MAGIC.test(inner)) continue
      found.push({ line: idx + 1, token: `[${inner}]` })
    }
  })

  return found
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name)
    if (fs.statSync(p).isDirectory()) walk(p, out)
    else if (/\.(tsx|ts)$/.test(name)) out.push(p)
  }
  return out
}

/** variables.css 里 `:root` 块声明的变量（去掉注释后按行解析） */
function declaredVars(): Map<string, string> {
  const css = fs.readFileSync(VARIABLES, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  const vars = new Map<string, string>()
  for (const m of css.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) vars.set(m[1], m[2].trim())
  return vars
}

describe('A. 不许在 class 串里写任意值（卡 2f6f8082）', () => {
  it('src/renderer 全量扫描：0 处任意值', () => {
    const offenders: string[] = []
    for (const file of walk(RENDERER)) {
      const hits = scanArbitraryValues(fs.readFileSync(file, 'utf8'))
      for (const h of hits) {
        offenders.push(`${path.relative(ROOT, file).replace(/\\/g, '/')}:${h.line}  ${h.token}`)
      }
    }
    expect(
      offenders,
      `发现任意值（该进令牌，或在同一行写 "design-allow: <理由>" 显式豁免）：\n${offenders.join('\n')}`
    ).toEqual([])
  })

  it('扫描器自检：抓得到 magic number 与裸色值', () => {
    expect(scanArbitraryValues(`const a = 'w-[248px]'`)).toEqual([{ line: 1, token: '[248px]' }])
    expect(scanArbitraryValues(`const a = 'bg-[#5388F6] text-[11px]'`)).toHaveLength(2)
    expect(scanArbitraryValues(`const a = 'max-h-[90vh]'`)).toHaveLength(1)
    // 阴影里的逗号与圆括号不能把 token 切碎（第一版就是这么漏掉的）
    expect(scanArbitraryValues(`const a = 'shadow-[0_8px_24px_rgba(17,24,39,0.05)]'`)).toEqual([
      { line: 1, token: '[0_8px_24px_rgba(17,24,39,0.05)]' }
    ])
    // 数组里的色板也算（否则"写进数组"就是绕过闸门的后门）
    expect(scanArbitraryValues(`const PALETTE = ['#5388F6', '#65C19C']`)).toHaveLength(1)
  })

  it('扫描器自检：放过令牌引用、注释与显式豁免', () => {
    expect(scanArbitraryValues(`const a = 'bg-[var(--surface-muted)]'`)).toEqual([])
    expect(scanArbitraryValues(`const a = 'border-[color:var(--color-success)]/30'`)).toEqual([])
    expect(scanArbitraryValues(`// 旧写法 w-[248px] 已收进令牌`)).toEqual([])
    expect(scanArbitraryValues(`/* w-[248px] */ const a = 'w-sidebar'`)).toEqual([])
    expect(scanArbitraryValues(`const a = 'w-[248px]' // design-allow: 打印宽度，随打印机型号变`)).toEqual([])
  })
})

describe('B. tailwind 里的每个 var(--x) 都真的有定义（卡 2f6f8082）', () => {
  it('工具类引用的令牌名都出现在 variables.css', () => {
    const declared = declaredVars()
    const extend = (tailwindConfig as any).theme.extend as Record<string, unknown>
    const missing: string[] = []

    const collect = (node: unknown, trail: string) => {
      if (typeof node === 'string') {
        for (const m of node.matchAll(/var\((--[a-z0-9-]+)/gi)) {
          if (!declared.has(m[1])) missing.push(`${trail} → ${m[1]}`)
        }
        return
      }
      if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node as Record<string, unknown>)) collect(v, `${trail}.${k}`)
      }
    }
    collect(extend, 'theme.extend')

    expect(missing, `这些工具类指向了不存在的变量（样式会静默失效）：\n${missing.join('\n')}`).toEqual([])
  })

  it('字号 / 字距 / 圆角 / 尺寸组都已接进 extend', () => {
    const extend = (tailwindConfig as any).theme.extend
    for (const key of ['fontSize', 'letterSpacing', 'fontFamily', 'borderRadius', 'width', 'maxWidth', 'maxHeight', 'borderWidth', 'spacing']) {
      expect(extend, `extend.${key} 缺失`).toHaveProperty(key)
    }
  })
})

describe('C. cn() 认得的名字与 tailwind 配置一一对应（卡 2f6f8082）', () => {
  const extend = (tailwindConfig as any).theme.extend

  it('字号：清单里每个名字都在 tailwind fontSize 里', () => {
    for (const name of FONT_SIZE_TOKENS) expect(Object.keys(extend.fontSize)).toContain(name)
  })

  it('字体族 / 字距 / 圆角 / 宽度 / 最大宽 / 最大高 同理', () => {
    for (const name of FONT_FAMILY_TOKENS) expect(Object.keys(extend.fontFamily)).toContain(name)
    for (const name of LETTER_SPACING_TOKENS) expect(Object.keys(extend.letterSpacing)).toContain(name)
    for (const name of RADIUS_TOKENS) expect(Object.keys(extend.borderRadius)).toContain(name)
    for (const name of WIDTH_TOKENS) expect(Object.keys(extend.width)).toContain(name)
    for (const name of MAX_WIDTH_TOKENS) expect(Object.keys(extend.maxWidth)).toContain(name)
    for (const name of MAX_HEIGHT_TOKENS) expect(Object.keys(extend.maxHeight)).toContain(name)
  })
})

describe('D. cn() 的分组行为（认不出名字就会被静默吞掉）', () => {
  it('字号与颜色是两组：text-caption 不会被 text-text-secondary 吃掉', () => {
    expect(cn('text-caption', 'text-text-secondary')).toBe('text-caption text-text-secondary')
    expect(cn('text-title', 'text-text-primary')).toBe('text-title text-text-primary')
  })

  it('同组后者胜：对话框尺寸覆盖得住 Dialog 的基准上限', () => {
    expect(cn('max-w-dialog', 'max-w-dialog-lg')).toBe('max-w-dialog-lg')
    expect(cn('w-sidebar', 'w-60')).toBe('w-60')
    expect(cn('max-h-dialog', 'max-h-60')).toBe('max-h-60')
    expect(cn('rounded-panel', 'rounded-card')).toBe('rounded-card')
    expect(cn('tracking-label', 'tracking-tight')).toBe('tracking-tight')
    expect(cn('font-mono', 'font-sans')).toBe('font-sans')
  })

  it('跨组共存：宽度与最大宽不是一回事', () => {
    expect(cn('w-drawer', 'max-w-snackbar')).toBe('w-drawer max-w-snackbar')
  })
})
