import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import {
  Button,
  buttonVariants,
  type ButtonSize,
  type ButtonVariant
} from '../../../../src/renderer/components/ui/Button'

/**
 * 按钮渲染断言（1.0.114，卡 935ea1e9 的第一条样板用例；同时守住卡 fb47d77c）
 *
 * ── 它挡的是什么 ──
 *
 * `Button` 从"4 行 if 拼 class"改成 cva 的表驱动（卡 fb47d77c），这一步
 * **必须是纯重构**：多一种变体只该多一行数据，不该顺手动外观。
 * 靠肉眼看不出来 —— 6 种 variant×size 组合里有 3 种只差字色或 hover。
 *
 * ── ⚠️ 这里逮到一个真缺陷（本轮修掉）──
 *
 * 改造前的 size 里写着 `text-label` / `text-button`，但 `cn()`（tailwind-merge）
 * **不认识这两个自定义字号名**，把它们当成颜色类，于是后写的
 * `text-text-secondary` / `text-white` 每次都会把字号吞掉 ——
 * 按钮的 `--font-label` / `--font-button` **从来没生效过**。
 *
 * 修法在 `lib/utils.ts` 的 `cn`：把令牌名登记进 tailwind-merge（清单在
 * `lib/design-tokens.ts`）。**所以本轮唯一一处可见变化就是按钮字号恢复为
 * 设计的 12px（sm）/ 13px（md）** —— 这是"令牌写死在组件里却不生效"的收口，
 * 不是重构顺带的副作用，单独记在卡 fb47d77c 的收口评论里。
 */

const BASE = [
  'inline-flex',
  'items-center',
  'justify-center',
  'rounded-button',
  'font-medium',
  'transition-colors',
  'focus-visible:outline-none',
  'focus-visible:ring-2',
  'focus-visible:ring-accent',
  'disabled:pointer-events-none',
  'disabled:opacity-50'
]

/** 每个组合最终落到 DOM 上的类（含 size 的字号类 —— 见文件头那段缺陷说明） */
const EXPECTED: Record<string, string[]> = {
  'ghost-md': [...BASE, 'h-8', 'px-3', 'text-button', 'text-text-secondary', 'hover:bg-black/5', 'hover:text-text-primary'],
  'ghost-sm': [...BASE, 'h-7', 'px-2', 'text-label', 'text-text-secondary', 'hover:bg-black/5', 'hover:text-text-primary'],
  'primary-md': [...BASE, 'h-8', 'px-3', 'text-button', 'bg-accent', 'text-white', 'hover:bg-accent/90'],
  'primary-sm': [...BASE, 'h-7', 'px-2', 'text-label', 'bg-accent', 'text-white', 'hover:bg-accent/90'],
  'danger-md': [...BASE, 'h-8', 'px-3', 'text-button', 'text-red-500', 'hover:bg-red-50', 'hover:text-red-600'],
  'danger-sm': [...BASE, 'h-7', 'px-2', 'text-label', 'text-red-500', 'hover:bg-red-50', 'hover:text-red-600'],
  'dangerSolid-md': [...BASE, 'h-8', 'px-3', 'text-button', 'bg-red-600', 'text-white', 'hover:bg-red-700'],
  'dangerSolid-sm': [...BASE, 'h-7', 'px-2', 'text-label', 'bg-red-600', 'text-white', 'hover:bg-red-700']
}

const classesOf = (el: Element) =>
  Array.from(new Set((el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean))).sort()

describe('Button 渲染断言（variant×size 六种组合）', () => {
  for (const [key, expected] of Object.entries(EXPECTED)) {
    const [variant, size] = key.split('-') as [ButtonVariant, ButtonSize]
    it(`${key}：class 集合与改造前逐条相同`, () => {
      render(<Button variant={variant} size={size} data-testid="btn">确定</Button>)
      expect(classesOf(screen.getByTestId('btn'))).toEqual([...expected].sort())
    })
  }

  it('默认 variant=ghost / size=md（与改造前一致）', () => {
    render(<Button data-testid="btn">默认</Button>)
    expect(classesOf(screen.getByTestId('btn'))).toEqual([...EXPECTED['ghost-md']].sort())
  })

  it('buttonVariants 本身可复用，且与组件输出同源', () => {
    render(<Button variant="primary" size="sm" data-testid="btn">主</Button>)
    expect(classesOf(screen.getByTestId('btn'))).toEqual(
      Array.from(new Set(buttonVariants({ variant: 'primary', size: 'sm' }).split(/\s+/))).sort()
    )
  })

  it('字号类真的留在元素上（1.0.113 曾被 cn 当成颜色吞掉）', () => {
    render(<Button size="sm" data-testid="btn">小</Button>)
    const classes = classesOf(screen.getByTestId('btn'))
    expect(classes).toContain('text-label')
    expect(classes).toContain('text-text-secondary')
  })
})

describe('Button 的语义与透传', () => {
  it('type 默认 button（HTML 缺省是 submit，放进表单会顺手提交）', () => {
    render(<Button data-testid="btn">点我</Button>)
    expect(screen.getByTestId('btn').getAttribute('type')).toBe('button')
  })

  it('调用方写的 type 优先（表单提交按钮仍然能提交）', () => {
    render(<Button type="submit" data-testid="btn">搜索</Button>)
    expect(screen.getByTestId('btn').getAttribute('type')).toBe('submit')
  })

  it('className 仍可透传，且与变体冲突时由 cn 后者胜出', () => {
    render(<Button size="sm" className="h-10 px-6" data-testid="btn">大号</Button>)
    const classes = classesOf(screen.getByTestId('btn'))
    expect(classes).toContain('h-10')
    expect(classes).toContain('px-6')
    expect(classes).not.toContain('h-7')
    expect(classes).not.toContain('px-2')
  })

  it('disabled / onClick 等原生属性原样到达 DOM', () => {
    let clicked = 0
    render(<Button disabled onClick={() => { clicked += 1 }} data-testid="btn">不可点</Button>)
    const btn = screen.getByTestId('btn') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    btn.click()
    expect(clicked).toBe(0)
  })
})
