import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runMigrations } from '../../../src/main/database/migrations'
import { DB_VERSION } from '../../../src/renderer/lib/constants'

/**
 * 接手说明修订历史（schema v35，36b44adb）
 *
 * 判据：每一版的「内容 + 作者 + 时间」都能还原；保存相同内容不写；
 * 只留最近 50 版；回滚留痕且不删中间版本；删项目级联清修订；
 * 迁移在**有数据的 v34 老库副本**上跑通、数据条数不变。
 */
let activeDb: Database.Database
vi.mock('../../../src/main/database/index', () => ({
  getDatabase: () => activeDb
}))

const { ProjectRepository, HANDOFF_REVISION_LIMIT, HANDOFF_BASELINE_AUTHOR, HANDOFF_DRIFT_AUTHOR } =
  await import('../../../src/main/database/project.repository')
const { TodoRepository } = await import('../../../src/main/database/todo.repository')
const { CommentRepository } = await import('../../../src/main/database/comment.repository')
const { CategoryRepository } = await import('../../../src/main/database/category.repository')

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-handoff-rev-'))
afterAll(() => {
  try {
    if (activeDb?.open) activeDb.close()
    fs.rmSync(workDir, { recursive: true, force: true })
  } catch {
    /* 临时目录清理失败不掩盖断言 */
  }
})

describe('接手说明修订：仓储层语义', () => {
  let repo: InstanceType<typeof ProjectRepository>
  let pid: string

  beforeEach(() => {
    activeDb = new Database(':memory:')
    activeDb.pragma('foreign_keys = ON')
    runMigrations(activeDb)
    repo = new ProjectRepository()
    pid = repo.create({ name: '修订测试项目' }).id
  })

  it('迁移后版本为当前 DB_VERSION 且修订表存在', () => {
    expect(DB_VERSION).toBeGreaterThanOrEqual(35)
    const v = activeDb.prepare('SELECT MAX(version) AS v FROM _schema_version').get() as { v: number }
    expect(v.v).toBe(DB_VERSION)
    const cols = (activeDb.prepare('PRAGMA table_info(project_handoff_revisions)').all() as Array<{ name: string }>).map(
      (c) => c.name
    )
    expect(cols).toEqual(
      expect.arrayContaining(['id', 'project_id', 'seq', 'body', 'author', 'kind', 'source_revision_id', 'source_seq', 'created_at'])
    )
  })

  it('每次内容有变化的保存留一版：全文 + 作者 + 时间 + 种类', () => {
    repo.saveHandoff(pid, '第一版', 'human')
    repo.saveHandoff(pid, '第二版', 'agent:alice')
    const revs = repo.listHandoffRevisions(pid)
    expect(revs.map((r) => [r.seq, r.body, r.author, r.kind])).toEqual([
      [2, '第二版', 'agent:alice', 'save'],
      [1, '第一版', 'human', 'save']
    ])
    expect(revs[0].isCurrent).toBe(true)
    expect(revs[1].isCurrent).toBe(false)
    expect(revs.every((r) => !Number.isNaN(Date.parse(r.createdAt)))).toBe(true)
    expect(repo.getById(pid)!.handoffMarkdown).toBe('第二版')
  })

  it('保存内容与当前完全相同：不写修订也不报错', () => {
    repo.saveHandoff(pid, 'A', 'human')
    const same = repo.saveHandoff(pid, 'A', 'agent:x')
    expect(same.changed).toBe(false)
    expect(same.revision).toBeNull()
    expect(repo.countHandoffRevisions(pid)).toBe(1)
    // 经 update() 入口同样去重
    repo.update({ id: pid, handoffMarkdown: 'A', actor: 'agent:x' })
    expect(repo.countHandoffRevisions(pid)).toBe(1)
  })

  it('update() 不带 handoffMarkdown 时不动说明也不写修订；带了则记 actor（缺省 human）', () => {
    repo.update({ id: pid, name: '改名' })
    expect(repo.countHandoffRevisions(pid)).toBe(0)
    repo.update({ id: pid, handoffMarkdown: 'via update' })
    repo.update({ id: pid, handoffMarkdown: 'via update 2', actor: 'agent:q' })
    expect(repo.listHandoffRevisions(pid).map((r) => r.author)).toEqual(['agent:q', 'human'])
  })

  it('清空说明也算一次保存（空串全文留一版）', () => {
    repo.saveHandoff(pid, '有内容')
    repo.saveHandoff(pid, '')
    expect(repo.listHandoffRevisions(pid).map((r) => r.body)).toEqual(['', '有内容'])
  })

  it('基线行：已有说明但没有任何修订行时首次保存，先把被覆盖的旧内容存成「迁移前」基线', () => {
    // 模拟修订历史上线前写入的说明：直接写列，不经仓储层
    activeDb.prepare('UPDATE projects SET handoff_markdown = ? WHERE id = ?').run('老说明（v34 时写的）', pid)
    expect(repo.countHandoffRevisions(pid)).toBe(0)

    repo.saveHandoff(pid, '新说明', 'agent:alice')
    const revs = repo.listHandoffRevisions(pid)
    expect(revs.map((r) => [r.seq, r.body, r.author])).toEqual([
      [2, '新说明', 'agent:alice'],
      [1, '老说明（v34 时写的）', HANDOFF_BASELINE_AUTHOR]
    ])
    expect(HANDOFF_BASELINE_AUTHOR).toBe('迁移前')
  })

  it('当前说明与最新一版对不上（绕开仓储层改过）：先补一条「未知来源」基线再写新版', () => {
    repo.saveHandoff(pid, 'v1', 'human')
    activeDb.prepare('UPDATE projects SET handoff_markdown = ? WHERE id = ?').run('被偷偷改过', pid)
    repo.saveHandoff(pid, 'v2', 'human')
    expect(repo.listHandoffRevisions(pid).map((r) => [r.body, r.author])).toEqual([
      ['v2', 'human'],
      ['被偷偷改过', HANDOFF_DRIFT_AUTHOR],
      ['v1', 'human']
    ])
  })

  it('带说明新建项目（备份导入）：第 1 版就是它', () => {
    const imported = repo.create({ name: '导入项目', handoffMarkdown: '导入的说明' })
    expect(repo.listHandoffRevisions(imported.id).map((r) => r.body)).toEqual(['导入的说明'])
    repo.saveHandoff(imported.id, '再改')
    expect(repo.countHandoffRevisions(imported.id)).toBe(2)
  })

  it('只保留最近 50 版：超出删最旧；seq 不回收，序号永远指同一版', () => {
    for (let i = 1; i <= HANDOFF_REVISION_LIMIT + 5; i++) repo.saveHandoff(pid, `内容 ${i}`, 'human')
    const revs = repo.listHandoffRevisions(pid)
    expect(revs).toHaveLength(HANDOFF_REVISION_LIMIT)
    expect(revs[0].seq).toBe(HANDOFF_REVISION_LIMIT + 5)
    expect(revs[revs.length - 1].seq).toBe(6)
    expect(repo.getHandoffRevision(pid, '#5')).toBeNull()
    expect(repo.getHandoffRevision(pid, '6')!.body).toBe('内容 6')
  })

  it('修剪同样适用于基线行：基线是最旧的一版，超出时先被淘汰', () => {
    activeDb.prepare('UPDATE projects SET handoff_markdown = ? WHERE id = ?').run('基线内容', pid)
    repo.saveHandoff(pid, 'c1') // 基线 seq1 + c1 seq2
    for (let i = 2; i <= HANDOFF_REVISION_LIMIT; i++) repo.saveHandoff(pid, `c${i}`) // 累计 51 版 → 基线被删
    const revs = repo.listHandoffRevisions(pid)
    expect(revs).toHaveLength(HANDOFF_REVISION_LIMIT)
    expect(revs.some((r) => r.body === '基线内容')).toBe(false)
    expect(revs[revs.length - 1].body).toBe('c1')
  })

  it('回滚 = 把旧版全文写成新的一次保存（kind=rollback、记来源版），不删任何中间版本', () => {
    repo.saveHandoff(pid, 'v1', 'human')
    repo.saveHandoff(pid, 'v2', 'human')
    repo.saveHandoff(pid, 'v3', 'human')
    const result = repo.rollbackHandoff(pid, '1', 'agent:alice')
    expect(result.changed).toBe(true)
    expect(result.project.handoffMarkdown).toBe('v1')
    expect(result.revision).toMatchObject({
      seq: 4,
      kind: 'rollback',
      body: 'v1',
      author: 'agent:alice',
      sourceSeq: 1
    })
    const revs = repo.listHandoffRevisions(pid)
    expect(revs.map((r) => r.seq)).toEqual([4, 3, 2, 1]) // 中间版本全在
    expect(revs[0].sourceRevisionId).toBe(repo.getHandoffRevision(pid, '1')!.id)
    // 回滚错了还能再回滚回来
    repo.rollbackHandoff(pid, '3')
    expect(repo.getById(pid)!.handoffMarkdown).toBe('v3')
    expect(repo.countHandoffRevisions(pid)).toBe(5)
  })

  it('回滚到内容已等于当前的版本：不写新修订（changed=false）', () => {
    repo.saveHandoff(pid, 'v1')
    repo.saveHandoff(pid, 'v2')
    repo.saveHandoff(pid, 'v1') // seq3 内容同 seq1
    const r = repo.rollbackHandoff(pid, '1')
    expect(r.changed).toBe(false)
    expect(repo.countHandoffRevisions(pid)).toBe(3)
  })

  it('修订引用：序号 / #序号 / 修订 id / id 前缀；不存在给出现有序号', () => {
    repo.saveHandoff(pid, 'a')
    repo.saveHandoff(pid, 'b')
    const first = repo.getHandoffRevision(pid, '1')!
    expect(repo.getHandoffRevision(pid, '#1')!.id).toBe(first.id)
    expect(repo.getHandoffRevision(pid, first.id)!.id).toBe(first.id)
    expect(repo.getHandoffRevision(pid, first.id.slice(0, 8))!.id).toBe(first.id)
    expect(repo.getHandoffRevision(pid, '99')).toBeNull()
    expect(() => repo.rollbackHandoff(pid, '99')).toThrow(/现有序号：#2 #1/)
    // 百分号不是通配符
    expect(repo.getHandoffRevision(pid, '%')).toBeNull()
  })

  it('修订不跨项目：别的项目的修订 id 在本项目取不到', () => {
    const other = repo.create({ name: '另一个项目' }).id
    repo.saveHandoff(other, '别人的说明')
    const foreign = repo.getHandoffRevision(other, '1')!
    expect(repo.getHandoffRevision(pid, foreign.id)).toBeNull()
    expect(() => repo.rollbackHandoff(pid, foreign.id)).toThrow()
  })

  it('摘要列表不含全文，只有长度与首行预览；limit 生效', () => {
    repo.saveHandoff(pid, '\n\n# 标题行\n正文第二行')
    repo.saveHandoff(pid, 'x'.repeat(100))
    const [latest, older] = repo.listHandoffRevisionSummaries(pid)
    expect(latest).not.toHaveProperty('body')
    expect(latest.length).toBe(100)
    expect(latest.preview).toBe(`${'x'.repeat(60)}…`)
    expect(older.preview).toBe('# 标题行')
    expect(repo.listHandoffRevisionSummaries(pid, 1)).toHaveLength(1)
  })

  it('getDetail 带 handoffRevisionCount', () => {
    expect(repo.getDetail(pid)!.handoffRevisionCount).toBe(0)
    repo.saveHandoff(pid, 'a')
    repo.saveHandoff(pid, 'b')
    expect(repo.getDetail(pid)!.handoffRevisionCount).toBe(2)
  })

  it('提交基准修订过期时拒绝覆盖，并保留当前正文与历史', () => {
    repo.saveHandoff(pid, 'v1', 'human')
    const currentSeq = repo.listHandoffRevisions(pid)[0].seq
    repo.saveHandoff(pid, 'v2', 'human')
    expect(() => repo.saveHandoff(pid, 'agent stale', 'agent:stale', currentSeq)).toThrow(/已发生变化/)
    expect(repo.getById(pid)?.handoffMarkdown).toBe('v2')
    expect(repo.listHandoffRevisions(pid).map((revision) => revision.body)).toEqual(['v2', 'v1'])
  })

  it('接手说明提议保存原文和基准，采纳后写入修订并可查历史', () => {
    repo.saveHandoff(pid, '用户当前说明', 'human')
    const baseRevision = repo.listHandoffRevisions(pid)[0].seq
    const proposal = repo.proposeHandoff(pid, 'Agent 草稿', 'agent:alice')

    expect(proposal).toMatchObject({
      projectId: pid,
      body: 'Agent 草稿',
      originalBody: '用户当前说明',
      baseRevision,
      proposer: 'agent:alice',
      status: 'pending'
    })
    expect(repo.getById(pid)?.handoffMarkdown).toBe('用户当前说明')
    expect(repo.listHandoffProposals()).toMatchObject([{ id: proposal.id, stale: false, currentBody: '用户当前说明' }])

    const decided = repo.decideHandoffProposal(proposal.id, 'approved', 'human', '人工修订后采纳')
    expect(decided).toMatchObject({ status: 'approved', decidedBy: 'human', decidedBody: '人工修订后采纳' })
    expect(repo.getById(pid)?.handoffMarkdown).toBe('人工修订后采纳')
    expect(repo.listHandoffRevisions(pid)[0]).toMatchObject({ body: '人工修订后采纳', author: 'human', kind: 'save' })
    expect(repo.listHandoffProposals('all')).toHaveLength(1)
    expect(repo.listHandoffProposals()).toHaveLength(0)
    expect(() => repo.decideHandoffProposal(proposal.id, 'approved', 'human')).toThrow(/处理过/)
  })

  it('接手说明提议后内容变化时标记过期并拒绝采纳', () => {
    repo.saveHandoff(pid, '提议前', 'human')
    const proposal = repo.proposeHandoff(pid, 'Agent 草稿', 'agent:alice')
    repo.saveHandoff(pid, '用户后来保存', 'human')

    expect(repo.listHandoffProposals()[0]).toMatchObject({ id: proposal.id, stale: true, currentBody: '用户后来保存' })
    expect(() => repo.decideHandoffProposal(proposal.id, 'approved', 'human')).toThrow(/已发生变化/)
    expect(repo.listHandoffProposals()[0].status).toBe('pending')
    expect(repo.getById(pid)?.handoffMarkdown).toBe('用户后来保存')
  })

  it('拒绝接手说明提议只留决定记录，不改当前正文', () => {
    repo.saveHandoff(pid, '保留这版', 'human')
    const proposal = repo.proposeHandoff(pid, '不采纳的版本', 'agent:alice')
    const decided = repo.decideHandoffProposal(proposal.id, 'rejected', 'human')
    expect(decided).toMatchObject({ status: 'rejected', decidedBy: 'human', decidedBody: null })
    expect(repo.getById(pid)?.handoffMarkdown).toBe('保留这版')
    expect(repo.listHandoffProposals()).toHaveLength(0)
    expect(repo.listHandoffProposals('all')).toHaveLength(1)
  })

  it('保存失败（项目不存在）不留半截修订', () => {
    expect(() => repo.saveHandoff('不存在的项目', 'x')).toThrow(/项目不存在/)
    const n = activeDb.prepare('SELECT COUNT(*) AS n FROM project_handoff_revisions').get() as { n: number }
    expect(n.n).toBe(0)
  })

  it('删项目级联清掉修订（FK ON DELETE CASCADE）', () => {
    const other = repo.create({ name: '保留项目' }).id
    repo.saveHandoff(pid, 'a')
    repo.saveHandoff(pid, 'b')
    repo.saveHandoff(other, 'keep')
    repo.delete(pid, other)
    const rows = activeDb
      .prepare('SELECT project_id, COUNT(*) AS n FROM project_handoff_revisions GROUP BY project_id')
      .all() as Array<{ project_id: string; n: number }>
    expect(rows).toEqual([{ project_id: other, n: 1 }])
  })
})

describe('接手说明修订：v34 → v35 老库副本迁移', () => {
  it('有数据的 v34 副本迁移后条数不变、handoff_markdown 不丢、新表就绪，并能照常保存/回滚', async () => {
    // 1. 由真实迁移链建库并灌数据，再把本轮新增的表撤掉、版本回到 34 = 有数据的 v34 老库形状
    const seed = new Database(':memory:')
    activeDb = seed
    runMigrations(seed)
    new CategoryRepository().initializeDefaults()
    const repo = new ProjectRepository()
    const withDoc = repo.create({ name: '有接手说明的老项目' })
    const empty = repo.create({ name: '没有说明的老项目' })
    // 老库里 handoff_markdown 就是直接写列（v34 没有修订表）
    seed.prepare('UPDATE projects SET handoff_markdown = ? WHERE id = ?').run('# 老接手说明\n\n不能丢', withDoc.id)
    const todo = new TodoRepository().create({
      title: '老库事项',
      description: '原描述',
      projectId: withDoc.id,
      status: 'suspended',
      skipGuards: true
    })
    new CommentRepository().create({ todoId: todo.id, body: '老评论', authorType: 'agent', authorId: 'agent:old' })

    seed.exec('DROP TABLE cli_reminder_receipts; DROP TABLE project_handoff_revisions')
    seed.prepare('UPDATE _schema_version SET version = 34').run()
    const counts = (db: Database.Database) => ({
      projects: (db.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n,
      todos: (db.prepare('SELECT COUNT(*) AS n FROM todos').get() as { n: number }).n,
      comments: (db.prepare('SELECT COUNT(*) AS n FROM todo_comments').get() as { n: number }).n
    })
    const before = counts(seed)
    // 迁移链自带一个默认项目，所以只断言「至少有我们灌的 2 个」，迁移前后相等才是判据
    expect(before.projects).toBeGreaterThanOrEqual(2)
    expect(before.todos).toBe(1)
    expect(before.comments).toBe(1)

    const copyPath = path.join(workDir, 'populated-v34-copy.db')
    await seed.backup(copyPath)
    seed.close()

    // 2. 只在副本上迁移
    activeDb = new Database(copyPath)
    activeDb.pragma('foreign_keys = ON')
    runMigrations(activeDb)
    const v = activeDb.prepare('SELECT MAX(version) AS v FROM _schema_version').get() as { v: number }
    expect(v.v).toBe(DB_VERSION)
    expect(counts(activeDb)).toEqual(before)
    const hasTable = activeDb
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='project_handoff_revisions'")
      .get()
    expect(hasTable).toBeTruthy()
    const migrated = new ProjectRepository()
    expect(migrated.getById(withDoc.id)!.handoffMarkdown).toBe('# 老接手说明\n\n不能丢')
    expect(migrated.getById(empty.id)!.handoffMarkdown).toBe('')
    // 迁移本身不写修订（不编造历史）
    expect(migrated.countHandoffRevisions(withDoc.id)).toBe(0)

    // 3. 迁移后首次保存：被覆盖的老说明留成基线，可回滚找回
    migrated.saveHandoff(withDoc.id, '误写覆盖', 'agent:alice')
    expect(migrated.listHandoffRevisions(withDoc.id).map((r) => [r.body, r.author])).toEqual([
      ['误写覆盖', 'agent:alice'],
      ['# 老接手说明\n\n不能丢', HANDOFF_BASELINE_AUTHOR]
    ])
    migrated.rollbackHandoff(withDoc.id, '1', 'human')
    expect(migrated.getById(withDoc.id)!.handoffMarkdown).toBe('# 老接手说明\n\n不能丢')
  })
})
