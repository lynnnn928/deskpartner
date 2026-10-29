import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '../../../src/main/database/migrations'
import { ProfileRepository } from '../../../src/main/database/profile.repository'
import { ProtocolRepository } from '../../../src/main/database/protocol.repository'
import { AgentRepository } from '../../../src/main/database/agent.repository'

const db = new Database(':memory:')
vi.mock('../../../src/main/database/index', () => ({ getDatabase: () => db }))

describe('档案与协议提议审批快照', () => {
  let profile: ProfileRepository
  let protocol: ProtocolRepository

  beforeAll(() => {
    runMigrations(db)
    db.pragma('foreign_keys = OFF')
  })

  beforeEach(() => {
    db.prepare('DELETE FROM agent_approval_events').run()
    db.prepare('DELETE FROM agent_grants').run()
    db.prepare('DELETE FROM agents').run()
    db.prepare('DELETE FROM profile_proposals').run()
    db.prepare('DELETE FROM profile_revisions').run()
    db.prepare('DELETE FROM protocol_proposals').run()
    db.prepare('DELETE FROM profile_blocks').run()
    db.prepare('DELETE FROM protocol_blocks').run()
    db.prepare("DELETE FROM settings WHERE key = 'collaboration_import_v1'").run()
    profile = new ProfileRepository()
    protocol = new ProtocolRepository()
  })

  it('空档案区块明确表示未填写且未确认', () => {
    const blocks = profile.list({ scope: 'global' })
    expect(blocks).toHaveLength(4)
    expect(blocks.every((block) => block.body === '')).toBe(true)
    expect(blocks.every((block) => block.source === 'empty')).toBe(true)
    expect(blocks.every((block) => block.confirmed === false)).toBe(true)
  })

  it('默认协议保持未确认，只有显式确认才翻转确认状态', () => {
    const defaults = protocol.list({ scope: 'global' })
    expect(defaults).toHaveLength(5)
    expect(defaults.every((block) => !block.confirmed)).toBe(true)
    protocol.save({ scope: 'global' }, 'communication', '用户调整后的默认内容', 'human', false)
    expect(protocol.list({ scope: 'global' }).find((block) => block.blockKey === 'communication')?.confirmed).toBe(false)
    protocol.save({ scope: 'global' }, 'communication', '用户已确认的内容', 'human', true)
    expect(protocol.list({ scope: 'global' }).find((block) => block.blockKey === 'communication')?.confirmed).toBe(true)
  })

  it('档案提议保留提议时原文、最终采纳内容和审批历史', () => {
    profile.save({ scope: 'global' }, 'basics', '原始档案')
    const proposal = profile.propose({ scope: 'global' }, 'basics', 'agent 建议', 'agent:helper')

    expect(proposal.originalBody).toBe('原始档案')
    expect(profile.listProposals()).toHaveLength(1)
    expect(profile.listProposals('all')).toHaveLength(1)
    const decided = profile.decideProposal(proposal.id, 'approved', 'human', '人工编辑后的内容')

    expect(decided.status).toBe('approved')
    expect(decided.decidedBody).toBe('人工编辑后的内容')
    expect(profile.listProposals()).toHaveLength(0)
    expect(profile.listProposals('all')[0].originalBody).toBe('原始档案')
    expect(profile.list({ scope: 'global' }).find((block) => block.blockKey === 'basics')?.body).toBe('人工编辑后的内容')
    expect(() => profile.decideProposal(proposal.id, 'approved')).toThrow('已经处理过')
  })

  it('档案提议期间当前内容变化时拒绝覆盖，并保持提议待处理', () => {
    profile.save({ scope: 'global' }, 'basics', '提议时内容')
    const proposal = profile.propose({ scope: 'global' }, 'basics', '旧提议', 'agent:helper')
    profile.save({ scope: 'global' }, 'basics', '用户后来修改')

    expect(() => profile.decideProposal(proposal.id, 'approved')).toThrow('已发生变化')
    expect(profile.list({ scope: 'global' }).find((block) => block.blockKey === 'basics')?.body).toBe('用户后来修改')
    expect(profile.listProposals()[0].status).toBe('pending')
  })

  it('协议提议保留原文和最终生效正文，重复审批被后端拒绝', () => {
    protocol.save({ scope: 'global' }, 'communication', '原协议')
    const proposal = protocol.propose({ scope: 'global' }, 'communication', '建议协议', 'agent:helper')

    expect(proposal.originalBody).toBe('原协议')
    const decided = protocol.decideProposal(proposal.id, 'approved', 'human', '审阅后的协议')
    expect(decided.decidedBody).toBe('审阅后的协议')
    expect(protocol.listProposals()).toHaveLength(0)
    expect(protocol.listProposals('all').find((item) => item.id === proposal.id)?.status).toBe('approved')
    expect(protocol.list({ scope: 'global' }).find((block) => block.blockKey === 'communication')?.body).toBe('审阅后的协议')
    expect(() => protocol.decideProposal(proposal.id, 'rejected')).toThrow('已经处理过')
  })

  it('统一审批历史能读取 Agent、授权、档案和协议四类流水及快照', () => {
    const agentRepo = new AgentRepository()
    agentRepo.register({ id: 'agent:history', displayName: 'History Agent' })
    agentRepo.setApproved('agent:history', true)
    const grant = agentRepo.requestGrant({ agentId: 'agent:history', scope: 'config', command: 'ui set' })
    agentRepo.resolveGrant(grant.id, false)

    profile.save({ scope: 'global' }, 'basics', '原档案')
    const profileProposal = profile.propose({ scope: 'global' }, 'basics', '新档案', 'agent:history')
    profile.decideProposal(profileProposal.id, 'approved', 'human', '确认档案')
    protocol.save({ scope: 'global' }, 'communication', '原协议')
    protocol.propose({ scope: 'global' }, 'communication', '新协议', 'agent:history')

    const all = agentRepo.listApprovalHistory({ offset: 0, limit: 20 })
    expect(all.total).toBe(5)
    expect(all.rows.map((row) => row.type).sort()).toEqual(['agent', 'agent', 'grant', 'profile', 'protocol'])
    const profileHistory = agentRepo.listApprovalHistory({ offset: 0, limit: 20, type: 'profile' })
    expect(profileHistory.rows[0]).toMatchObject({ originalBody: '原档案', proposedBody: '新档案', decidedBody: '确认档案', decision: 'approved' })
    const protocolHistory = agentRepo.listApprovalHistory({ offset: 0, limit: 20, type: 'protocol' })
    expect(protocolHistory.rows[0]).toMatchObject({ originalBody: '原协议', proposedBody: '新协议', decision: 'pending' })
    expect(agentRepo.listApprovalHistory({ offset: 0, limit: 20, type: 'agent' }).rows).toHaveLength(2)
    expect(agentRepo.listApprovalHistory({ offset: 0, limit: 20, type: 'grant' }).rows).toHaveLength(1)
  })

  it('协议提议期间当前内容变化时不覆盖用户修改', () => {
    protocol.save({ scope: 'global' }, 'communication', '提议时内容')
    const proposal = protocol.propose({ scope: 'global' }, 'communication', '旧提议', 'agent:helper')
    protocol.save({ scope: 'global' }, 'communication', '用户后来修改')

    expect(() => protocol.decideProposal(proposal.id, 'approved')).toThrow('已发生变化')
    expect(protocol.list({ scope: 'global' }).find((block) => block.blockKey === 'communication')?.body).toBe('用户后来修改')
    expect(protocol.listProposals()[0].status).toBe('pending')
  })

  it('档案修订支持回滚到首次保存前的空状态，且空状态不冒充已确认', () => {
    profile.save({ scope: 'global' }, 'basics', '主用户资料')
    const revisions = profile.listRevisions({ scope: 'global' }, 'basics')
    expect(revisions).toHaveLength(2)
    expect(revisions[1]).toMatchObject({ body: '', confirmed: false, present: false })
    expect(revisions[0]).toMatchObject({ body: '主用户资料', confirmed: true, present: true })

    const restored = profile.rollbackRevision(revisions[1].id)
    expect(restored).toMatchObject({ blockKey: 'basics', body: '', confirmed: false, source: 'empty' })
    expect(profile.listRevisions({ scope: 'global' }, 'basics')[0]).toMatchObject({ body: '', present: false })
  })

  it('修订写入失败时档案正文一并回滚，不产生“失败但已保存”', () => {
    db.exec(`CREATE TRIGGER reject_profile_revision BEFORE INSERT ON profile_revisions
      BEGIN SELECT RAISE(ABORT, 'revision blocked'); END;`)
    expect(() => profile.save({ scope: 'global' }, 'basics', '不应落库')).toThrow('revision blocked')
    expect(profile.list({ scope: 'global' }).find((block) => block.blockKey === 'basics'))
      .toMatchObject({ body: '', source: 'empty', confirmed: false })
    db.exec('DROP TRIGGER reject_profile_revision')
  })
})
