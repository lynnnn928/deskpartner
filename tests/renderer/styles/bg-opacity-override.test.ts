/**
 * 磨砂底色 opacity 覆盖的回归闸门（1.0.59，主用户拍板「显式调过才覆盖预设」）
 *
 * ── 为什么必须有这组断言 ──
 *
 * 这个变量在本项目里出过三次事，每次形态都不同：
 *   1.0.48  改了 :root、漏了 frosted.css → 想达到的 0.88 一直没生效
 *   1.0.56  删掉设置项 → 行内值消失 → 上面那个漏改的 0.72 当场生效，界面变透明
 *   1.0.59  现在：设置项回归，语义改成「null = 跟随预设」
 *
 * 前两次的根因是同一个：**行内值恒在、恒赢**，于是预设里的值既读不到、
 * 也没人核对。所以这一组测的不是"能不能覆盖"，而是
 * **默认状态下行内根本不存在** —— 那条一旦被破坏，1.0.57 的现象就会原样重演。
 */
import { describe, it, expect } from 'vitest'
import { applyBgOpacityOverride } from '../../../src/renderer/lib/theme-inline'

/** 最小够用的 style 替身：只记录被写/被删的属性 */
function fakeStyle() {
  const written = new Map<string, string>()
  return {
    written,
    style: {
      setProperty(name: string, value: string) {
        written.set(name, value)
      },
      removeProperty(name: string) {
        written.delete(name)
      }
    }
  }
}

describe('磨砂底色覆盖：null = 跟随预设（1.0.59）', () => {
  it('默认 null → 行内不写，值归预设（唯一来源，不重演 1.0.57）', () => {
    const el = fakeStyle()
    const applied = applyBgOpacityOverride(el, null)
    expect(applied).toBe(false)
    expect(el.written.has('--frosted-bg-opacity')).toBe(false)
  })

  it('undefined 同样当作跟随预设（旧设置值缺字段时不能写成 NaN/字符串）', () => {
    const el = fakeStyle()
    expect(applyBgOpacityOverride(el, undefined)).toBe(false)
    expect(el.written.has('--frosted-bg-opacity')).toBe(false)
  })

  it('非有限数（NaN）不写 —— 滑块绝不能拿到一个算不出来的值', () => {
    const el = fakeStyle()
    expect(applyBgOpacityOverride(el, Number.NaN)).toBe(false)
    expect(el.written.has('--frosted-bg-opacity')).toBe(false)
  })

  it('有数值 → 写入行内并覆盖预设，且明确回报"处于覆盖态"', () => {
    const el = fakeStyle()
    const applied = applyBgOpacityOverride(el, 0.6)
    expect(applied).toBe(true)
    expect(el.written.get('--frosted-bg-opacity')).toBe('0.6')
  })

  it('从覆盖回到跟随预设 → 行内被抹掉，不是留下一个等于默认值的行内值', () => {
    const el = fakeStyle()
    applyBgOpacityOverride(el, 1)
    expect(el.written.get('--frosted-bg-opacity')).toBe('1')

    applyBgOpacityOverride(el, null)
    // 关键：必须是"没有这一条"，而不是"有一条值恰好等于预设值"。
    // 后者正是两条来源并存的形态，预设改了它不会跟着变。
    expect(el.written.has('--frosted-bg-opacity')).toBe(false)
  })

  it('0 是合法覆盖值（完全透明）—— 不能被当成 falsy 漏掉', () => {
    const el = fakeStyle()
    expect(applyBgOpacityOverride(el, 0)).toBe(true)
    expect(el.written.get('--frosted-bg-opacity')).toBe('0')
  })
})
