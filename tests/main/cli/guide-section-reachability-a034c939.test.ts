import { describe, it, expect } from 'vitest'
import { buildAgentGuide, buildAgentGuideIndex, buildAgentGuideTopic, readCollaborationAgreement } from '../../../src/main/cli/agent-guide'
import { guideTopicNames } from '../../../src/main/cli/guide-topics'

/**
 * 说明书每一节都必须有出口（卡 `a034c939`，2026-10-22）
 *
 * ── 病在哪 ──
 *
 * `buildAgentGuide`（正文那一册）**没有任何生产调用方** —— `dp skill` 给入口页、
 * `dp skill <主题>` 给主题切片、MCP `get_guide` 同前、GUI 的「AI 助手接入」也给了入口页。
 * 于是"某一节写在正文里"≠"agent 读得到"。实测（1.0.110）：正文里
 * **12 节 / 约 16 KB** 哪份出口都送不到，含整个「场景路由」索引
 * （1.0.67 立它的全部意义就是"按场景直达"）与「常用操作」「标题与描述」。
 *
 * 三件事让这个洞藏了很久：
 *   ① 最常做的事（登记 / 改状态 / 收口 / 权限 / 接手）都在送达的四份里；
 *   ② 本机还留着几份 1.0.94 之前的**旧整本**副本（如 `~/.alice/skills/…`、`~/Downloads/…`），
 *      内容靠它们兜着 —— 而旧副本不会更新；
 *   ③ 只读源码 / 只在仓库干活的人天然绕过这个缺口。
 *
 * ── 2026-10-22 拍板（Dave 复核，主用户带回）与这之后的收口 ──
 *
 * **整本保留、只当真源**（一处改、几份主题同时更新）；出口即交付物，不再补"导出完整版"。
 * 12 节按卡里的建议去向接进各出口：
 *   - 「场景路由」**搬进入口页**，且行目标改成 `dp skill <主题>`（指向正文小节名 = 死链接）；
 *   - 「常用操作」→ core；「什么时候不要用」→ access；正文前言 → 入口页；
 *   - 新开 `writing` 主题（记什么/不记什么/标题与描述/类型与执行者/先归到 story/batch/勾掉同类事项）；
 *   - 「先定位命令，再查参数」删（判据并入入口页「最小纪律」）。
 * 于是 `BASELINE` **清空**：今天正文 23 节全部有出口。名单仍然只许变短 —— 空名单是终点。
 *
 * ── 这道闸门怎么判 ──
 *
 * 节的判据：正文里每个 `##`/`###` 标题（围栏里的 `#` 不算）算一节；
 * **文件头（frontmatter + 文档标题那一行 `#`）不算节** —— 标题写的是文件叫什么，不是内容；
 * 指纹 = 标题行 + 第一条正文行；正文里读得到、而任何一份出口都读不到 → 无出口。
 * 出口 = 入口页（`dp skill`）+ `GUIDE_TOPICS` 里的每一份主题（加主题自动纳入判定）。
 *
 * ## 为什么是"基线棘轮"而不是直接断言"零无出口"
 *
 * 直接断言零无出口在 2026-10-22 上午会红 12 条，而"这 12 节各自该进哪一本"是产品判断；
 * 所以先钉"不许再多、不许假装"（新增无出口的节当场红；名单里的节有了出口必须从名单删掉）。
 * 现在名单已空，两条规则仍然守着回归：**新写的节没有出口 → 红**。
 *
 * 口径与规模闸门一致：**项目自己的 `COLLABORATION.md` 不进产品账** ——
 * 它的正文是项目内容、会随项目改（改它不需要发版）；它的送达问题单独看
 * （入口页本来就是让 agent 自己去读那个文件）。
 */
const CLI = 'C:/x/deskpartner.cjs'
const VERSION = '1.0.111'

/**
 * 已知无出口的节（只许变短）。标题必须与正文里**逐字**一致。
 *
 * 2026-10-22 清空：12 节全部接进出口（去向见文件头）。**空名单就是这个闸门的终点** ——
 * 它变空之后，任何一次"往正文里丢一节、没接出口"都会被下面的用例当场拦下。
 */
const BASELINE: string[] = []

/** 项目约定区不进产品账：它由入口页/`dp protocol get` 供给（见文件头注释） */
const AGREEMENT_TITLES = ['## 当前项目协作约定', '## 接入后的读取顺序']

type Section = { level: number; title: string; bytes: number; heading: string; firstLine: string }

function sectionsOf(doc: string): Section[] {
  const lines = doc.split('\n')
  const out: Section[] = []
  let cur: Section | null = null
  let fence = false
  lines.forEach((l) => {
    if (l.trimStart().startsWith('```')) fence = !fence
    const m = !fence && /^(#{1,3}) (.+)$/.exec(l)
    if (m) {
      if (cur) out.push(cur)
      // 文件头（frontmatter + 文档标题）不算节：标题不是内容
      cur =
        m[1].length === 1
          ? null
          : { level: m[1].length, title: m[2], bytes: 0, heading: `${m[1]} ${m[2]}`, firstLine: '' }
    }
    if (cur) {
      cur.bytes += Buffer.byteLength(l, 'utf8') + 1
      // 指纹下半 = 标题之后第一条非空正文行（判"这一节真的在这一份文档里"）
      if (l !== cur.heading && !cur.firstLine && l.trim()) cur.firstLine = l
    }
  })
  if (cur) out.push(cur)
  return out
}

/**
 * 一节在不在某份出口里：标题要在，且**首行正文出现在标题之后**。
 * （只比"两行都在"会被别的节的同名行骗过；比"标题\n首行"又会栽在中间的空行上。）
 */
function reachableIn(text: string, s: Section): boolean {
  const at = text.indexOf(s.heading)
  if (at < 0) return false
  return !s.firstLine || text.indexOf(s.firstLine, at) >= 0
}

/** 出口：入口页 + 每一份主题（`GUIDE_TOPICS` 里有几个就有几份，加主题自动进判定） */
function exits(): Record<string, string> {
  const out: Record<string, string> = { '入口页（dp skill）': buildAgentGuideIndex(CLI, VERSION) }
  for (const name of guideTopicNames()) out[`主题 ${name}`] = buildAgentGuideTopic(name, CLI, VERSION)
  return out
}

describe('说明书逐节可达（卡 a034c939）', () => {
  it('每一节都必须有出口 —— 无出口的节只许比基线更少', () => {
    const doc = buildAgentGuide(CLI, VERSION)
    const agreement = readCollaborationAgreement()
    // 扣掉内嵌的项目约定正文，免得项目的标题被算成"产品缺节"
    const clean = agreement && doc.includes(agreement.body) ? doc.replace(agreement.body, '') : doc
    const sections = sectionsOf(clean).filter((s) => !AGREEMENT_TITLES.some((t) => s.title.startsWith(t.slice(3))))
    expect(sections.length, '一节都没解析出来 —— 判据与文档结构脱钩了').toBeGreaterThan(20)

    const find = Object.entries(exits()).map(([name, text]) => ({ name, text }))
    const reachable = sections.filter((s) => find.some((e) => reachableIn(e.text, s)))
    expect(reachable.length, '几乎全部节都没有出口 —— 先确认判据没写坏').toBeGreaterThan(10)

    const orphans = sections.filter((s) => !find.some((e) => reachableIn(e.text, s)))
    const orphanTitles = orphans.map((s) => `${'#'.repeat(s.level)} ${s.title}`)
    const added = orphanTitles.filter((t) => !BASELINE.includes(t))
    const fixed = BASELINE.filter((t) => !orphanTitles.includes(t))

    if (added.length) {
      throw new Error(
        `新写了 ${added.length} 节没有出口（agent 拿不到）：\n  ${added.join(
          '\n  '
        )}\n→ 要么把它接进某份出口（入口页 / 某主题，见 guide-topics.ts），要么别往正文里放。`
      )
    }
    if (fixed.length) {
      throw new Error(
        `基线里有 ${fixed.length} 节已经有出口了，请从本文件的 BASELINE 删掉：\n  ${fixed.join(
          '\n  '
        )}\n（名单只许变短 —— 不然"已修"没有任何痕迹）`
      )
    }
    expect(orphanTitles.sort(), '无出口的节与基线不一致').toEqual([...BASELINE].sort())
  })

  it('基线里的节确实存在（名单非空时才有意义；防"改个标题就算修好"）', () => {
    const doc = buildAgentGuide(CLI, VERSION)
    for (const t of BASELINE) {
      expect(doc.includes(t), `基线里的「${t}」在正文里找不到了 —— 标题改了要同步基线`).toBe(true)
    }
  })
})
