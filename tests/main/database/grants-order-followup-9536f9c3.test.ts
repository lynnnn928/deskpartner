/**
 * 同一时刻的两条授权，谁算数必须**可预测**（卡 `9536f9c3`，接 `1486836d`）
 *
 * ## 它治的病
 *
 * `1486836d` 修的是 `listGrants` 的回执顺序（`agent grants` 那条路）。
 * 同一件事在 `src/main/database/agent.repository.ts` 里还剩 4 处：
 * 三处是那张卡点名的"剩下三处"，它们各自在**平局时给出一个结论**，
 * 而结论此前由 SQLite 的隐式顺序决定 —— 同一份库、同样的调用，两次可能不一样：
 *
 * | 方法 | 谁在读这个结论 | 平局时跳的是什么 |
 * |---|---|---|
 * | `findUsableGrant` | 门禁（`commands.ts`）+「批准即执行」（`ipc.ts`） | 同刻两条都可用时，**用掉哪条** |
 * | `findAnyUsableGrant` | `agent whoami` 自报 | 报长期牌还是本会话牌、上次 `ok` 还是 `error` |
 * | `findLatestGrant` | `agent whoami` 说"为什么没有可用牌" | 同刻一条 `consumed` 一条 `denied` 时，说的是哪一句 |
 * | `list()` | `agents` 表的清单 | 同刻注册的两个身份谁在前 |
 *
 * 第四处（`list()`）不是那张卡点名的三处之一，是**本卡顺带收的**：同一文件、
 * 同一类问题。收干净之后源码闸门才能写成**无例外**的一句（见本文件最后一条用例）——
 * 留一处例外，例外就会掩盖下一处新增。
 *
 * ## 判据
 *
 * **能算出来的顺序，不许交给数据库的隐式行为。**
 *
 * 兜底键用 `id`（与同文件 `listGrants` / `listGrantHistory` 同一套做法），
 * 方向与主键同向：`DESC` 配 `, id DESC`、`ASC` 配 `, id ASC`。
 * 不用 `rowid`：这两张表的主键是 TEXT，`rowid` 只是隐藏列、`VACUUM` 之后可以重编号，
 * 它不是一个稳的次序（库里 `memo` / `notification` 用的是 `rowid` 那一套，
 * 本卡不动它们）。
 *
 * ⚠️ 兜底键必须写在 SQL 里，不能改成取回后再 JS 排序：`LIMIT 1` 会**先**截错行，
 * 事后再排已经晚了（最后一条用例把这个限制也闸住）。
 *
 * ## 本文件怎么证明"以前是错的"
 *
 * 每条断言都跑**两种插入序**（`aa` 先 / `zz` 先）。改前两者结果不同 ——
 * SQLite 的隐式顺序就是扫描顺序，谁先插谁在前；改后必须一致。
 * 这样用例在版本回退时会红，而不是"恰好通过"。
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

/** 平局的前提：两条授权的 `created_at` **一模一样** */
const INSTANT = '2026-10-21T03:00:00.000Z'
const AGENT = 'agent:probe'
const SESSION = 'sess-tie'

type SeedGrant = {
  id: string
  scope?: string
  sessionId?: string | null
  status?: string
  command?: string | null
  targets?: string[] | null
  execStatus?: 'ok' | 'error' | null
  execError?: string | null
  createdAt?: string
  expiresAt?: string | null
}

/** 直接落库：本文件要造的正是"同一毫秒、两种插入序"这两个前提 */
const insertGrant = (o: SeedGrant): void => {
  db.prepare(
    `INSERT INTO agent_grants
       (id, agent_id, scope, session_id, status, command, target_ids,
        created_at, resolved_at, resolved_by, expires_at, exec_status, exec_error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`
  ).run(
    o.id,
    AGENT,
    o.scope ?? 'config',
    o.sessionId ?? null,
    o.status ?? 'granted',
    o.command === undefined ? 'ui set' : o.command,
    o.targets ? JSON.stringify(o.targets) : null,
    o.createdAt ?? INSTANT,
    o.expiresAt === undefined ? new Date(Date.now() + 3_600_000).toISOString() : o.expiresAt,
    o.execStatus ?? null,
    o.execError ?? null
  )
}

/** 清表后按给定顺序插入两条：先插的那条是"扫描顺序在前"的那条 */
const seedInOrder = (a: SeedGrant, b: SeedGrant): void => {
  db.prepare('DELETE FROM agent_grants').run()
  insertGrant(a)
  insertGrant(b)
}

/** 前提自检：插入序 == rowid 序，否则下面两组对照就不是"插入序相反" */
const rowidOrder = (): string[] =>
  (db.prepare('SELECT id FROM agent_grants ORDER BY rowid ASC').all() as { id: string }[]).map(
    (r) => r.id
  )

let repo: AgentRepository
let ctx: never
const run = (args: string[]) => executeOne(ctx, args)

describe('同一时刻的两条授权，谁算数必须可预测（9536f9c3）', () => {
  beforeAll(() => {
    runMigrations(db)
    db.pragma('foreign_keys = OFF')
  })

  beforeEach(() => {
    db.prepare('DELETE FROM agent_grants').run()
    db.prepare('DELETE FROM agents').run()
    repo = new AgentRepository()
    ctx = {
      deps: {
        agentRepo: repo,
        todoRepo: new TodoRepository(),
        categoryRepo: new CategoryRepository(),
        projectRepo: new ProjectRepository(),
        memoRepo: { list: () => [] },
        settingsRepo: { get: () => ({}) },
        events: { append: () => {} },
        telemetry: { record: () => {} }
      },
      meta: { version: '1.0.109', dbPath: ':memory:', schemaVersion: 45, via: 'pipe' },
      /** 门禁与自检只在**非交互**（agent 经管道调用）时才有话可说 */
      interactive: false,
      actor: AGENT,
      session: SESSION
    } as never
  })

  it('findUsableGrant：同刻两条都可用时，用掉 id 倒序那条，且与插入序无关', () => {
    const older = { id: 'aa-plain', command: 'ui set' }
    const newer = { id: 'zz-plain', command: 'ui set' }

    seedInOrder(older, newer)
    expect(rowidOrder(), '前提：aa 先插').toEqual(['aa-plain', 'zz-plain'])
    expect(
      repo.findUsableGrant(AGENT, 'config', SESSION, 'ui set', [])?.id,
      '同一时刻时用掉哪条不能由数据库的隐式顺序决定'
    ).toBe('zz-plain')

    seedInOrder(newer, older)
    expect(rowidOrder(), '前提：这次 zz 先插（插入序反过来）').toEqual(['zz-plain', 'aa-plain'])
    expect(
      repo.findUsableGrant(AGENT, 'config', SESSION, 'ui set', [])?.id,
      '插入序反过来，结论必须一样'
    ).toBe('zz-plain')
  })

  it('findUsableGrant：兜底键不许打断"目标不符就跳过"（同刻两条里挑对得上的那条）', async () => {
    /**
     * 这是 `findUsableGrant` 取多条而不是 `LIMIT 1` 的原因：为她批过 A、又批过 B 时，
     * 排在前面那条目标不符，后面那条才是本次能用的。补兜底键若顺手改成 `LIMIT 1`，
     * 门禁就会变成"有牌但不认目标"—— 这条用例专门看住它。
     */
    const wrongTargets = { id: 'zz-other', targets: ['t-other'] }
    const rightTargets = { id: 'aa-mine', targets: ['t-mine'] }

    seedInOrder(wrongTargets, rightTargets)
    expect(repo.findUsableGrant(AGENT, 'config', SESSION, 'ui set', ['t-mine'])?.id).toBe('aa-mine')

    seedInOrder(rightTargets, wrongTargets)
    expect(repo.findUsableGrant(AGENT, 'config', SESSION, 'ui set', ['t-mine'])?.id).toBe('aa-mine')
  })

  it('findAnyUsableGrant：同刻两条仍有效时，自报 id 倒序那条，且与插入序无关', () => {
    const longLived = {
      id: 'aa-longlived',
      sessionId: null,
      execStatus: 'ok' as const,
      execError: null
    }
    const failed = {
      id: 'zz-failed',
      sessionId: SESSION,
      execStatus: 'error' as const,
      execError: '上一次删除失败'
    }

    seedInOrder(longLived, failed)
    expect(repo.findAnyUsableGrant(AGENT, 'config', SESSION)).toEqual({
      sessionId: SESSION,
      execStatus: 'error',
      execError: '上一次删除失败'
    })

    seedInOrder(failed, longLived)
    expect(
      repo.findAnyUsableGrant(AGENT, 'config', SESSION),
      '插入序反过来，自报的那条必须一样'
    ).toEqual({ sessionId: SESSION, execStatus: 'error', execError: '上一次删除失败' })
  })

  it('findLatestGrant：同刻一条 consumed 一条 denied 时，"为什么没有牌"说的是 id 倒序那条', () => {
    const consumed = { id: 'aa-consumed', status: 'consumed', scope: 'destructive' }
    const denied = { id: 'zz-denied', status: 'denied', scope: 'destructive' }

    seedInOrder(consumed, denied)
    expect(repo.findLatestGrant(AGENT, 'destructive')?.status).toBe('denied')

    seedInOrder(denied, consumed)
    expect(repo.findLatestGrant(AGENT, 'destructive')?.status).toBe('denied')
  })

  it('agent whoami 自检：同刻两条时的结论不随插入序跳', async () => {
    const longLived = {
      id: 'aa-longlived',
      sessionId: null,
      execStatus: 'ok' as const,
      execError: null
    }
    const failed = {
      id: 'zz-failed',
      sessionId: SESSION,
      execStatus: 'error' as const,
      execError: '上一次删除失败'
    }

    type Whoami = {
      scopes: { config: string }
      scopeDetails: { config: { state: string; detail: string | null } }
    }

    seedInOrder(longLived, failed)
    const first = (await run(['agent', 'whoami'])).data as Whoami
    /** 两条都还可用，但"本会话牌 + 上次失败"和"长期牌 + 可用"是两句不同的话 */
    expect(first.scopes.config).toBe('session')
    expect(first.scopeDetails.config.state).toBe('retryable')

    seedInOrder(failed, longLived)
    const second = (await run(['agent', 'whoami'])).data as Whoami
    expect(second.scopes.config, '插入序反过来，自检结论必须一样').toBe('session')
    expect(second.scopeDetails.config.state).toBe('retryable')
  })

  it('list()：同刻注册的两个身份按 id 正序，且与插入序无关', () => {
    const insertAgent = (id: string): void => {
      db.prepare(
        `INSERT INTO agents (id, display_name, color, approved, created_at, last_seen_at)
         VALUES (?, ?, NULL, 1, ?, NULL)`
      ).run(id, id, INSTANT)
    }
    const idOrder = (): string[] =>
      (
        db.prepare('SELECT id FROM agents ORDER BY rowid ASC').all() as { id: string }[]
      ).map((r) => r.id)

    db.prepare('DELETE FROM agents').run()
    insertAgent('agent:zz')
    insertAgent('agent:aa')
    expect(idOrder(), '前提：zz 先插（与 id 正序相反）').toEqual(['agent:zz', 'agent:aa'])
    expect(
      repo.list().map((a) => a.id),
      '同一时刻注册时谁在前不能由数据库的隐式顺序决定'
    ).toEqual(['agent:aa', 'agent:zz'])

    db.prepare('DELETE FROM agents').run()
    insertAgent('agent:aa')
    insertAgent('agent:zz')
    expect(repo.list().map((a) => a.id), '插入序反过来，结论必须一样').toEqual([
      'agent:aa',
      'agent:zz'
    ])
  })

  it('源码闸门：这个文件里所有 ORDER BY created_at 都带同向兜底键，且兜底键不在 JS 层', () => {
    const src = read('src/main/database/agent.repository.ts')

    const all = [...src.matchAll(/ORDER BY created_at (ASC|DESC)/g)]
    expect(all.length, '处数变了就要回来改这张卡的说明（现在是 4 处新建 + listGrants 那 1 处）').toBe(5)

    const missing = [...src.matchAll(/ORDER BY created_at (ASC|DESC)(?!, id \1)/g)].map((m) => m[0])
    expect(missing, '这些排序缺兜底次序键（DESC 配 , id DESC；ASC 配 , id ASC）').toEqual([])

    /** 先例不该被顺手改掉 */
    expect(src).toContain('COALESCE(resolved_at, executed_at, created_at) DESC, id DESC')

    /** 兜底键不许挪到 JS 层：`LIMIT 1` 会先截错行，事后再排已经晚了 */
    expect(src, '排序只能写在 SQL 里').not.toContain('.sort(')
  })
})
