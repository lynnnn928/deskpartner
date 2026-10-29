import { describe, it, expect } from 'vitest'
import { buildAgentGuide, buildAgentGuideIndex, buildAgentGuideTopic, readCollaborationAgreement } from '../../../src/main/cli/agent-guide'
import { guideTopicNames } from '../../../src/main/cli/guide-topics'

/**
 * 说明书要有索引，且不许靠 agent 自己的记忆补缺口（1.0.67）
 *
 * ## 为什么要有这道闸门
 *
 * 2026-10-06 的实测后果：
 * - 说明书 **534 行 / 33 KB**，一个平铺的章节列表，**没有索引、没有场景路由**；
 * - 而 agent 天天在用的 `--fixed-in` 在说明书里**出现 0 次**；
 * - 于是同一份判据被抄进 agent 的**长期记忆**里 ——
 *   **说明书一改，两份就对不上**（她原话：「你依赖长期记忆发现又对不上了，怎么整」）。
 *
 * ## 结构性判据
 *
 * **判据属于产品，不属于 agent 的记忆。**
 * agent 会换、会忘、会自己乱补 —— 判据只能有一个出处（说明书），
 * 而那个出处必须**可检索**：不是"通读全文去找"，是"按场景直达"。
 *
 * ## 2026-10-22 改口径：闸门量的是**出口**，不是真源（卡 `d3cc69a6`）
 *
 * 这一天查实：`buildAgentGuide`（真源那一册）**从 1.0.104 起没有任何出口** ——
 * `dp skill` 给入口页、`dp skill <主题>` 给切片、MCP `get_guide` 同前、GUI 的
 * 「AI 助手接入」也给了入口页。而这道闸门原先一直对着真源断言，"索引存在、判据在里面"
 * 全部**成立却送不出去**（「场景路由」就这么白写了两个版本）。
 *
 * 改法：判据在**并集**上断言 —— 入口页 + 每一份主题切片，也就是 agent 真能拿到的全部文字。
 * 真源只留一条"只报不拦"的体量提示：它的体量不再决定 agent 读到什么，
 * 该有上界的是出口（见 `guide-progressive-reading.test.ts` 的逐份上界）。
 */
const CLI = 'C:/x/deskpartner.cjs'
const VERSION = '1.0.66'

describe('说明书索引与判据归属（1.0.67）', () => {
  /** 真源：内容都在它里面，**但它不是交付物**（见文件头） */
  const book = buildAgentGuide(CLI, VERSION)
  /** 出口：入口页 + 每一份主题切片 */
  const index = buildAgentGuideIndex(CLI, VERSION)
  const delivered = [index, ...guideTopicNames().map((n) => buildAgentGuideTopic(n, CLI, VERSION))].join('\n\n')
  /** 场景路由那一段（入口页里从它到「最小纪律」） */
  const router = index.slice(index.indexOf('## 场景路由'), index.indexOf('## 最小纪律'))

  it('「场景路由」在入口页里，且放在“调用入口”之前（先知道去哪，再看怎么调）', () => {
    const routeIdx = index.indexOf('## 场景路由')
    const callIdx = index.indexOf('## 调用入口')
    expect(routeIdx, '入口页里缺少场景路由索引').toBeGreaterThan(-1)
    expect(callIdx).toBeGreaterThan(-1)
    expect(routeIdx, '索引必须在“调用入口”之前 —— 先知道去哪，再看怎么调').toBeLessThan(callIdx)
  })

  it('索引是一张表，且行数够用（少于 8 行等于没索引）', () => {
    const rows = router.split('\n').filter((l) => l.trim().startsWith('|') && !l.includes('---'))
    expect(rows.length, `索引只有 ${rows.length} 行，覆盖不住实际场景`).toBeGreaterThanOrEqual(8)
  })

  it('索引覆盖这几种真实场景（都是 agent 实际会遇到的）', () => {
    for (const kw of ['登记', '重复', '验收', '收口', '发版', 'MCP', '错误码', '权限']) {
      expect(router.includes(kw), `索引里没有「${kw}」这个场景`).toBe(true)
    }
  })

  /**
   * 路由的每一行都必须落到一条**能直接跑的命令**上。
   *
   * 原先这张表指向正文里的小节名（「状态关口」「任务同步闭环」…），
   * 而那一册没有出口 —— 指路指了，agent 一行都读不到（卡 `d3cc69a6` 的病根）。
   */
  it('索引的每一行都指向一条能直接跑的命令（`dp skill <主题>`）', () => {
    const rows = router.split('\n').filter((l) => l.trim().startsWith('|') && !l.includes('---'))
    const targets = rows
      .slice(1)
      .map((r) => r.split('|')[2] ?? '')
      .filter((r) => r.trim())
    expect(targets.length, '索引只有表头，没有目标').toBeGreaterThan(7)
    for (const t of targets) {
      expect(t, `索引目标「${t.trim()}」既不是命令也不是主题`).toMatch(/`dp (skill|help|schema|doctor)/)
    }
  })

  /**
   * 核心：agent 真正需要的判据必须在**送得到的**文档里。
   *
   * ⚠️ 这几条都是**曾经只存在于 agent 私有记忆里**的判据 ——
   * 它们描述的是产品怎么用，不是 agent 怎么干活。
   */
  it('`--fixed-in` 在送达的文档里有（曾经出现 0 次）', () => {
    expect(delivered.includes('--fixed-in'), 'agent 天天用的命令在送得到的文档里查不到').toBe(true)
  })

  it('讲清「标了版本 ≠ 交付，还要推待验收」', () => {
    expect(delivered).toContain('awaiting_review')
    const section = delivered.slice(delivered.indexOf('#### 做完了怎么交'))
    expect(section, '缺少收口第三步的说明').toContain('awaiting_review')
    expect(
      section.includes('顺序') || section.includes('别调换'),
      '要给出明确顺序，而不是让 agent 自己拼'
    ).toBe(true)
  })

  it('讲清「--fixed-in 是承诺不是事实」及其前置检查', () => {
    const section = delivered.slice(delivered.indexOf('#### 版本归属'))
    expect(section).toContain('承诺')
    expect(section, '要给出具体检查命令，而不只是原则').toContain('package.json')
    expect(section).toContain('dist/')
  })

  it('给了「漏了怎么自检」的办法', () => {
    expect(
      delivered.includes('--status awaiting_review'),
      '要告诉 agent 怎么自己发现漏推了'
    ).toBe(true)
    expect(delivered.indexOf('自检'), '缺少自检提示').toBeGreaterThan(-1)
  })

  /**
   * 防退化：说明书不该再"教人把判据抄进自己的记忆"。
   *
   * 原文有一句「把这条闭环写进你自己的 agent.md（或同等的长期指令文件）」——
   * 那等于**把产品判据外包给 agent 的记忆**，正是这次要消灭的做法。
   * 可以提 agent.md，但只能提"触发时机"，不能提"把判据抄进去"。
   */
  it('不再教 agent 把判据抄进自己的长期记忆', () => {
    expect(
      delivered.includes('写进你自己的 agent.md'),
      '不能把产品判据外包给 agent 记忆 —— 那是两份真相的来源'
    ).toBe(false)
  })

  /**
   * 项目约定是**内嵌进真源**的（入口页只给读法：`dp protocol get` / 工作目录里的
   * `COLLABORATION.md`）—— 所以这一条仍然对着真源断言。
   */
  it('真源里内嵌了当前项目的 COLLABORATION.md，而不是只在仓库里裸奔', () => {
    expect(book).toContain('当前项目协作约定')
    expect(book).toContain('COLLABORATION.md')
    expect(book).toContain('分工：每张卡记三个角色')
    expect(book).toContain('修改约定不需要发版')
  })

  /**
   * 真源的体量提示（卡 `5cc68aa5` 定了口径、`d3cc69a6` 改成只报不拦）。
   *
   * 口径：**说明书自己的文字**，不含内嵌的项目 `COLLABORATION.md`（那份改了不需要发版，
   * 却曾能无声吃掉余量：2026-10-22 实测正文 61274 / 61440，只剩 166 字节）。
   *
   * 为什么不再拦：整本从 1.0.104 起没有出口，"它多大"不再决定 agent 读到什么 ——
   * 拦它只会逼下一个人去删别人的段落（收益为零）。**该有上界的是出口**：
   * 入口页 12KB、每份主题各有上界，见 `guide-progressive-reading.test.ts`。
   */
  it('真源自己的文字超过 60KB 只提示，不拦（闸门已改量出口）', () => {
    const agreement = readCollaborationAgreement()
    let fixedText = book
    if (agreement) {
      const at = book.indexOf(agreement.body)
      expect(
        at,
        '内嵌的项目约定没能在成品里定位到 —— 提示的体量会失真，先修这张闸门'
      ).toBeGreaterThan(-1)
      fixedText = book.slice(0, at) + book.slice(at + agreement.body.length)
    }
    const bytes = Buffer.byteLength(fixedText, 'utf-8')
    const embedded = agreement ? Buffer.byteLength(agreement.body, 'utf-8') : 0
    if (bytes > 60 * 1024) {
      console.warn(
        `[说明书] 真源的文字 ${(bytes / 1024).toFixed(1)} KB（另内嵌项目约定 ${(embedded / 1024).toFixed(
          1
        )} KB）已过 60KB —— 只提示不拦：先看新内容有没有出口，再决定要不要拆分真源。`
      )
    }
    expect(bytes, '真源自己的文字不可能为空').toBeGreaterThan(1000)
  })

  /**
   * 示例渲染后不许被模板串吃掉换行（2026-10-22 发现并修）。
   *
   * 模板串里**行尾的单个反斜杠是续行转义**：源码写着五行 `dp todo close` 示例，
   * 渲染出来是一行 —— 示例本身还能跑，但它想教的"五个参数各占一行"看不出来了，
   * 而且这种错**不会让任何用例变红**（此前正是如此）。
   */
  it('多行 bash 示例渲染后仍是多行（行尾续行符要写成两个反斜杠）', () => {
    const lines = delivered.split('\n')
    const at = lines.findIndex((l) => l.startsWith('dp todo close <id>'))
    expect(at, '送得到的文档里没有 `todo close` 的示例').toBeGreaterThan(-1)
    expect(lines[at].endsWith('\\'), '示例首行的续行符被模板串吃掉了（源码里要写两个反斜杠）').toBe(true)
    expect(lines[at + 1].trim().startsWith('--did'), '示例被压成了一行').toBe(true)
    expect(lines[at + 4].trim().startsWith('--leftover'), '五行示例只剩一行 —— 续行符没写对').toBe(true)
  })

  it('索引里的每个锚点都指向真实存在的主题（防指路指空）', () => {
    // 路由表里的 `dp skill <名字>` 必须是真主题（`GUIDE_TOPICS` 的 key）；
    // `list` 是子命令、不是主题，但它也是正当目标
    const refs = [...router.matchAll(/`dp skill (\w+)`/g)].map((m) => m[1])
    expect(refs.length, '索引里没解析出任何主题引用').toBeGreaterThan(3)
    const known = [...guideTopicNames(), 'list']
    for (const r of new Set(refs)) {
      expect(known, `索引指向主题 \`${r}\`，但它不存在（可用：${guideTopicNames().join(' / ')}）`).toContain(r)
    }
  })
})
