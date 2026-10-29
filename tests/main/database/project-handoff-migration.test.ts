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

const { ProjectRepository } = await import('../../../src/main/database/project.repository')
const { TodoRepository } = await import('../../../src/main/database/todo.repository')
const { CategoryRepository } = await import('../../../src/main/database/category.repository')
const { CommentRepository } = await import('../../../src/main/database/comment.repository')

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-project-handoff-'))
const oldCopyPath = path.join(workDir, 'populated-v33-copy.db')
const proposalMigrationPath = path.join(workDir, 'populated-v42-copy.db')
const roundTripPath = path.join(workDir, 'handoff-backup-roundtrip.db')

afterAll(() => {
  try {
    if (activeDb?.open) activeDb.close()
    fs.rmSync(workDir, { recursive: true, force: true })
  } catch {
    /* 临时 fixture 清理失败不掩盖迁移断言 */
  }
})

describe('项目接手说明迁移与 SQLite backup API', () => {
  it('在有项目、事项和评论的 v33 副本上迁移，写入后重启回读并经 backup API 往返', async () => {
    const source = new Database(':memory:')
    activeDb = source
    runMigrations(source)
    const categories = new CategoryRepository()
    categories.initializeDefaults()

    const projects = new ProjectRepository()
    const project = projects.create({ name: 'v33 有数据项目' })
    const todos = new TodoRepository()
    const todo = todos.create({
      title: '旧库中的挂起事项',
      description: '原有描述保持不变',
      projectId: project.id,
      status: 'suspended',
      skipGuards: true
    })
    const comment = new CommentRepository().create({
      todoId: todo.id,
      body: '旧库中的原有评论',
      authorType: 'agent',
      authorId: 'agent:old'
    })

    // 由真实迁移链建立基线，再只撤销本轮新增列，形成有数据的 v33 老库形状。
    source.exec('DROP TABLE cli_reminder_receipts; DROP TABLE project_handoff_revisions; ALTER TABLE projects DROP COLUMN handoff_markdown')
    source.prepare('UPDATE _schema_version SET version = 33').run()
    await source.backup(oldCopyPath)
    source.close()

    // 只在 SQLite backup API 生成的临时副本上跑迁移，绝不接触用户库。
    activeDb = new Database(oldCopyPath)
    runMigrations(activeDb)
    const migratedProject = projects.getById(project.id)!
    expect(migratedProject.handoffMarkdown).toBe('')
    expect(todos.getById(todo.id)).toMatchObject({
      id: todo.id,
      title: '旧库中的挂起事项',
      description: '原有描述保持不变',
      status: 'suspended',
      projectId: project.id
    })
    expect(new CommentRepository().listByTodo(todo.id)).toContainEqual(
      expect.objectContaining({ id: comment.id, body: '旧库中的原有评论' })
    )

    const markdown = '# 接手说明\n\n当前方向：保留旧数据；入口见 `src/main`。\n'
    projects.update({ id: project.id, handoffMarkdown: markdown })
    activeDb.close()

    // 关闭连接后重新打开同一个文件，模拟应用重启后的仓储回读。
    activeDb = new Database(oldCopyPath)
    expect(new ProjectRepository().getById(project.id)?.handoffMarkdown).toBe(markdown)

    // SQLite backup API 取得一致性快照，再打开快照核对新字段完整往返。
    await activeDb.backup(roundTripPath)
    const roundTrip = new Database(roundTripPath)
    activeDb = roundTrip
    expect(new ProjectRepository().getById(project.id)?.handoffMarkdown).toBe(markdown)
    expect(new ProjectRepository().getDetail(project.id)?.overview.items).toContainEqual(
      expect.objectContaining({ id: todo.id, status: 'suspended' })
    )
  })

  it('有数据的 v42 旧库副本升级后创建 handoff proposal 表并保留业务数据', async () => {
    const source = new Database(':memory:')
    activeDb = source
    source.pragma('foreign_keys = ON')
    runMigrations(source)
    new CategoryRepository().initializeDefaults()
    const projects = new ProjectRepository()
    const project = projects.create({ name: 'v42 接手提议迁移项目', handoffMarkdown: '旧接手说明' })
    const todo = new TodoRepository().create({
      title: '迁移前事项', categoryIds: [], projectId: project.id, status: 'todo', skipGuards: true
    })
    const comment = new CommentRepository().create({
      todoId: todo.id, body: '迁移前评论', authorType: 'agent', authorId: 'agent:legacy'
    })

    source.exec('DROP TABLE project_handoff_proposals')
    source.prepare('UPDATE _schema_version SET version = 42').run()
    await source.backup(proposalMigrationPath)
    source.close()

    // 只在备份副本上跑 42 → 43 迁移。
    activeDb = new Database(proposalMigrationPath)
    activeDb.pragma('foreign_keys = ON')
    runMigrations(activeDb)

    const version = activeDb.prepare('SELECT MAX(version) AS version FROM _schema_version').get() as { version: number }
    expect(version.version).toBe(DB_VERSION)
    const columns = (activeDb.prepare('PRAGMA table_info(project_handoff_proposals)').all() as Array<{ name: string }>).map((column) => column.name)
    expect(columns).toEqual(expect.arrayContaining([
      'id', 'project_id', 'body', 'original_body', 'base_revision', 'decided_body',
      'proposer', 'status', 'decided_by', 'decided_at', 'created_at'
    ]))
    expect(new ProjectRepository().getById(project.id)?.handoffMarkdown).toBe('旧接手说明')
    expect(new TodoRepository().getById(todo.id)?.title).toBe('迁移前事项')
    expect(new CommentRepository().listByTodo(todo.id)).toContainEqual(expect.objectContaining({ id: comment.id, body: '迁移前评论' }))

    const proposal = new ProjectRepository().proposeHandoff(project.id, '迁移后新提议', 'agent:alice')
    expect(new ProjectRepository().listHandoffProposals()).toMatchObject([{ id: proposal.id, status: 'pending' }])
  })
})
