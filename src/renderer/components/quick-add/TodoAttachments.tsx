import React, { useCallback, useEffect, useState } from 'react'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { Icon } from '../ui/Icon'
import { invoke } from '../../lib/ipc-client'
import { cn } from '../../lib/utils'
import type { TodoAttachment } from '../../types/todo'

/**
 * 事项附件（schema v50，主用户 2026-11-11 提需求）
 *
 * ── 它解决什么 ──
 *
 * 交付里最该被看见的三样东西 —— 截图、日志、产物 —— 此前只能"放到某个目录、
 * 把路径贴在评论里"：对方要自己去找、自己去开，而那个路径过几天就不一定还在。
 * 附件是**卡片自己的东西**，跟着卡片活。
 *
 * ── 两条边界（都在主进程落实，这里只是消费）──
 *
 * 1. **复制，不是引用**：文件被复制进数据目录，源文件移走删掉都不影响它。
 *    与「项目关联文档目录」相反 —— 那份是引用外部目录、磁盘为准、可能是 git 工作区。
 *    一个跟着卡片活，一个跟着磁盘活，判据是**谁是权威**。
 * 2. **图片不走 `file://`**：生产 CSP 是 `img-src 'self' data: blob:`，渲染层引不到
 *    磁盘上的图；缩略图与预览大图都由主进程转成 `data:` URL 再送进来。
 *
 * ── 交互 ──
 *
 * 图片点一下开预览（大图另取，列表里只放缩略图，窄右栏不被几十张原图拖住）；
 * 其余文件点一下交给系统默认程序（和「打开文档目录」同一条路）。
 */

/** 文件大小文案：够看就行，不追求精确 */
const formatSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** 非图片附件在格子里显示的短标签（PDF / ZIP / LOG…） */
const extLabel = (item: TodoAttachment): string =>
  (item.ext.replace('.', '') || '文件').toUpperCase().slice(0, 4)

/** 失败信息里只报文件名，整条路径太长会把这一行撑爆 */
const baseName = (p: string): string => p.split(/[\\/]/).pop() || p

const errText = (err: unknown): string => {
  const raw = err instanceof Error ? err.message : String(err)
  // IPCError 的前缀是通道名，对用户没有意义
  return raw.replace(/^\[IPC\][^:]*:\s*/, '')
}

interface TodoAttachmentsProps {
  todoId: string
}

export const TodoAttachments: React.FC<TodoAttachmentsProps> = ({ todoId }) => {
  const [items, setItems] = useState<TodoAttachment[]>([])
  const [thumbs, setThumbs] = useState<Record<string, string>>({})
  const [preview, setPreview] = useState<TodoAttachment | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [pendingRemove, setPendingRemove] = useState<TodoAttachment | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const list = await invoke('todo:attachments', { todoId })
      setItems(list)
      const imageIds = list.filter((a) => a.kind === 'image').map((a) => a.id)
      setThumbs(imageIds.length ? await invoke('todo:attachmentThumbs', { ids: imageIds }) : {})
    } catch (err) {
      setError(errText(err))
    }
  }, [todoId])

  useEffect(() => {
    void load()
  }, [load])

  const addFiles = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await invoke('todo:pickAttachments', { todoId })
      if (res && res.failed.length) {
        setError(res.failed.map((f) => `${baseName(f.path)}：${f.reason}`).join('；'))
      }
      await load()
    } catch (err) {
      setError(errText(err))
    } finally {
      setBusy(false)
    }
  }

  const openExternal = async (item: TodoAttachment) => {
    setError(null)
    try {
      await invoke('todo:openAttachment', { id: item.id })
    } catch (err) {
      setError(errText(err))
    }
  }

  const openPreview = async (item: TodoAttachment) => {
    setError(null)
    setPreview(item)
    setPreviewUrl(null)
    try {
      const res = await invoke('todo:attachmentPreview', { id: item.id })
      setPreviewUrl(res.dataUrl)
    } catch (err) {
      setError(errText(err))
      setPreview(null)
    }
  }

  const confirmRemove = async () => {
    if (!pendingRemove) return
    setError(null)
    try {
      await invoke('todo:removeAttachment', { id: pendingRemove.id })
      setPendingRemove(null)
      await load()
    } catch (err) {
      setError(errText(err))
      setPendingRemove(null)
    }
  }

  return (
    <div
      data-testid="todo-attachments"
      className="flex flex-col gap-2 pt-3 border-t border-border"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-caption text-text-secondary">
          附件{items.length > 0 ? ` ${items.length}` : ''}
        </span>
        <Button
          variant="ghost"
          size="sm"
          data-testid="todo-attachment-add"
          disabled={busy}
          onClick={() => void addFiles()}
          title="选图片或文件挂到这条事项上（会复制一份到数据目录）"
        >
          <Icon name="plus" size={13} />
          {busy ? '处理中…' : '图片 / 文件'}
        </Button>
      </div>

      {error && (
        <p data-testid="todo-attachment-error" className="text-caption text-danger leading-relaxed">
          {error}
        </p>
      )}

      {items.length === 0 ? (
        <p className="text-caption text-text-secondary/70">
          还没有附件。截图、日志、产物都可以挂在这里，图片能直接看，文件一点用系统程序打开。
        </p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {items.map((item) => (
            <li key={item.id} className="w-24 flex flex-col gap-1">
              <div className="relative">
                <button
                  type="button"
                  data-testid={`todo-attachment-item-${item.id}`}
                  onClick={() => void (item.kind === 'image' ? openPreview(item) : openExternal(item))}
                  title={
                    item.kind === 'image'
                      ? `预览图片：${item.name}`
                      : `用系统默认程序打开：${item.name}`
                  }
                  aria-label={
                    item.kind === 'image'
                      ? `预览图片 ${item.name}`
                      : `用系统默认程序打开 ${item.name}`
                  }
                  className={cn(
                    'w-24 h-24 rounded-card border border-border overflow-hidden',
                    'bg-surface-subtle flex items-center justify-center cursor-pointer',
                    'transition-colors hover:border-accent/60'
                  )}
                >
                  {item.kind === 'image' && thumbs[item.id] ? (
                    <img
                      src={thumbs[item.id]}
                      alt={item.name}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <span className="flex flex-col items-center gap-1 text-text-secondary">
                      <Icon name="fileText" size={20} />
                      <span className="text-caption font-mono">{extLabel(item)}</span>
                    </span>
                  )}
                </button>
                <button
                  type="button"
                  data-testid={`todo-attachment-remove-${item.id}`}
                  aria-label={`移除附件 ${item.name}`}
                  title="移除这个附件"
                  onClick={() => setPendingRemove(item)}
                  className={cn(
                    'absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full',
                    'flex items-center justify-center',
                    'bg-bg-card border border-border text-text-secondary',
                    'transition-colors hover:text-danger hover:border-danger/50 cursor-pointer'
                  )}
                >
                  <Icon name="x" size={11} />
                </button>
              </div>
              <span className="text-caption text-text-primary truncate" title={item.name}>
                {item.name}
              </span>
              <span className="text-caption text-text-secondary/70">{formatSize(item.bytes)}</span>
            </li>
          ))}
        </ul>
      )}

      {/* 图片预览：大图按需取（列表里只有缩略图） */}
      <Dialog open={preview !== null} onClose={() => setPreview(null)}>
        <div className="flex flex-col gap-3" data-testid="todo-attachment-preview">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-body font-medium text-text-primary truncate">
              {preview?.name ?? ''}
            </h3>
            <button
              type="button"
              data-testid="todo-attachment-preview-close"
              aria-label="关闭预览"
              title="关闭（Esc）"
              onClick={() => setPreview(null)}
              className={cn(
                'shrink-0 w-6 h-6 flex items-center justify-center rounded-button',
                'text-text-secondary transition-colors hover:bg-black/5 hover:text-text-primary cursor-pointer'
              )}
            >
              <Icon name="x" size={13} />
            </button>
          </div>
          <div className="flex items-center justify-center min-h-32 bg-surface-subtle rounded-card border border-border p-2">
            {previewUrl ? (
              <img
                data-testid="todo-attachment-preview-image"
                src={previewUrl}
                alt={preview?.name ?? ''}
                className="max-w-full max-h-96 object-contain"
              />
            ) : (
              <span className="text-label text-text-secondary py-8">读取中…</span>
            )}
          </div>
          {preview && (
            <div className="flex items-center justify-between gap-2">
              <span className="text-caption text-text-secondary">{formatSize(preview.bytes)}</span>
              <Button variant="ghost" size="sm" onClick={() => void openExternal(preview)}>
                <Icon name="fileText" size={13} />
                用系统程序打开
              </Button>
            </div>
          )}
        </div>
      </Dialog>

      {/* 移除要先问一句：附件是复制进来的，删了得重新找源文件 */}
      <Dialog open={pendingRemove !== null} onClose={() => setPendingRemove(null)}>
        <div className="flex flex-col gap-3" role="alertdialog" aria-labelledby="attachment-remove-title">
          <h3 id="attachment-remove-title" className="text-body font-medium text-text-primary">
            移除这个附件？
          </h3>
          <p className="text-label leading-relaxed text-text-secondary">
            「{pendingRemove?.name}」的副本会从数据目录里删掉，原文件不受影响。
          </p>
          <div className="flex items-center justify-end gap-2 pt-1">
            <Button variant="ghost" size="sm" onClick={() => setPendingRemove(null)}>
              取消
            </Button>
            <Button
              variant="danger"
              size="sm"
              data-testid="todo-attachment-confirm-remove"
              onClick={() => void confirmRemove()}
            >
              移除
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  )
}
