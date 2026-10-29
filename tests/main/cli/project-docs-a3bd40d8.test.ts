import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { runMigrations } from '../../../src/main/database/migrations'
import { ProjectRepository } from '../../../src/main/database/project.repository'
import { AgentRepository } from '../../../src/main/database/agent.repository'
import { EventsRepository } from '../../../src/main/database/events.repository'
import { executeOne } from '../../../src/main/cli/commands'

const db = new Database(':memory:')
vi.mock('../../../src/main/database/index', () => ({ getDatabase: () => db }))
vi.mock('../../../src/cli/credentials', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/cli/credentials')>()
  return { ...actual, writeCredential: vi.fn() }
})

/**
 * 卡 `a3bd40d8`（方式 B）/ 卡 `095b2006`（方案 C）：
 * 接手说明留在数据库内（可靠随库备份 + 修订历史 + 审批），
 * 项目可关联本地 Markdown 文档目录（只读索引、渲染、防越界读取，CLI/MCP/GUI 同源）。
 */
describe('项目关联本地 Markdown 文档目录（a3bd40d8 / 095b2006）', () => {
  let projects: ProjectRepository
  let agents: AgentRepository
  let agentToken = ''
  let tempDocsDir = ''

  beforeAll(() => {
    runMigrations(db)
    tempDocsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-proj-docs-a3bd40d8-'))
    fs.writeFileSync(
      path.join(tempDocsDir, 'architecture.md'),
      '# 系统架构说明\n\n这是项目的核心架构设计文档。\n',
      'utf8'
    )
    fs.mkdirSync(path.join(tempDocsDir, 'decisions'), { recursive: true })
    fs.writeFileSync(
      path.join(tempDocsDir, 'decisions', '001-storage.md'),
      '# 001 存储选型决策\n\n采用 SQLite 作为本地权威存储。\n',
      'utf8'
    )
    // node_modules 下的 md 应被自动忽略
    fs.mkdirSync(path.join(tempDocsDir, 'node_modules', 'pkg'), { recursive: true })
    fs.writeFileSync(path.join(tempDocsDir, 'node_modules', 'pkg', 'README.md'), '# Ignored\n', 'utf8')
  })

  afterAll(() => {
    try {
      fs.rmSync(tempDocsDir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  beforeEach(() => {
    db.exec(`
      DELETE FROM project_handoff_revisions;
      DELETE FROM project_handoff_proposals;
      DELETE FROM projects;
      DELETE FROM agents;
    `)
    projects = new ProjectRepository()
    agents = new AgentRepository()
    agents.register({ id: 'agent:penguin', displayName: 'Penguin', color: '#8B5CF6' } as never)
    agents.setApproved('agent:penguin', true)
    agentToken = agents.issueCredential('agent:penguin')?.token ?? ''
  })

  function mkCtx(actor = 'agent:penguin', credential = agentToken) {
    return {
      deps: {
        projectRepo: projects,
        agentRepo: agents,
        events: new EventsRepository(),
        telemetry: { record: () => {}, stats: () => ({}), query: () => [], clear: () => 0 }
      },
      meta: {
        version: '1.0.129',
        dbPath: ':memory:',
        schemaVersion: 47,
        busyTimeoutMs: 5000,
        channels: ['headless' as const],
        via: 'headless' as const,
        startedAt: Date.now()
      },
      interactive: false,
      actor,
      credential
    } as never
  }

  it('project add --docs-dir 支持新建与同名项目复用更新文档目录，且传 clear 可取消关联', async () => {
    const createRes = await executeOne(mkCtx(), [
      'project',
      'add',
      '--name',
      'DeskPartner',
      '--docs-dir',
      tempDocsDir
    ])
    expect(createRes.ok).toBe(true)
    const p = projects.getById(projects.resolveId('DeskPartner'))
    expect(p?.docsDir).toBe(tempDocsDir)

    // 同名项目复用时传 --docs-dir clear 可取消关联
    const clearRes = await executeOne(mkCtx(), [
      'project',
      'add',
      '--name',
      'DeskPartner',
      '--docs-dir',
      'clear'
    ])
    expect(clearRes.ok).toBe(true)
    expect((clearRes.data as { reused: boolean; docsDir: string | null }).reused).toBe(true)
    expect((clearRes.data as { docsDir: string | null }).docsDir).toBeNull()
    expect(projects.getById(p!.id)?.docsDir).toBeUndefined()
  })

  it('doc list --project 与 doc show --project 只读索引并读取项目 Markdown 文档，自动忽略 node_modules', async () => {
    projects.create({ name: 'DeskPartner', docsDir: tempDocsDir })

    const listRes = await executeOne(mkCtx(), ['doc', 'list', '--project', 'DeskPartner'])
    expect(listRes.ok).toBe(true)
    const rows = listRes.data as Array<{ file: string; title: string; bytes: number; sha256: string }>
    expect(rows.map((r) => r.file)).toEqual(['architecture.md', 'decisions/001-storage.md'])
    expect(rows[0].title).toBe('系统架构说明')
    expect(rows[1].title).toBe('001 存储选型决策')

    // 按相对路径或唯一文件名读取正文
    const showRes = await executeOne(mkCtx(), [
      'doc',
      'show',
      'decisions/001-storage.md',
      '--project',
      'DeskPartner'
    ])
    expect(showRes.ok).toBe(true)
    const doc = showRes.data as { file: string; title: string; content: string }
    expect(doc.file).toBe('decisions/001-storage.md')
    expect(doc.title).toBe('001 存储选型决策')
    expect(doc.content).toContain('采用 SQLite 作为本地权威存储')
  })

  it('doc show --project 拦截越界路径（../），防止越出项目关联的文档目录', async () => {
    projects.create({ name: 'DeskPartner', docsDir: tempDocsDir })

    const res = await executeOne(mkCtx(), [
      'doc',
      'show',
      '../outside.md',
      '--project',
      'DeskPartner'
    ])
    expect(res.ok).toBe(false)
    expect(res.code).toBe(2)
    expect(String((res as { message?: string }).message)).toContain('不允许越出项目关联的文档目录')
  })
})
