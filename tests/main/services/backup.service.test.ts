import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { runMigrations } from '../../../src/main/database/migrations'

const db = new Database(':memory:')
vi.mock('../../../src/main/database/index', () => ({
  getDatabase: () => db,
  /**
   * 导入前备份要拿库文件路径（1.0.46）。
   * 测试里给一个固定的假路径：真实路径依赖 electron 的 app.getPath，
   * 而这里的整套测试都在 :memory: 上跑，没有磁盘文件可拷 ——
   * 所以需要真落盘的用例自行 spy copyFileSync。
   */
  getDatabasePath: () => '/fake/user-data/user.db'
}))

let seq = 0
vi.mock('uuid', () => ({ v4: () => `bk-uuid-${++seq}` }))

/**
 * 备份导入为什么必须单独测
 *
 * 这里出过一次"静默丢数据"：导入时分类 ID 映射表算出来的值
 * 与库里真实的分类 id 毫无关系（create 不接受 id，内部另生成一个），
 * 于是带标签的待办全部撞外键失败、被 catch 吞掉 ——
 * 界面只显示一个 skipped 数字，人不知道自己一半数据没进来。
 *
 * 这类问题 tsc 抓不到、repository 单测也走不到，
 * 只有真的"导出 → 清空 → 导入 → 逐字段比对"才暴露得出来。
 */
const { BackupService } = await import('../../../src/main/services/backup.service')
const { TodoRepository } = await import('../../../src/main/database/todo.repository')
const { CategoryRepository } = await import('../../../src/main/database/category.repository')
const { ProjectRepository } = await import('../../../src/main/database/project.repository')
const { MemoRepository } = await import('../../../src/main/database/memo.repository')
const { AgentRepository } = await import('../../../src/main/database/agent.repository')
const { SettingsRepository } = await import('../../../src/main/database/settings.repository')

describe('BackupService 导入', () => {
  let backup: InstanceType<typeof BackupService>
  let todoRepo: InstanceType<typeof TodoRepository>
  let categoryRepo: InstanceType<typeof CategoryRepository>
  let projectRepo: InstanceType<typeof ProjectRepository>
  let memoRepo: InstanceType<typeof MemoRepository>
  let agentRepo: InstanceType<typeof AgentRepository>
  let settingsRepo: InstanceType<typeof SettingsRepository>

  beforeAll(() => {
    runMigrations(db)
    todoRepo = new TodoRepository()
    categoryRepo = new CategoryRepository()
    projectRepo = new ProjectRepository()
    memoRepo = new MemoRepository()
    agentRepo = new AgentRepository()
    settingsRepo = new SettingsRepository()
    backup = new BackupService(
      todoRepo,
      categoryRepo,
      settingsRepo,
      projectRepo,
      memoRepo,
      agentRepo
    )
  })

  beforeEach(() => {
    db.exec(`
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
      DELETE FROM settings;
    `)
    /**
     * 补上默认分类 —— 真实库里 `initializeDefaults()` 在启动时就会写这 4 条，
     * 而 `todoRepo.create()` 在"一个分类都没有"时会直接抛错。
     * 测试若不补，会造出一个真实环境里不存在的"零分类"状态。
     */
    categoryRepo.initializeDefaults()
  })

  it('带标签的待办能完整回来（导出 → 清空 → 导入）', () => {
    const a = categoryRepo.create({ name: '方向', color: '#111111', sortOrder: 0 })
    const b = categoryRepo.create({ name: '待修', color: '#222222', sortOrder: 1 })
    const p = projectRepo.create({ name: '备份项目' })

    todoRepo.create({
      title: '带两个标签的待办',
      categoryIds: [a.id, b.id],
      projectId: p.id
    })
    todoRepo.create({ title: '不带标签的待办', projectId: p.id })

    const json = backup.exportData()

    // 清空后重新导入：这一步才真正检验 id 映射
    db.exec(`
      DELETE FROM todo_comments;
      DELETE FROM todo_transitions;
      DELETE FROM todo_categories;
      DELETE FROM todos;
      DELETE FROM categories;
    `)

    const result = backup.importData(json)

    const imported = todoRepo.list()
    expect(imported).toHaveLength(2)

    const withTags = imported.find((t) => t.title === '带两个标签的待办')!
    expect(withTags).toBeDefined()
    // 核心断言：标签必须在，且一个都不少
    expect(withTags.categoryIds).toHaveLength(2)
    expect(new Set(withTags.categoryIds)).toEqual(new Set([a.id, b.id]))
    // 一条待办都没被静默跳过（分类"已存在"计入 skipped 属正常，见下）
    expect(result.detail?.todos).toBe(2)
    expect(result.skippedItems?.filter((s) => s.kind === '待办') ?? []).toHaveLength(0)
  })

  it('标签顺序在批量映射后不漂移（categoryId 取第一个）', () => {
    const a = categoryRepo.create({ name: '一', color: '#111111', sortOrder: 0 })
    const b = categoryRepo.create({ name: '二', color: '#222222', sortOrder: 1 })
    const p = projectRepo.create({ name: '顺序项目' })
    const todo = todoRepo.create({
      title: '顺序', categoryIds: [a.id, b.id], projectId: p.id
    })

    // 单行查询与批量 list 必须给出同一个顺序，否则 categoryId 会漂移
    const single = todoRepo.getById(todo.id)!
    const batched = todoRepo.list().find((t) => t.id === todo.id)!
    expect(batched.categoryIds).toEqual(single.categoryIds)
    expect(batched.categoryId).toBe(single.categoryId)
  })

  it('残缺的设置不会把字段写成字符串 undefined', () => {
    // 模拟老版本备份：settings 缺字段、类型不对、还混进不认识的键
    const partial = JSON.stringify({
      version: 1,
      exportedAt: new Date().toISOString(),
      todos: [],
      categories: [],
      settings: { theme: 'dark', floatBallSize: '不是数字', 不认识的键: 'x' }
    })

    backup.importData(partial)

    // 库里不该出现字符串 "undefined"
    const raw = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[]
    for (const row of raw) {
      expect(row.value).not.toBe('undefined')
    }
    // 类型不对的整项丢弃：悬浮球尺寸读回来必须还能算，不能是 NaN
    const s = settingsRepo.get()
    expect(Number.isNaN(s.floatBallSize)).toBe(false)
    // 主题是合法值，应当被接受
    expect(s.theme).toBe('dark')
  })

  it('系统级设置不随备份导入，且要能报出来', () => {
    const result = settingsRepo.importFrom({
      autoStart: true,
      globalShortcut: 'Ctrl+Alt+X',
      theme: 'dark'
    })

    expect(result.accepted).toContain('theme')
    expect(result.accepted).not.toContain('autoStart')
    expect(result.accepted).not.toContain('globalShortcut')
    // 丢掉的必须能报出来 —— 静默吞掉正是"导入坏得没声音"的成因
    expect(result.rejected.map((r) => r.key)).toEqual(
      expect.arrayContaining(['autoStart', 'globalShortcut'])
    )
    expect(result.rejected.every((r) => r.why.length > 0)).toBe(true)
  })

  it('非对象 / 数组的设置整体忽略，不写脏数据', () => {
    const r1 = settingsRepo.importFrom('not an object')
    expect(r1.accepted).toHaveLength(0)
    expect(r1.rejected).toHaveLength(1)

    const r2 = settingsRepo.importFrom([1, 2, 3])
    expect(r2.accepted).toHaveLength(0)
    expect(r2.rejected).toHaveLength(1)
  })
})

/**
 * v2 导出/导入（1.0.46）
 *
 * Bob 2026-09-22 演练暴露的整套问题都在这组用例里：
 * 导出漏三张表、导入只恢复三个字段、id 每导一次换一遍、
 * agent 恢复后全部变未批准、以及回执只说"成功"。
 *
 * 每条用例对应一个**曾经真实发生过**的失效，不做泛泛的"字段完整性"检查。
 */
describe('BackupService v2 导出导入', () => {
  let backup: InstanceType<typeof BackupService>
  let todoRepo: InstanceType<typeof TodoRepository>
  let categoryRepo: InstanceType<typeof CategoryRepository>
  let projectRepo: InstanceType<typeof ProjectRepository>
  let memoRepo: InstanceType<typeof MemoRepository>
  let agentRepo: InstanceType<typeof AgentRepository>
  let settingsRepo: InstanceType<typeof SettingsRepository>

  beforeAll(() => {
    todoRepo = new TodoRepository()
    categoryRepo = new CategoryRepository()
    projectRepo = new ProjectRepository()
    memoRepo = new MemoRepository()
    agentRepo = new AgentRepository()
    settingsRepo = new SettingsRepository()
    backup = new BackupService(
      todoRepo,
      categoryRepo,
      settingsRepo,
      projectRepo,
      memoRepo,
      agentRepo
    )
  })

  beforeEach(() => {
    db.exec(`
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
      DELETE FROM settings;
    `)
    /**
     * 补上默认分类 —— 真实库里 `initializeDefaults()` 在启动时就会写这 4 条，
     * 而 `todoRepo.create()` 在"一个分类都没有"时会直接抛错。
     * 测试若不补，会造出一个真实环境里不存在的"零分类"状态。
     */
    categoryRepo.initializeDefaults()
  })

  /**
   * 清掉除 settings 外的所有业务数据，模拟"换一台干净的机器恢复"
   *
   * 默认分类要补回来：真实库启动时 `initializeDefaults()` 就会写这 4 条，
   * 清空后不补会造出"零分类"状态 —— 那个状态下待办根本建不出来，
   * 测出来的失败与导入逻辑无关。
   */
  function wipeAll(): void {
    db.exec(`
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

  it('导出带上 projects / agents / memos / comments / transitions（v3 格式）', () => {
    const project = projectRepo.create({ name: '导出项目', color: '#334455' })
    agentRepo.register({ id: 'agent:bob', displayName: 'Bob', color: '#7F77DD' })
    memoRepo.create({ author: 'agent:bob', text: '一条备忘' })
    const todo = todoRepo.create({ title: '带交接材料的事项', projectId: project.id })
    const comment = db
      .prepare(
        `INSERT INTO todo_comments
          (id, todo_id, parent_id, author_type, author_id, body, kind, created_at, recipient)
         VALUES (?, ?, NULL, 'agent', ?, ?, 'comment', ?, NULL)`
      )
      .run('comment-export-1', todo.id, 'agent:bob', '决定保留这条记录', '2026-10-14T00:00:00.000Z')
    expect(comment.changes).toBe(1)
    db.prepare(
      `INSERT INTO todo_transitions
        (id, todo_id, from_status, to_status, actor, created_at, is_rejection)
       VALUES (?, ?, NULL, 'todo', ?, ?, 0)`
    ).run('transition-export-1', todo.id, 'agent:bob', '2026-10-14T00:00:01.000Z')

    const parsed = JSON.parse(backup.exportData()) as Record<string, unknown>

    expect(parsed.version).toBe(5)
    expect(parsed.projects).toHaveLength(1)
    expect(parsed.agents).toHaveLength(1)
    expect(parsed.memos).toHaveLength(1)
    expect(parsed.comments).toEqual([
      expect.objectContaining({ id: 'comment-export-1', todoId: todo.id, body: '决定保留这条记录' })
    ])
    expect(parsed.transitions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'transition-export-1', todoId: todo.id, toStatus: 'todo' })
      ])
    )
  })

  it('评论和流转随事项往返，供新 agent 找回历史决定', () => {
    const project = projectRepo.create({ name: '交接往返项目' })
    const todo = todoRepo.create({ title: '有历史的事项', projectId: project.id })
    db.prepare(
      `INSERT INTO todo_comments
        (id, todo_id, parent_id, author_type, author_id, body, kind, created_at, recipient)
       VALUES (?, ?, NULL, 'human', 'human', ?, 'comment', ?, NULL)`
    ).run('comment-roundtrip-1', todo.id, '原始决定：暂不删除', '2026-10-14T00:00:00.000Z')
    db.prepare(
      `INSERT INTO todo_transitions
        (id, todo_id, from_status, to_status, actor, created_at, is_rejection)
       VALUES (?, ?, NULL, 'todo', 'human', ?, NULL)`
    ).run('transition-roundtrip-1', todo.id, '2026-10-14T00:00:01.000Z')

    const json = backup.exportData()
    wipeAll()
    db.exec('DELETE FROM todo_comments; DELETE FROM todo_transitions;')
    const result = backup.importData(json)

    expect(result.detail?.comments).toBeGreaterThanOrEqual(1)
    expect(result.detail?.transitions).toBeGreaterThanOrEqual(1)
    expect(db.prepare('SELECT body FROM todo_comments WHERE id = ?').get('comment-roundtrip-1')).toEqual({
      body: '原始决定：暂不删除'
    })
    expect(db.prepare('SELECT to_status, is_rejection FROM todo_transitions WHERE id = ?').get('transition-roundtrip-1')).toEqual({
      to_status: 'todo',
      is_rejection: null
    })
  })

  it('项目接手说明随现有 JSON 项目记录往返', () => {
    const markdown = '# 目标与入口\n\n关键决定出处：`docs/decisions.md`。\n'
    const project = projectRepo.create({ name: '有接手说明的项目', handoffMarkdown: markdown })
    const json = backup.exportData()
    const exported = JSON.parse(json) as { projects: Array<{ id: string; handoffMarkdown: string }> }
    expect(exported.projects.find((p) => p.id === project.id)?.handoffMarkdown).toBe(markdown)

    wipeAll()
    backup.importData(json)
    expect(projectRepo.getById(project.id)?.handoffMarkdown).toBe(markdown)
  })

  it('导出的 agent 不含凭据哈希 —— 备份文件不该带认证材料', () => {
    agentRepo.register({ id: 'agent:bob', displayName: 'Bob' })
    agentRepo.issueCredential('agent:bob')

    const raw = backup.exportData()
    const parsed = JSON.parse(raw) as { agents: Record<string, unknown>[] }

    expect(parsed.agents[0]).not.toHaveProperty('credentialHash')
    // 连"哈希"这个词都不该出现在文件里
    expect(raw.toLowerCase()).not.toContain('credentialhash')
  })

  it('待办的字段逐个还原，不再只剩标题', () => {
    const p = projectRepo.create({ name: '项目甲' })
    const c = categoryRepo.create({ name: '方向', color: '#aa0000', sortOrder: 0 })
    const created = todoRepo.create({
      title: '带全字段的待办',
      description: '这是描述',
      projectId: p.id,
      categoryIds: [c.id],
      status: 'in_progress',
      priority: 'high',
      type: 'bug',
      createdBy: 'agent:bob',
      executedBy: 'human',
      dueAt: '2026-10-01T00:00:00.000Z',
      remindAt: '2026-09-30T09:00:00.000Z',
      isPinned: true
    })

    const json = backup.exportData()
    wipeAll()
    backup.importData(json)

    const back = todoRepo.getById(created.id)!
    expect(back).toBeDefined()
    // 这几项此前**全都没传**，是"导入后只剩标题"的根因
    expect(back.description).toBe('这是描述')
    expect(back.projectId).toBe(p.id)
    expect(back.status).toBe('in_progress')
    expect(back.priority).toBe('high')
    expect(back.type).toBe('bug')
    expect(back.createdBy).toBe('agent:bob')
    expect(back.executedBy).toBe('human')
    expect(back.dueAt).toBe('2026-10-01T00:00:00.000Z')
    expect(back.remindAt).toBe('2026-09-30T09:00:00.000Z')
    expect(back.isPinned).toBe(true)
    expect(back.categoryIds).toEqual([c.id])
  })

  it('id 与时间戳原样保住 —— 导入还原的是"那一刻的库"', () => {
    const created = todoRepo.create({ title: '原始时间戳' })

    const json = backup.exportData()
    wipeAll()
    backup.importData(json)

    const back = todoRepo.getById(created.id)!
    // id 保住：不保住的话 parentId / 授权目标 / 人记下的编号全断
    expect(back.id).toBe(created.id)
    // 时间戳保住：否则整批数据的"创建时间"都变成导入那一刻
    expect(back.createdAt).toBe(created.createdAt)
    expect(back.updatedAt).toBe(created.updatedAt)
  })

  it('重复导入同一份备份不会翻倍（id 冲突检测真的生效）', () => {
    todoRepo.create({ title: '甲' })
    todoRepo.create({ title: '乙' })

    const json = backup.exportData()
    wipeAll()

    const first = backup.importData(json)
    expect(first.detail?.todos).toBe(2)
    expect(todoRepo.list()).toHaveLength(2)

    // 再导一次：这一条才是真正检验 id 保真的用例 ——
    // 此前 id 每导一次重生成，冲突检测永远命中不了，204 会变 408
    const second = backup.importData(json)
    expect(second.detail?.todos).toBe(0)
    // 所有导出条目都已存在，包含 v4 协作上下文表，均应计入 skipped。
    const exported = JSON.parse(json) as { todos: unknown[]; categories: unknown[]; transitions?: unknown[]; auxiliary?: Record<string, unknown[]> }
    const exportedCount = exported.todos.length + exported.categories.length + (exported.transitions?.length ?? 0) +
      Object.values(exported.auxiliary ?? {}).reduce((sum, rows) => sum + rows.length, 0)
    expect(second.imported).toBe(0)
    expect(second.skipped).toBe(exportedCount)
    expect(todoRepo.list()).toHaveLength(2)
    // 跳过原因要说清楚，不能只给个数字
    expect(second.skippedItems?.every((s) => s.why.length > 0)).toBe(true)
  })

  it('子任务在父任务之后落库（父先子后，不吃 G1）', () => {
    const parent = todoRepo.create({ title: '父需求' })
    todoRepo.create({ title: '子任务', parentId: parent.id })
    todoRepo.create({ title: '孙任务', parentId: parent.id })

    const json = backup.exportData()
    // 故意把子任务排到前面：备份里的顺序不该决定能否导入
    const parsed = JSON.parse(json) as { todos: unknown[] }
    parsed.todos.reverse()

    wipeAll()
    const result = backup.importData(JSON.stringify(parsed))

    expect(result.detail?.todos).toBe(3)
    // 三条待办全部进来（分类"已存在"计入 skipped 属正常）
    expect(result.skippedItems?.filter((s) => s.kind === '待办') ?? []).toHaveLength(0)
    const child = todoRepo.list().find((t) => t.title === '子任务')!
    expect(child.parentId).toBe(parent.id)
  })

  it('父需求停在 proposed 时子任务照样能导入（历史数据不重审）', () => {
    const parent = todoRepo.create({ title: '还没拍板的父需求', status: 'proposed' })
    // 造这条子任务时本身就得绕开 G1（否则来源库都建不出来）——
    // 它代表的是"父需求后来被退回 proposed"这种真实历史状态
    const child = todoRepo.create({ title: '子任务', parentId: parent.id, skipGuards: true })

    const json = backup.exportData()
    wipeAll()
    const result = backup.importData(json)

    // 若 G1 在导入时生效，这里会被拦成 skipped —— 而这是**已经存在过**的数据
    expect(result.detail?.todos).toBe(2)
    expect(result.skippedItems?.filter((s) => s.kind === '待办') ?? []).toHaveLength(0)
    expect(todoRepo.getById(child.id)).toBeDefined()
  })

  it('agent 身份恢复后保留批准状态（不用人重点一遍）', () => {
    agentRepo.register({ id: 'agent:a', displayName: '甲' })
    agentRepo.register({ id: 'agent:b', displayName: '乙' })
    agentRepo.setApproved('agent:a', true)

    const json = backup.exportData()
    wipeAll()
    backup.importData(json)

    expect(agentRepo.get('agent:a')?.approved).toBe(true)
    // 没批准过的保持没批准 —— 恢复不能顺手扩权
    expect(agentRepo.get('agent:b')?.approved).toBe(false)
  })

  it('agent 的注册时间被还原（列表先后顺序不失真）', () => {
    const early = agentRepo.register({ id: 'agent:early', displayName: '先来的' })
    agentRepo.register({ id: 'agent:late', displayName: '后来的' })

    const json = backup.exportData()
    wipeAll()
    backup.importData(json)

    expect(agentRepo.get('agent:early')?.createdAt).toBe(early.createdAt)
    expect(agentRepo.list()[0].id).toBe('agent:early')
  })

  it('备忘的状态与阅读时间被还原', () => {
    const memo = memoRepo.create({ author: 'human', text: '看过的那条' })
    memoRepo.ack(memo.id, 'human')
    const read = memoRepo.get(memo.id)!

    const json = backup.exportData()
    wipeAll()
    backup.importData(json)

    const back = memoRepo.get(memo.id)!
    expect(back.status).toBe('read')
    expect(back.readAt).toBe(read.readAt)
  })

  it('备忘指向已不存在的待办时置空，不留死引用', () => {
    const json = JSON.stringify({
      version: 2,
      exportedAt: new Date().toISOString(),
      todos: [],
      categories: [],
      settings: {},
      memos: [
        {
          id: 'memo-1',
          author: 'human',
          text: '指向幽灵待办',
          linkedTodoId: 'todo-不存在',
          status: 'unread',
          createdAt: new Date().toISOString(),
          readAt: null
        }
      ]
    })

    backup.importData(json)

    expect(memoRepo.get('memo-1')?.linkedTodoId).toBeNull()
  })

  it('v5 备份保留档案空态与项目规则继承修订', () => {
    const project = projectRepo.create({ name: '修订历史备份项目' })
    db.prepare(`INSERT INTO profile_blocks
      (scope, project_id, block_key, body, confirmed, updated_by, updated_at)
      VALUES ('global', NULL, 'basics', '主用户档案', 1, 'human', '2026-10-17T00:00:00.000Z')`).run()
    db.prepare(`INSERT INTO profile_revisions
      (id, scope, project_id, block_key, body, confirmed, present, author, created_at)
      VALUES ('profile-empty-baseline', 'global', NULL, 'basics', '', 0, 0, 'human', '2026-10-16T00:00:00.000Z')`).run()
    db.prepare(`INSERT INTO rule_revisions
      (id, scope, project_id, rule_key, category, enforcement, has_override, author, created_at)
      VALUES ('rule-inherit-baseline', 'project', ?, 'G10', 'flow', NULL, 0, 'human', '2026-10-16T00:00:00.000Z')`).run(project.id)

    const json = backup.exportData()
    expect(JSON.parse(json).version).toBe(5)
    wipeAll()
    const result = backup.importData(json)

    expect(result.detail).toMatchObject({ profileBlocks: 1, profileRevisions: 1, ruleRevisions: 1 })
    expect(db.prepare("SELECT body, confirmed, present FROM profile_revisions WHERE id = 'profile-empty-baseline'").get())
      .toEqual({ body: '', confirmed: 0, present: 0 })
    expect(db.prepare("SELECT enforcement, has_override FROM rule_revisions WHERE id = 'rule-inherit-baseline'").get())
      .toEqual({ enforcement: null, has_override: 0 })
  })

  it('回执给出各表明细与跳过原因，而不是一个含糊的"成功"', () => {
    projectRepo.create({ name: '甲项目' })
    // 默认 4 条分类 + 这里新建 1 条
    categoryRepo.create({ name: '乙分类', color: '#123456', sortOrder: 9 })
    todoRepo.create({ title: '丙待办' })
    memoRepo.create({ author: 'human', text: '丁备忘' })

    const json = backup.exportData()
    wipeAll()
    const result = backup.importData(json)

    // 一个总数说明不了"哪里没进来"，必须分表
    expect(result.detail).toEqual({
      projects: 1,
      // 默认 4 条在目标库已存在（按名字复用，不计新建），只有"乙分类"是新建的
      categories: 1,
      todos: 1,
      agents: 0,
      memos: 1,
      comments: 0,
      transitions: 1,
      profileBlocks: 0,
      profileProposals: 0,
      profileRevisions: 0,
      protocolBlocks: 0,
      protocolProposals: 0,
      handoffRevisions: 0,
      handoffProposals: 0,
      releases: 0,
      collaborationRules: 0,
      permissionMatrix: 0,
      ruleProposals: 0,
      ruleRevisions: 0,
      agentApprovalEvents: 0
    })
    expect(result.reusedCategories).toBe(4)

    /**
     * 不变量：`imported + skipped` == 备份里的总条目数。
     * 分类的"已存在/按名复用"必须计入 skipped —— 否则用户对不上账
     * （导出 9 条，回执只交代 5 条，剩下 4 条去哪了没人知道）。
     */
    const exported = JSON.parse(json) as {
      todos: unknown[]
      categories: unknown[]
      projects?: unknown[]
      agents?: unknown[]
      memos?: unknown[]
      comments?: unknown[]
      transitions?: unknown[]
      auxiliary?: Record<string, unknown[]>
    }
    const total =
      exported.todos.length +
      exported.categories.length +
      (exported.projects?.length ?? 0) +
      (exported.agents?.length ?? 0) +
      (exported.memos?.length ?? 0) +
      (exported.comments?.length ?? 0) +
      (exported.transitions?.length ?? 0) +
      Object.values(exported.auxiliary ?? {}).reduce((sum, rows) => sum + rows.length, 0)
    expect(result.imported + result.skipped).toBe(total)
  })

  it('换机恢复：目标库已有同名默认分类时按名称复用，不重复建', () => {
    // 备份来源机器：默认分类 + 一条挂在其下的待办
    const work = categoryRepo.list().find((c) => c.name === '工作')!
    todoRepo.create({ title: '挂在工作下的待办', categoryIds: [work.id] })
    const json = backup.exportData()

    /**
     * 目标机器：清空后重新 initializeDefaults()，模拟"新机器第一次启动"
     * —— 它的默认分类 id 与来源机器**完全不同**（每次 uuidv4）。
     * 这正是Bob演练的场景：换机恢复后界面出现两组同名分类。
     */
    db.exec(`
      DELETE FROM todo_comments;
      DELETE FROM todo_transitions;
      DELETE FROM todo_categories;
      DELETE FROM todos;
      DELETE FROM categories;
    `)
    categoryRepo.initializeDefaults()
    expect(categoryRepo.list().filter((c) => c.name === '工作')).toHaveLength(1)

    const result = backup.importData(json)

    // 核心断言：同名分类没有翻倍
    const workCount = categoryRepo.list().filter((c) => c.name === '工作').length
    expect(workCount).toBe(1)
    // 且这件事要报出来，不能静默
    expect(result.reusedCategories).toBeGreaterThan(0)

    // 待办仍然带着标签（映射到了目标库那条同名分类）
    const back = todoRepo.list().find((t) => t.title === '挂在工作下的待办')!
    expect(back.categoryIds).toHaveLength(1)
    expect(categoryRepo.getById(back.categoryIds[0])?.name).toBe('工作')
  })

  it('v1 老备份仍然能导入（只认 todos / categories / settings）', () => {    const legacy = JSON.stringify({
      version: 1,
      exportedAt: new Date().toISOString(),
      todos: [
        {
          id: 'legacy-todo',
          title: '老备份里的待办',
          status: 'todo',
          priority: 'normal',
          type: 'task',
          createdBy: 'human',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
      ],
      categories: [],
      settings: {}
    })

    const result = backup.importData(legacy)

    expect(result.detail?.todos).toBe(1)
    // 老格式没有 categoryId，标签落空但不能因此丢整条
    expect(todoRepo.getById('legacy-todo')).toBeDefined()
  })

  it('导入前自动留一份原件备份（破坏性操作必须可退）', () => {
    todoRepo.create({ title: '导入前的数据' })

    const spy = vi.spyOn(fs, 'copyFileSync').mockImplementation(() => undefined)
    try {
      const result = backup.importData(
        JSON.stringify({
          version: 2,
          exportedAt: new Date().toISOString(),
          todos: [],
          categories: [],
          settings: {}
        })
      )
      // 文件路径要带回渲染进程，界面上得告诉人"原件在哪"
      expect(result.preImportBackup).toBeTruthy()
      expect(result.preImportBackup).toContain('backup-preimport-')
      /**
       * 卡 71270463：名字必须落在 `<库文件>.backup-` 前缀里。
       * 清理（pruneOldBackups）与清点（listSnapshots）都只认这个前缀 ——
       * 曾写成 `user.backup-preimport-….db`（少了中间的 `.db`），
       * 于是备份既不轮转、也不出现在设置里那份"可用快照"清单中。
       */
      expect(path.basename(result.preImportBackup)).toMatch(
        /^user\.db\.backup-preimport-\d{4}-\d{2}-\d{2}T/
      )
      expect(spy).toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })
})
