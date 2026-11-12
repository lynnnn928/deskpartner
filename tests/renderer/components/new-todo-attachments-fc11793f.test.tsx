import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import React from 'react'
import fs from 'node:fs'
import path from 'node:path'
import {
  fitPickedFiles,
  intakeFiles,
  pastedImageName,
  pendingTotalBytes,
  formatSize,
  type PendingAttachment
} from '../../../src/renderer/lib/attachment-intake'
import { PendingAttachments } from '../../../src/renderer/components/quick-add/PendingAttachments'
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_TOTAL_BYTES } from '../../../src/renderer/lib/constants'

/**
 * 新建事项时的待挂附件（卡 `fc11793f`）
 *
 * 分三层验，缺一不可：
 * ① **收东西**（纯函数）：有路径的走路径、截图走字节、超限/空内容当场说不收 —— 逐条真跑；
 * ② **那块界面**：名字、大小、合计与上限、移除、错误文字都真渲染一遍；
 * ③ **接线**（源码闸门）：附件区**默认就在**（不必先点开）、新建模式的粘贴监听、
 *    提交顺序（先建后挂）、挂不上就不关卡片、待挂清单不进草稿、"挑了不挂"这条通道
 *    不许偷偷落库 —— 这些错都不报错，跑起来才看得见。
 */

const ROOT = path.resolve(__dirname, '../../..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n')

/** 真 File：size 与读出来的字节自洽 */
const fileOf = (body: number[], name: string, type: string): File =>
  new File([new Uint8Array(body)], name, { type })

/**
 * 只报"声明的体积"的假 File（总量与超限用例专用）
 *
 * 收东西那一步**先按 size 判、再读字节**，所以这里不必真分配几十 MB；
 * arrayBuffer 一旦被调用就说明判据顺序错了 —— 直接抛。
 */
const fakeSized = (name: string, type: string, size: number): File =>
  ({
    name,
    type,
    size,
    arrayBuffer: async () => {
      throw new Error('只该判体积的文件不该被读进内存')
    }
  }) as unknown as File

const stubPaths = (map: Map<unknown, string>): void => {
  ;(window as unknown as { api: unknown }).api = {
    getPathForFile: (file: File) => map.get(file) ?? ''
  }
}

describe('新建事项时的待挂附件（fc11793f）', () => {
  beforeEach(() => {
    stubPaths(new Map())
  })
  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
    delete (window as unknown as { api?: unknown }).api
  })

  describe('① 收东西：分流、命名、当场拦', () => {
    it('资源管理器复制来的文件走路径（不读字节、保留原名）', async () => {
      const doc = fileOf([1, 2], '交付说明.pdf', 'application/pdf')
      stubPaths(new Map([[doc, 'C:\\docs\\交付说明.pdf']]))

      const { items, problems } = await intakeFiles([doc])
      expect(problems).toEqual([])
      expect(items).toEqual([
        { kind: 'path', path: 'C:\\docs\\交付说明.pdf', name: '交付说明.pdf', size: 2 }
      ])
    })

    it('截图走字节，名字是「粘贴图片-<时间戳>」且扩展名跟着 mime', async () => {
      const shot = fileOf([1, 2, 3], 'image.png', 'image/jpeg')
      const { items, problems } = await intakeFiles([shot])

      expect(problems).toEqual([])
      expect(items).toHaveLength(1)
      const item = items[0] as Extract<PendingAttachment, { kind: 'bytes' }>
      expect(item.kind).toBe('bytes')
      expect(item.name).toMatch(/^粘贴图片-\d{8}-\d{6}\.jpg$/)
      expect(Array.from(item.bytes)).toEqual([1, 2, 3])
      expect(item.size).toBe(3)
    })

    it('超 25 MB 当场说不收（路径与字节两条都拦），清单里不留', async () => {
      const huge = fakeSized('大文件.log', 'text/plain', MAX_ATTACHMENT_BYTES + 1)
      stubPaths(new Map([[huge, 'C:\\docs\\大文件.log']]))
      const bigShot = fakeSized('image.png', 'image/png', MAX_ATTACHMENT_BYTES + 1)

      const mixed = await intakeFiles([huge])
      expect(mixed.items).toEqual([])
      expect(mixed.problems[0]).toContain('超过 25.0 MB 上限')
      expect(mixed.problems[0]).toContain('大文件.log')

      // 字节那条的判据在主进程给字节之后（这里用同一份常量在前端先拦一次）
      const shotResult = await intakeFiles([bigShot])
      expect(shotResult.items).toEqual([])
      expect(shotResult.problems[0]).toContain('超过 25.0 MB 上限')
    })

    it('非图片的剪贴板内容不收也不报错（纯文字粘贴照旧）', async () => {
      const textish = fileOf([1], 'x', 'text/plain')
      const { items, problems } = await intakeFiles([textish])
      expect(items).toEqual([])
      expect(problems).toEqual([])
    })

    it('总量：这张卡已经占了多少，加这一份会不会超（单份没超也照样拦）', async () => {
      // 单份 20 MB 不超 25 MB，但已经占了 190 MB —— 加起来越过 200 MB 那条线
      const doc = fakeSized('补一句.log', 'text/plain', 20 * 1024 * 1024)
      stubPaths(new Map([[doc, 'C:\\docs\\补一句.log']]))

      const { items, problems } = await intakeFiles([doc], {
        usedBytes: MAX_ATTACHMENT_TOTAL_BYTES - 10 * 1024 * 1024
      })
      expect(items).toEqual([])
      expect(problems).toHaveLength(1)
      expect(problems[0]).toContain('待挂的附件总量超过 200.0 MB 上限')
      expect(problems[0]).toContain('已有 190.0 MB，加这一份会到 210.0 MB')
      expect(problems[0]).toContain('补一句.log')

      // 同样的这一份，余量够就照收
      const roomy = await intakeFiles([doc], { usedBytes: 0 })
      expect(roomy.items.map((i) => i.name)).toEqual(['补一句.log'])
      expect(roomy.problems).toEqual([])
    })

    it('同一批里前面的几份也算进总量（不然一批就能把上限撑破）', async () => {
      const a = fakeSized('第一份.log', 'text/plain', 20 * 1024 * 1024)
      const b = fakeSized('第二份.log', 'text/plain', 20 * 1024 * 1024)
      stubPaths(
        new Map([
          [a, 'C:\\docs\\a.log'],
          [b, 'C:\\docs\\b.log']
        ])
      )

      const { items, problems } = await intakeFiles([a, b], {
        usedBytes: MAX_ATTACHMENT_TOTAL_BYTES - 30 * 1024 * 1024
      })
      expect(items.map((i) => i.name)).toEqual(['第一份.log'])
      expect(problems).toHaveLength(1)
      expect(problems[0]).toContain('已有 190.0 MB，加这一份会到 210.0 MB')
      expect(problems[0]).toContain('第二份.log')
    })

    it('挑了没挂的那条路（文件对话框只回实况）也按余量筛，能挂的照留', () => {
      const picked = [
        { path: 'C:\\docs\\a.log', name: 'a.log', size: 20 * 1024 * 1024, problem: null },
        { path: 'C:\\docs\\b.log', name: 'b.log', size: 20 * 1024 * 1024, problem: null },
        { path: 'C:\\docs\\坏.log', name: '坏.log', size: 0, problem: '坏.log：附件超过 25.0 MB 上限（80.0 MB）' }
      ]

      const { items, problems } = fitPickedFiles(picked, MAX_ATTACHMENT_TOTAL_BYTES - 30 * 1024 * 1024)
      expect(items.map((i) => i.name)).toEqual(['a.log'])
      expect(problems).toHaveLength(2)
      expect(problems[0]).toContain('已有 190.0 MB，加这一份会到 210.0 MB')
      expect(problems[1]).toContain('超过 25.0 MB 上限')

      // 不传已用量 = 只判单份（详情里那块走的是主进程那道权威判据）
      expect(fitPickedFiles([picked[0]]).items).toHaveLength(1)
    })

    it('空字节与大小文案', async () => {
      const empty = fileOf([], 'image.png', 'image/png')
      const { items, problems } = await intakeFiles([empty])
      expect(items).toEqual([])
      expect(problems[0]).toContain('没有字节')

      expect(formatSize(512)).toBe('512 B')
      expect(formatSize(2048)).toBe('2 KB')
      expect(formatSize(3 * 1024 * 1024)).toBe('3.0 MB')
      expect(pastedImageName('image/webp')).toMatch(/^粘贴图片-\d{8}-\d{6}\.webp$/)
    })
  })

  describe('② 那块界面', () => {
    const items: PendingAttachment[] = [
      { kind: 'path', path: 'C:\\docs\\交付说明.pdf', name: '交付说明.pdf', size: 2048 },
      { kind: 'bytes', name: '粘贴图片-20261112-131500.png', bytes: new Uint8Array([1]), size: 1024 }
    ]

    it('列出名字与大小、合计与上限，✕ 能移除对应的那一份', () => {
      const onRemove = vi.fn()
      render(
        <PendingAttachments
          items={items}
          problem={null}
          busy={false}
          onPick={() => undefined}
          onRemove={onRemove}
        />
      )

      expect(screen.getByText('交付说明.pdf')).toBeTruthy()
      expect(screen.getByText('2 KB')).toBeTruthy()
      expect(screen.getByText('粘贴图片-20261112-131500.png')).toBeTruthy()
      expect(screen.getByText('1 KB')).toBeTruthy()
      // 照实说：此刻它们还没挂上；合计与上限也摆在明处（2048 + 1024 = 3 KB）
      const block = screen.getByTestId('pending-attachments').textContent ?? ''
      expect(block).toContain('附件 2 · 共 3 KB')
      expect(block).toContain('上限 200.0 MB')
      expect(block).toContain('保存时一起挂上')
      expect(pendingTotalBytes(items)).toBe(3072)

      fireEvent.click(screen.getAllByTestId('pending-attachment-remove')[1])
      expect(onRemove).toHaveBeenCalledWith(1)
    })

    it('空清单时粘贴那一行照旧在（不必先点开），有问题时把问题原样摆出来', () => {
      const { rerender } = render(
        <PendingAttachments
          items={[]}
          problem={null}
          busy={false}
          onPick={() => undefined}
          onRemove={() => undefined}
        />
      )
      // 默认就在：新建卡片上一进来就能粘，没有"先点 + 附件"这一步
      expect(screen.getByTestId('pending-attachment-paste-zone').textContent).toContain('Ctrl+V')
      expect(screen.getByTestId('pending-attachment-paste-zone').textContent).toContain('保存时一起挂上')
      expect(screen.getByTestId('pending-attachments').textContent).toContain('上限 200.0 MB')
      expect(screen.getByTestId('pending-attachments').textContent).not.toContain('· 共')

      rerender(
        <PendingAttachments
          items={[]}
          problem={'大文件.log：附件超过 25.0 MB 上限（80.0 MB）'}
          busy={false}
          onPick={() => undefined}
          onRemove={() => undefined}
        />
      )
      expect(screen.getByTestId('pending-attachment-error').textContent).toContain('超过 25.0 MB 上限')
    })

    it('「图片 / 文件」按钮走的是 onPick', () => {
      const onPick = vi.fn()
      render(
        <PendingAttachments items={[]} problem={null} busy={false} onPick={onPick} onRemove={() => undefined} />
      )
      fireEvent.click(screen.getByTestId('pending-attachment-add'))
      expect(onPick).toHaveBeenCalledTimes(1)
    })
  })

  describe('③ 接线（源码闸门）', () => {
    const form = read('src/renderer/components/quick-add/QuickAddForm.tsx')

    it('新建模式的粘贴监听：编辑时交给附件区自己听，别两处都收', () => {
      const listenerAt = form.indexOf("window.addEventListener('paste', onPaste)")
      expect(listenerAt, '新建模式要能 Ctrl+V').toBeGreaterThan(0)
      const guardAt = form.lastIndexOf('if (editingTodoId) return', listenerAt)
      expect(guardAt, '编辑模式下这块归附件区管').toBeGreaterThan(0)
      expect(listenerAt - guardAt, '守卫要在同一个 effect 里、紧挨着').toBeLessThan(400)
      expect(form, '没有文件就不该拦（纯文字粘贴照常进标题框）').toMatch(/if \(!files\.length\) return/)
    })

    it('提交顺序：先建事项、再挂附件（附件挂在 id 上，反过来做不到）', () => {
      const createAt = form.indexOf('const created = await createTodo(')
      const attachAt = form.indexOf('await attachPending(createdId')
      expect(createAt).toBeGreaterThan(0)
      expect(attachAt).toBeGreaterThan(createAt)
    })

    it('附件没挂上就不关卡片，也不静默丢掉失败清单', () => {
      expect(form, '有失败就别关').toContain('if (!failed.length) closeDetail()')
      expect(form, '失败要留在屏幕上').toContain('data-testid="orphan-attachments"')
      expect(form, '只重挂剩下的那几份').toContain('retryOrphanAttachments')
      const retry = form.slice(form.indexOf('const retryOrphanAttachments'), form.indexOf('const handleSubmit'))
      expect(retry, '重试用的是同一个 attachPending').toContain('attachPending(orphan.todoId')
      expect(retry, '只把没挂上的放回清单').toContain('setPendingAttachments(failed.map((f) => f.item))')
    })

    it('待挂清单不进草稿（文件字节不进 sessionStorage）', () => {
      const start = form.indexOf('const formNow: QuickAddDraft = {')
      const end = form.indexOf('}', start)
      const draftShape = form.slice(start, end)
      expect(draftShape).not.toContain('pending')
      expect(draftShape).not.toContain('Attachments')
      expect(form, '落草稿的仍只有表单字段').toContain('writeQuickAddDraft(routeParams, formNow)')
    })

    it('选文件走的是"挑了不挂"的那条通道，且这块**默认就在**（不必先点开）', () => {
      expect(form).toContain("invoke('todo:pickFiles')")
      const blockAt = form.indexOf('<PendingAttachments')
      expect(blockAt).toBeGreaterThan(0)
      const guardAt = form.lastIndexOf('!editingTodoId && (', blockAt)
      expect(guardAt, '这块只在新建模式渲染').toBeGreaterThan(0)
      // 主用户 2026-11-12：新建时直接就能传，不要"先点 + 附件"这一步
      expect(form, '不该再有"先展开附件"的那个开关').not.toContain('attachOpen')
      expect(form, '入口钮也该没了').not.toContain('pending-attachment-open')
      expect(form, '编辑模式的附件区仍是另一块').toContain(
        '{editingTodoId && <TodoAttachments todoId={editingTodoId} />}'
      )
    })

    it('总量上限两处都接上了：渲染层先算，主进程落盘前再判（那才是权威）', () => {
      expect(form, '把待挂清单的合计递进去当已用量').toContain(
        'intakeFiles(files, { usedBytes: attachedBytes })'
      )
      expect(form, '挑了没挂的那条路也按余量筛').toContain('fitPickedFiles(picked, attachedBytes)')
      expect(form).toContain('pendingTotalBytes(pendingAttachments)')

      const repo = read('src/main/database/attachment.repository.ts')
      expect(repo, '复制之前先取一次已用体积').toContain('let usedBytes = this.totalBytes(todoId)')
      expect(repo, '同一批里每成功一份就累加（否则一批就能撑破）').toContain('usedBytes += meta.bytes')
      expect(repo).toContain('storeAttachmentFile({ dataDir, todoId, srcPath: src, usedBytes })')

      const file = read('src/main/lib/attachments.ts')
      expect(file, '总量也在复制之前判').toContain(
        'attachmentTotalTooLargeReason(opts.usedBytes, stat.size, path.basename(srcPath))'
      )
      expect(file, '不传已用量 = 只判单份（老调用方不受影响）').toContain('opts.usedBytes !== undefined')
    })

    it('主进程那条通道挑了不挂：handler 里不许出现入库动作', () => {
      const ipc = read('src/main/ipc.ts')
      const start = ipc.indexOf("ipcMain.handle('todo:pickFiles'")
      const end = ipc.indexOf('ipcMain.handle(', start + 10)
      const handler = ipc.slice(start, end)
      expect(start).toBeGreaterThan(0)
      expect(handler, '挑完就挂就等于把两条路合并了（新建时没有 id 可挂）').not.toContain('addAttachments(')
      expect(handler).not.toContain('attachmentRepo.add')
      expect(handler, '上限当场判一次').toContain('attachmentTooLargeReason')
    })
  })
})
