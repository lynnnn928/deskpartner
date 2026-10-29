/**
 * 回执里说的「最多几条」必须就是这一次生效的上限（卡 `2e948042`）
 *
 * ## 它治的病
 *
 * `todo list` 与 MCP 的 `list_todos` 是同一个能力的两个出口。CLI 直连默认 20 条，
 * 而 MCP 那边 `toArgv` 会替调用方兜上**通道侧默认** 50 条（`mcp-server.ts` 的 `DEFAULT_LIMIT`，
 * 与 `DEFAULT_ROW_LIMIT` 同源）。可回执里那句默认口径是**写死的**"默认最多返回 20 条"。
 * 实测（装着的 1.0.107，走管道）：
 *
 * | 路 | `meta.returned` | `meta.defaultScope` 那句话 | 真假 |
 * |---|---:|---|---|
 * | CLI 直连（不带 --limit） | 20 | 默认最多返回 20 条 | 真 |
 * | MCP 等效（工具映射给的 argv） | 50 | 默认最多返回 20 条 | **假** |
 *
 * 接入方按那句话判断自己是否看全，而它实际拿到的是 50 —— 与 `2e8dfa6d`（文案少点名两列）
 * 同一族：**说出口的话必须是真的**。
 *
 * ## 修法与判据
 *
 * 那句话改成**按真实参数生成**：不传 `--limit` 就说默认值（也就是生效值），
 * 传了就说本次值，不再冒充"默认"。判据两条：
 *
 * 1. **声称的上限 == 这一次生效的上限**（CLI 与 MCP 两条路各测一次）；
 * 2. **`meta.returned` 不超过声称的上限**，超过就说 `truncated`。
 *
 * MCP 那条路的 argv 取自**真的工具映射**（`TOOLS` 里 `list_todos` 的 `toArgv`），
 * 不手抄 `--limit 50` —— 抄了就会在通道默认改值时静默失效。
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
import { executeOne, TODO_LIST_DEFAULT_LIMIT } from '../../../src/main/cli/commands'
import { buildAgentGuide } from '../../../src/main/cli/agent-guide'

const { TOOLS } = await import('../../../src/cli/mcp-server')
const { DEFAULT_ROW_LIMIT } = await import('../../../src/cli/mcp-tools-from-schema')

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

const seedOpen = (n: number): void => {
  for (let i = 0; i < n; i++) {
    todos.create({ title: `第 ${i + 1} 条`, projectId: null } as never)
  }
}

const run = (args: string[]) => executeOne(ctx, args)
const metaOf = (out: { meta?: Record<string, unknown> }) => (out.meta ?? {}) as Record<string, unknown>
const scopeOf = (out: { meta?: Record<string, unknown> }) => String(metaOf(out).defaultScope ?? '')

/** 那句话里声称的上限；"全量"时返回 null */
const claimedCap = (scope: string): number | null => {
  const m = scope.match(/最多返回 (\d+) 条/)
  return m ? Number(m[1]) : null
}

/** argv 里 --limit 的值；没带时返回 null */
const argvLimit = (argv: string[]): number | null => {
  const i = argv.indexOf('--limit')
  return i === -1 ? null : Number(argv[i + 1])
}

describe('list 的条数口径：说的就是生效的（2e948042）', () => {
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

  it('CLI 直连：不传 --limit 时，那句话说的默认值就是生效上限', async () => {
    seedOpen(TODO_LIST_DEFAULT_LIMIT + 5)
    const r = await run(['todo', 'list'])
    const m = metaOf(r as never)
    expect(claimedCap(scopeOf(r as never)), '声称的上限要等于实际的默认上限').toBe(
      TODO_LIST_DEFAULT_LIMIT
    )
    expect(m.returned).toBe(TODO_LIST_DEFAULT_LIMIT)
    expect(m.truncated).toBe(true)
  })

  /**
   * MCP 那条路：argv 里带的是通道侧默认（50），也就是 CLI 直连的默认（20）**并不生效** ——
   * 那句话这时候不许再说"默认最多返回 20 条"。
   */
  it('MCP 路：工具映射给的 argv 生效上限是通道默认，那句话必须说它', async () => {
    seedOpen(DEFAULT_ROW_LIMIT + 5)
    const argv = mcpArgv({})
    const cap = argvLimit(argv)
    expect(cap, 'MCP 默认调用必须兜上一个上限，否则回执体积由数据量决定').toBe(DEFAULT_ROW_LIMIT)

    const r = await run(argv)
    const scope = scopeOf(r as never)
    expect(claimedCap(scope), '声称的上限要等于 argv 里带的上限').toBe(cap)
    expect(scope, '带了 --limit 就不再是"默认"，别冒充').not.toContain('默认最多返回')
    expect(metaOf(r as never).returned).toBe(cap)
    expect(metaOf(r as never).truncated).toBe(true)
  })

  it('显式 --limit 5：说"本次"并给出 5', async () => {
    seedOpen(10)
    const r = await run(['todo', 'list', '--limit', '5'])
    const scope = scopeOf(r as never)
    expect(claimedCap(scope)).toBe(5)
    expect(scope).toContain('--limit 5')
    expect(metaOf(r as never).returned).toBe(5)
  })

  it('--limit 0（全量）：那句话不再声称任何默认上限，returned 也不截断', async () => {
    seedOpen(25)
    const r = await run(['todo', 'list', '--limit', '0'])
    const scope = scopeOf(r as never)
    expect(claimedCap(scope), '全量时不许再报一个"最多 N 条"').toBeNull()
    expect(scope).toContain('全量')
    const m = metaOf(r as never)
    expect(m.returned).toBe(m.matched)
    expect(m.truncated).toBe(false)
  })

  /**
   * 同族的一处静默（顺手收掉）：`--limit abc` / `--limit -1` 以前按"非正数 = 全量"处理，
   * 而回执还说"最多 20 条" —— 两句话都不真。按同族命令的判据报 usage_error。
   */
  it('--limit 不是非负整数：拒绝，不静默当全量', async () => {
    seedOpen(3)
    for (const bad of ['abc', '-1', '1.5']) {
      const r = await run(['todo', 'list', '--limit', bad])
      expect(r.ok, `--limit ${bad} 应被拒`).toBe(false)
      expect(r.errorCode, `--limit ${bad} 的错误码`).toBe('usage_error')
    }
  })

  it('源码闸门：这句承诺不许再写死第二份', () => {
    const commandsSource = readCliChain()
    expect(commandsSource, '文案里不许再写死默认条数').not.toContain('不传 = 默认最多 20 条')
    expect(commandsSource, '回执文案里不许再写死默认条数').not.toContain('默认最多返回 20 条')
    expect(commandsSource, '要由参数生成').toContain('默认最多返回 ${limit} 条')

    const guideSource = read('src/main/cli/agent-guide.ts')
    for (const hardcoded of ['默认最多 50 条', '前 20 条']) {
      expect(guideSource, `说明书里不许写死「${hardcoded}」`).not.toContain(hardcoded)
    }
    expect(guideSource).toContain('默认最多 ${DEFAULT_ROW_LIMIT} 条')
    expect(guideSource).toContain('前 ${TODO_LIST_DEFAULT_LIMIT} 条')
  })

  it('说明书里那两处也来自常量（渲染出来的数字与通道默认一致）', () => {
    const guide = buildAgentGuide('C:/x/deskpartner.cjs', '9.9.9')
    expect(guide).toContain(`默认最多 ${DEFAULT_ROW_LIMIT} 条`)
    expect(guide).toContain(`前 ${TODO_LIST_DEFAULT_LIMIT} 条`)
  })
})
