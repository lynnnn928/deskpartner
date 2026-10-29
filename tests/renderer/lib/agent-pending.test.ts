import { describe, it, expect } from 'vitest'
import { countAwaitingApproval, isPendingAgent } from '../../../src/renderer/lib/grant-state'
import type { Agent, AgentGrant, GrantScope } from '../../../src/renderer/types/todo'

/**
 * 「等你点头」这件事的判定口径（1.0.62，aa0b4610）
 *
 * ── 为什么值得一组断言 ──
 *
 * 这个判断被四处共用（两处红点、用户页的待批准提示、审批页的待表态队列）。
 * 它判错的形态不是报错，而是**界面与角标对不上**：
 * 要么"红点说有 3 件，进来只有 1 件"，要么"我已经处理掉了，它还亮着"。
 * 两种形态都会让人得出同一个结论：这个红点不可信。
 *
 * 这里要锁的是 1.0.62 补上的那次判断：被拒绝过的身份**已经结案**，
 * 不再算"还在等你" —— 在此之前，人不想批准某个 agent 就永远摆脱不了它，
 * 因为唯一的按钮写着"批准"。
 */

function agent(over: Partial<Agent> = {}): Agent {
  return {
    id: 'agent:someone',
    displayName: 'someone',
    color: null,
    approved: false,
    rejectedAt: null,
    hasCredential: true,
    createdAt: '2026-09-01T00:00:00.000Z',
    lastSeenAt: null,
    lastWriteAt: null,
    lastWriteCmd: null,
    ...over
  }
}

function grant(over: Partial<AgentGrant> = {}): AgentGrant {
  return {
    id: 'g1',
    agentId: 'agent:someone',
    scope: 'config' as GrantScope,
    sessionId: null,
    status: 'pending',
    command: 'ui set',
    summary: '改主题',
    targetIds: [],
    requestArgv: ['ui', 'set'],
    execStatus: null,
    execError: null,
    execSummary: null,
    executedAt: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    resolvedAt: null,
    resolvedBy: null,
    expiresAt: null,
    ...over
  }
}

describe('isPendingAgent', () => {
  it('注册完还没表态的身份在等人', () => {
    expect(isPendingAgent(agent())).toBe(true)
  })

  it('批准过的不再等人', () => {
    expect(isPendingAgent(agent({ approved: true }))).toBe(false)
  })

  it('拒绝过的是已经结案的决定，不再算等人', () => {
    expect(isPendingAgent(agent({ rejectedAt: '2026-09-30T01:00:00.000Z' }))).toBe(false)
  })

  it('撤销拒绝后重新回到待处理', () => {
    expect(isPendingAgent(agent({ rejectedAt: null, approved: false }))).toBe(true)
  })
})

describe('countAwaitingApproval', () => {
  it('被拒绝的身份不计进红点，且不误伤待表态的申请', () => {
    const agents = [
      agent({ id: 'a:pending' }),
      agent({ id: 'a:rejected', rejectedAt: '2026-09-30T01:00:00.000Z' }),
      agent({ id: 'a:approved', approved: true })
    ]
    // 只数 1 个待批准身份 + 1 条待表态申请
    expect(countAwaitingApproval(agents, [grant()])).toBe(2)
  })

  it('把被拒绝的全都摆出来时，一个也不数', () => {
    const agents = [
      agent({ id: 'a:rejected-1', rejectedAt: '2026-09-30T01:00:00.000Z' }),
      agent({ id: 'a:rejected-2', rejectedAt: '2026-09-30T01:05:00.000Z' })
    ]
    expect(countAwaitingApproval(agents, [])).toBe(0)
  })

  it('将档案、协议和接手说明提议计入同一待审批总数', () => {
    expect(countAwaitingApproval([], [], 2, 3, 4)).toBe(9)
  })

  it('过期未处理的申请不算（寿命到了它已经无从处理）', () => {
    const stale = grant({ expiresAt: '2026-09-01T00:00:00.000Z' })
    expect(countAwaitingApproval([], [stale])).toBe(0)
  })
})
