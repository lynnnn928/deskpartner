/**
 * `project search` 的 `data` 回到数组、计数进顶层 `meta`（卡 `9bf9f667`）
 *
 * ## 它治的病
 *
 * 1.0.106 给 `project search` 补 `--limit` / `--offset` 时，把 `data` 从**数组**
 * 换成了 `{results, matched, returned, truncated, nextOffset}`。翻页本身是对的，
 * 但这是一次**没有通告的破坏性变更**：按数组解析的既有脚本（卡上点名的那类
 * 紧凑化工具）拿到对象后 `for` / `map` 静默走空 —— 不报错，比报错更难查。
 * 同时 `todo list` 把同样的计数放在**顶层 `meta`**，两条命令的同族信息
 * 落在两个层级，"匹配多少"要看情况记住该读哪儿。
 *
 * ## 判据（卡上的 ①②）
 *
 * 1. `data` 形状与 `todo list` 一族一致：**数组**；
 * 2. 计数/截断/翻页在**同一层级**（顶层 `meta`），键名与 `todo list` 一致。
 *
 * ## 这一版专门盯住的假通过
 *
 * "回满一页 ⇒ 还有下一页"这条推断在本文件里会**报反**：造"命中数正好等于
 * `--limit`"的数据，`truncated` 必须是 `false`、`nextOffset` 必须是 `null`。
 * 用 `results.length === limit` 判定截断的实现会在这里红。
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { readCliChain } from './cli-chain'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { runMigrations } from '../../../src/main/database/migrations'
import { TodoRepository } from '../../../src/main/database/todo.repository'
import { CategoryRepository } from '../../../src/main/database/category.repository'
import { ProjectRepository } from '../../../src/main/database/project.repository'
import { executeOne, commands } from '../../../src/main/cli/commands'
import { buildAgentGuide } from '../../../src/main/cli/agent-guide'
import { formatOutcome } from '../../../src/main/cli/output'

const { TOOLS } = await import('../../../src/cli/mcp-server')

const db = new Database(':memory:')
vi.mock('../../../src/main/database/index', () => ({ getDatabase: () => db }))

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8')

/** MCP `search_project` 在某组入参下真正会拼出的 argv —— 用真映射，不手抄 */
const mcpArgv = (params: Record<string, unknown>): string[] => {
  const tool = TOOLS.find((t) => t.name === 'search_project')
  if (!tool) throw new Error('MCP 工具 search_project 不存在')
  return tool.toArgv(params)
}

let todos: TodoRepository
let projects: ProjectRepository
let ctx: never
let projectId: string

const run = (args: string[]) => executeOne(ctx, args)
const metaOf = (out: { meta?: Record<string, unknown> }) =>
  (out.meta ?? {}) as Record<string, unknown>
const search = (extra: string[] = []) =>
  run(['project', 'search', projectId, '--query', '针叶', ...extra])

describe('project search 的形状与计数位置（9bf9f667）', () => {
  beforeAll(() => {
    runMigrations(db)
    db.pragma('foreign_keys = OFF')
  })

  beforeEach(() => {
    db.prepare('DELETE FROM todos').run()
    db.prepare('DELETE FROM projects').run()
    todos = new TodoRepository()
    projects = new ProjectRepository()
    new CategoryRepository().create({ name: '方向', color: '#111', sortOrder: 0 })
    projectId = projects.create({ name: '搜索项目' }).id
    ctx = {
      deps: {
        todoRepo: todos,
        categoryRepo: new CategoryRepository(),
        projectRepo: projects,
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

  const seed = (n: number): void => {
    for (let i = 0; i < n; i++) {
      todos.create({
        title: `针叶 ${String(i + 1).padStart(2, '0')}`,
        categoryIds: [],
        projectId,
        status: 'todo',
        skipGuards: true
      } as never)
    }
  }

  it('data 是数组 —— 按数组解析的老脚本不再静默走空', async () => {
    seed(3)
    const out = await search(['--limit', '10'])
    expect(out.ok).toBe(true)
    expect(Array.isArray(out.data), 'data 必须回到数组：对象会让 `data.map/for` 静默走空').toBe(true)
    // 真的遍历一遍 —— 这正是 1.0.106 坏掉的那个调用方式
    const rows = out.data as Array<{ snippet: string }>
    expect(rows).toHaveLength(3)
    for (const row of rows) expect(typeof row.snippet).toBe('string')
  })

  it('计数与翻页在顶层 meta，键名与 todo list 一致（同层级、同名）', async () => {
    seed(3)
    const found = await search(['--limit', '2'])
    const meta = metaOf(found)
    expect(Object.keys(meta).sort()).toEqual(['matched', 'nextOffset', 'returned', 'truncated'])

    // 键名集合必须是 `todo list` 那套的子集 —— 同族信息不许各起名字
    const listed = await run(['todo', 'list', '--limit', '1'])
    const listMetaKeys = new Set(Object.keys(metaOf(listed)))
    for (const key of Object.keys(meta)) {
      expect(listMetaKeys.has(key), `meta.${key} 与 todo list 的键名没对齐`).toBe(true)
    }
  })

  it('计数不在 data 里：命中条目上不再挂 matched/returned/truncated', async () => {
    seed(2)
    const out = await search(['--limit', '10'])
    for (const row of out.data as Array<Record<string, unknown>>) {
      for (const key of ['matched', 'returned', 'truncated', 'nextOffset']) {
        expect(key in row, `结果条目上出现了计数键 ${key} —— 同一类信息不许放两处`).toBe(false)
      }
    }
    // 顶层也不许再出现 1.0.106 那个包装对象
    expect('results' in (out.data as object)).toBe(false)
  })

  it('nextOffset 就是下一段的起点：两页拼起来无重叠、无遗漏', async () => {
    seed(5)
    // ⚠️ 这里不能写 `--limit 0` 求全量：`project search` 的 0 会被夹成 1 条
    //（`searchPage` 里 `Math.max(1, …)`），与 `todo list` / `agent grants` 的
    //「0 = 全量」不一致 —— 属另一张卡，本文件不在这里偷偷改口径。
    const all = (await search(['--limit', '100'])).data as Array<Record<string, unknown>>
    expect(all).toHaveLength(5)

    const p1 = await search(['--limit', '2'])
    expect((p1.data as unknown[]).map((r) => (r as { todoId: string }).todoId)).toEqual(
      all.slice(0, 2).map((r) => r.todoId)
    )
    const p2 = await search(['--limit', '2', '--offset', String(metaOf(p1).nextOffset)])
    expect((p2.data as unknown[]).map((r) => (r as { todoId: string }).todoId)).toEqual(
      all.slice(2, 4).map((r) => r.todoId)
    )
    expect(metaOf(p2)).toMatchObject({ matched: 5, returned: 2, truncated: true, nextOffset: 4 })
  })

  it('假通过守卫：命中数正好等于 --limit 时，truncated=false 且 nextOffset=null', async () => {
    seed(4)
    const out = await search(['--limit', '4'])
    expect(metaOf(out)).toMatchObject({
      matched: 4,
      returned: 4,
      truncated: false,
      nextOffset: null
    })
  })

  it('meta 无论是否截断都在（不必靠数数组长度推"还有没有"）', async () => {
    const empty = await search(['--limit', '10'])
    expect(metaOf(empty)).toMatchObject({ matched: 0, returned: 0, truncated: false, nextOffset: null })
    expect(empty.data).toEqual([])
  })

  it('信封层（调用方真正 parse 的那一层）：data 是数组、meta 在顶层', async () => {
    seed(2)
    const out = await search(['--limit', '10'])
    const formatted = formatOutcome(out, ['project', 'search', 'P', '--query', '针叶'], false)
    const envelope = JSON.parse(formatted.stdout) as Record<string, unknown>
    expect(Array.isArray(envelope.data)).toBe(true)
    expect(envelope.meta).toMatchObject({ matched: 2, returned: 2, truncated: false, nextOffset: null })
    expect('results' in (envelope.data as object)).toBe(false)
  })

  it('MCP 路同形：search_project 的真 argv 拼出的回执同样是数组 + 顶层 meta', async () => {
    seed(2)
    const argv = mcpArgv({ id: '搜索项目', query: '针叶', limit: 10 })
    const out = await run(argv)
    expect(out.ok).toBe(true)
    expect(Array.isArray(out.data)).toBe(true)
    expect(metaOf(out)).toMatchObject({ matched: 2, returned: 2, truncated: false, nextOffset: null })
  })

  it('结构闸门：命令实现必须把结果包成 {__meta, data}，不许把 page 对象直接当 data', () => {
    const src = readCliChain()
    const start = src.indexOf("name: 'project search'")
    expect(start, 'commands.ts 里找不到 project search').toBeGreaterThan(-1)
    // 块边界用"下一条命令的起始行"（两空格缩进的 `{` + 四空格缩进的 name），
    // 不能拿 `name: '` 找 —— 参数里的 `positional: { name: 'id' …}` 会先撞上。
    const rest = src.slice(start)
    const next = rest.search(/\r?\n {2}\{\r?\n {4}name: '/)
    const block = next === -1 ? rest : rest.slice(0, next)
    expect(block, 'project search 的 run 里没有 __meta').toContain('__meta:')
    expect(block, 'project search 仍把 page 对象整个当 data 返回').not.toContain(
      'return ctx.deps.projectRepo.searchPage(id, query, { limit, offset })'
    )
    expect(block, 'data 必须是 page.results（数组）').toContain('data: page.results')
  })

  it('提前告知：schema 的 desc 里写明形状，不跑也知道 data 是数组', () => {
    const spec = commands.find((c) => c.name === 'project search')
    expect(spec, 'project search 命令不存在').toBeTruthy()
    expect(spec?.desc ?? '').toContain('data 是命中数组')
    expect(spec?.desc ?? '').toContain('meta')
  })

  it('MCP 工具描述同步：search_project 的说明里写清命中是数组、计数在顶层 meta', () => {
    // 手工表**覆盖** schema 生成的那条（buildToolsFromSchema 里 legacy 优先），
    // 所以真正发给 MCP 宿主的是这一份描述 —— 改了实现就得改它。
    const tool = TOOLS.find((t) => t.name === 'search_project')
    expect(tool, 'MCP 工具 search_project 不存在').toBeTruthy()
    expect(tool?.description ?? '').toContain('data（数组）')
    expect(tool?.description ?? '').toContain('顶层 meta')
  })

  it('说明书与实现一致：指引读的是顶层 meta 的计数', () => {
    // ① 渲染出来的那一份 —— agent 真正读到的说明书
    const guide = buildAgentGuide('C:/x/deskpartner.cjs', '1.0.107')
    const rendered = guide
      .split('\n')
      .filter((l) => l.includes('dp project search') && l.includes('nextOffset'))
    expect(rendered.length, '渲染后的说明书里找不到 project search 的读取指引').toBeGreaterThan(0)
    for (const line of rendered) {
      expect(line, `说明书里这句没写清计数在顶层 meta：${line}`).toContain('meta')
    }

    // ② 源码里的**每一句**同款指引。两份都要查：有的句子只在 `dp guide <主题>`
    //    里渲染（渲染面看到的是子集），只查渲染会漏一整句 —— 这一版实测就是
    //    "改回无层级的 matched/nextOffset"时渲染面照样全绿。
    const srcLines = read('src/main/cli/agent-guide.ts')
      .split('\n')
      .filter((l) => l.includes('dp project search') && l.includes('nextOffset'))
    expect(srcLines.length, '源码里只找到一句同款指引？少查了一句等于漏一句').toBeGreaterThanOrEqual(2)
    for (const line of srcLines) {
      expect(line, `说明书源码里这句没写清计数在顶层 meta：${line.trim()}`).toContain('meta')
    }
  })
})
