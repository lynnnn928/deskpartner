/**
 * 阴影令牌闸门（1.0.116，验收反馈转来的一处真残留）
 *
 * ── 要锁住的现象 ──
 *
 * 悬浮球的未读呼吸光晕原来是组件里的一行内联样式：
 *
 *     style={{ boxShadow: '0 0 12px 3px rgba(130, 177, 255, 0.4)' }}
 *
 * 几何是 magic number，颜色是**硬编码 rgba** —— 正好绕开 1.0.114/1.0.115 刚做完的通道化：
 * 换光晕色要改组件、主题跟不动。它躲过了所有既有闸门，因为那些闸门扫的是 **class 串**
 * （`[...]` 任意值），看不见 `style={{}}` 里的裸色值。这是"闸门的盲区"，不是"写法的小毛病"。
 *
 * ── 判据 ──
 *   A. `variables.css` 声明的每个 `--shadow-*` 都接进了 tailwind 的 `boxShadow`
 *      （否则就是死令牌 —— 1.0.113 那批 `shadow-card` 之类全都没有对应工具类）；
 *   B. 反过来每个 `boxShadow` 值都指向已声明的变量（配置里写死一份值 = 两处来源）；
 *   C. 光晕的颜色走**通道 + alpha**（`rgb(var(--color-reminder-glow-rgb) / 0.4)`）；
 *   D. 组件里不再有内联 `boxShadow` 字面量（这是本次的盲区，单独立一条钉住）。
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import tailwindConfig from '../../../tailwind.config'

const ROOT = path.resolve(__dirname, '../../..')
const RENDERER = path.join(ROOT, 'src/renderer')
const VARS = path.join(RENDERER, 'styles/variables.css')

const varsCss = fs.readFileSync(VARS, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
const declaredShadows = new Map<string, string>()
for (const m of varsCss.matchAll(/(--shadow-[a-z-]+)\s*:\s*([^;]+);/g)) declaredShadows.set(m[1], m[2].trim())

const boxShadow = ((tailwindConfig as any).theme.extend.boxShadow ?? {}) as Record<string, string>

function walk(dir: string, out: string[] = []): string[] {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name)
    if (fs.statSync(p).isDirectory()) walk(p, out)
    else if (/\.(tsx|ts)$/.test(name)) out.push(p)
  }
  return out
}

/** 去掉注释后的源码行（注释里举旧写法是解释，不是违规） */
function codeLines(source: string): { line: number; text: string }[] {
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

describe('A/B. 阴影令牌与 tailwind 一一对应', () => {
  it('解析到基础数据（防止闸门假通过）', () => {
    expect(declaredShadows.size, 'variables.css 里没解析出 --shadow-*，闸门失效').toBeGreaterThan(4)
    expect(Object.keys(boxShadow).length, 'tailwind 里没解析出 boxShadow，闸门失效').toBeGreaterThan(4)
  })

  it('每个 --shadow-* 都有对应工具类（没有就是死令牌）', () => {
    const registered = new Set(
      Object.values(boxShadow).map((v) => v.match(/var\((--shadow-[a-z-]+)\)/)?.[1]).filter(Boolean) as string[]
    )
    const dead = [...declaredShadows.keys()].filter((name) => !registered.has(name))
    expect(
      dead,
      `这些阴影令牌没有任何工具类消费（写了也不生效）：${dead.join(', ')}\n` +
        `要么接进 tailwind 的 boxShadow，要么删掉 —— 1.0.113 之前的 shadow-card 就是这样空挂的。`
    ).toEqual([])
  })

  it('每个 boxShadow 值都指向已声明的变量（配置里写死值 = 两处来源）', () => {
    const offenders = Object.entries(boxShadow)
      .filter(([, v]) => !/^var\(--shadow-[a-z-]+\)$/.test(v.trim()))
      .map(([k, v]) => `${k}: ${v}`)
    expect(offenders, `这些阴影不是"只指向令牌变量"：\n  ${offenders.join('\n  ')}`).toEqual([])
  })
})

describe('C. 光晕阴影：颜色走通道，几何在令牌里', () => {
  it('--shadow-glow 存在，颜色是 rgb(var(--color-reminder-glow-rgb) / 0.4)', () => {
    const value = declaredShadows.get('--shadow-glow')
    expect(value, 'variables.css 里没有 --shadow-glow').toBeTruthy()
    expect(value).toContain('rgb(var(--color-reminder-glow-rgb) / 0.4)')
  })

  it('几何（12px 光晕 / 3px 扩散）在令牌里，不在组件里', () => {
    expect(declaredShadows.get('--shadow-glow')).toMatch(/^0 0 12px 3px /)
    expect(boxShadow.glow).toBe('var(--shadow-glow)')
  })

  it('光晕组件只用类名，没有内联 style', () => {
    const src = fs.readFileSync(path.join(RENDERER, 'components/float-ball/GlowEffect.tsx'), 'utf8')
    expect(src).toContain('shadow-glow')
    // 注释里会写"原来是 boxShadow: …"作为说明，所以只查**代码行**
    const code = codeLines(src)
    expect(code.some((l) => /style=\{/.test(l.text)), '组件里还有内联 style').toBe(false)
    expect(code.some((l) => /boxShadow\s*:/.test(l.text)), '组件里还有内联 boxShadow').toBe(false)
  })
})

describe('D. 组件里不再有内联 boxShadow 字面量（闸门的盲区）', () => {
  it('src/renderer 全量扫描：0 处', () => {
    const offenders: string[] = []
    for (const file of walk(RENDERER)) {
      for (const { line, text } of codeLines(fs.readFileSync(file, 'utf8'))) {
        if (!/boxShadow\s*:\s*['"`]/.test(text)) continue
        const rel = path.relative(ROOT, file).split(path.sep).join('/')
        offenders.push(`${rel}:${line}  ${text.trim()}`)
      }
    }
    expect(
      offenders,
      `内联 boxShadow 绕开了令牌体系（闸门只扫 class 串，看不见这里）：\n  ${offenders.join('\n  ')}\n` +
        `改成 \`--shadow-*\` 令牌 + 对应工具类（光晕那档见 --shadow-glow）。`
    ).toEqual([])
  })

  it('扫描器自检：抓得到内联字面量，放过注释与类名', () => {
    const hit = codeLines(`<div style={{ boxShadow: '0 0 12px 3px rgba(130,177,255,0.4)' }} />`)
    expect(hit.some((l) => /boxShadow\s*:\s*['"`]/.test(l.text))).toBe(true)
    expect(codeLines(`// 旧写法 style={{ boxShadow: '0 0 12px 3px rgba(0,0,0,.2)' }}`).some((l) => /boxShadow\s*:\s*['"`]/.test(l.text))).toBe(false)
    expect(codeLines(`<div className="shadow-card" />`)).toHaveLength(1)
  })
})
