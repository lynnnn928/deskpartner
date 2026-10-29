import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  clampReminderBannerHeight,
  REMINDER_BANNER_MAX_H,
  REMINDER_BANNER_MIN_H,
  REMINDER_BANNER_W
} from '../../../src/main/lib/banner-size'

/**
 * 横幅高度必须由内容决定，且只能在这一个地方夹（1.0.117，卡 `21f171f1`）
 *
 * ── 为什么要两条腿 ──
 *
 * 渲染侧那条已由 `tests/renderer/windows/reminder-banner-21f171f1.test.tsx` 钉住
 * （它会真的上报高度）。但"上报了"不等于"窗口会变"：主进程只要把高度写回去、
 * 或把 clamp 丢了，横幅就还是那条装不下自己话的 104px ——
 * 而渲染测试对此一无所知（它只看到自己发了 IPC）。
 *
 * 所以这里分两层：
 *  1. **数值**由 `clampReminderBannerHeight` 单测（纯函数，判据能算）；
 *  2. **接线**由源码断言（`windows.ts` 用的是那个函数，不是自己再夹一遍）。
 *
 * ⚠️ 反向验证：把 `clampReminderBannerHeight` 的上限去掉，第 2 条必红；
 * 把 windows.ts 里那行换成自己算，第 4 条必红。
 */
const ROOT = path.resolve(__dirname, '../../..')
const WINDOWS_SRC = fs.readFileSync(path.join(ROOT, 'src/main/windows.ts'), 'utf8')
const INDEX_SRC = fs.readFileSync(path.join(ROOT, 'src/main/index.ts'), 'utf8')

describe('横幅尺寸规则（21f171f1）', () => {
  it('内容矮：不低于下限（单行提醒不能缩成一条缝）', () => {
    expect(clampReminderBannerHeight(40, 1000)).toBe(REMINDER_BANNER_MIN_H)
    expect(clampReminderBannerHeight(0, 1000)).toBe(REMINDER_BANNER_MIN_H)
  })

  it('内容高了：跟着内容长（五个按钮 + 回执放得下）', () => {
    expect(clampReminderBannerHeight(168, 1000)).toBe(176)
    expect(clampReminderBannerHeight(240, 1000)).toBe(248)
  })

  it('内容再多也到不了上限以上（一条横幅不该占半屏）', () => {
    expect(clampReminderBannerHeight(2000, 1000)).toBe(REMINDER_BANNER_MAX_H)
  })

  it('屏幕本身很矮时，按可用高度收（不能把横幅顶出屏幕外）', () => {
    expect(clampReminderBannerHeight(2000, 300)).toBe(276)
    // 极端情况仍不低于下限，否则会算出比内容还小的窗口
    expect(clampReminderBannerHeight(2000, 100)).toBe(REMINDER_BANNER_MIN_H)
  })

  it('拿不到有效高度时退回下限（而不是 NaN 传给 setBounds）', () => {
    expect(clampReminderBannerHeight(Number.NaN, 1000)).toBe(REMINDER_BANNER_MIN_H)
    expect(clampReminderBannerHeight(168, Number.NaN)).toBe(176)
    expect(REMINDER_BANNER_W).toBe(440)
  })
})

describe('windows.ts 的接线（21f171f1）', () => {
  it('初始尺寸用常量，不再是写死的 440 / 104', () => {
    expect(WINDOWS_SRC, '宽度又写回字面量了').not.toMatch(/\bconst W = 440\b/)
    expect(WINDOWS_SRC, '高度又写死回 104 了').toMatch(/const H = REMINDER_BANNER_MIN_H/)
    expect(WINDOWS_SRC).toMatch(/const W = REMINDER_BANNER_W/)
  })

  it('高度由渲染层上报、主进程只夹一道', () => {
    expect(WINDOWS_SRC).toContain("'window:fitReminderBanner'")
    expect(WINDOWS_SRC).toContain('clampReminderBannerHeight(height, area.height)')
    // 自己再夹一遍就会与 lib 里的规则并成两处判据
    const at = WINDOWS_SRC.indexOf('private fitReminderBannerTo(')
    const body = WINDOWS_SRC.slice(at, at + 600)
    expect(body, 'windows.ts 里又自己夹了一遍高度').not.toMatch(/Math\.min\(\s*Math\.max/)
  })

  it('改高度时不动宽度与位置（长高要往下长）', () => {
    expect(WINDOWS_SRC).toMatch(/width: bounds\.width, height: next/)
    expect(WINDOWS_SRC).toMatch(/x: bounds\.x, y: bounds\.y/)
  })

  it('授权横幅把目标摘要放到 detail，标题只留"谁想干什么"', () => {
    expect(INDEX_SRC).toContain("detail: summary || command || ''")
    /**
     * 判据是"标题里根本不该出现 summary"，不是"不该出现某种拼法" ——
     * 反向验证时换一种拼法就把只认字面量的闸门骗过去了（本轮实测）。
     */
    const at = INDEX_SRC.indexOf('const bannerTitle =')
    expect(at, 'bannerTitle 不见了').toBeGreaterThan(-1)
    const titleExpr = INDEX_SRC.slice(at, INDEX_SRC.indexOf('windowManager.showReminderBanner', at))
    expect(titleExpr, '标题里又拼回摘要了（440 宽的那一行会被挤爆）').not.toContain('summary')
  })

  it('command-core 生成授权摘要时不再按 30 字截断长标题（64 字标题完整进入横幅 detail）', () => {
    const commandCoreSrc = fs.readFileSync(path.join(ROOT, 'src/main/cli/command-core.ts'), 'utf8')
    expect(commandCoreSrc).toContain('function clip(s: string, n = 120): string')
    expect(commandCoreSrc).not.toContain('function clip(s: string, n = 30): string')
  })
})
