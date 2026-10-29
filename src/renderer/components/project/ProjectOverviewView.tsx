import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { invoke, on } from '../../lib/ipc-client'
import { STATUS_META } from '../../lib/constants'
import type { TodoStatus } from '../../types/enums'
import type { ProjectDetail } from '../../types/project'
import type { Release } from '../../types/release'
import { useProjectStore } from '../../stores/project.store'
import { useTodoStore } from '../../stores/todo.store'
import { useUIStore } from '../../stores/ui.store'
import { useSettingsStore } from '../../stores/settings.store'
import { ownerLabel } from '../../lib/todo-filter'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { TodoStatusPill } from '../ui/Badge'
import { MarkdownContent } from '../ui/MarkdownContent'
import { EmptyState } from '../ui/EmptyState'
import { Icon } from '../ui/Icon'
import { HandoffRevisionsDrawer } from './HandoffRevisionsDrawer'
import { resolveHandoffTodoReferences } from '../../lib/handoff-references'
import { findHandoffMatches, handoffMatchLine, revealHandoffMatch } from '../../lib/handoff-locate'
import { cn } from '../../lib/utils'

interface ProjectOverviewViewProps {
  projectId: string
  onOpenItems: (status?: TodoStatus) => void
  onOpenVersions: () => void
  /**
   * 全局搜索带到这里的命中关键词（卡 c9dfbc87）：非空时定位并选中说明里的那一段。
   * 不带关键词进来就只剩"打开概览页"，命中的是哪一段得自己再找一遍。
   */
  focusHandoffQuery?: string
}

const CURRENT_STATUSES: TodoStatus[] = ['proposed', 'todo', 'in_progress', 'awaiting_review']
const NEXT_STATUSES: TodoStatus[] = ['awaiting_review', 'in_progress', 'proposed', 'todo']
const PROJECT_COLOR_PRESETS = [
  '#5388F6',
  '#10B981',
  '#F59E0B',
  '#EF4444',
  '#8B5CF6',
  '#EC4899',
  '#06B6D4',
  '#64748B'
]

/**
 * 项目概览：项目背景、实时工作概况、接手说明与项目内检索共处于同一项目上下文。
 * 接手说明不再藏在独立弹窗/页面；检索结果能直接打开命中的事项或评论。
 */
export const ProjectOverviewView: React.FC<ProjectOverviewViewProps> = ({ projectId, onOpenItems, onOpenVersions, focusHandoffQuery = '' }) => {
  const updateProject = useProjectStore((s) => s.updateProject)
  const deleteProject = useProjectStore((s) => s.deleteProject)
  const todos = useTodoStore((s) => s.todos)
  const showToast = useUIStore((s) => s.showToast)
  const enterWorkbench = useUIStore((s) => s.enterWorkbench)
  const openUserSection = useUIStore((s) => s.openUserSection)
  const settings = useSettingsStore((s) => s.settings)
  const [detail, setDetail] = useState<ProjectDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [dirty, setDirty] = useState(false)
  const dirtyRef = useRef(false)
  const [saving, setSaving] = useState(false)
  const [revisionsOpen, setRevisionsOpen] = useState(false)
  const [editingHandoff, setEditingHandoff] = useState(false)
  const [releases, setReleases] = useState<Release[]>([])
  const [editModalOpen, setEditModalOpen] = useState(false)
  const [editNameDraft, setEditNameDraft] = useState('')
  const [editColorDraft, setEditColorDraft] = useState('#5388F6')
  const [deleteModalOpen, setDeleteModalOpen] = useState(false)
  const [deleteConfirmed, setDeleteConfirmed] = useState(false)
  const markdownRef = useRef<HTMLTextAreaElement>(null)
  const draftStorageKey = `deskpartner:handoff-draft:${projectId}`

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const next = await invoke('project:detail', { id: projectId })
      if (!next) throw new Error('项目不存在或已删除')
      setDetail(next)
      if (!dirtyRef.current) setDraft(next.project.handoffMarkdown ?? '')
    } catch (err) {
      setError(err instanceof Error ? err.message : '读取项目概览失败')
    } finally {
      setLoading(false)
    }
  }, [projectId])

  const loadReleases = useCallback(async () => {
    try {
      const list = await invoke('release:list', { projectId })
      setReleases(list)
    } catch {
      setReleases([])
    }
  }, [projectId])

  useEffect(() => {
    dirtyRef.current = false
    setDirty(false)
    void load()
    void loadReleases()
    const unsubscribe = on('event:dataChanged', (event) => {
      if (event.type === 'todo' || event.type === 'project') void load()
      if (event.type === 'project') void loadReleases()
    })
    return unsubscribe
  }, [load, loadReleases])

  useEffect(() => {
    if (!detail || detail.project.id !== projectId || dirtyRef.current) return
    const storedDraft = localStorage.getItem(draftStorageKey)
    if (storedDraft !== null && storedDraft !== (detail.project.handoffMarkdown ?? '')) {
      setDraft(storedDraft)
      setDirty(true)
      dirtyRef.current = true
    } else {
      setDraft(detail.project.handoffMarkdown ?? '')
    }
  }, [detail?.project.id, projectId, draftStorageKey])

  const currentTotal = useMemo(() => {
    if (!detail) return 0
    return CURRENT_STATUSES.reduce((sum, status) => sum + (detail.overview.statusCounts[status] ?? 0), 0)
  }, [detail])

  const activityStats = useMemo(() => {
    const projectTodos = todos.filter((t) => t.projectId === projectId)
    const now = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    const todayKey = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
    const sevenDaysAgo = Date.now() - 7 * 86400000
    let todayCreated = 0
    let todayDone = 0
    let weekCreated = 0
    let weekDone = 0
    for (const t of projectTodos) {
      if (t.createdAt) {
        const cDate = new Date(t.createdAt)
        if (!Number.isNaN(cDate.getTime())) {
          const cKey = `${cDate.getFullYear()}-${pad(cDate.getMonth() + 1)}-${pad(cDate.getDate())}`
          if (cKey === todayKey) todayCreated++
          if (cDate.getTime() >= sevenDaysAgo) weekCreated++
        }
      }
      if (t.completedAt) {
        const dDate = new Date(t.completedAt)
        if (!Number.isNaN(dDate.getTime())) {
          const dKey = `${dDate.getFullYear()}-${pad(dDate.getMonth() + 1)}-${pad(dDate.getDate())}`
          if (dKey === todayKey) todayDone++
          if (dDate.getTime() >= sevenDaysAgo) weekDone++
        }
      }
    }
    return { todayCreated, todayDone, weekCreated, weekDone }
  }, [todos, projectId])

  const nextItems = useMemo(() => {
    if (!detail) return []
    const rank = new Map(NEXT_STATUSES.map((status, index) => [status, index]))
    return detail.overview.items
      .filter((item) => CURRENT_STATUSES.includes(item.status))
      .sort((a, b) => (rank.get(a.status) ?? 99) - (rank.get(b.status) ?? 99) || b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 5)
  }, [detail])

  const handoffReferences = useMemo(() => {
    if (!detail) return []
    return resolveHandoffTodoReferences(draft, detail.overview.items)
  }, [detail, draft])

  /**
   * 搜索落点（卡 c9dfbc87）。命中位置按**屏幕上这一版草稿**实时算，不缓存：
   * 用户把那个词改掉的当下，提示条就该改口说"已不再匹配"。
   * 关键词先在本地 trim（仓储层与搜索结果都用 trim 过的那份），
   * 这样"选中几个字"和"找哪几个字"永远是同一个长度。
   */
  const focusTerm = focusHandoffQuery.trim()
  const focusMatches = useMemo(
    () => (focusTerm ? findHandoffMatches(draft, focusTerm) : []),
    [draft, focusTerm]
  )
  const [matchOrdinal, setMatchOrdinal] = useState(0)
  const focusOrdinal = focusMatches.length > 0 ? Math.min(matchOrdinal, focusMatches.length - 1) : 0

  const revealMatch = useCallback(
    (ordinal: number) => {
      const offset = focusMatches[ordinal]
      if (offset === undefined) return
      const textarea = markdownRef.current
      if (textarea) revealHandoffMatch(textarea, offset, offset + focusTerm.length)
    },
    [focusMatches, focusTerm]
  )

  /**
   * 落点只做一次：选中命中的那一段并滚进视野。
   * 不能跟着 draft 每次都重设选区 —— 用户在这里动一下就要被拽回选区，等于没法编辑，
   * 所以用 ref 记住"这一次落点已经处理过"（换项目或换关键词才重新算）。
   */
  const landedRef = useRef('')
  useEffect(() => {
    if (!focusTerm) {
      landedRef.current = ''
      return
    }
    if (loading || !detail || detail.project.id !== projectId) return
    const key = projectId + '\n' + focusTerm
    if (landedRef.current === key) return
    // 装载中的空草稿**不等于**"说明里没这个词"：等这一版真正上屏再判断，
    // 否则打开的一瞬间会误报"已不再匹配"（库里明明还写着）。
    if (draft === '' && (detail.project.handoffMarkdown ?? '') !== '') return
    landedRef.current = key
    setMatchOrdinal(0)
    revealMatch(0)
  }, [focusTerm, loading, detail, projectId, draft, revealMatch])

  const save = async () => {
    if (!detail || !dirty || saving) return
    setSaving(true)
    try {
      const project = await updateProject({ id: projectId, handoffMarkdown: draft })
      setDetail((current) => (current ? { ...current, project } : current))
      setDraft(project.handoffMarkdown)
      setDirty(false)
      dirtyRef.current = false
      localStorage.removeItem(draftStorageKey)
      showToast('接手说明已保存')
      void load()
    } catch (err) {
      showToast(err instanceof Error ? `保存失败：${err.message}` : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  if (loading && !detail) return <div className="empty-state flex-1 m-5 text-label text-text-secondary"><Icon name="clock" size={22} className="mx-auto text-text-secondary/50" /><div>加载中…</div></div>
  if (error) return <div className="empty-state flex-1 m-5 text-label text-red-500"><Icon name="alertTriangle" size={22} className="mx-auto" /><div>{error}</div><p className="text-label text-text-secondary/70">请稍后重试，或从项目列表重新进入。</p></div>
  if (!detail) return null

  const { project, overview } = detail
  const isEmpty = !draft.trim()
  const latestRelease = releases[0]
  const showHandoffEditor = editingHandoff || Boolean(focusTerm) || isEmpty
  const createdDateStr = project.createdAt ? project.createdAt.slice(0, 10) : ''

  const submitProjectEdit = async () => {
    if (!editNameDraft.trim()) return
    try {
      const updated = await updateProject({
        id: projectId,
        name: editNameDraft.trim(),
        color: editColorDraft
      })
      setDetail((cur) => (cur ? { ...cur, project: updated } : cur))
      setEditModalOpen(false)
      showToast('项目信息已更新')
    } catch (err) {
      showToast(err instanceof Error ? `更新失败：${err.message}` : '更新失败')
    }
  }

  const toggleProjectArchive = async () => {
    const nextArchived = !project.archived
    try {
      const updated = await updateProject({ id: projectId, archived: nextArchived })
      setDetail((cur) => (cur ? { ...cur, project: updated } : cur))
      showToast(nextArchived ? '已归档：事项与接手说明都还在，可在「已归档」里恢复' : '已取消归档')
    } catch (err) {
      showToast(err instanceof Error ? `操作失败：${err.message}` : '操作失败')
    }
  }

  const submitProjectDelete = async () => {
    if (!deleteConfirmed) return
    try {
      await deleteProject(projectId)
      setDeleteModalOpen(false)
      setDeleteConfirmed(false)
      enterWorkbench()
    } catch (err) {
      showToast(err instanceof Error ? `永久删除失败：${err.message}` : '永久删除失败')
    }
  }

  return (
    <div className="project-shell flex-1 min-h-0 overflow-y-auto px-6 py-5">
      <div className="max-w-4xl mx-auto flex flex-col gap-4">
        <section className="project-section p-5">
          <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-border/60">
            <div className="flex items-center gap-2.5 min-w-0 flex-wrap">
              <span
                aria-hidden="true"
                className="w-2.5 h-2.5 rounded-full shrink-0"
                style={{ background: project.color }}
              />
              <h2 className="text-content font-semibold text-text-primary">当前工作分布</h2>
              {createdDateStr && (
                <span className="text-caption font-mono text-text-secondary">
                  · 创建于 {createdDateStr}
                </span>
              )}
              {project.archived && (
                <span className="px-2 py-0.5 rounded-full bg-warning/10 text-warning text-caption font-medium">
                  已归档
                </span>
              )}
              <span className="text-caption font-mono text-text-secondary">
                · 当前工作 {currentTotal} 条 / 共 {overview.total} 条
              </span>
            </div>
            <div className="flex items-center gap-1.5 flex-wrap">
              <Button
                variant="ghost"
                size="sm"
                className="border border-border bg-surface-subtle hover:bg-surface-muted px-2.5 text-text-primary cursor-pointer"
                onClick={() => {
                  setEditNameDraft(project.name)
                  setEditColorDraft(project.color || '#5388F6')
                  setEditModalOpen(true)
                }}
              >
                <Icon name="pencil" size={12} className="mr-1" />
                编辑项目
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="border border-border bg-surface-subtle hover:bg-surface-muted px-2.5 text-text-primary cursor-pointer"
                onClick={() => openUserSection('rules', projectId)}
              >
                <Icon name="shield" size={12} className="mr-1" />
                项目规则与协议
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="border border-border bg-surface-subtle hover:bg-surface-muted px-2.5 text-text-primary cursor-pointer"
                onClick={() => void toggleProjectArchive()}
              >
                <Icon name="archive" size={12} className="mr-1" />
                {project.archived ? '取消归档' : '归档项目'}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="border border-danger/30 bg-danger/5 text-danger hover:bg-danger/10 px-2.5 cursor-pointer"
                onClick={() => {
                  setDeleteConfirmed(false)
                  setDeleteModalOpen(true)
                }}
              >
                <Icon name="trash" size={12} className="mr-1" />
                永久删除…
              </Button>
            </div>
          </div>
          <div className="mt-3.5 grid grid-cols-2 lg:grid-cols-4 gap-2.5">
            {CURRENT_STATUSES.map((status) => {
              const count = overview.statusCounts[status] ?? 0
              return (
                <button
                  key={status}
                  type="button"
                  onClick={() => onOpenItems(status)}
                  className="text-left rounded-card border border-border bg-bg-card px-3.5 py-3 hover:border-accent/60 transition-colors cursor-pointer"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-1.5 text-label text-text-secondary">
                      <span
                        className="w-2 h-2 rounded-full shrink-0"
                        style={{ backgroundColor: `var(${STATUS_META[status].colorVar})` }}
                      />
                      {STATUS_META[status].label}
                    </span>
                    <span className="text-content font-semibold font-mono text-text-primary">{count}</span>
                  </div>
                  <div className={cn('mt-2.5 h-1 rounded-full bg-surface-muted overflow-hidden', count === 0 && 'opacity-50')}>
                    <div
                      className="h-full rounded-full"
                      style={{
                        backgroundColor: `var(${STATUS_META[status].colorVar})`,
                        width: `${currentTotal ? Math.min(100, (count / currentTotal) * 100) : 0}%`
                      }}
                    />
                  </div>
                </button>
              )
            })}
          </div>
          <div className="mt-3 pt-3 border-t border-border/50 grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            <div className="flex items-center justify-between rounded-button bg-surface-subtle border border-border/60 px-3.5 py-2 text-label">
              <span className="text-text-secondary font-medium">今日工作动态</span>
              <div className="flex items-center gap-3 font-mono text-caption">
                <span className="text-text-secondary">
                  新增 <strong className="text-text-primary font-semibold">{activityStats.todayCreated}</strong>
                </span>
                <span className="text-text-secondary">
                  完成 <strong className="text-success font-semibold">{activityStats.todayDone}</strong>
                </span>
              </div>
            </div>
            <div className="flex items-center justify-between rounded-button bg-surface-subtle border border-border/60 px-3.5 py-2 text-label">
              <span className="text-text-secondary font-medium">近 7 天工作动态</span>
              <div className="flex items-center gap-3 font-mono text-caption">
                <span className="text-text-secondary">
                  新增 <strong className="text-text-primary font-semibold">{activityStats.weekCreated}</strong>
                </span>
                <span className="text-text-secondary">
                  完成 <strong className="text-success font-semibold">{activityStats.weekDone}</strong>
                </span>
              </div>
            </div>
          </div>
        </section>

        <section className="project-section p-5">
          <div className="flex items-center justify-between gap-3 pb-3 border-b border-border/60">
            <h2 className="text-content font-semibold text-text-primary">待处理事项</h2>
            <span className="text-caption font-mono text-text-secondary">{nextItems.length} 条</span>
          </div>
          {nextItems.length === 0 ? (
            <EmptyState title="当前没有需要继续处理的事项" className="mt-3" />
          ) : (
            <div className="mt-3 flex flex-col gap-1.5">
              {nextItems.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => void invoke('window:showQuickAdd', { todoId: item.id })}
                  className="flex items-center gap-3 rounded-button border border-border/70 bg-surface-subtle px-3.5 py-2.5 text-left hover:bg-bg-card hover:border-border transition-colors cursor-pointer"
                >
                  <div className="w-20 shrink-0">
                    <TodoStatusPill status={item.status} />
                  </div>
                  <span className="text-content font-normal text-text-primary truncate flex-1">{item.title}</span>
                  {item.executedBy && (
                    <span className="text-caption text-text-secondary shrink-0">
                      {ownerLabel(item.executedBy, settings?.humanName)}
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
        </section>

        <section className="project-section p-5">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0 flex-1">
              <h2 className="text-content font-semibold text-text-primary">项目版本</h2>
              {latestRelease ? (
                <p className="mt-1 text-label text-text-secondary truncate">
                  最近登记：<span className="font-mono text-text-primary font-medium">{latestRelease.version}</span>
                  {latestRelease.summary ? ` · ${latestRelease.summary}` : ''}
                </p>
              ) : (
                <p className="mt-1 text-label text-text-secondary">当前项目尚无登记版本。</p>
              )}
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={onOpenVersions}
              className="shrink-0 border border-border bg-surface-subtle hover:bg-surface-muted px-2.5 text-text-primary cursor-pointer"
            >
              查看版本记录
            </Button>
          </div>
        </section>

        <section className="project-section p-5">
          <div className="flex items-center justify-between gap-3 pb-3 border-b border-border/60">
            <h2 className="text-content font-semibold text-text-primary">项目接手说明</h2>
            <div className="flex items-center gap-2">
              {!isEmpty && !focusTerm && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="border border-border bg-surface-subtle hover:bg-surface-muted px-2.5 text-text-primary cursor-pointer"
                  onClick={() => setEditingHandoff((prev) => !prev)}
                >
                  {editingHandoff ? '阅读视图' : '编辑说明'}
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                className="border border-border bg-surface-subtle hover:bg-surface-muted px-2.5 text-text-primary cursor-pointer"
                onClick={() => setRevisionsOpen(true)}
              >
                <Icon name="clock" size={13} className="mr-1" /> 修订历史（{detail.handoffRevisionCount}）
              </Button>
              {(showHandoffEditor || dirty) && (
                <Button variant="primary" size="sm" onClick={() => void save()} disabled={!dirty || saving}>
                  {saving ? '保存中…' : '保存说明'}
                </Button>
              )}
            </div>
          </div>

          {!showHandoffEditor && (
            <div
              role="button"
              tabIndex={0}
              onClick={() => setEditingHandoff(true)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  setEditingHandoff(true)
                }
              }}
              title="点击切入编辑模式"
              className="mt-3 rounded-card border border-border/70 bg-bg-card p-4 hover:border-border transition-colors cursor-text"
            >
              <MarkdownContent content={draft} />
            </div>
          )}

          {isEmpty && !dirty && (
            <p className="mt-3 rounded-input border border-dashed border-border px-3 py-2 text-label text-text-secondary">
              尚无接手说明。可填写项目目标、当前决定、工作入口和重要决定出处。
            </p>
          )}
          <textarea
            ref={markdownRef}
            value={draft}
            onChange={(event) => {
              const value = event.target.value
              setDraft(value)
              const changed = value !== (detail.project.handoffMarkdown ?? '')
              if (changed) localStorage.setItem(draftStorageKey, value)
              else localStorage.removeItem(draftStorageKey)
              setDirty(changed)
              dirtyRef.current = changed
            }}
            rows={12}
            maxLength={50000}
            placeholder={'# 项目目标\n\n# 当前决定\n\n# 工作入口\n\n# 关键决定出处\n'}
            className={cn(
              'mt-3 w-full min-h-56 resize-y rounded-input border border-border bg-bg-card px-3.5 py-2.5 text-label text-text-primary font-mono leading-relaxed outline-none focus:border-accent',
              !showHandoffEditor && 'hidden'
            )}
            aria-label="项目接手说明 Markdown"
          />
          {focusTerm && (
            <div
              role="status"
              aria-label="接手说明的搜索命中"
              className={cn(
                'mt-3 flex flex-wrap items-center gap-2 rounded-input border px-3 py-2 text-label',
                focusMatches.length > 0
                  ? 'border-accent bg-accent/5 text-text-secondary ring-1 ring-accent/40'
                  : 'border-amber-200 bg-amber-50 text-amber-800'
              )}
            >
              {focusMatches.length > 0 ? (
                <>
                  <span>
                    已定位「{focusTerm}」（{focusOrdinal + 1}/{focusMatches.length}，第{' '}
                    {handoffMatchLine(draft, focusMatches[focusOrdinal])} 行）
                  </span>
                  {/* 一份说明在搜索结果里只有一行，其余几处不给出路就等于没提 */}
                  {focusMatches.length > 1 && (
                    <Button variant="ghost" size="sm" onClick={() => {
                      const next = (focusOrdinal + 1) % focusMatches.length
                      setMatchOrdinal(next)
                      revealMatch(next)
                    }}>下一处</Button>
                  )}
                </>
              ) : (
                <span>
                  未在接手说明中找到「{focusTerm}」
                </span>
              )}
            </div>
          )}
          {handoffReferences.length > 0 && (
            <div className="mt-3 rounded-input border border-border bg-bg-secondary p-3" aria-label="接手说明引用事项的当前状态">
              <div className="text-label font-medium text-text-primary">引用的事项</div>
              <ul className="mt-2 grid gap-1.5">
                {handoffReferences.map((reference) => {
                  const status = reference.item?.status as TodoStatus | undefined
                  return (
                    <li key={reference.reference} className="flex flex-wrap items-center gap-2 text-label">
                      <code className="text-caption text-text-tertiary">#{reference.reference}</code>
                      {reference.item && status ? (
                        <>
                          <span className="rounded-full bg-bg-card px-2 py-0.5 text-caption">{STATUS_META[status].label}</span>
                          <span className="min-w-0 break-words text-text-primary">{reference.item.title}</span>
                        </>
                      ) : reference.ambiguous ? (
                        <span className="text-warning">短号在本项目中匹配多条事项，请补充更多编号字符。</span>
                      ) : (
                        <span className="text-text-secondary">本项目当前事项中未找到；可能已删除或不属于此项目。</span>
                      )}
                    </li>
                  )
                })}
              </ul>
            </div>
          )}
          {dirty && <p className="mt-2 text-label text-amber-600">有未保存的修改；离开页面前请保存。</p>}
        </section>

      </div>
      <HandoffRevisionsDrawer projectId={projectId} open={revisionsOpen} onClose={() => { setRevisionsOpen(false); void load() }} />
      {editModalOpen && (
        <Dialog open onClose={() => setEditModalOpen(false)}>
          <div className="w-88 flex flex-col gap-3.5">
            <div className="flex items-center justify-between pb-2.5 border-b border-border/60">
              <h3 className="text-body font-semibold text-text-primary">编辑项目</h3>
              <button
                type="button"
                onClick={() => setEditModalOpen(false)}
                aria-label="关闭"
                className="w-6 h-6 flex items-center justify-center rounded-button text-text-secondary hover:bg-surface-muted hover:text-text-primary transition-colors cursor-pointer"
              >
                <Icon name="x" size={14} />
              </button>
            </div>
            <label className="flex flex-col gap-1.5 text-label text-text-secondary">
              项目名称
              <input
                autoFocus
                value={editNameDraft}
                onChange={(e) => setEditNameDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void submitProjectEdit()
                  if (e.key === 'Escape') setEditModalOpen(false)
                }}
                maxLength={30}
                className="w-full h-9 px-3 rounded-button border border-border text-content text-text-primary bg-bg-card outline-none focus:border-accent transition-colors"
              />
            </label>
            <div className="flex flex-col gap-1.5">
              <span className="text-label text-text-secondary">项目标识色</span>
              <div className="flex items-center gap-2 flex-wrap">
                {PROJECT_COLOR_PRESETS.map((c) => {
                  const active = editColorDraft.toLowerCase() === c.toLowerCase()
                  return (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setEditColorDraft(c)}
                      title={`选择标识色 ${c}`}
                      className={cn(
                        'w-6 h-6 rounded-full transition-transform cursor-pointer flex items-center justify-center',
                        active ? 'ring-2 ring-offset-2 ring-accent scale-110' : 'hover:scale-105 opacity-85 hover:opacity-100'
                      )}
                      style={{ backgroundColor: c }}
                    />
                  )
                })}
                <label
                  className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-button border border-border bg-bg-card text-caption text-text-secondary hover:text-text-primary cursor-pointer ml-1"
                  title="自定义其他颜色"
                >
                  <input
                    type="color"
                    value={editColorDraft}
                    onChange={(e) => setEditColorDraft(e.target.value)}
                    className="w-3.5 h-3.5 rounded-xs border-0 bg-transparent cursor-pointer"
                  />
                  <span>自定义</span>
                </label>
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2 border-t border-border/60">
              <Button variant="ghost" size="sm" onClick={() => setEditModalOpen(false)}>
                取消
              </Button>
              <Button variant="primary" size="sm" onClick={() => void submitProjectEdit()}>
                保存
              </Button>
            </div>
          </div>
        </Dialog>
      )}
      {deleteModalOpen && (
        <Dialog open onClose={() => { setDeleteModalOpen(false); setDeleteConfirmed(false) }}>
          <div className="w-dialog-sm flex flex-col gap-3">
            <h3 className="text-body font-medium text-text-primary">永久删除项目「{project.name}」</h3>
            <p className="text-label text-text-secondary leading-relaxed">
              将一并删除该项目下的 {overview.total} 条事项、评论、接手说明与版本记录，
              <span className="text-red-500">删除后不可恢复</span>。若需保留数据，请使用<span className="text-text-primary">「归档项目」</span>。
            </p>
            <label className="flex items-start gap-2 text-label text-text-primary cursor-pointer">
              <input type="checkbox" checked={deleteConfirmed} onChange={(e) => setDeleteConfirmed(e.target.checked)} className="mt-0.5 accent-accent" />
              <span>我确认永久删除该项目及其全部数据</span>
            </label>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => { setDeleteModalOpen(false); setDeleteConfirmed(false) }}>取消</Button>
              <Button
                variant="ghost"
                size="sm"
                className="border border-border bg-surface-subtle hover:bg-surface-muted text-text-primary"
                onClick={async () => {
                  setDeleteModalOpen(false)
                  setDeleteConfirmed(false)
                  try {
                    const updated = await updateProject({ id: projectId, archived: true })
                    setDetail((cur) => (cur ? { ...cur, project: updated } : cur))
                    showToast('已归档：事项与接手说明都还在，可在「已归档」里恢复')
                    enterWorkbench()
                  } catch (err) {
                    showToast(err instanceof Error ? `归档失败：${err.message}` : '归档操作失败')
                  }
                }}
              >
                归档项目
              </Button>
              <Button variant="danger" size="sm" disabled={!deleteConfirmed} onClick={() => void submitProjectDelete()}>永久删除</Button>
            </div>
          </div>
        </Dialog>
      )}
    </div>
  )
}
