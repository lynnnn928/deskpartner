/**
 * 「继续读取」必须真做得到：`todo list` 的 `--offset` + `meta.nextOffset`（卡 `3675f993`）
 *
 * ## 它治的病
 *
 * `todo list` 有 `--limit`、有 12 个筛选维度，**没有 `--offset`** ——
 * 而 `--limit` 的说明写着"需要继续读取时显式传 --limit"。没有偏移就"继续"不了，
 * 只能把窗口一次放大：卡上实测 `--limit 0` 是 **519 条 / 1,146,659 字节（约 1.1MB）**。
 * 也就是说"默认有界"这条纪律在这条命令上只挡住了默认值，
 * 逃生门仍然是"一次拉爆上下文"。同版的 `project search` 早就有 offset + nextOffset。
 *
 * ## 判据（卡上的 ①②③）
 *
 * 1. `todo list` 收 `--offset`，回执给 `nextOffset`；
 * 2. `--limit 20 --offset 20` 与第一页**不重叠**，拼起来就是前 40 条；
 * 3. 文档里"继续读取/全量"的措辞与实现一致（不再是"只能靠 --limit 放大窗口"）。
 *
 * ## 顺带钉住的一件事：排序必须在分页**之前**
 *
 * 原来排序写在切片之后：`--sort priority --limit 5` 实际是
 * "repo 顺序的前 5 条，再按优先级排" —— 而说明书里写的是"紧急的在前"。
 * 加上 `--offset` 之后这条更说不通：两页会各自排序，拼起来不是"排序后的前 40 条"。
 * 所以本文件的排序用例**专门用"最紧急的那条排在 repo 顺序最后"的数据**，
 * 让"先切后排"与"先排后切"给出不同答案 —— 否则这条断言是假通过。
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { runMigrations } from '../../../src/main/database/migrations'
import { TodoRepository } from '../../../src/main/database/todo.repository'
import { CategoryRepository } from '../../../src/main/database/category.repository'
import { ProjectRepository } from '../../../src/main/database/project.repository'
import { executeOne, commands, TODO_LIST_DEFAULT_LIMIT } from '../../../src/main/cli/commands'
import { buildAgentGuide } from '../../../src/main/cli/agent-guide'

const { TOOLS } = await import('../../../src/cli/mcp-server')

const db = new Database(':memory:')
vi.mock('../../../src/main/database/index', () => ({ getDatabase: () => db }))

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8')

/** MCP `list_todos` 在某组入参下真正会拼出的 argv —— 用真映射，不手抄 */
const mcpArgv = (params: Record<string, unknown>): string[] => {
  const tool = TOOLS.find((t) => t.name === 'list_todos')
  if (!tool) throw new Error('MCP 工具 list_todos 不存在')
  return tool.toArgv(params)
}

let todos: TodoRepository
let ctx: never

const seed = (n: number): void => {
  for (let i = 0; i < n; i++) {
    todos.create({ title: `第 ${String(i + 1).padStart(3, '0')} 条`, projectId: null } as never)
  }
}

const run = (args: string[]) => executeOne(ctx, args)
const metaOf = (out: { meta?: Record<string, unknown> }) => (out.meta ?? {}) as Record<string, unknown>
const titles = (out: { data?: unknown }): string[] =>
  ((out.data ?? []) as Array<{ title: string }>).map((t) => t.title)

describe('todo list 的分页：继续读取真做得到（3675f993）', () => {
  beforeAll(() => {
    runMigrations(db)
    db.pragma('foreign_keys = OFF')
  })

  beforeEach(() => {
    db.prepare('DELETE FROM todos').run()
    todos = new TodoRepository()
    new CategoryRepository().create({ name: '方向', color: '#111', sortOrder: 0 })
    new ProjectRepository().create({ name: 'P' })
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
      meta: { version: '1.0.107', dbPath: ':memory:', schemaVersion: 45, via: 'pipe' },
      interactive: true,
      actor: 'human'
    } as never
  })

  it('命令表里声明了 --offset（少了它，"继续读取"就只是句广告）', () => {
    const spec = commands.find((c) => c.name === 'todo list')
    expect(spec, 'todo list 命令不存在').toBeTruthy()
    const flags = (spec?.args ?? []).map((a) => a.flag)
    expect(flags, 'todo list 没有 --offset').toContain('--offset')
  })

  it('两页不重叠，拼起来就是前 40 条', async () => {
    seed(45)
    const all = titles(await run(['todo', 'list', '--limit', '0']))
    expect(all.length).toBe(45)

    const p1 = titles(await run(['todo', 'list', '--limit', String(TODO_LIST_DEFAULT_LIMIT)]))
    const p2 = titles(
      await run(['todo', 'list', '--limit', String(TODO_LIST_DEFAULT_LIMIT), '--offset', '20'])
    )
    expect(p1).toEqual(all.slice(0, 20))
    expect(p2).toEqual(all.slice(20, 40))
    expect(new Set([...p1, ...p2]).size, '两页有重叠 → 翻页在丢/重复给数据').toBe(40)
  })

  it('meta.nextOffset 指的就是下一段的起点；读完是 null', async () => {
    seed(45)

    const p1 = await run(['todo', 'list', '--limit', '20'])
    const m1 = metaOf(p1 as never)
    expect('offset' in m1, '键名与 project search 对齐：meta 里只有 nextOffset，不追一个同义的 offset').toBe(false)
    expect(m1.returned).toBe(20)
    expect(m1.matched).toBe(45)
    expect(m1.truncated, '后面还有 → 必须说还有').toBe(true)
    expect(m1.nextOffset, 'nextOffset 必须等于"本页起点 + 本页条数"').toBe(20)

    const p2 = await run(['todo', 'list', '--limit', '20', '--offset', '20'])
    const m2 = metaOf(p2 as never)
    expect(m2.nextOffset).toBe(40)
    expect(m2.truncated).toBe(true)

    // 最后一页：25 条以后没有了
    const p3 = await run(['todo', 'list', '--limit', '20', '--offset', '40'])
    const m3 = metaOf(p3 as never)
    expect(titles(p3 as never).length).toBe(5)
    expect(m3.truncated, '最后一页之后没有更多 —— 说 true 会让人白跑一趟').toBe(false)
    expect(m3.nextOffset).toBeNull()

    // 每一页的 nextOffset 都自洽：rowId(page1) + 20 == rowId(page2)
    expect(m1.nextOffset).toBe(20)
    expect(m2.nextOffset).toBe(m1.nextOffset! + 20)
  })

  it('--limit 0 保留为显式全量：不截断、不给下一页', async () => {
    seed(25)
    const r = await run(['todo', 'list', '--limit', '0'])
    const m = metaOf(r as never)
    expect(titles(r as never).length).toBe(25)
    expect(m.matched).toBe(25)
    expect(m.returned).toBe(25)
    expect(m.truncated).toBe(false)
    expect(m.nextOffset).toBeNull()
  })

  it('偏移越过总数：回空数组，但仍如实给出总数（不假装"没有数据"）', async () => {
    seed(5)
    const r = await run(['todo', 'list', '--offset', '99'])
    const m = metaOf(r as never)
    expect(titles(r as never)).toEqual([])
    expect(m.matched, '总数与这一页无关，不能因为翻过头就报 0').toBe(5)
    expect(m.returned).toBe(0)
    expect(m.truncated).toBe(false)
    expect(m.nextOffset).toBeNull()
  })

  it('--offset 不是非负整数：拒绝，不静默当成 0', async () => {
    seed(3)
    // 空串不在列：`Number('') === 0`，与 `--limit` 一样落回默认值 —— 那是"没给"，不是"给错"
    for (const bad of ['abc', '-1', '1.5']) {
      const r = await run(['todo', 'list', '--offset', bad])
      expect(r.ok, `--offset「${bad}」应被拒`).toBe(false)
      expect(r.errorCode, `--offset「${bad}」的错误码`).toBe('usage_error')
    }
  })

  it('排序在分页**之前**：先切后排会让"紧急的"连第一页都进不去', async () => {
    /**
     * 按 urgent → low 的顺序建，于是 repo 顺序（`created_at` 倒序，`nowVersion()` 单调）
     * 正好相反：low → urgent。**先切后排**的实现只能拿到两条低优先级，看不到 urgent。
     *
     * ⚠️ 四个优先级各不相同：并列时排序结果取决于 `sort` 的稳定性，
     * 那会让这条断言变成"看运气"，而不是看"先排还是先切"。
     */
    todos.create({ title: '紧急的', priority: 'urgent', projectId: null } as never)
    todos.create({ title: '高的', priority: 'high', projectId: null } as never)
    todos.create({ title: '普通的', priority: 'normal', projectId: null } as never)
    todos.create({ title: '低的', priority: 'low', projectId: null } as never)

    // 先把前提摆出来：不给 --sort 时就是 repo 顺序，也就是"最不紧急的在前"
    expect(await titles(await run(['todo', 'list', '--limit', '0'])), '本用例的前提：repo 顺序与优先级相反').toEqual([
      '低的',
      '普通的',
      '高的',
      '紧急的'
    ])

    const sortedAll = titles(await run(['todo', 'list', '--sort', 'priority', '--limit', '0']))
    expect(sortedAll, '排序本身要先对').toEqual(['紧急的', '高的', '普通的', '低的'])

    const p1 = titles(await run(['todo', 'list', '--sort', 'priority', '--limit', '2']))
    const p2 = titles(await run(['todo', 'list', '--sort', 'priority', '--limit', '2', '--offset', '2']))
    expect(p1, '--limit 2 拿到的必须是排好序的前 2 条').toEqual(sortedAll.slice(0, 2))
    expect(p2, '第二页接着排好的序列往下').toEqual(sortedAll.slice(2, 4))
    expect([...p1, ...p2], '先切后排时两页会各自排序，拼起来不是排序后的前 4 条').toEqual(sortedAll)
  })

  it('MCP 那条路同样能翻页：工具映射给得出 --offset', async () => {
    seed(45)
    const argv = mcpArgv({ limit: 20, offset: 20 })
    expect(argv).toContain('--offset')
    expect(argv[argv.indexOf('--offset') + 1]).toBe('20')

    const cliPage2 = titles(await run(['todo', 'list', '--limit', '20', '--offset', '20']))
    const viaMcp = titles(await run(argv))
    expect(viaMcp, '同一个工具映射要与 CLI 直连给出同一页').toEqual(cliPage2)

    const page1 = titles(await run(['todo', 'list', '--limit', '20']))
    expect(new Set([...page1, ...viaMcp]).size).toBe(40)
  })

  it('文档侧：--limit 的说明改教翻页，说明书里两个键都在', () => {
    const spec = commands.find((c) => c.name === 'todo list')
    const limitArg = (spec?.args ?? []).find((a) => a.flag === '--limit')
    expect(String(limitArg?.desc ?? ''), '--limit 的说明必须指出翻页配 --offset').toContain('--offset')
    expect(
      String(limitArg?.desc ?? ''),
      '不再教"需要继续读取时显式传 --limit"—— 那句在只有 --limit 时是做不到的事'
    ).not.toContain('需要继续读取时显式传')

    const guideSource = read('src/main/cli/agent-guide.ts')
    expect(guideSource, '说明书要有 --offset 的教程').toContain('--offset')
    expect(guideSource, '说明书要提回执给的 nextOffset').toContain('nextOffset')

    const guide = buildAgentGuide('C:/x/deskpartner.cjs', '9.9.9')
    expect(guide).toContain('--offset')
    expect(guide).toContain('nextOffset')
    // 上一批的承诺不能被这次改动推翻：那两个数字仍来自常量
    expect(guide).toContain(`前 ${TODO_LIST_DEFAULT_LIMIT} 条`)
  })
})
