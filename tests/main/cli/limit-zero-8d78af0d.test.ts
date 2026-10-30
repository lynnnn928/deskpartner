/**
 * `--limit 0` 在全族只有一种含义（卡 `8d78af0d`）
 *
 * ## 它治的病
 *
 * 同一个参数值，四条同族命令各有各的含义（装着的 1.0.107 实测）：
 *
 * | 命令 | `--limit 0` | 实测 |
 * |---|---|---|
 * | `todo list` | 全量 | 112 条 |
 * | `project get` | 全量 | 553 条 |
 * | `project search` | **1 条** | `matched: 195`、`returned: 1` |
 * | `notification list` | 报错 | `--limit 需要正整数` |
 *
 * （最后那一行是**当时**的状态：1.0.107 修 `329c7bab` 之后它也归队了。）
 *
 * 说明书**公开教过**"要全量传 `--limit 0`"（`todo list` 那一节），于是学会这条的
 * 调用方在 `project search` 上会**少拿 194 条且不报错** —— 回执里 `matched: 195`
 * 与 `returned: 1` 并排出现，看着像"就筛出一条"。这正是同族 `9bf9f667` 刚修过的
 * 那类"文档这么教、实现那么做"。
 *
 * ## 判据
 *
 * 1. **`0` 只有一种含义**：不做条数收窄（全量）。全族由 `parseLimit` 一处解析、
 *    `takeLimit` 一处切片，说明里都写明这句话；
 * 2. 真做不到"不收窄"的命令（列表本身有硬上限）**明确报错**，并在说明里写明
 *    `不接受 0` 与原因 —— 静默换一个含义才是要治的病。
 *    ⚠️ 1.0.107 修 `329c7bab` 之后，族里**没有一条命令还需要这个例外**：
 *    `notification list` 是最后一条（它当年写死 `list(200)`），窗口下推后它的 0 也归队。
 *    所以本文件的立场从"族里允许有一个例外"改成"**族内不许再有例外**" ——
 *    哪天真有命令做不到，就在这里补一条点名的用例，而不是把例外悄悄加回去；
 * 3. 顺带收掉的同族静默：`--limit abc` / `-1` / `1.5` 过去在 `memo list` / `todo inbox` /
 *    `telemetry export` 上被悄悄当成"全量"（对着装着的 1.0.107 实测），现在一律 `usage_error`。
 *    同族的 `project get` 本来就有非负校验，行为没变。
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
import {
  executeOne,
  commands,
  parseLimit,
  takeLimit,
  LIMIT_ZERO_DOC,
  LIMIT_ZERO_REJECT_DOC
} from '../../../src/main/cli/commands'

const db = new Database(':memory:')
vi.mock('../../../src/main/database/index', () => ({ getDatabase: () => db }))

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8')

let ctx: never
let projectId: string
let todoId: string
let seenTelemetry: Array<Record<string, unknown>> = []

const run = (args: string[]) => executeOne(ctx, args)

/** 回执里"回了几条"—— 各命令形状不同，取一个统一的读法（读不出来就报错，不猜） */
const countOf = (data: unknown): number => {
  if (Array.isArray(data)) return data.length
  const o = (data ?? {}) as Record<string, unknown>
  if (Array.isArray(o.notifications)) return o.notifications.length
  if (Array.isArray(o.items)) return o.items.length
  if (Array.isArray(o.transitions)) return o.transitions.length
  if (Array.isArray(o.revisions)) return o.revisions.length
  if (Array.isArray(o.grants)) return o.grants.length
  if (o.overview && Array.isArray((o.overview as { items: unknown[] }).items)) {
    return (o.overview as { items: unknown[] }).items.length
  }
  if (Array.isArray((o.data as unknown[]) ?? undefined)) return (o.data as unknown[]).length
  /**
   * `work next`（卡 ce43b4ba）是**多桶**回执：该动 / 可领 / 等人 / 挂起。
   * "回了几条"= 各桶之和 —— 0 与不传应当一样多。
   */
  if (['recommend', 'available', 'waiting', 'blocked'].every((k) => Array.isArray(o[k]))) {
    return (['recommend', 'available', 'waiting', 'blocked'] as const).reduce(
      (n, k) => n + (o[k] as unknown[]).length,
      0
    )
  }
  throw new Error(`读不出条数，回执形状：${JSON.stringify(o).slice(0, 120)}`)
}

describe('--limit 0 的族内含义（8d78af0d）', () => {
  beforeAll(() => {
    runMigrations(db)
    db.pragma('foreign_keys = OFF')
  })

  beforeEach(() => {
    for (const t of [
      'todos',
      'todo_comments',
      'todo_transitions',
      'memos',
      'notifications',
      'projects',
      'categories'
    ]) {
      db.prepare(`DELETE FROM ${t}`).run()
    }
    const todos = new TodoRepository()
    const projects = new ProjectRepository()
    new CategoryRepository().create({ name: '方向', color: '#111', sortOrder: 0 })
    projectId = projects.create({ name: 'P' }).id
    todoId = todos.create({
      title: '针叶 锚点事项',
      categoryIds: [],
      projectId,
      status: 'todo',
      skipGuards: true
    } as never).id
    // 25 条：比 `todo list` 的默认 20 条多，才能让 "0 = 全量" 与默认区分开
    for (let i = 0; i < 25; i++) {
      todos.create({
        title: `针叶 ${String(i).padStart(2, '0')}`,
        categoryIds: [],
        projectId,
        status: 'todo',
        skipGuards: true
      } as never)
    }
    const memos = new MemoRepository()
    memos.create({ author: 'agent:carol', text: '备忘一' })
    memos.create({ author: 'agent:carol', text: '备忘二', recipient: 'agent:alice' })
    memos.create({ author: 'agent:alice', text: '备忘三' })
    const notifications = new NotificationRepository()
    for (let i = 0; i < 25; i++) {
      notifications.create({ type: 'review', title: `通知 ${i}` })
    }
    new CommentRepository().create({
      todoId,
      body: '等我回一句',
      authorType: 'agent',
      authorId: 'agent:alice',
      recipient: 'human'
    })

    seenTelemetry = []
    ctx = {
      deps: {
        todoRepo: todos,
        categoryRepo: new CategoryRepository(),
        projectRepo: projects,
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
        telemetry: {
          record: () => {},
          query: (filter: Record<string, unknown>) => {
            seenTelemetry.push(filter)
            return []
          }
        }
      },
      meta: { version: '1.0.107', dbPath: ':memory:', schemaVersion: 45, via: 'headless' },
      interactive: true,
      actor: 'human'
    } as never
  })

  /** 每个声明了 `--limit` 的命令：怎么调一次 */
  const family = (): Array<{ name: string; argv: string[] }> => {
    const argvOf: Record<string, string[]> = {
      'todo list': ['todo', 'list', '--project', 'P'],
      'todo inbox': ['todo', 'inbox'],
      'todo history': ['todo', 'history', todoId],
      'project get': ['project', 'get', 'P'],
      'project search': ['project', 'search', 'P', '--query', '针叶'],
      'project handoff-history': ['project', 'handoff-history', 'P'],
      'memo list': ['memo', 'list'],
      'notification list': ['notification', 'list'],
      'telemetry export': ['telemetry', 'export'],
      'agent grants': ['agent', 'grants'],
      'work next': ['work', 'next']
    }
    return commands
      .filter((c) => (c.args ?? []).some((a) => a.flag === '--limit'))
      .map((c) => {
        const argv = argvOf[c.name]
        if (!argv) throw new Error(`新命令 ${c.name} 声明了 --limit，本表没跟上`)
        return { name: c.name, argv }
      })
  }

  it('枚举闸门：每个声明 --limit 的命令都在说明里写明了 0 的含义，且族内不许有例外', () => {
    const list = family()
    expect(list.length, '声明 --limit 的命令数不对了？').toBeGreaterThanOrEqual(10)
    for (const c of list) {
      const desc = String(
        (commands.find((x) => x.name === c.name)?.args ?? []).find((a) => a.flag === '--limit')?.desc
      )
      expect(desc, `${c.name} 的 --limit 说明没写 0 的含义：${desc.slice(0, 40)}`).toContain(
        LIMIT_ZERO_DOC
      )
      /**
       * `LIMIT_ZERO_REJECT_DOC` 还在导出（`parseLimit` 的 `zero: 'reject'` 留着当落点），
       * 但**没有哪条命令该再用它** —— 谁用了，谁就是在宣告"我做不到全量"。
       */
      expect(
        desc,
        `${c.name} 又拿"${LIMIT_ZERO_REJECT_DOC}"当例外了 —— 先在这里点名说清，再讨论放不放行`
      ).not.toContain(LIMIT_ZERO_REJECT_DOC)
    }
  })

  it('结构闸门：全族只有一处解析（parseLimit）与一处切片（takeLimit）', () => {
    const src = readCliChain()
    const calls = src.split("parseLimit(flags['--limit']").length - 1
    expect(calls, 'parseLimit 的调用点数必须等于"声明了 --limit 的命令数"').toBe(family().length)
    expect(src, '还留着旧的 Number(flags[...]) 解析 —— 那正是"同一个 0 好几种含义"的来源').not.toContain(
      "Number(flags['--limit'])"
    )
    // 切片口径也不许各写各的（`todo history` 的 `slice(-limit)` 是"取最后 N 条"，不在此列）
    expect(src).not.toContain('rows = rows.slice(0, limit)')
    expect(src).not.toContain('memos = memos.slice(0, limit)')
  })

  it('族内一律：每一条 --limit 0 都必须真的跑得通（族内没有例外）', async () => {
    for (const c of family()) {
      const res = await run([...c.argv, '--limit', '0'])
      expect(res.ok, `${c.name} --limit 0 不该失败：${res.message ?? ''}`).toBe(true)
    }
  })

  it('project search --limit 0 = 全部命中（卡上报的就是它：静默夹成 1 条）', async () => {
    const one = await run(['project', 'search', 'P', '--query', '针叶', '--limit', '1'])
    expect(countOf(one.data)).toBe(1)

    const zero = await run(['project', 'search', 'P', '--query', '针叶', '--limit', '0'])
    expect(zero.ok).toBe(true)
    const matched = (zero.meta as { matched: number }).matched
    expect(countOf(zero.data), '0 必须是全量，不是被夹成的 1 条').toBe(matched)
    expect(countOf(zero.data)).toBeGreaterThan(1)
    expect((zero.meta as { truncated: boolean }).truncated).toBe(false)
    expect((zero.meta as { nextOffset: number | null }).nextOffset).toBeNull()
  })

  it('全族：--limit 0 不比"不传"少（默认有界的命令正好被这条抓住）', async () => {
    const full = family()
    expect(full.length, '全量族至少该有 10 条命令').toBeGreaterThanOrEqual(10)
    for (const c of full) {
      const plain = await run(c.argv)
      const zero = await run([...c.argv, '--limit', '0'])
      expect(zero.ok, `${c.name} --limit 0 失败：${zero.message ?? ''}`).toBe(true)
      expect(
        countOf(zero.data),
        `${c.name}：--limit 0 比不传还少，说明 0 又被夹成别的数了`
      ).toBeGreaterThanOrEqual(countOf(plain.data))
    }
  })

  it('默认口径没被顺手改掉：不传仍是各命令自己那个默认', async () => {
    expect(countOf((await run(['todo', 'list', '--project', 'P'])).data), 'todo list 默认仍是 20').toBe(20)
    expect(countOf((await run(['notification', 'list'])).data), 'notification list 默认仍是 20').toBe(20)
    expect(countOf((await run(['memo', 'list'])).data), 'memo list 默认仍是全部').toBe(3)
    expect(countOf((await run(['project', 'get', 'P'])).data), 'project get 不传=不给清单').toBe(0)
  })

  it('顺带收掉的同族静默：--limit 的非法值一律 usage_error，不许悄悄当全量', async () => {
    for (const bad of ['abc', '-1', '1.5']) {
      for (const c of family()) {
        const res = await run([...c.argv, '--limit', bad])
        expect(res.ok, `${c.name} --limit ${bad} 不该跑成功`).toBe(false)
        expect(res.errorCode, `${c.name} --limit ${bad} 的错误码`).toBe('usage_error')
      }
    }
  })

  it('telemetry export 把 0 原样传给仓储（仓储层 0 = 不设上限）', async () => {
    await run(['telemetry', 'export', '--limit', '0'])
    expect(seenTelemetry.at(-1)?.limit, '0 被改写成别的值就等于换了含义').toBe(0)
    await run(['telemetry', 'export'])
    expect(seenTelemetry.at(-1)?.limit, '不传 → undefined（仓储用自己的默认窗口）').toBeUndefined()
  })

  it('notification list 也归队了：--limit 0 回全部命中，不再报"不接受 0"', async () => {
    // 底数不写死：这一层里别的命令也会顺手写通知，写死了就会随环境漂
    const matched = new NotificationRepository().listPage().matched
    expect(matched, '本用例的前提是通知比默认 20 条多').toBeGreaterThan(20)
    const zero = await run(['notification', 'list', '--limit', '0'])
    expect(zero.ok, `--limit 0 不该再报错：${zero.message ?? ''}`).toBe(true)
    expect(countOf(zero.data), '0 = 全量（修 329c7bab 之前这里是 usage_error）').toBe(matched)
    const plain = await run(['notification', 'list'])
    expect(countOf(plain.data), '归队的是 0，不是默认：不传仍是 20').toBe(20)
  })

  it('单元层：parseLimit / takeLimit 的语义与报错', () => {
    expect(parseLimit(undefined, 'x')).toBeUndefined()
    expect(parseLimit('0', 'x')).toBe(0)
    expect(parseLimit('7', 'x')).toBe(7)
    expect(() => parseLimit('abc', 'x')).toThrow(/非负整数/)
    expect(() => parseLimit('-2', 'x')).toThrow(/非负整数/)
    expect(() => parseLimit('1.5', 'x')).toThrow(/非负整数/)
    expect(() => parseLimit('0', 'x', { zero: 'reject', why: '有硬上限' })).toThrow(/不接受 0/)

    const rows = ['a', 'b', 'c']
    expect(takeLimit(rows, undefined)).toHaveLength(3)
    expect(takeLimit(rows, 0)).toHaveLength(3)
  })

  /**
   * 通道侧（MCP）与命令行是同一件事的两个出口：这里也得认 0，说明里也得写明。
   * 只测手工工具表 —— 生成工具的描述直接来自命令自己的 schema，天然同源。
   */
  it('MCP 手工工具表的 limit 也认 0，说明里写明（通道侧别自己再挡一遍）', async () => {
    const { TOOLS } = await import('../../../src/cli/mcp-server')
    const withLimit = TOOLS.filter((t) => 'limit' in t.input)
    expect(withLimit.map((t) => t.name).sort()).toEqual([
      'get_project',
      'list_handoff_revisions',
      'list_todos',
      'search_project'
    ])
    for (const t of withLimit) {
      const schema = t.input.limit
      expect(schema.safeParse(0).success, `${t.name} 的 limit 不接受 0 —— 通道侧就断了一条`).toBe(true)
      expect(schema.safeParse(5).success).toBe(true)
      expect(schema.safeParse(-1).success, `${t.name} 的 limit 不该接受负数`).toBe(false)
      expect(String(schema.description ?? ''), `${t.name} 的 limit 说明没写 0 的含义`).toContain('0 = 全量')
    }
  })

  /**
   * 说明书那句"全族同一个含义"必须跟着命令表走：**列了谁**是真话。
   *
   * 只断言"这句话在"是不够的 —— 漏掉一条命令，读者按说明书学到的口径就少一条，
   * 正是这张卡要治的"文档这么教、实现那么做"。所以逐条点名。
   */
  it('说明书那句"全族同一个含义"点名了每个命令，且不再有例外', () => {
    const src = read('src/main/cli/agent-guide.ts')
    const line = src.split(/\r?\n/).find((l) => l.includes('全族同一个含义'))
    expect(line, '说明书里那句"全族同一个含义"不见了').toBeTruthy()
    const tick = (s: string): string => '\\`' + s + '\\`'
    for (const c of family()) {
      expect(line as string, `说明书那句没点名 ${c.name}`).toContain(tick(c.name))
    }
    /**
     * 族里没有例外了：那句里不该再有"只有 X 不接受 0"的子句。
     * 谁把它加回来，这条就会红 —— 加例外是**行为变更**，得在说明书里点名。
     */
    expect(line as string, '说明书那句里又出现了"不接受 0"的例外子句').not.toContain(
      LIMIT_ZERO_REJECT_DOC
    )
    expect(line as string, '说明书那句还在引已删掉的 NOTIFICATION_LIST_CAP').not.toContain(
      'NOTIFICATION_LIST_CAP'
    )
  })
})
