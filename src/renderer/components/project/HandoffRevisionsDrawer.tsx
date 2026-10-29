import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Button } from '../ui/Button'
import { Icon } from '../ui/Icon'
import { invoke, on } from '../../lib/ipc-client'
import { diffLines, diffStats } from '../../lib/line-diff'
import { ownerLabel } from '../../lib/todo-filter'
import { useUIStore } from '../../stores/ui.store'
import { useSettingsStore } from '../../stores/settings.store'
import { cn } from '../../lib/utils'
import type { HandoffRevision } from '../../types/project'

interface HandoffRevisionsDrawerProps {
  projectId: string
  open: boolean
  onClose: () => void
}

/**
 * 接手说明修订历史抽屉（36b44adb）
 *
 * 列表（时间 · 作者 · 种类，最新一版标「当前」）→ 选中一版看与上一版的行级差异
 * → 非当前版可「回滚到这一版」。回滚 = 把该版写成**新的一次保存**，不删中间版本，
 * 所以回滚错了还能再回滚回来。
 */
export const HandoffRevisionsDrawer: React.FC<HandoffRevisionsDrawerProps> = ({
  projectId,
  open,
  onClose
}) => {
  const showToast = useUIStore((s) => s.showToast)
  const settings = useSettingsStore((s) => s.settings)
  const [revisions, setRevisions] = useState<HandoffRevision[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [rollingBack, setRollingBack] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const list = await invoke('project:handoffRevisions', { id: projectId })
      setRevisions(list)
      // 保留原选中；原选中已被修剪或首次打开时落到最新一版
      setSelectedId((cur) => (cur && list.some((r) => r.id === cur) ? cur : (list[0]?.id ?? null)))
    } catch (err) {
      setError(err instanceof Error ? err.message : '读取修订历史失败')
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    if (!open) return
    void load()
    return on('event:dataChanged', (event) => {
      if (event.type === 'project') void load()
    })
  }, [open, load])

  const selectedIndex = revisions.findIndex((r) => r.id === selectedId)
  const selected = selectedIndex >= 0 ? revisions[selectedIndex] : null
  // 列表是倒序：下一个下标才是「上一版」
  const previous = selectedIndex >= 0 ? (revisions[selectedIndex + 1] ?? null) : null

  const diff = useMemo(
    () => (selected ? diffLines(previous?.body ?? '', selected.body) : []),
    [selected, previous]
  )
  const stats = useMemo(() => diffStats(diff), [diff])

  const rollback = async () => {
    if (!selected || selected.isCurrent || rollingBack) return
    setRollingBack(true)
    try {
      const result = await invoke('project:handoffRollback', {
        id: projectId,
        revisionId: selected.id
      })
      showToast(
        result.changed
          ? `已回滚到第 ${selected.seq} 版（写成了新的一次保存）`
          : '该版内容与当前接手说明相同，未写入新修订'
      )
      setSelectedId(null)
      await load()
    } catch (err) {
      showToast(err instanceof Error ? `回滚失败：${err.message}` : '回滚失败')
    } finally {
      setRollingBack(false)
    }
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[60]" role="dialog" aria-label="接手说明修订历史">
      <div className="absolute inset-0 bg-black/20" onClick={onClose} />
      <aside className="absolute right-0 top-0 bottom-0 w-drawer frosted-glass border-l border-border shadow-xl flex flex-col">
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-border shrink-0">
          <div className="min-w-0">
            <div className="text-title font-semibold text-text-primary">接手说明 · 修订历史</div>
            <p className="mt-1 text-label text-text-secondary">
              保留最近 50 个修订版本
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="关闭修订历史">
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
              暂无修订记录
            </p>
          ) : (
            <>
              <div className="flex flex-col gap-1.5" role="listbox" aria-label="修订列表">
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
                      <span className="text-text-secondary">
                        {ownerLabel(rev.author, settings?.humanName)}
                      </span>
                      <span className="rounded bg-surface-muted px-1.5 text-caption text-text-secondary">
                        {rev.kind === 'rollback'
                          ? `回滚${rev.sourceSeq ? `自第 ${rev.sourceSeq} 版` : ''}`
                          : '保存'}
                      </span>
                      {rev.isCurrent && (
                        <span className="rounded bg-accent/15 px-1.5 text-caption text-accent">当前</span>
                      )}
                      <span className="ml-auto text-caption text-text-secondary/70">第 {rev.seq} 版</span>
                    </span>
                  </button>
                ))}
              </div>

              {selected && (
                <section className="flex flex-col gap-2">
                  <h3 className="text-content font-medium text-text-primary">
                    {previous ? '与上一版的差异' : '内容（最早保留的一版）'}
                    <span className="ml-2 text-label text-text-secondary">
                      <span className="text-green-600">+{stats.added}</span>{' '}
                      <span className="text-red-500">-{stats.removed}</span>
                    </span>
                  </h3>
                  <div
                    className="rounded-input border border-border/70 font-mono text-label leading-relaxed overflow-x-auto"
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
                            line.type === 'del' && 'bg-red-500/15 text-red-600 line-through decoration-red-400/50',
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
                  <div className="flex items-center gap-3 pt-1">
                    {selected.isCurrent ? (
                      <span className="text-label text-text-secondary">这是当前版本</span>
                    ) : (
                      <Button variant="primary" size="sm" onClick={() => void rollback()} disabled={rollingBack}>
                        {rollingBack ? '回滚中…' : '回滚到这一版（写成新的一次保存）'}
                      </Button>
                    )}
                  </div>
                </section>
              )}
            </>
          )}
        </div>
      </aside>
    </div>
  )
}
