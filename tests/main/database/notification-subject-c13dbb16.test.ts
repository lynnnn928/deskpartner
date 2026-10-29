import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import Database from 'better-sqlite3'
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { runMigrations } from '../../../src/main/database/migrations'
import { NotificationRepository } from '../../../src/main/database/notification.repository'
import { DB_VERSION } from '../../../src/renderer/lib/constants'

const db = new Database(':memory:')
vi.mock('../../../src/main/database/index', () => ({ getDatabase: () => db }))

/**
 * 通知的未读/已读**按主体分别记**：人清自己的、agent 清自己的（卡 `c13dbb16`）
 *
 * ## 数据侧判据（对应卡上验收）
 *
 * ① 同一批通知：**人视角与 agent 视角的未读数不同** —— agent 读过的，人仍然未读；
 * ② 各自可清：人清自己那一份不动 agent 的，agent `markReadBy` 也不动人的；
 * ③ 角标（`unreadSystemCount`）与页头（`inboxPage().unread`）**同一份 WHERE**；
 * ④ 列表那一趟**不按主体收窄**：已读的仍要在 rows 里（"我已知晓"要看得见）；
 * ⑤ 存量回填（迁移 46）：`status='read'` 但没人记名的行认成主用户读过 ——
 *    不回填的话，升级后界面会凭空多出一批未读（真库实测 111 条）。
 *
 * 渲染层那半（判据 + 接线闸门）在
 * `tests/renderer/components/notification-subject-c13dbb16.test.ts`。
 */
describe('通知未读按主体分别记（c13dbb16）', () => {
  let repo: NotificationRepository

  beforeAll(() => {
    runMigrations(db)
  })

  beforeEach(() => {
    db.exec('DELETE FROM notifications;')
    repo = new NotificationRepository()
  })

  /** 造一条系统级通知（不关联项目，角标那个范围数的就是它） */
  const mk = (over: Record<string, unknown> = {}) =>
    repo.create({
      type: 'memo' as const,
      title: '一张纸条',
      summary: 's',
      refId: 'm1',
      actor: 'agent:alice',
      ...over
    } as never)

  // ───────────────── 判据①：两个主体各自的未读数不同 ─────────────────

  it('①同一批通知：agent 读过的不算人读过，两边未读数不同', () => {
    mk({ refId: 'a' })
    const b = mk({ refId: 'b' })
    repo.markReadBy(b.id, 'agent:bob')

    expect(
      repo.countWithProject({ projectId: null, unreadOnly: true, unreadFor: 'human' }),
      '人视角：qwen 读过不等于我读过 ⇒ 2 条未读'
    ).toBe(2)
    expect(
      repo.countWithProject({ projectId: null, unreadOnly: true, unreadFor: 'agent:bob' }),
      'qwen 视角：他自己读过一条 ⇒ 1 条未读'
    ).toBe(1)
    expect(repo.unreadSystemCount('human'), '角标那个数也按主体').toBe(2)
    expect(repo.unreadSystemCount('agent:bob')).toBe(1)
  })

  it('②人清自己的：agent 的未读一条不少（这就是"各自可清"）', () => {
    const a = mk({ refId: 'a' })
    mk({ refId: 'b' })

    expect(repo.markReadFor(a.id, 'human'), '第一次点开该有改动').toBe(true)
    expect(repo.countWithProject({ projectId: null, unreadOnly: true, unreadFor: 'human' })).toBe(1)
    expect(
      repo.countWithProject({ projectId: null, unreadOnly: true, unreadFor: 'agent:bob' }),
      '⚠️ 人读过不该让 agent 的未读少一个 —— 这条不过等于没做'
    ).toBe(2)
    expect(repo.markReadFor(a.id, 'human'), '幂等：重复点开不再改').toBe(false)
  })

  it('②agent 清自己的：人的未读一条不少', () => {
    const a = mk({ refId: 'a' })
    mk({ refId: 'b' })
    repo.markReadBy(a.id, 'agent:bob')
    expect(repo.countWithProject({ projectId: null, unreadOnly: true, unreadFor: 'agent:bob' })).toBe(1)
    expect(repo.countWithProject({ projectId: null, unreadOnly: true, unreadFor: 'human' })).toBe(2)
  })

  it('②点开一条 = 同时记进 read_by 与全局位（CLI 的 unread 字段与备忘 ack 链路还按全局位走）', () => {
    const a = mk({ refId: 'a' })
    repo.markReadFor(a.id, 'human')
    const row = db
      .prepare('SELECT status, read_at, read_by FROM notifications WHERE id = ?')
      .get(a.id) as { status: string; read_at: string | null; read_by: string | null }
    expect(row.read_by, '主体集合里记下主用户').toBe('human')
    expect(row.status, '全局位照旧要写 —— 不写它，CLI 的 unread 字段就再也不动了').toBe('read')
    expect(row.read_at).not.toBeNull()
    expect(repo.unreadCount(), '全局未读数（旧口径）也跟着减').toBe(0)
  })

  // ───────────────── 判据②：范围清理（"全部已读"） ─────────────────

  it('②范围"全部已读"：只清我的那一份、把我追加进 read_by、别人的读者一个字不改', () => {
    const a = mk({ refId: 'a' })
    const b = mk({ refId: 'b' })
    repo.markReadBy(b.id, 'agent:bob')

    const 我声称要清的 = repo.countWithProject({
      projectId: null,
      unreadOnly: true,
      unreadFor: 'human'
    })
    const cleared = repo.markSystemAllRead(null, 'human')

    expect(cleared, '清掉的条数就是它宣称的范围（页头那个数）').toBe(我声称要清的)
    expect(cleared).toBe(2)
    const readBy = (id: string) =>
      (db.prepare('SELECT read_by FROM notifications WHERE id = ?').get(id) as { read_by: string })
        .read_by
    expect(readBy(b.id), '⚠️ 追加、不覆盖 —— 覆盖就退回"只记得最后是谁读的"').toBe(
      'agent:bob,human'
    )
    expect(readBy(a.id), '没人读过的行就记我一个').toBe('human')
    expect(repo.countWithProject({ projectId: null, unreadOnly: true, unreadFor: 'human' })).toBe(0)
    expect(
      repo.countWithProject({ projectId: null, unreadOnly: true, unreadFor: 'agent:bob' }),
      'qwen 还差 a 那条没读'
    ).toBe(1)
  })

  // ───────────────── 判据③④：口径同源 + 列表不收窄 ─────────────────

  it('③角标与页头同一个数（同一份 WHERE，都不含窗口）', () => {
    mk({ refId: 'a' })
    const b = mk({ refId: 'b' })
    repo.markReadBy(b.id, 'agent:bob')

    const 页头 = repo.inboxPage({ projectId: null, unreadFor: 'human' }).unread
    expect(repo.unreadSystemCount('human'), '角标与页头不许各说各话').toBe(页头)
    expect(页头).toBe(2)
    // 不带主体时是旧的全局口径：两条都没人翻全局位 ⇒ 也是 2（这里不是判据，是"旧口径没被弄坏"）
    expect(repo.inboxPage({ projectId: null }).unread).toBe(2)
  })

  it('④列表那一趟不按主体收窄：已读的那条仍在 rows 里（"我已知晓"要看得见）', () => {
    const a = mk({ refId: 'a' })
    mk({ refId: 'b' })
    repo.markReadFor(a.id, 'human')

    const page = repo.inboxPage({ projectId: null, unreadFor: 'human' })
    expect(page.rows.length, '已读的行不许从列表里消失（那是"只看未读"，不是收件箱）').toBe(2)
    expect(page.unread, '但未读那个数只剩一条').toBe(1)
    expect(
      page.rows.find((r) => r.id === a.id)?.readBy,
      '界面的"未读绿点"就看这个字段'
    ).toBe('human')
  })

  // ───────────────── 判据⑤：存量回填（迁移 46） ─────────────────

  /**
   * 造一个"v45 形状"的库（只建版本表与 notifications，版本号写 45）——
   * 于是 `runMigrations` 只会跑新那一条，存量各种形态都能摆出来。
   */
  const v45Shape = (rows: Array<[string, string, string | null, string | null]>) => {
    const legacy = new Database(':memory:')
    legacy.exec(`
      CREATE TABLE _schema_version (version INTEGER NOT NULL);
      INSERT INTO _schema_version (version) VALUES (45);
      CREATE TABLE notifications (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        ref_id TEXT,
        actor TEXT,
        status TEXT NOT NULL DEFAULT 'unread',
        meta TEXT,
        created_at TEXT NOT NULL,
        read_at TEXT,
        recipient TEXT,
        read_by TEXT
      );
    `)
    const ins = legacy.prepare(
      `INSERT INTO notifications (id, type, title, status, created_at, read_at, read_by)
       VALUES (?, 'memo', ?, ?, '2026-10-01T00:00:00.000Z', ?, ?)`
    )
    for (const [id, status, readAt, readBy] of rows) ins.run(id, id, status, readAt, readBy)
    return legacy
  }

  const readByOf = (conn: Database.Database, id: string): string | null =>
    (conn.prepare('SELECT read_by FROM notifications WHERE id = ?').get(id) as { read_by: string | null })
      .read_by

  it('⑤迁移 46：全局已读但没人记名的行认成主用户读过；已有读者的行一个字不改', () => {
    const legacy = v45Shape([
      // 1.0.68 之前读过的：迁移 28 按"历史行不知道是谁读的"留了 NULL
      ['n-旧已读', 'read', '2026-01-01T00:00:00.000Z', null],
      // 1.0.68 之后在界面上读过的：界面只写了全局位（read_by 是空串）
      ['n-界面已读', 'read', '2026-09-01T00:00:00.000Z', ''],
      // 已经有读者的：agent ack 过
      ['n-agent读过', 'read', '2026-09-02T00:00:00.000Z', 'agent:bob'],
      // 没人读过的
      ['n-未读', 'unread', null, '']
    ])

    expect(() => runMigrations(legacy)).not.toThrow()
    const v = legacy.prepare('SELECT MAX(version) AS v FROM _schema_version').get() as { v: number }
    expect(v.v, '迁移后版本必须等于当前 DB_VERSION').toBe(DB_VERSION)

    expect(readByOf(legacy, 'n-旧已读'), '历史行认成主用户读过（否则它会重新亮成未读）').toBe('human')
    expect(readByOf(legacy, 'n-界面已读'), '界面上读过的那些同理').toBe('human')
    expect(
      readByOf(legacy, 'n-agent读过'),
      '⚠️ 已经有读者的行不许覆盖 —— read_by 是集合，追加才是它的语义'
    ).toBe('agent:bob')
    expect(readByOf(legacy, 'n-未读'), '没读过的行不该被写成读过').toBe('')

    // 幂等：再跑一次（重装/再启动是常态）不改任何东西
    expect(() => runMigrations(legacy)).not.toThrow()
    expect(readByOf(legacy, 'n-agent读过')).toBe('agent:bob')
    expect(readByOf(legacy, 'n-旧已读')).toBe('human')
    legacy.close()
  })

  /**
   * 真库副本上验一遍（1.0.69 白屏那次的教训：**空库跑通什么都不能证明**）。
   * 副本落在仓库 `.tmp-check/`，与 `migration-on-populated-db.test.ts` 同一个去向，
   * 但**文件名不同** —— 两个用例文件是并发跑的，撞同一个副本会互相打断。
   */
  const REAL_DB = join(process.env.APPDATA || join(os.homedir(), 'AppData', 'Roaming'), 'desk-partner', 'user.db')
  const TMP_DIR = join(process.cwd(), '.tmp-check')
  const CPY = `${TMP_DIR}/notification-subject-probe.db`
  const HAS_REAL_DB = existsSync(REAL_DB)
  const realCase = HAS_REAL_DB ? it : it.skip

  afterAll(() => {
    try {
      rmSync(CPY, { force: true })
    } catch {
      /* 清副本失败不该让用例红 —— 它验的是迁移，不是文件清理 */
    }
  })

  realCase('⑤真库副本：回填后没有"全局已读却没人记名"的行；已有的读者逐条不变', () => {
    mkdirSync(TMP_DIR, { recursive: true })
    copyFileSync(REAL_DB, CPY)
    const copy = new Database(CPY)
    try {
      const beforeVersion = (
        copy.prepare('SELECT MAX(version) AS v FROM _schema_version').get() as { v: number }
      ).v
      const before = copy
        .prepare('SELECT id, status, read_by FROM notifications')
        .all() as Array<{ id: string; status: string; read_by: string | null }>

      runMigrations(copy)

      const after = new Map(
        (
          copy.prepare('SELECT id, read_by FROM notifications').all() as Array<{
            id: string
            read_by: string | null
          }>
        ).map((r) => [r.id, r.read_by])
      )

      /** 待回填 = 全局已读、但集合里没人 */
      const 待回填 = before.filter(
        (r) => (r.read_by === null || r.read_by === '') && r.status === 'read'
      )
      const 没被回填的 = 待回填.filter(
        (r) => !(after.get(r.id) ?? '').split(',').filter(Boolean).includes('human')
      )
      expect(没被回填的, `这 ${待回填.length} 条升级后会重新亮成未读`).toEqual([])

      /** 已经有读者的行，一个字都不许改 */
      const 被改过的 = before.filter(
        (r) => r.read_by !== null && r.read_by !== '' && after.get(r.id) !== r.read_by
      )
      expect(被改过的).toEqual([])

      /** 没人读过、也没人标已读的行不许被写成读过 */
      const 未读被写脏 = before.filter(
        (r) => r.status !== 'read' && r.read_by === '' && after.get(r.id) !== ''
      )
      expect(未读被写脏).toEqual([])

      /**
       * 会"从已读翻回未读"的那批：有人读过（`read_by` 非空）、全局位也是已读，
       * 但**主用户没记名**。按新口径它们该算主用户未读 —— 这正是本卡要的效果，
       * 但角标数字会因此变化，所以打出来给人看一眼（不断言：两个值都合法）。
       */
      const 会翻回未读 = before.filter(
        (r) =>
          r.status === 'read' &&
          !!r.read_by &&
          !r.read_by.split(',').filter(Boolean).includes('human')
      )

      // eslint-disable-next-line no-console
      console.log(
        `  真库副本：迁移前 v${beforeVersion}、通知 ${before.length} 条、` +
          `本次回填 ${待回填.length} 条（全局已读但没人记名）、` +
          `另有 ${会翻回未读.length} 条会按新口径从「已读」翻回「未读」（agent 读过、主用户没记名）`
      )
    } finally {
      copy.close()
    }
  })
})
