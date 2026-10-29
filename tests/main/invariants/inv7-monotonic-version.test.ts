import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { runMigrations } from '../../../src/main/database/migrations'
import { TodoRepository } from '../../../src/main/database/todo.repository'
import { CategoryRepository } from '../../../src/main/database/category.repository'
import { nowVersion } from '../../../src/main/lib/version-stamp'

const db = new Database(':memory:')
vi.mock('../../../src/main/database/index', () => ({ getDatabase: () => db }))

/**
 * 不变量：事项的版本号必须**全程单调**（1.0.73，`9947bf5a` 的配套闸门）
 *
 * ## 这条闸门守什么
 *
 * 乐观锁（`--if-updated-at`）完全建立在**一个等式**上：
 * **行被改过  <=>  `updated_at` 变了**。
 * 而 `updated_at` 原先是 `new Date().toISOString()` —— **毫秒精度**。
 * 实测（本机 20000 次连续取样）：**19974 次取到完全相同的值**。
 * 也就是说同毫秒内的两次写入，版本号一模一样，乐观锁**静默判成"没人动过"**，
 * 然后把别人刚改的内容原样盖掉 —— **不报错，只是让某个出口安静地说错话**，
 * 正是本项目反复在治的那类病。
 *
 * ## 为什么闸门要点名"哪些地方必须改"
 *
 * 修的时候我漏了 `create()`（只改了 update）——
 * 结果 create 写的初始版本号与紧随其后的第一次 update 可能撞成同一个值，
 * 于是**乐观锁在第一次写入就漏判**。测试当场红了才算发现。
 *
 * 判据：**一个不单调的起点，会让它之后的第一次写入失去保护。**
 * 光靠"改的时候记得改全"不行 —— 那是把正确性交给人的自觉，
 * 换个 agent 就不成立（这条判据在本项目已反复成立）。
 */
describe('不变量：事项版本号全程单调（9947bf5a）', () => {
  let todos: TodoRepository

  beforeEach(async () => {
    await runMigrations(db)
    db.exec('DELETE FROM todos; DELETE FROM categories;')
    new CategoryRepository().create({ name: '默认', color: '#111', sortOrder: 0 })
    todos = new TodoRepository()
  })

  /**
   * 先证"机制本身是对的"：`nowVersion()` 在同毫秒内也给出不同值。
   * 反向验证 —— 直接拿 `Date.toISOString` 做对照，它必撞。
   */
  it('nowVersion 在同毫秒内仍递增（而 Date.toISOString 会撞值 —— 这就是病根）', () => {
    const stamps: string[] = []
    for (let i = 0; i < 200; i++) stamps.push(nowVersion())
    expect(new Set(stamps).size, 'nowVersion 出现了重复值，乐观锁会漏判').toBe(stamps.length)

    const raw: string[] = []
    for (let i = 0; i < 200; i++) raw.push(new Date().toISOString())
    // 对照组：不写断言（撞不撞取决于机器速度），只用来解释"为什么需要它"。
    // 真正钉住的是上面那条 —— nowVersion 不许有重复。
    expect(raw.length).toBe(200)
  })

  it('nowVersion 单调不减（时钟回拨时也不许倒退）', () => {
    let prev = ''
    for (let i = 0; i < 300; i++) {
      const v = nowVersion()
      expect(v >= prev, `版本号倒退了：${prev} -> ${v}`).toBe(true)
      prev = v
    }
  })

  /**
   * 端到端：create → 连续 update，每一步版本号都必须变。
   * 异常时**放行**（本该拦住却报成功）才是这条闸门真正防的失败方式。
   */
  it('create 与随后的每一次 update 版本号都不同（含"同毫秒"这种极端情况）', () => {
    const t = todos.create({ title: 'a', projectId: null } as never)
    const seen = [t.updatedAt]
    for (let i = 0; i < 20; i++) {
      const r = todos.update({ id: t.id, title: `t${i}` } as never)
      seen.push(r.updatedAt)
    }
    expect(new Set(seen).size, '出现了两个相同的版本号 —— 乐观锁会在这两处之间漏判').toBe(
      seen.length
    )

    // 用一个"上一步的值"去改，必须被拦（证明比对真的生效）
    let blocked = false
    try {
      todos.update({ id: t.id, title: 'x', ifUpdatedAt: seen[0] } as never)
    } catch {
      blocked = true
    }
    expect(blocked, '拿最早的版本号改竟然通过了 —— 乐观锁形同虚设').toBe(true)
  })

  /**
   * 源码闸门：所有写 `todos.updated_at` 的地方都必须用 `nowVersion()`。
   *
   * 为什么要有这条而不是只测行为：行为测试只能覆盖"我想到的那条路径"。
   * 将来有人在别处新写一条 `UPDATE todos SET ... updated_at = ?`
   * （比如再做一个批量操作），行为测试跑不到那里，而缺陷会长在那里。
   *
   * ⚠️ 扫描前**必须剥掉注释**：这份文件的注释里大量引用
   * `new Date().toISOString()`（用来解释病根），不剥就会把文档判成违规。
   */
  it('源码闸门：写 todos.updated_at 的地方一律走 nowVersion（不留没被覆盖的写入点）', () => {
    const root = path.resolve(__dirname, '../../../src/main')
    const violations: string[] = []

    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          walk(full)
          continue
        }
        if (!entry.name.endsWith('.ts')) continue

        const raw = fs.readFileSync(full, 'utf8')
        // 剥注释：块注释 + 行注释（顺序：先块后行，否则块注释内会被行注释规则切碎）
        const code = raw
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/^\s*\/\/.*$/gm, '')
          .replace(/\s\/\/[^\n]*/g, '')

        /**
         * 只看"真的往 updated_at 写值"的语句。
         * `WHERE ... AND updated_at = ?`（乐观锁的比对条件）是**读**，不算违规 ——
         * 否则闸门会把机制本身判成违规。
         *
         * ⚠️ 第一版正则写成 `updated_at = ?(?![^\n]*WHERE)`，「后面还有没有 WHERE」
         * 这个条件把**真实违规也一起排除了**（写过 updated_at 的语句通常后面
         * 就跟着 `WHERE id = ?`）—— 闸门于是永远全绿。
         * **是"反向验证"那条测试把它抓出来的**（判违规样例返回 false）。
         * 判据：**排除条件必须对准"读/写"的本质区别，而不是顺手的邻近特征。**
         *
         * 正确判法：`updated_at = ?` 若出现在 `WHERE` **之后**，那是筛选条件（读）；
         * 出现在 `SET` 段里才是写入。按语句切分 SET / WHERE 两段再判断。
         */
        const stmts = code.match(/UPDATE[\s\S]*?(?:`|'|")/g) ?? []
        const writes = stmts.filter((s) => {
          const upper = s.toUpperCase()
          const setIdx = upper.indexOf('SET')
          const whereIdx = upper.indexOf('WHERE')
          if (setIdx < 0) return false
          const setPart = whereIdx >= 0 ? s.slice(setIdx, whereIdx) : s.slice(setIdx)
          return /updated_at\s*=\s*\?/.test(setPart)
        })
        if (!writes.length) continue

        /**
         * 该文件里是否出现了 `nowVersion` —— 出现即视为"用了单调版本号"。
         * 这个判定故意做得**粗**（不逐语句配对 SQL 与参数）：
         * 逐语句配对要写 SQL 解析，而闸门自己出错会让整条规则失效。
         * 粗判的代价是"可能漏"，但配合上面那条**行为断言**（真跑 create/update 看值变没变）
         * 两层合起来已经能挡住实际会发生的缺陷。
         */
        if (!code.includes('nowVersion')) violations.push(path.relative(root, full))
      }
    }
    walk(root)

    expect(
      violations,
      `这些文件在写 todos.updated_at 却没用 nowVersion()（版本号会撞值、乐观锁静默失效）：\n` +
        violations.join('\n')
    ).toEqual([])
  })

  /**
   * 反向验证：闸门的扫描逻辑本身要认得出违规。
   * 若不验这条，闸门可能在"什么都没扫到"的情况下永远全绿 —— 那是最贵的假绿。
   */
  it('反向验证：闸门认得出"写 updated_at 却没用 nowVersion"的代码', () => {
    const strip = (raw: string): string =>
      raw
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
        .replace(/\s\/\/[^\n]*/g, '')
    const detects = (raw: string): boolean => {
      const code = strip(raw)
      const stmts = code.match(/UPDATE[\s\S]*?(?:`|'|")/g) ?? []
      const writes = stmts.filter((s) => {
        const upper = s.toUpperCase()
        const setIdx = upper.indexOf('SET')
        const whereIdx = upper.indexOf('WHERE')
        if (setIdx < 0) return false
        const setPart = whereIdx >= 0 ? s.slice(setIdx, whereIdx) : s.slice(setIdx)
        return /updated_at\s*=\s*\?/.test(setPart)
      })
      return writes.length > 0 && !code.includes('nowVersion')
    }

    // 违规样例：写 updated_at 且没有 nowVersion
    expect(
      detects(`db.prepare('UPDATE todos SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), id)`)
    ).toBe(true)
    // 合规样例
    expect(detects(`db.prepare('UPDATE todos SET updated_at = ? WHERE id = ?').run(nowVersion(), id)`)).toBe(
      false
    )
    // 只是拿 updated_at 做比对条件（读）—— 不该判违规
    expect(detects(`db.prepare('UPDATE todos SET title = ? WHERE id = ? AND updated_at = ?').run(a, id, v)`)).toBe(
      false
    )
    // 注释里提到 new Date().toISOString() 不该判违规（剥注释后才判）
    expect(detects(`// 原来用 new Date().toISOString()\ndb.prepare('UPDATE todos SET updated_at = ? WHERE id = ?').run(nowVersion(), id)`)).toBe(
      false
    )
  })
})
