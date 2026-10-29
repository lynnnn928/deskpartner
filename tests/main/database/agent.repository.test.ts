import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '../../../src/main/database/migrations'
import {
  AgentRepository,
  PENDING_GRANT_TTL_MS,
  ONCE_GRANT_TTL_MS,
  SESSION_GRANT_TTL_MS
} from '../../../src/main/database/agent.repository'
import { ProjectRepository } from '../../../src/main/database/project.repository'

const db = new Database(':memory:')
vi.mock('../../../src/main/database/index', () => ({
  getDatabase: () => db
}))

/**
 * 授权窗口的两个时钟（1.0.49）
 *
 * 这张表曾经只有一个"30 分钟"，同时管两件不同的事：
 * ① 申请发出后，人有多久可以点头；② 批准后，这条授权多久没用掉就作废。
 *
 * 两件事的等待者不同 —— ① 等的是**人**（作息是小时级），
 * ② 等的是 **agent**（就在跟前等结果）。用同一个数就是拿人的作息
 * 去迁就机器的节奏：主用户实测后果是申请半夜发出、她早上醒来已过期，
 * agent 只能反复重发。
 *
 * 本文件锁住这条分工。它此前**完全没有测试**（整个 agent 仓库没有测试文件），
 * 所以改了也没人拦 —— 补上。
 */
describe('AgentRepository 授权窗口（待表态 vs 已批准）', () => {
  let agents: AgentRepository

  beforeAll(() => {
    runMigrations(db)
    db.pragma('foreign_keys = OFF')
  })

  beforeEach(() => {
    db.prepare('DELETE FROM agent_approval_events').run()
    db.prepare('DELETE FROM agent_grants').run()
    db.prepare('DELETE FROM agents').run()
    agents = new AgentRepository()
  })

  const nowMs = () => Date.now()
  const hours = (ms: number) => ms / 3_600_000

  it('待表态申请活 24 小时，不是 30 分钟（主用户 2026-09-24 拍板放宽）', () => {
    const g = agents.requestGrant({
      agentId: 'agent:alice',
      scope: 'destructive',
      command: 'todo rm',
      targetIds: ['t1'],
      requestArgv: ['todo rm', 't1', '--yes']
    })

    expect(g.status).toBe('pending')
    expect(g.expiresAt, '待表态申请必须有寿命（否则会永远挂在界面上）').not.toBeNull()
    const left = new Date(g.expiresAt!).getTime() - nowMs()
    // 允许 1 分钟误差，只验量级：24 小时对上，30 分钟对不上
    expect(hours(left)).toBeCloseTo(hours(PENDING_GRANT_TTL_MS), 1)
    expect(hours(left)).toBeGreaterThan(23)
  })

  it('批准之后（删除档）仍是 30 分钟 —— 放宽只给"等人"，不给"等机器"', () => {
    const g = agents.requestGrant({
      agentId: 'agent:alice',
      scope: 'destructive',
      command: 'todo rm',
      targetIds: ['t1']
    })

    const granted = agents.resolveGrant(g.id, true)
    expect(granted?.status).toBe('granted')
    const left = new Date(granted!.expiresAt!).getTime() - nowMs()
    expect(hours(left)).toBeCloseTo(hours(ONCE_GRANT_TTL_MS), 1)
    // 关键断言：待表态窗口变长了，已批准窗口**没跟着变长**
    expect(hours(left)).toBeLessThan(1)
  })

  it('改界面档（config）批准后 8 小时，与删除档各走各的', () => {
    const g = agents.requestGrant({ agentId: 'agent:alice', scope: 'config', command: 'ui set' })
    const granted = agents.resolveGrant(g.id, true)
    const left = new Date(granted!.expiresAt!).getTime() - nowMs()
    expect(hours(left)).toBeCloseTo(hours(SESSION_GRANT_TTL_MS), 1)
  })

  it('长期授权（longTerm）无到期时间', () => {
    const g = agents.requestGrant({ agentId: 'agent:alice', scope: 'config', command: 'ui set' })
    const granted = agents.resolveGrant(g.id, true, { longTerm: true })
    expect(granted?.expiresAt).toBeNull()
  })

  it('拒绝 → denied，且不留下可用授权', () => {
    const g = agents.requestGrant({ agentId: 'agent:alice', scope: 'destructive', command: 'todo rm' })
    const denied = agents.resolveGrant(g.id, false)
    expect(denied?.status).toBe('denied')
    expect(agents.listGrants({ activeOnly: true })).toHaveLength(0)
  })

  /**
   * 复用（同一会话、同一目标反复申请）要**顺延**窗口。
   *
   * 场景就是主用户踩的那个：半夜发起、人在睡觉、agent 隔一会儿重试一次。
   * 若复用时不动 expires_at，窗口永远按第一次算 —— 重试再多次，
   * 她早上醒来看到的还是一条过期申请。
   */
  it('审批流水在数据库端分页且总数不受页面大小影响', () => {
    for (let i = 0; i < 25; i++) {
      const grant = agents.requestGrant({ agentId: 'agent:alice', scope: i % 2 ? 'config' : 'destructive', command: `todo rm ${i}` })
      agents.resolveGrant(grant.id, false)
    }
    const page = agents.listGrantHistory({ offset: 10, limit: 10 })
    expect(page.total).toBe(25)
    expect(page.rows).toHaveLength(10)
    expect(page.offset).toBe(10)
    expect(page.limit).toBe(10)
    const filtered = agents.listGrantHistory({ offset: 0, limit: 20, scope: 'config' })
    expect(filtered.total).toBe(12)
    expect(filtered.rows.every((row) => row.scope === 'config')).toBe(true)
  })

  it('审批流水可在数据库端按执行结果筛选并保持总数准确', () => {
    const failed = agents.requestGrant({ agentId: 'agent:alice', scope: 'destructive', command: 'todo rm failed' })
    agents.resolveGrant(failed.id, true)
    db.prepare("UPDATE agent_grants SET exec_status = 'error', exec_error = '目标被保护' WHERE id = ?").run(failed.id)
    const denied = agents.requestGrant({ agentId: 'agent:alice', scope: 'config', command: 'ui set' })
    agents.resolveGrant(denied.id, false)

    const errors = agents.listGrantHistory({ offset: 0, limit: 10, execution: 'error' })
    expect(errors.total).toBe(1)
    expect(errors.rows[0].id).toBe(failed.id)
    const noExecution = agents.listGrantHistory({ offset: 0, limit: 10, execution: 'none' })
    expect(noExecution.total).toBe(1)
    expect(noExecution.rows[0].id).toBe(denied.id)
  })

  it('统一审批历史覆盖 Agent 事件和超过 200 条授权记录，并在 SQLite 端分页', () => {
    agents.register({ id: 'agent:history', displayName: 'History Agent' })
    agents.setApproved('agent:history', true)
    for (let i = 0; i < 205; i++) {
      const grant = agents.requestGrant({ agentId: 'agent:history', scope: 'config', command: `ui set --history-${i}` })
      agents.resolveGrant(grant.id, false)
    }

    const page = agents.listApprovalHistory({ offset: 200, limit: 20 })
    expect(page.total).toBe(207)
    expect(page.rows).toHaveLength(7)
    expect(page.rows.every((row) => row.activityAt)).toBe(true)
    const identity = agents.listApprovalHistory({ offset: 0, limit: 20, type: 'agent' })
    expect(identity.total).toBe(2)
    expect(identity.rows.map((row) => row.decision).sort()).toEqual(['approved', 'pending'])
    expect(agents.listApprovalHistory({ offset: 0, limit: 20, decision: 'approved' }).rows.every((row) => row.decision === 'approved')).toBe(true)
  })

  it('统一审批流水包含接手说明提议的原文、决定正文和项目来源', () => {
    const projects = new ProjectRepository()
    const project = projects.create({ name: `审批历史接手说明-${Date.now()}` })
    projects.saveHandoff(project.id, '提议前正文', 'human')
    const proposal = projects.proposeHandoff(project.id, 'Agent 提议正文', 'agent:alice')

    const pending = agents.listApprovalHistory({ offset: 0, limit: 20, type: 'handoff', projectId: project.id })
    expect(pending.total).toBe(1)
    expect(pending.rows[0]).toMatchObject({
      id: proposal.id,
      type: 'handoff',
      agentId: 'agent:alice',
      projectId: project.id,
      summary: `接手说明提议 · ${project.name}`,
      decision: 'pending',
      originalBody: '提议前正文',
      proposedBody: 'Agent 提议正文',
      decidedBody: null,
      execution: 'not_required'
    })

    projects.decideHandoffProposal(proposal.id, 'approved', 'human', '最终采纳正文')
    const decided = agents.listApprovalHistory({ offset: 0, limit: 20, type: 'handoff', projectId: project.id })
    expect(decided.rows[0]).toMatchObject({ decision: 'approved', decidedBy: 'human', decidedBody: '最终采纳正文' })
  })

  it('重复申请复用同一条，并把窗口顺延到"最后一次发问 + 24h"', () => {
    const first = agents.requestGrant({
      agentId: 'agent:alice',
      scope: 'destructive',
      command: 'todo rm',
      targetIds: ['t1']
    })

    // 假装过了一段时间（直接把旧记录的 expires_at 改到接近过期）
    const soon = new Date(Date.now() + 60_000).toISOString()
    db.prepare('UPDATE agent_grants SET expires_at = ? WHERE id = ?').run(soon, first.id)

    const again = agents.requestGrant({
      agentId: 'agent:alice',
      scope: 'destructive',
      command: 'todo rm',
      targetIds: ['t1']
    })

    expect(again.id, '同会话同目标应复用，不该堆出第二条').toBe(first.id)
    const left = new Date(again.expiresAt!).getTime() - Date.now()
    expect(hours(left), '复用后窗口应被顺延回 24 小时').toBeGreaterThan(23)
    expect(agents.listGrants({ status: 'pending' })).toHaveLength(1)
  })
})
