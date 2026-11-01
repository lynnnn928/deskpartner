import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '../../../src/main/database/migrations'
import { MemoRepository } from '../../../src/main/database/memo.repository'
import { NotificationRepository } from '../../../src/main/database/notification.repository'

/**
 * 备忘的已读归属：**主用户先点开、agent 事后 ack**（卡 `20dc1a2e`）
 *
 * ## 治的病
 *
 * `memo ack` 走的 `markReadByRef` 原来只更新 `status = 'unread'` 的行。于是
 * 「她在界面点开过（行已 read、`read_by` 只有 human）→ agent 事后处理」这种顺序下，
 * agent 永远进不了 `read_by`，`5fd2b595` 给她的那个「谁处理了」出口就会显示
 * 「无人接手」——**与她自己的记忆相反**，而这是最难判断的场景（她看过、又问过别人）。
 *
 * ## 两条写方的分工（也是这个文件要钉住的）
 *
 * - `memo ack`（`markReadByRef`）：追加读者 **并且** 翻全局已读位 = 「接手了」；
 * - `notification list --ack-mine`（`markReadBy`）：只追加读者 = 「看过了」。
 *   「待接手」那一档取的正是"已了结 or 有非人类读者"，所以这两条必须各自归位。
 */
const db = new Database(':memory:')
vi.mock('../../../src/main/database/index', () => ({ getDatabase: () => db }))

const memoRepo = () => new MemoRepository()
const noteRepo = () => new NotificationRepository()

type Row = { id: string; status: string; read_by: string | null; read_at: string | null }
const noteRow = (memoId: string): Row =>
  db.prepare('SELECT id, status, read_by, read_at FROM notifications WHERE ref_id = ?').get(memoId) as Row

/** 造一条「两个 agent 之间」的备忘：它会同时落一条收件箱通知（ref_id = 备忘 id） */
const createMemo = (text = '这条口信给谁处理一下') =>
  memoRepo().create({ author: 'agent:carol', recipient: 'agent:bob', text })

describe('备忘已读归属（卡 20dc1a2e）', () => {
  beforeAll(() => {
    runMigrations(db)
  })

  beforeEach(() => {
    db.prepare('DELETE FROM notifications').run()
    db.prepare('DELETE FROM memos').run()
  })

  it('① 我先点开、agent 事后 ack：两个读者都在，全局状态与已读时间不被后来者改写', () => {
    const memo = createMemo()
    const GUiReadAt = '2026-11-01T02:00:00.000Z'
    // 界面点开：翻状态 + 记 human（照 NotificationsView 那条路的两件事）
    noteRepo().markReadBy(noteRow(memo.id).id, 'human')
    db.prepare(`UPDATE notifications SET status = 'read', read_at = ? WHERE ref_id = ?`).run(
      GUiReadAt,
      memo.id
    )
    expect(noteRow(memo.id).read_by).toBe('human')

    memoRepo().ack(memo.id, 'agent:bob')

    const after = noteRow(memo.id)
    expect(after.read_by).toBe('human,agent:bob')
    expect(after.status).toBe('read')
    expect(after.read_at, '已读时间属于先读的那个人，后来者不许改写').toBe(GUiReadAt)
  })

  it('② 重复 ack 幂等：读者不重复、已读时间不动', () => {
    const memo = createMemo()
    db.prepare(`UPDATE notifications SET status = 'read', read_at = ? WHERE ref_id = ?`).run(
      '2026-11-01T02:00:00.000Z',
      memo.id
    )
    db.prepare(`UPDATE notifications SET read_by = 'human' WHERE ref_id = ?`).run(memo.id)

    memoRepo().ack(memo.id, 'agent:bob')
    const first = noteRow(memo.id)
    memoRepo().ack(memo.id, 'agent:bob')
    const second = noteRow(memo.id)

    expect(second.read_by).toBe('human,agent:bob')
    expect(second.read_by).toBe(first.read_by)
    expect(second.read_at).toBe(first.read_at)
  })

  it('③ 两条写方各归各档：只 --ack-mine 仍算「待接手」，memo ack 之后才落地', () => {
    const memo = createMemo()
    const rowId = noteRow(memo.id).id

    // `notification list --ack-mine`：只追加读者，不翻全局位
    noteRepo().markReadBy(rowId, 'agent:dave')
    let row = noteRow(memo.id)
    expect(row.read_by).toBe('agent:dave')
    expect(row.status, '--ack-mine 不等于有人接手').toBe('unread')
    expect(noteRepo().inboxPage({ unhandled: true }).rows.map((r) => r.id)).toContain(rowId)

    // `memo ack`：翻全局位 + 追加读者
    memoRepo().ack(memo.id, 'agent:bob')
    row = noteRow(memo.id)
    expect(row.status).toBe('read')
    expect(row.read_by).toBe('agent:dave,agent:bob')
    expect(noteRepo().inboxPage({ unhandled: true }).rows.map((r) => r.id)).not.toContain(rowId)
  })

  it('④ 未读那条老路没有被我改坏：全新备忘 ack 后只有处理者一个读者', () => {
    const memo = createMemo('没人看过就处理掉的')
    memoRepo().ack(memo.id, 'agent:bob')

    const row = noteRow(memo.id)
    expect(row.status).toBe('read')
    expect(row.read_by).toBe('agent:bob')
    expect(row.read_at).toBeTruthy()
  })
})
