/**
 * 发版前置闸门：项目名（卡 36f3eaa4，1.0.115）
 *
 * ── 要锁住的现象 ──
 *
 * 1.0.114 发版实测（2026-10-27）：前置检查放过了缺 `--project` 的命令行，
 * 于是**前 12 步全过**（测试 2069 passed + 真库备份往返 + 升号 + build +
 * electron-builder 打包 + latest.yml + 发版验收，约 16 分钟），到第 13 步
 * 「版本登记」才因为 `buildReleaseAddArgs` 抛「缺 --project」中止。
 *
 * 代价不是"重跑一次"：
 *  · `package.json` 已经升到新号、`dist/` 里已经躺着一个 88MB 的装机包；
 *  · 登记**没落** —— 版本处于"发出去了但查不到"的状态（这版是手写脚本补登才齐的）；
 *  · 重跑整条链会因为"该号已存在于 dist/"被挡（要 `--overwrite`），而且默认会**再升一版号**。
 *
 * 根因是个很自然的直觉：**校验放在使用点旁边**。在这条链上它是错的 ——
 * 每一步都很贵，越晚校验白跑越多。所以判据要提到前置，且与拼 argv **共用同一处**
 * （`requireProject`），否则两处早晚各说各话。
 *
 * ── 为什么写结构性断言 ──
 *
 * 前置检查里那几行可以以后被人"顺手简化"掉，而行为测试不容易在单测里跑
 * （release.mjs 顶层即发版，一 import 就真发版）。同类先例：
 * tests/main/cli/release-clean-gate.test.ts（工作区干净那道闸门）。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { requireProject, buildReleaseAddArgs, parseReleaseArgs } from '../../../scripts/lib/release-register.mjs'

const src = readFileSync(join(process.cwd(), 'scripts', 'release.mjs'), 'utf8')

/** 前置检查那一段：从 `head('前置检查')` 到"跑测试"那一步之前 */
const PREFLIGHT_ANCHOR = "head('前置检查')"
const TESTS_ANCHOR = "head('跑测试"
function preflightBlock(): string {
  const i = src.indexOf(PREFLIGHT_ANCHOR)
  const j = src.indexOf(TESTS_ANCHOR)
  if (i < 0 || j < 0 || j < i) throw new Error('release.mjs 里找不到前置检查 / 跑测试这两步（被人删了？）')
  return src.slice(i, j)
}

describe('requireProject：判据本身（与 release add 共用一处）', () => {
  it('缺项目名 / 空白都抛，报错点名 --project', () => {
    for (const bad of [undefined, null, '', '   ', '\t\n']) {
      expect(() => requireProject(bad as never)).toThrow(/缺 --project/)
    }
  })

  it('给你项目名时去掉首尾空白（"DeskPartner " 不该被当成另一个项目）', () => {
    expect(requireProject('  DeskPartner  ')).toBe('DeskPartner')
  })

  it('buildReleaseAddArgs 走的就是同一个判据（报错文案一字不差）', () => {
    const one = (() => {
      try {
        requireProject('')
      } catch (e) {
        return (e as Error).message
      }
      return ''
    })()
    let two = ''
    try {
      buildReleaseAddArgs({ version: '1.0.115', summary: 's' })
    } catch (e) {
      two = (e as Error).message
    }
    expect(one).toBeTruthy()
    expect(two).toBe(one)
  })
})

describe('前置检查必须在校验 --project（卡 36f3eaa4）', () => {
  it('前置检查里调用了 requireProject(PROJECT)', () => {
    expect(
      preflightBlock(),
      '前置检查里没有 requireProject(PROJECT) —— 缺项目名又会跑到第 13 步才中止'
    ).toMatch(/requireProject\(\s*PROJECT\s*\)/)
  })

  it('它在跑测试 / 构建 / 打包之前（越晚校验白跑越多）', () => {
    const at = src.indexOf('requireProject(PROJECT)')
    expect(at, '找不到 requireProject(PROJECT)，闸门失效').toBeGreaterThan(-1)
    // ⚠️ 锚点一律用 head() 的完整调用串：裸词（如 `electron-builder`）
    // 在文件头注释里就出现过一次，会把断言锚到注释上、恒真（同 release-clean-gate 的坑）。
    for (const later of [TESTS_ANCHOR, "head('打包（electron-builder", 'head(`版本登记（release add']) {
      const i = src.indexOf(later)
      expect(i, `找不到步骤锚点 ${later}（发版链被人改了？）`).toBeGreaterThan(-1)
      expect(at, `requireProject 落在 ${later} 之后了`).toBeLessThan(i)
    }
  })

  it('拦下时是中止（die）并给出补参数的下一步，不是打个警告继续', () => {
    const block = preflightBlock()
    const i = block.indexOf('requireProject(PROJECT)')
    // 紧邻的一段里必须有 die(...) 与补参数的提示
    const nearby = block.slice(Math.max(0, i - 400), i + 400)
    expect(nearby).toMatch(/catch\s*\(e\)\s*\{[\s\S]*die\(/)
    expect(nearby).toMatch(/--project/)
  })

  it('--project 由 parseReleaseArgs 解析（与 release add 同一套 flag 解析）', () => {
    expect(src).toMatch(/project:\s*PROJECT\s*,/)
    expect(parseReleaseArgs(['--project', 'DeskPartner', '--summary', 's']).project).toBe('DeskPartner')
    expect(parseReleaseArgs(['--project=知彼', '--summary', 's']).project).toBe('知彼')
    expect(parseReleaseArgs(['--summary', 's']).project).toBeNull()
  })

  it('用法说明里写清了 --project 必填（别让人靠报错猜）', () => {
    expect(src).toMatch(/--project "DeskPartner"/)
    expect(src).toMatch(/`--project` 同理必填/)
  })
})
