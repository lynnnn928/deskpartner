// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'
import React from 'react'
import { CommentThread } from '../../../src/renderer/components/quick-add/CommentThread'
import { useSettingsStore } from '../../../src/renderer/stores/settings.store'

/**
 * 评论附图（schema v51；起因是主用户那句「你写在评论里的截图，我看不到」）
 *
 * 判据只有一条：**图真的出现在评论下面**，而不是一行路径文字。
 * 这里盯的是界面把 `todo:attachmentThumbs` 的返回值接到了 `<img>` 上 ——
 * 主进程返回了缩略图、界面没渲染，这种"都做了但没接上"的缺陷 tsc 抓不到。
 */
const invokeMock = vi.fn()
vi.mock('../../../src/renderer/lib/ipc-client', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  on: () => () => {}
}))

const COMMENT = {
  id: 'c1',
  todoId: 't1',
  parentId: null,
  authorType: 'agent',
  authorId: 'agent:bob',
  body: '改好了，见截图',
  kind: 'comment',
  createdAt: '2026-11-13T00:00:00.000Z',
  attachments: [
    {
      id: 'a1',
      todoId: 't1',
      commentId: 'c1',
      seq: 1,
      name: '验收.png',
      ext: '.png',
      kind: 'image',
      mime: 'image/png',
      bytes: 1234,
      sha256: 'x',
      relPath: 'attachments/t1/a1.png',
      createdBy: 'agent:bob',
      createdAt: '2026-11-13T00:00:00.000Z'
    }
  ]
}

beforeEach(() => {
  invokeMock.mockReset()
  invokeMock.mockImplementation(async (channel: string) => {
    if (channel === 'todo:comments') return [COMMENT]
    if (channel === 'todo:attachmentThumbs') return { a1: 'data:image/png;base64,AAAA' }
    return null
  })
  useSettingsStore.setState({ settings: { humanName: 'Alex' } as never })
})

afterEach(() => cleanup())

describe('评论附图', () => {
  it('评论带的图渲染成真正的图片，src 用的是主进程给的缩略图', async () => {
    render(<CommentThread todoId="t1" />)
    const img = await waitFor(() => screen.getByTestId('comment-attachment-image-a1'))
    expect(img.getAttribute('src')).toBe('data:image/png;base64,AAAA')
    expect(img.getAttribute('alt')).toBe('验收.png')
    expect(invokeMock).toHaveBeenCalledWith('todo:attachmentThumbs', { ids: ['a1'] })
  })

  /**
   * 点缩略图开大图（1.0.147）
   *
   * 起因：缩略图只有几百像素，截图里的字看不清，而点它之前什么都不发生 ——
   * 看着像图，用起来像死图。这里盯两件事：点击真的去要了大图（且走的是附件区
   * 已经在用的那条通道），以及拿到的大图真的画在了预览框里。
   */
  it('点击缩略图会去要预览大图，并在预览框里显示出来', async () => {
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === 'todo:comments') return [COMMENT]
      if (channel === 'todo:attachmentThumbs') return { a1: 'data:image/png;base64,AAAA' }
      if (channel === 'todo:attachmentPreview') {
        return { dataUrl: 'data:image/png;base64,PREVIEW', name: '验收.png' }
      }
      return null
    })

    render(<CommentThread todoId="t1" />)
    fireEvent.click(await screen.findByTestId('comment-attachment-open-a1'))

    await waitFor(() => expect(screen.getByTestId('comment-attachment-preview-image')).toBeTruthy())
    expect(invokeMock).toHaveBeenCalledWith('todo:attachmentPreview', { id: 'a1' })
    const big = screen.getByTestId('comment-attachment-preview-image')
    expect(big.getAttribute('src')).toBe('data:image/png;base64,PREVIEW')
    // 标题写文件名：连着几张截图时，得知道现在看的是哪一张
    expect(screen.getByTestId('comment-attachment-preview').textContent).toContain('验收.png')
  })

  /** 预览通道报错时给一句读得懂的话，而不是点了没反应 */
  it('预览通道报错时显示提示，不静默也不崩', async () => {
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === 'todo:comments') return [COMMENT]
      if (channel === 'todo:attachmentThumbs') return { a1: 'data:image/png;base64,AAAA' }
      if (channel === 'todo:attachmentPreview') throw new Error('附件不存在，可能已被删除')
      return null
    })

    render(<CommentThread todoId="t1" />)
    fireEvent.click(await screen.findByTestId('comment-attachment-open-a1'))

    const err = await screen.findByTestId('comment-attachment-preview-error')
    expect(err.textContent).toContain('附件不存在')
    expect(screen.queryByTestId('comment-attachment-preview-image')).toBeNull()
    // 线程还在，提示之外什么都不该塌
    expect(screen.getByTestId('comment-attachments-c1')).toBeTruthy()
  })
})
