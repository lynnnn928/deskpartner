import { useCallback } from 'react'
import {
  DndContext,
  DragOverlay,
  closestCorners,
  PointerSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
  type DragOverEvent
} from '@dnd-kit/core'
import { arrayMove } from '@dnd-kit/sortable'
import { useTodoStore } from '../stores/todo.store'
import { useUIStore } from '../stores/ui.store'
import { BOARD_COLUMNS, STATUS_META } from '../lib/constants'
import type { TodoStatus } from '../types/enums'

/** 看板拖拽排序 Hook */
export function useDragSort() {
  const { todos, updateTodo, setTodos } = useTodoStore()

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 }
    })
  )

  const getTodosByStatus = useCallback(
    (status: TodoStatus) => todos.filter((t) => t.status === status),
    [todos]
  )

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      const { active, over } = event
      if (!over) return

      const activeId = active.id as string
      const overId = over.id as string

      // 找到活跃卡片和目标
      const activeTodo = todos.find((t) => t.id === activeId)
      if (!activeTodo) return

      // 检测是否跨列拖拽
      let newStatus: TodoStatus | null = null

      // overId 可能是列 ID（列的 Droppable id）或另一个卡片 ID
      if (BOARD_COLUMNS.includes(overId as TodoStatus)) {
        newStatus = overId as TodoStatus
      } else {
        const overTodo = todos.find((t) => t.id === overId)
        if (overTodo && overTodo.status !== activeTodo.status) {
          newStatus = overTodo.status
        }
      }

      if (newStatus && newStatus !== activeTodo.status) {
        /**
         * 驳回拦截（1.0.54，主用户 2026-09-28）：
         * 「待验收 → 进行中」= 验收不通过，必须先说清"哪里没做好"。
         *
         * 此前这条流转直接发生、理由只能事后手改描述 —— 于是执行方
         * 收到的是"被退回了"但没有"为什么"，只能盲改。这里拦下来，
         * 弹一个理由输入框，提交时才真正流转（理由同时落成 reject 评论）。
         *
         * 不用 window.prompt：它在这里既丑又阻塞，且拿不到中文输入法。
         * 改成挂起态交给 UI 渲染（见 pendingReject）。
         */
        if (activeTodo.status === 'awaiting_review' && newStatus === 'in_progress') {
          useUIStore.getState().setPendingReject({
            id: activeId,
            title: activeTodo.title,
            snapshot: activeTodo
          })
          return
        }

        // 跨列：乐观更新 + IPC。
        // repo 层守卫（候选池 G1/G2）会拒绝非法迁移并抛错，
        // catch 里回滚 + 把原因透给 UI 层提示，不能让卡片"看起来拖过去了"。
        const optimisticTodos = todos.map((t) =>
          t.id === activeId ? { ...t, status: newStatus!, updatedAt: new Date().toISOString() } : t
        )
        setTodos(optimisticTodos)
        try {
          await updateTodo({ id: activeId, status: newStatus })
          /**
           * 拖拽同样进撤销队列（1.0.48）：拖错列是最常见的手滑，
           * 而"再拖回去"要重新找卡片、还可能被守卫拦（比如拖到待验收再拖回来）。
           * 快照是**拖动前**的整条，撤销即回到原来的列。
           */
          useUIStore.getState().pushUndo({
            id: activeId,
            label: `已移到「${STATUS_META[newStatus].label}」`,
            snapshot: activeTodo
          })
        } catch (err) {
          setTodos(todos) // 回滚
          setBoardError(err instanceof Error ? err.message : String(err))
        }
      }
    },
    [todos, updateTodo, setTodos]
  )

  return { sensors, handleDragEnd, getTodosByStatus }
}

/**
 * 拖拽被拒的全局提示通道。
 *
 * 单独抽出来是因为 useDragSort 在 hook 里拿不到 React state：
 * 错误信息由 KanbanBoard 订阅显示，写坏不炸界面。
 */
let boardErrorListener: ((msg: string) => void) | null = null
export function onBoardError(fn: (msg: string) => void): () => void {
  boardErrorListener = fn
  return () => {
    if (boardErrorListener === fn) boardErrorListener = null
  }
}
function setBoardError(msg: string): void {
  boardErrorListener?.(msg)
}
