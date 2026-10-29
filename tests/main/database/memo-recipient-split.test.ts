import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'

/**
 * 纸条分「递的人」与「给谁」（`3c436592`，qwen 提，主用户 10-06 拍板）
 *
 * ## 它治的病
 *
 * `memo add --owner agent:x` 把 **author 写成了收件人**
 * （`commands.ts`：`create({ author: owner })`）。
 *
 * 后果：**"这张纸条是谁递的"查不出来** —— 审计链是反的，**而且不报错**。
 * 而"谁在什么时候提醒我什么"正是这个产品对 agent 的核心卖点。
 *
 * 报卡人原话：
 * > 「递出去的纸条记成收件人自己写的，发送者查不出来」
 * > 「与 todo add 的自动归因不一致，同一个 agent 在两类对象上身份口径不同」
 *
 * ## 为什么拆列而不是就地纠正 author
 *
 * 那一列**同时装着两个身份**（我递的 / 我给谁的），
 * **存量行已经分不出哪个是哪个了** —— 只能靠"有没有通知"去猜，而那也猜不准。
 *
 * 所以：`recipient` 新列归收件人，**已错的 author 置 NULL**（表示"历史行没记"）。
 *
 * ⚠️ **不编造发起方** —— 宁可留 NULL，也不要写一个看起来对的值。
 */
describe('纸条分递的人与给谁（3c436592）', () => {
  let db: Database.Database

  const fresh = (): Database.Database => {
    const d = new Database(':memory:')
    // ⚠️ **不预置版本号** —— 让全部迁移从头跑一遍。
    // 我第一版写死 26（只验 27）、后来改 27（只验 28），
    // 每次加迁移都要重改，**而漏改的症状是"全红"而不是"明确失败"**。
    // 判据：迁移测试该跑**完整链路**（像真库从 v0 升上来），
    // 而"只验某一条"得用别的方式隔离（否则它就是我说的那种脆断言）。
    d.exec(`CREATE TABLE _schema_version (version INTEGER NOT NULL);`)
    return d
  }

  beforeEach(() => {
    db = fresh()
    // 迁移前先塞存量行 —— ⚠️ 顺序很重要：
    // 先有数据再跑迁移，才验得到"回填"；反了的话回填逻辑一行都不会执行。
    db.exec(`
      CREATE TABLE memos (
        id TEXT PRIMARY KEY, author TEXT, text TEXT,
        linked_todo_id TEXT, status TEXT, created_at TEXT, read_at TEXT
      );
    `)
    const now = '2026-09-30T14:14:00.000Z'
    const add = (a: string) =>
      db
        .prepare(
          "INSERT INTO memos (id, author, text, status, created_at) VALUES (?, ?, 't', 'unread', ?)"
        )
        .run(Math.random().toString(36).slice(2), a, now)
    add('agent:alice') // 当年这行其实是「收件人」
    add('agent:cli') // 没传 --owner 的默认值
    add('human') // 人自己记的
  })

  afterEach(() => db.close())

  const row = (n: number) =>
    db.prepare('SELECT author, recipient FROM memos ORDER BY rowid').all()[n] as {
      author: string | null
      recipient: string | null
    }

  const migrate = async () => {
    vi.resetModules()
    const { runMigrations } = await import('../../../src/main/database/migrations')
    // 让被 mock 的 getDatabase 返回本测试的 db
    vi.doMock('../../../src/main/database/index', () => ({ getDatabase: () => db }))
    runMigrations(db)
  }

  it('memos 表多出 recipient 列', async () => {
    await migrate()
    const cols = db.prepare('PRAGMA table_info(memos)').all().map((r) => (r as { name: string }).name)
    expect(cols, 'recipient 列没加 —— 拆列没做').toContain('recipient')
  })

  it('存量：当年装在 author 里的收件人被迁到 recipient，author 改成显式的"没记"', async () => {
    await migrate()
    const r = row(0)
    expect(r.recipient, '收件人没迁出来').toBe('agent:alice')
    /**
     * ⚠️ 这里原来断言 `author === null` —— **那正是 1.0.69 白屏的原因**：
     * `memos.author` 是 `TEXT NOT NULL`（v1 建表就有），
     * 迁移里 `SET author = NULL` ⇒ 装上就抛 `NOT NULL constraint failed` ⇒ 界面起不来。
     *
     * ⇒ 判据：**"没记"要用一个显式值表达，不能用 NULL**
     * —— 前提是那一列根本不能空（**约束要查，别猜**）。
     */
    expect(
      r.author,
      '应改成显式的"历史行没记发起方"，而不能是 NULL（NOT NULL）'
    ).toBe('unknown:pre-1.0.68')
    expect(r.author, '⚠️ 绝不能是某个真实 agent —— 那是编造').not.toContain('agent:')
  })

  it('存量：agent:cli（没传 --owner 的默认）不迁（它不是收件人）', async () => {
    await migrate()
    const r = row(1)
    expect(r.recipient, 'agent:cli 是"没指定收件人"，不该被当成收件人').toBeNull()
  })

  it('存量：human（人自己记的）不迁', async () => {
    await migrate()
    const r = row(2)
    expect(r.recipient).toBeNull()
  })

  it('迁移后可正常写入两个身份（这是修好的落点）', async () => {
    await migrate()
    db.prepare(
      "INSERT INTO memos (id, author, recipient, text, status, created_at) VALUES ('m1','agent:alice','agent:qwen','t','unread','2026-10-07T00:00:00Z')"
    ).run()
    const r = db.prepare("SELECT author, recipient FROM memos WHERE id='m1'").get() as {
      author: string
      recipient: string
    }
    expect(r.author, '递的人要记对').toBe('agent:alice')
    expect(r.recipient, '给谁要记对').toBe('agent:qwen')
  })

  it('判据：`agent:cli` 这个默认值必须排除在回填外（它是"没指定"，不是"指定了 cli"）', async () => {
    /**
     * 这一条是**独立断言**：万一有人把回填条件从 `<> 'agent:cli'`
     * 改成只判 `LIKE 'agent:%'`，上面第 3 条仍会绿（它只看 recipient 为空），
     * 但**这条会红** —— 两条各自钉一个方向，才不会被"改一个条件绿一片"蒙过去。
     *
     * ⚠️ 我第一版忘了跑迁移就断言 author，
     * 而 beforeEach 造的 `migrate` 之前 author 确实是 `agent:cli` ——
     * **断言在错误的位置，通过与否都没有意义**。
     */
    await migrate()
    const r = row(1)
    expect(
      r.recipient,
      'agent:cli 迁进 recipient = 把"没指定收件人"当成了"收件人是 cli"'
    ).toBeNull()
    expect(
      r.author,
      'agent:cli 那一行的 author 不该被动（它本来就不是收件人）'
    ).toBe('agent:cli')
  })
})
