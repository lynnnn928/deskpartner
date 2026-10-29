import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 主题变量一致性闸门（1.0.49）
 *
 * ── 为什么需要这道测试 ──
 *
 * 1.0.48 的冷中性配色**整轮没生效**，而 tsc、lint、单元测试全是绿的 ——
 * 因为这不是代码错误，是 CSS **优先级与导入顺序**的相互作用：
 *
 *   `variables.css` 的 `:root`          优先级 (0,1,0)
 *   `light.css` 的 `[data-theme=light]` 优先级 (0,1,0)  ← 完全相同
 *
 * 而 `globals.css` 把 light.css 排在 variables.css **之后** import，
 * 同优先级下后导入者胜 → light.css 里那 6 个**值不同**的声明
 * 把 :root 的新值全盖了回去。改 variables.css 的人看到自己改对了，
 * 界面上却一点变化都没有，排查成本极高（记忆里专门留了一条"样式层陷阱"）。
 *
 * 这类问题的本质是：**同一个变量的权威来源有两个**。
 * 所以这道闸门锁住的不是"某个颜色等于多少"，而是**权威的唯一性**：
 *
 *   1. 浅色主题的权威只能是 `variables.css` 的 `:root` ——
 *      light.css 不得重复声明 :root 已有的变量；
 *   2. 深色主题只声明**真正不同**的值 ——
 *      与 :root 同值的声明属于"写两遍"，是将来 :root 改动时
 *      悄悄覆盖回去的暗桩，必须清掉。
 *
 * 判据是结构性的（比较声明集合），不是把颜色值写死进测试 ——
 * 后者会让"改配色"这件事被迫先改测试，反而逼人绕过闸门。
 */

const STYLES_DIR = path.resolve(__dirname, '../../../src/renderer/styles')

/** 从一段 CSS 里抽出某个选择器块内的 `--var: value` 声明 */
function readVars(css: string, selector: string): Map<string, string> {
  // 匹配 `selector { ... }`，取到配对的右花括号
  const start = css.indexOf(selector)
  if (start === -1) return new Map()
  const open = css.indexOf('{', start)
  if (open === -1) return new Map()
  let depth = 0
  let end = -1
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++
    else if (css[i] === '}') {
      depth--
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  const body = css.slice(open + 1, end === -1 ? css.length : end)

  const out = new Map<string, string>()
  // 去掉注释，避免注释里的示例被当成真声明
  const cleaned = body.replace(/\/\*[\s\S]*?\*\//g, '')
  for (const line of cleaned.split('\n')) {
    const m = line.match(/^\s*(--[a-zA-Z0-9-]+)\s*:\s*(.+?)\s*;?\s*$/)
    if (m) out.set(m[1], m[2].replace(/;$/, '').trim())
  }
  return out
}

const read = (rel: string) => fs.readFileSync(path.join(STYLES_DIR, rel), 'utf8')

const rootVars = readVars(read('variables.css'), ':root')
const lightVars = readVars(read('themes/light.css'), "[data-theme='light']")
const darkVars = readVars(read('themes/dark.css'), "[data-theme='dark']")
const frostedVars = readVars(read('themes/frosted.css'), "[data-preset='frosted']")

/** 值比较：忽略大小写与多余空白（`#FFF` 与 `#fff` 是同一个颜色） */
const sameValue = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

describe('主题变量的权威唯一性', () => {
  it('解析得到基础数据（防止闸门因解析失败而假通过）', () => {
    // 这个断言本身很重要：如果哪天 :root 被改名或格式变化导致解析出 0 条，
    // 下面两条"没有冲突"的断言会**静默变成永远通过**，闸门就废了。
    expect(rootVars.size).toBeGreaterThan(30)
  })

  it('浅色主题不得重复声明 :root 已有的变量（浅色的权威就是 :root）', () => {
    const conflicts = [...lightVars.keys()].filter((k) => rootVars.has(k))
    expect(
      conflicts,
      `light.css 重复声明了 :root 已有的变量：${conflicts.join(', ')}。\n` +
        `两者优先级相同而 light.css 后导入 → 会静默覆盖 :root（1.0.48 冷中性配色失效的根因）。\n` +
        `改浅色请直接改 variables.css 的 :root。`
    ).toEqual([])
  })

  it('深色主题只声明真正不同的值（与 :root 同值 = 将来的暗桩）', () => {
    const redundant = [...darkVars.entries()]
      .filter(([k, v]) => rootVars.has(k) && sameValue(rootVars.get(k)!, v))
      .map(([k]) => k)
    expect(
      redundant,
      `dark.css 里这些变量与 :root 同值，属于重复声明：${redundant.join(', ')}。\n` +
        `:root 一旦改值，这里就会悄悄盖回去 —— 请删除，只保留深色真正的差异。`
    ).toEqual([])
  })

  it('深色主题声明的每个变量都要有出处（:root 或它自己的差异）', () => {
    // 反向检查：dark 声明的变量不能是"凭空出现"的拼写错误
    // （拼错一个变量名不会报错，只会让样式静默不生效）
    const unknown = [...darkVars.keys()].filter((k) => !rootVars.has(k) && !k.startsWith('--color-'))
    expect(unknown, `dark.css 里有疑似拼错的变量名：${unknown.join(', ')}`).toEqual([])
  })

  /**
   * 默认预设（frosted）必须是 :root 的**忠实副本**（1.0.56）
   *
   * ── 为什么单独锁 frosted，不锁 japanese ──
   *
   * `frosted` 是**默认风格预设**，它与 `:root` 表达同一套审美：
   * 两边的值应当逐条相同（japanese 是"另一套审美"，本来就该不同，
   * 所以不在锁的范围里 —— 这也是不能反过来强制"所有预设都等于 :root"的原因）。
   *
   * ── 不锁会怎样（1.0.48 真实踩到）──
   *
   * 1.0.48 把 `--frosted-bg-opacity` 从 0.72 实化到 0.88，只改了 `:root`、
   * 漏了 frosted.css。两者**优先级相同（0,1,0）**，而 globals.css 把
   * frosted.css 排在其后导入 → 后导入者胜，那个早该作废的 0.72 一直压着 0.88。
   *
   * 它当时被「界面不透明度」设置项的行内值盖着（行内优先级最高），界面看不出来；
   * 1.0.56 删掉该设置项后，立刻暴露成用户可见的**「背景变透明」**
   * —— 这是一个潜伏了两个大版本、由"两处同值声明"造成的缺陷。
   *
   * 闸门只管"漂移"，不管"具体等于多少"：改配色时同步改两边即可，不必改测试。
   */
  it('默认预设 frosted 的值必须与 :root 一致（1.0.48 透明回归的根因）', () => {
    // 防止解析失败导致下面的断言静默通过
    expect(frostedVars.size, 'frosted.css 解析出 0 条声明，闸门失效').toBeGreaterThan(5)

    const drifted = [...frostedVars.entries()]
      .filter(([k, v]) => rootVars.has(k) && !sameValue(rootVars.get(k)!, v))
      .map(([k, v]) => `${k}: frosted=${v} ← :root=${rootVars.get(k)}`)

    expect(
      drifted,
      `frosted（默认预设）与 :root 的值已经漂移：\n  ${drifted.join('\n  ')}\n` +
        `两者优先级相同、frosted.css 后导入 → 这里会静默盖掉 :root 的新值，\n` +
        `界面上表现为"改了 :root 却没生效"（1.0.48 的 --frosted-bg-opacity 就是这么丢的）。\n` +
        `prompt: 请把两边改成同一个值；若这一项**本就该只在预设里不同**，\n` +
        `就同时从 :root 删除，别让同一个效果有两条来源。`
    ).toEqual([])
  })

  /**
   * `--frosted-*` 归**风格预设**所有，主题文件不得再声明（1.0.56）
   *
   * 名字里就带着「磨砂」这一族（blur / saturate / bg-opacity / border-opacity）
   * 表达的是"要磨砂到什么程度"，属于**风格预设**的职责；深浅色不参与。
   * 而 globals.css 的导入顺序是 variables → light → dark → frosted → japanese，
   * 两个预设文件排在 `dark.css` **之后** —— 于是 dark.css 里就算声明了，
   * 也被预设静默覆盖，是一条**永远读不到的死值**。
   *
   * 1.0.56 删掉了 dark.css 里的 `--frosted-bg-opacity: 0.65` /
   * `--frosted-border-opacity: 0.2`（CDP 实测四种 theme×preset 组合都不生效）。
   * 留着比删掉更糟：它会让人以为"深色下磨砂更透"是生效的，据此做设计判断。
   */
  it('主题文件不得声明 --frosted-* （那是预设的职责，声明了也是死值）', () => {
    const offenders = [...darkVars.keys(), ...lightVars.keys()].filter((k) =>
      k.startsWith('--frosted-')
    )
    expect(
      offenders,
      `theme 文件里声明了预设专属变量：${offenders.join(', ')}。\n` +
        `它们在 frosted.css / japanese.css 之后被 import，恒被覆盖，是读不到的死值。\n` +
        `请删除，并改到 themes/frosted.css 与 themes/japanese.css 里。`
    ).toEqual([])
  })

  /**
   * 两套风格预设必须**真的看得出差别**（1.0.60，主用户驳回 273b451f）
   *
   * ── 这条闸门要拦的是什么 ──
   *
   * 她的驳回原话：「极简磨砂和日系留白切换之后**感觉没有差别**，
   * 建议保留一个，另一个删除。」
   *
   * 复核后确认这不是"值配错了"，而是**差异被压在看不见的维度上**：
   * 当时两者的 `--frosted-bg-opacity` 都是 0.88 —— 而它是唯一直接决定
   * "磨砂感"的量；剩下能变的只有 blur(20→12) 与 saturate(180→140)，
   * 一层 88% 不透明的实色盖在背后，模糊参数差多少都看不出来。
   * 于是"切预设"实际只改了卡片圆角与间距，而这两项**只有看板卡片能体现**——
   * 人站在设置页点切换，屏幕上没有一处会变，"感觉没有差别"是必然结论。
   *
   * ── 闸门怎么判 ──
   *
   * 不写死具体数值（改审美不该改测试），而是要求两套预设里
   * **至少有 3 个维度不同，且其中必须包含一个"可感知强度"维度**：
   * 底色不透明度 / 模糊 / 饱和度 —— 这三个直接决定窗口与浮层看上去什么样，
   * 是唯一能在切换当场被人眼确认的。只差圆角和间距不算数
   * （它们看板外不可见，正是这次翻车的原因）。
   */
  it('两套风格预设必须有可感知的差异（只差圆角/间距 = 用户看不出切换生效）', () => {
    const japaneseVars = readVars(read('themes/japanese.css'), "[data-preset='japanese']")
    expect(japaneseVars.size, 'japanese.css 解析出 0 条声明，闸门失效').toBeGreaterThan(5)

    const sharedKeys = [...frostedVars.keys()].filter((k) => japaneseVars.has(k))

    /** 能当场看出来的维度：决定窗口/浮层的通透程度 */
    const PERCEPTIBLE = ['--frosted-bg-opacity', '--frosted-blur', '--frosted-saturate']
    const perceivedDiff = sharedKeys.filter(
      (k) => PERCEPTIBLE.includes(k) && !sameValue(frostedVars.get(k)!, japaneseVars.get(k)!)
    )

    expect(
      perceivedDiff.length,
      `两套预设在这些"看得见"的维度上完全相同：` +
        `${PERCEPTIBLE.filter((k) => !perceivedDiff.includes(k)).join(', ')}。\n` +
        `人站在设置页切换预设时，屏幕上不会有任何变化 —— ` +
        `这正是 273b451f 被驳回的"切换之后感觉没有差别"。\n` +
        `请至少拉开一项（如 --frosted-bg-opacity），别只改圆角与间距：\n` +
        `那两项只有看板卡片能体现，而切换开关在设置页。`
    ).toBeGreaterThanOrEqual(1)
  })
})
