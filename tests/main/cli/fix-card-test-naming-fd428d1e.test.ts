import { describe, it, expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { buildAgentGuide, buildAgentGuideIndex, buildAgentGuideTopic } from '../../../src/main/cli/agent-guide'
import { GUIDE_TOPICS, guideTopicNames } from '../../../src/main/cli/guide-topics'

/**
 * 卡 `fd428d1e`：「修一张卡配一条以卡 id 命名的回归用例」从口头约定搬进产品说明书。
 *
 * 为什么是说明书、不是记忆（卡里的原话）：这条纪律 1.0.75 就立了，
 * 但它只活在评审口头与执行者记忆里 —— **换一个执行 agent 就归零**。
 * 2026-10-15 审计实测：全仓用例里带 8 位卡 id 的只有 12 条（约 0.8%）。
 * "判据在说明书、不在记忆"这件事本身有先例（1.0.67 的索引闸门）——
 * 那次同样是同一份判据被抄进 agent 的长期记忆、两处对不上。
 *
 * ## 纪律落在**三个出口**上
 *
 *   - 真源 `### 修一张卡，配一条以卡 id 命名的回归用例`；
 *   - 入口页 `## 最小纪律` 一条（只读 `dp skill` 的 agent 也看得到）；
 *   - 主题 `core` 带出真源那一节（`dp skill core`）；
 *   - 入口页的场景路由一行（按场景直达）——2026-10-22 起这一行指向 `dp skill core`
 *     而不是正文里的节名：正文没有任何出口，指向节名就是死链接（卡 `d3cc69a6`）。
 *
 * 该看到的出口缺一个就会有一批 agent 漏掉 —— 所以逐个断言。
 *
 * ## 本文件钉六件事
 *   ① 真源有这一节，判据 + 自检命令 + 反向验证都在；
 *   ② 入口页（`dp skill` 默认出口）也有一份；
 *   ③ 入口页的场景路由能直达这一节，且每条目标都是**真主题**；
 *   ④ 主题表里的标题**每一个都在真源里存在**（拼错一个字母会被
 *      `if (start < 0) continue` 静默跳过：命令成功、内容少一节，没有任何迹象）；
 *   ⑤ 每一份主题切片都真带出了它表里的标题（同上，另一种表现）；
 *   ⑥ 本文件自己按这条纪律命名（卡 id 在文件名里）。
 */
const HEADING = '### 修一张卡，配一条以卡 id 命名的回归用例'
const CLI = 'C:/x/deskpartner.cjs'
const VERSION = '1.0.111'

/** 取一节：从标题到下一个同级/更高级标题 */
function section(doc: string, heading: string): string {
  const start = doc.indexOf(heading)
  expect(start, `说明书里没有「${heading}」`).toBeGreaterThan(-1)
  const after = doc.indexOf('### ', start + heading.length)
  return doc.slice(start, after < 0 ? doc.length : after)
}

describe('修复纪律进说明书（卡 fd428d1e）', () => {
  it('真源有这一节（卡里【修法】要的就是这一段）', () => {
    const s = section(buildAgentGuide(CLI, VERSION), HEADING)
    expect(s).toContain('8 位')
    expect(s).toContain('卡 id')
    expect(s, '要说明它是给谁看的账，不是只给当时的自己').toContain('回归用例')
  })

  it('入口页（`dp skill` 默认出口）也有一份 —— 只读默认出口的 agent 不会漏', () => {
    const index = buildAgentGuideIndex(CLI, VERSION)
    expect(index, '纪律没进默认出口').toContain('8 位 id')
    expect(index).toContain('修一张卡')
  })

  it('判据写清了「用例名里带 8 位卡 id」，并给了一个真例子', () => {
    for (const doc of [buildAgentGuide(CLI, VERSION), buildAgentGuideIndex(CLI, VERSION)]) {
      expect(doc, '给个真文件名，比"命名要规范"这种话有用').toMatch(/[0-9a-f]{8}\.test\.ts/)
    }
  })

  it('给了可复跑的自检命令，而不是只讲原则', () => {
    const s = section(buildAgentGuide(CLI, VERSION), HEADING)
    expect(s, '缺自检命令 —— 只有原则就等于回到"靠记忆"').toContain('.test.ts')
    expect(s, '自检命令要能真筛出用例名里的卡 id').toMatch(/\[0-9a-f\]\{8\}/)
    expect(s).toContain('反向验证')
  })

  it('`dp skill core` 带出这一节（有 ### 标题就必须同时进主题表）', () => {
    const core = buildAgentGuideTopic('core', CLI, VERSION)
    expect(core).toContain(HEADING)
    expect(core).toContain('8 位')
  })

  it('入口页的「场景路由」能直达这一节，且每条目标都是真主题（不指路指空）', () => {
    const index = buildAgentGuideIndex(CLI, VERSION)
    const router = index.slice(index.indexOf('## 场景路由'), index.indexOf('## 最小纪律'))
    expect(router, '入口页里没有场景路由').not.toBe('')
    expect(router, '索引里没有这一行 —— 通读全文才找得到，等于没有').toContain(
      '修一张卡，配一条以卡 id 命名的回归用例'
    )
    // 路由目标必须是真主题：指向正文里的小节名就是死链接（那一册没有出口）
    // （`list` 是子命令、不是主题，但同样是正当目标）
    const known = [...guideTopicNames(), 'list']
    const refs = [...router.matchAll(/`dp skill (\w+)`/g)].map((m) => m[1])
    expect(refs.length, '路由里没解析出主题引用').toBeGreaterThan(3)
    for (const r of new Set(refs)) {
      expect(known, `路由指向主题 \`${r}\`，但它不存在（可用：${guideTopicNames().join(' / ')}）`).toContain(r)
    }
  })

  it('入口页自己的体量闸门没被撞（<12KB）', () => {
    const bytes = Buffer.byteLength(buildAgentGuideIndex(CLI, VERSION), 'utf8')
    expect(bytes, `入口页 ${(bytes / 1024).toFixed(1)} KB`).toBeLessThan(12 * 1024)
  })

  it('静态闸门：主题表的每个标题都在真源里（拼错一个字母 = 静默少一节）', () => {
    const entries = Object.entries(GUIDE_TOPICS)
    expect(entries.length, '主题表一份主题都没有').toBeGreaterThan(3)
    const heads = entries.flatMap(([, t]) => t.headings)
    expect(heads.length, '主题表没解析出标题（写法与判据脱钩了）').toBeGreaterThan(10)
    const doc = buildAgentGuide(CLI, VERSION)
    for (const h of heads) {
      expect(doc.includes(h), `主题表里的「${h}」在真源里不存在（dp skill <主题> 会静默少一节）`).toBe(true)
    }
  })

  it('行为闸门：每一份主题切片都真带出了它表里的标题', () => {
    for (const name of guideTopicNames()) {
      const slice = buildAgentGuideTopic(name, CLI, VERSION)
      for (const h of GUIDE_TOPICS[name].headings) {
        expect(slice.includes(h), `主题 ${name} 少了表里的一节「${h}」`).toBe(true)
      }
    }
  })

  it('本文件自己照这条纪律命名：8 位卡 id 在文件名里', () => {
    expect(fileURLToPath(import.meta.url)).toMatch(/fd428d1e\.test\.ts$/)
  })
})
