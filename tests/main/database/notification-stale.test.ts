import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '../../../src/main/database/migrations'
import { NotificationRepository } from '../../../src/main/database/notification.repository'

const db = new Database(':memory:')
vi.mock('../../../src/main/database/index', () => ({ getDatabase: () => db }))

/**
 * 通知在批量场景会说假话：状态变了、通知没跟着变（`182271c2`）
 *
 * ## 它治的病（实测数字，10-06 只读查真实库）
 *
 * 未读 `review` 通知 **148 条**，其中：
 * - 「验收未通过，已退回」20 条，**15 条指向的卡已经是 `done`**
 * - 「交付待验收」126 条，**85 条的卡也已经是 `done`**
 *
 * 也就是说这些通知**在说一句已经不成立的话** —— 人打开收件箱看到
 * 「验收未通过」，而那张卡早就收口了。**它不报错、不消失，就躺在那儿冒充待办。**
 *
 * ## 判据
 *
 * 通知的 `ref_id` 指向那张卡。**若卡已不在「触发这条通知时的状态」，这条通知即失效**
 * —— 不占未读、不在列表里冒头。
 *
 * ⚠️ **判据能同时接住存量与增量**，这是选它的理由：
 * 补发只能解决"下次"，而 148 条存量已经在骗人了。
 * 实测能 JOIN 上 139/148（另 9 条 ref 指向已不存在的卡，**一并扫掉**——
 * 通知指向空气同样是在骗人）。
 */
describe('通知失效判据（182271c2）', () => {
  let notif: NotificationRepository

  const mkTodo = (id: string, status: string) =>
    db
      .prepare(
        `INSERT INTO todos (id, title, status, created_at, updated_at)
         VALUES (?, 't', ?, datetime('now'), datetime('now'))`
      )
      .run(id, status)

  const mkNotif = (id: string, title: string, refId: string | null, unread = true) =>
    db
      .prepare(
        `INSERT INTO notifications (id, type, title, ref_id, status, created_at)
         VALUES (?, 'review', ?, ?, ?, datetime('now'))`
      )
      .run(id, title, refId, unread ? 'unread' : 'read')

  beforeAll(() => {
    // ⚠️ 迁移必须在这里跑，不能放 beforeEach ——
    // 我第一版放错位置，8 条用例集体报「no such table: notifications」，
    // 而报错指向的是我的清理语句，不是被测判据。
    runMigrations(db)
  })

  beforeEach(() => {
    db.prepare('DELETE FROM notifications').run()
    db.prepare('DELETE FROM todos').run()
    notif = new NotificationRepository()
  })

  it('卡已 done → 通知失效（这是本条判据的核心）', () => {
    mkTodo('t1', 'done')
    mkNotif('n1', '验收未通过：某卡', 't1')
    expect(notif.list().map((n) => n.id), '卡已完成，通知还在说"验收未通过"').toEqual([])
    expect(notif.unreadCount()).toBe(0)
  })

  it('卡在 awaiting_review → 通知仍有效（别把该看的也扫掉）', () => {
    mkTodo('t2', 'awaiting_review')
    mkNotif('n2', '交付待验收：某卡', 't2')
    expect(notif.list().map((n) => n.id)).toEqual(['n2'])
    expect(notif.unreadCount()).toBe(1)
  })

  it('卡在 in_progress → 通知仍有效（被退回后正是这个状态）', () => {
    mkTodo('t3', 'in_progress')
    mkNotif('n3', '验收未通过：某卡', 't3')
    expect(notif.list().map((n) => n.id)).toEqual(['n3'])
  })

  it('ref 指向已不存在的卡 → 失效（通知指向空气也是骗人）', () => {
    mkNotif('n4', '交付待验收：已删的卡', 'no-such-id')
    expect(notif.list().map((n) => n.id)).toEqual([])
  })

  it('列表与未读计数口径一致（最容易出"列表没有但数字还在"的不一致）', () => {
    mkTodo('t5', 'done') // 失效
    mkNotif('n5', '验收未通过：甲', 't5')
    mkTodo('t6', 'awaiting_review') // 有效
    mkNotif('n6', '交付待验收：乙', 't6')
    mkTodo('t7', 'suspended') // 失效
    mkNotif('n7', '验收未通过：丙', 't7')
    expect(notif.list()).toHaveLength(1)
    expect(notif.unreadCount(), '计数与列表必须同一口径').toBe(1)
  })

  it('非 review 类型不受这条判据影响（memo/decision 说过的事不会过期）', () => {
    mkTodo('t8', 'done')
    db.prepare(
      `INSERT INTO notifications (id, type, title, ref_id, status, created_at)
       VALUES ('m1', 'memo', '某人给你递了张纸条', 't8', 'unread', datetime('now'))`
    ).run()
    expect(
      notif.list().map((n) => n.id),
      'memo 说的是"发生过的事"，不该被"卡状态变了"扫掉'
    ).toEqual(['m1'])
  })

  it('已读的那条即使卡还在，也不该被算进未读（原有语义不变）', () => {
    mkTodo('t9', 'awaiting_review')
    mkNotif('n9', '交付待验收：甲', 't9', false)
    expect(notif.list().map((n) => n.id)).toEqual(['n9'])
    expect(notif.unreadCount()).toBe(0)
  })

  it('退役类型（grant）仍然被排除 —— 两条判据要成对生效', () => {
    mkTodo('ta', 'awaiting_review')
    db.prepare(
      `INSERT INTO notifications (id, type, title, ref_id, status, created_at)
       VALUES ('g1', 'grant', '授权申请', 'ta', 'unread', datetime('now'))`
    ).run()
    expect(notif.list().map((n) => n.id), 'grant 是退役类型，不该出现').toEqual([])
  })
})
