/**
 * `agent grants` 默认有界 + 默认偏向"活的那部分"（卡 `99be5ae7`）
 *
 * ## 它治的病
 *
 * `agent grants` 是同类读命令里**默认值最重**的一个：有 `--id` / `--status` / `--active`
 * 三个筛选，却**没有 `--limit`、默认也不设边界**。实测默认回 81 条 / 66,409 字节，
 * 而其中 **0 条是活着的授权** —— 全是 expired / consumed 的历史。
 * "还挂着哪些有效授权"是这条命令的主要用途，恰恰是那份默认输出里最不显眼的部分。
 *
 * ## 修法与判据（卡上的 ①②，一起做）
 *
 * - **默认口径收窄**：不传 `--status` 就是"只看还有效的"（pending / granted 且未过期），
 *   与 `todo list` 默认只回 open 四列同一套做法；看历史传 `--status any`。
 * - **默认有界 + 自报**：`--limit`（默认 `AGENT_GRANTS_DEFAULT_LIMIT`，`0` = 全量），
 *   `meta` 给出 `matched / returned / truncated` 与"默认过滤条件"那句话。
 *
 * 判据不是"字节小了就算过"，而是：
 * **默认回执里的每一条都必须还在有效期内；且 `meta` 说的数就是这一页的数。**
 *
 * ## ⚠️ 本文件盯的两处"最容易假通过"
 *
 * 1. **恰好整除**：`matched === limit` 时不能报 `truncated`（回满一页不等于还有下一页）。
 *    所以有一条用例专门造"有效授权正好 20 条"。
 * 2. **`data` 的形状不能动**：`count` 一直是"本次回了几条"。把它改成"总条数"
 *    就是一次无声的破坏性变更（正是 `9bf9f667` 报的那类事），所以新数字只进 `meta`。
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '../../../src/main/database/migrations'
import { AgentRepository } from '../../../src/main/database/agent.repository'
import { TodoRepository } from '../../../src/main/database/todo.repository'
import { CategoryRepository } from '../../../src/main/database/category.repository'
import { ProjectRepository } from '../../../src/main/database/project.repository'
import { executeOne, buildSchema, AGENT_GRANTS_DEFAULT_LIMIT } from '../../../src/main/cli/commands'
import { buildToolRoutes, toArgv } from '../../../src/cli/mcp-tools-from-schema'
import type { SchemaCommand } from '../../../src/cli/mcp-tools-from-schema'

const db = new Database(':memory:')
vi.mock('../../../src/main/database/index', () => ({ getDatabase: () => db }))

let ctx: never

const run = (args: string[]) => executeOne(ctx, args)
const metaOf = (out: { meta?: Record<string, unknown> }) => (out.meta ?? {}) as Record<string, unknown>
const dataOf = (out: { data?: unknown }) =>
  (out.data ?? {}) as { count: number; note: string; grants: { status: string; id: string }[] }

const iso = (offsetMs: number): string => new Date(Date.now() + offsetMs).toISOString()
const HOUR = 3_600_000

/**
 * 直接落库造授权记录：要覆盖的是"呈现态"（过期的 granted 会被 `mapGrant` 呈现成 `expired`），
 * 走仓储的申请→批准那条路反而不好造"已过期"的样本。
 */
const insertGrant = (o: { id: string; status: string; expiresAt?: string | null }): void => {
  db.prepare(
    `INSERT INTO agent_grants
       (id, agent_id, scope, session_id, status, command, created_at, resolved_at, resolved_by, expires_at)
     VALUES (?, 'agent:probe', 'config', NULL, ?, 'ui set', ?, NULL, NULL, ?)`
  ).run(o.id, o.status, new Date().toISOString(), o.expiresAt ?? null)
}

/** 还有效的：pending（不设到期）/ granted（到期在未来）各一半 */
const seedActive = (n: number): void => {
  for (let i = 0; i < n; i++) {
    insertGrant(
      i % 2 === 0
        ? { id: `a-pending-${i}`, status: 'pending' }
        : { id: `a-granted-${i}`, status: 'granted', expiresAt: iso(2 * HOUR) }
    )
  }
}

/** 历史：用掉的 / 被拒的 / 被撤的（都不是"有效授权"） */
const seedHistory = (n: number): void => {
  const statuses = ['consumed', 'denied', 'revoked']
  for (let i = 0; i < n; i++) insertGrant({ id: `h-${i}`, status: statuses[i % statuses.length] })
}

/** 过期：曾经有效、到点自己失效 —— 呈现态是 `expired`，不算有效授权 */
const seedExpired = (n: number): void => {
  for (let i = 0; i < n; i++) {
    insertGrant({ id: `e-${i}`, status: 'granted', expiresAt: iso(-HOUR) })
  }
}

describe('agent grants 的默认口径（99be5ae7）', () => {
  beforeAll(() => {
    runMigrations(db)
    db.pragma('foreign_keys = OFF')
  })

  beforeEach(() => {
    db.prepare('DELETE FROM agent_grants').run()
    ctx = {
      deps: {
        agentRepo: new AgentRepository(),
        todoRepo: new TodoRepository(),
        categoryRepo: new CategoryRepository(),
        projectRepo: new ProjectRepository(),
        memoRepo: { list: () => [] },
        settingsRepo: { get: () => ({}) },
        events: { append: () => {} },
        telemetry: { record: () => {} }
      },
      meta: { version: '1.0.107', dbPath: ':memory:', schemaVersion: 45, via: 'pipe' },
      interactive: true,
      actor: 'human'
    } as never
  })

  it('默认只回还有效的：60 条历史不再灌进默认回执', async () => {
    seedActive(3)
    seedHistory(60)

    const def = await run(['agent', 'grants'])
    const m = metaOf(def as never)
    expect(m.matched, '符合"还有效"的只有 3 条').toBe(3)
    expect(m.returned).toBe(3)
    expect(m.truncated).toBe(false)
    for (const g of dataOf(def as never).grants) {
      expect(['pending', 'granted'], `默认回执里不该出现 ${g.status}`).toContain(g.status)
    }

    // 全量那条路仍然通：--status any
    const all = await run(['agent', 'grants', '--status', 'any', '--limit', '0'])
    expect(metaOf(all as never).matched).toBe(63)
    expect(dataOf(all as never).grants.length).toBe(63)

    // 量级：默认回执必须显著小于"把历史一起拉"的那份（卡上的 66KB → 246B 就是这件事）
    const bytes = (x: unknown): number => Buffer.byteLength(JSON.stringify(x))
    expect(
      bytes(all),
      `默认 ${bytes(def)} 字节 vs 全量 ${bytes(all)} 字节 —— 默认没有真的收窄`
    ).toBeGreaterThan(bytes(def) * 5)
  })

  it('过期的不算有效：曾经 granted、到点自己失效的同样被默认排除', async () => {
    seedActive(2)
    seedExpired(4)

    const def = await run(['agent', 'grants'])
    expect(metaOf(def as never).matched).toBe(2)
    /**
     * ⚠️ 比**集合**，不比顺序（1.0.109 修卡 `1486836d`）。
     *
     * `insertGrant` 每条各自取 `new Date()`：实测**约一成的运行里两条会落在不同毫秒**
     * （探针 200 次：22 次跨毫秒），而跨毫秒时 `ORDER BY created_at DESC` 把后建的
     * 排在前面是**正确**的 —— 写死顺序的断言在那 22 次里必红（这正是"十次里红两三次"）。
     * 本用例要断言的从来是"**哪两条**还算有效"，顺序不在其中。
     *
     * "同一时刻创建的两条，回执顺序必须可预测"另见
     * `grants-order-stable-1486836d.test.ts`（兜底键 `id DESC`）。
     */
    expect(
      dataOf(def as never).grants.map((g) => g.id).sort(),
      '默认只该剩下这两条还有效的'
    ).toEqual(['a-granted-1', 'a-pending-0'])

    // 但它是审计信息，不许被永久藏掉：--status expired 能查回来
    const expired = await run(['agent', 'grants', '--status', 'expired'])
    expect(metaOf(expired as never).matched).toBe(4)
  })

  it('默认有界：超过上限就截断，并且 meta 说得出"还有多少"', async () => {
    seedActive(30)

    const def = await run(['agent', 'grants'])
    expect(metaOf(def as never).matched).toBe(30)
    expect(metaOf(def as never).returned).toBe(AGENT_GRANTS_DEFAULT_LIMIT)
    expect(metaOf(def as never).truncated).toBe(true)

    const five = await run(['agent', 'grants', '--limit', '5'])
    expect(metaOf(five as never).matched).toBe(30)
    expect(metaOf(five as never).returned).toBe(5)
    expect(metaOf(five as never).truncated).toBe(true)

    const full = await run(['agent', 'grants', '--limit', '0'])
    expect(metaOf(full as never).returned).toBe(30)
    expect(metaOf(full as never).truncated).toBe(false)
  })

  /**
   * **恰好整除**是这条判据最容易假通过的地方：正好回满一页时，
   * "数组长度 === limit"这条推断会说还有下一页，而其实已经到底了。
   */
  it('正好回满一页时不许说"还有更多"（靠 matched，不靠数组长度）', async () => {
    seedActive(AGENT_GRANTS_DEFAULT_LIMIT)

    const def = await run(['agent', 'grants'])
    const m = metaOf(def as never)
    expect(m.returned).toBe(AGENT_GRANTS_DEFAULT_LIMIT)
    expect(m.returned).toBe(m.matched)
    expect(m.truncated, '正好回满一页 ≠ 还有下一页').toBe(false)
  })

  it('meta 自报四件事，且默认口径那句只在"没点口径"时出现', async () => {
    seedActive(3)
    seedHistory(10)

    const def = await run(['agent', 'grants'])
    const m = metaOf(def as never)
    const scope = String(m.defaultScope ?? '')
    expect('matched' in m).toBe(true)
    expect('returned' in m).toBe(true)
    expect('truncated' in m).toBe(true)
    expect(scope, '默认过滤条件必须写出来').toContain('只看还有效的')
    expect(scope, '要给出出路').toContain('--status any')
    expect(scope, '默认上限按真实参数生成').toContain(`默认最多 ${AGENT_GRANTS_DEFAULT_LIMIT} 条`)

    const explicit = await run(['agent', 'grants', '--limit', '5'])
    expect(String(metaOf(explicit as never).defaultScope)).toContain('本次最多 5 条')

    // 调用方自己点了口径 / 点了 --active —— 不该再啰嗦一句"默认是……"
    for (const args of [
      ['agent', 'grants', '--status', 'any'],
      ['agent', 'grants', '--status', 'consumed'],
      ['agent', 'grants', '--active']
    ]) {
      const r = await run(args)
      expect('defaultScope' in metaOf(r as never), `${args.join(' ')} 不该声明默认口径`).toBe(false)
    }
  })

  it('--active 仍是"只看有效的"，与默认同结果（旧调用方不受影响）', async () => {
    seedActive(4)
    seedHistory(6)
    seedExpired(2)

    const def = await run(['agent', 'grants'])
    const active = await run(['agent', 'grants', '--active'])
    expect(dataOf(active as never).grants).toEqual(dataOf(def as never).grants)
    expect(metaOf(active as never).matched).toBe(4)
  })

  it('data 的形状一个字没动：count 仍是"本次回了几条"', async () => {
    seedActive(30)

    const def = await run(['agent', 'grants'])
    const d = dataOf(def as never)
    expect(Array.isArray(d.grants), 'grants 必须仍是数组').toBe(true)
    expect(d.count, 'count 的旧语义是"本次回了几条"').toBe(d.grants.length)
    expect(d.count).toBe(AGENT_GRANTS_DEFAULT_LIMIT)
    expect(d.note, 'note 还在').toContain('scope=config')
    // 新数字只进 meta：把 count 改成总数就是一次无声的破坏性变更
    expect('matched' in d, '总数不许塞进 data').toBe(false)
  })

  it('--limit 不是非负整数：拒绝，不静默当全量', async () => {
    seedActive(2)
    for (const bad of ['abc', '-1', '1.5']) {
      const r = await run(['agent', 'grants', '--limit', bad])
      expect(r.ok, `--limit「${bad}」应被拒`).toBe(false)
      expect(r.errorCode).toBe('usage_error')
    }
  })

  it('命令表：声明了 --limit，--status 枚举含 any 且在说明里列全', () => {
    const spec = buildSchema() as unknown as { commands: (SchemaCommand & { name: string })[] }
    const grants = spec.commands.find((c) => c.name === 'agent grants')
    expect(grants, 'agent grants 不在命令表里').toBeTruthy()
    const flags = (grants?.args ?? []).map((a) => a.flag)
    expect(flags).toContain('--limit')
    const statusArg = (grants?.args ?? []).find((a) => a.flag === '--status')
    expect([...(statusArg?.enum ?? [])], '没有 any 就没有"看全部"的出口').toContain('any')
    // 卡上那条附注：从默认输出反推枚举值是不够的，说明里要列全
    for (const v of ['consumed', 'denied', 'revoked', 'expired']) {
      expect(String(statusArg?.desc ?? ''), `说明里没列出 ${v}`).toContain(v)
    }
  })

  it('MCP 生成链路：grants_agents 收得到 limit（同一份 schema 派生）', () => {
    const cmds = (buildSchema() as unknown as { commands: SchemaCommand[] }).commands
    const routes = buildToolRoutes(cmds as never)
    expect(toArgv('grants_agents', { status: 'any', limit: '5' }, routes)).toEqual([
      'agent',
      'grants',
      '--status=any',
      '--limit=5'
    ])
  })
})
