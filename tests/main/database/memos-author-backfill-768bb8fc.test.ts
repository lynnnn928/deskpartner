import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '../../../src/main/database/migrations'
import { DB_VERSION } from '../../../src/renderer/lib/constants'

/**
 * 存量库有 memos 行时迁移必须成功且回填 author（`768bb8fc`）
 *
 * ## 它治的病（1.0.69 事故的卡）
 *
 * v26 → v27 撞 `memos.author TEXT NOT NULL`：无头启动即崩、
 * 每次调用重试同一迁移每次崩，栈固定 `NOT NULL constraint failed: memos.author`。
 *
 * ## 为什么必须用"缺 author 的存量行"来构造
 *
 * 迁移的 SQL 约束只在**有行**时才触发（1.0.69 的教训：空库跑通什么都不能证明）。
 * 所以这里的库是 **pre-v27 旧 schema + 有 memos 行缺 author**：
 * - 旧 schema：memos 只有 recipient 拆列之前的那些列；
 * - 有缺 author 的行（NULL / 空串）—— 卡片说的"存量行拿不到 author"。
 *
 * ## 回填口径（卡片拍板："取旧列，取不到默认 human"）
 *
 * - 取旧列：有旧值的行原样保留（`human` / `agent:cli` 都不许被动）；
 * - 取不到默认 `'human'`：宁保守不造假 —— **绝不编造某个 `agent:*`**；
 * - 当年装在 author 里的收件人 → 迁到 `recipient`，author 落
 *   `unknown:pre-1.0.68`（1.0.70 的显式"没记"，见 memo-recipient-split）。
 */
describe('存量 memos 行缺 author 时迁移必须成功且回填（768bb8fc）', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    // ⚠️ 不预置版本号 —— 让全部迁移从头跑（同 memo-recipient-split 的判据：
    // 迁移测试跑完整链路，写死版本号的断言每加一条迁移就要重改）。
    db.exec(`
      CREATE TABLE _schema_version (version INTEGER NOT NULL);
      CREATE TABLE memos (
        id TEXT PRIMARY KEY, author TEXT, text TEXT,
        linked_todo_id TEXT, status TEXT, created_at TEXT, read_at TEXT
      );
    `)
    const now = '2026-10-07T00:00:00.000Z'
    const add = (id: string, author: string | null) =>
      db
        .prepare(
          'INSERT INTO memos (id, author, text, status, created_at) VALUES (?, ?, ?, ?, ?)'
        )
        .run(id, author, 't', 'unread', now)
    add('m-keep-human', 'human') // 取旧列：真作者，原样保留
    add('m-keep-cli', 'agent:cli') // 取旧列：默认署名，原样保留
    add('m-masq', 'agent:alice') // 当年装在 author 里的收件人 → recipient
    add('m-null', null) // 缺 author → 回填
    add('m-empty', '') // 缺 author（空串）→ 回填
  })

  afterEach(() => db.close())

  const authorOf = (id: string) =>
    db.prepare('SELECT author, recipient FROM memos WHERE id = ?').get(id) as {
      author: string | null
      recipient: string | null
    }

  it('迁移不抛错、版本到 DB_VERSION（1.0.69 的形状：有 memos 行的存量库一跑就崩）', () => {
    expect(() => runMigrations(db)).not.toThrow()
    const { v } = db.prepare('SELECT MAX(version) AS v FROM _schema_version').get() as {
      v: number
    }
    expect(v, '迁移后版本必须等于当前 DB_VERSION').toBe(DB_VERSION)
  })

  it('缺 author 的行回填 human（取不到默认 human，绝不编造 agent）', () => {
    runMigrations(db)
    for (const id of ['m-null', 'm-empty']) {
      const r = authorOf(id)
      expect(r.author, `${id} 没回填 —— 缺 author 的行会一直顶着 NOT NULL 契约`).toBe(
        'human'
      )
      expect(r.author, `${id} 回填成了 agent —— 那是编造`).not.toContain('agent:')
    }
  })

  it('取旧列：有 author 的行原样保留，一个都不许被动', () => {
    runMigrations(db)
    expect(authorOf('m-keep-human').author, 'human 那行的 author 被动了').toBe('human')
    expect(authorOf('m-keep-cli').author, 'agent:cli 那行的 author 被动了').toBe(
      'agent:cli'
    )
  })

  it('拆列不丢值：收件人迁到 recipient，author 显式标"没记"', () => {
    runMigrations(db)
    const r = authorOf('m-masq')
    expect(r.recipient, '收件人没迁出来').toBe('agent:alice')
    // 显式值而非 NULL —— author 是 NOT NULL，写 NULL 就是 1.0.69 的崩法
    expect(r.author).toBe('unknown:pre-1.0.68')
  })

  it('收口不变量：迁移后没有任何一行缺 author', () => {
    runMigrations(db)
    const bad = db
      .prepare('SELECT COUNT(*) AS n FROM memos WHERE author IS NULL OR author = ?')
      .get('') as { n: number }
    expect(bad.n, '迁移后仍有行拿不到 author').toBe(0)
  })
})
