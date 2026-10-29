import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '../../../src/main/database/migrations'

/**
 * 对话级标识（1.0.49，修 3d6e4395）
 *
 * ── 为什么这件事值得一组测试 ──
 *
 * 主用户要找的答案是"规则给进去、十几二十轮之后 agent 还登记不登记"。
 * 这只有一个指标能回答：**同一个对话内，第 N 轮还有没有 todo add**。
 *
 * 而这条曲线此前算不出来 —— 不是没人做，是做了**没生效**：
 * `run.ts` 把 `DESKPARTNER_SESSION` 写进了 `props.sessionId`，
 * 而 `session_id` 列被 TelemetryService 硬写成"一个进程一个 uuid"。
 * 于是导出数据里 `sessionId` 永远是随机 uuid，标识只躺在 props 里，
 * 按对话归组的统计完全用不上。实测确认过这个症状。
 *
 * 这组用例钉住的是**列**（`session_id`）而不是 props ——
 * 因为统计只读列。钉 props 的话，同样的 bug 能再次通过。
 */

const db = new Database(':memory:')
vi.mock('../../../src/main/database/index', () => ({
  getDatabase: () => db
}))

const { TelemetryRepository } = await import('../../../src/main/database/telemetry.repository')
const { TelemetryService } = await import('../../../src/main/services/telemetry.service')

describe('TelemetryService.record 的会话标识', () => {
  let repo: InstanceType<typeof TelemetryRepository>
  let service: InstanceType<typeof TelemetryService>

  beforeAll(() => {
    runMigrations(db)
    repo = new TelemetryRepository()
    service = new TelemetryService(true)
  })

  beforeEach(() => {
    db.exec('DELETE FROM usage_events')
  })

  const readLast = () => repo.query({ limit: 1 })[0]

  it('显式传入对话标识时，写进 session_id 列（不是 props）', () => {
    service.record({
      actor: 'agent:alice',
      surface: 'cli',
      category: 'cli',
      event: 'invoke',
      ok: true,
      sessionId: 'dialog-abc'
    })

    const row = readLast()
    // 关键断言：读的是**列**，因为统计只读列
    expect(row.sessionId).toBe('dialog-abc')
    expect(row.props?.sessionId).toBeUndefined()
  })

  it('不传时回退到实例 uuid —— 界面侧仍是一条一进程', () => {
    service.record({
      actor: 'human',
      surface: 'kanban',
      category: 'todo',
      event: 'create',
      ok: true
    })

    const row = readLast()
    expect(row.sessionId).toBe(service.session)
    expect(row.sessionId).not.toBe('')
  })

  it('同一个对话标识的多次调用归到同一个 session —— 这正是曲线要的分组', () => {
    for (let i = 0; i < 3; i++) {
      service.record({
        actor: 'agent:alice',
        surface: 'cli',
        category: 'cli',
        event: 'invoke',
        ok: true,
        sessionId: 'dialog-same'
      })
    }
    service.record({
      actor: 'agent:alice',
      surface: 'cli',
      category: 'cli',
      event: 'invoke',
      ok: true,
      sessionId: 'dialog-other'
    })

    const s = repo.stats()
    // 4 条事件、2 个会话 —— 按对话归组才算得出来
    expect(s.total).toBe(4)
    expect(s.sessions).toBe(2)

    const same = repo.query({ limit: 100 }).filter((r) => r.sessionId === 'dialog-same')
    expect(same).toHaveLength(3)
  })

  it('空白标识视为没传（不能造出一个 "" 会话）', () => {
    service.record({
      actor: 'human',
      surface: 'cli',
      category: 'cli',
      event: 'invoke',
      ok: true,
      sessionId: '   '
    })

    const row = readLast()
    expect(row.sessionId).toBe(service.session)
  })

  it('传 null 也回退到实例 uuid（不炸、不写空）', () => {
    service.record({
      actor: 'human',
      surface: 'cli',
      category: 'cli',
      event: 'invoke',
      ok: true,
      sessionId: null
    })
    expect(readLast().sessionId).toBe(service.session)
  })
})
