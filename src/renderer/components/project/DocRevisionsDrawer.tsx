import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Button } from '../ui/Button'
import { Icon } from '../ui/Icon'
import { MarkdownContent } from '../ui/MarkdownContent'
import { invoke, on } from '../../lib/ipc-client'
import { diffLines, diffStats } from '../../lib/line-diff'
import { cn, formatBytes } from '../../lib/utils'
import type { ProjectDocRevisionList } from '../../types/project'

interface DocRevisionsDrawerProps {
  projectId: string
  /** 相对文档目录的路径（文档页当前打开的那一篇） */
  file: string
  open: boolean
  onClose: () => void
}

/**
 * 关联目录文档的历史抽屉（卡 `e15d1a78`）
 *
 * 列表（时间 · 体积，与磁盘上当前内容一致的那一版标「当前」）→ 选中一版看**全文**，
 * 或看它相对上一版的行级差异。
 *
 * **只读**：没有回滚、不回写磁盘 —— 外部目录的权威在磁盘（还可能是 git 工作区），
 * 产品这边只负责"改之前写的是什么"这句话答得出来。
 *
 * 文案里的 20 与主进程的 `DOC_REVISION_LIMIT` 同源（与接手说明抽屉写死 50 的做法一致）。
 */
export const DocRevisionsDrawer: React.FC<DocRevisionsDrawerProps> = ({
  projectId,
  file,
  open,
  onClose
}) => {
  const [data, setData] = useState<ProjectDocRevisionList | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [view, setView] = useState<'content' | 'diff'>('content')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await invoke('project:docRevisions', { id: projectId, file })
      setData(res)
      // 保留原选中；原选中已被修剪或首次打开时落到最新一版
      setSelectedId((cur) =>
        cur && res.revisions.some((r) => r.id === cur) ? cur : (res.revisions[0]?.id ?? null)
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : '读取文档历史失败')
    } finally {
      setLoading(false)
    }
  }, [projectId, file])

  useEffect(() => {
    if (!open) return
    setView('content')
    void load()
    return on('event:dataChanged', (event) => {
      if (event.type === 'project') void load()
    })
  }, [open, load])

  const revisions = data?.revisions ?? []
  const selectedIndex = revisions.findIndex((r) => r.id === selectedId)
  const selected = selectedIndex >= 0 ? revisions[selectedIndex] : null
  // 列表是倒序：下一个下标才是「上一版」
  const previous = selectedIndex >= 0 ? (revisions[selectedIndex + 1] ?? null) : null

  const diff = useMemo(
    () => (selected ? diffLines(previous?.body ?? '', selected.body) : []),
    [selected, previous]
  )
  const stats = useMemo(() => diffStats(diff), [diff])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[60]" role="dialog" aria-label="文档历史">
      <div className="absolute inset-0 bg-black/20" onClick={onClose} />
      <aside className="absolute right-0 top-0 bottom-0 w-drawer frosted-glass border-l border-border shadow-xl flex flex-col">
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-border shrink-0">
          <div className="min-w-0">
            <div className="text-title font-semibold text-text-primary">文档历史</div>
            <p className="mt-1 text-label text-text-secondary truncate" title={file}>
              {file}
            </p>
            <p className="mt-0.5 text-caption text-text-secondary/80">保留最近 20 版</p>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="关闭文档历史">
            <Icon name="x" size={15} />
          </Button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-5 flex flex-col gap-4">
          {loading && revisions.length === 0 ? (
            <p className="text-content text-text-secondary">加载中…</p>
          ) : error ? (
            <p className="text-content text-red-500">{error}</p>
          ) : revisions.length === 0 ? (
            <p className="text-content text-text-secondary">
              还没有记录。打开这篇文档时会存下当时的正文，之后再改、再打开，就能看到上一版。
            </p>
          ) : (
            <>
              <div className="flex flex-col gap-1.5" role="listbox" aria-label="文档版本列表">
                {revisions.map((rev) => (
                  <button
                    key={rev.id}
                    type="button"
                    role="option"
                    aria-selected={rev.id === selectedId}
                    onClick={() => setSelectedId(rev.id)}
                    className={cn(
                      'w-full text-left rounded-input border px-3 py-2 text-label transition-colors hover:bg-black/5',
                      rev.id === selectedId ? 'border-accent' : 'border-border/70'
                    )}
                  >
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="font-medium text-text-primary">
                        {new Date(rev.createdAt).toLocaleString()}
                      </span>
                      <span className="text-text-secondary">{formatBytes(rev.bytes)}</span>
                      {rev.isCurrent && (
                        <span className="rounded bg-accent/15 px-1.5 text-caption text-accent">
                          当前
                        </span>
                      )}
                      <span className="ml-auto text-caption text-text-secondary/70">
                        第 {rev.seq} 版
                      </span>
                    </span>
                  </button>
                ))}
              </div>

              {selected && (
                <section className="flex flex-col gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      variant={view === 'content' ? 'primary' : 'ghost'}
                      size="sm"
                      onClick={() => setView('content')}
                    >
                      内容
                    </Button>
                    <Button
                      variant={view === 'diff' ? 'primary' : 'ghost'}
                      size="sm"
                      onClick={() => setView('diff')}
                    >
                      与上一版的差异
                    </Button>
                    {view === 'diff' && (
                      <span className="ml-auto text-label text-text-secondary">
                        <span className="text-green-600">+{stats.added}</span>{' '}
                        <span className="text-red-500">-{stats.removed}</span>
                      </span>
                    )}
                  </div>

                  {view === 'content' ? (
                    data?.kind === 'html' ? (
                      <>
                        <p className="text-caption text-text-secondary">
                          HTML 文档按源码显示（不重渲染）。
                        </p>
                        <pre
                          className="p-4 rounded-input border border-border/70 bg-bg-card font-mono text-label leading-relaxed text-text-primary overflow-x-auto whitespace-pre-wrap break-words"
                          data-testid="doc-revision-content"
                          aria-label="版本内容"
                        >
                          {selected.body}
                        </pre>
                      </>
                    ) : (
                      <div
                        className="p-4 rounded-card border border-border/70 bg-bg-card"
                        data-testid="doc-revision-content"
                        aria-label="版本内容"
                      >
                        <MarkdownContent content={selected.body} />
                      </div>
                    )
                  ) : (
                    <div
                      className="rounded-input border border-border/70 font-mono text-label leading-relaxed overflow-x-auto"
                      data-testid="doc-revision-diff"
                      aria-label="行级差异"
                    >
                      {diff.length === 0 ? (
                        <div className="px-3 py-2 text-text-secondary">（空）</div>
                      ) : (
                        diff.map((line, index) => (
                          <div
                            key={index}
                            data-diff={line.type}
                            className={cn(
                              'px-3 whitespace-pre-wrap break-words',
                              line.type === 'add' && 'bg-green-500/15 text-green-700',
                              line.type === 'del' &&
                                'bg-red-500/15 text-red-600 line-through decoration-red-400/50',
                              line.type === 'same' && 'text-text-secondary'
                            )}
                          >
                            <span className="select-none mr-2 opacity-60">
                              {line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '}
                            </span>
                            {line.text === '' ? ' ' : line.text}
                          </div>
                        ))
                      )}
                    </div>
                  )}

                  <p className="text-caption text-text-secondary">
                    {selected.isCurrent
                      ? '这一版就是磁盘上当前的内容。'
                      : '只读历史：不会把这一版写回磁盘上的文件。'}
                  </p>
                </section>
              )}
            </>
          )}
        </div>
      </aside>
    </div>
  )
}
