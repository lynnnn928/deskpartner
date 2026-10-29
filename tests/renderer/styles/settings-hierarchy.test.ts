import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 设置页排版层次闸门（1.0.60，主用户驳回 8acbf57e）
 *
 * ── 这条闸门要拦的是什么 ──
 *
 * 主用户连续两轮驳回同一个问题：
 *   第一轮（截图）：「太丑、层次不明确」
 *   第二轮：「分组依然不清晰，**至少分组名称加粗显示吧**，
 *            现在这种方案只是比上一轮好一点而已。」
 *
 * 我第一轮的反应是"加分组标题"，第二轮才复核到真正的根因：
 * **层次倒置** —— 二级组标题写的是 `text-label`（12px）+ `text-secondary`，
 * 而它下面每一行的标签 `Row` 是 `text-content`（14px）+ `text-primary`。
 * 组标题比它的内容**更小、更淡**，视觉上根本不构成标题，
 * 只是一行灰色小字卡在设置项之间。
 *
 * 所以"加粗"只解决了一半 —— 不把字号层级扶正，加粗也是给最小的那行加粗。
 *
 * ── 闸门怎么判 ──
 *
 * 不锁具体字号值（改视觉规范不该改测试），只锁**结构关系**：
 * 标题的字号档不得小于其内容的字号档。
 * 字号档按 variables.css 的定义排序（label 12 < button 13 < content 14
 * < column-title 16），所以比的是**档位顺序**而不是像素数。
 *
 * ⚠️ 这类缺陷的可怕之处：tsc / 单测 / CDP 数值断言**全是绿的** ——
 * 尺寸都"正确渲染"了，只是关系反了。只有这类结构性断言拦得住。
 */
const ROOT = path.resolve(__dirname, '../../..')
const SECTION = path.join(ROOT, 'src/renderer/components/settings/Section.tsx')

const src = fs.readFileSync(SECTION, 'utf8')
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const clean = stripComments(src)

/**
 * 字号档位的从小到大排序。
 *
 * 与 variables.css 的 `--font-*-base` 对应（label 12 / button 13 /
 * content 14 / column-title 16）。新增字号档时必须在这里补上，
 * 否则下面的比较会把它当成"未知"而静默放行 —— 所以有一条断言
 * 专门检查"所有用到的 text-* 档位都在表里"。
 */
const SCALE_ORDER = ['label', 'button', 'content', 'column-title']

/**
 * `text-*` 里**不是**字号的那些：颜色与对齐。
 *
 * ⚠️ 名单必须同时覆盖**两种前缀形态**，因为下面的判断是先切掉一个 `text-`
 * 再查表：
 *   - `text-white`        → 切后 `white`
 *   - `text-text-primary` → 切后 `text-primary`
 * 少写任何一个形态，闸门就会对着一个颜色类报"未知字号档"。
 *
 * 踩过的坑（第一版）：用 `/\btext-([a-z-]+)\b/` 去抓，正则把 `text-` 当成
 * 工具类前缀吃掉 —— 颜色名单里写了 primary/secondary 恰好盖住双前缀那种，
 * 但 `text-right` 切后剩 `right` 没盖住，于是闸门拿一个**对齐类**当了字号档。
 * 现在改成先按空白切 token 再判断，不再依赖正则吃掉前缀的巧合行为。
 */
const NON_SIZE = new Set([
  // 颜色（双前缀 `text-text-*` 切后形态）
  'text-primary',
  'text-secondary',
  'text-done',
  'text-accent',
  // 颜色（单前缀 `text-*` 切后形态）
  'primary',
  'secondary',
  'done',
  'accent',
  'white',
  'red',
  'green',
  'amber',
  'danger',
  'warning',
  'success',
  // 对齐 / 其它 text-* 工具类
  'right',
  'left',
  'center',
  'ellipsis',
  'nowrap',
  'xs',
  'sm',
  'base',
  'lg'
])

/** 抽出文件里所有 className 字符串，按空白切成 token */
function classTokens(source: string): string[] {
  const out: string[] = []
  for (const m of source.matchAll(/className=\{?["'`]([^"'`]+)["'`]/g)) {
    out.push(...m[1].split(/\s+/).filter(Boolean))
  }
  // 三元表达式里的 className 分支（'bg-accent text-white' : '…'）
  for (const m of source.matchAll(/["'`]([a-z0-9-]+(?:[/:][a-z0-9-]+)*\s+[a-z0-9-/:. ]+)["'`]/g)) {
    for (const t of m[1].split(/\s+/)) if (t.startsWith('text-')) out.push(t)
  }
  return out
}

/** 取一个 className 片段对应的字号档（没有字号类时返回 undefined） */
function sizeClassOf(attrs: string): string | undefined {
  for (const token of attrs.split(/\s+/).filter(Boolean)) {
    if (!token.startsWith('text-')) continue
    const rest = token.slice('text-'.length)
    if (SCALE_ORDER.includes(rest)) return rest
  }
  return undefined
}

const rank = (cls: string | undefined): number => {
  if (!cls) return -1
  return SCALE_ORDER.indexOf(cls)
}

describe('设置页排版的层次关系', () => {
  it('基础数据解析成功（防止闸门因格式变化而假通过）', () => {
    expect(clean.length).toBeGreaterThan(500)
    // 三个标题（level=1 h3 / level=2 h4）与行标签都必须还在
    expect(clean).toContain('<h3')
    expect(clean).toContain('<h4')
    expect(clean).toContain('text-content')
  })

  it('用到的每个字号档位都在已知顺序表里（防止新档位被静默放行）', () => {
    const unknown = [
      ...new Set(
        classTokens(clean)
          /**
           * ⚠️ 只挑**看起来像字号档**的 token 来质疑。
           *
           * `text-*` 在 Tailwind 里同时承载颜色/对齐/字号，无法只靠前缀区分。
           * 所以判据是"白名单里的字号档 or 白名单里的非字号"，其余一律当作
           * 可疑（宁可真失败去补名单，也不要静默放行一个新字号档）。
           */
          .filter((t) => t.startsWith('text-'))
          .filter((t) => !/[/:.[\]]/.test(t))
          .map((t) => t.slice('text-'.length))
          .filter((v) => !SCALE_ORDER.includes(v) && !NON_SIZE.has(v))
      )
    ]
    expect(
      unknown,
      `Section.tsx 里出现了未登记的字号档：${unknown.join(', ')}。\n` +
        `若是新增字号档，请同步更新本测试的 SCALE_ORDER（否则下面的层次\n` +
        `比较会跳过它，闸门静默失效）；若是颜色/对齐类，请补进 NON_SIZE。`
    ).toEqual([])
  })

  it('二级组标题不得小于行标签（层次倒置 = 主用户说的"分组不清晰"）', () => {
    const h4 = clean.match(/<h4\s+className="([^"]+)"/)
    expect(h4, 'Section.tsx 里找不到 h4 组标题').not.toBeNull()
    const h4Size = sizeClassOf(h4![1])

    const rowLabel = clean.match(/<span className="(text-content[^"]*)"/)
    expect(rowLabel, 'Row 的行标签结构变了，请同步本闸门').not.toBeNull()
    const rowSize = sizeClassOf(rowLabel![1])

    expect(rank(h4Size), `h4 用了 ${h4Size}，不在已知字号档里`).toBeGreaterThanOrEqual(0)
    expect(rank(rowSize), `行标签用了 ${rowSize}，不在已知字号档里`).toBeGreaterThanOrEqual(0)

    expect(
      rank(h4Size),
      `二级组标题（${h4Size}）比它自己的行标签（${rowSize}）还小 —— 层次倒置。\n` +
        `主用户驳回原话：「分组依然不清晰，至少分组名称加粗显示吧」。\n` +
        `注意根因不是"字重不够"：12px 的组标题带着 14px 的内容，\n` +
        `视觉上它不构成标题，加粗也只是给最小的那行加粗。\n` +
        `请让标题的字号档 >= 内容的字号档。`
    ).toBeGreaterThanOrEqual(rank(rowSize))
  })

  it('一级标题必须比二级标题更大（否则两级层次在界面上分不出来）', () => {
    const h3 = clean.match(/<h3\s+className="([^"]+)"/)
    const h4 = clean.match(/<h4\s+className="([^"]+)"/)
    expect(h3).not.toBeNull()
    expect(h4).not.toBeNull()
    const h3Size = sizeClassOf(h3![1])
    const h4Size = sizeClassOf(h4![1])
    expect(
      rank(h3Size),
      `一级标题（${h3Size}）没有比二级标题（${h4Size}）更大 —— ` +
        `两级层次在界面上会是平的，这正是最初"一列平铺、扫读找不到目标"的来源。`
    ).toBeGreaterThan(rank(h4Size))
  })

  it('两级标题都要加粗（主用户明确要求"分组名称加粗显示"）', () => {
    const h3 = clean.match(/<h3\s+className="([^"]+)"/)
    const h4 = clean.match(/<h4\s+className="([^"]+)"/)
    expect(h3![1], '一级标题没加粗').toMatch(/font-semibold|font-bold/)
    expect(
      h4![1],
      '二级标题没加粗 —— 主用户的原话是「至少分组名称加粗显示吧」'
    ).toMatch(/font-semibold|font-bold/)
  })
})
