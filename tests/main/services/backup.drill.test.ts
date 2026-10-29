/**
 * 真实数据端到端演练（1.0.46 修复验证）
 *
 * 为什么单测不够：单测跑的是 :memory: 上的合成数据（几条待办、一个标签）。
 * 而Bob演练事故的全部症状都只在**真实数据形状**下才暴露：
 * 199 条待办里 199 条带 projectId、188 条有描述、144 条已完成、
 * 63 条指派了执行者、27 条是子任务 —— 旧实现只恢复 title/status/priority，
 * 这些字段会**全部静默归零**，而合成数据看不出来。
 *
 * ── 1.0.49 重写（修 8e238221）──
 *
 * 原先这组用例靠写死路径指向本机某份历史快照，而那份快照被环境恢复
 * 消耗掉了 → `skipIf` 生效 → 4 条用例**静默跳过**，npm test 仍是全绿。
 * 也就是说，唯一能拦住"导入只恢复三个字段"这类回归的闸门实际不生效。
 *
 * 现在改成**仓库内 fixture**（`drill-fixture.ts` 按真实统计合成，
 * 不含任何真实数据），任何机器任何时间都跑得住。同时：
 * - 基线**缺失即失败**（不再 skip）—— 静默跳过正是这次踩的坑；
 * - fixture 由测试自己生成到临时目录，不往仓库里塞二进制；
 * - 顺带断言"形状确实造出来了"（避免 fixture 退化后测试假通过）。
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import Database from 'better-sqlite3'
import { runMigrations } from '../../../src/main/database/migrations'
import { createFixtureDb, type FixtureShape } from './drill-fixture'

const WORK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-drill-'))
const WORK_DB = path.join(WORK_DIR, 'drill-work.db')

/**
 * ⚠️ fixture 必须在**模块顶层**生成，不能放进 `beforeAll`。
 *
 * 下面的 `new Database(WORK_DB)` 是模块顶层执行的 —— 如果等到 beforeAll
 * 才生成基线文件，连接早就建在了一个空库上，于是所有比对都变成
 * "0 条 vs 0 条"、全部通过，测试却什么都没验。
 *
 * （这不是假想：第一版就是放在 beforeAll 里的，实测四个用例全绿而库里 0 条，
 * 靠 fixture 自检那道断言才抓出来。它正是为这种情况准备的。）
 */
const baseline = path.join(WORK_DIR, 'baseline.db')
const shape: FixtureShape = createFixtureDb(baseline)
/**
 * 工作库必须与基线分离：演练过程会清空、导入、重复导入，
 * 直接在基线上跑会把基线改坏（这正是"快照被消耗"的另一种形态）。
 */
fs.copyFileSync(baseline, WORK_DB)

afterAll(() => {
  try {
    fs.rmSync(WORK_DIR, { recursive: true, force: true })
  } catch {
    /* 临时目录清理失败不该让测试变红 */
  }
})

const db = new Database(WORK_DB)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')
runMigrations(db)

vi.mock('../../../src/main/database/index', () => ({
  getDatabase: () => db,
  getDatabasePath: () => WORK_DB
}))

const { BackupService } = await import('../../../src/main/services/backup.service')
const { TodoRepository } = await import('../../../src/main/database/todo.repository')
const { CategoryRepository } = await import('../../../src/main/database/category.repository')
const { ProjectRepository } = await import('../../../src/main/database/project.repository')
const { MemoRepository } = await import('../../../src/main/database/memo.repository')
const { AgentRepository } = await import('../../../src/main/database/agent.repository')
const { SettingsRepository } = await import('../../../src/main/database/settings.repository')

describe('真实数据演练：导出 → 清空 → 导入 → 逐字段比对', () => {
  let backup: InstanceType<typeof BackupService>
  let todoRepo: InstanceType<typeof TodoRepository>
  let categoryRepo: InstanceType<typeof CategoryRepository>
  let projectRepo: InstanceType<typeof ProjectRepository>
  let memoRepo: InstanceType<typeof MemoRepository>
  let agentRepo: InstanceType<typeof AgentRepository>

  beforeAll(() => {
    todoRepo = new TodoRepository()
    categoryRepo = new CategoryRepository()
    projectRepo = new ProjectRepository()
    memoRepo = new MemoRepository()
    agentRepo = new AgentRepository()
    backup = new BackupService(
      todoRepo,
      categoryRepo,
      new SettingsRepository(),
      projectRepo,
      memoRepo,
      agentRepo
    )
  })

  /**
   * fixture 自检 —— 这道断言是"闸门的闸门"。
   *
   * 如果 fixture 生成逻辑退化（比如某次改动把 description 全设成 null），
   * 后面的逐字段比对**依然会全绿**（导入前后都是 null，当然相等），
   * 而测试实际上什么都没验。所以先把"形状确实造出来了"钉死。
   */
  it('fixture 确实具备真实数据形状（否则后面的比对是空转）', () => {
    expect(shape.todos).toBe(200)
    expect(shape.withProject, '项目是必填项，一条都不能漏').toBe(200)
    expect(shape.withDescription, '有描述的条数太少，验不出大字段丢失').toBeGreaterThan(100)
    expect(shape.done, '已完成条数太少，验不出 completed_at 丢失').toBeGreaterThan(50)
    expect(shape.withExecutedBy, '有执行者的条数太少，验不出 executed_by 丢失').toBeGreaterThan(30)
    expect(shape.withParent, '没有两层父子，验不出 parent_id 丢失').toBe(24)
    expect(shape.categories).toBe(16)
    expect(shape.projects).toBe(2)
    expect(shape.agents).toBe(2)
    expect(shape.memos).toBe(2)
  })

  it('200 条待办的字段全部原样回来', () => {
    // ── 导出前的真实状态（直接从库里读，不依赖导出结果） ──
    const before = db
      .prepare(
        `SELECT id, title, description, project_id, parent_id, status, priority, type,
                created_by, executed_by, due_at, remind_at, is_pinned,
                created_at, updated_at, completed_at
           FROM todos ORDER BY id`
      )
      .all() as Record<string, unknown>[]
    const beforeTags = db
      .prepare(
        `SELECT tc.todo_id, tc.category_id FROM todo_categories tc
           JOIN todos t ON t.id = tc.todo_id
           JOIN categories c ON c.id = tc.category_id
          ORDER BY tc.todo_id, tc.category_id`
      )
      .all() as { todo_id: string; category_id: string }[]
    const beforeProjects = db.prepare('SELECT id, name, color, archived, sort_order, created_at FROM projects ORDER BY id').all()
    const beforeAgents = db.prepare('SELECT id, display_name, color, approved, created_at FROM agents ORDER BY id').all()
    const beforeMemos = db.prepare('SELECT id, author, text, linked_todo_id, status, created_at, read_at FROM memos ORDER BY id').all()

    console.log(`\n[演练] 导出前：待办 ${before.length} 条 / 标签关联 ${beforeTags.length} 条 / 项目 ${beforeProjects.length} / 身份 ${beforeAgents.length} / 备忘 ${beforeMemos.length}`)

    // ── 导出 ──
    const json = backup.exportData()
    const parsed = JSON.parse(json) as Record<string, unknown>
    console.log(`[演练] 导出 JSON ${(json.length / 1024).toFixed(0)} KB，version=${parsed.version}`)

    // 导出必须带上全部四类数据
    expect(parsed.projects).toHaveLength(beforeProjects.length)
    expect(parsed.agents).toHaveLength(beforeAgents.length)
    expect(parsed.memos).toHaveLength(beforeMemos.length)
    expect(parsed.todos).toHaveLength(before.length)

    // ── 清空（模拟"换一台干净的机器"） ──
    db.exec(`
      DELETE FROM todo_categories;
      DELETE FROM todos;
      DELETE FROM categories;
      DELETE FROM projects;
      DELETE FROM memos;
      DELETE FROM agent_grants;
      DELETE FROM agents;
    `)
    expect(todoRepo.list()).toHaveLength(0)

    // ── 导入 ──
    const result = backup.importData(json)
    console.log(`[演练] 导入回执: ${JSON.stringify(result.detail)} skipped=${result.skipped}`)
    if (result.skippedItems?.length) {
      console.log(`[演练] 跳过项（前 5）: ${JSON.stringify(result.skippedItems.slice(0, 5))}`)
    }

    // ── 逐字段比对 ──
    const after = db
      .prepare(
        `SELECT id, title, description, project_id, parent_id, status, priority, type,
                created_by, executed_by, due_at, remind_at, is_pinned,
                created_at, updated_at, completed_at
           FROM todos ORDER BY id`
      )
      .all() as Record<string, unknown>[]
    const afterTags = db
      .prepare(
        `SELECT tc.todo_id, tc.category_id FROM todo_categories tc
           JOIN todos t ON t.id = tc.todo_id
           JOIN categories c ON c.id = tc.category_id
          ORDER BY tc.todo_id, tc.category_id`
      )
      .all()

    expect(after).toHaveLength(before.length)
    expect(after).toEqual(before)
    expect(afterTags).toEqual(beforeTags)
    console.log(`[演练] 标签关联：有效 ${afterTags.length} 条一致`)

    // 明细表逐类核对
    expect(db.prepare('SELECT id, name, color, archived, sort_order, created_at FROM projects ORDER BY id').all()).toEqual(beforeProjects)
    expect(db.prepare('SELECT id, display_name, color, approved, created_at FROM agents ORDER BY id').all()).toEqual(beforeAgents)
    expect(db.prepare('SELECT id, author, text, linked_todo_id, status, created_at, read_at FROM memos ORDER BY id').all()).toEqual(beforeMemos)

    // 一条待办都不该被跳过（分类按名复用计入 skipped，属正常）
    const todoSkips = (result.skippedItems ?? []).filter((s) => s.kind === '待办')
    const agentSkips = (result.skippedItems ?? []).filter((s) => s.kind === 'agent')
    const memoSkips = (result.skippedItems ?? []).filter((s) => s.kind === '备忘')
    expect(todoSkips).toHaveLength(0)
    expect(agentSkips).toHaveLength(0)
    expect(memoSkips).toHaveLength(0)
  })

  /**
   * 大字段与特殊字符专项（fixture 里刻意放了 376 字超长描述、
   * emoji、多行、引号）——这些在真实库里都有，且最容易在序列化时坏掉。
   */
  it('超长描述 / emoji / 多行 / 引号都原样保留', () => {
    const rows = db
      .prepare("SELECT title, description FROM todos WHERE description IS NOT NULL AND description <> ''")
      .all() as { title: string; description: string }[]

    const longest = rows.reduce((a, b) => (a.description.length >= b.description.length ? a : b))
    console.log(`\n[演练] 最长描述 ${longest.description.length} 字，换行 ${(longest.description.match(/\n/g) ?? []).length} 处`)
    expect(longest.description.length, '超长描述应被完整保留').toBeGreaterThan(300)
    expect(longest.description).toContain('\n')
    expect(longest.description).toContain('```')

    // emoji 与多行：只要还存在就说明没被清洗掉
    expect(rows.some((r) => /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(r.description))).toBe(true)
    expect(rows.some((r) => r.description.includes('\n'))).toBe(true)
    expect(rows.some((r) => r.description.includes('"'))).toBe(true)
  })

  it('重复导入同一份备份不翻倍（fixture 200 条）', () => {
    const count = () => db.prepare('SELECT COUNT(*) n FROM todos').get() as { n: number }
    const base = count().n
    expect(base).toBe(200)

    const json = backup.exportData()
    const again = backup.importData(json)

    console.log(
      `\n[演练] 重复导入：待办 ${base} → ${count().n}，新进 ${again.detail?.todos}，` +
        `跳过 ${again.skipped}（明细 ${JSON.stringify(again.detail)}）`
    )
    // 核心：id 保住了，冲突检测才真的生效
    expect(count().n).toBe(base)
    expect(again.detail?.todos).toBe(0)
    // 重复导入时一件事都没新建
    expect(again.imported).toBe(0)
    expect(again.detail?.projects).toBe(0)
    expect(again.detail?.agents).toBe(0)
    expect(again.detail?.memos).toBe(0)

    /**
     * 不变量：`imported + skipped` == 备份里的总条目数。
     * 这条能拦住"回执对不上账"（导出了 N 条，回执只交代 N-1 条，
     * 剩下那条去哪了没人知道）。
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
    expect(again.imported + again.skipped).toBe(total)

    // 跳过原因必须是"同 id 已存在"，不能是数据库主键报错
    for (const item of again.skippedItems ?? []) {
      expect(item.why).not.toContain('UNIQUE constraint')
      expect(item.why).toContain('已存在')
    }
  })

  it('agent 身份与批准状态完整回来（Bob报的"Agent 不能注册"场景）', () => {
    const agents = agentRepo.list()
    console.log(`\n[演练] 身份: ${agents.map((a) => `${a.id}(approved=${a.approved})`).join(', ')}`)
    expect(agents.length).toBe(2)
    // 演练前两个身份都是 approved=1，恢复后必须还是
    expect(agents.every((a) => a.approved)).toBe(true)
    // 凭据不该被备份带回来 —— 恢复后要人重新签发
    expect(agents.every((a) => !a.hasCredential)).toBe(true)
  })

  it('导入前的原件备份真的落到了磁盘上', () => {
    // 这是"演练无法隔离"之外的第二道保险：导入前留原件
    const inWorkDir = fs.readdirSync(WORK_DIR).filter((f) => f.includes('backup-preimport-'))
    console.log(`\n[演练] 工作目录里的导入前备份: ${inWorkDir.join(', ') || '(无)'}`)
    expect(inWorkDir.length).toBeGreaterThan(0)
  })
})
