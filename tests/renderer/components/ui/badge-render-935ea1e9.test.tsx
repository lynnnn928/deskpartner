import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { StatusBadge } from '../../../../src/renderer/components/ui/Badge'

/**
 * 徽章渲染断言（1.0.114，卡 290a99e5）
 *
 * 卡 290a99e5 选的是"先拆文件、不改渲染输出"。拆文件最容易出的错
 * 不是编译错（tsc 会拦），而是**拆分时顺手改了 class 串**：
 * 例如把 `bg-[var(--surface-muted)]` 简写成 `bg-surface-muted`（后者不存在，
 * 样式静默消失，界面只是"看起来淡了一点"）。
 *
 * 所以五个 tone 的 class 串在这里逐条写死。
 *
 * ── 1.0.115 更新（卡 5fdf9b6d 第二步）──
 *
 * 那次"简写"现在是**对的**了：`bg-surface-subtle` / `bg-surface-muted` 已登记进
 * tailwind 的 backgroundColor（卡 5fdf9b6d 第二步把令牌引用型任意值全部换成工具类）。
 * 于是下面这五条从「引用令牌」改成「工具类名」，判据不变 —— 仍然是
 * **五个 tone 的 class 集合逐条相同**，拆分/改写法都不能顺手改掉观感。
 */
/**
 * 1.0.125（卡 6ae61278）加了两条：徽标放进 `min-w-0` 的 flex 行后会被压成一字一行。
 * `whitespace-nowrap shrink-0` 是**有意加的**，不是顺手改 class —— 所以 BASE 跟着改，
 * 判据仍是"五个 tone 的 class 集合逐条相同"。
 */
const BASE = [
  'inline-flex',
  'items-center',
  'rounded-full',
  'border',
  'px-2',
  'py-0.5',
  'text-label',
  'font-medium',
  'whitespace-nowrap',
  'shrink-0'
]

const TONES: Record<string, string[]> = {
  neutral: ['border-border', 'bg-surface-muted', 'text-text-secondary'],
  accent: ['border-accent/30', 'bg-accent/10', 'text-accent'],
  success: ['border-success/30', 'bg-success/10', 'text-success'],
  warning: ['border-warning/30', 'bg-warning/10', 'text-warning'],
  danger: ['border-danger/30', 'bg-danger/10', 'text-danger']
}

const classesOf = (el: Element) =>
  Array.from(new Set((el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean))).sort()

describe('StatusBadge 渲染断言（拆分前后输出不变）', () => {
  for (const [tone, toneClasses] of Object.entries(TONES)) {
    it(`${tone}：class 集合与拆分前逐条相同`, () => {
      render(<StatusBadge tone={tone as keyof typeof TONES}>待验收</StatusBadge>)
      expect(classesOf(screen.getByText('待验收'))).toEqual([...BASE, ...toneClasses].sort())
    })
  }

  it('tone 缺省为 neutral', () => {
    render(<StatusBadge>默认</StatusBadge>)
    expect(classesOf(screen.getByText('默认'))).toEqual([...BASE, ...TONES.neutral].sort())
  })

  it('渲染成一个 span 且带文字（不是按钮：徽章不可点）', () => {
    render(<StatusBadge>标签</StatusBadge>)
    const el = screen.getByText('标签')
    expect(el.tagName).toBe('SPAN')
  })
})
