import React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../../lib/utils'

/**
 * 按钮（1.0.114 起变体是数据，不再是 if 链 —— 卡 fb47d77c）
 *
 * ── 为什么上 cva ──
 *
 * 改造前：variant 三选一 + size 二选一，靠 4 行 `&&` 拼 class。
 * 「加第四种变体」要去三个地方：interface 加字面量、className 里加一行、
 * 页面里再补内联覆盖。变体×尺寸的合法组合没有任何地方能回答，
 * 调用方还能用 `className` 透传把任何一条覆盖掉。
 *
 * 现在：变体与尺寸各是一张表（`buttonVariants`），合法组合在数据里；
 * `buttonVariants({ variant, size })` 也能被别的组件拿去复用同一套外观
 * （组件外 24 处手写 `rounded-button` 属另一张卡，不收编）。
 *
 * ⚠️ **判据：改造前后 6 种组合的 class 集合必须逐字符相同** ——
 * 渲染断言 `tests/renderer/components/ui/button-render-*.test.tsx` 钉住了这一点，
 * 否则这轮"重构"就会顺手换掉界面。
 *
 * 另外补了 `type` 的默认值：HTML 的缺省是 `submit`，
 * 于是组件放进表单就会顺手提交（本项目唯一一处表单 GlobalSearchView 显式写了
 * `type="submit"`，其余按钮一律 `button`）。
 */

export const buttonVariants = cva(
  [
    'inline-flex items-center justify-center rounded-button font-medium transition-colors',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
    'disabled:pointer-events-none disabled:opacity-50'
  ],
  {
    variants: {
      variant: {
        primary: 'bg-accent text-white hover:bg-accent/90',
        ghost: 'text-text-secondary hover:bg-black/5 hover:text-text-primary',
        danger: 'text-red-500 hover:bg-red-50 hover:text-red-600',
        /**
         * 实心红：**要人明确选一次的破坏性动作**（1.0.117，卡 `0dfff6df`）
         *
         * `danger` 是无边框红字，语义是"这里可以拒绝/可以删"，适合列表里
         * 与其它按钮并排的次要出口。但当它紧挨着一句红色错误文案时，
         * 两者在屏幕上长得一模一样 —— 实测「允许并强制」就这么被读成了
         * "又一句报错"，而它其实是失败之后唯一的下一步。
         *
         * 判据：**要和错误文案拉开层级时用这个**，不要在调用处内联覆盖颜色 ——
         * 内联 color 类过不了渲染断言，也会在下一次改版时被漏掉。
         *
         * 名字不带连字符是刻意的：渲染断言用 `${variant}-${size}` 再 `split('-')` 解析键。
         */
        dangerSolid: 'bg-red-600 text-white hover:bg-red-700'
      },
      size: {
        sm: 'h-7 px-2 text-label',
        md: 'h-8 px-3 text-button'
      }
    },
    defaultVariants: {
      variant: 'ghost',
      size: 'md'
    }
  }
)

export type ButtonVariant = NonNullable<VariantProps<typeof buttonVariants>['variant']>
export type ButtonSize = NonNullable<VariantProps<typeof buttonVariants>['size']>

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'ghost', size = 'md', type = 'button', ...props }, ref) => {
    return (
      <button
        ref={ref}
        type={type}
        className={cn(buttonVariants({ variant, size }), className)}
        {...props}
      />
    )
  }
)

Button.displayName = 'Button'
