import { describe, it, expect, vi } from 'vitest'
import { isRetryableWriteError, withWriteRetry } from '../../../src/main/database/write-retry'

describe('write-retry', () => {
  describe('isRetryableWriteError()', () => {
    it('认出 SQLITE_BUSY', () => {
      expect(isRetryableWriteError({ code: 'SQLITE_BUSY' })).toBe(true)
    })

    it('认出 SQLITE_LOCKED', () => {
      expect(isRetryableWriteError({ code: 'SQLITE_LOCKED' })).toBe(true)
    })

    /**
     * 20 进程并发实测中出现过这个错误，写入被拒绝 = 语句没执行，可安全重试。
     */
    it('认出 SQLITE_READONLY（写入被拒绝，语句未执行）', () => {
      expect(isRetryableWriteError({ code: 'SQLITE_READONLY' })).toBe(true)
    })

    /**
     * 这条是安全底线：无法判定是否已写入的错误必须被排除在重试之外，
     * 否则重试可能产生重复数据（待办场景下一件事变两件，比失败更难收拾）。
     */
    it('不把其它错误误判为锁冲突', () => {
      expect(isRetryableWriteError({ code: 'SQLITE_CONSTRAINT' })).toBe(false)
      expect(isRetryableWriteError({ code: 'ERR_DLOPEN_FAILED' })).toBe(false)
      expect(isRetryableWriteError(new Error('boom'))).toBe(false)
      expect(isRetryableWriteError(null)).toBe(false)
      expect(isRetryableWriteError(undefined)).toBe(false)
    })
  })

  describe('withWriteRetry()', () => {
    it('首次成功就不重试', () => {
      const fn = vi.fn(() => 'ok')
      expect(withWriteRetry('t', fn)).toBe('ok')
      expect(fn).toHaveBeenCalledTimes(1)
    })

    it('锁冲突时重试到成功为止', () => {
      let calls = 0
      const fn = vi.fn(() => {
        calls++
        if (calls < 3) {
          const e = new Error('database is locked') as Error & { code: string }
          e.code = 'SQLITE_BUSY'
          throw e
        }
        return 'recovered'
      })
      expect(withWriteRetry('t', fn)).toBe('recovered')
      expect(fn).toHaveBeenCalledTimes(3)
    })

    it('锁冲突重试到底仍失败则抛出最后一次错误', () => {
      const fn = vi.fn(() => {
        const e = new Error('busy') as Error & { code: string }
        e.code = 'SQLITE_BUSY'
        throw e
      })
      expect(() => withWriteRetry('t', fn, 3)).toThrow('busy')
      expect(fn).toHaveBeenCalledTimes(3)
    })

    /**
     * 最关键的一条：非锁错误绝不重试 —— 因为无法判定写入是否已经发生。
     */
    it('非锁错误立即抛出，一次都不重试', () => {
      const fn = vi.fn(() => {
        throw new Error('未知故障')
      })
      expect(() => withWriteRetry('t', fn, 3)).toThrow('未知故障')
      expect(fn).toHaveBeenCalledTimes(1)
    })
  })
})
