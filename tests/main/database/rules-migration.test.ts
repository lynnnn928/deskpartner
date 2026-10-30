import { describe, it, expect, vi, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runMigrations } from '../../../src/main/database/migrations'
import { DB_VERSION } from '../../../src/renderer/lib/constants'

let activeDb: Database.Database
vi.mock('../../../src/main/database/index', () => ({
  getDatabase: () => activeDb
}))

const { RulesRepository } = await import('../../../src/main/database/rules.repository')
const { ProfileRepository } = await import('../../../src/main/database/profile.repository')
const { AgentRepository } = await import('../../../src/main/database/agent.repository')
const { GuardResolver } = await import('../../../src/main/database/guard-resolver')
const { CategoryRepository } = await import('../../../src/main/database/category.repository')
const { ProjectRepository } = await import('../../../src/main/database/project.repository')
const { TodoRepository } = await import('../../../src/main/database/todo.repository')

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-rules-migration-'))

afterAll(() => {
  try {
    if (activeDb?.open) activeDb.close()
    fs.rmSync(workDir, { recursive: true, force: true })
  } catch {
    /* 临时 fixture 清理失败不掩盖迁移断言 */
  }
})

describe('协作规则迁移 v44', () => {
  it('在有数据的 v43 副本上迁移，规则表建好且不影响已有数据', () => {
    const source = new Database(':memory:')
    activeDb = source
    runMigrations(source)
    const categories = new CategoryRepository()
    categories.initializeDefaults()
    const projects = new ProjectRepository()
    const project = projects.create({ name: 'v43 有数据项目' })
    const todos = new TodoRepository()
    todos.create({
      title: '旧库中的事项',
      projectId: project.id,
      status: 'todo',
      skipGuards: true
    })

    // 由真实迁移链建立基线，再撤销本轮新增表，形成有数据的 v43 老库形状
    source.exec('DROP TABLE IF EXISTS collaboration_rules; DROP TABLE IF EXISTS permission_matrix; DROP TABLE IF EXISTS rule_proposals')
    source.prepare('UPDATE _schema_version SET version = 43').run()

    // 重新迁移
    runMigrations(source)
    const version = source.prepare('SELECT version FROM _schema_version').get() as { version: number }
    expect(version.version).toBe(DB_VERSION)

    // 新表存在
    const tables = source.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN ('collaboration_rules','permission_matrix','rule_proposals')`).all()
    expect(tables.length).toBe(3)

    // 已有数据不受影响
    const todoCount = source.prepare('SELECT COUNT(*) as n FROM todos').get() as { n: number }
    expect(todoCount.n).toBe(1)
  })

  it('出厂默认 = 当前产品行为：listRules 返回 GATES 的默认强度', () => {
    const source = new Database(':memory:')
    activeDb = source
    runMigrations(source)
    const repo = new RulesRepository()

    const rules = repo.listRules({ scope: 'global' })
    // 流转规则
    expect(rules.find((r) => r.key === 'G1')?.enforcement).toBe('block')
    expect(rules.find((r) => r.key === 'G2')?.enforcement).toBe('block')
    expect(rules.find((r) => r.key === 'G4-status')?.enforcement).toBe('block')
    expect(rules.find((r) => r.key === 'G4-delete')?.enforcement).toBe('authorize')
    expect(rules.find((r) => r.key === 'G6')?.enforcement).toBe('block')
    expect(rules.find((r) => r.key === 'G10')?.enforcement).toBe('block')
    // 提醒
    expect(rules.find((r) => r.key === 'G3')?.enforcement).toBe('notice')
    expect(rules.find((r) => r.key === 'G5')?.enforcement).toBe('notice')
    expect(rules.find((r) => r.key === 'G7')?.enforcement).toBe('notice')
    expect(rules.find((r) => r.key === 'G8')?.enforcement).toBe('notice')
    expect(rules.find((r) => r.key === 'G9')?.enforcement).toBe('notice')
    // 全部来自出厂默认
    expect(rules.every((r) => r.source === 'default')).toBe(true)
  })

  it('项目覆盖 → 全局 → 出厂默认 三层解析', () => {
    const source = new Database(':memory:')
    activeDb = source
    runMigrations(source)
    const repo = new RulesRepository()
    const projects = new ProjectRepository()
    const project = projects.create({ name: '覆盖测试项目' })

    // 全局层改 G10 为 notice
    repo.saveRule({ scope: 'global' }, 'G10', 'notice', 'human')
    const globalRules = repo.listRules({ scope: 'global' })
    expect(globalRules.find((r) => r.key === 'G10')?.enforcement).toBe('notice')
    expect(globalRules.find((r) => r.key === 'G10')?.source).toBe('global')

    // 项目层覆盖 G10 为 off
    repo.saveRule({ scope: 'project', projectId: project.id }, 'G10', 'off', 'human')
    const projectRules = repo.listRules({ scope: 'project', projectId: project.id })
    expect(projectRules.find((r) => r.key === 'G10')?.enforcement).toBe('off')
    expect(projectRules.find((r) => r.key === 'G10')?.source).toBe('project')

    // 全局不受项目覆盖影响
    const globalAfter = repo.listRules({ scope: 'global' })
    expect(globalAfter.find((r) => r.key === 'G10')?.enforcement).toBe('notice')

    // 未覆盖的规则沿用全局/默认
    expect(projectRules.find((r) => r.key === 'G1')?.enforcement).toBe('block')
    expect(projectRules.find((r) => r.key === 'G1')?.source).toBe('default')
  })

  it('权限矩阵：human 全 allow，agent 按出厂默认', () => {
    const source = new Database(':memory:')
    activeDb = source
    runMigrations(source)
    const repo = new RulesRepository()

    const perms = repo.listPermissions({ scope: 'global' })
    const humanSelfVerify = perms.find((p) => p.action === 'self_verify' && p.subject === 'human')
    expect(humanSelfVerify?.decision).toBe('allow')
    const agentSelfVerify = perms.find((p) => p.action === 'self_verify' && p.subject === 'all_agents')
    expect(agentSelfVerify?.decision).toBe('deny')
    const agentUpdateProfile = perms.find((p) => p.action === 'update_profile' && p.subject === 'all_agents')
    expect(agentUpdateProfile?.decision).toBe('require_approval')
  })

  it('权限解析：all_agents 配置对具体 agent 生效，具体 agent 配置优先', () => {
    const source = new Database(':memory:')
    activeDb = source
    runMigrations(source)
    const repo = new RulesRepository()
    const resolver = new GuardResolver(repo)

    repo.savePermission({ scope: 'global' }, 'update_handoff', 'all_agents', 'allow', 'human')
    expect(resolver.checkPermission('update_handoff', 'agent:carol', { scope: 'global' })).toBe('allow')

    repo.savePermission({ scope: 'global' }, 'update_handoff', 'agent:carol', 'deny', 'human')
    expect(resolver.checkPermission('update_handoff', 'agent:carol', { scope: 'global' })).toBe('deny')
    expect(resolver.checkPermission('update_handoff', 'agent:other', { scope: 'global' })).toBe('allow')
  })

  it('规则提议 → 采纳后生效', () => {
    const source = new Database(':memory:')
    activeDb = source
    runMigrations(source)
    const repo = new RulesRepository()

    const proposal = repo.propose({ scope: 'global' }, 'G10', 'off', 'agent:test')
    expect(proposal.status).toBe('pending')

    const decided = repo.decideProposal(proposal.id, 'approved', 'human')
    expect(decided.status).toBe('approved')

    const rules = repo.listRules({ scope: 'global' })
    expect(rules.find((r) => r.key === 'G10')?.enforcement).toBe('off')
  })

  it('规则提议进入可筛选的审批历史，保留提议前后和决定值', () => {
    const source = new Database(':memory:')
    activeDb = source
    runMigrations(source)
    const rules = new RulesRepository()
    const agents = new AgentRepository()
    agents.register({ id: 'agent:rules-history', displayName: '规则历史 Agent' })
    const proposal = rules.propose({ scope: 'global' }, 'G10', 'off', 'agent:rules-history')
    rules.decideProposal(proposal.id, 'approved', 'human')

    const page = agents.listApprovalHistory({ offset: 0, limit: 20, type: 'rules' })
    expect(page.total).toBe(1)
    expect(page.rows[0]).toMatchObject({
      type: 'rules',
      decision: 'approved',
      summary: '协作规则提议 · G10',
      originalBody: 'block',
      proposedBody: 'off',
      decidedBody: 'off',
      execution: 'not_required'
    })
  })

  it('规则提议 → 拒绝后不变', () => {
    const source = new Database(':memory:')
    activeDb = source
    runMigrations(source)
    const repo = new RulesRepository()

    const proposal = repo.propose({ scope: 'global' }, 'G2', 'off', 'agent:test')
    const decided = repo.decideProposal(proposal.id, 'rejected', 'human')
    expect(decided.status).toBe('rejected')

    const rules = repo.listRules({ scope: 'global' })
    expect(rules.find((r) => r.key === 'G2')?.enforcement).toBe('block')
  })

  it('权限矩阵仅 GUI 可改：savePermission 是唯一写入口，CLI/MCP 无对应命令', () => {
    const source = new Database(':memory:')
    activeDb = source
    runMigrations(source)
    const repo = new RulesRepository()

    // GUI 保存
    repo.savePermission({ scope: 'global' }, 'self_verify', 'all_agents', 'allow', 'human')
    const perms = repo.listPermissions({ scope: 'global' })
    const agentSelfVerify = perms.find((p) => p.action === 'self_verify' && p.subject === 'all_agents')
    expect(agentSelfVerify?.decision).toBe('allow')
    expect(agentSelfVerify?.source).toBe('global')
  })

  it('恢复出厂默认：resetRule 删掉覆盖', () => {
    const source = new Database(':memory:')
    activeDb = source
    runMigrations(source)
    const repo = new RulesRepository()

    repo.saveRule({ scope: 'global' }, 'G1', 'off', 'human')
    expect(repo.listRules({ scope: 'global' }).find((r) => r.key === 'G1')?.enforcement).toBe('off')

    repo.resetRule({ scope: 'global' }, 'G1')
    const after = repo.listRules({ scope: 'global' }).find((r) => r.key === 'G1')
    expect(after?.enforcement).toBe('block')
    expect(after?.source).toBe('default')
  })

  it('规则历史回滚准确恢复“项目覆盖”与“沿用全局”两种状态', () => {
    const source = new Database(':memory:')
    activeDb = source
    runMigrations(source)
    const repo = new RulesRepository()
    const project = new ProjectRepository().create({ name: '规则修订项目' })

    repo.saveRule({ scope: 'global' }, 'G10', 'notice', 'human')
    repo.saveRule({ scope: 'project', projectId: project.id }, 'G10', 'off', 'human')
    const projectHistory = repo.listRevisions({ scope: 'project', projectId: project.id }, 'G10')
    expect(projectHistory.slice(0, 2).map((revision) => [revision.enforcement, revision.hasOverride])).toEqual([
      ['off', true], [null, false]
    ])

    repo.resetRule({ scope: 'project', projectId: project.id }, 'G10')
    const resetRevision = repo.listRevisions({ scope: 'project', projectId: project.id }, 'G10')[0]
    expect(resetRevision).toMatchObject({ enforcement: null, hasOverride: false })
    expect(repo.listRules({ scope: 'project', projectId: project.id }).find((rule) => rule.key === 'G10'))
      .toMatchObject({ enforcement: 'notice', source: 'global' })

    repo.rollbackRevision(projectHistory[0].id)
    expect(repo.listRules({ scope: 'project', projectId: project.id }).find((rule) => rule.key === 'G10'))
      .toMatchObject({ enforcement: 'off', source: 'project' })
    repo.rollbackRevision(resetRevision.id)
    expect(repo.listRules({ scope: 'project', projectId: project.id }).find((rule) => rule.key === 'G10'))
      .toMatchObject({ enforcement: 'notice', source: 'global' })
  })

  it('修订写入失败时规则配置一并回滚', () => {
    const source = new Database(':memory:')
    activeDb = source
    runMigrations(source)
    const repo = new RulesRepository()
    source.exec(`CREATE TRIGGER reject_rule_revision BEFORE INSERT ON rule_revisions
      BEGIN SELECT RAISE(ABORT, 'revision blocked'); END;`)

    expect(() => repo.saveRule({ scope: 'global' }, 'G1', 'off', 'human')).toThrow('revision blocked')
    expect(repo.listRules({ scope: 'global' }).find((rule) => rule.key === 'G1'))
      .toMatchObject({ enforcement: 'block', source: 'default' })
  })

  it('v44 存量档案和规则升级后各自保留可回滚的迁移基线', () => {
    const source = new Database(':memory:')
    activeDb = source
    runMigrations(source)
    const projects = new ProjectRepository()
    const project = projects.create({ name: 'v44 修订历史项目' })
    new ProfileRepository().save({ scope: 'global' }, 'basics', '迁移前资料')
    new RulesRepository().saveRule({ scope: 'project', projectId: project.id }, 'G10', 'notice', 'human')

    source.exec('DROP TABLE profile_revisions; DROP TABLE rule_revisions;')
    source.prepare('UPDATE _schema_version SET version = 44').run()
    runMigrations(source)

    expect(new ProfileRepository().listRevisions({ scope: 'global' }, 'basics'))
      .toContainEqual(expect.objectContaining({ body: '迁移前资料', present: true }))
    expect(new RulesRepository().listRevisions({ scope: 'project', projectId: project.id }, 'G10'))
      .toContainEqual(expect.objectContaining({ enforcement: 'notice', hasOverride: true }))
  })
})
