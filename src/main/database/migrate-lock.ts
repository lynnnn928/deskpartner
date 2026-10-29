import fs from 'node:fs'

/**
 * 迁移排他锁（`c5b30fb3`，主用户 2026-10-08 拍板按建议①）
 *
 * ## 问题（2026-10-08 22:46 本机实测，两个进程毫秒级同时首启同一库）
 *
 * 两个实例同时触发 v31→v32 迁移：一个成功，另一个死在
 * `SqliteError: duplicate column name: tested` —— 而且是**未处理的 Promise 拒绝**，
 * 进程带着不确定的库状态继续跑命令。谁先谁后纯靠运气。
 *
 * ## 为什么用文件锁，而不是 SQLite 自己的写锁（`BEGIN IMMEDIATE`）
 *
 * 临界区里有两样东西**必须在事务外**：
 * - `wal_checkpoint(TRUNCATE)`（事务内跑不了）；
 * - 迁移前备份的 `fs.copyFileSync`（要拷到的是 checkpoint 后的完整文件）。
 *
 * 所以临界区 = 文件锁（进程级排他，跨进程、跨通道都算数），
 * 事务只负责"迁移本身要么全成要么全滚"。两者各管一层。
 *
 * ## 判据
 *
 * 1. **同一时刻只有一个实例能进"版本复核 → 备份/清旧备份 → 迁移"**；
 * 2. **死人锁必须能破**（进程崩溃留下的锁文件不能永久卡死启动）；
 * 3. 等待有上界，超时给明确报错（不静默、不永久挂住）。
 */

/**
 * 「这一轮就是拿不到锁」的错误码（`30d651ac`）
 *
 * 原先只认 `EEXIST`（`wx` 遇到已有文件）。但 Windows 上还有一类**同一语义**的
 * 失败：锁文件正被删（delete-pending）、被杀软/索引临时占住的那一瞬间，
 * `wx` 打开返回的是 `EPERM` / `EACCES` / `EBUSY`，而不是 `EEXIST`。
 *
 * 实测代价：1.0.113 发版链跑全量测试时，`migration-lock-c5b30fb3` 的
 * 「真子进程互斥」用例红了一次 —— 持锁子进程 700ms 后 `unlinkSync(lock)`，
 * 父进程恰好在这个窗口里抢锁，`EPERM` 一路冒出 `acquire()`，
 * 报出来的既不是 `MigrateLockTimeoutError`，也不带「确认没有实例在迁移后
 * 可删除锁文件重试」那句自救提示，而是一句裸的 `operation not permitted`。
 *
 * 这四个码的语义都是"现在拿不到，等下一轮"，所以进轮询分支；
 * 其余错误（`ENOENT` / `EROFS` / `ENOSPC`…）照旧上抛 —— 不许把真错误吞成等待。
 */
const LOCK_BUSY_CODES = new Set(['EEXIST', 'EPERM', 'EACCES', 'EBUSY'])

/** 只用到这六个调用点；单列出来是为了让"仅可测性注入"能把它整个换掉 */
export interface MigrateLockFs {
  openSync: typeof fs.openSync
  writeSync: typeof fs.writeSync
  closeSync: typeof fs.closeSync
  readFileSync: typeof fs.readFileSync
  statSync: typeof fs.statSync
  unlinkSync: typeof fs.unlinkSync
}

export interface MigrateLock {
  /** 拿不到就一直等到上界；超时抛 {@link MigrateLockTimeoutError} */
  acquire(): void
  /** 释放自己持有的锁；没持有过就是 no-op */
  release(): void
}

/** 等锁超时：另一个实例长时间占着迁移锁（或锁文件残留且持有者查不出死活） */
export class MigrateLockTimeoutError extends Error {
  readonly lockPath: string
  constructor(lockPath: string, waitedMs: number) {
    super(
      `另一个实例正在迁移数据库，等待 ${waitedMs}ms 仍未完成。` +
        `锁文件：${lockPath}（确认没有实例在迁移后，可删除该文件重试）`
    )
    this.name = 'MigrateLockTimeoutError'
    this.lockPath = lockPath
  }
}

/** 无锁实现：内存库（单测）没有跨进程问题，不需要排他 */
export function noopMigrateLock(): MigrateLock {
  return {
    acquire() {},
    release() {}
  }
}

interface LockHolder {
  pid: number
  startedAt: string
}

/** 进程是否还活着。EPERM = 进程存在但无权限 → 算活（宁可等，不抢活人的锁） */
function defaultIsPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export interface FileMigrateLockOptions {
  /** 等锁上界（默认 30s：备份几 MB 库是亚秒级，30s 还没完就是出事了） */
  timeoutMs?: number
  /** 轮询间隔 */
  pollMs?: number
  /** 仅可测性：注入"判活"实现 */
  isPidAlive?: (pid: number) => boolean
  /** 仅可测性：注入时钟 */
  now?: () => number
  /**
   * 仅可测性：注入 fs（`30d651ac`）
   *
   * `EPERM` 那条分支在真机上**概率低且不可控**（要恰好撞上 Windows 的
   * delete-pending 窗口），只能靠注入伪造："第一次 openSync 抛 EPERM、第二次放行"。
   * 与 `isPidAlive` / `now` 同一套做法 —— 生产调用不传，永远走真 fs。
   */
  fs?: MigrateLockFs
}

/**
 * 锁文件损坏（创建与写入之间崩溃）时的抢锁宽限期：
 * 空文件可能是别人**正在写**，先等一会再判"写锁文件的人已经不在了"。
 */
const CORRUPT_LOCK_GRACE_MS = 10_000

/**
 * 用 `<db>.migrate.lock` 旁的锁文件做进程级排他。
 *
 * 创建用 `wx`（原子独占创建）—— 两个进程同时抢，内核只让一个赢，
 * 不需要任何"先查后写"的临界判断（那正是竞态的来源）。
 *
 * ⚠️ 不可重入：同一个进程里 acquire 两次会自己等死自己。
 * 调用点只有 `runMigrations` 一处，天然单次。
 */
export function createFileMigrateLock(
  dbPath: string,
  options: FileMigrateLockOptions = {}
): MigrateLock {
  const lockPath = `${dbPath}.migrate.lock`
  const timeoutMs = options.timeoutMs ?? 30_000
  const pollMs = options.pollMs ?? 50
  const isPidAlive = options.isPidAlive ?? defaultIsPidAlive
  const now = options.now ?? Date.now
  const io: MigrateLockFs = options.fs ?? fs
  let owned = false

  const readHolder = (): LockHolder | null => {
    try {
      const parsed = JSON.parse(io.readFileSync(lockPath, 'utf-8') as string) as Partial<LockHolder>
      if (typeof parsed.pid !== 'number') return null
      return { pid: parsed.pid, startedAt: String(parsed.startedAt ?? '') }
    } catch {
      return null
    }
  }

  const lockAgeMs = (): number => {
    try {
      return now() - io.statSync(lockPath).mtimeMs
    } catch {
      return Infinity // 读不到 mtime 当"很老"，尽快走抢锁分支
    }
  }

  /** 阻塞睡眠：runMigrations 是同步函数，不能用 setTimeout 让出事件循环 */
  const sleep = (ms: number): void => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  }

  return {
    acquire() {
      const startedAt = now()
      for (;;) {
        try {
          const fd = io.openSync(lockPath, 'wx')
          try {
            io.writeSync(
              fd,
              JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })
            )
          } finally {
            io.closeSync(fd)
          }
          owned = true
          return
        } catch (err) {
          // EEXIST 与 Windows 上的 EPERM/EACCES/EBUSY 都是"这一轮没抢到"，等下一轮；
          // 其余错误照旧上抛（`30d651ac`）
          if (!LOCK_BUSY_CODES.has((err as NodeJS.ErrnoException).code ?? '')) throw err
        }

        // 没抢到：看持有者是谁，决定"等"还是"抢"
        const holder = readHolder()
        const stealable = holder === null ? lockAgeMs() > CORRUPT_LOCK_GRACE_MS : !isPidAlive(holder.pid)
        if (stealable) {
          /**
           * 死人锁/残锁必须能破：否则一次崩溃就永久卡死启动 ——
           * "能破"与"不抢活人的锁"二选一的话，前者管故障恢复，优先。
           *
           * ⚠️ 删掉了也要落到下面的等待，不许直接 `continue`：
           * Windows 上锁文件可能正处于 delete-pending，`unlinkSync` 会一直抛
           * EPERM —— 那时"抢不到"和"删不掉"同时发生，直接跳回循环顶就成了
           * **不带 sleep 的死转**（既不超时也不让路）。
           */
          try {
            io.unlinkSync(lockPath)
            continue
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue // 被别人抢先清掉了，正好
            // 删不掉：等下一轮再来一次，由上界兜底
          }
        }

        const waited = now() - startedAt
        if (waited >= timeoutMs) throw new MigrateLockTimeoutError(lockPath, waited)
        sleep(Math.min(pollMs, Math.max(1, timeoutMs - waited)))
      }
    },

    release() {
      if (!owned) return
      owned = false
      try {
        io.unlinkSync(lockPath)
      } catch {
        /* 已被清掉就算了，删除失败不该把迁移流程搞挂 */
      }
    }
  }
}
