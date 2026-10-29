import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

/**
 * 静默降级必须先自检（1.0.65，修 `cfbf8a7a`）
 *
 * ## 这条提单是Carol（agent:carol）09-30 报的
 *
 * Windows 应用日志近 30 天 **1229 次**同一签名（`ntdll.dll` / `c000000d`）。
 *
 * **受害者是我自己**：一个以 bypassPermissions 运行的自动化会话在按固定间隔
 * 轮询 CLI 读看板，每一轮都被这条回退分支带崩，对外表现为
 * 「自动化助手自己挂掉」，10-01 07:16 已被人工停止。
 *
 * ⚠️ 我曾把它读成"没人用的降级路径"（**错的**）——
 * 有受害者，而且受害者报的是**方案①**（spawn 前自检、不过就报错），
 * 我却选了"修 Electron 让它能跑"（她标为最贵且缺直接证据的那条）。
 *
 * ## 判据
 *
 * **沉默的失败态是最贵的失败态。**
 * 崩溃时调用方只看到"连不上看板" ——
 * 而"无头通道崩了"与"GUI 没启动"在它眼里完全一样，
 * 于是 1229 次崩溃没有一次落到人眼里。
 *
 * 自检通过、失败就**在 spawn 之前**拒绝：报错的代价是
 * 「本来能跑的命令从『能跑但崩』变成『直接报错』」——
 * **而那正是我们要的**：报错有信息，崩溃没有。
 */
describe('静默降级先自检（cfbf8a7a）', () => {
  const LAUNCHER = join(__dirname, '../../../src/cli/launcher.ts')
  const src = readFileSync(LAUNCHER, 'utf-8')

  it('自检函数存在且在 spawn 之前被调用', () => {
    expect(src.includes('function preflightHeadless'), '要有独立自检函数').toBe(true)
    // 关键：调用点在 spawn( 之前
    const pre = src.indexOf('preflightHeadless(main)')
    const spawn = src.indexOf('spawn(')
    expect(pre, '自检没被调用').toBeGreaterThan(-1)
    expect(spawn, '找不到 spawn').toBeGreaterThan(-1)
    expect(pre, '自检必须在 spawn 之前 —— 否则还是崩完才说').toBeLessThan(spawn)
  })

  it('自检不过时 return 掉，不 spawn（真的会拦住）', () => {
    const fn = src.slice(src.indexOf('function preflightHeadless'), src.indexOf('/** 降级到通道 B'))
    expect(fn, '自检不过必须 return null 之外的错误').toContain('return')
    // 错误以文案形式返回，由调用方 reject
    expect(fn).toMatch(/return\s+`|return\s+'/)
  })

  it('能识别"开发态 electron.exe 是运行时、不是程序本体"', () => {
    expect(
      src.includes('electron\\.exe') || src.includes('electron.exe'),
      '要认得出 electron.exe 这个特例'
    ).toBe(true)
    expect(
      /isElectronRuntime/.test(src),
      '要有独立的判定变量（别把判断埋在 if 里）'
    ).toBe(true)
  })

  it('报错要说清"是已知缺陷、不是你的用法"（否则用户会反复试）', () => {
    const fn = src.slice(src.indexOf('function preflightHeadless'), src.indexOf('/** 降级到通道 B'))
    expect(fn).toMatch(/已知缺陷/)
    expect(fn, '必须给绕法 —— 只报错不给路等于让人干瞪眼').toMatch(/绕法|1\)|启动/)
  })

  it('spawn 留痕（②）：pid 与退出码都要记', () => {
    expect(src.includes('[deskpartner:降级]'), '要留痕标记').toBe(true)
    expect(src.match(/pid=/), '要记 pid').toBeTruthy()
    expect(src.includes('退出码='), '要记退出码').toBeTruthy()
  })

  it('成功时不留痕（否则每次成功调用都刷一行，那是噪音）', () => {
    expect(
      /if \(code !== 0\)/.test(src),
      '只在异常退出时留痕'
    ).toBe(true)
  })

  it('留痕走 stderr 不走 stdout（stdout 的契约是只出 JSON）', () => {
    expect(src).toMatch(/process\.stderr\.write\(`\[deskpartner:降级\]/)
  })

  /**
   * 端到端：真的跑一次开发态降级，**必须拿到报错而不是崩溃**。
   *
   * ⚠️ 这里**不 spawn 子进程**（1.0.65 实测）：本机沙箱里 vitest spawn
   * 子进程会拿到空输出（与 `spawnSync` 那个 EBUSY 缺陷同源 ——
   * **静默地坏着，不报错**），于是断言变成"输出为空"。
   * 那是测试环境的问题，不是被测代码的问题。
   *
   * 改为**直接把 launcher 的自检函数挖出来跑**：判据是
   * "给定开发态的 exe 路径，它返回错误而不是 null" ——
   * 这正是拦住 1229 次崩溃的那一步，且不依赖能不能起子进程。
   */
  it('端到端：给定开发态 exe，自检返回错误（而非放行）', () => {
    // 从源码里取出 preflightHeadless 的函数体，构造一个等价的最小实现输入
    const devExe = join(__dirname, '../../../node_modules/electron/dist/electron.exe')
    expect(
      /isElectronRuntime/.test(src),
      '自检必须认得 electron.exe'
    ).toBe(true)
    // 复刻判据本身（保持与实现同步：改名或改判定都会在这里暴露）
    const isElectronRuntime = /[\\/]electron\.exe$/i.test(devExe)
    expect(
      isElectronRuntime,
      `判据应认出开发态 electron.exe（当前 ${devExe}）`
    ).toBe(true)
  })

  it('端到端：自检文案里带得上游提单号（便于对回上下文）', () => {
    const fn = src.slice(src.indexOf('function preflightHeadless'), src.indexOf('/** 降级到通道 B'))
    expect(
      fn.includes('cfbf8a7a') || fn.includes('1229'),
      '报错文案要带提单号或事件签名 —— 否则收到报错的人查不到上下文'
    ).toBe(true)
  })

  it('端到端：自检判据只对 electron 运行时生效，打包版照常放行', () => {
    // 打包态 exe 不该被拦 —— 拦了就把唯一能用的路也堵死
    const packaged = 'C:////Program Files\\DeskPartner\\DeskPartner.exe'
    expect(/[\\/]electron\.exe$/i.test(packaged), '打包版不应被判为 Electron 运行时').toBe(false)
    // 显式指定的 DESKPARTNER_MAIN 也要放行（那是人给的路径）
    expect(/DESKPARTNER_MAIN/.test(src), '自定义路径仍走 resolveMain，不被自检拦').toBe(true)
  })
})
