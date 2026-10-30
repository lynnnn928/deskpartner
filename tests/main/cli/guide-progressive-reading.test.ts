import { describe, expect, it } from 'vitest'
import { readCliChain } from './cli-chain'
import { join } from 'node:path'
import { buildAgentGuideIndex, buildAgentGuideTopic } from '../../../src/main/cli/agent-guide'
import { GUIDE_TOPICS, guideTopicNames } from '../../../src/main/cli/guide-topics'
import { commands } from '../../../src/main/cli/commands'

/**
 * Guide 渐进式阅读出口（1.0.94 起）：入口页是默认出口，细节按主题读。
 *
 * ## 2026-10-22 补上"每份出口的体量"（卡 `d3cc69a6`）
 *
 * 体检结论：出口这边**一条上界都没有** —— 而原先唯一的规模闸门（60KB）
 * 量的是真源，真源从 1.0.104 起没有任何出口。也就是说我们为没人读的那一册
 * 精打细算，同时放任 core 长到 30 KB。产品判断（Dave 复核）：**整本保留当真源**，
 * **闸门改量出口**，每份主题各有上界，core 的上界目标 24 KB。
 *
 * 上界取"棘轮"写法：今天是多少就钉在多少，只许变短。
 *
 * core 的 24 KB 目标**当天就达成了**，但过程和预想的不同：它并不需要"搬到别的主题"，
 * 而是 core 的表里挂着两条**重复切片**——「规格与往来分开」「验收三态」不是真源里的
 * 一节，而是「状态关口」正文里的两个列表项，切片会从列表中间切到下一个真标题，
 * 于是重复送出 4441 + 3174 字节（且顺序错乱）。删掉这两条表项，core 从 32485 掉到
 * 24868（24.3 KB）—— 内容一个字没少，因为那两段本来就在「状态关口」的切片里
 * （实测包含关系成立，见卡 `d3cc69a6`）。
 *
 * 遗留：core 里，「状态关口」单节仍有 13 KB —— 那是**可读性**问题（一次要读 13 KB），
 * 不是体量问题（出口已经在上界之内）。要不要再分，是内容判断，另案。
 *
 * ## 主题清单只在一处定义（`guide-topics.ts`）
 *
 * 加一个主题原先要改四处（`dp skill list`、切片表、入口页「按需阅读」、schema 枚举），
 * 漏一处就是静默漂移。现在四处全部从 `GUIDE_TOPICS` 派生 —— 这个文件守"派生没走回头路"。
 */
const CLI = 'C:/x/deskpartner.cjs'
const VERSION = '1.0.111'

/** 每份出口的字节上界（棘轮：只许变短）。数字后面是 2026-10-22 的实测值。 */
const CEILINGS: Record<string, number> = {
  index: 12 * 1024, // 入口页 6202（原 2341：场景路由 2726 + 前言搬了进来）
  core: 25 * 1024, // 24868 —— 目标 24KB 已达成（24.3 KB）
  writing: 12 * 1024, // 8104（新主题）
  project: 12 * 1024, // 9347
  access: 12 * 1024, // 9144（接进「什么时候不要用」530）
  troubleshooting: 8 * 1024 // 4737
}

function assertUnder(name: string, bytes: number): void {
  const limit = CEILINGS[name]
  expect(limit, `${name} 没有上界 —— 出口必须有上界`).toBeGreaterThan(0)
  expect(
    bytes,
    `${name} ${bytes} 字节，超过上界 ${limit}（棘轮只许变短；确实该长，先在卡上说明再抬上界）`
  ).toBeLessThan(limit)
}

describe('Guide 渐进式阅读出口', () => {
  const index = buildAgentGuideIndex(CLI, VERSION)

  it('L0 入口页包含接入、最小纪律与主题索引', () => {
    expect(index).toContain('COLLABORATION.md')
    expect(index).toContain('dp project get')
    expect(index).toContain('dp project search')
    expect(index).toContain('dp todo list --project')
    expect(index).toContain('dp skill project')
    expect(index).not.toContain('Bob')
    expect(index).not.toContain('驳回')
  })

  it('入口页列出全部主题（按需阅读由 GUIDE_TOPICS 渲染，不是手写第二遍）', () => {
    const names = guideTopicNames()
    expect(names.length, '主题一份都没有').toBeGreaterThan(4)
    for (const n of names) {
      expect(index, `入口页没列出主题 ${n}`).toContain(`dp skill ${n}`)
      expect(index, `入口页没写主题 ${n} 的用途`).toContain(GUIDE_TOPICS[n].summary)
    }
  })

  it('入口页有体量上界', () => {
    assertUnder('index', Buffer.byteLength(index, 'utf8'))
  })

  it.each(guideTopicNames())('主题 %s 可按需读取，且有体量上界', (topic) => {
    const doc = buildAgentGuideTopic(topic, CLI, VERSION)
    expect(doc).toContain(`desk-partner-todos-${topic}`)
    expect(doc.length).toBeGreaterThan(100)
    assertUnder(topic, Buffer.byteLength(doc, 'utf8'))
  })

  it('未知主题明确给出可用主题', () => {
    expect(() => buildAgentGuideTopic('unknown', CLI, VERSION)).toThrow('可用主题')
  })

  /**
   * 行为闸门：`dp skill list` 的输出就是 `GUIDE_TOPICS` 的 key，一行一个。
   *
   * 此前源码里写的是 `.join('\\n')` —— 字面反斜杠 + n，实际打成一整行
   * `core\nproject\n…`（2026-10-22 实测，没人报过）。清单改为派生之后，
   * 这里同时守住"分隔符别写错"与"清单别跟主题表分叉"。
   */
  it('`dp skill list` 逐行列出全部主题，且与主题表一致', () => {
    const cmd = commands.find((c) => c.name === 'skill')
    expect(cmd, '命令表里没有 skill 命令').toBeTruthy()
    const out = cmd!.run({} as never, {} as never, ['list'])
    expect(out).toBe(guideTopicNames().join('\n'))
    expect(String(out), '列表被打成了一整行或用了字面反斜杠 n').not.toContain('\\n')
  })

  it('主题枚举说明也由主题表派生（schema 里不再是手写第二遍）', () => {
    const cmd = commands.find((c) => c.name === 'skill')
    const desc = String(cmd?.positional?.desc ?? '')
    for (const n of guideTopicNames()) {
      expect(desc, `schema 的主题说明漏了 ${n}`).toContain(n)
    }
    const src = readCliChain()
    expect(src, 'schema 的主题说明没从 guideTopicNames() 派生').toContain('guideTopicNames().join')
  })
})
