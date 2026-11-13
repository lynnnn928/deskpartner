import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 首启必须与主界面同屏，而且只开这一个窗口
 *
 * ## 为什么要有这道闸门
 *
 * 1.0.64 的症状：新用户装完第一眼是**空桌面上孤零零一个说明框**，
 * 产品本身没露脸 —— 启动链上根本没人调 `showKanban()`（修 `abec1753`）。
 *
 * 1.0.146 另一半问题：主界面在场了，但背后还压着两个置顶小窗
 * （问名字 + 演三步）。用户的原话是「演示式看不懂」：小窗里演一遍、
 * 关掉就没了，人手里还是空界面。于是两个小窗一并退役，上手内容搬进
 * 「我的工作」顶部那条由真实数据驱动的清单（卡 `a19054a1`）。
 *
 * 这类缺陷 tsc 抓不到、lint 抓不到、单测也几乎抓不到：它不是"某行写错了"，
 * 而是**一整条启动链上多/少了一个环节**。所以这里读源码、断言结构关系。
 */
const ROOT = join(__dirname, '../../..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

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

const src = stripCommentsAndStrings(read('src/main/index.ts'))

/** 从 `app.whenReady()` 那段里取启动链（引导相关逻辑都在这一段） */
function startupBlock(): string {
  const start = src.indexOf('whenReady')
  expect(start, 'index.ts 里应能定位到 app.whenReady').toBeGreaterThan(-1)
  return src.slice(start, start + 12000)
}

/**
 * 首启那一段（从 `isFirstRun` 声明起）
 *
 * ⚠️ **不能**直接 `startupBlock().indexOf('showKanban(')`：第 6 步的托盘服务里
 * 也有一次 `onShowKanban: () => windowManager.showKanban()`，它排在首启逻辑
 * **之前**。用它做锚点会让"顺序"断言拿托盘那次来比 —— 那样断言恒成立、
 * 等于没断言（第一版就踩了，是假通过）。所以锚点必须从 `isFirstRun` 之后找。
 */
function firstRunBlock(): string {
  const block = startupBlock()
  const at = block.indexOf('isFirstRun')
  expect(at, '应有一个显式的"首次启动"判定（isFirstRun）').toBeGreaterThan(-1)
  return block.slice(at, at + 1200)
}

/** `if (isFirstRun) { … }` 的函数体（按 2 空格缩进的收尾括号切） */
function firstRunBody(): string {
  const block = firstRunBlock()
  const start = block.indexOf('if (isFirstRun) {')
  expect(start, '首启必须被 if (isFirstRun) 包着').toBeGreaterThan(-1)
  const end = block.indexOf('\n  }', start)
  expect(end, '应能定位到 if (isFirstRun) 的收尾').toBeGreaterThan(start)
  return block.slice(start, end)
}

describe('首启：只开主界面（abec1753 / a19054a1）', () => {
  it('首启判定里存在 showKanban()（首启时它从未被打开过）', () => {
    expect(
      firstRunBlock().includes('showKanban('),
      '首启那段里必须出现 showKanban()，否则新用户第一眼只有空桌面 + 一个浮框'
    ).toBe(true)
  })

  it('showKanban 被 if (isFirstRun) 包着，不在启动链上无条件执行', () => {
    expect(
      firstRunBody().includes('showKanban('),
      '无条件开窗 = 每次开机都弹大窗；这是老用户配好的"只出悬浮球"形态被打断'
    ).toBe(true)
  })

  it('首启判定只看 welcomeShown（名字输入已搬进清单条）', () => {
    const decl = firstRunBlock().slice(0, 200)
    expect(decl).toContain('welcomeShown')
    expect(
      decl.includes('humanNameAsked'),
      'humanNameAsked 不再参与首启判定：名字行在「我的工作」清单里，不必为它再弹一个窗口'
    ).toBe(false)
  })

  it('首启同一次里写回 welcomeShown=true（否则每次都算首启）', () => {
    const body = firstRunBody()
    expect(
      body.includes('welcomeShown: true'),
      '老逻辑靠"关掉引导窗"写这个标记，窗口不弹了就必须在启动链上自己写 —— ' +
        '否则每次开机都当成首启、每次都把主窗口弹到人脸上'
    ).toBe(true)
    // 顺序：先让界面出场，再落标记
    expect(body.indexOf('showKanban(')).toBeLessThan(body.indexOf('welcomeShown: true'))
  })

  it('启动链不再唤起引导小窗', () => {
    const block = startupBlock()
    expect(block.includes('showOnboarding('), '问名字小窗已退役').toBe(false)
    expect(block.includes('showWelcome('), '三步演示小窗已退役（改由清单条承接）').toBe(false)
  })

  it('两个引导窗的实现与路由一并退役，不留死窗口', () => {
    const windowsTs = stripCommentsAndStrings(read('src/main/windows.ts'))
    expect(windowsTs).not.toContain('showOnboarding')
    expect(windowsTs).not.toContain('showWelcome')

    // 路由用原文查：`case 'onboarding':` 是字符串字面量，剥掉就什么都不剩了
    const appTs = read('src/renderer/App.tsx')
    expect(appTs).not.toContain("case 'onboarding'")
    expect(appTs).not.toContain("case 'welcome'")
    expect(appTs).not.toContain("windows/Onboarding")
    expect(appTs).not.toContain("windows/Welcome")
  })
})
