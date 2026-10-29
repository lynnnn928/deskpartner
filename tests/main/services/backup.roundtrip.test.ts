/**
 * 真数据备份往返验收（1.0.49，Bob 65e5ebc7）
 *
 * ── 为什么单开一个文件，不进 npm test ──
 *
 * `backup.drill.test.ts` 用**合成 fixture**（形状复刻真实统计、内容全造）。
 * 它回答的是"形状会不会退化"，任何机器都跑得住，所以进 npm test。
 *
 * 这个文件回答的是另一个问题：**本机真库导出的那份 JSON，导回去还一样吗。**
 * 它依赖本机真库，换台机器就跑不了 —— 所以做成独立命令
 * （`node scripts/verify-backup-roundtrip.mjs`），由脚本准备好副本再调它。
 *
 * 两者是互补的：fixture 守回归，真数据守"这次真的对得上"。
 *
 * ── 基线从哪来 ──
 *
 * 环境变量 `DESKPARTNER_DRILL_DB` 指向真库的**一致性副本**
 * （由脚本用 sqlite backup API 取，不是 copyFile —— WAL 下 copyFile 会丢事务）。
 * 没设就整组跳过 —— 这是**刻意的**：它不该在 npm test 里跑，
 * 也不该在没有副本时假装通过。
 *
 * ⚠️ 与 8e238221 的教训对照：那次是"基线缺失就 skip，于是静默失效"。
 * 这里的 skip 不会静默 —— 它只在独立命令下被调用，而脚本除了看退出码，
 * 还会数**真正跑过的用例条数**（要求 >= 4 且 skipped == 0）。
 * 这一点是必须的：vitest 在整组被跳过时退出码同样是 **0**，
 * 只看退出码就会让"环境变量名漂了"变成一次假通过。
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import Database from 'better-sqlite3'
import { runMigrations } from '../../../src/main/database/migrations'

const SRC = process.env.DESKPARTNER_DRILL_DB

/**
 * 没给副本 → 整组跳过（这条命令只该由 verify-backup-roundtrip.mjs 调）
 *
 * ⚠️ `await import` 必须在**模块顶层**，不能放进 describe 回调 ——
 * 那里不是 async 上下文，语法直接报 PARSE_ERROR（实测踩过两次）。
 */
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-rt-'))
const WORK_DB = path.join(WORK, 'work.db')

/**
 * 工作库与源副本分离：往返过程会清空表，直接在源副本上跑会把基线改坏。
 * 这正是 8e238221 那个坑的另一种形态 —— 基线必须是一次性的。
 *
 * ⚠️ 必须在模块顶层就复制好：下面的 `new Database(WORK_DB)` 也是顶层执行的，
 * 若等到 beforeAll 才复制，连接早已建在一个空库上。
 */
if (SRC && fs.existsSync(SRC)) fs.copyFileSync(SRC, WORK_DB)

const db = new Database(WORK_DB)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')
runMigrations(db)

vi.mock('../../../src/main/database/index', () => ({
  getDatabase: () => db,
  getDatabasePath: () => WORK_DB
}))

const { BackupService, BACKUP_FORMAT_VERSION } =
  await import('../../../src/main/services/backup.service')
const { TodoRepository } = await import('../../../src/main/database/todo.repository')
const { CategoryRepository } = await import('../../../src/main/database/category.repository')
const { ProjectRepository } = await import('../../../src/main/database/project.repository')
const { MemoRepository } = await import('../../../src/main/database/memo.repository')
const { AgentRepository } = await import('../../../src/main/database/agent.repository')
const { SettingsRepository } = await import('../../../src/main/database/settings.repository')

const suite = SRC && fs.existsSync(SRC) ? describe : describe.skip

suite('真数据往返：导出 → 清空 → 导入 → 逐字段比对', () => {
  let backup
  let todoRepo
  /**
   * `importData` 的回执；null = 还没有哪条用例走到导入那一步。
   *
   * 用例之间不该这样传值，这里是刻意的例外：下面"导入前备份落盘"是一条**独立**用例，
   * 而它要保护的动作发生在另一条用例里。不记这一笔，上游中途失败（比如一条过期断言）
   * 会让它报"导入前没留原件备份" —— 把"用例没跑到"说成"产品没备份"，
   * 与本次驳回的误导一模一样。
   */
  let importReceipt = null

  beforeAll(() => {
    /**
     * 先埋三份"旧快照"（卡 71270463）：导入前的备份必须**进轮转**。
     * 判据是"导入之后目录里还剩几份"—— 没有旧文件在场，就分不出
     * "轮转生效了"与"压根没轮转过"。
     */
    for (const n of [
      'v0-2001-01-01T00-00-00-000Z',
      'v0-2002-01-01T00-00-00-000Z',
      'v0-2003-01-01T00-00-00-000Z'
    ]) {
      fs.writeFileSync(`${WORK_DB}.backup-${n}`, 'stale snapshot')
    }
    todoRepo = new TodoRepository()
    const categoryRepo = new CategoryRepository()
    const projectRepo = new ProjectRepository()
    backup = new BackupService(
      todoRepo,
      categoryRepo,
      new SettingsRepository(),
      projectRepo,
      new MemoRepository(),
      new AgentRepository()
    )
  })

  afterAll(() => {
    try {
      db.close()
      fs.rmSync(WORK, { recursive: true, force: true })
    } catch {
      /* 清理失败不该让结论变红 */
    }
  })

  /**
   * 真库不是空的才算数。
   *
   * 这条断言是"闸门的闸门"：若副本是空的（复制失败、路径指错），
   * 下面的比对会变成 0 条 vs 0 条、全绿，而实际什么都没验。
   */
  it('副本确实有真实数据（否则后面的比对是空转）', () => {
    const n = (db.prepare('SELECT COUNT(*) n FROM todos').get()).n
    const cats = (db.prepare('SELECT COUNT(*) n FROM categories').get()).n
    console.log(`\n[往返] 副本规模：待办 ${n} 条 / 分类 ${cats} 个`)
    expect(n, '副本里没有待办，比不出任何东西').toBeGreaterThan(0)
    expect(cats).toBeGreaterThan(0)
  })

  it('逐字段比对：待办 / 标签关联 / 项目 / 身份 / 备忘全部一致', () => {
    const readTodos = () =>
      db
        .prepare(
          `SELECT id, title, description, project_id, parent_id, status, priority, type,
                  created_by, executed_by, due_at, remind_at, is_pinned,
                  created_at, updated_at, completed_at
             FROM todos ORDER BY id`
        )
        .all()
    const readTags = () =>
      db
        .prepare(
          `SELECT tc.todo_id, tc.category_id FROM todo_categories tc
             JOIN todos t ON t.id = tc.todo_id
             JOIN categories c ON c.id = tc.category_id
            ORDER BY tc.todo_id, tc.category_id`
        )
        .all()
    const readProjects = () =>
      db.prepare('SELECT id, name, color, archived, sort_order, created_at FROM projects ORDER BY id').all()
    const readAgents = () =>
      db.prepare('SELECT id, display_name, color, approved, created_at FROM agents ORDER BY id').all()
    const readMemos = () =>
      db.prepare('SELECT id, author, text, linked_todo_id, status, created_at, read_at FROM memos ORDER BY id').all()
    /**
     * v5 的两张修订历史（`profile_revisions` / `rule_revisions`）此前**不在这张表里**：
     * 格式升 v5 时补了导出、却没补比对 —— "修订历史丢了"这件事这套往返测试看不见。
     * 与上面那条版本断言合起来才是完整的：版本号自称一致，内容由这张表兜。
     */
    const auxiliaryTables = [
      'profile_blocks', 'profile_proposals', 'profile_revisions',
      'protocol_blocks', 'protocol_proposals',
      'project_handoff_revisions', 'project_handoff_proposals', 'releases',
      'collaboration_rules', 'permission_matrix',
      'rule_proposals', 'rule_revisions', 'agent_approval_events'
    ]
    const readAuxiliary = () => Object.fromEntries(auxiliaryTables.map((table) => [
      table,
      db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()
    ]))

    const before = {
      todos: readTodos(),
      tags: readTags(),
      projects: readProjects(),
      agents: readAgents(),
      memos: readMemos(),
      auxiliary: readAuxiliary()
    }
    console.log(
      `[往返] 导出前：待办 ${before.todos.length} / 标签关联 ${before.tags.length} / ` +
        `项目 ${before.projects.length} / 身份 ${before.agents.length} / 备忘 ${before.memos.length}`
    )

    // ── 导出 ──
    const json = backup.exportData()
    const parsed = JSON.parse(json)
    console.log(`[往返] 导出 JSON ${(json.length / 1024).toFixed(0)} KB，version=${parsed.version}`)
    /**
     * 格式版本：**只核性质，不钉死数字**（1.0.110，修 `d562f985` 的驳回）
     *
     * 这里原样是 `toBe(4)`。v5 把 profile / rules 修订历史并进备份时忘了同步它，
     * 于是这条闸门从 1.0.105 起一直红着 —— 而它不在 npm test / 发版链里，
     * 红了两周没人看见（驳回原文：`npm run verify:backup` rc=1）。
     *
     * 更贵的是它的**位置**：它是这一段的第一条断言，一红，后面的"清空 → 导入"
     * 整段就不执行了 —— 于是最后一条"导入前的原件备份真的落到了磁盘"也跟着红，
     * **一条过期断言伪装成两个产品缺陷**。本次驳回的真相就是这个。
     *
     * 所以判据改成两条不依赖具体版本号的性质：
     * ① 导出自称的版本 = 实现里的常量（导出与实现不能各说各话）；
     * ② 常量不低于 v4 —— v4 是"带接手所需的协作上下文与审批审计"的起点，
     *    而老备份永远要能导入，版本号因此只许前进。
     * 至于那些表**到底有没有真的随备份走**，由下面的逐表比对负责 ——
     * 那才是会真红的一条线，版本号这一条只负责"没在骗人"。
     */
    expect(parsed.version, '导出自称的版本必须与 BACKUP_FORMAT_VERSION 同源').toBe(
      BACKUP_FORMAT_VERSION
    )
    expect(
      BACKUP_FORMAT_VERSION,
      '备份格式版本只许前进：v4 是协作上下文与审批审计的起点'
    ).toBeGreaterThanOrEqual(4)
    expect(parsed.todos).toHaveLength(before.todos.length)
    expect(parsed.projects ?? []).toHaveLength(before.projects.length)
    expect(parsed.agents ?? []).toHaveLength(before.agents.length)
    expect(parsed.memos ?? []).toHaveLength(before.memos.length)

    // ── 清空（模拟换一台干净机器） ──
    db.exec(`
      DELETE FROM rule_proposals;
      DELETE FROM permission_matrix;
      DELETE FROM collaboration_rules;
      DELETE FROM project_handoff_proposals;
      DELETE FROM project_handoff_revisions;
      DELETE FROM protocol_proposals;
      DELETE FROM protocol_blocks;
      DELETE FROM profile_proposals;
      DELETE FROM profile_blocks;
      DELETE FROM releases;
      DELETE FROM agent_approval_events;
      DELETE FROM todo_categories;
      DELETE FROM todos;
      DELETE FROM categories;
      DELETE FROM projects;
      DELETE FROM memos;
      DELETE FROM agent_grants;
      DELETE FROM agents;
    `)
    expect(todoRepo.list(), '清空没生效，后面的"导入成功"是假的').toHaveLength(0)

    // ── 导入 ──
    const result = backup.importData(json)
    importReceipt = result
    console.log(
      `[往返] 导入回执：${JSON.stringify(result.detail)} skipped=${result.skipped}` +
        (result.reusedCategories ? ` reusedCategories=${result.reusedCategories}` : '')
    )
    if (result.skippedItems?.length) {
      const kinds = {}
      for (const s of result.skippedItems) kinds[s.kind] = (kinds[s.kind] ?? 0) + 1
      console.log(`[往返] 跳过项分布：${JSON.stringify(kinds)}`)
      console.log(`[往返] 跳过项样例（前 3）：${JSON.stringify(result.skippedItems.slice(0, 3))}`)
    }

    // ── 逐字段比对 ──
    expect(readTodos(), '待办字段有差异 —— 逐行对比见上方输出').toEqual(before.todos)
    expect(readTags(), '标签关联有差异').toEqual(before.tags)
    expect(readProjects()).toEqual(before.projects)
    expect(readAgents()).toEqual(before.agents)
    expect(readMemos()).toEqual(before.memos)
    expect(readAuxiliary(), '档案/协议/接手说明/版本/规则及审批审计未完整恢复').toEqual(before.auxiliary)

    /**
     * 一条待办都不该被跳过。
     *
     * 分类按名复用会计入 skipped（属正常，目标是干净库时会命中默认分类），
     * 但**待办/身份/备忘**被跳过就意味着真丢东西了。
     */
    const byKind = (k) => (result.skippedItems ?? []).filter((s) => s.kind === k)
    expect(byKind('待办'), '有待办没导进来').toHaveLength(0)
    expect(byKind('agent'), '有身份没导进来').toHaveLength(0)
    expect(byKind('备忘'), '有备忘没导进来').toHaveLength(0)

    /**
     * 不变量：`imported + skipped` == 备份条目总数。
     * 对不上账就是回执在骗人（导出了 N 条，只交代了 N-1 条）。
     */
    const total =
      parsed.todos.length +
      parsed.categories.length +
      (parsed.projects?.length ?? 0) +
      (parsed.agents?.length ?? 0) +
      (parsed.memos?.length ?? 0) +
      (parsed.comments?.length ?? 0) +
      (parsed.transitions?.length ?? 0) +
      Object.values(parsed.auxiliary ?? {}).reduce((sum, rows) => sum + rows.length, 0)
    expect(result.imported + result.skipped).toBe(total)
  })

  it('id 全部保住（换 id 会断掉外部引用与父子关系）', () => {
    const ids = db.prepare('SELECT id FROM todos ORDER BY id').all().map((r) => r.id)
    const parents = db
      .prepare('SELECT parent_id FROM todos WHERE parent_id IS NOT NULL')
      .all()
      .map((r) => r.parent_id)
    console.log(`[往返] id 保留 ${ids.length} 个；挂父级的 ${parents.length} 条`)
    // 父 id 必须在库中真实存在（悬空父级说明 id 没保住）
    for (const p of parents) {
      expect(ids, `父级 ${p} 不在库里 —— parent_id 断了`).toContain(p)
    }
  })

  it('导入前的原件备份落了盘，而且进了轮转（破坏性操作的保险）', () => {
    // 先分清"产品没备份"与"这条用例的上游没跑到"（本次驳回的误导就出在这里）
    expect(
      importReceipt,
      '上一条用例没执行到导入那一步（它中途失败了）—— 这条红不是备份的锅，先看上面的失败'
    ).not.toBeNull()

    const base = path.basename(WORK_DB)
    const found = fs.readdirSync(WORK).filter((f) => f.includes('backup-preimport-'))
    console.log(`[往返] 工作目录里的导入前备份：${found.join(', ') || '(无)'}`)
    expect(found.length, '导入前没留原件备份').toBeGreaterThan(0)

    /**
     * 卡 71270463：备份文件必须落在 `<库文件>.backup-` 前缀里 ——
     * 清理（pruneOldBackups）与清点（listSnapshots）认的都是它。
     * 命名一漂（曾少了中间的 `.db`），文件既不被轮转、也不出现在"可用快照"清单里：
     * 磁盘上有退路，人却以为没有。
     */
    expect(
      found.filter((f) => f.startsWith(`${base}.backup-`)),
      '导入前备份不在 <库文件>.backup- 前缀里：不会被清理，也进不了"可用快照"清单'
    ).toHaveLength(found.length)

    /**
     * 轮转真的生效：beforeAll 埋了 3 份旧快照，导入后主文件必须已收敛到保留窗口内。
     * 否则每导入一次就多留一份完整库（5 MB × N），而没有任何一步会因此变红。
     */
    const mains = fs
      .readdirSync(WORK)
      .filter((f) => f.startsWith(`${base}.backup-`) && !/-(wal|shm)$/.test(f))
    console.log(`[往返] 备份收敛后还剩 ${mains.length} 份快照`)
    expect(
      mains.length,
      '导入前的备份没有进轮转：每导入一次就多留一份完整库'
    ).toBeLessThanOrEqual(2)
  })
})
