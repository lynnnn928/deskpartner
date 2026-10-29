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
 * 默认口径必须自报（1.0.65，修 `cd854e3a`）
 *
 * 1.0.64 起 `todo list` 默认只回未完成（`--status any` 才全量）。
 * 那个默认值本身是对的，但它**静默**：
 * 跨版本写的脚本按"拉 list 数条数"得到的数与看板实际列数不一致，
 * 于是"还有 30 多张待办"这类判断的口径被打乱 —— 而**数不对时没有任何报错**。
 *
 * 判据：**默认值变了就在回执里说清默认值是什么。**
 * 同一个道理见 batch 的 `executed:false`（不 自报，调用方只能靠猜）。
 *
 * ⚠️ 只在"确实按默认过滤掉了 done"时声明 ——
 * 调用方显式传了 `--status`，那是他的口径，不该再啰嗦一句。
 */
describe('list 的默认口径要自报（cd854e3a）', () => {
  let todos: TodoRepository
  let ctx: never

  beforeAll(() => {
    runMigrations(db)
    db.pragma('foreign_keys = OFF')
  })

  beforeEach(() => {
    db.prepare('DELETE FROM todos').run()
    todos = new TodoRepository()
    new CategoryRepository().create({ name: '方向', color: '#111', sortOrder: 0 })
    new ProjectRepository().create({ name: 'P' })
    todos.create({ title: '未完成的一条', projectId: null } as never)
    todos.create({ title: '已完成的一条', projectId: null, status: 'done' } as never)
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
      meta: { version: '1.0.66', dbPath: ':memory:', schemaVersion: 25, via: 'pipe' },
      interactive: true,
      actor: 'human'
    } as never
  })

  const metaOf = (out: { meta?: Record<string, unknown> }) => (out.meta ?? {}) as Record<string, unknown>

  it('默认调用时 meta 里带 defaultScope，说清已排除 done', async () => {
    const r = await executeOne(ctx, ['todo', 'list'])
    expect(r.ok).toBe(true)
    const m = metaOf(r as never)
    expect(
      String(m.defaultScope ?? ''),
      '默认口径变了却不说 → 跨版本脚本会静默少算，且不报错'
    ).toContain('已排除 done')
  })

  it('defaultScope 要给出补救办法（只说"排除了"等于让人猜）', async () => {
    const r = await executeOne(ctx, ['todo', 'list'])
    const m = metaOf(r as never)
    expect(String(m.defaultScope)).toContain('--status any')
  })

  it('显式传 --status any 时不再声明（那是调用方的口径，不该啰嗦）', async () => {
    const r = await executeOne(ctx, ['todo', 'list', '--status', 'any'])
    expect(r.ok).toBe(true)
    const m = metaOf(r as never)
    expect(
      'defaultScope' in m,
      '显式传了还声明默认口径 → 变成噪声，调用方会开始无视它'
    ).toBe(false)
  })

  it('显式传具体状态时同样不声明', async () => {
    const r = await executeOne(ctx, ['todo', 'list', '--status', 'todo'])
    const m = metaOf(r as never)
    expect('defaultScope' in m).toBe(false)
  })

  it('既有 meta 字段一个都不能少（别为了加提示把原字段挤掉）', async () => {
    const r = await executeOne(ctx, ['todo', 'list'])
    const m = metaOf(r as never)
    for (const k of ['matched', 'returned', 'truncated', 'byStatus']) {
      expect(m, `meta.${k} 丢了`).toHaveProperty(k)
    }
  })
})
