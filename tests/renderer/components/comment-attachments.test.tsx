// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
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
  useSettingsStore.setState({ settings: { humanName: '木木' } as never })
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
})
