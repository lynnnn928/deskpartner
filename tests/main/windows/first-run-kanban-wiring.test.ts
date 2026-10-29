import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 首启引导必须与主界面同屏（1.0.65 修 `abec1753`）
 *
 * ## 为什么要有这道闸门
 *
 * 1.0.64 的症状：新用户装完第一眼是**空桌面上孤零零一个说明框**，
 * 产品本身没露脸。根因是启动链里 `showKanban()` **从来不在**那条路径上 ——
 * 只有托盘 / 悬浮球菜单 / `window:showKanban` 这几条手动路径会调它。
 *
 * 这类缺陷 tsc 抓不到、lint 抓不到、单测也几乎抓不到：
 * 它不是"某行写错了"，而是**一整条启动链上少了一个环节**，
 * 编译通过、测试全绿，现象却百分之百复现。
 *
 * 所以这里读源码 + 断言**结构关系**，而不是断言某行代码的存在。
 * 判据来自记忆里那条：结构性闸门能抓 tsc/lint/单测全绿的静默缺陷。
 *
 * ## 为什么断言"顺序"而不只是"出现过"
 *
 * 引导窗是 `alwaysOnTop` 的。只保证 `showKanban()` 出现过是不够的 ——
 * 先弹引导再开主窗口的话，主窗口会把置顶引导窗顶到后面，
 * 而 `bringToFront` 抢焦点还可能打断人正在打的字。
 * 顺序反了 = 修了个寂寞，所以必须断在 `showKanban` 之前。
 */
const APP_INDEX = join(__dirname, '../../../src/main/index.ts')

/** 去掉注释与字符串字面量，避免注释里提到 `showKanban()` 就把用例哄绿 */
function stripCommentsAndStrings(src: string): string {
  let out = ''
  let i = 0
  while (i < src.length) {
    const two = src.slice(i, i + 2)
    if (two === '/*') {
      const end = src.indexOf('*/', i + 2)
      i = end === -1 ? src.length : end + 2
      continue
    }
    if (two === '//') {
      const end = src.indexOf('\n', i)
      i = end === -1 ? src.length : end
      continue
    }
    const ch = src[i]
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch
      i++
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\') i++
        i++
      }
      i++
      // 留一个占位，保证 token 不会被前后两段拼成一个词
      out += '""'
      continue
    }
    out += ch
    i++
  }
  return out
}

const src = stripCommentsAndStrings(readFileSync(APP_INDEX, 'utf-8'))

/** 从 `app.whenReady()` 那段里取启动链（引导相关逻辑都在这一段） */
function startupBlock(): string {
  const start = src.indexOf('whenReady')
  expect(start, 'index.ts 里应能定位到 app.whenReady').toBeGreaterThan(-1)
  return src.slice(start, start + 12000)
}

/**
 * 首启那一段（从 `isFirstRun` 声明起）
 *
 * ⚠️ **不能**直接 `block.indexOf('showKanban(')`：第 6 步的托盘服务里
 * 也有一次 `onShowKanban: () => windowManager.showKanban()`，
 * 它排在首启逻辑**之前**。用它做锚点会让"顺序"断言拿托盘那次来比 ——
 * 那样断言恒成立，等于没断言（我自己第一版就踩了，test 2 是假通过）。
 * 所以锚点必须从 `isFirstRun` 声明**之后**开始找。
 */
function firstRunBlock(): string {
  const block = startupBlock()
  const at = block.indexOf('isFirstRun')
  expect(at, '应有一个显式的"首次启动"判定（isFirstRun）').toBeGreaterThan(-1)
  return block.slice(at, at + 1200)
}

describe('首启引导：主界面必须在场（abec1753）', () => {
  it('首启判定里存在 showKanban()（首启时它从未被打开过）', () => {
    expect(
      firstRunBlock().includes('showKanban('),
      '首启那段里必须出现 showKanban()，否则新用户第一眼只有空桌面 + 一个浮框'
    ).toBe(true)
  })

  it('showKanban 在引导窗之前（顺序反了等于没修）', () => {
    const block = firstRunBlock()
    const kanbanAt = block.indexOf('showKanban(')
    const onboardingAt = block.indexOf('showOnboarding(')
    const welcomeAt = block.indexOf('showWelcome(')

    expect(kanbanAt, '首启那段应有 showKanban()').toBeGreaterThan(-1)
    expect(onboardingAt, '首启那段应有 showOnboarding()').toBeGreaterThan(-1)
    expect(
      kanbanAt,
      'showKanban() 必须排在 showOnboarding() 之前：引导窗是 alwaysOnTop 的，' +
        '后开主窗口会把它顶到后面，还可能抢焦点'
    ).toBeLessThan(onboardingAt)

    if (welcomeAt > -1) {
      expect(
        kanbanAt,
        'showKanban() 也必须排在 showWelcome() 之前（同上，置顶层级问题）'
      ).toBeLessThan(welcomeAt)
    }
  })

  it('首启判定同时覆盖 humanNameAsked 与 welcomeShown 两条分支', () => {
    const decl = firstRunBlock().slice(0, 200)
    expect(decl).toContain('humanNameAsked')
    expect(
      decl,
      'welcomeShown 也必须在内：老用户升级上来会走这条路，只有 humanNameAsked 会漏'
    ).toContain('welcomeShown')
  })

  it('showKanban 被首启判定包着，不在启动链上无条件执行', () => {
    const block = firstRunBlock()
    const guardAt = block.indexOf('if (isFirstRun)')
    const kanbanAt = block.indexOf('showKanban(')
    expect(
      guardAt,
      'showKanban() 必须在 if (isFirstRun) 之内：无条件开窗 = 每次开机都弹大窗'
    ).toBeGreaterThan(-1)
    expect(kanbanAt).toBeGreaterThan(guardAt)
    // 闭合大括号要紧跟在这次调用之后（中间不留别的语句）
    const between = block.slice(guardAt, kanbanAt)
    expect(between, 'showKanban 之前只应有 if 判断本身').not.toMatch(/;\s*\w+\s*\(/)
  })
})
