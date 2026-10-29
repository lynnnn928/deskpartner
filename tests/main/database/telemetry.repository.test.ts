import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '../../../src/main/database/migrations'

const db = new Database(':memory:')
vi.mock('../../../src/main/database/index', () => ({
  getDatabase: () => db
}))

/**
 * stats 为什么必须单独测
 *
 * 1.0.38 把它从"读全表到内存里统计"改成了 SQL 聚合。这类改动最怕的
 * 不是算错，而是**统计口径悄悄变了**：界面上「共 N 条」与下面列表的
 * 长度对不上，或者时间跨度指的是全表而不是当前筛选的这几条 ——
 * 都是看单个数字发现不了、只有对照着断言才暴露的问题。
 */
const { TelemetryRepository } = await import('../../../src/main/database/telemetry.repository')

describe('TelemetryRepository.stats', () => {
  let repo: InstanceType<typeof TelemetryRepository>

  beforeAll(() => {
    runMigrations(db)
    repo = new TelemetryRepository()
  })

  beforeEach(() => {
    db.exec('DELETE FROM usage_events')
  })

  const seed = (n: number, opts: { ok?: boolean; dur?: number | null; session?: string } = {}) => {
    for (let i = 0; i < n; i++) {
      repo.record({
        sessionId: opts.session ?? 's1',
        actor: 'human',
        surface: 'cli',
        category: 'cli',
        event: 'invoke',
        ok: opts.ok,
        durationMs: opts.dur ?? null,
        props: { i }
      })
    }
  }

  it('空表不炸，各维度都是零值', () => {
    const s = repo.stats()
    expect(s.total).toBe(0)
    expect(s.failed).toBe(0)
    expect(s.firstTs).toBeNull()
    expect(s.lastTs).toBeNull()
    expect(s.durationMs).toBeNull()
  })

  it('基本计数：总量、会话去重、失败数', () => {
    seed(3, { ok: true })
    seed(2, { ok: false })
    repo.record({ sessionId: 's2', actor: 'human', surface: 'cli', category: 'cli', event: 'invoke' })

    const s = repo.stats()
    expect(s.total).toBe(6)
    expect(s.sessions).toBe(2)
    expect(s.failed).toBe(2)
  })

  it('ok 为 null 不算失败（NULL 不是 false）', () => {
    seed(2)
    const s = repo.stats()
    expect(s.total).toBe(2)
    expect(s.failed).toBe(0)
  })

  it('byEvent 的 key 是 category.event', () => {
    seed(2)
    const s = repo.stats()
    expect(s.byEvent['cli.invoke']).toBe(2)
    expect(s.byCategory['cli']).toBe(2)
    expect(s.bySurface['cli']).toBe(2)
  })

  it('带 limit 时只统计最新那几条（不是全表）', () => {
    /**
     * 必须显式指定 ts：record() 用的是当前时刻，同一毫秒内插入的 10 条
     * 时间戳完全相同，firstTs 自然也一样 —— 那样根本验证不出"收窄"。
     */
    const ins = db.prepare(
      `INSERT INTO usage_events (ts, session_id, actor, surface, category, event, ok, duration_ms, props)
       VALUES (?, 's1', 'human', 'cli', 'cli', 'invoke', 1, NULL, NULL)`
    )
    for (let i = 0; i < 10; i++) {
      ins.run(`2026-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`)
    }

    const all = repo.stats()
    const limited = repo.stats({ limit: 3 })
    expect(all.total).toBe(10)
    // 只统计最新 3 条：跨度必须跟着收窄到 01-08 ~ 01-10
    expect(limited.total).toBe(3)
    expect(limited.firstTs).toBe('2026-01-08T00:00:00.000Z')
    expect(limited.lastTs).toBe('2026-01-10T00:00:00.000Z')
    // 全表跨度仍是 01-01 ~ 01-10
    expect(all.firstTs).toBe('2026-01-01T00:00:00.000Z')
    expect(limited.lastTs).toBe(all.lastTs)
  })

  it('分位数：p50 / p95 / max 都取自 durationMs', () => {
    // 1..10 毫秒各一条
    for (let i = 1; i <= 10; i++) {
      repo.record({
        sessionId: 's1', actor: 'human', surface: 'cli', category: 'cli',
        event: 'invoke', ok: true, durationMs: i
      })
    }
    const s = repo.stats()
    expect(s.durationMs).not.toBeNull()
    expect(s.durationMs!.max).toBe(10)
    expect(s.durationMs!.p50).toBeGreaterThanOrEqual(1)
    expect(s.durationMs!.p50).toBeLessThanOrEqual(10)
    expect(s.durationMs!.p95).toBeGreaterThanOrEqual(s.durationMs!.p50 as number)
  })

  it('筛选条件与流水列表口径一致（统计条数 = 列表长度）', () => {
    seed(4)
    repo.record({ sessionId: 's1', actor: 'human', surface: 'kanban', category: 'todo', event: 'create' })

    const filtered = { surface: 'kanban' }
    expect(repo.stats(filtered).total).toBe(1)
    expect(repo.query(filtered)).toHaveLength(1)
  })
})

/**
 * 失败分两桶（1.0.49，修 4d1dfb6e）
 *
 * 主用户手算 1876 条事件后发现：近期失败的近一半是**守卫按设计拒绝**
 * （该批的没批、该声明的没声明），不是接口误用。混在一个 failed 里
 * 会被读成"agent 用得乱七八糟"，而两者的处置方向完全相反。
 */
describe('TelemetryRepository.stats 失败分桶', () => {
  let repo: InstanceType<typeof TelemetryRepository>

  beforeAll(() => {
    runMigrations(db)
    repo = new TelemetryRepository()
  })

  beforeEach(() => {
    db.exec('DELETE FROM usage_events')
  })

  /** 记一条失败事件，带上 cmd 与 errorCode（与真实埋点同形状） */
  const fail = (cmd: string, errorCode: string) => {
    repo.record({
      sessionId: 's1',
      actor: 'agent:alice',
      surface: 'cli',
      category: 'cli',
      event: 'invoke',
      ok: false,
      props: { cmd, channel: 'headless', exitCode: 4, errorCode }
    })
  }

  it('守卫类 errorCode 进 guardRejections，不进 errors', () => {
    fail('todo rm', 'grant_required')
    fail('todo add', 'identity_required')
    fail('todo rm', 'credential_invalid')

    const s = repo.stats()
    expect(s.guardRejections.total).toBe(3)
    expect(s.errors.total).toBe(0)
    // 总量口径不变：failed 仍是两者之和
    expect(s.failed).toBe(3)
  })

  it('接口误用类进 errors，不进 guardRejections', () => {
    fail('todo add', 'usage_error')
    fail('todo get', 'not_found')
    fail('batch', 'batch_all_failed')

    const s = repo.stats()
    expect(s.guardRejections.total).toBe(0)
    expect(s.errors.total).toBe(3)
  })

  it('历史错误码 human_required 仍算守卫拒绝（1.0.47 已移除，但历史事件还在）', () => {
    fail('agent credential', 'human_required')
    const s = repo.stats()
    expect(s.guardRejections.byErrorCode['human_required']).toBe(1)
    expect(s.errors.total).toBe(0)
  })

  it('两桶各自按 cmd 与 errorCode 展开', () => {
    fail('todo rm', 'grant_required')
    fail('todo rm', 'grant_required')
    fail('project rm', 'grant_required')
    fail('todo add', 'usage_error')

    const s = repo.stats()
    expect(s.guardRejections.byCmd).toEqual({ 'todo rm': 2, 'project rm': 1 })
    expect(s.guardRejections.byErrorCode).toEqual({ grant_required: 3 })
    expect(s.errors.byCmd).toEqual({ 'todo add': 1 })
    expect(s.errors.byErrorCode).toEqual({ usage_error: 1 })
  })

  it('成功的事件不落进任何一桶', () => {
    repo.record({
      sessionId: 's1', actor: 'human', surface: 'cli', category: 'cli',
      event: 'invoke', ok: true, props: { cmd: 'todo list', errorCode: null }
    })
    fail('todo rm', 'grant_required')

    const s = repo.stats()
    expect(s.guardRejections.total + s.errors.total).toBe(1)
  })

  it('归因覆盖率：props.cmd 缺失的算"归因不上"', () => {
    // 3 条带 cmd，1 条不带（模拟 cmd 归因上线前的事件）
    fail('todo rm', 'grant_required')
    fail('todo add', 'usage_error')
    repo.record({
      sessionId: 's1', actor: 'human', surface: 'cli', category: 'cli',
      event: 'invoke', ok: false, props: { exitCode: 2, errorCode: 'usage_error' }
    })
    repo.record({
      sessionId: 's1', actor: 'human', surface: 'cli', category: 'cli',
      event: 'invoke', ok: true, props: { cmd: 'todo list' }
    })

    const s = repo.stats()
    expect(s.attributionCoverage.total).toBe(4)
    expect(s.attributionCoverage.unattributed).toBe(1)
    expect(s.attributionCoverage.rate).toBeCloseTo(0.75, 5)
  })

  it('空表时归因率记 1（空集不该读成"全都没归因"）', () => {
    const s = repo.stats()
    expect(s.attributionCoverage.total).toBe(0)
    expect(s.attributionCoverage.rate).toBe(1)
  })
})
