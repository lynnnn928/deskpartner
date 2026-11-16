/**
 * 备份必须带上通知 / 附件 / 文档快照 / 协议修订四张表（卡 7c347b4b，评审第 7 条）
 *
 * ── 缺陷 ──
 * `backup.service.ts` 的表清单里没有 `notifications`、`todo_attachments`、
 * `project_doc_revisions`、`protocol_revisions`。换机恢复（导出 JSON → 清空 → 导入）之后：
 * 未读角标与通知历史全空、卡片上的附件行消失、项目文档的快照序列断掉、
 * 协议修订无从回溯 —— 而回执上一切"成功"。
 *
 * ── 这里钉住什么 ──
 * ① 导出确实带这四张表（结构与行都在）；
 * ② 清空后导入，四张表**逐行**一致（不是只看行数）；
 * ③ 旧格式备份（没有这四个键）照样能导入，且不会把这四张表写脏。
 *
 * ⚠️ 附件**行**随备份走，磁盘上的文件本体不随 JSON 走：`rel_path` 是相对数据目录的
 * 路径（`attachments/<todo_id>/<id><ext>`），换机导入后行指向的文件可能不存在。
 * 这条用例只保证"行没丢"，文件本体不在本条范围内。
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '../../../src/main/database/migrations'

const db = new Database(':memory:')
vi.mock('../../../src/main/database/index', () => ({
  getDatabase: () => db,
  // 导入前的原件备份依赖真实库文件；这里是 :memory:，拷不到就跳过（不阻断导入）
  getDatabasePath: () => '/fake/user-data/user.db'
}))

const { BackupService } = await import('../../../src/main/services/backup.service')
const { TodoRepository } = await import('../../../src/main/database/todo.repository')
const { CategoryRepository } = await import('../../../src/main/database/category.repository')
const { ProjectRepository } = await import('../../../src/main/database/project.repository')
const { MemoRepository } = await import('../../../src/main/database/memo.repository')
const { AgentRepository } = await import('../../../src/main/database/agent.repository')
const { SettingsRepository } = await import('../../../src/main/database/settings.repository')
const { ProtocolRepository } = await import('../../../src/main/database/protocol.repository')

/** JSON 里的键 → 表名。键名随导出结构走，表名随库走，两者都要对。 */
const FOUR_TABLES = {
  notifications: 'notifications',
  todoAttachments: 'todo_attachments',
  projectDocRevisions: 'project_doc_revisions',
  protocolRevisions: 'protocol_revisions'
} as const

describe('备份内容：通知 / 附件 / 文档快照 / 协议修订', () => {
  let backup: InstanceType<typeof BackupService>
  let todoRepo: InstanceType<typeof TodoRepository>
  let categoryRepo: InstanceType<typeof CategoryRepository>
  let projectRepo: InstanceType<typeof ProjectRepository>

  beforeAll(() => {
    runMigrations(db)
    todoRepo = new TodoRepository()
    categoryRepo = new CategoryRepository()
    projectRepo = new ProjectRepository()
    backup = new BackupService(
      todoRepo,
      categoryRepo,
      new SettingsRepository(),
      projectRepo,
      new MemoRepository(),
      new AgentRepository()
    )
    categoryRepo.initializeDefaults()
    // protocol_revisions 由仓储按需建表（迁移链里没有），先触发一次，后面才能直接写行
    new ProtocolRepository().save({ scope: 'global' }, 'handoff', '协议修订测试正文', 'human')
  })

  beforeEach(() => {
    wipe()
  })

  /**
   * 清空：模拟"换一台干净的机器"。
   * 顺序按外键：附件先于事项，文档快照先于项目。
   */
  function wipe(): void {
    db.exec(`
      DELETE FROM notifications;
      DELETE FROM todo_attachments;
      DELETE FROM project_doc_revisions;
      DELETE FROM protocol_revisions;
      DELETE FROM todo_comments;
      DELETE FROM todo_transitions;
      DELETE FROM todo_categories;
      DELETE FROM profile_revisions;
      DELETE FROM profile_proposals;
      DELETE FROM profile_blocks;
      DELETE FROM protocol_proposals;
      DELETE FROM protocol_blocks;
      DELETE FROM project_handoff_proposals;
      DELETE FROM project_handoff_revisions;
      DELETE FROM rule_revisions;
      DELETE FROM rule_proposals;
      DELETE FROM permission_matrix;
      DELETE FROM collaboration_rules;
      DELETE FROM agent_approval_events;
      DELETE FROM releases;
      DELETE FROM todos;
      DELETE FROM categories;
      DELETE FROM projects;
      DELETE FROM memos;
      DELETE FROM agent_grants;
      DELETE FROM agents;
    `)
    categoryRepo.initializeDefaults()
  }

  /** 造一份四张表都有真实行的数据 */
  function seed(): void {
    const project = projectRepo.create({ name: '四表备份项目' })
    const todo = todoRepo.create({ title: '带附件的事项', projectId: project.id })

    db.prepare(
      `INSERT INTO notifications
        (id, type, title, summary, ref_id, actor, status, meta, created_at, read_at, recipient, read_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'notif-1', 'reminder', '到期提醒', '换机别丢', todo.id, 'system', 'unread',
      JSON.stringify({ level: 'warn' }), '2026-11-16T00:00:00.000Z', null, 'human', ''
    )
    db.prepare(
      `INSERT INTO notifications
        (id, type, title, summary, ref_id, actor, status, meta, created_at, read_at, recipient, read_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'notif-2', 'decision', '已批准的提议', '读过的也要在', null, 'agent:bob', 'read',
      null, '2026-11-16T00:00:01.000Z', '2026-11-16T01:00:00.000Z', 'human', 'human'
    )

    // 附件只存元数据：rel_path 指向数据目录里的副本
    db.prepare(
      `INSERT INTO todo_attachments
        (id, todo_id, comment_id, seq, name, ext, kind, mime, bytes, sha256, rel_path, created_by, created_at)
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'att-1', todo.id, 1, '截图.png', '.png', 'image', 'image/png', 2048,
      'a'.repeat(64), `attachments/${todo.id}/att-1.png`, 'human', '2026-11-16T00:00:02.000Z'
    )
    db.prepare(
      `INSERT INTO todo_attachments
        (id, todo_id, comment_id, seq, name, ext, kind, mime, bytes, sha256, rel_path, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'att-2', todo.id, 'comment-x', 2, '日志.txt', '.txt', 'file', 'text/plain', 12,
      'b'.repeat(64), `attachments/${todo.id}/att-2.txt`, 'agent:bob', '2026-11-16T00:00:03.000Z'
    )

    db.prepare(
      `INSERT INTO project_doc_revisions
        (id, project_id, file, seq, sha256, bytes, body, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('docrev-1', project.id, 'plan.md', 1, 'c'.repeat(64), 18, '# 第一版计划\n', '2026-11-16T00:00:04.000Z')

    db.prepare(
      `INSERT INTO protocol_revisions
        (id, scope, project_id, block_key, body, confirmed, present, author, created_at)
       VALUES (?, 'global', NULL, ?, ?, ?, ?, ?, ?)`
    ).run('protorev-1', 'handoff', '旧协议正文', 1, 1, 'human', '2026-11-16T00:00:05.000Z')
  }

  const readRows = (table: string): Record<string, unknown>[] =>
    db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() as Record<string, unknown>[]

  it('导出把四张表一起带上（结构与行都在）', () => {
    seed()
    const parsed = JSON.parse(backup.exportData()) as {
      auxiliary?: Record<string, Record<string, unknown>[]>
    }
    const auxiliary = parsed.auxiliary ?? {}

    for (const key of Object.keys(FOUR_TABLES)) {
      expect(auxiliary[key], `导出缺少 auxiliary.${key}`).toBeDefined()
    }
    expect(auxiliary.notifications).toHaveLength(2)
    expect(auxiliary.todoAttachments).toHaveLength(2)
    expect(auxiliary.projectDocRevisions).toHaveLength(1)
    expect(auxiliary.protocolRevisions).toHaveLength(1)

    // 关键字段要原样在：附件靠 rel_path 找回文件，通知靠 status/read_by 决定未读角标
    expect(auxiliary.todoAttachments[0]).toMatchObject({
      id: 'att-1',
      rel_path: expect.stringContaining('/att-1.png'),
      kind: 'image',
      sha256: 'a'.repeat(64)
    })
    expect(auxiliary.notifications[1]).toMatchObject({ id: 'notif-2', status: 'read', read_by: 'human' })
    expect(auxiliary.projectDocRevisions[0]).toMatchObject({ file: 'plan.md', seq: 1, body: '# 第一版计划\n' })
    expect(auxiliary.protocolRevisions[0]).toMatchObject({ block_key: 'handoff', present: 1 })
  })

  it('清空 → 导入：四张表逐行一致', () => {
    seed()
    const before = Object.fromEntries(
      Object.values(FOUR_TABLES).map((table) => [table, readRows(table)])
    )
    const json = backup.exportData()
    wipe()
    for (const table of Object.values(FOUR_TABLES)) {
      expect(readRows(table), `${table} 没被清空，后面的导入断言是假的`).toHaveLength(0)
    }

    const result = backup.importData(json)

    for (const [key, table] of Object.entries(FOUR_TABLES)) {
      expect(readRows(table), `${table} 没有随备份回来`).toEqual(before[table])
      expect((result.detail as Record<string, number>)[key], `${table} 的回执明细不对`).toBe(
        before[table].length
      )
    }
    // 附件行回来了，所属事项也必须在（否则卡片上挂空气）
    expect(db.prepare('SELECT todo_id FROM todo_attachments WHERE id = ?').get('att-1')).toEqual({
      todo_id: (before.todo_attachments[0] as { todo_id: string }).todo_id
    })
  })

  it('旧格式备份（没有这四个键）仍然能导入，且不会把这四张表写脏', () => {
    seed()
    const legacy = JSON.parse(backup.exportData()) as {
      auxiliary?: Record<string, unknown>
      version: number
    }
    // 去掉四张表，还原成改动之前的备份形状
    for (const key of Object.keys(FOUR_TABLES)) delete legacy.auxiliary![key]

    wipe()
    const result = backup.importData(JSON.stringify(legacy))

    for (const [key, table] of Object.entries(FOUR_TABLES)) {
      expect(readRows(table), `${table} 在旧格式备份里没有数据，导入后应当仍为空`).toHaveLength(0)
      expect((result.detail as Record<string, number>)[key]).toBe(0)
    }
    // 旧备份的其余内容照常恢复：兼容性不能被这次改动破坏
    expect(todoRepo.list()).toHaveLength(1)
    expect(projectRepo.list()).toHaveLength(1)
  })
})
