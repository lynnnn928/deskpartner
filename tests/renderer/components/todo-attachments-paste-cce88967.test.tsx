import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup, act } from '@testing-library/react'
import { TodoAttachments } from '../../../src/renderer/components/quick-add/TodoAttachments'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 附件区直接粘贴（卡 `cce88967`）
 *
 * 钉住三件事：
 * ① **分流**：资源管理器复制来的文件有真实路径 → 走已有的按路径那条（不复制字节、
 *    保留原文件名）；截图只有内存字节 → 走新通道，名字由界面命名成「粘贴图片-<时间戳>」；
 * ② **纯文字粘贴不许拦**：粘一段说明进标题框是常规操作，被 preventDefault 掉才是 bug；
 * ③ **失败要说清是哪一份**（超限/不支持的都算）—— 静默消失比报错更糟。
 *
 * 另外钉住源码层的两处：粘贴目标是附件区里看得见的一块，且整个附件区只在**编辑某条
 * 事项**时才挂载（否则粘贴会跑到别的页面上去）。
 */
const hoisted = vi.hoisted(() => ({
  calls: [] as Array<{ channel: string; input: unknown }>,
  attachments: [] as unknown[],
  pastedResult: { added: [], failed: [] } as unknown,
  addPathsResult: { added: [], failed: [] } as unknown
}))

vi.mock('../../../src/renderer/lib/ipc-client', () => ({
  invoke: vi.fn(async (channel: string, input: unknown) => {
    hoisted.calls.push({ channel, input })
    switch (channel) {
      case 'todo:attachments':
        return hoisted.attachments
      case 'todo:attachmentThumbs':
        return {}
      case 'todo:addPastedAttachments':
        return hoisted.pastedResult
      case 'todo:addAttachments':
        return hoisted.addPathsResult
      default:
        return null
    }
  })
}))

const mesh = (chan: string): Array<{ channel: string; input: unknown }> =>
  hoisted.calls.filter((c) => c.channel === chan)

type PastedInput = { todoId: string; files: Array<{ name: string; bytes: Uint8Array }> }

/** 剪贴板里的那份"东西"：资源管理器复制的文件有真实路径，截图没有 */
const stubPaths = (paths: Map<File, string>): void => {
  ;(window as unknown as { api: unknown }).api = {
    getPathForFile: (file: File) => paths.get(file) ?? ''
  }
}

/**
 * 造一次粘贴事件（happy-dom 不会替我们造 clipboardData）
 *
 * 包在 `act` 里发：收到粘贴后组件会去取字节、调通道、刷列表 —— 那是 React 的更新，
 * 裸发会刷一屏 "not wrapped in act" 警告，把真正的失败淹掉。
 */
const paste = async (files: File[]): Promise<Event> => {
  const e = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(e, 'clipboardData', { value: { files } })
  await act(async () => {
    window.dispatchEvent(e)
  })
  return e
}

const imageFile = (name: string, type: string, body: number[]): File =>
  new File([new Uint8Array(body)], name, { type })

const ROOT = path.resolve(__dirname, '../../..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

describe('附件区粘贴上传（cce88967）', () => {
  beforeEach(() => {
    hoisted.calls.length = 0
    hoisted.attachments = []
    hoisted.pastedResult = { added: [], failed: [] }
    hoisted.addPathsResult = { added: [], failed: [] }
    stubPaths(new Map())
  })

  afterEach(() => {
    cleanup()
    delete (window as unknown as { api?: unknown }).api
  })

  it('粘一张截图：字节走新通道，名字是「粘贴图片-<时间戳>」', async () => {
    render(<TodoAttachments todoId="t1" />)

    const shot = imageFile('image.png', 'image/png', [1, 2, 3])
    const e = await paste([shot])

    await waitFor(() => expect(mesh('todo:addPastedAttachments')).toHaveLength(1))
    expect(e.defaultPrevented, '粘贴被处理了就该拦下默认行为（别把图再插到别处）').toBe(true)

    const input = mesh('todo:addPastedAttachments')[0].input as PastedInput
    expect(input.todoId).toBe('t1')
    expect(input.files).toHaveLength(1)
    expect(input.files[0].name).toMatch(/^粘贴图片-\d{8}-\d{6}\.png$/)
    expect(Array.from(input.files[0].bytes)).toEqual([1, 2, 3])
    // 走的不是"按路径"那条：截图没有路径可给
    expect(mesh('todo:addAttachments')).toHaveLength(0)

    // 挂完要重新拉一次列表（缩略图才会出现）
    await waitFor(() => expect(mesh('todo:attachments').length).toBeGreaterThan(1))
  })

  it('jpeg / 一次两张：扩展名跟着 mime 走，一次调用送两份', async () => {
    render(<TodoAttachments todoId="t1" />)

    await paste([
      imageFile('a.jpg', 'image/jpeg', [1]),
      imageFile('b.webp', 'image/webp', [2])
    ])

    await waitFor(() => expect(mesh('todo:addPastedAttachments')).toHaveLength(1))
    const input = mesh('todo:addPastedAttachments')[0].input as PastedInput
    expect(input.files).toHaveLength(2)
    expect(input.files[0].name.endsWith('.jpg')).toBe(true)
    expect(input.files[1].name.endsWith('.webp')).toBe(true)
  })

  it('资源管理器复制来的文件：走按路径那条，保留原文件名、不传字节', async () => {
    const doc = imageFile('中间报告.pdf', 'application/pdf', [7])
    stubPaths(new Map([[doc, 'C:\\somewhere\\中间报告.pdf']]))

    render(<TodoAttachments todoId="t1" />)
    await paste([doc])

    await waitFor(() => expect(mesh('todo:addAttachments')).toHaveLength(1))
    expect(mesh('todo:addAttachments')[0].input).toEqual({
      todoId: 't1',
      paths: ['C:\\somewhere\\中间报告.pdf']
    })
    expect(mesh('todo:addPastedAttachments'), '有路径就别再传一份字节').toHaveLength(0)
  })

  it('纯文字粘贴不拦：那不是附件', async () => {
    render(<TodoAttachments todoId="t1" />)

    const e = await paste([])
    expect(e.defaultPrevented, '粘一段字进输入框是常规操作，拦下来才是 bug').toBe(false)
    // 等一拍，确认没有任何通道被调用
    await new Promise((r) => setTimeout(r, 10))
    expect(hoisted.calls.filter((c) => c.channel !== 'todo:attachments')).toHaveLength(0)
  })

  it('失败要说清是哪一份、为什么', async () => {
    hoisted.pastedResult = {
      added: [],
      failed: [{ name: '粘贴图片-20261112-131500.png', reason: '附件超过 25.0 MB 上限（80.0 MB）' }]
    }
    render(<TodoAttachments todoId="t1" />)

    await paste([imageFile('image.png', 'image/png', [1])])

    const err = await screen.findByTestId('todo-attachment-error')
    expect(err.textContent).toContain('粘贴图片-20261112-131500.png')
    expect(err.textContent).toContain('超过 25.0 MB 上限')
  })

  it('源码闸门：粘贴目标是附件区里看得见的一块，附件区只在编辑时才挂', () => {
    const area = read('src/renderer/components/quick-add/TodoAttachments.tsx')
    expect(area, '要有一个明确的粘贴落点').toContain('todo-attachment-paste-zone')
    expect(area, '得告诉人按什么键').toContain('Ctrl+V')
    expect(area, '粘贴挂在 window 上，详情开着时才收得到').toContain(
      "window.addEventListener('paste', onPaste)"
    )
    expect(area, '没有文件就不该拦（纯文字粘贴要照常进输入框）').toMatch(
      /if \(!files\.length\) return/
    )

    // 附件区本身只在编辑某条事项时挂载（见 QuickAddForm）——粘贴不会跑到别的页面
    expect(read('src/renderer/components/quick-add/QuickAddForm.tsx')).toMatch(
      /editingTodoId && <TodoAttachments/
    )
  })
})
