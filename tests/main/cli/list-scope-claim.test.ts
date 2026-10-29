import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '../../../src/main/database/migrations'
import { TodoRepository } from '../../../src/main/database/todo.repository'
import { CategoryRepository } from '../../../src/main/database/category.repository'
import { ProjectRepository } from '../../../src/main/database/project.repository'
import { executeOne } from '../../../src/main/cli/commands'

const db = new Database(':memory:')
vi.mock('../../../src/main/database/index', () => ({ getDatabase: () => db }))

/**
 * 查询范围必须自报：全机查询不许再"长得像某个项目的清单"
 *
 * ── 为什么（2026-10-22 主用户定的）──
 *
 * 她问的是「现在是能让 agent 先查状态、然后再查是哪个项目的。理论上不该先查项目、
 * 再查状态吗？直接全局查状态的这条路要不要关掉？」
 *
 * 查清后的事实：`todo list --project` 是**可选**过滤器，不传就是全机；
 * 而回执里一个字都没说这件事（每行带 `projectName`，但逐行的信息读不出"这一页跨了几个项目"）。
 * 于是它很自然地被读成"我在看某个项目的清单"。
 *
 * ⚠️ 对照产品自己的模型：看板有 `project` / `all` 两种工作区模式，**默认进项目**，
 * 看全部要显式切（`ui.store.ts` 的 `WorkspaceMode`）。也就是说 CLI 这里确实比界面松。
 *
 * ── 定的做法：保留能力，但让它自报 ──
 *
 * 不关掉这条路，因为跨项目的盘点真实且常用（全机待验收多少张、待办列被谁塞了多少张、
 * 有没有卡指派给我 —— 这些都没有项目可先选）。"先项目、后状态"是**教法的顺序**，
 * 靠删掉能力来实现它，代价比收益大。
 *
 * 判据与 `defaultScope` 同源：**默认口径变了就在回执里说清**。
 * 而且两种范围都带 `projectScope` —— 不许用"字段不在 ⇒ 按项目查"这种靠猜的推断。
 */
describe('list 的查询范围要自报（全机 vs 按项目）', () => {
  let todos: TodoRepository
  let ctx: never

  beforeAll(() => {
    runMigrations(db)
    db.pragma('foreign_keys = OFF')
  })

  beforeEach(() => {
    db.prepare('DELETE FROM todos').run()
    new CategoryRepository().create({ name: '方向', color: '#111', sortOrder: 0 })
    const projects = new ProjectRepository()
    projects.create({ name: '甲项目' })
    projects.create({ name: '乙项目' })
    projects.create({ name: '丙项目' })
    projects.create({ name: '丁项目' })
    const byName = (n: string) => projects.list().find((p) => p.name === n)!.id

    todos = new TodoRepository()
    // 四个项目各一条 —— 这样"跨了几个项目"这条信息是真的，不是造出来的
    todos.create({ title: '甲里的一条', projectId: byName('甲项目') } as never)
    todos.create({ title: '乙里的一条', projectId: byName('乙项目') } as never)
    todos.create({ title: '丙里的一条', projectId: byName('丙项目') } as never)
    todos.create({ title: '丁里的一条', projectId: byName('丁项目') } as never)
    // 老数据可能没有项目 —— 它也得被如实归类，不能不算数
    todos.create({ title: '没归属的一条', projectId: null } as never)

    ctx = {
      deps: {
        todoRepo: todos,
        categoryRepo: new CategoryRepository(),
        projectRepo: new ProjectRepository(),
        memoRepo: { list: () => [] },
        settingsRepo: { get: () => ({}) },
        agentRepo: {},
        events: { append: () => {} },
        telemetry: { record: () => {} }
      },
      meta: { version: '1.0.110', dbPath: ':memory:', schemaVersion: 45, via: 'pipe' },
      interactive: true,
      actor: 'human'
    } as never
  })

  const metaOf = (out: { meta?: Record<string, unknown> }) =>
    (out.meta ?? {}) as Record<string, unknown>
  const scopeOf = (out: { meta?: Record<string, unknown> }) =>
    (metaOf(out).projectScope ?? {}) as Record<string, unknown>

  it('不传 --project：回执明说这是全机（跨项目）查询', async () => {
    const r = await executeOne(ctx, ['todo', 'list'])
    expect(r.ok).toBe(true)
    const scope = scopeOf(r as never)
    expect(
      scope.kind,
      '不传 --project 就是全机查询，而回执没说 —— 这正是"看起来像在看一个项目"的来源'
    ).toBe('all-projects')
    const notice = String(scope.notice ?? '')
    expect(notice, '只说 kind 不够：调用方要读得懂人话').toContain('全机')
    expect(notice, '没给补救办法（该传什么）等于让人猜').toContain('--project')
    expect(Number(scope.projectCount), '本页跨了几个项目必须给数').toBe(5)
    expect(scope.projects, '要能读出是哪几个项目').toContain('甲项目')
    expect(scope.projects, '没有项目的老数据也要如实归类').toContain('（未归属项目）')
  })

  it('传了 --project：kind 是 project，且不再啰嗦"这是全机"', async () => {
    const r = await executeOne(ctx, ['todo', 'list', '--project', '甲项目'])
    expect(r.ok).toBe(true)
    const scope = scopeOf(r as never)
    expect(scope.kind).toBe('project')
    expect(
      'notice' in scope,
      '显式按项目查还提示"没按项目收窄" → 变成噪声，调用方会开始无视它'
    ).toBe(false)
    expect(scope.projects).toEqual(['甲项目'])
  })

  it('按项目查时也要带 projectScope —— 别用"字段不在"表达"按项目"', async () => {
    const r = await executeOne(ctx, ['todo', 'list', '--project', '乙项目'])
    expect(
      'projectScope' in metaOf(r as never),
      '"没有这个字段 ⇒ 按项目查"又是一次靠猜的推断；两种范围都要显式说'
    ).toBe(true)
  })

  it('翻页后 projectScope 说的是**这一页**的项目（不是全库的）', async () => {
    const first = await executeOne(ctx, ['todo', 'list', '--limit', '2'])
    const scope = scopeOf(first as never)
    expect(Number(scope.projectCount), '本页只有 2 条，就不该说 5 个项目').toBe(2)
  })

  it('既有 meta 字段一个都不能少（别为了加范围声明把原字段挤掉）', async () => {
    const r = await executeOne(ctx, ['todo', 'list'])
    const m = metaOf(r as never)
    for (const k of ['matched', 'returned', 'truncated', 'byStatus', 'defaultScope']) {
      expect(m, `meta.${k} 丢了`).toHaveProperty(k)
    }
  })
})
