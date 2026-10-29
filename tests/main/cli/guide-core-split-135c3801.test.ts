import { describe, expect, it } from 'vitest'
import { buildAgentGuideIndex, buildAgentGuideTopic } from '../../../src/main/cli/agent-guide'
import { GUIDE_TOPICS } from '../../../src/main/cli/guide-topics'

/**
 * 卡 `135c3801`（采纳方案 ②）：
 * 1. 将 `core` 中原本 13KB 的「状态关口」拆成两节：
 *    `### 状态关口：候选池（什么能自己动，什么必须等人）` + `### 验收与退回（谁说了算）`，两节均留在 `core`；
 * 2. 两节互相指路（防止只读一节漏掉 G4 或 G10）；
 * 3. 入口页「场景路由」里「要验收别人的卡」行精确指向新节「验收与退回」。
 */
describe('core 状态关口与验收与退回拆节（135c3801）', () => {
  const CLI = 'C:/x/deskpartner.cjs'
  const VERSION = '1.0.129'

  it('GUIDE_TOPICS.core.headings 同时登记「### 状态关口」与「### 验收与退回」', () => {
    expect(GUIDE_TOPICS.core.headings).toContain('### 状态关口')
    expect(GUIDE_TOPICS.core.headings).toContain('### 验收与退回')
  })

  it('dp skill core 同时包含拆开后的两节，且两节互相指路', () => {
    const core = buildAgentGuideTopic('core', CLI, VERSION)
    const idxCandidate = core.indexOf('### 状态关口：候选池')
    const idxAcceptance = core.indexOf('### 验收与退回（谁说了算）')
    const idxSync = core.indexOf('### 任务同步闭环')

    expect(idxCandidate).toBeGreaterThan(-1)
    expect(idxAcceptance).toBeGreaterThan(idxCandidate)
    expect(idxSync).toBeGreaterThan(idxAcceptance)

    const candidateSection = core.slice(idxCandidate, idxAcceptance)
    const acceptanceSection = core.slice(idxAcceptance, idxSync)

    // 两节互指
    expect(candidateSection).toContain('验收与退回（谁说了算）')
    expect(acceptanceSection).toContain('状态关口：候选池（什么能自己动，什么必须等人）')

    // 各自承载正确内容且单节不再超过 10KB
    expect(candidateSection).toContain('G4')
    expect(acceptanceSection).toContain('G10')
    expect(acceptanceSection).toContain('todo reject')
    expect(Buffer.byteLength(candidateSection, 'utf8')).toBeLessThan(10 * 1024)
    expect(Buffer.byteLength(acceptanceSection, 'utf8')).toBeLessThan(10 * 1024)
  })

  it('入口页场景路由中「要验收别人的卡」指向新节「验收与退回」', () => {
    const index = buildAgentGuideIndex(CLI, VERSION)
    const router = index.slice(index.indexOf('## 场景路由'), index.indexOf('## 最小纪律'))
    const acceptanceRow = router
      .split('\n')
      .find((line) => line.includes('要**验收**别人的卡'))
    expect(acceptanceRow).toBeTruthy()
    expect(acceptanceRow).toContain('验收与退回')
  })
})
