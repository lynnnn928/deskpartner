import React, { useMemo, useState } from 'react'
import { PanelTodoItem } from './PanelTodoItem'
import { Icon } from '../ui/Icon'
import { useTodoStore } from '../../stores/todo.store'
import { useCategoryStore } from '../../stores/category.store'
import { useProjectStore } from '../../stores/project.store'
import { useSettingsStore } from '../../stores/settings.store'
import { invoke } from '../../lib/ipc-client'
import { compareForPanel } from '../../lib/panel-sort'
import dayjs from 'dayjs'
import type { Todo } from '../../types/todo'

/**
 * 悬浮面板（F2-P0-19：能看、能加、能勾）
 *
 * 就四块，照着 MoliTodo 的悬浮面板来：
 *   1. 一句话进度
 *   2. 一个输入框
 *   3. 一张可勾选的列表
 *   4. 底部完成数
 *
 * 早先这里还塞了归属筛选（全部/我的/AI）、逾期数、今日完成、标签、截止时间，
 * 全砍了。面板宽度只有 300 出头，**它是"扫一眼 + 勾一下"的地方，
 * 不是第二个看板**。要筛选、要整理、要看细节，都去完整看板 ——
 * 两个入口各管一件事，比一个什么都能干的小面板清楚得多。
 */
const LAST_PROJECT_KEY = 'deskpartner.quickAdd.lastProjectId'

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
  const currentProject = useMemo(() => {
    if (selectedProjectId) {
      const hit = activeProjects.find((p) => p.id === selectedProjectId)
      if (hit) return hit
    }
    return activeProjects[0] ?? null
  }, [activeProjects, selectedProjectId])

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
   * 今日完成数
   *
   * 只留这一个数字。它就是底部那句"今天完成 N 件"，
   * 是一天结束时的一个交代，不是用来做决策的指标。
   */
  const doneToday = useMemo(
    () =>
      todos.filter(
        (t) =>
          (!t.projectId || !archivedProjectIds.has(t.projectId)) &&
          t.status === 'done' &&
          t.completedAt &&
          dayjs(t.completedAt).isAfter(today)
      ).length,
    [todos, today, archivedProjectIds]
  )

  /**
   * 列表：只显示未完成的（排除已归档项目）
   *
   * 做完的勾一下就消失——这是勾选这个动作该有的即时反馈。
   * 想找回来去"已完成"列，面板不为它留位置。
   *
   * 「待确认」(proposed) 也不进面板：那是还没拍板的提议，
   * 面板答的是"我现在有什么事"，提议要看去完整看板。
   * 「待验收」保留 —— 它是做完了等确认的事，正是人该在这里扫到并勾掉的。
   */
  const visible = useMemo(
    () =>
      todos
        .filter((t) => !t.projectId || !archivedProjectIds.has(t.projectId))
        .filter((t) => t.status !== 'done' && t.status !== 'proposed' && t.status !== 'discarded')
        .sort(compareForPanel),
    [todos, archivedProjectIds]
  )

  const handleAdd = async () => {
    let title = draft.trim()
    if (!title) return
    let targetProject = currentProject
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
      {/* ── 1. 一句话进度 + 快捷登记归属项目切换 ── */}
      <div className="px-3.5 pt-3 pb-2 shrink-0 flex items-center justify-between gap-2 relative">
        <span className="text-column-title font-medium text-text-primary">
          {visible.length > 0 ? `${visible.length} 项事项` : '都做完了'}
        </span>
        {currentProject && (
          <div className="relative">
            <button
              type="button"
              data-testid="panel-project-trigger"
              onClick={() => setProjectMenuOpen((v) => !v)}
              title="切换快捷登记归属的项目"
              className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-surface-subtle hover:bg-surface-muted border border-border/60 text-caption text-text-secondary hover:text-text-primary transition-colors max-w-36 cursor-pointer"
            >
              <span
                className="w-2 h-2 rounded-full shrink-0"
                style={{ background: currentProject.color }}
              />
              <span className="truncate">{currentProject.name}</span>
              <Icon name="chevronLeft" size={11} className="shrink-0 opacity-70 -rotate-90" />
            </button>
            {projectMenuOpen && activeProjects.length > 0 && (
              <div
                role="listbox"
                aria-label="选择归属项目"
                className="absolute right-0 top-full mt-1 z-50 min-w-36 max-h-48 overflow-y-auto rounded-card border border-border bg-bg-card p-1 shadow-float"
              >
                {activeProjects.map((proj) => {
                  const active = proj.id === currentProject.id
                  return (
                    <button
                      key={proj.id}
                      type="button"
                      role="option"
                      aria-selected={active}
                      onClick={() => selectProject(proj.id)}
                      className="w-full flex items-center gap-2 px-2 py-1.5 rounded-button text-label text-left hover:bg-surface-subtle transition-colors"
                    >
                      <span
                        className="w-2 h-2 rounded-full shrink-0"
                        style={{ background: proj.color }}
                      />
                      <span className="flex-1 truncate text-text-primary">{proj.name}</span>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── 2. 输入框：能加 ── */}
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
        </div>
      </div>

      {/* ── 3. 列表：能看、能勾 ── */}
      <div className="flex-1 overflow-y-auto px-2 pb-1">
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
        <span className="text-label text-text-secondary">
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
