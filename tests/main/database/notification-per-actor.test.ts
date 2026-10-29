import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '../../../src/main/database/migrations'
import { NotificationRepository } from '../../../src/main/database/notification.repository'

const db = new Database(':memory:')
vi.mock('../../../src/main/database/index', () => ({ getDatabase: () => db }))

/**
 * 通知按收件人定向 + 已读位按人存（`3c436592` 的第 2 环）
 *
 * ## 病根（实测 10-07）
 *
 * `notifications` 表**只有单个 `read_at`**，而本机有 4 个写入方
 * （alice / Bob / human / kimi）。于是：
 * ① **表里没有"给谁"** —— 只有 `actor`（谁触发的）
 * ② **A 读过了 B 就当已读** —— 未读位是一份全局的
 *
 * 而"谁在什么时候提醒我什么"是这个产品对 agent 的核心卖点。
 *
 * ## 最关键的设计判断：已读位是**集合**，不是布尔
 *
 * ⚠️ 塞进单个字段只能存"最后是谁读的"，**两个人交替读会互相覆盖**。
 * 所以新增 `read_by`（逗号分隔的 actor 集合），
 * 而 `status`/`read_at` **原样留给界面铃铛**（"人看过了没"）。
 *
 * 判据：**同一份数据有两种读者时，各自的"已读"就该各自一份。**
 */
describe('通知定向与按人已读（3c436592 第 2 环）', () => {
  let notif: NotificationRepository

  beforeAll(async () => {
    // ⚠️ **先迁移再清** —— 我第一版反了（先 DELETE 表还不存在），
    // 症状是 9 条集体报「no such table: notifications」。
    // 判据：**同一段里两个有依赖的操作，顺序错了报错会指向"不存在"而不是"顺序"。**
    await runMigrations(db)
  })

  beforeEach(() => {
    db.exec(`DELETE FROM notifications;`)
    notif = new NotificationRepository()
  })

  const mk = (over: Record<string, unknown> = {}) =>
    notif.create({
      type: 'memo' as const,
      title: '一张纸条',
      summary: 's',
      refId: 'm1',
      actor: 'agent:alice',
      ...over
    } as never)

  it('迁移加了两列（recipient / read_by）', () => {
    const cols = db.prepare('PRAGMA table_info(notifications)').all().map((r) => (r as { name: string }).name)
    expect(cols, 'recipient 没加 —— 通知进谁的收件箱还是无人知道').toContain('recipient')
    expect(cols, 'read_by 没加 —— 已读位还是全局一份').toContain('read_by')
  })

  it('通知能记收件人（与 actor 是两个身份）', () => {
    const n = mk({ recipient: 'agent:qwen' })
    expect(n.recipient).toBe('agent:qwen')
    expect(n.actor, 'actor 是谁触发的，不该被收件人顶替').toBe('agent:alice')
  })

  it('`listFor` 只看待给某人的（+ 没指定收件人的广播）', () => {
    mk({ recipient: 'agent:qwen', refId: 'a' })
    mk({ recipient: 'agent:alice', refId: 'b' })
    mk({ recipient: null, refId: 'c' })
    const mine = notif.listFor('agent:qwen').map((n) => n.refId)
    expect(mine, '给 alice 的不该出现在 qwen 这儿').not.toContain('b')
    expect(mine, '给 qwen 的该在').toContain('a')
    expect(mine, '没指定收件人的广播该在（否则 agent 会漏掉"我不知道给谁"的事）').toContain('c')
  })

  /**
   * 这条是**整张卡的核心**。
   *
   * 判据：**两个 agent 各读各的，未读数互不影响。**
   * 做不到这点就等于没做——而这正是原来全局 `read_at` 的毛病。
   */
  it('A 读过不影响 B 的未读数（这是全卡的核心判据）', () => {
    const n = mk({ recipient: 'agent:qwen' })
    expect(notif.unreadCountFor('agent:qwen', 'agent:qwen')).toBe(1)
    expect(notif.unreadCountFor('agent:qwen', 'agent:alice')).toBe(1)

    notif.markReadBy(n.id, 'agent:qwen')

    expect(
      notif.unreadCountFor('agent:qwen', 'agent:qwen'),
      'qwen 自己读过了，他这儿该变成 0'
    ).toBe(0)
    expect(
      notif.unreadCountFor('agent:qwen', 'agent:alice'),
      '⚠️ qwen 读过不该让 alice 的未读数少 —— 这条不过等于没做'
    ).toBe(1)
  })

  it('`markReadBy` 不动全局 status（界面铃铛那个口径不能被 agent 改掉）', () => {
    const n = mk({ recipient: 'agent:qwen' })
    notif.markReadBy(n.id, 'agent:qwen')
    const after = db.prepare('SELECT status, read_at FROM notifications WHERE id = ?').get(n.id) as {
      status: string
      read_at: string | null
    }
    expect(after.status, 'agent 记已读不该改全局 status —— 那是界面铃铛用的').toBe('unread')
    expect(after.read_at).toBeNull()
    expect(notif.unreadCount(), '全局未读数也不该被 agent 动').toBe(1)
  })

  it('`markReadBy` 幂等（同一人重复读不重复记）', () => {
    const n = mk({ recipient: 'agent:qwen' })
    expect(notif.markReadBy(n.id, 'agent:qwen')).toBe(true)
    expect(notif.markReadBy(n.id, 'agent:qwen'), '重复读不该再改一次').toBe(false)
    const row = db.prepare('SELECT read_by FROM notifications WHERE id = ?').get(n.id) as {
      read_by: string
    }
    expect(row.read_by.split(',').filter(Boolean)).toEqual(['agent:qwen'])
  })

  it('多个人读过要都记下来（集合，不是"最后一个"）', () => {
    const n = mk({ recipient: 'agent:qwen' })
    notif.markReadBy(n.id, 'agent:qwen')
    notif.markReadBy(n.id, 'agent:alice')
    const row = db.prepare('SELECT read_by FROM notifications WHERE id = ?').get(n.id) as {
      read_by: string
    }
    expect(row.read_by.split(',').filter(Boolean).sort()).toEqual(['agent:alice', 'agent:qwen'])
  })

  it('`listFor` + `unreadBy` 组合：只给我且我没读过的', () => {
    const a = mk({ recipient: 'agent:qwen', refId: 'a' })
    mk({ recipient: 'agent:qwen', refId: 'b' })
    mk({ recipient: 'agent:alice', refId: 'c' })
    notif.markReadBy(a.id, 'agent:qwen')
    const rows = notif.listFor('agent:qwen', { unreadBy: 'agent:qwen' })
    expect(rows.map((r) => r.refId)).toEqual(['b'])
  })

  it('存量已读的行不编造"谁读过"（read_by 留空 = 我没读过，不是"他读过"）', () => {
    // 模拟存量：read_at 非空、read_by 为 NULL（迁移 28 就是这么处理的）
    db.prepare(
      `INSERT INTO notifications (id,type,title,summary,ref_id,actor,status,meta,created_at,read_at,recipient,read_by)
       VALUES ('old','memo','旧的','s','x','human','read',NULL,'2026-01-01T00:00:00Z','2026-01-02T00:00:00Z','agent:qwen',NULL)`
    ).run()
    const rows = notif.listFor('agent:qwen', { unreadBy: 'agent:qwen' })
    expect(
      rows.filter((r) => r.id === 'old').length,
      '存量已读行不该报成"我还没看过" —— 但也不能编造是谁读的'
    ).toBe(1)
  })
})
