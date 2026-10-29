import { useMemo } from 'react'
import { useUIStore } from '../stores/ui.store'
import { useTodoStore } from '../stores/todo.store'
import { countVisibleCards, type BoardVisibility } from '../lib/board-visibility'
import type { TodoFilter } from '../lib/todo-filter'

/**
 * 看板可见性 + 角标数字（f6f78ada）
 *
 * 窗口层（Kanban.tsx）与看板本体（KanbanBoard.tsx）都调它：两处拿到的是
 * **同一次计算**的口径 —— 角标上的 N 与屏幕上的卡片数因此不可能漂开。
 * 判据本身在 lib/board-visibility.ts，这里只负责把 store 里的筛选读出来拼成 scope。
 *
 * 读的就是看板渲染链用的那几个筛选：关键字 / 标签 / 归属 / 项目 / 优先级 / 类型 /
 * 版本 / 创建时间，加上工作空间范围、视角、状态与今天·逾期。
 */
export function useBoardVisibility(): { visibility: BoardVisibility; visibleCount: number } {
  const {
    searchKeyword,
    filterCategory,
    filterOwner,
    filterExecutor,
    filterProject,
    filterProjectIds,
    filterCreatedRange,
    filterPriority,
    filterType,
    filterFixedIn,
    filterStatus,
    filterDue,
    viewScope,
    workspaceMode,
    workItemScope
  } = useUIStore()
  const todos = useTodoStore((s) => s.todos)

  const filter: TodoFilter = useMemo(
    () => ({
      keyword: searchKeyword,
      categoryId: filterCategory,
      owner: filterOwner,
      executor: filterExecutor,
      projectId: filterProject,
      projectIds: filterProjectIds,
      createdRange: filterCreatedRange,
      priority: filterPriority,
      type: filterType,
      fixedIn: filterFixedIn ?? undefined
    }),
    [
      searchKeyword,
      filterCategory,
      filterOwner,
      filterExecutor,
      filterProject,
      filterProjectIds,
      filterCreatedRange,
      filterPriority,
      filterType,
      filterFixedIn
    ]
  )

  const visibility: BoardVisibility = useMemo(
    () => ({ workspaceMode, workItemScope, filterStatus, viewScope, filter, dueScope: filterDue }),
    [workspaceMode, workItemScope, filterStatus, viewScope, filter, filterDue]
  )

  const visibleCount = useMemo(() => countVisibleCards(todos, visibility), [todos, visibility])

  return { visibility, visibleCount }
}
