/**
 * 设计令牌的**名字**清单（1.0.114，卡 2f6f8082）
 *
 * ── 为什么名字要单独一份 ──
 *
 * `variables.css` + `tailwind.config.ts` 定义了令牌，但 `cn()`（tailwind-merge）
 * 还有自己的一张表：它靠**认识的名字**判断两个类是不是同一组、会不会互相覆盖。
 * 认不出来的 `text-caption` 会被当成**颜色**类 —— 于是
 * `cn('text-caption', 'text-text-secondary')` 把字号静默丢掉；
 * 认不出来的 `max-w-dialog-lg` 会和父级的 `max-w-dialog` **同时存在**，
 * 取哪个宽度就由 CSS 顺序决定（对话框尺寸开始"看运气"）。
 *
 * 这不是假想：1.0.113 的 Button 里 size 的 `text-label` / `text-button`
 * 一直排在色值类前面，**从来没生效过**
 * （本轮加渲染断言时才被照出来，见 tests/renderer/components/ui/button-render-935ea1e9.test.tsx）。
 *
 * 所以名字放这里一份，`lib/utils.ts` 的 `cn` 与"令牌×tailwind 配置对齐"的闸门
 * 都读它。`tailwind.config.ts` 的键名也被同一条用例盯着（tests/renderer/styles/design-tokens-*.test.ts）。
 *
 * ⚠️ 加令牌的顺序：先写进 variables.css → 再进 tailwind.config.ts → 最后补到这里。
 */

/** 字号令牌（tailwind `fontSize` 的键，`text-<名>`） */
export const FONT_SIZE_TOKENS = [
  'caption',
  'label',
  'button',
  'content',
  'column-title',
  'body',
  'title',
  'display'
] as const

/** 字体族令牌（`font-<名>`） */
export const FONT_FAMILY_TOKENS = ['mono'] as const

/**
 * 圆角令牌（`rounded-<名>`）
 *
 * ⚠️ 必须写全：tailwind-merge 只认识 Tailwind 自带的 rounded-none/sm/md/lg/xl/full，
 * 本项目这套 rounded-card/button/input/tag/quick-add 它一个都不认识 ——
 * 于是 `rounded-card` 与 `rounded-full` 同时留在元素上，谁赢由 CSS 顺序决定。
 */
export const RADIUS_TOKENS = ['card', 'button', 'input', 'quick-add', 'tag', 'xs', 'panel'] as const

/** 宽度令牌（`w-<名>`） */
export const WIDTH_TOKENS = ['sidebar', 'drawer', 'dialog-sm', 'dialog-md', 'dialog-lg'] as const

/** 最大宽令牌（`max-w-<名>`） */
export const MAX_WIDTH_TOKENS = [
  'dialog',
  'dialog-sm',
  'dialog-md',
  'dialog-lg',
  'page',
  'snackbar',
  'notice',
  'toast'
] as const

/** 最大高令牌（`max-h-<名>`） */
export const MAX_HEIGHT_TOKENS = ['dialog', 'scroll-md', 'scroll-sm'] as const

/** 字距令牌（`tracking-<名>`） */
export const LETTER_SPACING_TOKENS = ['label', 'title'] as const
