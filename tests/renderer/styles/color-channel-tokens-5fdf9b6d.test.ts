import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 颜色「通道变量」闸门（1.0.114，卡 5fdf9b6d 第一步）
 *
 * ── 它挡的是什么 ──
 *
 * Tailwind 3 只给 `rgb(var(--x) / <alpha-value>)` 这种形态生成透明度变体。
 * 颜色变量若是**完整色值**（`--color-accent: #111827`），那么
 * `bg-accent/10`、`text-text-secondary/70`、`border-success/30` 这些类
 * **一条 CSS 都不会产出** —— 而且是静默的：构建不报错、tsc 不管，
 * 界面上只是"底色和描边凭空消失"。1.0.113 及以前 154 处 / 45 文件都是这样空写着，
 * 状态徽章只剩文字是绿的，底色 `rgba(0,0,0,0)`、边框是浏览器默认灰。
 *
 * 修法是把颜色拆成两半：`--color-accent-rgb: 17 24 39`（通道，主题只覆盖这一层）
 * + `--color-accent: rgb(var(--color-accent-rgb))`（派生，只在 :root 一处）。
 * 这两半一旦有人写歪（直接给 `--color-x` 赋十六进制、或在主题里重复派生、或配置里
 * 退回 `var(--color-x)`），透明度又会**悄悄**失效，而没有任何其它信号。
 *
 * ── 为什么判据里不写死具体色值 ──
 *
 * 改配色不该被迫先改测试：这里只关心**结构**（谁派生谁、配置用哪种形态），
 * 以及"源码里用到的颜色名确实进了配置"。
 */

const ROOT = path.resolve(__dirname, '../../..')
const VARS = path.join(ROOT, 'src/renderer/styles/variables.css')
const THEME_DIR = path.join(ROOT, 'src/renderer/styles/themes')
const TAILWIND = path.join(ROOT, 'tailwind.config.ts')

const varsCss = fs.readFileSync(VARS, 'utf8')
const tailwindSrc = fs.readFileSync(TAILWIND, 'utf8')

/** 抽 tailwind.config.ts 里 `colors: { ... }` 块内的 `键: '值',` */
function readColorsBlock(src: string): Map<string, string> {
  const start = src.indexOf('colors: {')
  if (start < 0) return new Map()
  const open = src.indexOf('{', start)
  let depth = 0
  let end = -1
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  const body = src.slice(open + 1, end)
  const cleaned = body.replace(/\/\*[\s\S]*?\*\//g, '')
  const out = new Map<string, string>()
  for (const line of cleaned.split('\n')) {
    const m = line.match(/^\s*'?([a-zA-Z0-9-]+)'?\s*:\s*'(.+?)',?\s*$/)
    if (m) out.set(m[1], m[2])
  }
  return out
}

const colors = readColorsBlock(tailwindSrc)

/** 源码里的颜色名（`<util>-<name>/<alpha>` 的 name） */
const UTIL_TOKEN = /(?:[a-z-]+:)*(?:bg|text|border|ring|divide|outline|decoration|from|via|to)-([a-z0-9-]+)\/\d{1,3}/g

function walk(dir: string, out: string[] = []): string[] {
  for (const n of fs.readdirSync(dir)) {
    const p = path.join(dir, n)
    if (fs.statSync(p).isDirectory()) walk(p, out)
    else if (/\.(tsx|ts)$/.test(n)) out.push(p)
  }
  return out
}

const usedNames = new Map<string, string[]>()
for (const f of walk(path.join(ROOT, 'src/renderer'))) {
  const src = fs.readFileSync(f, 'utf8')
  for (const m of src.matchAll(UTIL_TOKEN)) {
    const name = m[1]
    const rel = path.relative(ROOT, f).split(path.sep).join('/')
    usedNames.set(name, [...(usedNames.get(name) ?? []), rel])
  }
}

/** Tailwind 自带的调色板：这些名字本来就有 alpha 变体，不在本项目颜色表里 */
const BUILTIN =
  /^(?:white|black|transparent|current|inherit|(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)(?:-\d{2,3})?)$/

const CHANNEL_VAR = /^\s*(--[a-z0-9-]+-rgb):\s*(\d{1,3} \d{1,3} \d{1,3});/gm
const channels = [...varsCss.matchAll(CHANNEL_VAR)].map((m) => m[1])

const DERIVED = /^\s*(--[a-z0-9-]+):\s*rgb\(var\((--[a-z0-9-]+-rgb)\)\);$/gm
const derived = [...varsCss.matchAll(DERIVED)].map((m) => ({ name: m[1], from: m[2] }))

describe('颜色通道变量：让 /alpha 真的产出 CSS（卡 5fdf9b6d）', () => {
  it('解析得到基础数据（防止闸门因解析失败而假通过）', () => {
    expect(colors.size, 'tailwind colors 一条都没解析出来，闸门失效').toBeGreaterThan(15)
    expect(channels.length, 'variables.css 里没有通道变量，闸门失效').toBeGreaterThan(15)
    expect(derived.length, 'variables.css 里没有派生声明，闸门失效').toBeGreaterThan(15)
  })

  it('配置里每个颜色都是 `rgb(var(--x-rgb) / <alpha-value>)` 形态', () => {
    const wrong = [...colors.entries()]
      .filter(([, v]) => !/^rgb\(var\(--[a-z0-9-]+-rgb\) \/ <alpha-value>\)$/.test(v))
      .map(([k, v]) => `${k}: ${v}`)
    expect(
      wrong,
      `这些颜色不是通道形态：\n  ${wrong.join('\n  ')}\n` +
        `颜色写成 \`var(--color-x)\`（完整色值）时，\`bg-accent/10\` 这类类**一条 CSS 都不产出**，\n` +
        `而且是静默的 —— 1.0.113 的 154 处空写就是这么来的。`
    ).toEqual([])
  })

  it('配置引用的每个通道变量都在 variables.css 里有声明', () => {
    const missing = [...colors.values()]
      .map((v) => v.match(/var\((--[a-z0-9-]+)\)/)?.[1])
      .filter((v): v is string => Boolean(v))
      .filter((v) => !channels.includes(v))
    expect(missing, `tailwind 引用了未声明的通道变量：${missing.join(', ')}`).toEqual([])
  })

  it('每个通道变量都有且只有一条派生声明（一个来源）', () => {
    const derivationsPer = new Map<string, number>()
    for (const d of derived) derivationsPer.set(d.from, (derivationsPer.get(d.from) ?? 0) + 1)

    const missing = channels.filter((c) => !derivationsPer.has(c))
    const dup = [...derivationsPer.entries()].filter(([, n]) => n > 1).map(([k]) => k)
    expect(missing, `通道变量没有派生完整色值（组件里 var(--x) 会是空的）：${missing.join(', ')}`).toEqual([])
    expect(dup, `同一个通道被派生了两遍（两处来源）：${dup.join(', ')}`).toEqual([])
  })

  it('主题文件只覆盖通道变量，不自己写完整色值', () => {
    const offenders: string[] = []
    for (const f of fs.readdirSync(THEME_DIR).filter((n) => n.endsWith('.css'))) {
      const css = fs.readFileSync(path.join(THEME_DIR, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
      for (const m of css.matchAll(/^\s*(--[a-z0-9-]+):\s*(.+?);/gm)) {
        const [, name, value] = m
        // 主题里允许声明非颜色变量的完整值（圆角、阴影、间距…）；
        // 颜色变量（`--color-*` / `--status-*`）必须只写通道形式。
        if (!/^--(?:color|status)-/.test(name)) continue
        if (!/-rgb$/.test(name)) offenders.push(`${f}: ${name}: ${value}`)
      }
    }
    expect(
      offenders,
      `主题文件里这些颜色没走通道（会在派生之前抢走权威）：\n  ${offenders.join('\n  ')}\n` +
        `请改成 \`--color-x-rgb: R G B\`；完整色值只在 variables.css 的 :root 派生一次。`
    ).toEqual([])
  })

  it('源码里带 /alpha 的颜色名都在配置或 Tailwind 内置调色板里', () => {
    const unknown = [...usedNames.entries()]
      .filter(([name]) => !colors.has(name) && !BUILTIN.test(name))
      .map(([name, files]) => `${name}（${[...new Set(files)].slice(0, 3).join(', ')}）`)
    expect(
      unknown,
      `这些颜色名既不在 tailwind colors 里，也不是 Tailwind 内置色：\n  ${unknown.join('\n  ')}\n` +
        `写出来的类不会产出任何 CSS（1.0.113 的 bg-warning/5、border-warning/60、bg-danger/10 就是这种，\n` +
        `11 处连类都不存在）。要么加进 colors，要么换成已有的名字。`
    ).toEqual([])
  })
})
