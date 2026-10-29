import { describe, it, expect } from 'vitest'
import { readCliChain } from './cli-chain'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 文案不许与机制相反（1.0.70，两次踩坑的产物）
 *
 * ## 踩了两次
 *
 * **① 1.0.65**（`6a316a45`，我自造的矛盾）：G9 提示写
 * 「通过：在看板上点一下完成」「`awaiting_review → done` 只能由人在界面上点」，
 * 而 G10 恰好硬拦了这条路 —— **文案教我做一件系统禁止的事**。
 *
 * **② 1.0.67 改按角色定权之后**（Carol 07-07 驳回）：
 * 我只改了 `agent-guide.ts`（SKILL 文档），**没改 `schema.agentGuide`** ——
 * 两处口径不一致，而 MCP 接入的 agent 读的是后者。
 * 连带 `G9` 的「在看板上点一下完成」也还是旧口径。
 *
 * ## 判据
 *
 * **同一个口径只能有一处出处，且它必须与守卫的实际行为一致。**
 * 文案说"必须人做"而机制放行了 = agent 会一直等下去；
 * 文案说"你可以做"而机制拦了 = agent 以为自己有问题。
 * **两种都是把机制的问题甩给读文档的人。**
 */
const GUIDE = readFileSync(join(__dirname, '../../../src/main/cli/agent-guide.ts'), 'utf-8')
const CMDS = readCliChain()

/** 已作废的说法（1.0.67 起按角色定权，它们全部与机制相反） */
const STALE = [
  '由人在界面上完成；agent 不得自行', // 验收：以为只有人能验收
  '也不能自行宣布验收通过', // 同上
  '为什么"通过"不给命令行' // G9 里的旧解释
]

describe('验收口径不许与机制相反（1.0.70）', () => {
  it('agent-guide（SKILL 文档）里没有"验收只能人做"的旧口径', () => {
    for (const s of STALE) {
      expect(GUIDE.includes(s), `agent-guide 仍写着「${s}」—— 1.0.67 起按角色定权，这句已作废`).toBe(false)
    }
  })

  it('schema.agentGuide 里也没有（Carol 07-07 驳回的就是这条）', () => {
    for (const s of STALE) {
      expect(
        CMDS.includes(s),
        `schema.agentGuide 仍写着「${s}」—— MCP 接入的 agent 读的是这一份`
      ).toBe(false)
    }
  })

  it('G9 提示不再教"在看板上点一下完成"', () => {
    // 那是 1.0.65 的做法；1.0.67 后验收者（≠执行者）可直接命令行收口
    expect(
      CMDS.includes('通过：在看板上点一下完成'),
      'G9 还在教旧做法 —— agent 照它办会一直等下去'
    ).toBe(false)
  })

  /**
   * 反向：**新口径必须在场**。
   * 只断言"旧的没了"不够 —— 那可能意味着两边都空了。
   */
  it('新口径写清了"验收者（≠ 执行者）可以直接做"', () => {
    const hasNew =
      CMDS.includes('验收者（≠ 执行者）可以直接做') || CMDS.includes('验收者（≠ 执行者）能直接做')
    expect(hasNew, '旧口径删了却没写新口径 = 读者无从判断现在能不能做').toBe(true)
  })

  it('新口径同时说清"执行者验收自己仍被拒"（否则会被读成"谁都能收口"）', () => {
    const s = CMDS.includes('执行者验收自己仍被拒') || CMDS.includes('只拦"执行者验收自己"')
    expect(s, '只写"可以直接做"而不写"执行者不行"，等于鼓励自验').toBe(true)
  })

  /**
   * 根因级：**G4 的口径在 1.0.68 也变了**，
   * 而 `schema.agentGuide` 那句还停在"任何 update 都会被拒绝"。
   */
  it('G4 的口径也已同步（提议人能自撤，但放行仍要人）', () => {
    expect(
      CMDS.includes('agent 侧任何 update --status 都会被拒绝'),
      '1.0.68 已放开"提议人自撤"，这句还停在旧口径'
    ).toBe(false)
  })
})
