import React, { useState } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { cn, shortId } from '../../lib/utils'
import { CardActions } from './CardActions'
import { Icon } from '../ui/Icon'
import { useCategoryStore } from '../../stores/category.store'
import { useProjectStore } from '../../stores/project.store'
import { useSettingsStore } from '../../stores/settings.store'
import { useTodoStore } from '../../stores/todo.store'
import { useUIStore } from '../../stores/ui.store'
import { PRIORITY_META, TYPE_META } from '../../lib/constants'
import { ownerLabel } from '../../lib/todo-filter'
import { formatDate, formatDueDate, isOverdue } from '../../lib/date'
import type { Todo } from '../../types/todo'

interface TodoCardProps {
  todo: Todo
  onEdit: (id: string) => void
  onDelete: (id: string) => void
  onPin: (id: string) => void
}

export const TodoCard: React.FC<TodoCardProps> = ({ todo, onEdit, onDelete, onPin }) => {
  const { getCategoryColor, getCategoryName } = useCategoryStore()
  const { getProject } = useProjectStore()
  const { settings } = useSettingsStore()
  const todos = useTodoStore((s) => s.todos)
  const [isHovered, setIsHovered] = useState(false)
  /**
   * 多选（批量操作模式，2026-09-24）
   *
   * 状态与 setter 早在 ui.store 里备好了（`multiSelectMode` / `selectedIds`），
   * 只是界面一直没有引用 —— 通道通了没人用。这里把它接上：
   * 选中态在卡片上直接看得见（描边 + 勾选框），不靠"我记得点过哪几张"。
   */
  const multiSelectMode = useUIStore((s) => s.multiSelectMode)
  const isSelected = useUIStore((s) => s.selectedIds.includes(todo.id))
  const toggleSelectId = useUIStore((s) => s.toggleSelectId)
  const workspaceMode = useUIStore((s) => s.workspaceMode)

  const project = getProject(todo.projectId)
  /**
   * v12 起提出者/执行者分离：
   * - 提出者（createdBy）是"这条谁记的"，徽标沿用原 owner 的 bot 图标语义
   * - 执行者（executedBy）非空说明"提出和执行不是同一人"（如 agent 报 bug 给用户修），
   *   这种分离态才显示执行者 —— 绝大多数事项提出即执行，标了等于没标
   */
  const isAgent = todo.createdBy.startsWith('agent:')
  const agentName = isAgent ? ownerLabel(todo.createdBy, settings?.humanName) : ''
  const executedBy = todo.executedBy
  const isExecutedByOther = !!executedBy && executedBy !== todo.createdBy
  const executedName = executedBy && isExecutedByOther ? ownerLabel(executedBy, settings?.humanName) : ''
  // task 不显示徽标：整屏都是徽标等于没有徽标（与优先级色点同一原则）
  const typeMeta = todo.type !== 'task' ? TYPE_META[todo.type] : null

  /**
   * 子任务进度 n/m（仅父需求显示）。
   *
   * 父需求转「待验收」前的状态一眼可判：6 个子任务做了 4 个，
   * 卡片上直接读出来，不用点开逐条数。
   * store 里有全量 todos，在这里过滤即可，不需要新 IPC。
   */
  const childStats = React.useMemo(() => {
    const children = todos.filter((t) => t.parentId === todo.id)
    if (!children.length) return null
    return {
      total: children.length,
      done: children.filter((t) => t.status === 'done').length
    }
  }, [todos, todo.id])

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging
  } = useSortable({ id: todo.id })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    borderRadius: settings.cardBorderRadius
  }

  const isDone = todo.status === 'done'

  // 优先级只在 urgent / high 时显示色点：整屏都是点就等于没有点
  const showPriorityDot = !isDone && (todo.priority === 'urgent' || todo.priority === 'high')
  // 已完成的任务不再标逾期 —— 迟到但做完了，不必再红着一张脸
  const overdue = !isDone && isOverdue(todo.dueAt)

  return (
    <div
      ref={multiSelectMode ? undefined : setNodeRef}
      style={multiSelectMode ? undefined : style}
      // 批量模式下不挂拖拽：单击＝勾选，拖拽手势会与"点一下选中"打架
      {...(multiSelectMode ? {} : attributes)}
      {...(multiSelectMode ? {} : listeners)}
      /**
       * 双击打开弹窗，不必先去找卡片上那个小按钮 ——
       * "要看详情却得先找到编辑图标"是没必要的门槛。
       *
       * 与拖拽不冲突：PointerSensor 配了 5px 激活阈值（见 useDragSort），
       * 静止的双击达不到阈值，不会被判定成拖拽。
       * 批量模式下双击让位给"勾选"，避免手一抖把详情弹出来。
       */
      onClick={() => {
        if (multiSelectMode) toggleSelectId(todo.id)
      }}
      onDoubleClick={() => {
        if (multiSelectMode) return
        if (isDragging) return
        onEdit(todo.id)
      }}
      title={multiSelectMode ? (isSelected ? '点击取消选中' : '点击选中') : '双击查看详情'}
      className={cn(
        'group relative bg-bg-card border border-border/80 p-card flex flex-col gap-2',
        multiSelectMode ? 'cursor-pointer' : 'cursor-grab active:cursor-grabbing',
        'transition-shadow',
        isDragging && 'shadow-drag scale-105 opacity-90 z-50',
        !isDragging && 'shadow-card hover:shadow-card-hover hover:border-border',
        isDone && 'opacity-70',
        isSelected && 'ring-1 ring-accent border-accent bg-accent/5'
      )}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {/*
        项目色带：仅在跨项目视图（非单项目看板）下显示卡片左缘竖色条。
        进入单个项目空间后，所有卡片均属于当前项目，不重复渲染左缘蓝条，避免整列泛蓝杂乱。
      */}
      {project && workspaceMode !== 'project' && (
        <span
          className="absolute left-0 top-0 bottom-0 w-0.75 rounded-l-[inherit]"
          style={{ backgroundColor: project.color }}
          title={`项目：${project.name}`}
        />
      )}

      {/*
        ── 第一层（顶栏标识行）：多选框 + 短编号 + 类型 + 解决版本 + 子任务进度 | 右侧悬停操作或置顶图标 ──
        参考 Linear 三段式卡片结构，将编号/类型/版本上移至顶栏，彻底解放底栏空间。
      */}
      <div className="flex items-center justify-between gap-2 min-h-5 text-caption text-text-secondary">
        <div className="flex items-center gap-1.5 min-w-0 overflow-hidden">
          {multiSelectMode && (
            <span
              aria-hidden
              className={cn(
                'shrink-0 w-4 h-4 rounded-xs border flex items-center justify-center transition-colors',
                isSelected ? 'bg-accent border-accent text-white' : 'border-border bg-bg-card'
              )}
            >
              {isSelected && (
                <svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                  <path
                    d="M2.5 6.2L5 8.7L9.5 3.5"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              )}
            </span>
          )}

          <span
            className="font-mono text-caption text-text-secondary/75 shrink-0"
            title={`事项编号 ${shortId(todo.id)}（可直接用于 CLI，如 dp todo update ${shortId(todo.id)}）`}
          >
            #{shortId(todo.id)}
          </span>

          {typeMeta && (
            <span
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-xs bg-surface-subtle text-caption font-medium text-text-primary shrink-0"
              title={`类型：${typeMeta.label}`}
            >
              <span
                className="w-1.5 h-1.5 rounded-full shrink-0"
                style={{ backgroundColor: typeMeta.color }}
              />
              {typeMeta.label}
            </span>
          )}

          {todo.fixedInVersion && (
            <span
              className="inline-flex items-center px-1.5 py-0.5 rounded-xs bg-surface-subtle text-caption font-mono text-text-secondary shrink-0"
              title={`解决于版本 ${todo.fixedInVersion}`}
            >
              v{todo.fixedInVersion}
            </span>
          )}

          {childStats && (
            <button
              type="button"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => onEdit(todo.id)}
              className={cn(
                'inline-flex items-center gap-0.5 text-caption shrink-0 rounded-xs px-1 py-0.5',
                'hover:bg-surface-muted transition-colors cursor-pointer',
                childStats.done === childStats.total
                  ? 'text-status-in-progress font-medium'
                  : 'text-text-secondary'
              )}
              title={`子任务已完成 ${childStats.done}/${childStats.total}`}
            >
              <Icon name="gitBranch" size={11} />
              <span className="font-mono">{childStats.done}/{childStats.total}</span>
            </button>
          )}
        </div>

        <div className="flex items-center shrink-0">
          {isHovered || settings.cardActionsAlwaysVisible ? (
            <CardActions
              todoId={todo.id}
              isPinned={todo.isPinned}
              onEdit={onEdit}
              onDelete={onDelete}
              onPin={onPin}
            />
          ) : (
            todo.isPinned && <Icon name="pin" size={12} className="text-accent shrink-0" />
          )}
        </div>
      </div>

      {/* ── 第二层（中段核心区）：优先级色点 + 事项标题（两行封顶） ── */}
      <div className="flex items-start gap-1.5">
        {showPriorityDot && (
          <span
            className="mt-1.5 h-2 w-2 rounded-full shrink-0"
            style={{ backgroundColor: PRIORITY_META[todo.priority].color }}
            title={`${PRIORITY_META[todo.priority].label}优先级`}
          />
        )}
        <p
          className={cn(
            'text-content font-normal text-text-primary leading-snug break-words min-w-0 line-clamp-2',
            isDone && 'line-through text-text-done'
          )}
        >
          {todo.title}
        </p>
      </div>

      {/* ── 第三层（底栏归属与时间行）：左侧提出者/执行人完整展示，右侧日期时间 ── */}
      <div className="flex items-center justify-between gap-2 pt-0.5 text-caption text-text-secondary">
        <div className="flex items-center gap-1.5 min-w-0 overflow-hidden">
          {isAgent ? (
            <span
              className="inline-flex items-center gap-1 text-caption text-text-secondary min-w-0 truncate"
              title={`由 ${agentName} 提出${isExecutedByOther ? `，${executedName} 执行` : ''}`}
            >
              <Icon name="bot" size={11} className="shrink-0 text-text-secondary/80" />
              <span className="truncate">{agentName}</span>
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-caption text-text-secondary/80 min-w-0 truncate">
              <Icon name="user" size={11} className="shrink-0 text-text-secondary/70" />
              <span className="truncate">{ownerLabel(todo.createdBy, settings?.humanName)}</span>
            </span>
          )}

          {isExecutedByOther && (
            <span
              className="inline-flex items-center gap-1 text-caption text-text-secondary min-w-0 truncate"
              title={`提出者 ${agentName || ownerLabel(todo.createdBy, settings?.humanName)}，执行者 ${executedName}`}
            >
              <span aria-hidden className="text-text-secondary/60">→</span>
              <Icon name={todo.executedBy === 'human' ? 'user' : 'bot'} size={11} className="shrink-0" />
              <span className="truncate">{executedName}</span>
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5 shrink-0 font-mono text-caption text-text-secondary/80">
          {todo.remindAt && (
            <span className="text-accent inline-flex items-center gap-1 shrink-0" title="提醒时间">
              <Icon name="clock" size={11} />
              {formatDate(todo.remindAt)}
            </span>
          )}
          {todo.dueAt ? (
            <span
              className={cn(
                'inline-flex items-center gap-1 shrink-0',
                overdue ? 'text-danger font-medium' : 'text-text-secondary'
              )}
              title={overdue ? '已逾期' : '截止时间'}
            >
              <Icon name="calendar" size={11} />
              {formatDueDate(todo.dueAt)}
            </span>
          ) : (
            <span>{formatDate(todo.createdAt)}</span>
          )}
        </div>
      </div>
    </div>
  )
}
