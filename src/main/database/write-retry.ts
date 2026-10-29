/**
 * 写入重试
 *
 * v2 的核心场景是多个 Agent 同时调 CLI，也就是多个进程同时写同一个 SQLite，
 * 锁冲突是必然会出现的。但这个重试有一个重要边界：
 *
 * **只对"能确认没有写进去"的错误重试。**
 *
 * 如果某个错误发生在写入之后、返回之前，重试就会产生重复数据 ——
 * 待办场景下一件事变成两件，比偶发失败更难收拾。
 * 而 SQLITE_BUSY / SQLITE_LOCKED 的语义是"根本没抢到锁"，
 * 也就是这条语句确实没有执行，重试才是安全的。
 *
 * 对无法判定是否已写入的错误（比如未定位的偶发故障），这里**不重试**，
 * 而是如实抛给上层，由调用方决定是否重来。
 */
/**
 * 是否可以安全重试
 *
 * 判定标准只有一个：**能否确认这条语句没有被执行过**。
 * 满足才可重试，否则重试可能造成重复写入。
 *
 * - SQLITE_BUSY / SQLITE_LOCKED：根本没抢到锁，语句没执行
 * - SQLITE_READONLY：写入被拒绝，语句没执行
 *   （20 进程并发实测中出现过，是 WAL 模式下 -wal / -shm 文件映射
 *   瞬时失败导致的；等一下就好）
 *
 * SQLite 是事务性的，被拒绝的写入不会留下部分改动，所以这两类都安全。
 */
export function isRetryableWriteError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code
  return (
    code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED' || code === 'SQLITE_READONLY'
  )
}

/** 同步休眠（better-sqlite3 是同步 API，不能用 await） */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * 执行写入，遇到锁冲突时退避重试
 *
 * @param label 操作名，仅用于日志
 * @param fn 实际写入逻辑
 * @param maxAttempts 总尝试次数（含第一次）
 */
export function withWriteRetry<T>(label: string, fn: () => T, maxAttempts = 3): T {
  let lastErr: unknown

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return fn()
    } catch (err) {
      // 无法确认"没写成" → 绝不重试，直接抛
      if (!isRetryableWriteError(err)) throw err

      lastErr = err
      if (attempt < maxAttempts) {
        console.warn(
          `[WriteRetry] ${label} 遇到可重试错误(${(err as { code?: string }).code})，` +
            `第 ${attempt}/${maxAttempts} 次尝试后退避重试`
        )
        // 线性退避：100ms、200ms
        sleepSync(100 * attempt)
      }
    }
  }

  throw lastErr
}
