import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Icon, type IconName } from '../ui/Icon'
import { Button } from '../ui/Button'
import { EmptyState } from '../ui/EmptyState'
import { useSettingsStore } from '../../stores/settings.store'
import { useUIStore } from '../../stores/ui.store'
import { invoke, on } from '../../lib/ipc-client'
import { timeAgo } from '../../lib/date'
import type { InboxNotification, InboxPage, NotificationType } from '../../types/notification'
import type { Agent } from '../../types/todo'
import { cn } from '../../lib/utils'
import { stripMarkdown } from '../../lib/markdown'
import { GUI_READER, isUnreadFor, withReader } from '../../lib/notification-subject'

/**
 * 通知中心（1.0.48，v3 设计拍板：五类全收；1.0.55 起四类 + 待拍板）
 *
 * 「备忘」的升级版：所有需要人知道的事的一个收件箱 ——
 * 待办提醒 / 执行回执 / agent 备忘 / 待验收交付 / 待你拍板。
 *
 * 定位是**索引不是操作台**：行内不做动作（不在列表里批准/处理），
 * 点击整行 = 标已读 + 去这件事所在的地方（待办→详情抽屉，
 * 备忘/回执→就地展开结构化详情卡片）。
 */
const TYPE_META: Record<NotificationType, { icon: IconName; label: string; cls: string }> = {
  reminder: { icon: 'bell', label: '提醒', cls: 'text-warning' },
  // 'grant' 已退役：保留键位仅为满足 Record 完整性，不会出现在筛选条里
  grant: { icon: 'shield', label: '审批', cls: 'text-danger' },
  exec_result: { icon: 'checkCircle', label: '回执', cls: 'text-success' },
  memo: { icon: 'fileText', label: '备忘', cls: 'text-text-secondary' },
  review: { icon: 'inbox', label: '交付', cls: 'text-warning' },
  decision: { icon: 'messageCircle', label: '待拍板', cls: 'text-accent' }
}

/** 已退役的类型：不进筛选条、不参与计数（与服务端 RETIRED_TYPES 对齐） */
const RETIRED_TYPES: NotificationType[] = ['grant']

/** 收件箱一次读多少条（卡 `cba46119`） */
const PAGE_SIZE = 500

type FilterOption = { value: string; label: string }

/**
 * 表头即筛选（Table Header as Filter）：
 * 采用自定义浮层菜单（Popover Listbox）替代 Windows 原生 <select>，
 * 表头列本身承担该维度的下拉筛选，选中后直接在表头回显当前条件。
 */
const HeaderColumnFilter: React.FC<{
  label: string
  ariaLabel: string
  value: string
  options: FilterOption[]
  activeLabel?: string | null
  onChange: (nextValue: string) => void
  wrapperClassName?: string
}> = ({ label, ariaLabel, value, options, activeLabel, onChange, wrapperClassName }) => {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const isActive = Boolean(activeLabel)

  useEffect(() => {
    if (!open) return
    const handleMouseDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', handleMouseDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handleMouseDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  return (
    <div
      ref={containerRef}
      role="columnheader"
      className={cn('relative flex items-center min-w-0', wrapperClassName)}
    >
      <button
        type="button"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={() => setOpen((prev) => !prev)}
        title={activeLabel ? `${label}：${activeLabel}（点击切换筛选）` : `点击按「${label}」筛选`}
        className={cn(
          'inline-flex items-center gap-1 rounded-xs px-1.5 py-0.5 -mx-1.5 transition-colors max-w-full cursor-pointer',
          isActive || open
            ? 'bg-accent/10 text-accent font-semibold'
            : 'text-text-secondary hover:text-text-primary hover:bg-surface-muted font-medium'
        )}
      >
        <span className="shrink-0">{label}</span>
        {activeLabel && <span className="truncate text-accent font-semibold">· {activeLabel}</span>}
        <Icon
          name="chevronLeft"
          size={10}
          className={cn(
            'shrink-0 transition-transform',
            open ? 'rotate-90 text-accent' : '-rotate-90',
            isActive ? 'text-accent' : 'text-text-secondary/70'
          )}
        />
      </button>

      {open && (
        <div
          role="listbox"
          aria-label={`${label}筛选项`}
          className="absolute left-0 top-full mt-1.5 z-50 min-w-36 max-h-64 overflow-y-auto rounded-card border border-border bg-bg-card p-1 shadow-float"
        >
          {options.map((opt) => {
            const selected = opt.value === value
            return (
              <button
                key={opt.value}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => {
                  onChange(opt.value)
                  setOpen(false)
                }}
                className={cn(
                  'w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-button text-label text-left transition-colors whitespace-nowrap',
                  selected
                    ? 'bg-accent/10 text-accent font-semibold'
                    : 'text-text-primary hover:bg-surface-subtle font-normal'
                )}
              >
                <span className="truncate">{opt.label}</span>
                {selected && <span className="w-1.5 h-1.5 rounded-full bg-accent shrink-0" />}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

export const NotificationsView: React.FC<{ projectId?: string; compact?: boolean }> = ({
  projectId,
  compact = false
}) => {
  const { settings } = useSettingsStore()
  const { setMainView, setFocusGrantId } = useUIStore()
  const [items, setItems] = useState<InboxNotification[]>([])
  const [agents, setAgents] = useState<Agent[]>([])
  /**
   * 窗口之外的事实（1.0.107，修 `cba46119`）：命中总数、下一页起点、分类计数、未读。
   * 全部来自主进程、与列表**同一份 WHERE**，所以界面上的三个数不会再各说各话。
   */
  const [pageInfo, setPageInfo] = useState<{
    matched: number
    nextOffset: number | null
    byType: InboxPage['byType']
    unread: number
  }>({ matched: 0, nextOffset: null, byType: {}, unread: 0 })
  const [loading, setLoading] = useState(true)
  /** 展开的备忘或回执 id（详情就地展开，不开新窗） */
  const [expandedMemo, setExpandedMemo] = useState<string | null>(null)
  const [actionError, setActionError] = useState('')
  const [loadError, setLoadError] = useState('')
  const [toast, setToast] = useState('')
  /**
   * 分类筛选（1.0.49）
   * 默认全部；点某一类只看该类。
   */
  const [filter, setFilter] = useState<NotificationType | 'all'>('all')

  /**
   * 读一页收件箱（卡 `cba46119`）
   * - `offset = 0` 重读第一页；`offset = nextOffset` 接着往下读。
   * - 分类筛选**下推给主进程**（`type` 参数）。
   */
  const load = useCallback(
    async (which: NotificationType | 'all', offset = 0) => {
      try {
        const page = await invoke('notification:listWithProject', {
          limit: PAGE_SIZE,
          offset,
          projectId: projectId ?? null,
          type: which === 'all' ? null : which,
          /**
           * 主体（卡 `c13dbb16`）：GUI 窗口的"我"就是**主用户**。
           */
          reader: GUI_READER
        })
        setItems((cur) => (offset > 0 ? [...cur, ...page.rows] : page.rows))
        setPageInfo({
          matched: page.matched,
          nextOffset: page.nextOffset,
          byType: page.byType,
          unread: page.unread
        })
        setLoadError('')
      } catch (error) {
        setLoadError(error instanceof Error ? `读取通知失败：${error.message}` : '读取通知失败')
      } finally {
        setLoading(false)
      }
    },
    [projectId]
  )

  useEffect(() => {
    void invoke('agent:list')
      .then((list) => {
        if (Array.isArray(list)) setAgents(list)
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    void load(filter)
    const offs = [
      on('event:dataChanged', (data) => {
        if (
          data.type === 'memo' ||
          data.type === 'grant' ||
          data.type === 'notification' ||
          data.type === 'todo'
        ) {
          void load(filter)
        }
      })
    ]
    const timer = window.setInterval(() => void load(filter), 5000)
    return () => {
      offs.forEach((off) => off())
      window.clearInterval(timer)
    }
  }, [load, filter])

  const flash = (msg: string) => {
    setToast(msg)
    window.setTimeout(() => setToast((cur) => (cur === msg ? '' : cur)), 3000)
  }

  /** 整行点击 = 标已读 + 去这件事所在的地方（索引职责） */
  const open = async (n: InboxNotification) => {
    setActionError('')
    try {
      if (isUnreadFor(n, GUI_READER)) {
        await invoke('notification:markRead', { id: n.id, reader: GUI_READER })
        setItems((cur) =>
          cur.map((it) =>
            it.id === n.id
              ? { ...it, status: 'read' as const, readBy: withReader(it.readBy, GUI_READER) }
              : it
          )
        )
      }
    } catch (error) {
      setActionError(error instanceof Error ? `标记通知已读失败：${error.message}` : '标记通知已读失败')
      return
    }
    switch (n.type) {
      case 'reminder':
      case 'review':
        if (n.refId) invoke('window:showQuickAdd', { todoId: n.refId, projectId: n.projectId ?? undefined })
        break
      case 'decision':
        setMainView('board')
        if (n.refId) invoke('window:showQuickAdd', { todoId: n.refId, projectId: n.projectId ?? undefined })
        break
      case 'grant':
        if (n.refId) setFocusGrantId(n.refId)
        setMainView('approval')
        break
      case 'memo':
        setExpandedMemo((cur) => (cur === n.refId ? null : n.refId))
        break
      case 'exec_result':
        setExpandedMemo((cur) => (cur === n.id ? null : n.id))
        break
    }
  }

  /**
   * 标已读的范围跟着**当前筛选**走，而且**与列表同一份范围**（卡 `cba46119`）
   */
  const markAllRead = async () => {
    if (projectId) {
      await invoke('notification:markProjectRead', {
        projectId,
        type: filter === 'all' ? null : filter,
        reader: GUI_READER
      })
    } else {
      await invoke('notification:markAllRead', {
        ...(filter === 'all' ? {} : { type: filter }),
        reader: GUI_READER
      })
    }
    setItems((cur) =>
      cur.map((it) =>
        filter === 'all' || it.type === filter
          ? { ...it, status: 'read' as const, readBy: withReader(it.readBy, GUI_READER) }
          : it
      )
    )
    setPageInfo((cur) => ({ ...cur, unread: 0 }))
  }

  const memoToTodo = async (memoId: string) => {
    setActionError('')
    try {
      const r = await invoke('memo:toTodo', { id: memoId })
      setExpandedMemo(null)
      void load(filter)
      flash(`已转为事项「${r.title}」`)
    } catch (e) {
      setActionError((e as Error).message)
    }
  }

  const memoDelete = async (memoId: string) => {
    setActionError('')
    try {
      await invoke('memo:delete', { id: memoId })
      setExpandedMemo(null)
      void load(filter)
    } catch (e) {
      setActionError((e as Error).message)
    }
  }

  /**
   * 各类计数（卡 `cba46119`）：**整个范围**里每一类有多少条，不含窗口。
   */
  const counts = useMemo(() => {
    const c: Record<NotificationType | 'all', number> = {
      all: 0,
      reminder: 0,
      grant: 0,
      exec_result: 0,
      memo: 0,
      review: 0,
      decision: 0
    }
    for (const [type, count] of Object.entries(pageInfo.byType)) {
      if (!count) continue
      c[type as NotificationType] = count.total
      c.all += count.total
    }
    return c
  }, [pageInfo.byType])

  /**
   * 显示哪些 chip：有内容的类才有意义；当前选中的那类即使归零也留着。
   */
  const chips = useMemo(() => {
    const present = (Object.keys(TYPE_META) as NotificationType[]).filter(
      (t) => counts[t] > 0 && !RETIRED_TYPES.includes(t) && (t !== 'memo' || (pageInfo.byType.memo?.unread ?? 0) > 0)
    )
    if (filter !== 'all' && !present.includes(filter)) present.push(filter)
    return present
  }, [counts, filter, pageInfo.byType.memo?.unread])

  /**
   * 列表行 = 主进程给的那一页（卡 `cba46119`）
   */
  const visible = items

  /**
   * 未读数 = **当前范围 ∩ 当前分类**的未读（主进程数的，不含窗口）。
   */
  const unread = pageInfo.unread
  /** 这一页之后还有多少条没读进来 —— 页脚据此说"还有 N 条" */
  const remaining = Math.max(0, pageInfo.matched - items.length)

  const typeFilterOptions = useMemo<FilterOption[]>(() => {
    const allTypes = (Object.keys(TYPE_META) as NotificationType[]).filter(
      (t) => !RETIRED_TYPES.includes(t)
    )
    return [
      { value: 'all', label: `全部类型 (${counts.all})` },
      ...allTypes.map((t) => ({
        value: t,
        label: `${TYPE_META[t].label} (${counts[t]})`
      }))
    ]
  }, [counts])

  const resolveActorDisplay = useCallback(
    (actor: string | null): string => {
      if (!actor) return '系统'
      if (actor === 'human') return settings.humanName?.trim() || '我'
      const matched = agents.find((a) => a.id === actor)
      if (matched?.displayName) return matched.displayName
      return actorLabel(actor, settings.humanName)
    },
    [agents, settings.humanName]
  )

  return (
    <div
      className={cn(
        'project-notification-inbox flex-1 min-h-0 overflow-y-auto',
        compact && 'text-body'
      )}
    >
      <div
        className={cn(
          'max-w-6xl mx-auto flex flex-col gap-4',
          compact ? 'px-4 py-3' : 'px-6 py-5'
        )}
      >
        {/* 顶栏：在独立通知中心显示标题，在项目动态页内不重复渲染大标题 */}
        <div className="notification-toolbar flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2.5 flex-wrap">
            {!projectId ? (
              <div className="flex items-baseline gap-2">
                <h2 className="text-column-title font-semibold tracking-title text-text-primary">
                  通知记录
                </h2>
                <span className="font-mono text-label text-text-secondary">{counts.all}</span>
              </div>
            ) : (
              <span className="text-label text-text-secondary font-mono">
                共 {counts.all} 条通知
              </span>
            )}

            <div className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-bg-card px-3 py-1 text-caption text-text-secondary">
              <span
                className={cn(
                  'w-1.5 h-1.5 rounded-full shrink-0',
                  unread > 0 ? 'bg-accent' : 'bg-success'
                )}
              />
              <span className="font-mono font-medium text-text-primary">
                {unread > 0 ? `未读 ${unread}` : '没有未读'}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            {/* 分类筛选：有内容的类出现快捷切换 */}
            {chips.length > 1 && (
              <div className="flex items-center gap-1 rounded-button bg-surface-subtle p-1 border border-border/60 overflow-x-auto">
                <FilterChip
                  label="全部"
                  count={counts.all}
                  active={filter === 'all'}
                  onClick={() => setFilter('all')}
                />
                {chips.map((t) => (
                  <FilterChip
                    key={t}
                    label={TYPE_META[t].label}
                    count={counts[t]}
                    active={filter === t}
                    onClick={() => setFilter(t)}
                  />
                ))}
              </div>
            )}

            {unread > 0 && (
              <Button variant="ghost" size="sm" onClick={() => void markAllRead()}>
                {filter === 'all' ? '全部已读' : '本类已读'}
              </Button>
            )}
          </div>
        </div>

        {toast && (
          <div className="rounded-card border border-success/30 bg-success/10 px-4 py-2 text-label text-success">
            {toast}
          </div>
        )}
        {loadError && (
          <div
            role="alert"
            className="rounded-card border border-danger/30 bg-danger/5 flex items-center gap-2 px-4 py-2 text-label text-danger"
          >
            <span className="flex-1">{loadError}；已显示的通知会保留。</span>
            <Button variant="ghost" size="sm" onClick={() => void load(filter)}>
              重新读取
            </Button>
          </div>
        )}
        {actionError && (
          <div
            role="alert"
            className="rounded-card border border-danger/30 bg-danger/5 px-4 py-2 text-label text-danger"
          >
            {actionError}
          </div>
        )}

        {/* 通知表格卡片：5 列纯文字表头（通知类型表头自带自定义浮层筛选） */}
        <div className="rounded-card border border-border bg-bg-card divide-y divide-border/50 shadow-sm">
          <div
            role="row"
            aria-label="通知列表表头"
            className="px-4 py-2 bg-surface-subtle rounded-t-card flex items-center gap-3 text-caption select-none"
          >
            <HeaderColumnFilter
              label="通知类型"
              ariaLabel="按通知类型筛选"
              activeLabel={filter === 'all' ? null : TYPE_META[filter].label}
              value={filter}
              options={typeFilterOptions}
              onChange={(next) => setFilter(next as NotificationType | 'all')}
              wrapperClassName="w-24 shrink-0"
            />

            <div role="columnheader" className="flex-1 min-w-0 font-medium text-text-secondary">
              通知内容
            </div>

            <div role="columnheader" className="w-28 shrink-0 font-medium text-text-secondary">
              来源
            </div>

            <div role="columnheader" className="w-20 shrink-0 font-medium text-text-secondary">
              状态
            </div>

            <div
              role="columnheader"
              className="w-28 shrink-0 font-medium text-text-secondary text-right pr-5"
            >
              时间
            </div>
          </div>

          {loading && items.length === 0 && (
            <div className="p-6 text-center text-label text-text-secondary">加载中…</div>
          )}

          {!loading && !loadError && visible.length === 0 && (
            <div className="p-6">
              <EmptyState
                title={filter === 'all' ? '暂无通知' : `没有「${TYPE_META[filter].label}」这一类`}
                description={
                  filter === 'all'
                    ? '当有事项提醒、执行回执、备忘或待验收事项时会在此汇总。'
                    : '可点击表头或顶部标签切换查看全部通知。'
                }
              />
            </div>
          )}

          {visible.map((n) => {
            const meta = TYPE_META[n.type]
            /**
             * 这条对**我（主用户）**算不算未读（卡 `c13dbb16`）：按 `read_by` 判，
             * 不按全局 `status`。
             */
            const unreadForMe = isUnreadFor(n, GUI_READER)
            const isMemoExpanded =
              expandedMemo !== null && (expandedMemo === n.refId || expandedMemo === n.id)
            const execOk = n.type === 'exec_result' ? parseMetaOk(n.meta) : null
            /**
             * 驳回要与"交付待验收"在动态里长得不一样（1.0.72）。
             * 标签用「退回」而不是「未通过」。
             */
            const rejected = isRejectedNotice(n.meta)
            const label = rejected ? '退回' : meta.label
            const isRejectLook = rejected
            const statusIcon: IconName =
              execOk === false || isRejectLook ? 'alertTriangle' : meta.icon

            const displayTitle = humanizeNotificationTitle(n)
            const subtitle = resolveNotificationSubtitle(n, execOk)
            const actorDisplay = resolveActorDisplay(n.actor)
            const isExpandable = n.type === 'memo' || n.type === 'exec_result'

            return (
              <div
                key={n.id}
                className={cn(
                  'notification-row transition-colors',
                  isMemoExpanded ? 'bg-surface-subtle' : 'hover:bg-black/5',
                  unreadForMe && 'notification-row-unread'
                )}
              >
                <button
                  type="button"
                  aria-expanded={isExpandable ? isMemoExpanded : undefined}
                  onClick={() => void open(n)}
                  className="w-full flex items-center gap-3 px-4 py-2.5 text-left cursor-pointer"
                >
                  {/* 列 1：通知类型（纯文字徽章，失败/退回用告警色强调） */}
                  <span className="w-24 shrink-0 flex items-center">
                    <span
                      data-icon={statusIcon}
                      className={cn(
                        'inline-flex items-center rounded-xs border px-2 py-0.5 text-caption font-medium whitespace-nowrap truncate',
                        execOk === false || isRejectLook
                          ? 'bg-danger/10 text-danger border-danger/30'
                          : 'bg-surface-subtle text-text-secondary border-border/70'
                      )}
                    >
                      {label}
                    </span>
                  </span>

                  {/* 列 2：通知内容（统一 ItemTitle 14px/400，未读以主色文字 + 状态列圆点表达，不再整屏加粗刷屏） */}
                  <span className="flex-1 min-w-0 flex flex-col gap-0.5">
                    <span
                      className={cn(
                        'block truncate text-content font-normal',
                        unreadForMe ? 'text-text-primary' : 'text-text-secondary'
                      )}
                    >
                      {displayTitle}
                    </span>
                    {subtitle && !isMemoExpanded && (
                      <span
                        className={cn(
                          'block truncate text-caption',
                          execOk === false || isRejectLook ? 'text-danger' : 'text-text-secondary'
                        )}
                      >
                        {stripMarkdown(subtitle)}
                      </span>
                    )}
                  </span>

                  {/* 列 3：来源 */}
                  <span
                    className="w-28 shrink-0 truncate text-label text-text-secondary"
                    title={n.actor ?? '系统'}
                  >
                    {actorDisplay}
                  </span>

                  {/* 列 4：状态（未读 / 已读） */}
                  <span className="w-20 shrink-0 flex items-center">
                    {unreadForMe ? (
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-accent/10 px-2.5 py-0.5 text-caption font-medium text-accent whitespace-nowrap">
                        <span className="w-1.5 h-1.5 rounded-full bg-accent shrink-0" />
                        <span>未读</span>
                      </span>
                    ) : (
                      <span className="text-caption text-text-secondary whitespace-nowrap pl-1">
                        已读
                      </span>
                    )}
                  </span>

                  {/* 列 5：时间 + 展开/跳转指示 */}
                  <span className="w-28 shrink-0 flex items-center justify-end gap-2">
                    <span className="font-mono text-caption text-text-secondary whitespace-nowrap">
                      {timeAgo(n.createdAt)}
                    </span>
                    <Icon
                      name="chevronLeft"
                      size={13}
                      className={cn(
                        'text-text-secondary/70 transition-transform shrink-0',
                        isExpandable
                          ? isMemoExpanded
                            ? 'rotate-90'
                            : '-rotate-90'
                          : 'rotate-180 opacity-50'
                      )}
                    />
                  </span>
                </button>

                {/* 备忘展开详情：结构化详情卡片 + 转为事项 / 删除 */}
                {n.type === 'memo' && isMemoExpanded && (
                  <div className="px-4 pb-3.5 pt-0.5">
                    <div className="rounded-button border border-border/80 bg-bg-primary p-3 grid gap-2.5 text-label">
                      <div className="flex items-center justify-between gap-3 flex-wrap text-caption">
                        <div className="flex items-center gap-4 flex-wrap text-text-secondary">
                          <span>
                            发件人：<strong className="text-text-primary font-medium">{actorDisplay}</strong>
                          </span>
                          {n.recipient && (
                            <span>
                              收件人：<strong className="text-text-primary font-medium">{resolveActorDisplay(n.recipient)}</strong>
                            </span>
                          )}
                          <span className="hidden">
                          </span>
                          <span>
                            时间：<span className="font-mono text-text-primary">{fmtFullTime(n.createdAt)}</span>
                          </span>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => n.refId && void memoDelete(n.refId)}
                          >
                            删除
                          </Button>
                          <Button
                            variant="primary"
                            size="sm"
                            onClick={() => n.refId && void memoToTodo(n.refId)}
                          >
                            转为事项
                          </Button>
                        </div>
                      </div>
                      <div className="rounded-input bg-bg-card border border-border/70 p-2.5 text-label text-text-primary leading-relaxed whitespace-pre-wrap">
                        {n.summary || n.title}
                      </div>
                      {n.actor === 'unknown:pre-1.0.68' && (
                        <div className="text-caption text-text-secondary">
                          该条为 1.0.68 之前的历史记录，当时尚未分离发件人与收件人字段。
                        </div>
                      )}
                      {parseMemoReplies(n.meta).length > 0 && (
                        <div data-testid="memo-reply-thread" className="grid gap-1.5 pt-1 border-t border-border/50">
                          <div className="text-caption font-medium text-text-secondary">
                            回复记录（{parseMemoReplies(n.meta).length}）
                          </div>
                          {parseMemoReplies(n.meta).map((r) => (
                            <div
                              key={r.id}
                              className="rounded-input bg-surface-subtle border border-border/60 px-2.5 py-2 text-label"
                            >
                              <div className="flex items-center justify-between gap-2 text-caption text-text-secondary mb-1">
                                <span>
                                  <strong className="text-text-primary font-medium">{resolveActorDisplay(r.author)}</strong>
                                  {r.recipient ? ` → ${resolveActorDisplay(r.recipient)}` : ''}
                                </span>
                                <span className="font-mono">{fmtFullTime(r.createdAt)}</span>
                              </div>
                              <div className="text-text-primary whitespace-pre-wrap">{r.text}</div>
                            </div>
                          ))}
                        </div>
                      )}
                      <div className="hidden">
                      </div>
                    </div>
                  </div>
                )}

                {/* 执行回执展开详情：以普通用户可读的操作内容与结果说明展示，不露底层命令行 */}
                {n.type === 'exec_result' && isMemoExpanded && (
                  <div className="px-4 pb-3.5 pt-0.5">
                    <div className="rounded-button border border-border/80 bg-bg-primary p-3 grid gap-2.5 text-label">
                      <div className="grid grid-cols-1 sm:grid-cols-[2fr_1fr_1fr_1fr] gap-3 text-caption">
                        <div className="min-w-0">
                          <div className="text-text-secondary mb-0.5">操作内容</div>
                          <div className="text-text-primary font-medium break-words">
                            {extractExecActionTitle(displayTitle)}
                          </div>
                        </div>
                        <div>
                          <div className="text-text-secondary mb-0.5">申请人</div>
                          <div className="text-text-primary font-medium truncate">{actorDisplay}</div>
                        </div>
                        <div>
                          <div className="text-text-secondary mb-0.5">执行状态</div>
                          <div
                            className={cn(
                              'font-medium',
                              execOk === false ? 'text-danger' : 'text-success'
                            )}
                          >
                            {execOk === false ? '执行未完成' : '已执行完成'}
                          </div>
                        </div>
                        <div>
                          <div className="text-text-secondary mb-0.5">记录时间</div>
                          <div className="text-text-primary font-mono">{fmtFullTime(n.createdAt)}</div>
                        </div>
                      </div>

                      <div className="border-t border-border/50 pt-2 flex items-center justify-between gap-3 flex-wrap text-caption">
                        <span
                          className={cn(
                            execOk === false ? 'text-danger font-medium' : 'text-text-secondary'
                          )}
                        >
                          {humanizeExecSummaryDetail(n.summary, execOk)}
                        </span>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            if (n.refId) setFocusGrantId(n.refId)
                            setMainView('approval')
                          }}
                        >
                          在审批记录中查看
                        </Button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>

        {/* 还有多少条（卡 `cba46119`） */}
        {remaining > 0 && (
          <div className="notification-more flex items-center gap-2 px-4 py-2 rounded-card border border-border bg-bg-card shrink-0">
            <span className="text-label text-text-secondary">还有 {remaining} 条未显示</span>
            <span className="flex-1" />
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void load(filter, pageInfo.nextOffset ?? 0)}
            >
              继续读取
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * 分类筛选 chip（1.0.49）
 */
const FilterChip: React.FC<{
  label: string
  count: number
  active: boolean
  onClick: () => void
}> = ({ label, count, active, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    aria-pressed={active}
    className={cn(
      'inline-flex items-center gap-1 px-2.5 py-1 rounded-tag text-label transition-colors whitespace-nowrap',
      active
        ? 'bg-bg-card text-text-primary font-medium shadow-sm'
        : 'text-text-secondary hover:bg-black/5 hover:text-text-primary'
    )}
  >
    {label}
    <span className="opacity-60 font-mono">{count}</span>
  </button>
)

function parseMetaOk(meta: string | null): boolean | null {
  if (!meta) return null
  try {
    const v = JSON.parse(meta) as { ok?: boolean }
    return typeof v.ok === 'boolean' ? v.ok : null
  } catch {
    return null
  }
}

/**
 * 这条通知是不是"验收未通过被退回"（1.0.72 补，主用户看动态时指出）：
 * 驳回与"交付待验收"共用 `type: 'review'`，靠 `meta.rejected` 区分。
 * 判据：**数据层写了的标记，渲染层必须读**。
 */
function isRejectedNotice(rawMeta: string | null): boolean {
  if (!rawMeta) return false
  try {
    const meta = JSON.parse(rawMeta) as { rejected?: boolean }
    return meta.rejected === true
  } catch {
    return false
  }
}

function parseMemoReplies(
  rawMeta: string | null
): Array<{ id: string; author: string; recipient: string | null; text: string; createdAt: string }> {
  if (!rawMeta) return []
  try {
    const parsed = JSON.parse(rawMeta) as { replies?: unknown }
    return Array.isArray(parsed.replies) ? (parsed.replies as never) : []
  } catch {
    return []
  }
}

function actorLabel(actor: string, humanName?: string | null): string {
  if (actor === 'human') return humanName?.trim() || '我'
  if (actor === 'unknown:pre-1.0.68') return '历史记录（未记发件人）'
  return actor.replace(/^agent:/, '')
}

function fmtFullTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * 将底层 CLI 命令摘要转换为面向普通用户的业务描述（与审批页同源）：
 * - `todo rm「X」` → `删除事项「X」`
 * - `release rm「X」` → `删除版本「X」`
 * - `category rm「X」` → `删除标签「X」`
 * - `ui reset` → `重置界面设置`
 * - `telemetry clear` → `清空统计埋点`
 */
function humanizeCommandSnippet(raw: string): string {
  const s = raw.trim()
  if (!s) return ''
  return s
    .replace(/^todo\s+rm(?:\s+|(?=[「"']))/i, '删除事项 ')
    .replace(/^todo\s+(?:delete|del)(?:\s+|(?=[「"']))/i, '删除事项 ')
    .replace(/^project\s+rm(?:\s+|(?=[「"']))/i, '删除项目 ')
    .replace(/^category\s+rm(?:\s+|(?=[「"']))/i, '删除标签 ')
    .replace(/^memo\s+rm(?:\s+|(?=[「"']))/i, '删除备忘 ')
    .replace(/^release\s+rm(?:\s+|(?=[「"']))/i, '删除版本 ')
    .replace(/^ui\s+reset\b/i, '重置界面设置')
    .replace(/^telemetry\s+clear\b/i, '清空统计埋点')
    .replace(/^ui\s+set\b\s*/i, '修改界面设置 ')
    .replace(/\s+--(?:yes|force)\b/g, '')
    .replace(/删除(事项|项目|标签|备忘|版本)\s+「/g, '删除$1「')
    .trim()
}

export function humanizeNotificationTitle(n: Pick<InboxNotification, 'type' | 'title'>): string {
  const normalized = (n.title || '').replace(/\s+/g, ' ').trim()
  if (!normalized) return '未命名通知'

  if (n.type === 'exec_result') {
    const prefixMatch = normalized.match(/^(已通过并执行|执行失败)[：:]\s*(.+)$/)
    if (prefixMatch) {
      const [, prefix, rest] = prefixMatch
      return `${prefix}：${humanizeCommandSnippet(rest)}`
    }
    return humanizeCommandSnippet(normalized)
  }

  return normalized
}

function extractExecActionTitle(displayTitle: string): string {
  return displayTitle.replace(/^(已通过并执行|执行失败)[：:]\s*/, '').trim() || displayTitle
}

/**
 * 将回执中的底层 CLI 报错或命令行复读转换为自然语言说明：
 * 彻底消除 `--force`、`--yes`、`todo children <id>`、`已执行：release rm ... --yes` 等命令行痕迹。
 */
export function humanizeExecSummaryDetail(
  rawSummary: string | null | undefined,
  execOk: boolean | null
): string {
  const s = (rawSummary ?? '').trim()
  if (!s) {
    return execOk === false ? '操作未完成。' : '已按你的允许执行完毕。'
  }

  // 成功回执若只是复读底层 CLI 命令（如 `已执行：release rm 9.9.8 --project DeskPartner --yes`），转为人话
  if (execOk !== false) {
    if (
      /^已执行[：:]\s*(?:todo|project|category|memo|release|ui|telemetry)\b/i.test(s) ||
      s === '已执行' ||
      s === '已按你的允许执行完毕'
    ) {
      return '已按你的允许执行完毕。'
    }
  }

  // 含子任务的二次确认提示
  const childMatch =
    s.match(/还有\s*(\d+)\s*个子任务/) ?? s.match(/其下\s*(\d+)\s*个子任务/)
  if (childMatch) {
    return `该事项下包含 ${childMatch[1]} 个子任务，需二次确认后删除（删除后子任务将保留为独立事项）。`
  }

  if (s.includes('允许并强制') || s.includes('--force')) {
    return '该事项下包含子任务，需二次确认后执行删除。'
  }

  // 兜底剥离任何残留 CLI 参数提示
  return s
    .replace(/[。；;]?\s*确认要删请加\s*--force[^。]*$/g, '')
    .replace(/[；;]?\s*想先看是哪几条[^。]*$/g, '')
    .replace(/\s*--(?:yes|force|project\s+\S+)\b/g, '')
    .trim()
}

function resolveNotificationSubtitle(
  n: Pick<InboxNotification, 'type' | 'title' | 'summary'>,
  execOk: boolean | null
): string | null {
  if (n.type === 'exec_result') {
    if (execOk === false) {
      return humanizeExecSummaryDetail(n.summary, false)
    }
    return null
  }
  if ((n.type === 'review' || n.type === 'decision') && n.summary) {
    const clean = n.summary.replace(/\s+/g, ' ').trim()
    return clean || null
  }
  return null
}
