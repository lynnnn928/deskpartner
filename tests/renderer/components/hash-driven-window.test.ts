import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 「窗口复用后内容必须跟着 hash 走」的结构性闸门（1.0.65，主用户报的缺陷）
 *
 * ── 要拦的是什么 ──
 *
 * 她 2026-10-01 截图：桌面上弹出「Carol 已接入，等你批准写入 —— 它现在只能读，不能写」，
 * 而审批页里实际待批的是「Carol 想【改界面】ui reset --key theme」。
 * **横幅说的和真正等着处理的事不是同一件。**
 *
 * 根因不是文案写错，是**窗口复用机制**：主进程 `showReminderBanner` 在窗口已存在时
 * 只 `loadRoute` 改 hash（见 windows.ts 的复用分支）—— Chromium 走**同文档导航**，
 * 不重载 JS、组件不重挂载。而 ReminderBanner 此前只在渲染时读一次 `location.hash`，
 * 于是内容停在第一次，后面每次复用都只是在旧内容上换一串没人看的 URL。
 *
 * ── 为什么这个缺陷值得一条闸门 ──
 *
 * 它是**静默说错话**：不报错、tsc 绿、单测绿，只有人去比对界面才发现。
 * 而且同一个坑本项目已经踩过三次：
 *   1. Kanban 的 `?view=` 深链（"去审批"第二次点击不生效）
 *   2. QuickAdd 的 `?todoId=` 编辑态（"双击卡片却弹出新增待办"）
 *   3. ReminderBanner（本次）
 * 前两次都是**修完就完**，没有留下任何"下次别再犯"的抓手 ——
 * 所以第三次照旧踩。这条闸门就是把那个抓手补上。
 *
 * ── 判据（结构性，不锁具体文案） ──
 *
 * 该组件里凡是读 `window.location.hash` 的地方，都必须在 `hashchange` 时重新读。
 * 做法上体现为：文件里既要有 `location.hash`，也要有 `addEventListener('hashchange'`。
 * 只读一次（`useMemo`/直接调用/模块级常量）都不算通过。
 *
 * ── 反向验证 ──
 *
 * 把 ReminderBanner 里的 `hashchange` 监听删掉，本测试必须变红。
 * （修复前本文件确实红了 —— 见下方"修复前"用例不存在的说明：闸门是修好之后
 *   补的，补完立即用注入故障的方式验证过一次。）
 */

const ROOT = path.resolve(__dirname, '../../..')

/** 所有"会被复用、内容靠 hash 区分"的窗口组件 —— 新增此类窗口时一并加进来 */
const HASH_DRIVEN_WINDOWS = [
  'src/renderer/windows/ReminderBanner.tsx',
  'src/renderer/windows/Kanban.tsx',
  'src/renderer/components/quick-add/useQuickAddRoute.ts'
]

const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

describe('hash 驱动的窗口必须监听 hashchange（主用户报的横幅错位缺陷）', () => {
  /**
   * 先证明闸门本身活着：如果这些文件都读不到，后面的断言全是假绿。
   *
   * 这条"基础数据解析成功"是跟 preset-value-source.test.ts 学的 ——
   * 路径写错时闸门会安静地通过，那才是最难查的失效形态。
   */
  it('基础数据解析成功（防止闸门因路径变化而假通过）', () => {
    for (const f of HASH_DRIVEN_WINDOWS) {
      const src = fs.readFileSync(path.join(ROOT, f), 'utf8')
      expect(src.length, `${f} 内容过短，路径可能已失效`).toBeGreaterThan(300)
      expect(src, `${f} 应读取 location.hash`).toContain('location.hash')
    }
  })

  it('读 hash 的组件都挂了 hashchange 监听', () => {
    const missing: string[] = []
    for (const f of HASH_DRIVEN_WINDOWS) {
      const clean = stripComments(fs.readFileSync(path.join(ROOT, f), 'utf8'))
      if (!/addEventListener\(\s*['"]hashchange['"]/.test(clean)) missing.push(f)
    }
    if (missing.length) {
      throw new Error(
        `以下组件读 location.hash 却没监听 hashchange ——\n` +
          `窗口被复用（只改 hash、不重挂载）时，内容会停在第一次：\n` +
          missing.map((f) => `  ${f}`).join('\n') +
          `\n\n改法：把"读 hash"抽成函数，用 useState 存、在 hashchange 里 setState 重读。\n` +
          `参考 src/renderer/components/quick-add/useQuickAddRoute.ts。`
      )
    }
    expect(missing).toEqual([])
  })

  /**
   * 横幅回归：组件必须**不是**"只在挂载时读一次"的形态。
   *
   * 具体锁法：`readBannerRoute` 这个解析函数必须被**传进 useState**（惰性初始化）
   * 之外还能被 hashchange 回调再次调用 —— 也就是文件里 `readBannerRoute`
   * 至少出现两次调用点（useState + onHashChange）。
   * 只出现一次 = 又变回"读一次"的写法。
   */
  it('ReminderBanner 的解析函数在 hashchange 里被再次调用（不是只读一次）', () => {
    const clean = stripComments(
      fs.readFileSync(path.join(ROOT, 'src/renderer/windows/ReminderBanner.tsx'), 'utf8')
    )
    const calls = clean.match(/readBannerRoute\(\)/g) || []
    expect(
      calls.length,
      `readBannerRoute() 只被调用了 ${calls.length} 次 —— 必须是"useState 惰性初始化"` +
        `加"hashchange 回调里再读一次"至少两处；\n` +
        `只有一处就等于"窗口复用时内容永不更新"，正是本次缺陷。`
    ).toBeGreaterThanOrEqual(2)
  })

  /**
   * 连带要求：hash 变化时旧回执必须清掉。
   *
   * 回执（"已通过并执行：…"）是**上一条**横幅的结论，复用时留在 DOM 里
   * 会叠在新内容下 —— 那是同一缺陷的变体（横幅在说一件已经过去的事）。
   */
  it('ReminderBanner 在 hash 变化时清掉上一次的回执', () => {
    const clean = stripComments(
      fs.readFileSync(path.join(ROOT, 'src/renderer/windows/ReminderBanner.tsx'), 'utf8')
    )
    const at = clean.search(/addEventListener\(\s*['"]hashchange['"]/)
    expect(at, '没找到 hashchange 监听').toBeGreaterThan(-1)
    /**
     * 双向取窗口：处理函数通常**定义在挂监听之前**
     * （`const onHashChange = () => {...}` 然后 `addEventListener(..., onHashChange)`），
     * 只往后取会漏掉函数体，把正常写法判成违规 —— 本轮实测踩到过。
     */
    const around = clean.slice(Math.max(0, at - 700), at + 400)
    expect(
      /setOutcome\(\s*null\s*\)/.test(around),
      'hashchange 附近没有 setOutcome(null) —— 上一条横幅的执行回执会残留，\n' +
        '叠在新内容下面继续误导人。'
    ).toBe(true)
  })
})
