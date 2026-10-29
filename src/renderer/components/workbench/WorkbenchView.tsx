import React, { useMemo } from 'react'
import { useTodoStore } from '../../stores/todo.store'
import { useProjectStore } from '../../stores/project.store'
import { useUIStore } from '../../stores/ui.store'
import { useSettingsStore } from '../../stores/settings.store'
import { matchesTodoFilter, matchesViewScope, ownerLabel, type TodoFilter } from '../../lib/todo-filter'
import { matchesDueScope } from '../../lib/due-scope'
import { TodoStatusPill, TodoPriorityBadge } from '../ui/Badge'
import { invoke } from '../../lib/ipc-client'
import type { TodoStatus } from '../../types/enums'

const ACTIONABLE: TodoStatus[] = ['proposed', 'todo', 'in_progress', 'awaiting_review']

/**
 * 「我的工作」是行动汇总，不是项目看板的另一套状态筛选。
 * 它只显示仍需处理的事项，并明确标出项目；进入项目后才使用看板列和范围条。
 */
export const WorkbenchView: React.FC = () => {
  const todos = useTodoStore((s) => s.todos)
  const projects = useProjectStore((s) => s.projects)
  const settings = useSettingsStore((s) => s.settings)
  const {
    searchKeyword,
    filterCategory,
    filterOwner,
    filterExecutor,
    filterPriority,
    filterType,
    filterFixedIn,
    filterProjectIds,
    filterCreatedRange,
    filterDue,
    viewScope
  } = useUIStore()

  const filter: TodoFilter = useMemo(() => ({
    keyword: searchKeyword,
    categoryId: filterCategory,
    owner: filterOwner,
    executor: filterExecutor,
    projectId: null,
    projectIds: filterProjectIds,
    createdRange: filterCreatedRange,
    priority: filterPriority,
    type: filterType,
    fixedIn: filterFixedIn ?? undefined
  }), [searchKeyword, filterCategory, filterOwner, filterExecutor, filterPriority, filterType, filterFixedIn, filterProjectIds, filterCreatedRange])

  const grouped = useMemo(() => {
    const archivedProjectIds = new Set(projects.filter((p) => p.archived).map((p) => p.id))
    const visible = todos
      .filter((todo) => !todo.projectId || !archivedProjectIds.has(todo.projectId))
      .filter((todo) => ACTIONABLE.includes(todo.status))
      .filter((todo) => matchesViewScope(todo, viewScope))
      .filter((todo) => matchesTodoFilter(todo, filter))
      .filter((todo) => matchesDueScope(todo, filterDue))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    const groups = new Map<string | null, typeof visible>()
    for (const todo of visible) {
      const list = groups.get(todo.projectId) ?? []
      list.push(todo)
      groups.set(todo.projectId, list)
    }
    return Array.from(groups.entries()).map(([projectId, items]) => ({
      projectId,
      project: projectId ? projects.find((p) => p.id === projectId) : null,
      items
    }))
  }, [todos, projects, filter, filterDue, viewScope])

  const total = grouped.reduce((sum, group) => sum + group.items.length, 0)

  return (
    <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5">
      <div className="max-w-4xl mx-auto flex flex-col gap-3.5">
        <div className="flex items-center justify-between gap-3 px-0.5">
          <h1 className="sr-only">我的工作</h1>
          <span className="text-label font-medium text-text-secondary">按项目汇总待处理事项</span>
          <span className="text-caption text-text-secondary font-mono">共 {total} 条待处理</span>
        </div>

        {grouped.length === 0 ? (
          <div className="rounded-card border border-border bg-bg-card p-10 text-center text-label text-text-secondary">
            当前视角下没有需要处理的事项。
          </div>
        ) : grouped.map((group) => (
          <section key={group.projectId ?? 'none'} className="rounded-card border border-border bg-bg-card shadow-sm overflow-hidden">
            <div className="flex items-center justify-between gap-2 px-4 py-2.5 bg-surface-subtle border-b border-border">
              <div className="flex items-center gap-2 min-w-0">
                <span
                  className="w-2.5 h-2.5 rounded-full shrink-0"
                  style={{ background: group.project?.color ?? 'var(--color-text-secondary)' }}
                />
                <span className="text-content font-semibold text-text-primary truncate">
                  {group.project?.name ?? '未归属项目'}
                </span>
              </div>
              <span className="px-2 py-0.5 rounded-full bg-surface-muted text-caption font-mono text-text-secondary shrink-0">
                {group.items.length}
              </span>
            </div>
            <div className="divide-y divide-border/60">
              {group.items.map((todo) => {
                const actor = todo.executedBy ?? todo.createdBy
                return (
                  <button
                    key={todo.id}
                    type="button"
                    onClick={() => void invoke('window:showQuickAdd', { todoId: todo.id })}
                    className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-surface-subtle transition-colors cursor-pointer"
                  >
                    <div className="w-20 shrink-0">
                      <TodoStatusPill status={todo.status} />
                    </div>
                    <span className="min-w-0 flex-1 truncate text-content font-normal text-text-primary">
                      {todo.title}
                    </span>
                    {(todo.priority === 'urgent' || todo.priority === 'high') && (
                      <TodoPriorityBadge priority={todo.priority} />
                    )}
                    <span className="w-28 shrink-0 text-right truncate text-caption text-text-secondary">
                      {ownerLabel(actor, settings?.humanName)}
                    </span>
                  </button>
                )
              })}
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}
