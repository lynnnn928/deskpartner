import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { checkIsolation, isolationErrorMessage } from '../../../src/main/utils/data-dir'

/**
 * 隔离开关的防呆（1.0.49，主用户拍板「设了却没生效就拒绝运行」）
 *
 * 背景：`DESKPARTNER_DATA_DIR` 是"我在隔离库里操作"的唯一表达方式，
 * 而它生效需要环境变量非空 + mkdir 成功 + setPath 成功 + 时机正确
 * 四件事同时成立。任一环失败，原实现只 `console.error` 然后退回真实库
 * 继续跑 —— 2026-09-22 演练事故正是这个形状。
 *
 * 这里钉住的判据（纯函数，不读 electron、不碰文件系统）：
 * - 没设 → 放行（本来就没打算隔离）
 * - 设了且生效 → 放行
 * - 设了但是空值 → 拦（几乎必然是变量没展开）
 * - 设了但实际目录不一致 → 拦（mkdir / setPath 失败后退回默认）
 */
describe('隔离数据目录的防呆校验', () => {
  const realDir = path.resolve('C:/MockAppData/Roaming/desk-partner')

  it('压根没设 → 放行（本来就没打算隔离）', () => {
    expect(checkIsolation(undefined, realDir)).toEqual({ ok: true })
  })

  it('设了且真的生效 → 放行', () => {
    const iso = path.resolve('C:/Temp/deskpartner-iso')
    expect(checkIsolation(iso, iso)).toEqual({ ok: true })
  })

  it('设了但是空值 → 拦下（空值几乎必然是变量没展开）', () => {
    /**
     * 这是最隐蔽的一种：`DESKPARTNER_DATA_DIR=$SOME_UNSET_VAR` 展开成空串。
     * 原代码 `?.trim()` 后当 falsy 处理 → 静默走真实库。
     * 没人会故意 export 空值来表达"用真实库"，所以空值必须当成"设了"。
     */
    const res = checkIsolation('', realDir)
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('unreachable')
    expect(res.reason).toBe('empty')
    expect(res.actual).toBe(realDir)
  })

  it('只写了空白字符也算空值', () => {
    const res = checkIsolation('   ', realDir)
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('unreachable')
    expect(res.reason).toBe('empty')
  })

  it('设了但实际目录不一致 → 拦下，并说清"实际会动哪个库"', () => {
    // 模拟 mkdir 或 setPath 失败后退回默认目录
    const res = checkIsolation(path.resolve('C:/Temp/deskpartner-iso'), realDir)
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('unreachable')
    expect(res.reason).toBe('mismatch')
    expect(res.requested).toBe(path.resolve('C:/Temp/deskpartner-iso'))
    expect(res.actual).toBe(realDir)
  })

  it('路径写法不同但指向同一处 → 放行（不能因为斜杠风格就误拦）', () => {
    const a = 'C:/Temp/deskpartner-iso'
    const b = 'C:\\Temp\\deskpartner-iso\\'
    expect(checkIsolation(a, b)).toEqual({ ok: true })
  })

  it('报错信息三条信息齐全：声明了什么、实际动哪个库、别重试', () => {
    const res = checkIsolation('', realDir)
    if (res.ok) throw new Error('unreachable')
    const msg = isolationErrorMessage(res)
    expect(msg).toContain('DESKPARTNER_DATA_DIR')
    expect(msg).toContain('空值')
    // 关键：必须点明"继续跑会读写真实库" —— 这是操作者真正需要知道的后果
    expect(msg).toContain('真实库')
    // 给出两条出路，而不是只报错
    expect(msg).toContain('绝对路径')
    expect(msg).toContain('清空该变量')
  })
})
