import React from 'react'
import { Icon } from '../ui/Icon'
import { cn } from '../../lib/utils'
import { useProjectStore } from '../../stores/project.store'
import { useSettingsStore } from '../../stores/settings.store'
import { ownerLabel } from '../../lib/todo-filter'
import type { Todo } from '../../types/todo'

interface PanelTodoItemProps {
  todo: Todo
  onToggle: (todo: Todo) => void
  onOpen: (id: string) => void
}

/**
 * 面板里的一条事项
 *
 * 只保留三样东西：勾选圈、标题、AI 角标。
 *
 * 项目色带、标签、截止时间全砍了 —— 面板宽度只有 300 出头，
 * 一行里挤四样信息的结果是**标题没地方放**，而标题才是这条事项本身。
 * 那些信息在看板卡片上都有，要看就打开看板。
 *
 * 唯一例外是 AI 角标：人机共享里"这条不是我记的"是必须一眼看出的。
 */
export const PanelTodoItem: React.FC<PanelTodoItemProps> = ({ todo, onToggle, onOpen }) => {
  const { getProject } = useProjectStore()
  const { settings } = useSettingsStore()

  const isDone = todo.status === 'done'
  const isAgent = todo.createdBy.startsWith('agent:')
  const agentName = isAgent ? ownerLabel(todo.createdBy, settings?.humanName) : ''
  const project = getProject(todo.projectId)

  return (
    <div className="group relative flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 transition-colors">
      {/* 项目色带：一条 2px 竖线，比一个色块省地方，仍能表达"这伙是一起的" */}
      {project && (
        <span
          className="absolute left-0 top-1 bottom-1 w-0.5 rounded-full"
          style={{ backgroundColor: project.color }}
          title={`项目：${project.name}`}
        />
      )}

      {/*
        勾选圈：点击即切换完成态
        不用原生 checkbox —— 它在透明窗口里各平台渲染差异大，
        而这里要与整体描边风格一致。
      */}
      <button
        type="button"
        onClick={() => onToggle(todo)}
        title={isDone ? '标为未完成' : '标为已完成'}
        className={cn(
          'shrink-0 h-3.75 w-3.75 rounded-full border-1.5 flex items-center justify-center',
          'transition-colors',
          isDone
            ? 'border-status-done bg-status-done text-white'
            : 'border-border hover:border-accent'
        )}
      >
        {isDone && <Icon name="checkCircle" size={9} strokeWidth={3} />}
      </button>

      <button
        type="button"
        onClick={() => onOpen(todo.id)}
        title="点击打开详情"
        className="flex-1 min-w-0 text-left flex items-center gap-1.5"
      >
        <span
          className={cn(
            'text-content leading-snug truncate',
            isDone && 'line-through text-text-done'
          )}
        >
          {todo.title}
        </span>
        {isAgent && (
          <span
            className="shrink-0 inline-flex items-center gap-0.5 text-label text-purple-500"
            title={`由 ${agentName} 登记`}
          >
            <Icon name="bot" size={10} />
            {agentName}
          </span>
        )}
      </button>
    </div>
  )
}
