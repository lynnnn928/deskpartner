import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { TodoAttachments } from '../../../src/renderer/components/quick-add/TodoAttachments'
import type { TodoAttachment } from '../../../src/renderer/types/todo'

/**
 * 事项附件（schema v50，卡 `1cb61d18`）
 *
 * 渲染断言只需要钉住四条**行为**，钉不住像素（happy-dom 没有布局）：
 * ① 图片格子里是缩略图、非图片格子里是扩展名标签；
 * ② 点图片开预览（大图另取一次），点文件走系统默认程序；
 * ③ 添加按钮走"开对话框选文件"那条通道；
 * ④ 移除要先确认，再调删除通道。
 *
 * 另外钉住"失败要说出来"：一个文件太大不该静默消失。
 */
const hoisted = vi.hoisted(() => ({
  calls: [] as Array<{ channel: string; input: unknown }>,
  attachments: [] as unknown[],
  pickResult: { added: [], failed: [] } as unknown
}))

vi.mock('../../../src/renderer/lib/ipc-client', () => ({
  invoke: vi.fn(async (channel: string, input: unknown) => {
    hoisted.calls.push({ channel, input })
    switch (channel) {
      case 'todo:attachments':
        return hoisted.attachments
      case 'todo:attachmentThumbs':
        return { 'a-img': 'data:image/png;base64,THUMB' }
      case 'todo:attachmentPreview':
        return { dataUrl: 'data:image/png;base64,FULL', name: '验收截图.png' }
      case 'todo:pickAttachments':
        return hoisted.pickResult
      default:
        return null
    }
  })
}))

const attachment = (over: Partial<TodoAttachment>): TodoAttachment => ({
  id: 'a-img',
  todoId: 't1',
  seq: 1,
  name: '验收截图.png',
  ext: '.png',
  kind: 'image',
  mime: 'image/png',
  bytes: 2048,
  sha256: 'x'.repeat(64),
  relPath: 'attachments/t1/a-img.png',
  createdBy: 'human',
  createdAt: '2026-11-11T00:00:00.000Z',
  ...over
})

const mesh = (chan: string): Array<{ channel: string; input: unknown }> =>
  hoisted.calls.filter((c) => c.channel === chan)

describe('TodoAttachments（v50 事项附件）', () => {
  beforeEach(() => {
    hoisted.calls.length = 0
    hoisted.pickResult = { added: [], failed: [] }
    hoisted.attachments = [
      attachment({}),
      attachment({
        id: 'a-pdf',
        seq: 2,
        name: '交付说明.pdf',
        ext: '.pdf',
        kind: 'file',
        mime: 'application/pdf',
        bytes: 3 * 1024 * 1024,
        relPath: 'attachments/t1/a-pdf.pdf'
      })
    ]
  })

  afterEach(() => cleanup())

  it('图片显示缩略图，文件显示扩展名与大小', async () => {
    render(<TodoAttachments todoId="t1" />)

    const img = await screen.findByAltText('验收截图.png')
    expect(img.getAttribute('src')).toBe('data:image/png;base64,THUMB')
    // 文件名与大小都摆出来了 —— 挂完要能认得出是哪一份
    expect(screen.getByText('验收截图.png')).toBeTruthy()
    expect(screen.getByText('2 KB')).toBeTruthy()
    // 非图片没有缩略图，只有扩展名标签
    expect(screen.getByText('交付说明.pdf')).toBeTruthy()
    expect(screen.getByText('PDF')).toBeTruthy()
    expect(screen.getByText('3.0 MB')).toBeTruthy()
    expect(screen.queryByAltText('交付说明.pdf')).toBeNull()
  })

  it('点图片开预览（大图另取），点文件交给系统默认程序', async () => {
    render(<TodoAttachments todoId="t1" />)

    fireEvent.click(await screen.findByTestId('todo-attachment-item-a-img'))
    await waitFor(() => expect(screen.getByTestId('todo-attachment-preview')).toBeTruthy())
    expect(mesh('todo:attachmentPreview')).toHaveLength(1)
    // 缩略图与预览图 alt 同名，取预览那张要按 testid
    const big = screen.getByTestId('todo-attachment-preview-image')
    await waitFor(() => expect(big.getAttribute('src')).toBe('data:image/png;base64,FULL'))

    fireEvent.click(screen.getByTestId('todo-attachment-preview-close'))
    fireEvent.click(screen.getByTestId('todo-attachment-item-a-pdf'))
    await waitFor(() => expect(mesh('todo:openAttachment')).toHaveLength(1))
    expect(mesh('todo:openAttachment')[0].input).toEqual({ id: 'a-pdf' })
    // 文件不该被当成图片去预览
    expect(mesh('todo:attachmentPreview')).toHaveLength(1)
  })

  it('添加走"选文件"通道；失败的文件名与原因要显示出来', async () => {
    hoisted.pickResult = {
      added: [],
      failed: [{ path: 'D:\\rua\\太大.log', reason: '附件超过 25.0 MB 上限（80.0 MB）' }]
    }
    render(<TodoAttachments todoId="t1" />)

    fireEvent.click(await screen.findByTestId('todo-attachment-add'))
    await waitFor(() => expect(mesh('todo:pickAttachments')).toHaveLength(1))
    const err = await screen.findByTestId('todo-attachment-error')
    expect(err.textContent).toContain('太大.log')
    expect(err.textContent).toContain('超过 25.0 MB 上限')
    // 失败之后仍然重新拉一次列表（成功的那些要出现）
    expect(mesh('todo:attachments').length).toBeGreaterThan(1)
  })

  it('移除先确认：确认后才真删，取消则不动', async () => {
    render(<TodoAttachments todoId="t1" />)

    fireEvent.click(await screen.findByTestId('todo-attachment-remove-a-pdf'))
    expect(screen.getByText('移除这个附件？')).toBeTruthy()
    expect(mesh('todo:removeAttachment')).toHaveLength(0)

    fireEvent.click(screen.getByText('取消'))
    await waitFor(() => expect(screen.queryByText('移除这个附件？')).toBeNull())
    expect(mesh('todo:removeAttachment')).toHaveLength(0)

    fireEvent.click(screen.getByTestId('todo-attachment-remove-a-pdf'))
    fireEvent.click(screen.getByTestId('todo-attachment-confirm-remove'))
    await waitFor(() => expect(mesh('todo:removeAttachment')).toHaveLength(1))
    expect(mesh('todo:removeAttachment')[0].input).toEqual({ id: 'a-pdf' })
  })

  it('没有附件时给一句提示，而不是一片空白', async () => {
    hoisted.attachments = []
    render(<TodoAttachments todoId="t1" />)
    expect(await screen.findByText(/还没有附件/)).toBeTruthy()
  })
})
