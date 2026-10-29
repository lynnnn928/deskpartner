/**
 * 迁移并发安全（`c5b30fb3`，主用户 2026-10-08 拍板按建议①）
 *
 * ## 要钉住的三件事（卡面原文）
 *
 * > ① 迁移加进程级排他 ② 迁移失败硬停（明确报错退出，不带病跑命令）
 * > ③ 备份/清理纳入同一临界区
 *
 * 本文件钉 ①③；② 的"启动边界硬停"在 `migration-hardstop-c5b30fb3.test.ts`。
 *
 ## 复现（2026-10-08 22:46 本机实测）
 *
 * 两个新构建进程毫秒级同时首启同一库、都触发 v31→v32：
 * 一个成功，另一个 `SqliteError: duplicate column name: tested` ——
 * 未处理拒绝、进程带着不确定的库状态继续跑命令。
 *
 * ## 每条用例都配了反向验证（摘掉机制必须变红）
 *
 * | 用例 | 违规注入 | 会怎么红 |
 * |---|---|---|
 * | 拿锁前不动库 | 备份挪到锁外 | 等锁期间留下备份文件 → 断言数到 1 个 |
 * | 等锁后复核版本 | 版本复核挪到锁外 | 重跑迁移撞 duplicate column → 抛错 |
 * | 真子进程互斥 | 摘掉锁 | 不再等 700ms → 耗时断言红 |
 * | 死人锁能破 | 摘掉抢锁 | 等到超时 → 抛 MigrateLockTimeoutError |
 * | 失败转 MigrationError | 摘掉包装 | 抛的是裸 Error → instanceof 红 |
 */
import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import {
  runMigrations,
  MigrationError,
  pruneOldBackups
} from '../../../src/main/database/migrations'
import {
  createFileMigrateLock,
  noopMigrateLock,
  MigrateLockTimeoutError,
  type MigrateLock
} from '../../../src/main/database/migrate-lock'
import { DB_VERSION } from '../../../src/renderer/lib/constants'

/** 每条用例一个独立目录：vitest 多 worker 并行，共用目录会互相踩锁 */
function freshDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dp-miglock-'))
}

const backupsOf = (dbPath: string) =>
  fs
    .readdirSync(path.dirname(dbPath))
    .filter((f) => f.startsWith(`${path.basename(dbPath)}.backup-`))

const lockPathOf = (dbPath: string) => `${dbPath}.migrate.lock`

const versionOf = (conn: Database.Database): number => {
  try {
    const row = conn.prepare('SELECT MAX(version) AS v FROM _schema_version').get() as
      | { v: number | null }
      | undefined
    return row?.v ?? 0
  } catch {
    return 0
  }
}

describe('迁移跨进程排他与临界区（c5b30fb3）', () => {
  it('③ 拿锁前不动库：等锁期间不写备份、不迁版本（备份/清理必须在临界区内）', () => {
    const dir = freshDir()
    const dbPath = path.join(dir, 'user.db')
    /**
     * 子进程以**活进程**身份占住锁 3 秒 —— 父进程用短超时去撞。
     * 若备份/迁移被挪到锁外，等锁的这 300ms 里就会留下备份文件。
     */
    const child = spawn(
      process.execPath,
      [
        '-e',
        `
        const fs = require('fs')
        const lock = ${JSON.stringify(lockPathOf(dbPath))}
        fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }))
        fs.writeFileSync(${JSON.stringify(path.join(dir, 'ready'))}, '1')
        setTimeout(() => process.exit(0), 3000)
        `
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    )

    // 确定性同步：等子进程真的把锁建好（不赌 sleep）
    const deadline = Date.now() + 5000
    while (!fs.existsSync(path.join(dir, 'ready'))) {
      if (Date.now() > deadline) throw new Error('子进程没起来')
    }

    const conn = new Database(dbPath)
    expect(() =>
      runMigrations(conn, {
        lock: createFileMigrateLock(dbPath, { timeoutMs: 300, pollMs: 20 })
      })
    ).toThrow(MigrateLockTimeoutError)

    // ⭐ 反向验证：备份若在锁外，这里会数到文件
    expect(backupsOf(dbPath), '等锁期间不许动库（备份挪出临界区就会留痕）').toEqual([])
    expect(versionOf(conn), '版本号不许在锁外被写').toBe(0)
    child.kill()
  }, 20000)

  it('① 等锁后必须复核版本：等待期间别人已迁完 ⇒ 我不能再跑一遍（撞 duplicate column）', () => {
    const dir = freshDir()
    const dbPath = path.join(dir, 'user.db')
    const connA = new Database(dbPath)
    const connB = new Database(dbPath)

    /**
     * 注入锁：acquire 里先"放另一个进程迁完"再放行 ——
     * 这正是实测事故的时序（我读到待迁移，等的工夫别人迁完了）。
     *
     * ⚠️ 反向验证：若版本复核被挪到锁外/被去掉，外层会拿着过期事实
     * 重跑全部迁移 —— v4 起有 ALTER ADD COLUMN，必撞
     * `duplicate column name` → 下面的 not.toThrow() 变红。
     */
    let otherMigrated = false
    const interleaved: MigrateLock = {
      acquire() {
        if (otherMigrated) return
        otherMigrated = true
        runMigrations(connB, { lock: noopMigrateLock() })
      },
      release() {}
    }

    expect(() => runMigrations(connA, { lock: interleaved })).not.toThrow()
    expect(versionOf(connA)).toBe(DB_VERSION)
    // 两个进程各迁各的才会出两个备份；正确行为只该有一个（后到者复核后直接跳过）
    expect(backupsOf(dbPath), '后到者不许重复迁移/重复备份').toHaveLength(1)
  }, 20000)

  it('① 真子进程互斥：别人持锁时我必须等，等完才动库', async () => {
    const dir = freshDir()
    const dbPath = path.join(dir, 'user.db')
    const conn = new Database(dbPath)

    const child = spawn(
      process.execPath,
      [
        '-e',
        `
        const fs = require('fs')
        const lock = ${JSON.stringify(lockPathOf(dbPath))}
        fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }))
        fs.writeFileSync(${JSON.stringify(path.join(dir, 'ready'))}, '1')
        setTimeout(() => { fs.unlinkSync(lock); process.exit(0) }, 700)
        `
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    )
    const deadline = Date.now() + 5000
    while (!fs.existsSync(path.join(dir, 'ready'))) {
      if (Date.now() > deadline) throw new Error('子进程没起来')
    }

    const t0 = Date.now()
    expect(() => runMigrations(conn)).not.toThrow() // 默认锁：文件锁，等对方放
    const elapsed = Date.now() - t0
    await new Promise((r) => child.on('close', r))

    // ⭐ 反向验证：摘掉锁就不再等这 700ms → 这条断言立刻红
    expect(elapsed, '必须等持锁者放完才迁移').toBeGreaterThanOrEqual(400)
    expect(versionOf(conn)).toBe(DB_VERSION)
    // 迁完锁必须被清掉：留着就是下一次启动的假"有人在迁移"
    expect(fs.existsSync(lockPathOf(dbPath)), '迁移完必须释放锁文件').toBe(false)
  }, 20000)

  it('① 死人锁能破：持锁进程已死 ⇒ 立即接手，不等到天荒地老', async () => {
    const dir = freshDir()
    const dbPath = path.join(dir, 'user.db')
    const conn = new Database(dbPath)

    // 先起一个必然退出的子进程，用它的 pid 当"死者"
    const dead = spawn(process.execPath, ['-e', 'process.exit(0)'], {
      stdio: ['ignore', 'pipe', 'pipe']
    })
    await new Promise((r) => dead.on('close', r))
    fs.writeFileSync(
      lockPathOf(dbPath),
      JSON.stringify({ pid: dead.pid, startedAt: new Date().toISOString() })
    )

    // ⭐ 反向验证：抢锁逻辑摘掉 → 这里等到超时抛错 → 变红
    expect(() =>
      runMigrations(conn, {
        lock: createFileMigrateLock(dbPath, { timeoutMs: 1500, pollMs: 20 })
      })
    ).not.toThrow()
    expect(versionOf(conn)).toBe(DB_VERSION)
  }, 20000)

  it('① 残锁（写锁文件途中崩溃留下的空文件）过宽限期也能破', () => {
    const dir = freshDir()
    const dbPath = path.join(dir, 'user.db')
    const conn = new Database(dbPath)

    fs.writeFileSync(lockPathOf(dbPath), '') // 崩在 create 与 write 之间：空文件
    const old = new Date(Date.now() - 60_000)
    fs.utimesSync(lockPathOf(dbPath), old, old) // 已过 10s 宽限期

    expect(() =>
      runMigrations(conn, {
        lock: createFileMigrateLock(dbPath, { timeoutMs: 1500, pollMs: 20 })
      })
    ).not.toThrow()
    expect(versionOf(conn)).toBe(DB_VERSION)
  }, 20000)

  it('② 迁移失败抛 MigrationError：回滚到旧版本、报文自带备份路径（硬停的上半段）', () => {
    const dir = freshDir()
    const dbPath = path.join(dir, 'user.db')
    const conn = new Database(dbPath)

    /**
     * 注入迁移列表（仅可测性）：第一条就炸。
     * 不写死版本号 —— 加迁移不必回来改这条用例（能从常量推导的值不写死）。
     */
    const boom = Array.from({ length: DB_VERSION }, (_, i) =>
      i === 0
        ? () => {
            throw new Error('模拟迁移失败')
          }
        : () => {}
    )

    let caught: unknown = null
    try {
      runMigrations(conn, { migrations: boom })
    } catch (e) {
      caught = e
    }

    // ⭐ 反向验证：摘掉 MigrationError 包装 → 裸 Error → 这两行红
    expect(caught).toBeInstanceOf(MigrationError)
    const err = caught as MigrationError
    expect(err.message).toContain('数据库迁移失败')
    expect(err.message).toContain('模拟迁移失败')
    expect(err.message).toContain('迁移前已备份')

    // 备份真的在，且报文里的路径就是它 —— "明确报错"要能指着东西说话
    const backups = backupsOf(dbPath)
    expect(backups).toHaveLength(1)
    expect(err.backupPath).toBe(path.join(dir, backups[0]))

    // 事务回滚：版本不许被推高（否则下次启动就"已是最新"而库是坏的）
    expect(versionOf(conn)).toBe(0)
    // 库还活着（回滚干净），不是一具尸体
    expect(() => conn.prepare('SELECT 1').get()).not.toThrow()
  }, 20000)

  it('内存库不建锁文件（单测路径保持零副作用）', () => {
    const conn = new Database(':memory:')
    expect(() => runMigrations(conn)).not.toThrow()
    expect(versionOf(conn)).toBe(DB_VERSION)
    // :memory: 没有文件可配对，也就绝不该出现 '.migrate.lock' 之类的残留
    expect(fs.existsSync(path.join(os.tmpdir(), ':memory:.migrate.lock'))).toBe(false)
  }, 20000)

  it('锁实现自带兜底：release 只删自己持有的锁', () => {
    const dir = freshDir()
    const dbPath = path.join(dir, 'user.db')
    const lock = createFileMigrateLock(dbPath)
    // 没 acquire 过就 release —— 不该把别人的锁删掉
    fs.writeFileSync(
      lockPathOf(dbPath),
      JSON.stringify({ pid: 999, startedAt: new Date().toISOString() })
    )
    lock.release()
    expect(fs.existsSync(lockPathOf(dbPath)), '没持有过的锁不许删').toBe(true)
    pruneOldBackups(dbPath) // 顺手确认这文件不干扰备份清理逻辑
  })

  /**
   * `30d651ac`：Windows 上 `wx` 拿不到锁时返回的是 EPERM/EACCES/EBUSY，不是 EEXIST
   *
   * 真机要撞上 Windows 的 delete-pending 窗口才会出现（178 个文件并发一轮里见过 1 次），
   * 所以用注入的 fs 把那一刻**确定性地**造出来：第一次 openSync 抛 EPERM，之后放行。
   * ⭐ 反向验证：从 `LOCK_BUSY_CODES` 里拿掉 EPERM → 第一条立刻红（裸 Error 冒出去）。
   */
  it('Windows 抖动：openSync 抛 EPERM 要当成"没抢到"继续等，不许冒出裸错误', () => {
    const dir = freshDir()
    const dbPath = path.join(dir, 'user.db')
    let attempts = 0
    const flaky = {
      ...fs,
      openSync: ((p: fs.PathLike, flags: string, mode?: fs.Mode) => {
        attempts += 1
        if (attempts === 1) {
          const err = new Error(
            `EPERM: operation not permitted, open '${String(p)}'`
          ) as NodeJS.ErrnoException
          err.code = 'EPERM'
          throw err
        }
        return fs.openSync(p, flags, mode)
      }) as typeof fs.openSync
    }

    const lock = createFileMigrateLock(dbPath, { timeoutMs: 2000, pollMs: 5, fs: flaky })
    expect(() => lock.acquire()).not.toThrow()
    expect(attempts, 'EPERM 之后必须再来一轮').toBeGreaterThanOrEqual(2)
    // 第二轮真的把锁建出来了 —— 不是"跳过建锁直接算拿到"
    expect(fs.existsSync(lockPathOf(dbPath))).toBe(true)
    lock.release()
    expect(fs.existsSync(lockPathOf(dbPath))).toBe(false)
  })

  it('真错误照旧上抛：ENOENT（目录不存在）不许被当成"没抢到"吞成等待', () => {
    const dbPath = path.join(freshDir(), 'no-such-dir', 'user.db') // 父目录不存在
    const lock = createFileMigrateLock(dbPath, { timeoutMs: 1000, pollMs: 5 })
    let caught: unknown = null
    try {
      lock.acquire()
    } catch (e) {
      caught = e
    }
    // ⭐ 反向验证：把 ENOENT 也塞进轮询集合 → 这里变成 MigrateLockTimeoutError（或干脆挂住）
    expect(caught).toBeInstanceOf(Error)
    expect((caught as NodeJS.ErrnoException).code).toBe('ENOENT')
    expect(caught).not.toBeInstanceOf(MigrateLockTimeoutError)
  })

  it('抢不掉的残锁不许死转：unlink 一直失败时也要走到上界并按超时报错', () => {
    const dir = freshDir()
    const dbPath = path.join(dir, 'user.db')
    fs.writeFileSync(lockPathOf(dbPath), '') // 空文件 = 残锁，过了宽限期就判定"可抢"
    const old = new Date(Date.now() - 60_000)
    fs.utimesSync(lockPathOf(dbPath), old, old)

    let spins = 0
    const undeletable = {
      ...fs,
      unlinkSync: ((p: fs.PathLike) => {
        spins += 1
        const err = new Error(`EPERM: operation not permitted, unlink '${String(p)}'`) as NodeJS.ErrnoException
        err.code = 'EPERM'
        throw err
      }) as typeof fs.unlinkSync
    }

    const lock = createFileMigrateLock(dbPath, { timeoutMs: 200, pollMs: 10, fs: undeletable })
    // ⭐ 反向验证：抢锁分支里直接 continue（不落等待/不判上界）→ 这里永远不返回
    expect(() => lock.acquire()).toThrow(MigrateLockTimeoutError)
    // 死转的形态是几百上千次；正常轮询 200ms/10ms 只有十几次
    expect(spins, '每轮只该试一次 unlink').toBeLessThan(100)
  })
})
