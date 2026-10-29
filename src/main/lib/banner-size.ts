/**
 * 顶部提醒横幅的尺寸规则（1.0.117，卡 `21f171f1`）
 *
 * ── 为什么单独抽出来 ──
 *
 * 高度从此由**内容**决定：渲染层量自己，主进程夹一道。
 * 而"夹"这件事如果只写在 `windows.ts` 里，就只能靠读代码相信它 ——
 * 那个文件摸 `screen` / `BrowserWindow`，没法在单测里跑。
 * 于是把规则提成纯函数：上下限与边距都成了可断言的判据。
 *
 * ── 三个数各自为什么是这个值 ──
 *
 * - 宽度固定 440：横幅是屏幕上方居中弹出的一条，不该随内容忽宽忽窄；
 * - 下限 104：与写死时代同一个高度 —— 单行提醒不该缩成一条缝；
 * - 上限 360：再高就该去审批页看完整信息了；同时不能超过屏幕可用高度。
 *
 * ⚠️ `+8` 是给圆角和内边距留的余量：内容高度贴着窗口边时，
 * 圆角那几像素会被透明窗口裁掉，看起来像"横幅缺了个角"。
 */
export const REMINDER_BANNER_W = 440
export const REMINDER_BANNER_MIN_H = 104
export const REMINDER_BANNER_MAX_H = 360

/** 内容高度 → 窗口高度：夹到 [104, min(360, 屏幕可用高度 - 24)] */
export function clampReminderBannerHeight(height: number, areaHeight: number): number {
  if (!Number.isFinite(height)) return REMINDER_BANNER_MIN_H
  // 离屏幕底边留 24：横幅长了会往下长，伸到屏幕外的部分谁也看不见
  const ceiling = Number.isFinite(areaHeight) ? areaHeight - 24 : REMINDER_BANNER_MAX_H
  const maxH = Math.max(REMINDER_BANNER_MIN_H, Math.min(REMINDER_BANNER_MAX_H, ceiling))
  return Math.min(Math.max(Math.round(height) + 8, REMINDER_BANNER_MIN_H), maxH)
}
