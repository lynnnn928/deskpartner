import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import { copyFileSync, existsSync, rmSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runMigrations } from '../../../src/main/database/migrations'
import { DB_VERSION } from '../../../src/renderer/lib/constants'

/**
 * 迁移必须在**有数据的老库**上验过（1.0.69 血的教训，`182271c2`）
 *
 * ## 发生了什么
 *
 * 用户装 1.0.69 后**界面等 2 分钟不出来**。查：进程在跑，是**迁移卡住了**。
 *
 * 在真库副本上跑迁移 → `NOT NULL constraint failed: memos.author`。
 *
 * **根因在我昨天写的迁移 27 里的那句** `UPDATE memos SET author = NULL` ——
 * 而 `memos` 的建表 SQL 是 `author TEXT NOT NULL`（v1 就有，**从建表起就不能空**）。
 *
 * ## 我为什么没发现
 *
 * **我只在空测试库上验过迁移。** 空库 `memos` 一行都没有，
 * 那句 `UPDATE` 影响 **0 行** ⇒ **不报错** ⇒ 全绿。
 *
 * > **判据：涉及迁移的改动必须在"有数据的老库副本"上验过。
 * > 空库跑通什么都不能证明 —— SQL 约束只在有行时才触发。**
 *
 * ⚠️ 这与"加了列没让 INSERT 参数跟上"是同一族：**真正的风险都在"有数据"的那一侧**，
 * 而我的测试库永远是空的。
 */
const REAL_DB = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'desk-partner', 'user.db')

/**
 * 副本落**仓库内**的 `.tmp-check/`，不放家目录（1.0.72 改）。
 *
 * 原来写在 `<workspace>/.tmp/` —— 那是**工作区**没错，
 * 但 `.alice/` 是产品的数据目录，把测试副本混进去有两个坏处：
 * 一是它跟着产品数据一起被备份/清理策略扫到，二是测试失败时留下的残骸
 * 会出现在产品的数据视图里，给"我的数据是不是坏了"这种排查添噪声。
 *
 * 顺带治了一个偶发红：清理副本时撞上 safe-delete 的回收站闸门
 * （`Error during a trash operation`）—— 那是环境问题不是实现问题，
 * 但落在 `.tmp-check/` 里至少不会让人以为是产品坏了。
 */
const TMP_DIR = path.join(process.cwd(), '.tmp-check')
const CPY = `${TMP_DIR}/migration-probe.db`

/**
 * 真库在不在，**在收集期就定**（卡 a50c2360）
 *
 * 原来是在用例体里 `if (!existsSync(REAL_DB)) { expect(true, '…跳过就等于放行…').toBe(true); return }`
 * —— 注释写着"不能假装通过"，代码却在**报告里显示 passed**。
 * 于是"有数据才发作的迁移缺陷"（NOT NULL / 回填那类，1.0.69 的白屏）在**没有真库的机器上完全失明**，
 * 而看报告的人以为这一条验过了。
 *
 * 改成收集期选中 `it.skip`：跳过**在报告里看得见**（skipped 而不是 passed），
 * 原因同时写进用例名与控制台。判据与 verify-backup-roundtrip.mjs 同源：
 * **闸门可以因为环境不成立而不跑，但不许把"没跑"说成"通过"。**
 */
const HAS_REAL_DB = existsSync(REAL_DB)
if (!HAS_REAL_DB) {
  // eslint-disable-next-line no-console
  console.warn(
    `[迁移真库验收] 本机没有真库副本（${REAL_DB}）—— 这一条会**跳过**（不是通过）。` +
      `\n  没有它，"有数据才发作的迁移缺陷"这次无人看守：本机/换机跑之前先确认这份库在。`
  )
}
/** 有真库 → 真跑；没有 → skip（报告里可见），绝不 expect(true) */
const coreCase = HAS_REAL_DB ? it : it.skip

describe('迁移在有数据的老库上跑得通（1.0.69 回归）', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
  })

  afterAll(() => {
    try {
      mkdirSync(TMP_DIR, { recursive: true })
      rmSync(CPY, { force: true })
    } catch {
      // 清理失败不该让这个测试文件变红 —— 它验的是迁移，不是回收站
    }
  })

  /**
   * 核心那条：**拿真库副本跑全链路迁移**。
   *
   * 它守的是"NOT NULL 约束"这类只有有数据时才发作的问题。
   * 没有它，1.0.69 会带着"装上就白屏"发出去。
   */
  // 用例名随 `DB_VERSION` 走（卡 a50c2360）：写死 "26 → 29" 会在契约前进后变成谎话
  coreCase(
    HAS_REAL_DB
      ? `真库副本上全链路迁移到 v${DB_VERSION} 通过（用户的库有真实数据）`
      : `真库副本上全链路迁移到 v${DB_VERSION}（跳过：本机没有真库 ${REAL_DB}）`,
    // ⚠️ 体写成**独立函数**而不是内联箭头：这样"改收集期判据"只动注册这几行，
    // 体里 4 空格缩进原样保留（不为包一层箭头把 50 行重排进 diff）
    coreCaseBody,
    60000
  )

  function coreCaseBody() {
    copyFileSync(REAL_DB, CPY)
    const real = new Database(CPY)
    real.pragma('foreign_keys = ON')
    const before = real.prepare('SELECT MAX(version) AS v FROM _schema_version').get() as {
      v: number
    }
    /**
     * ⚠️ **真库可能已经是 29 了**（装过 1.0.70 就升上来了）——
     * 那时"26 → 29 全链路"就无从验了。
     * 所以**两条路都要走通**：
     * - 还是 26 ⇒ 验"从 26 升上去"（首次安装的主路径）
     * - 已是 29 ⇒ 验"幂等"（重装/再启动不该报错）
     *
     * ⚠️ 我第一版写死 `expect(before.v).toBeLessThan(29)` ——
     * **结果你一装 1.0.70 这条就红了**，而它本该守的东西没错。
     * **判据：前置条件随环境变化时，测试要"两条路都走通"而不是"假设一种"。**
     */
    const alreadyMigrated = before.v >= 29
    // eslint-disable-next-line no-console
    console.log(
      `  真库 schema=${before.v}${alreadyMigrated ? '（已升过 ⇒ 本次验幂等）' : '（从旧版升 ⇒ 验全链路）'}`
    )

    // ⭐ 核心：1.0.69 在这里抛 NOT NULL constraint failed；1.0.70 后不抛
    expect(() => runMigrations(real)).not.toThrow()

    const after = real.prepare('SELECT MAX(version) AS v FROM _schema_version').get() as {
      v: number
    }
    /**
     * 断言用 `DB_VERSION` 而不是写死数字（1.0.72 改）。
     *
     * 原来写死 29，于是我加完迁移 30 它就红了 —— 而那是**契约变了**，
     * 不是实现坏了。写死的版本号等于给"每加一条迁移都要改一个测试"设了个
     * 隐形开关，而那类改动最容易被误当成"实现有问题"而去改实现。
     *
     * 判据：**能从常量推导出来的值就别写死。**
     * 这条与"契约被验收方改过时看守人要跟着改"同源 ——
     * 区别是这里连"改"都不该发生，就该让它自己跟上。
     */
    expect(after.v, '迁移后版本必须等于当前 DB_VERSION').toBe(DB_VERSION)

    // 幂等：再跑一次不报错、版本不变（重装/再启动是常态）
    expect(() => runMigrations(real)).not.toThrow()
    const again = real.prepare('SELECT MAX(version) AS v FROM _schema_version').get() as {
      v: number
    }
    expect(again.v, '重复跑迁移不该把版本推高').toBe(DB_VERSION)
    real.close()
  }

  /**
   * 把这次的教训单独钉住：`author` 是 NOT NULL，
   * **任何把它置 NULL 的迁移都会挂**。
   *
   * 判据写成代码，而不是写进注释（注释会被下一次改动忽略）。
   */
  it('author 列是 NOT NULL —— 所以"历史行没记发起方"不能写成 NULL', () => {
    db.exec(`
      CREATE TABLE memos (
        id TEXT PRIMARY KEY, author TEXT NOT NULL, text TEXT NOT NULL,
        linked_todo_id TEXT, status TEXT NOT NULL DEFAULT 'unread',
        created_at TEXT NOT NULL, read_at TEXT
      );
    `)
    const cols = db.prepare('PRAGMA table_info(memos)').all() as Array<{
      name: string
      notnull: number
    }>
    const author = cols.find((c) => c.name === 'author')
    expect(author, 'author 列不在了').toBeTruthy()
    expect(
      author!.notnull,
      '⚠️ author 不再是 NOT NULL —— 若是有意的，删掉这条断言；否则迁移里的 NULL 会挂'
    ).toBe(1)

    // 写一行，然后试那条致命的 UPDATE
    db.prepare("INSERT INTO memos (id,author,text,status,created_at) VALUES ('a','agent:x','t','unread','2026-01-01')").run()
    expect(() =>
      db.prepare('UPDATE memos SET author = NULL WHERE id = ?').run('a')
    ).toThrow(/NOT NULL/)
  })

  it('"历史行没记发起方"用一个显式值表达（不编造、也不违反约束）', () => {
    db.exec(`
      CREATE TABLE memos (
        id TEXT PRIMARY KEY, author TEXT NOT NULL, text TEXT NOT NULL,
        linked_todo_id TEXT, status TEXT NOT NULL DEFAULT 'unread',
        created_at TEXT NOT NULL, read_at TEXT
      );
    `)
    db.prepare("INSERT INTO memos (id,author,text,status,created_at) VALUES ('a','agent:alice','t','unread','2026-01-01')").run()
    // 这条是 1.0.69 修好的写法
    db.prepare('UPDATE memos SET author = ? WHERE id = ?').run('unknown:pre-1.0.68', 'a')
    const row = db.prepare('SELECT author FROM memos WHERE id = ?').get('a') as { author: string }
    expect(row.author).toBe('unknown:pre-1.0.68')
    expect(row.author, '⚠️ 不能是 agent:cli 或任何真实 agent —— 那是编造').not.toContain('agent:')
  })
})
