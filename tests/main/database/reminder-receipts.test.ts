import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '../../../src/main/database/migrations'
import { ReminderReceiptRepository } from '../../../src/main/database/reminder-receipt.repository'

const db = new Database(':memory:')
vi.mock('../../../src/main/database/index', () => ({ getDatabase: () => db }))

/** 未声明会话时的兜底记账键：从实现取，别在测试里抄一遍字面量 */
const NO_SESSION = ReminderReceiptRepository.NO_SESSION_KEY

describe('会话提醒快照', () => {
  beforeAll(() => runMigrations(db))
  beforeEach(() => db.prepare('DELETE FROM cli_reminder_receipts').run())
  it('同会话相同摘要跨仓储实例只展开一次，变化时重新展开', () => {
    expect(new ReminderReceiptRepository().shouldExpand('agent:a', 's1', '有1条')).toBe(true)
    expect(new ReminderReceiptRepository().shouldExpand('agent:a', 's1', '有1条')).toBe(false)
    expect(new ReminderReceiptRepository().shouldExpand('agent:a', 's1', '有2条')).toBe(true)
  })
  it('不同身份或会话互不压制', () => {
    const r = new ReminderReceiptRepository()
    r.shouldExpand('agent:a', 's1', '待处理')
    expect(r.shouldExpand('agent:b', 's1', '待处理')).toBe(true)
    expect(r.shouldExpand('agent:a', 's2', '待处理')).toBe(true)
  })
  it('清空后再次出现同一内容必须重新提醒', () => {
    const r = new ReminderReceiptRepository()
    r.shouldExpand('agent:a', 's1', '待处理')
    expect(r.shouldExpand('agent:a', 's1', '')).toBe(false)
    expect(r.shouldExpand('agent:a', 's1', '待处理')).toBe(true)
  })
  /**
   * 1.0.111（卡 `48f4e326`）：**未声明会话时也记账**。
   *
   * 1.0.106 的复现是"连续两条命令的 notice 完全相同，照旧每条重复推" ——
   * 因为绝大多数调用方根本不声明 `DESKPARTNER_SESSION`，旧判据等于把这条机制关着。
   * 新判据：同一身份、同一批内容只推一次；内容一变立刻重推。
   */
  it('没有会话声明时按"同一身份"记账：同一批只推一次，内容一变重推', () => {
    const r = new ReminderReceiptRepository()
    expect(r.shouldExpand('agent:a', undefined, '待处理')).toBe(true)
    expect(r.shouldExpand('agent:a', undefined, '待处理')).toBe(false)
    expect(r.shouldExpand('agent:a', undefined, '待处理：多了一条')).toBe(true)
    // 身份之间仍互不压制
    expect(r.shouldExpand('agent:b', undefined, '待处理：多了一条')).toBe(true)
    // 兜底键与真实会话号互不干扰（两行各记各的）
    expect(r.shouldExpand('agent:a', 's1', '待处理：多了一条')).toBe(true)
    const rows = db
      .prepare('SELECT session_id FROM cli_reminder_receipts WHERE actor = ?')
      .all('agent:a')
      .map((x) => (x as { session_id: string }).session_id)
      .sort()
    expect(rows).toEqual([NO_SESSION, 's1'])
  })

  it('snooze：把当前这一批标成已知晓，而内容一变照旧推', () => {
    const r = new ReminderReceiptRepository()
    expect(r.markSeen('agent:a', undefined, '你有 3 条指派')).toEqual({
      changed: true,
      same: false,
      key: NO_SESSION
    })
    expect(r.shouldExpand('agent:a', undefined, '你有 3 条指派')).toBe(false)
    // 同一批重复 snooze：不是"又标记了一批"
    expect(r.markSeen('agent:a', undefined, '你有 3 条指派').changed).toBe(false)
    // 内容变了 → 重新推（snooze 不会把后来的东西一起吞掉）
    expect(r.shouldExpand('agent:a', undefined, '你有 4 条指派')).toBe(true)
  })

  it('snooze 空摘要不算标记了一批', () => {
    const r = new ReminderReceiptRepository()
    expect(r.markSeen('agent:a', 's1', '').changed).toBe(false)
  })

  it('有数据的旧库升级保留原有数据并可重复运行迁移', () => {
    db.prepare("INSERT INTO settings (key, value) VALUES ('test-preserve', '原有数据') ON CONFLICT(key) DO NOTHING").run()
    // 模拟尚未应用36迁移的有数据35版库；升级与重入均不得丢失已有行。
    db.exec('DROP TABLE cli_reminder_receipts; UPDATE _schema_version SET version = 35')
    runMigrations(db)
    runMigrations(db)
    expect(db.prepare("SELECT value FROM settings WHERE key = 'test-preserve'").get()).toEqual({ value: '原有数据' })
    expect(db.prepare('SELECT COUNT(*) AS n FROM cli_reminder_receipts').get()).toEqual({ n: 0 })
  })
})
