import React from 'react'
import { useDroppable } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { ColumnHeader } from './ColumnHeader'
import { TodoCard } from './TodoCard'
import { EmptyColumn } from './EmptyColumn'
import { cn } from '../../lib/utils'
import { STATUS_META } from '../../lib/constants'
import type { Todo } from '../../types/todo'
import type { TodoStatus } from '../../types/enums'
import { useSettingsStore } from '../../stores/settings.store'
import { useUIStore } from '../../stores/ui.store'
import { Icon } from '../ui/Icon'

interface KanbanColumnProps {
  status: TodoStatus
  todos: Todo[]
  /** 折叠成窄竖条：只留识别点 + 计数 + 竖排名 */
  collapsed?: boolean
  onToggle?: (status: TodoStatus) => void
  onEdit: (id: string) => void
  onDelete: (id: string) => void
  onPin: (id: string) => void
  /** 在该列直接新增：目标位置就在手边，不必先建完再拖过来 */
  onAdd: (status: TodoStatus) => void
}

export const KanbanColumn: React.FC<KanbanColumnProps> = ({
  status,
  todos,
  collapsed = false,
  onToggle,
  onEdit,
  onDelete,
  onPin,
  onAdd
}) => {
  const { settings } = useSettingsStore()
  const columnWidth = useUIStore((s) => s.kanbanColumnWidth)
  const setColumnWidth = useUIStore((s) => s.setKanbanColumnWidth)
  const { setNodeRef, isOver } = useDroppable({ id: status })
  const config = STATUS_META[status]

  const spacingMap = {
    compact: 'gap-1.5',
    standard: 'gap-card-gap',
    spacious: 'gap-3'
  }

  const handleResizePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const startWidth = columnWidth

    const onMove = (moveEvent: PointerEvent) => {
      const delta = moveEvent.clientX - startX
      setColumnWidth(startWidth + delta)
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  /**
   * 折叠态：一条窄竖条
   *
   * 折叠不是隐藏 —— 「已完成」几百条时人还是想知道"那边堆了多少"，
   * 所以竖条上保留识别点和计数，内容一条不删，点一下全回来。
   * 竖排名从上往下读，符合"从上往下扫一列"的既有动线。
   */
  if (collapsed) {
    return (
      <button
        type="button"
        onClick={() => onToggle?.(status)}
        className={cn(
          'shrink-0 w-10 rounded-card bg-column-surface border border-border/60 overflow-hidden flex flex-col',
          'items-center py-3 gap-2.5 transition-colors cursor-pointer',
          'hover:bg-surface-muted hover:border-border'
        )}
        title={`展开「${config.label}」列`}
        aria-label={`展开「${config.label}」列`}
      >
        <span
          className="w-2 h-2 rounded-full shrink-0"
          style={{ backgroundColor: `var(${config.colorVar})` }}
          aria-hidden
        />
        <span className="px-1.5 py-0.5 rounded-full bg-surface-muted font-mono text-caption text-text-secondary">
          {todos.length}
        </span>
        <span
          className="text-label font-medium text-text-secondary tracking-wide"
          style={{ writingMode: 'vertical-rl' }}
        >
          {config.label}
        </span>
        <Icon name="chevronLeft" size={11} className="mt-auto rotate-180 text-text-secondary/60" />
      </button>
    )
  }

  return (
    <div
      ref={setNodeRef}
      className={cn(
        'relative flex flex-col shrink-0 rounded-card overflow-hidden',
        'bg-column-surface border border-border/60 transition-colors',
        isOver && 'ring-2 ring-accent/40'
      )}
      style={{
        borderRadius: settings.cardBorderRadius,
        width: columnWidth
      }}
    >
      <ColumnHeader status={status} count={todos.length} onToggle={onToggle} />

      <SortableContext items={todos.map((t) => t.id)} strategy={verticalListSortingStrategy}>
        <div
          className={cn(
            'flex-1 overflow-y-auto p-2.5 flex flex-col',
            spacingMap[settings.cardSpacing]
          )}
        >
          {todos.length === 0 ? (
            <EmptyColumn />
          ) : (
            todos.map((todo) => (
              <TodoCard
                key={todo.id}
                todo={todo}
                onEdit={onEdit}
                onDelete={onDelete}
                onPin={onPin}
              />
            ))
          )}
        </div>
      </SortableContext>

      {/*
        列内新增：放在列底部而不是只留顶栏那个全局「+ 新增」——
        用户想把任务放进"进行中"时，目标位置就在手边，
        不需要先建好再拖过去，也不需要记住这回事。
        "已完成"与"已废弃"列不给入口：往终态列里直接加任务没有意义
        （废弃是「不做了」的结论，凭空新建一条等于自相矛盾）。
      */}
      {status !== 'done' && status !== 'discarded' && (
        <div className="shrink-0 px-2.5 pb-2.5 pt-1">
          <button
            type="button"
            onClick={() => onAdd(status)}
            className={cn(
              'w-full py-1.5 rounded-button text-label',
              'border border-dashed border-border/80 text-text-secondary',
              'hover:border-text-secondary/60 hover:bg-bg-card/60 hover:text-text-primary transition-colors cursor-pointer'
            )}
          >
            + 添加事项
          </button>
        </div>
      )}

      {/* 右侧边缘拖拽调节列宽手柄（双击恢复默认 288px） */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="拖动调节泳道列宽"
        title="拖动调节列宽（双击恢复默认宽度）"
        onPointerDown={handleResizePointerDown}
        onDoubleClick={() => setColumnWidth(288)}
        className="absolute right-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-accent/20 active:bg-accent/35 transition-colors z-10"
      />
    </div>
  )
}
