/**
 * 并发写验证（1.0.73，`4f5f46cf`）
 *
 * ## 为什么要专门验这件事
 *
 * 本机**已有四个写入方**（alice / Bob / human / kimi）共写同一份 SQLite ——
 * 这是当前事实，不是未来场景。而 1.0.68 又增加了写操作，
 * 写变多了，并发覆盖的风险跟着变大。
 *
 * ## 判据（卡上原文，不许改松）
 *
 * > **无丢更新、无死锁、无一边成功一边静默失败**；出现任一情况则升级为 P1。
 *
 * ⚠️ 最后半句是重点：**"一边成功一边静默失败"就是 P1** ——
 * 它与本项目反复在治的那类病同源（通知说假话、状态被覆盖却没人知道）。
 *
 * ## 为什么必须开**真子进程**（踩过两次，记下来免得再犯）
 *
 * 1. 同进程里用 `setTimeout` 模拟"另一个进程 300ms 后提交"**根本不会触发** ——
 *    `repo.update` 是同步阻塞的，事件循环被占死。实测量到 16875ms 的"等锁"。
 * 2. 光靠 `await sleep(150)` 等子进程拿锁是**赌时序**：实测父进程 1ms 就"成功"，
 *    说明那一刻子进程还没起来。→ 必须用 ready 文件做**确定性**同步。
 *
 * ## 与 `optimistic-lock.test.ts` 的分工
 *
 * 那份验的是"单进程里版本戳对不对"；这份验的是**两个进程同时写同一条**时
 * 到底会不会互相盖 —— 后者是前者的动机，前者是后者的手段。
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { runMigrations } from '../../../src/main/database/migrations'
import { TodoRepository, ConflictError } from '../../../src/main/database/todo.repository'
import { CategoryRepository } from '../../../src/main/database/category.repository'

const require = createRequire(import.meta.url)

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-conc-'))
const DB_FILE = path.join(DIR, 'user.db')
const BSQLITE = require.resolve('better-sqlite3')

/**
 * ⚠️ 必须是**文件**库，不能是 `:memory:` —— 子进程是独立进程，
 * 内存库根本不共享。这正是本文件要验的场景。
 */
const conn = new Database(DB_FILE)
conn.pragma('journal_mode = WAL')
// 与生产同值：并发正确性的关键参数，写死在自己的代码里（src/main/database/index.ts）
conn.pragma('busy_timeout = 5000')
vi.mock('../../../src/main/database/index', () => ({ getDatabase: () => conn }))

/**
 * 起一个"另一个进程"：立刻拿到**写锁**，改完 → 写 ready 文件 → 持锁 holdMs → 提交。
 *
 * `BEGIN EXCLUSIVE` 而不是 `IMMEDIATE`：要连读也挡住才好构造
 * "我读的是旧快照"这个窗口（WAL 下 IMMEDIATE 不挡读）。
 *
 * ready 文件是**确定性同步**的关键：靠 sleep 等子进程就是赌时序。
 */
function otherProcess(opts: {
  holdMs: number
  sql: string
  args: unknown[]
}): { ready: Promise<void>; done: Promise<number | null>; stderr: () => string } {
  const readyFile = path.join(DIR, `ready-${Math.random().toString(36).slice(2)}`)
  const script = `
const fs = require('fs')
const D = require(${JSON.stringify(BSQLITE)})
const db = new D(${JSON.stringify(DB_FILE)})
db.pragma('journal_mode = WAL')
db.pragma('busy_timeout = 5000')
db.exec('BEGIN EXCLUSIVE')
db.prepare(${JSON.stringify(opts.sql)}).run(...${JSON.stringify(opts.args)})
fs.writeFileSync(${JSON.stringify(readyFile)}, '1')
setTimeout(() => { db.exec('COMMIT'); db.close(); process.exit(0) }, ${opts.holdMs})
`
  let err = ''
  const child = spawn(process.execPath, ['-e', script], {
    // 显式 stdio：缺了在本机沙箱会 EBUSY，症状是"取不到数"而不是报错
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stderr.on('data', (d) => (err += d))

  const ready = new Promise<void>((resolve) => {
    const tick = setInterval(() => {
      if (fs.existsSync(readyFile)) {
        clearInterval(tick)
        resolve()
      }
    }, 5)
  })
  const done = new Promise<number | null>((resolve) => child.on('close', (c) => resolve(c)))
  return { ready, done, stderr: () => err }
}

const row = (id: string) =>
  conn.prepare('SELECT title, status, priority, is_pinned, updated_at FROM todos WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined

let todos: TodoRepository

describe('并发写：多进程同时改同一条（4f5f46cf）', () => {
  beforeAll(() => {
    runMigrations(conn)
  })

  beforeEach(() => {
    for (const t of ['todo_transitions', 'todo_comments', 'todos', 'categories']) {
      conn.exec(`DELETE FROM ${t};`)
    }
    new CategoryRepository().create({ name: '默认', color: '#111', sortOrder: 0 })
    todos = new TodoRepository()
  })

  /** 造一条待办，并把它的标题/优先级改成"另一个进程写的值" */
  const seed = (title = '初始标题') =>
    todos.create({ title, projectId: null } as never)

  // ══════════════════════════════════════════════════════════════
  // 用例一：两个进程同时对同一条 `todo update`
  //         验 withWriteRetry 与线性退避会不会丢更新
  // ══════════════════════════════════════════════════════════════

  it('一·A 声明了版本 → 第二个写被拦下，且**一个字段都没写进去**（无丢更新）', async () => {
    const t = seed()
    const stale = t.updatedAt

    // 另一个进程把 title / priority 都改了
    const other = otherProcess({
      holdMs: 500,
      sql: 'UPDATE todos SET title = ?, priority = ?, updated_at = ? WHERE id = ?',
      args: ['子进程改的标题', 'urgent', '2099-01-01T00:00:00.000Z', t.id]
    })
    await other.ready

    // 我拿着**过期版本**去改置顶 —— 应该被拦，而不是把别人改的盖掉
    let conflict: unknown = null
    try {
      todos.update({ id: t.id, isPinned: true, ifUpdatedAt: stale })
    } catch (e) {
      conflict = e
    }
    await other.done

    console.log('  [一·A] 子进程 exit=', await other.done, ' 我的冲突=', conflict?.constructor.name)
    console.log('  [一·A] 终态=', JSON.stringify(row(t.id)))
    expect(conflict).toBeInstanceOf(ConflictError)
    const after = row(t.id)!
    // 关键：不仅"我被拦了"，而且**我的那次写没留下任何痕迹**
    expect(after.is_pinned).toBe(0)
    expect(after.title).toBe('子进程改的标题')
    expect(after.priority).toBe('urgent')
  })

  it('一·B 拿着**最新**版本去改 → 放行，不会误报冲突', async () => {
    const t = seed()
    const other = otherProcess({
      holdMs: 300,
      sql: 'UPDATE todos SET title = ?, updated_at = ? WHERE id = ?',
      args: ['别人改的', '2099-01-01T00:00:00.000Z', t.id]
    })
    await other.ready
    await other.done

    // 重读拿到新版本再改 —— 这才是文档教的正确姿势
    const fresh = todos.getById(t.id)!
    expect(fresh.updatedAt).toBe('2099-01-01T00:00:00.000Z')
    const updated = todos.update({ id: t.id, isPinned: true, ifUpdatedAt: fresh.updatedAt })

    expect(updated.isPinned).toBe(true)
    expect(row(t.id)!.title).toBe('别人改的')
  })

  it('一·C 不声明版本时，局部写入也保留另一个进程的标题与优先级', async () => {
    // 1.0.93 将旧缺陷刻画转为正确性回归：默认写入只改显式字段，读前先取得写锁。
    const t = seed()
    const other = otherProcess({
      holdMs: 500,
      sql: 'UPDATE todos SET title = ?, priority = ?, updated_at = ? WHERE id = ?',
      args: ['子进程改的标题', 'urgent', '2099-01-01T00:00:00.000Z', t.id]
    })
    await other.ready

    // 不声明版本 —— 这是当前 CLI 的默认形态（`todo pin` 根本没有传版本的入口）
    const updated = todos.update({ id: t.id, isPinned: true })
    await other.done

    expect(updated.isPinned).toBe(true) // 我成功了
    const after = row(t.id)!
    expect(after.is_pinned).toBe(1)
    // 双方修改互不覆盖，不要求每个普通调用都声明乐观锁。
    expect(after.title).toBe('子进程改的标题')
    expect(after.priority).toBe('urgent')
  }, 30000)

  // ══════════════════════════════════════════════════════════════
  // 用例二：一个 pin、一个 update --status 撞在一起
  //         看守卫判定与写序有没有互相踩
  // ══════════════════════════════════════════════════════════════

  it('二·声明版本后，pin 与改状态不再互相踩（两处改动都保住）', async () => {
    const t = seed()
    const stale = t.updatedAt

    // 另一个进程改状态
    const other = otherProcess({
      holdMs: 400,
      sql: 'UPDATE todos SET status = ?, updated_at = ? WHERE id = ?',
      args: ['in_progress', '2099-01-01T00:00:00.000Z', t.id]
    })
    await other.ready

    // 我置顶 —— 带上过期版本 → 被拦，不写
    // ⚠️ `update` 是**同步**函数：用 toThrow，不是 rejects
    expect(() => todos.update({ id: t.id, isPinned: true, ifUpdatedAt: stale })).toThrow(
      ConflictError
    )
    await other.done

    let after = row(t.id)!
    expect(after.status).toBe('in_progress') // 别人的状态变更保住了
    expect(after.is_pinned).toBe(0) // 我这条没生效（被拦，不是被盖）

    // 重读、带上新版本再来一次 → 这次两处都在
    const fresh = todos.getById(t.id)!
    todos.update({ id: t.id, isPinned: true, ifUpdatedAt: fresh.updatedAt })
    after = row(t.id)!
    expect(after.status).toBe('in_progress')
    expect(after.is_pinned).toBe(1)
  })

  it('二·不声明版本时，置顶仍保留别人刚写的状态', async () => {
    // 默认局部更新不再把旧状态写回。
    const t = seed()
    const other = otherProcess({
      holdMs: 400,
      sql: 'UPDATE todos SET status = ?, updated_at = ? WHERE id = ?',
      args: ['in_progress', '2099-01-01T00:00:00.000Z', t.id]
    })
    await other.ready

    todos.update({ id: t.id, isPinned: true }) // 成功、无报错
    await other.done

    const after = row(t.id)!
    expect(after.is_pinned).toBe(1)
    expect(after.status).toBe('in_progress')
  })

  // ══════════════════════════════════════════════════════════════
  // 用例三：批量写在锁被占时的表现（5000ms busyTimeout 触发时的尾部）
  // ══════════════════════════════════════════════════════════════

  it('三·锁被短时占用 → 等锁后成功，不会失败也不会丢（withWriteRetry + busy_timeout 生效）', async () => {
    const t = seed()
    const other = otherProcess({
      holdMs: 800,
      sql: 'UPDATE todos SET title = ? WHERE id = ?',
      args: ['别的进程写的', t.id]
    })
    await other.ready

    const t0 = Date.now()
    // 批量写是**列级**写（只动 status / updated_at / completed_at）——
    // 所以它天然不会误伤 title，这一点单独钉住
    expect(() => todos.batchUpdateStatus([t.id], 'in_progress')).not.toThrow()
    const waited = Date.now() - t0
    await other.done

    // 等锁上界：必须在 busy_timeout(5000ms) 之内拿到，不能永久挂住（无死锁）
    expect(waited).toBeLessThan(5000)
    const after = row(t.id)!
    expect(after.status).toBe('in_progress')
    expect(after.title).toBe('别的进程写的') // 列级写不误伤别的字段
  }, 30000)

  it('三·锁被占超过 busy_timeout → 报 SQLITE_BUSY，重试到底后上抛，不会死等', async () => {
    const t = seed()
    /**
     * 为什么临时把 busy_timeout 降到 300ms：
     *
     * 生产值 5000ms 下，要真正耗尽 3 次尝试需要子进程持锁 **>15.3s**
     * （3 × 5000ms 等锁 + 100/200ms 退避）—— 为了验"最终会失败上抛"
     * 让每条用例跑 15 秒，代价不成比例。
     *
     * ⚠️ 这里顺带量到一件对生产有意义的事：
     * **`withWriteRetry` 会把最坏等待放大 3 倍**（每次尝试都要重新等满 busy_timeout），
     * 也就是一次最多阻塞 ~15.3s。SQLite 的量级下可接受，
     * 但它意味着"锁被长期占住"时调用方要等这么久才拿到错。
     */
    const original = conn.pragma('busy_timeout', { simple: true }) as number
    conn.pragma('busy_timeout = 300')
    try {
      // 持锁 3s，远长于 3 次尝试的总耗时（300×3 + 300 退避 ≈ 1.2s）
      const other = otherProcess({
        holdMs: 3000,
        sql: 'UPDATE todos SET title = ? WHERE id = ?',
        args: ['占着不放', t.id]
      })
      await other.ready

      const t0 = Date.now()
      let err: unknown = null
      try {
        todos.batchUpdateStatus([t.id], 'in_progress')
      } catch (e) {
        err = e
      }
      const waited = Date.now() - t0
      await other.done

      // 必须**如实抛错**，不能"一边成功一边静默失败"
      expect(err).not.toBeNull()
      expect((err as { code?: string }).code).toBe('SQLITE_BUSY')
      // 无死锁：有明确的失败上界，不会永久挂住
      expect(waited).toBeLessThan(3000)
      // 失败时不留部分改动
      expect(row(t.id)!.status).toBe('todo')
    } finally {
      conn.pragma(`busy_timeout = ${original}`)
    }
  }, 30000)
})
