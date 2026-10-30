import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { vi } from 'vitest'

const db = new Database(':memory:')

vi.mock('../../../src/main/database/index', () => ({
  getDatabase: () => db
}))

import { runMigrations } from '../../../src/main/database/migrations'
import { TodoRepository } from '../../../src/main/database/todo.repository'
import { CategoryRepository } from '../../../src/main/database/category.repository'
import { ProjectRepository } from '../../../src/main/database/project.repository'
import { SettingsRepository } from '../../../src/main/database/settings.repository'
import { AgentRepository } from '../../../src/main/database/agent.repository'
import { ReleaseRepository } from '../../../src/main/database/release.repository'
import { CommentRepository } from '../../../src/main/database/comment.repository'
import { NotificationRepository } from '../../../src/main/database/notification.repository'
import { ReminderReceiptRepository } from '../../../src/main/database/reminder-receipt.repository'
import { RulesRepository } from '../../../src/main/database/rules.repository'
import { ProtocolRepository } from '../../../src/main/database/protocol.repository'
import { ProfileRepository } from '../../../src/main/database/profile.repository'
import { MemoRepository } from '../../../src/main/database/memo.repository'
import { executeOne } from '../../../src/main/cli/command-exec'
import { buildAgentGuideIndex, buildAgentGuideTopic } from '../../../src/main/cli/agent-guide'
import type { CliContext } from '../../../src/main/cli/command-core'

function makeCtx(actor: string): CliContext {
  const categoryRepo = new CategoryRepository()
  const projectRepo = new ProjectRepository()
  const settingsRepo = new SettingsRepository()
  const agentRepo = new AgentRepository()
  const releaseRepo = new ReleaseRepository()
  const commentRepo = new CommentRepository()
  const notificationRepo = new NotificationRepository()
  const reminderReceiptRepo = new ReminderReceiptRepository()
  const rulesRepo = new RulesRepository()
  const protocolRepo = new ProtocolRepository()
  const profileRepo = new ProfileRepository()
  const memoRepo = new MemoRepository()
  const todoRepo = new TodoRepository()

  return {
    actor,
    identityDeclared: true,
    credentialVerified: true,
    deps: {
      todoRepo,
      categoryRepo,
      projectRepo,
      settingsRepo,
      agentRepo,
      releaseRepo,
      commentRepo,
      notificationRepo,
      reminderReceiptRepo,
      rulesRepo,
      protocolRepo,
      profileRepo,
      memoRepo,
      events: { append: () => {} },
      telemetry: { record: () => {}, stats: () => ({}), query: () => [], clear: () => 0 }
    },
    meta: {
      version: '1.0.139',
      dbPath: ':memory:',
      schemaVersion: 48,
      busyTimeoutMs: 5000,
      channels: ['pipe', 'headless'],
      via: 'pipe',
      startedAt: Date.now()
    },
    interactive: true
  } as unknown as CliContext
}

describe('验收方遗留 A 组 4 项实现与回归守卫（e5892582 / 74650027）', () => {
  beforeAll(() => {
    runMigrations(db)
  })

  beforeEach(() => {
    db.exec(`
      DELETE FROM todos;
      DELETE FROM projects;
      DELETE FROM memos;
      DELETE FROM notifications;
      DELETE FROM profile_proposals;
      DELETE FROM protocol_proposals;
      DELETE FROM rule_proposals;
      DELETE FROM project_handoff_proposals;
    `)
    const agentRepo = new AgentRepository()
    for (const id of ['agent:alice', 'agent:bob', 'agent:carol']) {
      agentRepo.register({ id, displayName: id.slice(6) })
      agentRepo.setApproved(id, 'human')
    }
  })

  it('1. [A1] 四类提议（profile / protocol / rules / project handoff）支持发起人自撤，留痕且禁撤他人或已处理提议', async () => {
    const aliceCtx = makeCtx('agent:alice')
    const bobCtx = makeCtx('agent:bob')
    const proj = aliceCtx.deps.projectRepo.create({
      name: 'DeskPartner',
      handoffMarkdown: '# 初始说明\n'
    })

    // 1) profile propose & withdraw
    const profProp = (await executeOne(aliceCtx, [
      'profile',
      'propose',
      '--block',
      'habits',
      '--body',
      '偏好短句'
    ])) as { ok: boolean; data: { id: string } }
    expect(profProp.ok).toBe(true)

    // 他人撤回必须被拒
    const bobTryProf = await executeOne(bobCtx, [
      'profile',
      'propose',
      '--withdraw',
      profProp.data.id.slice(0, 8)
    ])
    expect(bobTryProf.ok).toBe(false)
    expect(bobTryProf.message).toContain('不能撤回别人提交')

    // 本人按前缀撤回成功
    const aliceWithdrawProf = (await executeOne(aliceCtx, [
      'profile',
      'propose',
      '--withdraw',
      profProp.data.id.slice(0, 8)
    ])) as { ok: boolean; data: { id: string; status: string; decidedBy: string; withdrawn: boolean } }
    expect(aliceWithdrawProf.ok).toBe(true)
    expect(aliceWithdrawProf.data.withdrawn).toBe(true)
    expect(aliceWithdrawProf.data.decidedBy).toBe('agent:alice')
    expect(aliceCtx.deps.profileRepo.listProposals('pending')).toHaveLength(0)
    expect(aliceCtx.deps.profileRepo.listProposals('all')[0]?.withdrawn).toBe(true)

    // 已撤回/已处理的提议再次撤回必须被拒
    const repeatProf = await executeOne(aliceCtx, [
      'profile',
      'propose',
      '--withdraw',
      profProp.data.id
    ])
    expect(repeatProf.ok).toBe(false)
    expect(repeatProf.message).toContain('不能撤回已处理')

    // 2) protocol propose & withdraw
    const protoProp = (await executeOne(aliceCtx, [
      'protocol',
      'propose',
      '--block',
      'roles',
      '--body',
      '新角色约定'
    ])) as { ok: boolean; data: { id: string } }
    expect(protoProp.ok).toBe(true)
    const aliceWithdrawProto = (await executeOne(aliceCtx, [
      'protocol',
      'propose',
      '--withdraw',
      protoProp.data.id.slice(0, 8)
    ])) as { ok: boolean; data: { withdrawn: boolean } }
    expect(aliceWithdrawProto.ok).toBe(true)
    expect(aliceWithdrawProto.data.withdrawn).toBe(true)
    expect(aliceCtx.deps.protocolRepo.listProposals('pending')).toHaveLength(0)

    // 3) rules propose & withdraw
    const ruleProp = (await executeOne(aliceCtx, [
      'rules',
      'propose',
      '--rule',
      'G3',
      '--enforcement',
      'off'
    ])) as { ok: boolean; data: { id: string } }
    expect(ruleProp.ok).toBe(true)
    const aliceWithdrawRule = (await executeOne(aliceCtx, [
      'rules',
      'propose',
      '--withdraw',
      ruleProp.data.id.slice(0, 8)
    ])) as { ok: boolean; data: { withdrawn: boolean } }
    expect(aliceWithdrawRule.ok).toBe(true)
    expect(aliceWithdrawRule.data.withdrawn).toBe(true)
    expect(aliceCtx.deps.rulesRepo.listProposals('pending')).toHaveLength(0)

    // 4) project handoff-propose & withdraw（且已采纳的不许撤回）
    const handoffProp1 = (await executeOne(aliceCtx, [
      'project',
      'handoff-propose',
      proj.name,
      '--body',
      '# 临时测试接手说明'
    ])) as { ok: boolean; data: { proposal: { id: string } } }
    expect(handoffProp1.ok).toBe(true)
    const aliceWithdrawHandoff = (await executeOne(aliceCtx, [
      'project',
      'handoff-propose',
      '--withdraw',
      handoffProp1.data.proposal.id.slice(0, 8)
    ])) as { ok: boolean; data: { withdrawn: boolean; proposal: { withdrawn: boolean } } }
    expect(aliceWithdrawHandoff.ok).toBe(true)
    expect(aliceWithdrawHandoff.data.withdrawn).toBe(true)
    expect(aliceCtx.deps.projectRepo.listHandoffProposals('pending')).toHaveLength(0)

    // 已采纳的提议禁止撤回
    const handoffProp2 = (await executeOne(aliceCtx, [
      'project',
      'handoff-propose',
      proj.name,
      '--body',
      '# 正式接手说明'
    ])) as { ok: boolean; data: { proposal: { id: string } } }
    aliceCtx.deps.projectRepo.decideHandoffProposal(handoffProp2.data.proposal.id, 'approved', 'human')
    const withdrawApproved = await executeOne(aliceCtx, [
      'project',
      'handoff-propose',
      '--withdraw',
      handoffProp2.data.proposal.id
    ])
    expect(withdrawApproved.ok).toBe(false)
    expect(withdrawApproved.message).toContain('不能撤回已处理')
  })

  it('2. [A2] todo close 支持 --notify 显式点名提醒对象（如 human），且 work next 的 waitingForHuman 汇总谁在等主用户做什么', async () => {
    const aliceCtx = makeCtx('agent:alice')
    const bobCtx = makeCtx('agent:bob')
    const humanCtx = makeCtx('human')

    aliceCtx.deps.categoryRepo.create({ name: '工作', color: '#3b82f6' })
    const proj = aliceCtx.deps.projectRepo.create({ name: 'DeskPartner' })

    const todo = aliceCtx.deps.todoRepo.create({
      title: '完成第一阶段清理',
      projectId: proj.id,
      createdBy: 'agent:bob',
      executedBy: 'agent:alice',
      verifier: 'agent:bob',
      status: 'awaiting_review'
    })

    // 验收方 bob 收口时显式 --notify human
    const closeRes = (await executeOne(bobCtx, [
      'todo',
      'close',
      todo.id.slice(0, 8),
      '--did',
      '已核验全部产物',
      '--verified',
      '扫描结果均为 0',
      '--pass-criteria',
      '产物无残留',
      '--leftover',
      '请主用户目视确认官网首屏 3 处样式',
      '--notify',
      'human'
    ])) as {
      ok: boolean
      data: {
        notifiedTo: string[]
        notifiedMemoIds: string[]
      }
    }

    expect(closeRes.ok).toBe(true)
    expect(closeRes.data.notifiedTo).toContain('human')
    expect(closeRes.data.notifiedTo).toContain('agent:alice')

    // 主用户执行 work next 能直接看到 waitingForHuman.unreadMemos 中来自 agent:bob 的点名事项
    const workRes = (await executeOne(humanCtx, ['work', 'next'])) as {
      ok: boolean
      data: {
        waitingForHuman: {
          unreadMemos: Array<{ from: string; linkedTodoId: string; text: string }>
          pendingProposals: { total: number }
        }
      }
    }
    expect(workRes.ok).toBe(true)
    expect(workRes.data.waitingForHuman.unreadMemos).toHaveLength(1)
    expect(workRes.data.waitingForHuman.unreadMemos[0]?.from).toBe('agent:bob')
    expect(workRes.data.waitingForHuman.unreadMemos[0]?.linkedTodoId).toBe(todo.id)
    expect(workRes.data.waitingForHuman.unreadMemos[0]?.text).toContain('请主用户目视确认官网首屏 3 处样式')
  })

  it('3. [A3] dp skill（L0）、dp skill project 与 dp skill core 均可读到接手说明更新时机与禁止手抄发版日志/实时计数指引', () => {
    const l0 = buildAgentGuideIndex('C:/Apps/DeskPartner/resources/cli/deskpartner.cjs', '1.0.139')
    const projectTopic = buildAgentGuideTopic('project', 'C:/Apps/DeskPartner/resources/cli/deskpartner.cjs', '1.0.139')
    const coreTopic = buildAgentGuideTopic('core', 'C:/Apps/DeskPartner/resources/cli/deskpartner.cjs', '1.0.139')

    for (const [label, text] of [
      ['L0 index', l0],
      ['skill project', projectTopic],
      ['skill core', coreTopic]
    ] as const) {
      expect(text, `${label} 应包含关键决定/工作入口/当前主线变更时才更新`).toContain('才更新接手说明')
      expect(text, `${label} 应包含禁止手抄发版日志与实时计数`).toContain('禁止手抄发版日志与实时计数')
    }
    expect(projectTopic).toContain('--withdraw')
  })

  it('4. [A4] notification list 元素暴露 readBy / read_by 只读归属，且 --ack-mine 后立即反映当前主体', async () => {
    const aliceCtx = makeCtx('agent:alice')
    const notif = aliceCtx.deps.notificationRepo.create({
      type: 'review',
      title: '测试通知',
      summary: '内容摘要',
      refId: null,
      actor: 'agent:bob',
      recipient: 'agent:alice'
    })
    expect(notif.id).toBeTruthy()

    // 未确认前 readBy / read_by 为 null
    const beforeAck = (await executeOne(aliceCtx, ['notification', 'list', '--to-me'])) as {
      ok: boolean
      data: {
        notifications: Array<{ id: string; readBy: string | null; read_by: string | null }>
      }
    }
    expect(beforeAck.ok).toBe(true)
    expect(beforeAck.data.notifications[0]?.readBy).toBeNull()
    expect(beforeAck.data.notifications[0]?.read_by).toBeNull()

    // --ack-mine 后当次返回及后续查询均包含 agent:alice
    const ackRes = (await executeOne(aliceCtx, ['notification', 'list', '--to-me', '--ack-mine'])) as {
      ok: boolean
      data: {
        notifications: Array<{ id: string; readBy: string | null; read_by: string | null }>
      }
    }
    expect(ackRes.ok).toBe(true)
    expect(ackRes.data.notifications[0]?.readBy).toBe('agent:alice')
    expect(ackRes.data.notifications[0]?.read_by).toBe('agent:alice')
  })
})
