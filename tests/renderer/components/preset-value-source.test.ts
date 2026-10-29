import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 「当前生效值」不得硬编码的闸门（1.0.60，主用户驳回 273b451f）
 *
 * ── 要拦的是什么 ──
 *
 * `PresetSection` 上写着「已覆盖预设（预设值 88%）」。那个 88 来自
 * `useState(0.88)` —— **硬编码**，而且因为在覆盖态下 effect 提前 return，
 * 它**从不读 CSS**。
 *
 * 于是 1.0.60 把 japanese 预设从 0.88 改成 0.96 之后，只要用户处在覆盖态，
 * 界面就会当场显示错的预设值。更要命的是它**不报错**：
 * tsc 绿、单测绿，只有人去界面上比对才发现。
 *
 * ── 这是 1.0.57 那个回归的同一个形状 ──
 *
 * 「一个效果只能有一条来源」。在这个组件里：
 *   来源 A = `themes/*.css` 里的预设值（权威）
 *   来源 B = 组件里硬编码的常量（影子）
 * 两条并存时，B 掩护着 A：**没人会去核对 B**，直到 A 变了、
 * B 还在原地，界面才开始骗人。
 *
 * ── 闸门怎么判 ──
 *
 * 不锁具体数值（改预设不该改测试），只锁结构：这个组件里**不得出现
 * 代表不透明度的字面量数字**，且必须真的去读 CSS 变量。
 */

const ROOT = path.resolve(__dirname, '../../..')
const FILE = 'src/renderer/components/settings/sections/PresetSection.tsx'
const src = fs.readFileSync(path.join(ROOT, FILE), 'utf8')

const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const clean = stripComments(src)

describe('「当前生效值」必须实时读，不得硬编码（主用户驳回 273b451f）', () => {
  it('基础数据解析成功（防止闸门因路径变化而假通过）', () => {
    expect(src.length).toBeGreaterThan(800)
    expect(src).toContain('bgOpacityOverride')
  })

  it('必须去读 --frosted-bg-opacity 的实时值', () => {
    expect(
      clean.includes('--frosted-bg-opacity'),
      'PresetSection 没有读 `--frosted-bg-opacity` —— 那么"预设值 X%"只能是\n' +
        '一个写死的常量。硬编码的"当前生效值"就是第二条来源：\n' +
        '没人核对它，预设改了它还在原地，界面开始显示错的数字。'
    ).toBe(true)
    expect(clean).toContain('getComputedStyle')
  })

  it('不透明度不得以字面量形式出现在组件里（0.88 / 88 / 0.9 之类）', () => {
    /**
     * 只挑「像不透明度的字面量」：0.x 小数、以及 *100 之后的整十数字。
     *
     * ⚠️ 允许极少数例外（滑块 min/max 兜底、首帧占位），它们必须是
     * **语义无关**的常量名而不是裸数字 —— 所以这里断言的是
     * "裸数字不得直接参与不透明度计算"，靠常量名放行。
     */
    const bareDecimals = [...clean.matchAll(/(?<![\w.])(0\.\d+)(?![\w])/g)].map((m) => m[1])
    const allowedContext = /PLACEHOLDER_OPACITY|DEFAULT_BG_OPACITY/
    const suspicious = bareDecimals.filter(() => !allowedContext.test(clean))

    expect(
      suspicious,
      `PresetSection 里出现了裸的不透明度字面量：${suspicious.join(', ')}。\n` +
        `主用户驳回的 273b451f 里，` + '`useState(0.88)`' + ` 正是这么埋进来的 —— \n` +
        `它让"预设值"永远显示 88%，哪怕预设文件已经改成 96%。\n` +
        `要么从 CSS 读，要么用有语义的常量名（见 PLACEHOLDER_OPACITY）。`
    ).toEqual([])
  })

  it('覆盖态下也要能量到预设值（不能因为"现在是覆盖态"就跳过读取）', () => {
    /**
     * 原实现的形状是：
     *   `if (override !== null) return`   ← 覆盖态直接不读了
     * 于是覆盖态下 hint 里的"预设值"100% 来自硬编码。
     *
     * 正确做法：临时摘掉行内覆盖、读 computed、再写回。
     * 断言"摘掉 / 写回"这对动作存在 —— 没有它就不可能读到真值。
     */
    const hasRemove = clean.includes("removeProperty('--frosted-bg-opacity')")
    const hasSetBack = clean.includes("setProperty('--frosted-bg-opacity'")
    expect(
      hasRemove && hasSetBack,
      '覆盖态下读不到真实预设值。\n' +
        '行内样式优先级高于预设规则，所以处在覆盖态时必须**临时摘掉**行内值、\n' +
        '读 computed、再原样写回 —— 否则读到的永远是覆盖值本身，\n' +
        '而 hint 里那个"预设值"就只能靠写死。'
    ).toBe(true)
  })

  it('读取必须发生在属性/样式落定之后（不能与 useTheme 抢同一帧）', () => {
    /**
     * React 的 effect 是**子先父后**：PresetSection 的 effect 早于
     * App 里的 useTheme 执行，而 `data-preset` 与行内覆盖都是 useTheme 写的。
     * 同步读会读到上一个预设的值（切预设时尤其明显）。
     * 放进 rAF 里读，绘制前 DOM 已落定。
     */
    expect(
      clean.includes('requestAnimationFrame'),
      '读取没有推迟到 DOM 落定之后。\n' +
        'useTheme 在父组件 App 的 effect 里写 `data-preset` 与行内覆盖，\n' +
        '而子组件的 effect 先跑 —— 同步读会拿到**上一个预设**的值，\n' +
        '切换预设时 hint 会显示旧数字。'
    ).toBe(true)
  })
})
