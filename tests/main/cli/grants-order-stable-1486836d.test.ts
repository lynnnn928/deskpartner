/**
 * 同一时刻创建的两条授权，回执顺序必须**可预测**（卡 `1486836d`）
 *
 * ## 它治的病
 *
 * `agent grants` 的默认回执顺序一直由 `listGrants` 的
 * `ORDER BY created_at DESC` 决定 —— **只有时间，没有兜底键**。
 * 同一毫秒创建的两条，谁在前由 SQLite 自己说了算（不保证等于插入序，
 * 也随时可能随执行计划变）。这是给 agent 读的回执：要"取最新那条"、
 * 或把两次回执逐条对照时，顺序不稳就会读错人。
 *
 * ⚠️ **但抖动本身不是这个原因造成的** —— 是本卡调查中最容易搞错的一步，记在这里：
 *
 * 同族的 `tests/main/cli/agent-grants-bounded-99be5ae7.test.ts`「过期的不算有效」
 * 十次里红两三次，长这样：`expected [ 'a-granted-1', 'a-pending-0' ] to equal [ 'a-pending-0', 'a-granted-1' ]`。
 * 探针（每次清表 → 按用例的方法造两条 → 跑一次 `agent grants`，200 次）实测：
 *
 * | | 次数 |
 * |---|---|
 * | 两条落在**同一毫秒** | 178 / 200 |
 * | 回执顺序与用例期望相反 | 22 / 200 |
 *
 * 也就是说：**同一毫秒时顺序其实是稳定的（都是插入序）**，反过来的是那 22 次
 * **跨毫秒**的运行 —— 而跨毫秒时 `created_at DESC` 把后建的排前面**是正确的行为**。
 * 所以只补兜底键修不了那条用例（补了之后探针仍是 22/200），
 * 那条用例要改的是它的断言口径（比集合，不比顺序）。
 *
 * ## 本文件管的是另一件事
 *
 * **同一时刻（created_at 相同）时，回执顺序仍然可预测**：
 * 兜底键 `id DESC`（与同文件 `listGrantHistory` 的
 * `ORDER BY COALESCE(...) DESC, id DESC` 同一套做法）。
 *
 * 判据：**能算出来的顺序，不许交给数据库的隐式行为。**
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { runMigrations } from '../../../src/main/database/migrations'
import { AgentRepository } from '../../../src/main/database/agent.repository'
import { TodoRepository } from '../../../src/main/database/todo.repository'
import { CategoryRepository } from '../../../src/main/database/category.repository'
import { ProjectRepository } from '../../../src/main/database/project.repository'
import { executeOne } from '../../../src/main/cli/commands'

const db = new Database(':memory:')
vi.mock('../../../src/main/database/index', () => ({ getDatabase: () => db }))

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8')

let ctx: never
const run = (args: string[]) => executeOne(ctx, args)
const idsOf = (out: { data?: unknown }): string[] =>
  ((out.data ?? {}) as { grants: { id: string }[] }).grants.map((g) => g.id)

/** 直接落库：本文件要造的正是"created_at 一模一样"这个前提 */
const insert = (o: { id: string; status: string; createdAt: string }): void => {
  db.prepare(
    `INSERT INTO agent_grants
       (id, agent_id, scope, session_id, status, command, created_at, resolved_at, resolved_by, expires_at)
     VALUES (?, 'agent:probe', 'config', NULL, ?, 'ui set', ?, NULL, NULL, ?)`
  ).run(o.id, o.status, o.createdAt, new Date(Date.now() + 3_600_000).toISOString())
}

/** 两条同一时刻的、都还有效的授权：**插入序与 id 倒序相反**（否则这条断言是假通过） */
const seedSameInstant = (): void => {
  const t = '2026-10-21T00:00:00.000Z'
  insert({ id: 'aa-pending', status: 'pending', createdAt: t })
  insert({ id: 'zz-granted', status: 'granted', createdAt: t })
}

describe('agent grants 的顺序可预测（1486836d）', () => {
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
      meta: { version: '1.0.109', dbPath: ':memory:', schemaVersion: 45, via: 'pipe' },
      interactive: true,
      actor: 'human'
    } as never
  })

  it('同一毫秒的两条：按 id 倒序，且每次调用都一样', async () => {
    seedSameInstant()
    /** 前提先摆出来：插入序是 aa → zz（若数据库恰好给出别的顺序，这条会红，不是假通过） */
    expect(
      (db.prepare('SELECT id FROM agent_grants ORDER BY rowid ASC').all() as { id: string }[]).map(
        (r) => r.id
      ),
      '本用例的前提：aa 先插、zz 后插'
    ).toEqual(['aa-pending', 'zz-granted'])

    const first = idsOf(await run(['agent', 'grants']))
    expect(first, '同一时刻时顺序不能由数据库的隐式行为决定').toEqual(['zz-granted', 'aa-pending'])

    for (let i = 0; i < 3; i++) {
      expect(idsOf(await run(['agent', 'grants'])), `第 ${i + 2} 次调用`).toEqual(first)
    }
    /** 取一页也一样：兜底键在 SQL 里，不在 JS 的事后排序里 */
    expect(await run(['agent', 'grants', '--limit', '1']).then(idsOf)).toEqual(['zz-granted'])
  })

  it('时间不同时仍以时间优先：后建的排前面（兜底键不该盖过主键）', async () => {
    insert({ id: 'aa-pending', status: 'pending', createdAt: '2026-10-21T00:00:00.000Z' })
    insert({ id: 'zz-granted', status: 'granted', createdAt: '2026-10-21T00:00:01.000Z' })
    expect(idsOf(await run(['agent', 'grants']))).toEqual(['zz-granted', 'aa-pending'])

    // 反过来插（先 zz 后 aa，时间也是 zz 晚）—— 顺序照样由时间定
    db.prepare('DELETE FROM agent_grants').run()
    insert({ id: 'zz-granted', status: 'granted', createdAt: '2026-10-21T00:00:01.000Z' })
    insert({ id: 'aa-pending', status: 'pending', createdAt: '2026-10-21T00:00:00.000Z' })
    expect(idsOf(await run(['agent', 'grants']))).toEqual(['zz-granted', 'aa-pending'])
  })

  it('源码闸门：兜底键写在 SQL 里，且与同文件那条先例同款', () => {
    const src = read('src/main/database/agent.repository.ts')
    expect(src, 'listGrants 少了兜底次序键').toContain('ORDER BY created_at DESC, id DESC')
    expect(src, '同文件 listGrantHistory 的先例不该被顺手改掉').toContain(
      'COALESCE(resolved_at, executed_at, created_at) DESC, id DESC'
    )
    /** 兜底键不许挪到 JS 层：事后排序会让 `--limit` 截错人 */
    expect(src, '取页与排序必须在同一句 SQL 里（事后排序会先截错行）').not.toContain(
      'grants.sort('
    )
  })
})
