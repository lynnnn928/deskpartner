import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { EmptyState } from '../../../../src/renderer/components/ui/EmptyState'
import { PageHeader } from '../../../../src/renderer/components/ui/PagePrimitives'

/**
 * 空态与页面骨架的渲染断言（1.0.114，卡 290a99e5 / 935ea1e9）
 *
 * EmptyState 从 PagePrimitives 拆出后，拆分文件与原文件都在改同一件事，
 * 最容易出现"两边各留一份"（拆分文件只复制了一半，原文件没删）。
 * 这条用例同时证明两件事：拆出来的那个还在、且输出没变。
 */

const classesOf = (el: Element) =>
  Array.from(new Set((el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean))).sort()

describe('EmptyState 渲染断言', () => {
  it('基础块：class 串与拆分前相同', () => {
    render(<EmptyState title="还没有事项" />)
    const el = screen.getByText('还没有事项').parentElement as HTMLElement
    expect(classesOf(el)).toEqual(
      ['empty-state', 'rounded-card', 'border', 'border-dashed', 'border-border', 'p-5', 'text-center'].sort()
    )
  })

  it('描述与动作是可选的：给了才渲染（多一层 div 就等于多一段间距）', () => {
    render(<EmptyState title="空" description="换个筛选试试" action={<button>清除筛选</button>} />)
    expect(screen.getByText('换个筛选试试')).toBeTruthy()
    expect(screen.getByRole('button', { name: '清除筛选' })).toBeTruthy()
  })

  it('调用方的 className 追加在末尾（不覆盖基础块）', () => {
    render(<EmptyState title="空" className="mt-4" />)
    const el = screen.getByText('空').parentElement as HTMLElement
    expect(classesOf(el)).toContain('mt-4')
    expect(classesOf(el)).toContain('rounded-card')
  })
})

describe('PageHeader 渲染断言（拆分后骨架留在原文件）', () => {
  it('标题、说明、eyebrow 各自到位', () => {
    render(<PageHeader title="统计" eyebrow="概览" description="这段时间新建与完成了多少" />)
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('统计')
    expect(screen.getByText('概览')).toBeTruthy()
    expect(screen.getByText('这段时间新建与完成了多少')).toBeTruthy()
  })

  it('PagePrimitives 不再导出 StatusBadge / EmptyState（拆分后只有一条来源）', async () => {
    const primitives = await import('../../../../src/renderer/components/ui/PagePrimitives')
    expect('StatusBadge' in primitives).toBe(false)
    expect('EmptyState' in primitives).toBe(false)
  })
})
