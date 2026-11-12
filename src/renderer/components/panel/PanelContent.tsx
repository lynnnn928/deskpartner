import React, { useMemo, useState } from 'react'
import { PanelTodoItem } from './PanelTodoItem'
import { Icon } from '../ui/Icon'
import { useTodoStore } from '../../stores/todo.store'
import { useCategoryStore } from '../../stores/category.store'
import { useProjectStore } from '../../stores/project.store'
import { useSettingsStore } from '../../stores/settings.store'
import { invoke } from '../../lib/ipc-client'
import { compareForPanel } from '../../lib/panel-sort'
import { stageQuickAddTitle } from '../../lib/quick-add-handoff'
import dayjs from 'dayjs'
import type { Todo } from '../../types/todo'

/**
 * 悬浮面板（F2-P0-19：能看、能加、能勾）
 *
 * 就四块，照着 MoliTodo 的悬浮面板来：
 *   1. 一句话进度 + 项目切换
 *   2. 一个输入框（能展开成完整登记）
 *   3. 一张可勾选的列表
 *   4. 底部完成数
 *
 * 早先这里还塞了归属筛选（全部/我的/AI）、逾期数、今日完成、标签、截止时间，
 * 全砍了。面板宽度只有 300 出头，**它是"扫一眼 + 勾一下"的地方，
 * 不是第二个看板**。要筛选、要整理、要看细节，都去完整看板 ——
 * 两个入口各管一件事，比一个什么都能干的小面板清楚得多。
 *
 * ── 项目切换 = 视图切换（卡 `4ad4f68d`，2026-11-12 主用户改的）──
 *
 * 这个按钮原来只决定"新条目挂哪个项目"：按钮写着 DeskPartner，清单里却混着
 * 其他项目的事、表头还是全局的 117 项。现在它切换的是**视图**：
 * 列表只留当前项目的，表头数字与底部"今天完成"同口径。
 */
const LAST_PROJECT_KEY = 'deskpartner.quickAdd.lastProjectId'

/** 「未归属项目」那一档视图的 id（不是真项目，只在有这种事项时出现） */
const UNASSIGNED_ID = '__unassigned__'
/** 没有项目的事项怎么称呼（与 CLI `todo list`、工作台同一口径） */
const UNASSIGNED_NAME = '未归属项目'
const UNASSIGNED_COLOR = '#8E8E93'

interface PanelView {
  id: string
  name: string
  color: string
  /** 这不是真项目，而是"没有归属"的那一档 */
  unassigned?: boolean
}

export const PanelContent: React.FC = () => {
  const { todos, createTodo, updateTodo } = useTodoStore()
  const { categories } = useCategoryStore()
  const { projects } = useProjectStore()
  const { settings } = useSettingsStore()

  const [draft, setDraft] = useState('')
  const [projectMenuOpen, setProjectMenuOpen] = useState(false)
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(() => {
    try {
      return window.localStorage.getItem(LAST_PROJECT_KEY)
    } catch {
      return null
    }
  })

  const activeProjects = useMemo(() => projects.filter((p) => !p.archived), [projects])
  const archivedProjectIds = useMemo(
    () => new Set(projects.filter((p) => p.archived).map((p) => p.id)),
    [projects]
  )

  /**
   * 面板认的那些事项：未完成、非提议、非丢弃，且不属于已归档项目
   *
   * 做完的勾一下就消失——这是勾选这个动作该有的即时反馈。
   * 想找回来去"已完成"列，面板不为它留位置。
   *
   * 「待确认」(proposed) 也不进面板：那是还没拍板的提议，
   * 面板答的是"我现在有什么事"，提议要看去完整看板。
   * 「待验收」保留 —— 它是做完了等确认的事，正是人该在这里扫到并勾掉的。
   */
  const openTodos = useMemo(
    () =>
      todos
        .filter((t) => !t.projectId || !archivedProjectIds.has(t.projectId))
        .filter((t) => t.status !== 'done' && t.status !== 'proposed' && t.status !== 'discarded'),
    [todos, archivedProjectIds]
  )

  /**
   * 没有归属项目的事项（CLI 不带 `--project` 建的那种）
   *
   * 项目视图按归属过滤，这一档就没地方去了 —— 而"看不见"正是最糟的处置。
   * 所以真有这种事项时，项目菜单里多一档专给它们；没有就不出现。
   */
  const unassignedCount = useMemo(() => openTodos.filter((t) => !t.projectId).length, [openTodos])

  const views = useMemo<PanelView[]>(
    () => [
      ...activeProjects.map((p) => ({ id: p.id, name: p.name, color: p.color })),
      ...(unassignedCount > 0
        ? [{ id: UNASSIGNED_ID, name: UNASSIGNED_NAME, color: UNASSIGNED_COLOR, unassigned: true }]
        : [])
    ],
    [activeProjects, unassignedCount]
  )

  const currentView = useMemo<PanelView | null>(() => {
    if (selectedProjectId) {
      const hit = views.find((v) => v.id === selectedProjectId)
      if (hit) return hit
    }
    return views[0] ?? null
  }, [views, selectedProjectId])

  const selectProject = (id: string) => {
    setSelectedProjectId(id)
    setProjectMenuOpen(false)
    try {
      window.localStorage.setItem(LAST_PROJECT_KEY, id)
    } catch {
      /* ignore */
    }
  }

  const today = dayjs().startOf('day')

  /**
   * 当前视图下的事项
   *
   * 一个在办项目都没有时**不过滤**：那时候 `currentView` 是 null，
   * 按项目过滤只会把面板变成空的 —— 而"没有项目"本身就是一件该看见的事。
   */
  const visible = useMemo(() => {
    if (!currentView) return openTodos.slice().sort(compareForPanel)
    return openTodos
      .filter((t) =>
        currentView.unassigned ? !t.projectId : t.projectId === currentView.id
      )
      .sort(compareForPanel)
  }, [openTodos, currentView])

  /**
   * 今日完成数（与上面同一个口径）
   *
   * 它就是底部那句"今天完成 N 件"，是一天结束时的一个交代，不是用来做决策的指标。
   * 既然视图切到了某个项目，这个数字也得是同一条范围 —— 否则"今天完成 3 件"
   * 会让人以为这个项目今天就完成了 3 件。
   */
  const doneToday = useMemo(() => {
    const scope = (t: Todo): boolean => {
      if (archivedProjectIds.has(t.projectId ?? '')) return false
      if (!currentView) return true
      return currentView.unassigned ? !t.projectId : t.projectId === currentView.id
    }
    return todos.filter(
      (t) => scope(t) && t.status === 'done' && t.completedAt && dayjs(t.completedAt).isAfter(today)
    ).length
  }, [todos, today, archivedProjectIds, currentView])

  /**
   * 新增落在哪儿
   *
   * 视图是「未归属项目」时不往那种地方记（项目在应用里是必填的）：
   * 落到第一个在办项目，并在保存后把视图切过去 —— 记完就能看见它。
   */
  const createTarget = useMemo(
    () => (currentView && !currentView.unassigned ? currentView : (activeProjects[0] ?? null)),
    [currentView, activeProjects]
  )

  const handleAdd = async () => {
    let title = draft.trim()
    if (!title) return
    let targetProject = createTarget
    // 支持 #项目名 标题 快捷指定项目
    if (title.startsWith('#')) {
      const spaceIdx = title.indexOf(' ')
      if (spaceIdx > 1) {
        const prefixName = title.slice(1, spaceIdx).trim().toLowerCase()
        const bodyTitle = title.slice(spaceIdx + 1).trim()
        const matched = activeProjects.find((p) => p.name.toLowerCase() === prefixName)
        if (matched && bodyTitle) {
          targetProject = matched
          title = bodyTitle
        }
      }
    }
    if (targetProject) {
      try {
        window.localStorage.setItem(LAST_PROJECT_KEY, targetProject.id)
      } catch {
        /* ignore */
      }
      setSelectedProjectId(targetProject.id)
    }
    // 面板里速记的都归"人"：这是人在界面上敲的，不是 agent 投递的；默认挂靠当前选中项目
    await createTodo({
      title,
      createdBy: 'human',
      projectId: targetProject?.id ?? undefined,
      categoryIds: categories[0] ? [categories[0].id] : undefined
    })
    setDraft('')
  }

  /**
   * 展开完整登记（卡 `4ad4f68d`）
   *
   * 这一行只收一句话；描述 / 优先级 / 截止 / 标签 / 附件都在速记那张完整卡片上。
   * 已经敲进去的那一句**带过去**（跨窗口一次性交接）—— 点了展开字却没了，
   * 那就不是"展开"而是"清空"。
   */
  const openFullForm = () => {
    stageQuickAddTitle(draft)
    setDraft('')
    invoke('window:showQuickAdd', { projectId: createTarget?.id })
  }

  const handleToggle = async (todo: Todo) => {
    // 待验收的勾 = 验收通过转 done；待办/进行中/挂起的勾 = 完成
    const next = todo.status === 'done' ? 'todo' : 'done'
    await updateTodo({ id: todo.id, status: next })
  }

  const handleOpen = (id: string) => {
    invoke('window:showQuickAdd', { todoId: id })
  }

  return (
    <div
      className="h-full w-full flex flex-col overflow-hidden window-frame frosted-glass"
      style={{ borderRadius: settings.quickAddBorderRadius }}
    >
      {/* ── 1. 一句话进度 + 项目视图切换 ── */}
      <div className="px-3.5 pt-3 pb-2 shrink-0 flex items-center justify-between gap-2 relative">
        <span data-testid="panel-count" className="text-column-title font-medium text-text-primary truncate">
          {visible.length > 0 ? `${visible.length} 项事项` : '都做完了'}
        </span>
        {currentView && (
          <div className="relative shrink-0">
            <button
              type="button"
              data-testid="panel-project-trigger"
              onClick={() => setProjectMenuOpen((v) => !v)}
              title="切换项目：清单只显示这个项目的"
              className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-surface-subtle hover:bg-surface-muted border border-border/60 text-caption text-text-secondary hover:text-text-primary transition-colors max-w-36 cursor-pointer"
            >
              <span
                className="w-2 h-2 rounded-full shrink-0"
                style={{ background: currentView.color }}
              />
              <span className="truncate">{currentView.name}</span>
              <Icon name="chevronLeft" size={11} className="shrink-0 opacity-70 -rotate-90" />
            </button>
            {projectMenuOpen && views.length > 0 && (
              <div
                role="listbox"
                aria-label="选择要看的项目"
                className="absolute right-0 top-full mt-1 z-50 min-w-36 max-h-48 overflow-y-auto rounded-card border border-border bg-bg-card p-1 shadow-float"
              >
                {views.map((view) => {
                  const active = view.id === currentView.id
                  return (
                    <button
                      key={view.id}
                      type="button"
                      role="option"
                      aria-selected={active}
                      data-testid="panel-project-option"
                      onClick={() => selectProject(view.id)}
                      className="w-full flex items-center gap-2 px-2 py-1.5 rounded-button text-label text-left hover:bg-surface-subtle transition-colors"
                    >
                      <span
                        className="w-2 h-2 rounded-full shrink-0"
                        style={{ background: view.color }}
                      />
                      <span className="flex-1 truncate text-text-primary">{view.name}</span>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── 2. 输入框：能加，也能展开成完整登记 ── */}
      <div className="px-3.5 pb-2 shrink-0">
        <div className="flex items-center gap-1.5">
          <Icon name="plus" size={14} className="text-text-secondary shrink-0" />
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                handleAdd()
              }
              if (e.key === 'Escape') {
                invoke('window:hidePanel')
              }
            }}
            placeholder="记一件事，回车保存"
            className="flex-1 bg-transparent text-content outline-none placeholder:text-text-secondary/60"
          />
          <button
            type="button"
            data-testid="panel-expand-full"
            onClick={openFullForm}
            title="展开完整登记：描述、优先级、截止时间、标签、附件"
            className="shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-button
              text-caption text-text-secondary hover:text-accent transition-colors cursor-pointer"
          >
            <Icon name="layoutWindow" size={12} />
            完整登记
          </button>
        </div>
      </div>

      {/* ── 3. 列表：能看、能勾 ── */}
      <div data-testid="panel-list" className="flex-1 overflow-y-auto px-2 pb-1">
        {visible.length === 0 ? (
          <p className="text-label text-text-secondary text-center py-8">这里空着</p>
        ) : (
          visible.map((t) => (
            <PanelTodoItem key={t.id} todo={t} onToggle={handleToggle} onOpen={handleOpen} />
          ))
        )}
      </div>

      {/* ── 4. 底部：完成数 + 去完整看板 ── */}
      <div className="px-3.5 py-2 border-t border-border flex items-center gap-2 shrink-0">
        <span data-testid="panel-done-today" className="text-label text-text-secondary">
          今天完成 {doneToday} 件
        </span>
        <button
          type="button"
          onClick={() => invoke('window:showKanban')}
          className="ml-auto inline-flex items-center gap-1 text-label text-text-secondary
            hover:text-accent transition-colors"
        >
          <Icon name="layoutBoard" size={12} />
          看板
        </button>
      </div>
    </div>
  )
}
