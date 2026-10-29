import { describe, expect, it } from 'vitest'
import { executeOne, GuardError as LegacyGuardError, NotFoundError as LegacyNotFoundError, UsageError as LegacyUsageError } from '../../../src/main/cli/commands'
import { ConflictError as LegacyConflictError } from '../../../src/main/database/todo.repository'
import { GuardError, NotFoundError, UsageError, ConflictError } from '../../../src/main/lib/domain-errors'

// 故意不给数据库或身份凭据：只读命令遇到业务错误应原样归类，不能触发写入。
const context = (error: Error) => ({
  deps: { todoRepo: { resolveId: () => { throw error } } },
  meta: { version: '1.0.91', schemaVersion: 35, via: 'pipe', dbPath: ':memory:' }
}) as never

describe('结构化错误不依赖提示语言或关口编号', () => {
  it.each([
    [new GuardError('Policy refused'), 4, 'guard_blocked'],
    [new NotFoundError('Resource missing'), 3, 'not_found'],
    [new UsageError('Invalid argument'), 2, 'usage_error'],
    [new ConflictError('Version differs'), 5, 'conflict'],
    [new GuardError('目标不存在但操作被禁止'), 4, 'guard_blocked'],
    [new NotFoundError('missing resource（G10）'), 3, 'not_found'],
    [new Error('底层异常包含不存在（G10），不能据此冒充守卫'), 1, 'error']
  ])('按类型归类 %s', async (error, code, errorCode) => {
    const r = await executeOne(context(error as Error), ['todo', 'get', '12345678'])
    expect(r.ok).toBe(false)
    expect(r.code).toBe(code)
    expect((r as { errorCode?: string }).errorCode).toBe(errorCode)
    expect((r as { message?: string }).message).toBe((error as Error).message)
  })

  it('旧导出与新定义是同一个类，保留 instanceof 兼容', () => {
    expect(LegacyGuardError).toBe(GuardError)
    expect(LegacyNotFoundError).toBe(NotFoundError)
    expect(LegacyUsageError).toBe(UsageError)
    expect(LegacyConflictError).toBe(ConflictError)
  })
})
