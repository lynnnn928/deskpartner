import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '../../src/main/database/migrations'
import { NotificationRepository } from '../../src/main/database/notification.repository'

/**
 * 「待接手」这一档真的进了 SQL（卡 `5fd2b595` 的下推）
 *
 * ## 为什么必须在这里验，而不是渲染层
 *
 * 在界面里对取回的一页 `.filter` 一遍，`matched` / `unread` / `byType` 就全是
 * 整范围的数、列表却只剩子集 —— `cba46119` 治过一次（角标 633 / 页头 484 / 列表 500）。
 * 所以这一档的判据必须落在 `inboxWhere` 里，并且**三个数与列表同一份 WHERE**。
 * 这个文件验的就是"同一份 WHERE"那一刻真的成立。
 *
 * ## 判据（与卡上的三件事一一对应）
 *
 * ① `read_by` 里除主用户没有别人 = 没人接手：`NULL`（历史行）/ 空串 / 只有 `human`；
 * ② 有 `agent:*`（哪怕同时有 `human`）= 已处理，默认视图里不出现；
 * ③ 角标（`unreadSystemCount('human')`）= **待接手 ∩ 我没看过** ——
 *    agent 已 ack 掉的备忘不再替主用户报警。
 */
const db = new Database(':memory:')
vi.mock('../../src/main/database/index', () => ({ getDatabase: () => db }))

let repo: NotificationRepository

type Case = {
  name: string
  /** 写进 `read_by` 的集合；null = 历史行 */
  readBy: string | null
  /** 全局已读位：`memo ack` 会翻过去，纯 `--ack-mine` 不会 */
  status?: 'read' | 'unread'
}

const cases: Case[] = [
  { name: '历史行（read_by 为 NULL）', readBy: null },
  { name: '空集', readBy: '' },
  { name: '只有主用户看过', readBy: 'human', status: 'read' },
  // `memo ack` 那条路：追加读者 **并且** 翻全局位 —— 这才是「接手了」
  { name: 'agent 处理过', readBy: 'agent:alice', status: 'read' },
  { name: '我读过、agent 也处理过', readBy: 'human,agent:bob', status: 'read' },
  { name: '两个 agent 都处理过', readBy: 'agent:alice,agent:bob', status: 'read' },
  // CLI `notification list --ack-mine` 那条路：只追加读者、不动全局位 ——「看过」不是「接手」
  { name: 'agent 只是看过', readBy: 'agent:dave', status: 'unread' }
]

const ids = new Map<string, string>()

describe('「待接手」的判据在 WHERE 里（卡 5fd2b595）', () => {
  beforeAll(() => {
    runMigrations(db)
  })

  beforeEach(() => {
    db.prepare('DELETE FROM notifications').run()
    repo = new NotificationRepository()
    ids.clear()
    for (const c of cases) {
      const created = repo.create({
        type: 'memo',
        title: c.name,
        // 系统范围（不挂项目）：角标数的就是这一片
        actor: 'agent:carol'
      })
      db.prepare('UPDATE notifications SET read_by = ?, status = ? WHERE id = ?').run(
        c.readBy,
        c.status ?? 'unread',
        created.id
      )
      ids.set(c.name, created.id)
    }
  })

  it('① 空集 / 历史行 / 只有我读过 → 待接手', () => {
    const page = repo.inboxPage({ projectId: null, unhandled: true })
    expect(page.matched).toBe(4)
    expect(page.rows.map((r) => r.title).sort()).toEqual(
      ['历史行（read_by 为 NULL）', '只有主用户看过', '空集', 'agent 只是看过'].sort()
    )
  })

  it('② 有 agent 参与过就不在待接手里 —— 哪怕我自己也读过', () => {
    const page = repo.inboxPage({ projectId: null, unhandled: true })
    expect(page.rows.map((r) => r.title)).not.toContain('我读过、agent 也处理过')
    expect(page.rows.map((r) => r.title)).not.toContain('agent 处理过')
    // 不收窄时全都在 —— 这一档只筛"有没有 agent 接手"，不是筛已读
    expect(repo.inboxPage({ projectId: null }).matched).toBe(cases.length)
  })

  it('三个数与列表同一份 WHERE（cba46119 的判据）：matched / byType / unread 都跟着这一档', () => {
    const all = repo.inboxPage({ projectId: null })
    const page = repo.inboxPage({ projectId: null, unhandled: true, unreadFor: 'human' })
    expect(page.matched, '命中数不含窗口、且按这一档数').toBe(4)
    expect(page.rows.length).toBe(4)
    expect(page.byType.memo?.total, 'chip 的数字不能还是整范围的 7').toBe(4)
    expect(all.byType.memo?.total).toBe(cases.length)
    // "我还没看过"里，agent 处理掉的那几条也不该算进来
    expect(page.unread, '页头未读 = 待接手 ∩ 我未读（只有主用户看过的那条不算）').toBe(3)
  })

  it('③ 角标：agent 已 ack 的备忘不再算成主用户的未读', () => {
    const 未收窄 = repo.countWithProject({ projectId: null, unreadFor: 'human' })
    expect(未收窄, '不收窄时：除了我自己看过的那两条，其余 5 条都算我没读过').toBe(5)
    expect(
      repo.unreadSystemCount('human'),
      '收窄后只剩"没人接手"且我没读过的三条 —— 红点不再为已处理掉的东西报警'
    ).toBe(3)
    // 与通知页默认视图的页头同一个数（同一份 WHERE）
    expect(
      repo.inboxPage({ projectId: null, unhandled: true, unreadFor: 'human' }).unread
    ).toBe(3)
  })

  it('主体隔离没被破坏：agent 的未读照旧按自己的 read_by 算', () => {
    // alice 处理过两条（agent:alice / agent:alice,agent:bob）—— 她自己的未读是 0
    expect(repo.countWithProject({ projectId: null, unreadFor: 'agent:alice' })).toBe(5)
    expect(
      repo.countWithProject({ projectId: null, unreadFor: 'agent:carol' }),
      'carol 一条都没读过'
    ).toBe(cases.length)
  })

  it('「全部已读」的范围不受这一档影响：清掉的仍是它宣称的那个范围', () => {
    // 主用户点「全部已读」时界面不带 unhandled（它本来就只清"我的"那一份）
    const n = repo.markSystemAllRead(null, 'human')
    // 只清"我还没读过"的那 5 条：我自己看过的那两条不重复清
    expect(n).toBe(5)
    expect(repo.unreadSystemCount('human')).toBe(0)
    expect(repo.countWithProject({ projectId: null })).toBe(cases.length)
  })
})
