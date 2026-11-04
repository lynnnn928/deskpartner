import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runMigrations } from '../../../src/main/database/migrations'
import { DB_VERSION } from '../../../src/renderer/lib/constants'

/**
 * 关联目录文档的读时快照（schema v49，卡 `e15d1a78`）
 *
 * 口径（主用户 2026-11-04 拍板）：**读时快照、只读历史、只给界面**。
 *
 * 判据：
 * 1. 界面读一篇文档记一版，**内容没变再读不写第二版**（去重）；
 * 2. 每篇只留最近 `DOC_REVISION_LIMIT` 版，超出删最旧、seq 不回收；
 * 3. 「当前」按**内容**判定，不按时间先后（A → B → A 只有两版，当前落在最早那版）；
 * 4. seq 是每篇内的，两篇文档互不串；
 * 5. 仓储的读（`readProjectDoc`，CLI `doc show` 走的就是它）**不写库** —— 记录点只在界面那条 IPC；
 * 6. 删项目一并清掉快照（不靠外键也清得掉，回执里逐表报数含它）；
 * 7. 迁移在**有数据的 v48 老库副本**上跑通、旧数据条数不变，且不编造历史。
 */
let activeDb: Database.Database
vi.mock('../../../src/main/database/index', () => ({
  getDatabase: () => activeDb
}))

const { ProjectRepository, DOC_REVISION_LIMIT } = await import(
  '../../../src/main/database/project.repository'
)
const { CategoryRepository } = await import('../../../src/main/database/category.repository')
const { TodoRepository } = await import('../../../src/main/database/todo.repository')

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-doc-rev-'))
const docsDir = path.join(workDir, 'docs')
fs.mkdirSync(docsDir, { recursive: true })

afterAll(() => {
  try {
    if (activeDb?.open) activeDb.close()
    fs.rmSync(workDir, { recursive: true, force: true })
  } catch {
    /* 临时目录清理失败不掩盖断言 */
  }
})

const writeDoc = (rel: string, body: string): void => {
  const abs = path.join(docsDir, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, body)
}

type Repo = InstanceType<typeof ProjectRepository>

/**
 * 界面读一篇文档 = IPC `project:readDoc` 的两步（读 + 记一版）。
 *
 * 这里手写这两步而不是调真正的 IPC 处理器（那要拉起 Electron 的 `ipcMain`）；
 * 「记录点只挂在界面这条路上」由 `tests/main/cli/doc-revision-gui-only-e15d1a78.test.ts`
 * 那道结构性闸门看着。
 */
const readViaGui = (repo: Repo, projectId: string, file: string): void => {
  const doc = repo.readProjectDoc(projectId, file)
  repo.recordDocRevision({
    projectId: doc.projectId,
    file: doc.file,
    sha256: doc.sha256,
    bytes: doc.bytes,
    content: doc.content
  })
}

const countRows = (projectId?: string): number => {
  const row = (
    projectId
      ? activeDb
          .prepare('SELECT COUNT(*) AS n FROM project_doc_revisions WHERE project_id = ?')
          .get(projectId)
      : activeDb.prepare('SELECT COUNT(*) AS n FROM project_doc_revisions').get()
  ) as { n: number }
  return row.n
}

describe('文档读时快照：仓储层语义', () => {
  let repo: Repo
  let pid: string

  beforeEach(() => {
    activeDb = new Database(':memory:')
    activeDb.pragma('foreign_keys = ON')
    runMigrations(activeDb)
    repo = new ProjectRepository()
    pid = repo.create({ name: '文档历史项目', docsDir }).id
  })

  it('迁移后版本为当前 DB_VERSION，快照表就绪', () => {
    expect(DB_VERSION).toBeGreaterThanOrEqual(49)
    const v = activeDb.prepare('SELECT MAX(version) AS v FROM _schema_version').get() as {
      v: number
    }
    expect(v.v).toBe(DB_VERSION)
    const cols = (
      activeDb.prepare('PRAGMA table_info(project_doc_revisions)').all() as Array<{ name: string }>
    ).map((c) => c.name)
    expect(cols).toEqual(
      expect.arrayContaining([
        'id',
        'project_id',
        'file',
        'seq',
        'sha256',
        'bytes',
        'body',
        'created_at'
      ])
    )
    expect(DOC_REVISION_LIMIT).toBe(20)
  })

  it('读一篇文档记一版；内容没变再读三次仍只有那一版', () => {
    writeDoc('a.md', '# A\n')
    readViaGui(repo, pid, 'a.md')
    readViaGui(repo, pid, 'a.md')
    readViaGui(repo, pid, 'a.md')

    const list = repo.listProjectDocRevisions(pid, 'a.md')
    expect(list.revisions).toHaveLength(1)
    expect(list.revisions[0]).toMatchObject({
      seq: 1,
      body: '# A\n',
      bytes: fs.statSync(path.join(docsDir, 'a.md')).size,
      isCurrent: true
    })
    expect(list.revisions[0].sha256).toBe(list.currentSha256)
    expect(countRows(pid)).toBe(1)
  })

  it('内容变了再读：倒序两版，正文与体积都能还原，当前那版标「当前」', () => {
    writeDoc('a.md', '# 第一版\n')
    readViaGui(repo, pid, 'a.md')
    writeDoc('a.md', '# 第一版\n\n这是新加的一行\n')
    readViaGui(repo, pid, 'a.md')

    const list = repo.listProjectDocRevisions(pid, 'a.md')
    expect(list.revisions.map((r) => [r.seq, r.body])).toEqual([
      [2, '# 第一版\n\n这是新加的一行\n'],
      [1, '# 第一版\n']
    ])
    expect(list.revisions.map((r) => r.isCurrent)).toEqual([true, false])
    expect(list.revisions.every((r) => !Number.isNaN(Date.parse(r.createdAt)))).toBe(true)
    expect(list).toMatchObject({ file: 'a.md', title: '第一版', kind: 'md' })
    expect(list.revisions[1].bytes).toBe(Buffer.byteLength('# 第一版\n'))
  })

  it('改回旧内容：按内容判定「当前」，不看时间先后（A → B → A 只有两版）', () => {
    writeDoc('a.md', 'A\n')
    readViaGui(repo, pid, 'a.md')
    writeDoc('a.md', 'B\n')
    readViaGui(repo, pid, 'a.md')
    writeDoc('a.md', 'A\n')
    readViaGui(repo, pid, 'a.md')

    const list = repo.listProjectDocRevisions(pid, 'a.md')
    expect(list.revisions.map((r) => [r.seq, r.body, r.isCurrent])).toEqual([
      [2, 'B\n', false],
      [1, 'A\n', true]
    ])
    expect(countRows(pid)).toBe(2)
  })

  it(`只留最近 ${DOC_REVISION_LIMIT} 版：超出删最旧，seq 不回收`, () => {
    for (let i = 1; i <= DOC_REVISION_LIMIT + 5; i++) {
      writeDoc('a.md', `内容 ${i}\n`)
      readViaGui(repo, pid, 'a.md')
    }
    const list = repo.listProjectDocRevisions(pid, 'a.md')
    expect(list.revisions).toHaveLength(DOC_REVISION_LIMIT)
    expect(list.revisions[0]).toMatchObject({ seq: DOC_REVISION_LIMIT + 5, body: `内容 ${DOC_REVISION_LIMIT + 5}\n` })
    expect(list.revisions[list.revisions.length - 1]).toMatchObject({ seq: 6, body: '内容 6\n' })
    expect(countRows(pid)).toBe(DOC_REVISION_LIMIT)
    // 被修剪掉的是最旧那几版，不是随机几版
    expect(list.revisions.some((r) => r.body.startsWith('内容 5'))).toBe(false)
  })

  it('seq 是每篇文档内的序号：两篇各从 1 开始，互不串', () => {
    writeDoc('a.md', 'A1\n')
    writeDoc('sub/b.md', 'B1\n')
    readViaGui(repo, pid, 'a.md')
    readViaGui(repo, pid, 'sub/b.md')
    writeDoc('a.md', 'A2\n')
    readViaGui(repo, pid, 'a.md')

    const a = repo.listProjectDocRevisions(pid, 'a.md')
    const b = repo.listProjectDocRevisions(pid, 'sub/b.md')
    expect(a.revisions.map((r) => [r.seq, r.body])).toEqual([
      [2, 'A2\n'],
      [1, 'A1\n']
    ])
    expect(b.revisions.map((r) => [r.seq, r.body])).toEqual([[1, 'B1\n']])
  })

  it('仓储的读不写库：只调 readProjectDoc（CLI `doc show` 走的就是它）一版都不留', () => {
    writeDoc('a.md', '# 只看不记\n')
    const doc = repo.readProjectDoc(pid, 'a.md')
    expect(doc.content).toBe('# 只看不记\n')
    expect(countRows()).toBe(0)
    // 历史接口本身也不写：它只读
    expect(repo.listProjectDocRevisions(pid, 'a.md').revisions).toEqual([])
    expect(countRows()).toBe(0)
  })

  it('文件不在了：历史接口按读取失败报错，不伪造一条空白版本', () => {
    writeDoc('gone.md', '有一版\n')
    readViaGui(repo, pid, 'gone.md')
    fs.rmSync(path.join(docsDir, 'gone.md'))
    expect(() => repo.listProjectDocRevisions(pid, 'gone.md')).toThrow(/找不到/)
    expect(countRows(pid)).toBe(1)
  })

  it('删项目一并清掉快照（外键关着也清得掉），回执逐表报数含 docRevisions', () => {
    const kept = repo.create({ name: '留着的项目', docsDir }).id
    writeDoc('a.md', 'A1\n')
    writeDoc('b.md', 'B1\n')
    writeDoc('c.md', 'C1\n')
    readViaGui(repo, pid, 'a.md')
    writeDoc('a.md', 'A2\n')
    readViaGui(repo, pid, 'a.md')
    readViaGui(repo, pid, 'b.md')
    readViaGui(repo, pid, 'c.md')
    readViaGui(repo, kept, 'a.md')
    expect(countRows(pid)).toBe(4)

    // 关掉外键：这样"清掉了"只可能来自显式删除，不是级联兜住的假象
    activeDb.pragma('foreign_keys = OFF')
    const result = repo.delete(pid, kept)
    expect(result.removed.docRevisions).toBe(4)
    const rows = activeDb
      .prepare('SELECT project_id, COUNT(*) AS n FROM project_doc_revisions GROUP BY project_id')
      .all() as Array<{ project_id: string; n: number }>
    expect(rows).toEqual([{ project_id: kept, n: 1 }])
  })
})

describe('文档读时快照：v48 → v49 老库副本迁移', () => {
  it('有数据的 v48 副本迁移后条数不变、新表就绪，且迁移本身不编造历史', async () => {
    // 1. 由真实迁移链建库并灌数据，再把本轮新增的表撤掉、版本回到 48 = 有数据的 v48 老库形状
    const seed = new Database(':memory:')
    activeDb = seed
    runMigrations(seed)
    new CategoryRepository().initializeDefaults()
    const repo = new ProjectRepository()
    const withDocs = repo.create({ name: '有文档目录的老项目', docsDir })
    const noDocs = repo.create({ name: '没关联目录的老项目' })
    const todo = new TodoRepository().create({
      title: '老库事项',
      description: '原描述',
      projectId: withDocs.id,
      status: 'suspended',
      skipGuards: true
    })

    seed.exec('DROP TABLE project_doc_revisions')
    seed.prepare('UPDATE _schema_version SET version = 48').run()
    const counts = (db: Database.Database) => ({
      projects: (db.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n,
      todos: (db.prepare('SELECT COUNT(*) AS n FROM todos').get() as { n: number }).n
    })
    const before = counts(seed)
    expect(before.todos).toBe(1)

    const copyPath = path.join(workDir, 'populated-v48-copy.db')
    await seed.backup(copyPath)
    seed.close()

    // 2. 只在副本上迁移
    activeDb = new Database(copyPath)
    activeDb.pragma('foreign_keys = ON')
    runMigrations(activeDb)
    const v = activeDb.prepare('SELECT MAX(version) AS v FROM _schema_version').get() as {
      v: number
    }
    expect(v.v).toBe(DB_VERSION)
    expect(counts(activeDb)).toEqual(before)
    const hasTable = activeDb
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='project_doc_revisions'")
      .get()
    expect(hasTable).toBeTruthy()
    expect(countRows()).toBe(0)
    const migrated = new ProjectRepository()
    expect(migrated.getById(withDocs.id)!.docsDir).toBe(docsDir)
    expect(migrated.getById(noDocs.id)!.docsDir ?? null).toBeNull()

    // 3. 迁移后照常记录与读取
    writeDoc('old.md', '迁移后的第一版\n')
    readViaGui(migrated, withDocs.id, 'old.md')
    writeDoc('old.md', '迁移后的第二版\n')
    readViaGui(migrated, withDocs.id, 'old.md')
    expect(
      migrated.listProjectDocRevisions(withDocs.id, 'old.md').revisions.map((r) => r.body)
    ).toEqual(['迁移后的第二版\n', '迁移后的第一版\n'])
    expect(todo.id).toBeTruthy()
  })
})
