import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { MarkdownContent } from '../../../src/renderer/components/ui/MarkdownContent'

/**
 * GFM 表格渲染（卡 `51671d3e`）
 *
 * 主用户在文档页打开一篇答辩方案，整块表格显示成一屏竖线源码（含单元格里的 `<br>`），
 * 只能换系统程序打开。这里钉的是结构：表格真的变成了 table、单元格内容不再带竖线、
 * 对齐串按冒号落到 th/td 的 class 上、`<br>` 变成换行元素。
 */
afterEach(() => cleanup())

const TABLE = [
  '## 评审标准',
  '',
  '| 评审维度 | 权重 | 说明 |',
  '| :--- | :---: | ---: |',
  '| **1. 产品实用性** | **30分** | 痛点<br>场景 |',
  '| **2. 产品创新性** | **30分** | 生态<br>主题 |',
  '',
  '表格之后的段落'
].join('\n')

describe('Markdown 表格（51671d3e）', () => {
  it('表格变成真的 table：表头与数据行都在，源码竖线不再出现', () => {
    const { container } = render(<MarkdownContent content={TABLE} />)
    const table = container.querySelector('table')
    expect(table, '表格没有被渲染出来').not.toBeNull()

    const headers = [...container.querySelectorAll('th')].map((el) => el.textContent)
    expect(headers).toEqual(['评审维度', '权重', '说明'])

    const firstRow = [...container.querySelectorAll('tbody tr')[0].querySelectorAll('td')].map(
      (el) => el.textContent
    )
    expect(firstRow[0]).toBe('1. 产品实用性')
    expect(firstRow[1]).toBe('30分')

    // 竖线与分隔串不该以正文形式出现在表格里
    expect(container.querySelector('table')?.textContent ?? '').not.toContain('|')
    expect(container.querySelector('table')?.textContent ?? '').not.toContain(':---')

    // 表格之后的正文仍是段落，没有被吞进表格
    expect(screen.getByText('表格之后的段落')).toBeTruthy()
    expect(container.querySelectorAll('tbody tr').length, '数据行数').toBe(2)
  })

  it('对齐按分隔行的冒号落位：左 / 中 / 右', () => {
    const { container } = render(<MarkdownContent content={TABLE} />)
    const ths = [...container.querySelectorAll('th')]
    expect(ths[0].className).toContain('text-left')
    expect(ths[1].className).toContain('text-center')
    expect(ths[2].className).toContain('text-right')

    const tds = [...container.querySelectorAll('tbody tr')[1].querySelectorAll('td')]
    expect(tds[0].className).toContain('text-left')
    expect(tds[1].className).toContain('text-center')
    expect(tds[2].className).toContain('text-right')
  })

  it('单元格里的 **加粗** 与 <br> 都生效，<br> 不再是可见字符', () => {
    const { container } = render(<MarkdownContent content={TABLE} />)
    const cell = container.querySelector('tbody tr td')
    expect(cell?.querySelector('strong')?.textContent).toBe('1. 产品实用性')

    const thirdCell = container.querySelectorAll('tbody tr')[0].querySelectorAll('td')[2]
    expect(thirdCell.querySelectorAll('br').length, '<br> 应渲染成换行元素').toBe(1)
    expect(thirdCell.textContent).toBe('痛点场景')
    expect(thirdCell.textContent).not.toContain('<br>')
  })

  it('只有竖线开头、下一行不是分隔行的内容仍按段落渲染（不能误判成表）', () => {
    const { container } = render(<MarkdownContent content={'| 这不是表格\n| 只是两行竖线开头的文字'} />)
    expect(container.querySelector('table')).toBeNull()
    expect(container.textContent).toContain('这不是表格')
  })

  it('单元格里的 \\| 转义当普通竖线，不拆列', () => {
    const { container } = render(
      <MarkdownContent content={'| 写法 | 含义 |\n| --- | --- |\n| a \\| b | 竖线 |'} />
    )
    const cells = [...container.querySelectorAll('tbody td')].map((el) => el.textContent)
    expect(cells).toEqual(['a | b', '竖线'])
  })
})
