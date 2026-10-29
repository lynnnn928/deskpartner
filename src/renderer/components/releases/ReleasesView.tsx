import React, { useEffect, useMemo, useState } from 'react'
import { invoke } from '../../lib/ipc-client'
import { useProjectStore } from '../../stores/project.store'
import { useUIStore } from '../../stores/ui.store'
import { useTodoStore } from '../../stores/todo.store'
import { cn } from '../../lib/utils'
import { Button } from '../ui/Button'
import { TodoStatusPill } from '../ui/Badge'
import { ReleaseDeleteDialog } from './ReleaseDeleteDialog'
import { friendlyReleaseDeleteError, stripIpcPrefix } from '../../lib/release-delete'
import type { Release, ReleaseDetail } from '../../types/release'
import type { TodoStatus } from '../../types/enums'

/**
 * 版本视图（1.0.73，主用户 10-07 提的「版本应该是一个对象」）
 *
 * ## 这一页回答什么
 *
 * 主用户 09-29 提过两个问题：「我现在既不清楚你当前版本准备处理哪些问题，
 * 也不知道发布后具体解决了哪些问题」。当时加的 `fixed_in_version` 只答了一半 ——
 * 它把"事项"和"版本"连起来了，但**版本自己不是个东西**：
 * 界面上只有一堆散落的卡片各标着版本号，没有一个地方能看见"1.0.72 这一版做了什么"。
 *
 * 这一页就是"版本"这个对象在界面上的样子：左边是登记过的版本（新发布在前），
 * 右边是选中那一版的内容 —— 它讲了什么、解决了哪几条、那些卡现在什么状态。
 *
 * ## 为什么"关联卡片"是派生的
 *
 * 卡片的版本号写在 `todos.fixed_in_version` 上（它自己的事实），
 * 这里只是按版本号聚合出来。**不另存一份关联** —— 存了就一定会和卡片本身对不上，
 * 而"对不上"这种错不会报错，只会安静地显示错的清单。
 */
export const ReleasesView: React.FC<{ projectId?: string | null; onOpenItems?: () => void }> = ({ projectId: scopedProjectId = null, onOpenItems }) => {
  const { projects } = useProjectStore()
  const { todos } = useTodoStore()
  const { setFilterFixedIn, setMainView, enterProject, setWorkItemScope } = useUIStore()
  const projectId = scopedProjectId
  const scopedTodos = projectId ? todos.filter((todo) => todo.projectId === projectId) : todos

  const [releases, setReleases] = useState<Release[]>([])
  /**
   * 选中哪一版：**(项目, 版本号)** 二元组，不是版本号 ——
   * 跨项目同名版本是常态（a2ea95f8），只存版本号会把「知彼的 1.0.76」
   * 和「DeskPartner 的 1.0.76」混成一个。
   */
  const [selected, setSelected] = useState<{ projectId: string; version: string } | null>(null)
  const [detail, setDetail] = useState<ReleaseDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [deleteOpen, setDeleteOpen] = useState(false)
  /** 解除关联事项后要重新读取详情，递增即可触发 */
  const [detailRefresh, setDetailRefresh] = useState(0)

  const load = async () => {
    setLoading(true)
    try {
      const list = (await invoke('release:list', projectId ? { projectId } : {})) as Release[]
      setReleases(list)
      setSelected((prev) => {
        const valid = prev && list.some((item) => item.projectId === prev.projectId && item.version === prev.version)
        return valid ? prev : list[0] ? { projectId: list[0].projectId, version: list[0].version } : null
      })
    } catch {
      setReleases([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [projectId])

  useEffect(() => {
    if (!selected) {
      setDetail(null)
      return
    }
    let cancelled = false
    void (async () => {
      try {
        // 按 (项目, 版本号) 定位 —— 少传 projectId 会静默查不到（invoke 不做类型检查）
        const d = (await invoke('release:detail', {
          projectId: selected.projectId,
          version: selected.version
        })) as ReleaseDetail | null
        if (!cancelled) setDetail(d)
      } catch {
        if (!cancelled) setDetail(null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [selected, detailRefresh])

  const projectName = (id: string | null): string | null =>
    id ? (projects.find((p) => p.id === id)?.name ?? null) : null

  /**
   * 事项状态的中文名与色调
   *
   * 与看板列同名 —— 这里再用一套说法（"已完成/完成/做完"）会让人以为是另一个概念。
   */
  const statusLabel: Record<string, string> = {
    proposed: '待确认',
    todo: '待办',
    in_progress: '进行中',
    suspended: '挂起',
    awaiting_review: '待验收',
    done: '已完成',
    discarded: '已废弃'
  }

  const orphanCount = useMemo(() => {
    if (!detail) return 0
    return detail.todos.length
  }, [detail])

  /** 到事项页查看这一版收口的事项：先建项目上下文，再放开状态范围，否则已完成事项被默认范围藏掉。 */
  const viewItemsInBoard = () => {
    if (!detail) return
    enterProject(detail.projectId)
    onOpenItems?.()
    setWorkItemScope('all')
    setFilterFixedIn(detail.version)
    setMainView('board')
  }

  const confirmDelete = async () => {
    if (!detail) return
    try {
      await invoke('release:delete', { projectId: detail.projectId, version: detail.version })
    } catch (err) {
      throw new Error(friendlyReleaseDeleteError(err))
    }
    setDeleteOpen(false)
    setSelected(null)
    setDetail(null)
    await load()
  }

  const unlinkTodo = async (todoId: string) => {
    try {
      await useTodoStore.getState().updateTodo({ id: todoId, fixedInVersion: null })
    } catch (err) {
      throw new Error(`解除失败：${err instanceof Error ? stripIpcPrefix(err.message) : '未知错误'}`)
    }
    setDetailRefresh((n) => n + 1)
  }

  const unlinkAll = async () => {
    if (!detail) return
    let done = 0
    for (const t of detail.todos) {
      try {
        await useTodoStore.getState().updateTodo({ id: t.id, fixedInVersion: null })
        done += 1
      } catch (err) {
        setDetailRefresh((n) => n + 1)
        const reason = err instanceof Error ? stripIpcPrefix(err.message) : '未知错误'
        throw new Error(`已解除 ${done} 条，「${t.title}」解除失败：${reason}`)
      }
    }
    setDetailRefresh((n) => n + 1)
  }

  /**
   * 项目页只允许出现当前项目的版本。
   * release:list 已经按 projectId 限定；这里再做一次前端防线，避免 IPC
   * 意外回传跨项目同名版本时污染当前项目的版本页。
   */
  const scopedReleases = useMemo(
    () => (projectId ? releases.filter((release) => release.projectId === projectId) : releases),
    [releases, projectId]
  )

  const grouped = useMemo(() => {
    const byProject = new Map<string | null, Release[]>()
    for (const r of scopedReleases) {
      const key = r.projectId ?? null
      const arr = byProject.get(key)
      if (arr) arr.push(r)
      else byProject.set(key, [r])
    }
    const order: Array<{
      projectId: string | null
      name: string | null
      color: string | null
      items: Release[]
    }> = []
    for (const p of projects) {
      const items = byProject.get(p.id)
      if (items?.length) order.push({ projectId: p.id, name: p.name, color: p.color, items })
    }
    const rest = byProject.get(null)
    if (rest?.length && !projectId) order.push({ projectId: null, name: null, color: null, items: rest })
    return order
  }, [scopedReleases, projects, projectId])

  const visibleReleases = projectId ? scopedReleases : releases

  if (loading) {
    return <div className="empty-state m-4 text-label text-text-secondary"><div>加载中…</div></div>
  }

  if (visibleReleases.length === 0) {
    return (
      <div className="flex-1 min-h-0 overflow-y-auto p-4">
        <div className="empty-state p-6">
          <div className="text-body text-text-primary">暂无版本记录</div>
        </div>
      </div>
    )
  }

  return (
    <div className="project-shell flex-1 min-h-0 flex gap-4 p-[var(--space-page)] max-w-6xl mx-auto w-full">
      {/* 左：版本清单 —— 按项目分节（版本长在项目下），组内新发布在前 */}
      <div className="w-60 shrink-0 flex flex-col gap-1.5 overflow-y-auto pr-1">
        <div className="flex items-center justify-between px-1 pb-1">
          <span className="text-caption font-semibold text-text-secondary tracking-label">
            {projectId ? '已登记版本' : '按项目分组'}
          </span>
          <span className="text-caption font-mono text-text-secondary/70">
            {visibleReleases.length}
          </span>
        </div>
        {grouped.map((g) => (
          <div key={g.projectId ?? 'orphan'} className="flex flex-col gap-1">
            <div className={cn('flex items-center gap-1.5 px-1 pt-1', projectId && 'sr-only')}>
              {g.color && (
                <span
                  className="w-2 h-2 rounded-full shrink-0"
                  style={{ backgroundColor: g.color }}
                />
              )}
              <span className="text-label text-text-secondary truncate">{g.name ?? '未归属项目'}</span>
              <span className="text-label text-text-secondary/50 shrink-0">{g.items.length}</span>
            </div>
            {g.items.map((r) => {
              const active = selected?.projectId === r.projectId && selected?.version === r.version
              return (
                <button
                  key={`${r.projectId}::${r.version}`}
                  onClick={() => setSelected({ projectId: r.projectId, version: r.version })}
                  className={cn(
                    'text-left rounded-card border px-3 py-2.5 transition-colors cursor-pointer',
                    active
                      ? 'border-accent/60 bg-accent/10 shadow-sm'
                      : 'border-border bg-bg-card hover:bg-surface-subtle hover:border-border'
                  )}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-content font-semibold font-mono text-text-primary">{r.version}</span>
                    <span className="text-caption font-mono text-text-secondary shrink-0">
                      {r.shippedAt ? r.shippedAt.slice(0, 10) : '未标日期'}
                    </span>
                  </div>
                  {r.summary && (
                    <div className="text-caption text-text-secondary mt-1 line-clamp-1">
                      {r.summary}
                    </div>
                  )}
                </button>
              )
            })}
          </div>
        ))}
      </div>

      {/* 右：选中版本的详情 */}
      <div className="flex-1 min-w-0 overflow-y-auto">
        {detail && (
          <div className="flex flex-col gap-3.5">
            <div className="project-section p-5">
              <div className="flex items-start justify-between gap-3 flex-wrap pb-3 border-b border-border/60">
                <div className="flex items-center gap-2.5 flex-wrap">
                  <span className="text-body font-semibold font-mono text-text-primary">{detail.version}</span>
                  {!projectId && projectName(detail.projectId) && (
                    <span className="text-caption rounded-tag bg-surface-subtle border border-border px-2 py-0.5 text-text-secondary">
                      {projectName(detail.projectId)}
                    </span>
                  )}
                  <span className="text-caption font-mono text-text-secondary">
                    {detail.shippedAt ? `发布于 ${detail.shippedAt.slice(0, 10)}` : '尚未标记发布时刻'}
                  </span>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="border border-danger/30 bg-danger/5 text-danger hover:bg-danger/10 px-2.5 shrink-0 cursor-pointer"
                  onClick={() => setDeleteOpen(true)}
                >
                  删除版本…
                </Button>
              </div>

              {detail.summary && (
                <p className="text-content font-normal text-text-primary mt-3.5 leading-relaxed">
                  {detail.summary}
                </p>
              )}

              {detail.highlights.length > 0 && (
                <ul className="mt-3 flex flex-col gap-1.5">
                  {detail.highlights.map((h, i) => (
                    <li key={i} className="flex items-start gap-2 text-label text-text-secondary">
                      <span className="mt-1.75 w-1.5 h-1.5 rounded-full bg-text-secondary/50 shrink-0" />
                      <span className="leading-relaxed text-text-secondary">{h}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* 关联卡片：**派生**自卡片的版本号，不另存 */}
            <div className="project-section p-5">
              <div className="flex items-center justify-between pb-3 border-b border-border/60">
                <span className="text-content font-semibold text-text-primary">
                  关联事项 <span className="font-mono font-normal text-caption text-text-secondary">({orphanCount})</span>
                </span>
                {orphanCount > 0 && (
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 h-7 px-2.5 rounded-button border border-border bg-surface-subtle hover:bg-surface-muted text-label font-medium text-text-primary transition-colors cursor-pointer"
                    onClick={viewItemsInBoard}
                  >
                    在事项看板中筛选 →
                  </button>
                )}
              </div>

              {orphanCount === 0 ? (
                <p className="text-label text-text-secondary mt-3 leading-relaxed">
                  暂无关联事项。可在事项详情页的「解决版本」中填写 <span className="font-mono text-text-primary">{detail.version}</span> 进行关联。
                </p>
              ) : (
                <div className="mt-3 flex flex-col gap-1.5">
                  {detail.todos.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => void invoke('window:showQuickAdd', { todoId: t.id })}
                      className="w-full flex items-center gap-3 rounded-button border border-border/70 bg-surface-subtle px-3.5 py-2.5 text-left hover:bg-bg-card hover:border-border transition-colors cursor-pointer"
                    >
                      <div className="w-20 shrink-0">
                        <TodoStatusPill status={t.status as TodoStatus} />
                      </div>
                      <span className="text-content font-normal text-text-primary truncate flex-1">{t.title}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
      {deleteOpen && detail && (
        <ReleaseDeleteDialog
          projectName={projectName(detail.projectId) ?? '当前项目'}
          version={detail.version}
          todos={detail.todos.map((t) => ({ id: t.id, title: t.title, statusLabel: statusLabel[t.status] ?? t.status }))}
          onConfirmDelete={confirmDelete}
          onUnlink={unlinkTodo}
          onUnlinkAll={unlinkAll}
          onViewItems={() => { setDeleteOpen(false); viewItemsInBoard() }}
          onClose={() => setDeleteOpen(false)}
        />
      )}
    </div>
  )
}
