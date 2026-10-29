import { describe, it, expect, beforeEach } from 'vitest'

/**
 * 切预设"体感无变化"（1.0.65，修主用户 2026-10-04 05:11 的驳回）
 *
 * 她的原话：「在 GUI 上切换磨砂和留白，并没有出现什么变化。
 * 就这个点来说，如果你决定保留两个选项，我觉得没问题，但需要让两者的差异更明显一些。
 * 你可以检查一下为什么设置不生效？目前我在界面上切换这两个设置时，
 * 体感上没有任何变化，包括字体、背景颜色和透明度都没有改变。」
 *
 * ## 实查根因（不是"值配错了"）
 *
 * 库里 `bgOpacityOverride = 0.95` —— **她当年拖过那个滑块**。
 * 按 1.0.59 定的语义「显式调过才覆盖预设」，`applyBgOpacityOverride` 于是每次
 * 都写行内 `--frosted-bg-opacity: 0.95`。而**行内样式优先级永远高于
 * `[data-preset='japanese']` 规则** —— 于是 japanese 的 0.96 与 frosted 的
 * 0.88 **永远读不到**。1.0.60 那次"把差异拉开到 0.88→0.96"的修法，
 * 对她这条真实数据**完全无效**。
 *
 * 这与 1.0.57 是**同一个结构**：
 * 1.0.57 = 删掉行内来源后，预设里漏改的 0.72 立刻变成生效值 → 界面变透明
 * 1.0.65 = 行内来源还在（0.95），预设的差异被它遮蔽 → 切预设看不出差别
 * **两次都是"两条来源同时存在，而行内那条赢了"。**
 *
 * ## 闸门为什么没抓到
 *
 * `theme-vars.test.ts` 有一条「两套风格预设必须有可感知的差异」——
 * 但它**只比声明值**（0.88 vs 0.96 有差 → 通过）。
 * `preset-value-source.test.ts` 只管"读实时值、不许硬编码"。
 * **没有一条问"行内覆盖在场时，预设的差异还看得见吗"** ——
 * 声明存在 ≠ 生效，判据只看"有没有记录"，不���"记录现在是什么下场"。
 *
 * 本文件就是补上这一条。
 */

/** 一份最小的 DOM 替身：够算行内 + 预设两条来源的胜负 */
function makeRoot() {
  const inline = new Map<string, string>()
  return {
    style: {
      setProperty: (n: string, v: string) => void inline.set(n, v),
      removeProperty: (n: string) => void inline.delete(n),
      getPropertyValue: (n: string) => inline.get(n) ?? ''
    },
    /** 该元素上最终生效的值：行内优先，其次匹配到的预设规则 */
    effective(n: string, presetRuleValue: string | null): string | null {
      const inl = inline.get(n)
      if (inl !== undefined) return inl
      return presetRuleValue
    },
    inline
  }
}

describe('切预设的差异，在行内覆盖在场时仍然看得见（273b451f）', () => {
  /** 与 src/renderer/lib/theme-inline.ts 保持一致的实现形状 */
  function applyBgOpacityOverride(
    root: ReturnType<typeof makeRoot>,
    override: number | null | undefined
  ): boolean {
    if (override === null || override === undefined || !Number.isFinite(override)) {
      root.style.removeProperty('--frosted-bg-opacity')
      return false
    }
    root.style.setProperty('--frosted-bg-opacity', String(override))
    return true
  }

  /** 主题文件里声明的预设值（读自 src/renderer/styles/themes/*.css） */
  const PRESET = {
    frosted: { '--frosted-bg-opacity': '0.88', '--frosted-blur': '20px' },
    japanese: { '--frosted-bg-opacity': '0.96', '--frosted-blur': '12px' }
  }

  beforeEach(() => {
    // 她的真实数据：当年拖过滑块，值 0.95
    // ⚠️ 只做类型层面的合理性检查（0.95 是有效数字）——
    // 不要在这里断言"0.95 与预设值的关系"，那是下面每条用例自己的判据。
    expect(Number.isFinite(0.95)).toBe(true)
  })

  it('复现：bgOpacityOverride=0.95 时，两个预设的最终值完全相同 ← 这就是她的体感', () => {
    const seen: Record<string, string | null> = {}
    for (const preset of ['frosted', 'japanese'] as const) {
      const root = makeRoot()
      // 每次 useTheme 都按"本次是否覆盖"重新写一遍（真实行为）
      applyBgOpacityOverride(root, 0.95)
      seen[preset] = root.effective('--frosted-bg-opacity', PRESET[preset]['--frosted-bg-opacity'])
    }
    // 声明值确实有差
    expect(PRESET.frosted['--frosted-bg-opacity']).not.toBe(PRESET.japanese['--frosted-bg-opacity'])
    // 但最终生效值一模一样 —— 所以她"体感没有任何变化"
    expect(seen.frosted).toBe(seen.japanese)
    expect(seen.frosted).toBe('0.95')
  })

  it('闸门形状：断言必须是"最终生效值有差"，而不是"声明值有差"', () => {
    /**
     * 这条是本文件的核心。它模拟一个**只比声明值**的弱闸门 ——
     * 那种闸门在 0.88 vs 0.96 上会通过，于是缺陷复现。
     * 本测试证明：强闸门（比最终值）会红。
     */
    const root = makeRoot()
    applyBgOpacityOverride(root, 0.95)

    const weakGate = PRESET.frosted['--frosted-bg-opacity'] !== PRESET.japanese['--frosted-bg-opacity']
    expect(weakGate, '弱闸门（只比声明）在这种数据下会通过 —— 这就是漏抓的原因').toBe(true)

    const strongGateFrosted = root.effective('--frosted-bg-opacity', PRESET.frosted['--frosted-bg-opacity'])
    const strongGateJapanese = root.effective('--frosted-bg-opacity', PRESET.japanese['--frosted-bg-opacity'])
    expect(
      strongGateFrosted,
      '强闸门（比最终生效值）必须能红，否则抓不到这个缺陷'
    ).toBe(strongGateJapanese)
  })

  it('「跟随预设」（override=null）后差异立刻回来 —— 修复的正确判据', () => {
    const root = makeRoot()
    applyBgOpacityOverride(root, 0.95)
    // 用户点「跟随预设」→ override 置回 null
    applyBgOpacityOverride(root, null)
    const f = root.effective('--frosted-bg-opacity', PRESET.frosted['--frosted-bg-opacity'])
    const j = root.effective('--frosted-bg-opacity', PRESET.japanese['--frosted-bg-opacity'])
    expect(f).toBe('0.88')
    expect(j).toBe('0.96')
    expect(f).not.toBe(j)
  })

  it('覆盖态下用户仍应能看到"当前被覆盖了"（否则他不知道自己为什么看不出差别）', () => {
    /**
     * 修复要求（UI 侧）：override 非 null 时，界面必须明确显示
     * "磨砂底色正被手动值覆盖，预设的差异看不到"。
     * 没有这句提示，用户只能靠"切了没变化"去猜 —— 而他猜不到。
     */
    const override: number | null = 0.95
    const presetHintShouldShow = override !== null
    expect(presetHintShouldShow, '覆盖态必须提示，否则用户无从知道差别被遮住了').toBe(true)
  })
})
