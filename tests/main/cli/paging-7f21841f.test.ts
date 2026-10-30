/**
 * 声明了 `--limit` 的命令都得能翻页：`memo list` / `todo inbox` / `telemetry export`（卡 `7f21841f`）
 *
 * ## 它治的病
 *
 * 同族五条命令里，`notification list` / `todo list` / `project search` 早就能翻页
 * （`--offset` + 回执里的 `nextOffset`），而**另外三条声明了 `--limit` 的翻不了**：
 *
 * - `memo list --limit 20`：截断时只说过"共 N 条，只回了前 20 条" —— 下一批从哪开始，回执不给；
 * - `todo inbox --limit 20`：同上；
 * - `telemetry export --limit 50`：同上，而且它逐行输出，连 notice 都没处放。
 *
 * 后果：这三条上的"继续读取"只能靠把窗口一次放大（`--limit 0` 拉爆上下文），
 * 或者靠"本页条数少于 limit 就到底"反推 —— 那个推断在**恰好整除**时是错的
 * （同族 `99be5ae7` 专门为它写过一条用例）。
 *
 * ## 判据（卡上的 ①~⑤）
 *
 * 1. 三条命令都声明 `--offset`，回执给出 `nextOffset`（读完是 `null`）；
 * 2. `--limit N` + `--offset N` 两页**不重不漏**，拼起来等于同一序列的前 2N 条；
 * 3. 越界回空页，但仍如实给出总数；非法值（含裸传）一律 `usage_error`；
 * 4. **读法只有一处**：`--offset` 全走 `parseOffset`，源码里不许再有手写的 `Number` 解析；
 * 5. `memo list` 的形状不许变：不传 `--offset` 且没截断时**仍然回数组**
 *    （`data` 是数组时变成对象就是同族 `9bf9f667` 那个病）。
 *
 * ## 两处容易假通过的地方
 *
 * - `memo list` 的计数只落在"截断时才有的包装"里。若哪天顺手把非截断那条也包起来，
 *   本文件的"形状"用例会红 —— 那正是要它红的。
 * - `telemetry export` 没有信封，**终点判据只能靠"回空页"**。
 *   若它的说明里出现"本页少于 limit 就到底"，用例会红（那条在整除时是错的）。
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
import { MemoRepository } from '../../../src/main/database/memo.repository'
import { CommentRepository } from '../../../src/main/database/comment.repository'
import { NotificationRepository } from '../../../src/main/database/notification.repository'
import { ReminderReceiptRepository } from '../../../src/main/database/reminder-receipt.repository'
import { RulesRepository } from '../../../src/main/database/rules.repository'
import { ProtocolRepository } from '../../../src/main/database/protocol.repository'
import { ProfileRepository } from '../../../src/main/database/profile.repository'
import { TelemetryRepository } from '../../../src/main/database/telemetry.repository'
import { executeOne, commands, parseOffset } from '../../../src/main/cli/commands'
import { buildAgentGuide } from '../../../src/main/cli/agent-guide'
import { buildSchema } from '../../../src/main/cli/commands'
import {
  buildToolRoutes,
  generateMcpTools,
  toArgv,
  type SchemaCommand
} from '../../../src/cli/mcp-tools-from-schema'
import { z } from 'zod'

const db = new Database(':memory:')
vi.mock('../../../src/main/database/index', () => ({ getDatabase: () => db }))

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8')

/** 本轮新补上 `--offset` 的三条（卡上点名的） */
const NEWLY_PAGED = ['memo list', 'todo inbox', 'telemetry export']

let ctx: never
let todos: TodoRepository
let memos: MemoRepository
let comments: CommentRepository
let telemetry: TelemetryRepository

const run = (args: string[]) => executeOne(ctx, args)
const listOf = (out: { data?: unknown }): unknown[] => (out.data ?? []) as unknown[]
const metaOf = (out: { meta?: Record<string, unknown> }) => (out.meta ?? {}) as Record<string, unknown>
/** `todo inbox` 的回执本来就是对象（不是数组）—— 字段在 `data` 里 */
const inboxOf = (out: { data?: unknown }) =>
  (out.data ?? {}) as {
    total: number
    returned: number
    truncated: boolean
    nextOffset: number | null
    items: Array<{ commentId: string }>
  }

describe('分页族：声明了 --limit 就得能翻页（7f21841f）', () => {
  beforeAll(() => {
    runMigrations(db)
    db.pragma('foreign_keys = OFF')
  })

  beforeEach(() => {
    for (const t of ['todos', 'todo_comments', 'memos', 'usage_events', 'projects', 'categories']) {
      db.prepare(`DELETE FROM ${t}`).run()
    }
    todos = new TodoRepository()
    memos = new MemoRepository()
    comments = new CommentRepository()
    telemetry = new TelemetryRepository()
    new CategoryRepository().create({ name: '方向', color: '#111', sortOrder: 0 })
    new ProjectRepository().create({ name: 'P' })

    ctx = {
      deps: {
        todoRepo: todos,
        categoryRepo: new CategoryRepository(),
        projectRepo: new ProjectRepository(),
        /* 卡 69788c32：命令层要读哪个仓储由 deps 决定 —— 缺一个，跑到那条命令就炸 */
        commentRepo: new CommentRepository(),
        notificationRepo: new NotificationRepository(),
        reminderReceiptRepo: new ReminderReceiptRepository(),
        rulesRepo: new RulesRepository(),
        protocolRepo: new ProtocolRepository(),
        profileRepo: new ProfileRepository(),
        memoRepo: memos,
        settingsRepo: { get: () => ({}) },
        agentRepo: { countGrants: () => 0, listGrants: () => [] },
        events: { append: () => {} },
        /**
         * ⚠️ `record` 必须是空操作：真写进去的话，本文件里"翻页拿到哪几条"
         * 的数字会随每次调用自己漂（同 `limit-zero` 那条的做法）。
         * `query` 走**真仓储**，因为这一条要证明的正是"OFFSET 下推到了 SQL"。
         */
        telemetry: {
          record: () => {},
          query: (filter: unknown) => telemetry.query(filter as never)
        }
      },
      meta: { version: '1.0.108', dbPath: ':memory:', schemaVersion: 45, via: 'pipe' },
      interactive: true,
      actor: 'agent:carol'
    } as never
  })

  /** 造 n 条待我回应的评论（每条挂一条自己的事项） */
  const seedInbox = (n: number): void => {
    for (let i = 0; i < n; i++) {
      const t = todos.create({
        title: `事项 ${String(i).padStart(2, '0')}`,
        categoryIds: [],
        projectId: null,
        status: 'todo',
        skipGuards: true
      } as never)
      comments.create({
        todoId: t.id,
        body: `@我一下 ${i}`,
        authorType: 'agent',
        authorId: 'agent:alice',
        recipient: 'agent:carol'
      } as never)
    }
  }

  const seedMemos = (n: number): void => {
    for (let i = 0; i < n; i++) {
      memos.create({ author: 'agent:alice', text: `纸条 ${String(i).padStart(2, '0')}` })
    }
  }

  const seedTelemetry = (n: number): void => {
    for (let i = 0; i < n; i++) {
      telemetry.record({
        sessionId: 's-probe',
        actor: 'agent:carol',
        surface: 'cli',
        category: 'cli',
        event: `probe.${String(i).padStart(2, '0')}`
      })
    }
  }

  it('命令表闸门：三条命令都声明了 --offset，且说明里写了"下一页从哪来"', () => {
    for (const name of NEWLY_PAGED) {
      const spec = commands.find((c) => c.name === name)
      expect(spec, `${name} 命令不存在`).toBeTruthy()
      const flags = (spec?.args ?? []).map((a) => a.flag)
      expect(flags, `${name} 没有 --offset`).toContain('--offset')
      const desc = String((spec?.args ?? []).find((a) => a.flag === '--offset')?.desc ?? '')
      expect(desc.length, `${name} 的 --offset 说明是空的`).toBeGreaterThan(20)
      if (name === 'telemetry export') {
        /**
         * 逐行输出没有信封 —— 它的终点判据必须写在说明里，且**不许**教那条错的
         * （"本页少于 limit 就到底"在恰好整除时是错的）。
         */
        expect(desc, '要说清怎么判断读到底了').toContain('回空')
      } else {
        expect(desc, `${name} 的 --offset 说明要指出回执里的 nextOffset`).toContain('nextOffset')
      }
    }
  })

  it('结构闸门：全族只有一处 --offset 解析（parseOffset），不许再手写 Number', () => {
    const declared = commands.filter((c) => (c.args ?? []).some((a) => a.flag === '--offset'))
    expect(
      declared.map((c) => c.name).sort(),
      '声明了 --offset 的命令集合变了 —— 这张表要跟着走'
    ).toEqual(
      [
        'memo list',
        'notification list',
        'project get',
        'project search',
        'telemetry export',
        'todo inbox',
        'todo list'
      ].sort()
    )
    const src = readCliChain()
    const calls = src.split("parseOffset(flags['--offset']").length - 1
    expect(calls, 'parseOffset 的调用点数必须等于"声明了 --offset 的命令数"').toBe(declared.length)
    expect(
      src,
      '还留着旧的 Number 解析 —— 裸传 --offset 时它会静默变成 1'
    ).not.toContain("Number(flags['--offset'])")
  })

  it('裸传与非法值：一律 usage_error，不静默当成 0 或 1', async () => {
    const argvOf: Record<string, string[]> = {
      'notification list': ['notification', 'list'],
      'todo list': ['todo', 'list'],
      'project search': ['project', 'search', 'P', '--query', '针叶'],
      'project get': ['project', 'get', 'P'],
      'memo list': ['memo', 'list'],
      'todo inbox': ['todo', 'inbox'],
      'telemetry export': ['telemetry', 'export']
    }
    for (const c of commands.filter((x) => (x.args ?? []).some((a) => a.flag === '--offset'))) {
      const base = argvOf[c.name]
      if (!base) throw new Error(`新命令 ${c.name} 声明了 --offset，本表没跟上`)
      for (const bad of ['abc', '-1', '1.5']) {
        const r = await run([...base, '--offset', bad])
        expect(r.ok, `${c.name} --offset ${bad} 不该跑成功`).toBe(false)
        expect(r.errorCode, `${c.name} --offset ${bad} 的错误码`).toBe('usage_error')
        expect(String(r.message), `${c.name} --offset ${bad} 要说清怎么传`).toContain(
          '--offset 需要非负整数'
        )
      }
      /**
       * ⚠️ **裸传**（`--offset` 后面没有值）：`parseFlags` 给的是布尔 `true`，
       * 旧的手写解析里 `Number(true) === 1` 会过掉校验 —— 静默从第 2 条开始给。
       * 这是本卡顺带收掉的那处静默，必须报错。
       */
      const bare = await run([...base, '--offset'])
      expect(bare.ok, `${c.name} 裸传 --offset 不该被当成 1`).toBe(false)
      expect(bare.errorCode).toBe('usage_error')
    }
  })

  it('单元层：parseOffset 的语义与报错', () => {
    expect(parseOffset(undefined, 'x')).toBe(0)
    expect(parseOffset('0', 'x')).toBe(0)
    expect(parseOffset('7', 'x')).toBe(7)
    expect(parseOffset(7, 'x')).toBe(7)
    for (const bad of ['abc', '-1', '1.5']) {
      expect(() => parseOffset(bad, 'x'), `--offset ${bad}`).toThrow(/非负整数/)
    }
    // 裸传的布尔 true 也要被拒（旧写法在这里静默变成 1）
    expect(() => parseOffset(true, 'x')).toThrow(/非负整数/)
  })

  it('todo inbox：三页不重不漏，读完 nextOffset 是 null', async () => {
    seedInbox(25)
    /** ⚠️ `todo inbox` 的回执**本来就是对象**（`{total, items, …}`）—— 字段在 `data` 里 */
    const all = inboxOf(await run(['todo', 'inbox', '--limit', '0'])).items
    expect(all.length).toBe(25)

    const p1 = inboxOf(await run(['todo', 'inbox', '--limit', '10']))
    expect(p1.items.length).toBe(10)
    expect(p1.total).toBe(25)
    expect(p1.returned).toBe(10)
    expect(p1.truncated).toBe(true)
    expect(p1.nextOffset, 'nextOffset 必须是"本页起点 + 本页条数"').toBe(10)

    const p2 = inboxOf(await run(['todo', 'inbox', '--limit', '10', '--offset', '10']))
    expect(p2.nextOffset).toBe(20)
    expect(p2.truncated).toBe(true)

    const p3 = inboxOf(await run(['todo', 'inbox', '--limit', '10', '--offset', '20']))
    expect(p3.items.length).toBe(5)
    expect(p3.truncated, '最后一页之后没有更多 —— 说 true 会让人白跑一趟').toBe(false)
    expect(p3.nextOffset).toBeNull()

    const seen = [...p1.items, ...p2.items, ...p3.items]
    expect(seen.map((c) => c.commentId), '三页拼起来就是同一序列的前 25 条').toEqual(
      all.map((c) => c.commentId)
    )
    expect(new Set(seen.map((c) => c.commentId)).size, '两页有重叠 → 翻页在重复给数据').toBe(25)
  })

  it('todo inbox：偏移越过总数 —— 回空页，但仍如实给出总数', async () => {
    seedInbox(5)
    const r = inboxOf(await run(['todo', 'inbox', '--offset', '99']))
    expect(r.items).toEqual([])
    expect(r.total, '总数与这一页无关，不能因为翻过头就报 0').toBe(5)
    expect(r.returned).toBe(0)
    expect(r.truncated).toBe(false)
    expect(r.nextOffset).toBeNull()
  })

  it('memo list：截断时给 meta.nextOffset，notice 里那句可以直接照抄', async () => {
    seedMemos(25)
    const all = listOf(await run(['memo', 'list', '--limit', '0'])) as Array<{ id: string }>
    expect(all.length).toBe(25)

    const p1 = (await run(['memo', 'list', '--limit', '10'])) as never
    expect(listOf(p1).length).toBe(10)
    expect(metaOf(p1).matched).toBe(25)
    expect(metaOf(p1).returned).toBe(10)
    expect(metaOf(p1).truncated).toBe(true)
    expect(metaOf(p1).nextOffset).toBe(10)
    expect(String(p1.notice), 'notice 要给出下一页该传的数').toContain('--offset 10')

    const p2 = (await run(['memo', 'list', '--limit', '10', '--offset', '10'])) as never
    /**
     * 最后一页：**回数组、没有 meta** —— 这正是它"读完了"的信号。
     * 形状不许动，所以 `meta` 只能在"截断时那层包装"里出现，不能为了对称
     * 把非截断那条也包起来（那会让老调用方 `map` 静默走空）。
     */
    const p3 = (await run(['memo', 'list', '--limit', '10', '--offset', '20'])) as never
    expect(Array.isArray(p3.data), '读完的那一页仍是数组').toBe(true)
    expect('meta' in p3, '没截断就不该有 meta').toBe(false)
    expect(listOf(p3).length).toBe(5)

    const seen = [...listOf(p1), ...listOf(p2), ...listOf(p3)] as Array<{ id: string }>
    expect(seen.map((m) => m.id)).toEqual(all.map((m) => m.id))
    expect(new Set(seen.map((m) => m.id)).size).toBe(25)
  })

  it('memo list：不截断时 data 仍是数组（形状一个字没动）', async () => {
    seedMemos(3)
    const plain = await run(['memo', 'list'])
    expect(Array.isArray(plain.data), 'data 变对象会让老调用方 map 静默走空').toBe(true)
    expect(listOf(plain).length).toBe(3)
    expect('meta' in plain, '没截断就不该冒出 meta').toBe(false)

    const wide = await run(['memo', 'list', '--limit', '30'])
    expect(Array.isArray(wide.data), '--limit 大于总数时也不许把数组包起来').toBe(true)
    expect(listOf(wide).length).toBe(3)

    const brief = await run(['memo', 'list', '--brief', '--limit', '30'])
    expect(Array.isArray(brief.data)).toBe(true)

    const paged = await run(['memo', 'list', '--limit', '2', '--offset', '1'])
    expect(Array.isArray(paged.data), '截断时 data 仍是数组（只是多了顶层 meta/notice）').toBe(true)
    expect(listOf(paged).length).toBe(2)
  })

  it('telemetry export：--offset 下推到 SQL —— 先定顺序，再切片', async () => {
    seedTelemetry(25)
    const all = telemetry.query({}) as Array<{ id: number; event: string }>
    expect(all.length).toBe(25)

    const ids = (out: { data?: unknown }): number[] =>
      (listOf(out) as Array<{ id: number }>).map((e) => e.id)

    /** 默认取最新的 N 条（结果仍按时间正序） */
    const newest10 = await run(['telemetry', 'export', '--limit', '10'])
    expect(ids(newest10)).toEqual(all.slice(-10).map((e) => e.id))
    /** 跳过最新的 10 条 → 再往前 10 条（翻旧账） */
    const newest10b = await run(['telemetry', 'export', '--limit', '10', '--offset', '10'])
    expect(ids(newest10b), '先在 SQL 里切片，再翻回正序；顺序若落在切片之后，两页会重叠').toEqual(
      all.slice(-20, -10).map((e) => e.id)
    )
    /** `--oldest` 也一样：方向由 order 定，切的是**排好序之后**的序列 */
    const oldest10 = await run(['telemetry', 'export', '--oldest', '--limit', '10'])
    expect(ids(oldest10)).toEqual(all.slice(0, 10).map((e) => e.id))
    const oldest10b = await run(['telemetry', 'export', '--oldest', '--limit', '10', '--offset', '10'])
    expect(ids(oldest10b)).toEqual(all.slice(10, 20).map((e) => e.id))

    /**
     * 只传 `--offset`（没有 `--limit`）：跳过**排在最前面的** 5 条（= 最新的 5 条），
     * 其余全给 —— 25 − 5 = 20 条，仍按时间正序。SQL 侧是 `LIMIT -1 OFFSET ?`
     * （SQLite 里 -1 = 不限，且 `OFFSET` 必须跟 `LIMIT` 一起出现）。
     */
    const skipped = await run(['telemetry', 'export', '--offset', '5'])
    expect(ids(skipped)).toEqual(all.slice(0, 20).map((e) => e.id))
    expect(listOf(skipped).length, '没有 --limit 就不该顺手截断').toBe(20)
  })

  it('telemetry export：翻到空页就是到底（NDJSON 没有 nextOffset）', async () => {
    seedTelemetry(25)
    const beyond = await run(['telemetry', 'export', '--limit', '10', '--offset', '25'])
    expect(listOf(beyond), '越过总数回空页 —— 这是它唯一能给的"读完了"信号').toEqual([])

    const beyond2 = await run(['telemetry', 'export', '--offset', '25'])
    expect(listOf(beyond2)).toEqual([])

    /** 恰好整除（25 = 10 + 10 + 5 之后再来一页空）—— 空就是空，不靠长度反推 */
    const last = await run(['telemetry', 'export', '--oldest', '--limit', '5', '--offset', '20'])
    expect(listOf(last).length).toBe(5)
    const after = await run(['telemetry', 'export', '--oldest', '--limit', '5', '--offset', '25'])
    expect(listOf(after).length).toBe(0)
  })

  it('MCP 那条路也翻得动：三个工具都收得到 offset，且拼得出 --offset', () => {
    const cmds = (buildSchema() as unknown as { commands: SchemaCommand[] }).commands
    const tools = generateMcpTools(cmds, z)
    const routes = buildToolRoutes(cmds as never)
    const pairs: Array<[string, string]> = [
      ['list_memos', 'memo list'],
      ['inbox_todos', 'todo inbox'],
      ['export_telemetry', 'telemetry export']
    ]
    for (const [toolName, cmdName] of pairs) {
      const tool = tools.find((t) => t.name === toolName)
      expect(tool, `MCP 工具 ${toolName} 不存在（命令 ${cmdName} 被排除了？）`).toBeTruthy()
      expect(
        Object.keys(tool?.input ?? {}),
        `${toolName} 的入参里没有 offset —— CLI 补了、通道没补，"继续读取"在 MCP 那条路上仍然做不到`
      ).toContain('offset')
      const argv = toArgv(toolName, { offset: 5, limit: 10 }, routes)
      expect(argv, `${toolName} 没把 offset 拼进 argv`).toContain('--offset=5')
    }
  })

  it('说明书：三条命令的翻页口径都写到了', () => {
    const guide = buildAgentGuide('C:/x/deskpartner.cjs', '9.9.9')
    expect(guide).toContain('--offset')
    expect(guide, 'telemetry 的终点判据（回空页）').toContain('回空页')
    expect(guide, 'memo list 的翻页要写在说明书里').toContain('memo list')
    const src = read('src/main/cli/agent-guide.ts')
    expect(src).toContain('nextOffset')
  })
})
