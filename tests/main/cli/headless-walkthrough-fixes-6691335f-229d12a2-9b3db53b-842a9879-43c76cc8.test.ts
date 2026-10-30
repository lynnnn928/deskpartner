import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '../../../src/main/database/migrations'
import { ProjectRepository } from '../../../src/main/database/project.repository'
import { TodoRepository } from '../../../src/main/database/todo.repository'
import { CategoryRepository } from '../../../src/main/database/category.repository'
import { MemoRepository } from '../../../src/main/database/memo.repository'
import { SettingsRepository } from '../../../src/main/database/settings.repository'
import { AgentRepository } from '../../../src/main/database/agent.repository'
import { ReleaseRepository } from '../../../src/main/database/release.repository'
import { CommentRepository } from '../../../src/main/database/comment.repository'
import { NotificationRepository } from '../../../src/main/database/notification.repository'
import { ReminderReceiptRepository } from '../../../src/main/database/reminder-receipt.repository'
import { RulesRepository } from '../../../src/main/database/rules.repository'
import { ProtocolRepository } from '../../../src/main/database/protocol.repository'
import { ProfileRepository } from '../../../src/main/database/profile.repository'
import { markHandoffDirty } from '../../../src/main/database/handoff-state'
import { executeOne, type CliContext } from '../../../src/main/cli/commands'
import { buildAgentGuide, buildAgentGuideIndex } from '../../../src/main/cli/agent-guide'

const db = new Database(':memory:')
vi.mock('../../../src/main/database/index', () => ({ getDatabase: () => db }))

const projectRepo = new ProjectRepository()
const todoRepo = new TodoRepository()
const categoryRepo = new CategoryRepository()
const memoRepo = new MemoRepository()
const settingsRepo = new SettingsRepository()
const agentRepo = new AgentRepository()
const releaseRepo = new ReleaseRepository()
const commentRepo = new CommentRepository()
const notificationRepo = new NotificationRepository()
const reminderReceiptRepo = new ReminderReceiptRepository()
const rulesRepo = new RulesRepository()
const protocolRepo = new ProtocolRepository()
const profileRepo = new ProfileRepository()

function makeCtx(overrides: Partial<CliContext> = {}): CliContext {
  return {
    deps: {
      todoRepo,
      categoryRepo,
      projectRepo,
      memoRepo,
      settingsRepo,
      agentRepo,
      releaseRepo,
      commentRepo,
      notificationRepo,
      reminderReceiptRepo,
      rulesRepo,
      protocolRepo,
      profileRepo,
      events: { append: () => {} },
      telemetry: { record: () => {}, stats: () => ({}), query: () => [], clear: () => 0 }
    },
    meta: {
      version: '1.0.134',
      dbPath: ':memory:',
      schemaVersion: 48,
      busyTimeoutMs: 5000,
      channels: ['pipe', 'headless'],
      via: 'pipe',
      startedAt: Date.now()
    },
    interactive: true,
    ...overrides
  } as unknown as CliContext
}

beforeAll(() => {
  runMigrations(db)
  db.pragma('foreign_keys = OFF')
})

beforeEach(() => {
  db.prepare('DELETE FROM cli_reminder_receipts').run()
  db.prepare('DELETE FROM project_handoff_revisions').run()
  db.prepare('DELETE FROM project_handoff_proposals').run()
  db.prepare('DELETE FROM releases').run()
  db.prepare('DELETE FROM todos').run()
  db.prepare('DELETE FROM projects').run()
  db.prepare('DELETE FROM categories').run()
  categoryRepo.initializeDefaults()
})

describe('阶段3 Headless 实测反馈五项修复（6691335f / 229d12a2 / 9b3db53b / 842a9879 / 43c76cc8）', () => {
  it('1. [6691335f] freshness.reasons 在事实差异叠加多次发布时不丢失最新一次发布记录', () => {
    const pid = projectRepo.create({ name: 'DeskPartner' }).id
    const cid = categoryRepo.list()[0].id
    todoRepo.create({
      title: '旧主线',
      projectId: pid,
      categoryIds: [cid],
      status: 'in_progress',
      priority: 'high',
      skipGuards: true
    })

    // 保存基于 1.0.131 的快照
    projectRepo.saveHandoff(pid, '旧版接手说明', 'human', undefined, { version: '1.0.131' })
    // 模拟快照是旧 schema v47
    const revRow = db
      .prepare('SELECT id, facts_snapshot FROM project_handoff_revisions WHERE project_id = ?')
      .get(pid) as { id: string; facts_snapshot: string }
    const snap = JSON.parse(revRow.facts_snapshot)
    snap.schemaVersion = 47
    db.prepare('UPDATE project_handoff_revisions SET facts_snapshot = ? WHERE id = ?').run(
      JSON.stringify(snap),
      revRow.id
    )

    // 切换主线 + 连续三次发布（1.0.132 / 1.0.133 / 1.0.134）
    todoRepo.create({
      title: '新主线：干净环境验证',
      projectId: pid,
      categoryIds: [cid],
      status: 'in_progress',
      priority: 'urgent',
      skipGuards: true
    })
    markHandoffDirty(db, pid, '发布了 1.0.132')
    markHandoffDirty(db, pid, '发布了 1.0.133')
    markHandoffDirty(db, pid, '发布了 1.0.134')

    const state = projectRepo.getHandoffState(pid, { version: '1.0.134' })
    expect(state.freshness.dirty?.reasons).toEqual([
      '发布了 1.0.132',
      '发布了 1.0.133',
      '发布了 1.0.134'
    ])
    expect(state.freshness.reasons).toContain('发布了 1.0.132')
    expect(state.freshness.reasons).toContain('发布了 1.0.133')
    expect(state.freshness.reasons).toContain('发布了 1.0.134')
  })

  it('2. [229d12a2] todo list / todo add / work next / protocol get / profile get / rules get 的 --project 均支持项目名、短 ID 与完整 UUID', async () => {
    const proj = projectRepo.create({ name: 'DeskPartner' })
    const shortId = proj.id.slice(0, 8)
    const ctx = makeCtx()

    // 使用完整 UUID 与短 ID 调用 todo add
    const addByUuid = (await executeOne(ctx, [
      'todo',
      'add',
      '--project',
      proj.id,
      '--title',
      '按 UUID 创建的事项'
    ])) as { ok: boolean; data: { id: string } }
    expect(addByUuid.ok).toBe(true)

    const addByShort = (await executeOne(ctx, [
      'todo',
      'add',
      '--project',
      shortId,
      '--title',
      '按短 ID 创建的事项'
    ])) as { ok: boolean; data: { id: string } }
    expect(addByShort.ok).toBe(true)

    // todo list 支持完整 UUID 与短 ID
    for (const ref of [proj.name, proj.id, shortId]) {
      const listRes = (await executeOne(ctx, ['todo', 'list', '--project', ref])) as {
        ok: boolean
        data: Array<{ id: string }>
      }
      expect(listRes.ok).toBe(true)
      expect(listRes.data.length).toBe(2)

      const workRes = (await executeOne(ctx, ['work', 'next', '--project', ref])) as {
        ok: boolean
      }
      expect(workRes.ok).toBe(true)

      const protoRes = (await executeOne(ctx, ['protocol', 'get', '--project', ref])) as {
        ok: boolean
        data: { projectId: string }
      }
      expect(protoRes.ok).toBe(true)
      expect(protoRes.data.projectId).toBe(proj.id)

      const profRes = (await executeOne(ctx, ['profile', 'get', '--project', ref])) as {
        ok: boolean
        data: { projectId: string }
      }
      expect(profRes.ok).toBe(true)
      expect(profRes.data.projectId).toBe(proj.id)

      const rulesRes = (await executeOne(ctx, ['rules', 'get', '--project', ref])) as {
        ok: boolean
        data: { projectId: string }
      }
      expect(rulesRes.ok).toBe(true)
      expect(rulesRes.data.projectId).toBe(proj.id)
    }
  })

  it('3. [9b3db53b] doctor 优先校验调用方传入的 ctx.cliEnv，路径失效时返回 env-missing-file 及可直接复制的 fallbackPath', async () => {
    const staleCallerPath = 'C:\\Apps\\测试应用\\DeskPartner\\resources\\cli\\deskpartner.cjs'
    const res = (await executeOne(makeCtx({ cliEnv: staleCallerPath }), ['doctor'])) as {
      ok: boolean
      data: {
        cli: {
          envVar: string
          value: string
          fallbackPath: string
          source: string
          exists: boolean
          note: string
        }
      }
    }
    expect(res.ok).toBe(true)
    expect(res.data.cli.source).toBe('env-missing-file')
    expect(res.data.cli.exists).toBe(false)
    expect(res.data.cli.value).toBe(
      'C:/Apps/测试应用/DeskPartner/resources/cli/deskpartner.cjs'
    )
    expect(res.data.cli.fallbackPath).toContain('deskpartner.cjs')
    expect(res.data.cli.note).toContain(res.data.cli.fallbackPath)

    const guideIndex = buildAgentGuideIndex('C:/Real/Path/deskpartner.cjs', '1.0.134')
    expect(guideIndex).toContain('node "$DESKPARTNER_CLI" <命令>')
    expect(guideIndex).toContain('node "C:/Real/Path/deskpartner.cjs" <命令>')
  })

  it('4. [842a9879] Agent 调用 skill 后自动登记已读当前说明书版本，后续调用不再刷 G8 落后或未声明提醒', async () => {
    const agentCtx = makeCtx({
      interactive: false,
      actor: 'agent:newmax',
      skillVersion: '1.0.74'
    })

    // 读取 skill 前：由于环境变量仍是旧的 1.0.74，会触发 G8 提醒
    const beforeRead = (await executeOne(agentCtx, ['doctor'])) as {
      ok: boolean
      notice?: string
    }
    expect(beforeRead.ok).toBe(true)
    expect(beforeRead.notice).toContain('你手上的说明书是 1.0.74，当前 CLI 已是 1.0.134')

    // Agent 调用 skill 读取最新说明书
    const skillRes = await executeOne(agentCtx, ['skill'])
    expect(skillRes.ok).toBe(true)

    // 读取后：即使调用方环境里的 skillVersion 仍为 1.0.74 或未传，也不再重复刷 G8 提醒
    const afterRead = (await executeOne(agentCtx, ['doctor'])) as {
      ok: boolean
      notice?: string
      data: { declaredSkillVersion: string | null }
    }
    expect(afterRead.ok).toBe(true)
    expect(afterRead.notice).toBeUndefined()

    const afterReadNoEnv = (await executeOne(
      makeCtx({ interactive: false, actor: 'agent:newmax', skillVersion: undefined }),
      ['doctor']
    )) as {
      ok: boolean
      notice?: string
      data: { declaredSkillVersion: string | null }
    }
    expect(afterReadNoEnv.ok).toBe(true)
    expect(afterReadNoEnv.notice).toBeUndefined()
    expect(afterReadNoEnv.data.declaredSkillVersion).toBe('1.0.134')
  })

  it('5. [43c76cc8] 内置说明书与发版回执明确只在方向/关键决定/工作入口/主线变更时更新接手说明，禁止手抄发版日志与状态计数', async () => {
    const fullGuide = buildAgentGuide('C:/Real/Path/deskpartner.cjs', '1.0.134')
    const indexGuide = buildAgentGuideIndex('C:/Real/Path/deskpartner.cjs', '1.0.134')
    expect(fullGuide).not.toContain('每完成一轮工作或发版后更新接手说明')
    expect(fullGuide).toContain('不要把发版日志或实时状态计数手抄进说明')
    expect(indexGuide).toContain('不要手抄发版日志或状态计数')

    const pid = projectRepo.create({ name: 'DeskPartner' }).id
    expect(pid).toBeTruthy()
    const relRes = (await executeOne(makeCtx(), [
      'release',
      'add',
      '--project',
      'DeskPartner',
      '--version',
      '1.0.134',
      '--summary',
      '首发版本',
      '--tested',
      'yes'
    ])) as { ok: boolean; data: { note: string } }
    expect(relRes.ok).toBe(true)
    expect(relRes.data.note).toContain('切勿把发版日志或状态计数手抄进说明')
  })
})
