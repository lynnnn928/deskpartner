import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { MarkdownContent } from '../../../src/renderer/components/ui/MarkdownContent'
import { invoke } from '../../../src/renderer/lib/ipc-client'

/**
 * Markdown 渲染器改用 remark（卡 `93929ec9`）
 *
 * 换解析器要证明两件事：① 原来认的语法一个不少（表格另有专门用例，
 * 卡 `51671d3e`）；② 原来不认的语法现在认了 —— 链接、嵌套列表、强调、
 * 删除线、图片。raw HTML 仍然只放行 `<br>`，安全面没被这次迁移放松。
 */
const openExternal = vi.fn(async () => ({ opened: true, url: '' }))
vi.mock('../../../src/renderer/lib/ipc-client', () => ({
  invoke: vi.fn(async (channel: string, payload: unknown) => {
    if (channel === 'app:openExternal') return openExternal(payload as never)
    return null
  })
}))

const writeText = vi.fn(async () => undefined)

beforeEach(() => {
  openExternal.mockClear()
  writeText.mockClear()
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true
  })
})

afterEach(() => cleanup())

describe('Markdown 渲染器（remark + remark-gfm，93929ec9）', () => {
  it('链接渲染成可读的 a，而不是原样源码', () => {
    const { container } = render(<MarkdownContent content={'见[官网](https://lynnnn928.github.io/deskpartner)说明'} />)
    const link = container.querySelector('a')
    expect(link?.textContent).toBe('官网')
    expect(link?.getAttribute('href')).toBe('https://lynnnn928.github.io/deskpartner')
    expect(container.textContent).not.toContain('](')
  })

  it('点链接走 app:openExternal（白名单由主进程判）', async () => {
    const { container } = render(<MarkdownContent content={'[点我](https://example.com/a)'} />)
    fireEvent.click(container.querySelector('a') as HTMLAnchorElement)
    await waitFor(() => expect(openExternal).toHaveBeenCalledWith({ url: 'https://example.com/a' }))
    expect(writeText).not.toHaveBeenCalled()
  })

  it('被白名单拒绝时把 URL 复制到剪贴板，而不是点了没反应', async () => {
    openExternal.mockResolvedValueOnce({ opened: false, url: '' } as never)
    const { container } = render(<MarkdownContent content={'[外部](https://example.com/b)'} />)
    fireEvent.click(container.querySelector('a') as HTMLAnchorElement)
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('https://example.com/b'))
  })

  it('嵌套列表不再被压平', () => {
    const md = ['- 外层一', '  - 内层甲', '  - 内层乙', '- 外层二'].join('\n')
    const { container } = render(<MarkdownContent content={md} />)
    const outer = container.querySelector('ul') as HTMLUListElement
    expect(outer.children.length, '外层应只有两条').toBe(2)
    expect(container.querySelectorAll('li li').length, '内层两条要真的嵌在里面').toBe(2)
    expect(screen.getByText('内层甲')).toBeTruthy()
  })

  it('有序列表按起始号连续编号', () => {
    const { container } = render(<MarkdownContent content={'3. 第三\n4. 第四'} />)
    const marks = [...container.querySelectorAll('li > span.font-mono')].map((el) => el.textContent)
    expect(marks).toEqual(['3.', '4.'])
  })

  it('强调 / 删除线 / 行内代码 / 代码块都渲染', () => {
    const md = ['*斜体* 与 ~~删除~~ 与 `code`', '', '```', 'const a = 1', '```'].join('\n')
    const { container } = render(<MarkdownContent content={md} />)
    expect(container.querySelector('em')?.textContent).toBe('斜体')
    expect(container.querySelector('s')?.textContent).toBe('删除')
    expect(container.querySelector('code')?.textContent).toBe('code')
    expect(container.querySelector('pre code')?.textContent).toContain('const a = 1')
  })

  it('raw HTML 一律丢弃，只有裸 <br> 放行', () => {
    const md = ['前一段<div onclick="x()">中间</div>后一段', '', '一行<br>两行', '', '<!-- 注释不该出现 -->'].join('\n')
    const { container } = render(<MarkdownContent content={md} />)
    // 判据是"没有生成任何元素/属性"，而不是"那段文字消失"：html 节点被丢掉后，
    // 标签之间的文字仍按普通文本保留，这是安全的（它不是标记）。
    expect(container.querySelector('[onclick]')).toBeNull()
    expect(container.innerHTML).not.toContain('onclick')
    expect(container.querySelectorAll('div').length, '除自身容器外不该再生成 div').toBe(1)
    expect(container.textContent).not.toContain('注释不该出现')
    expect(container.querySelector('br'), '<br> 应当渲染成换行元素').not.toBeNull()
  })

  it('图片不加载远程资源，按"说明 + 外链"呈现', () => {
    const { container } = render(<MarkdownContent content={'![截图](https://example.com/x.png)'} />)
    expect(container.querySelector('img')).toBeNull()
    const link = container.querySelector('a')
    expect(link?.textContent).toBe('截图')
    expect(link?.getAttribute('href')).toBe('https://example.com/x.png')
  })

  it('引用块里的嵌套内容按块渲染', () => {
    const md = ['> 引用第一段', '>', '> - 引用里的列表'].join('\n')
    const { container } = render(<MarkdownContent content={md} />)
    const quote = container.querySelector('blockquote')
    expect(quote?.textContent).toContain('引用第一段')
    expect(quote?.querySelector('li')?.textContent).toContain('引用里的列表')
  })

  it('空内容不渲染任何东西', () => {
    const { container } = render(<MarkdownContent content={'   '} />)
    expect(container.firstChild).toBeNull()
  })
})

void invoke
