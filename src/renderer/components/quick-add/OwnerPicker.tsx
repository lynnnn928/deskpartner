import React, { useEffect, useState } from 'react'
import { useTodoStore } from '../../stores/todo.store'
import { useSettingsStore } from '../../stores/settings.store'
import { useAgentStore } from '../../stores/agent.store'
import { Icon } from '../ui/Icon'
import { cn } from '../../lib/utils'
import { ownerLabel } from '../../lib/todo-filter'
import type { TodoOwner } from '../../types/todo'

interface OwnerPickerProps {
  value: TodoOwner
  onChange: (value: TodoOwner) => void
  /** 执行者。null = 执行者即提出者 */
  executedBy?: TodoOwner | null
  onExecutedByChange?: (value: TodoOwner | null) => void
}

/**
 * 提出者选择器（遵循属性表规范：默认展示「本人 + 当前已选提出者 + 展开切换」，
 * 不把历史上出现过的全部 agent 平铺成多行胶囊）。
 */
export const OwnerPicker: React.FC<OwnerPickerProps> = ({
  value,
  onChange
}) => {
  const { todos } = useTodoStore()
  const { settings } = useSettingsStore()
  const { fetchAgents } = useAgentStore()
  useEffect(() => {
    void fetchAgents()
  }, [fetchAgents])

  const [creating, setCreating] = useState(false)
  const [draft, setDraft] = useState('')
  const [showAllAgents, setShowAllAgents] = useState(false)

  /** 库里出现过的 agent（去重、按出现次序） */
  const knownAgents: TodoOwner[] = []
  for (const t of todos) {
    if (t.createdBy.startsWith('agent:') && !knownAgents.includes(t.createdBy)) {
      knownAgents.push(t.createdBy)
    }
    if (t.executedBy && t.executedBy.startsWith('agent:') && !knownAgents.includes(t.executedBy)) {
      knownAgents.push(t.executedBy)
    }
  }
  if (value.startsWith('agent:') && !knownAgents.includes(value)) {
    knownAgents.push(value)
  }

  const agentName = (owner: TodoOwner) => ownerLabel(owner, settings?.humanName)
  const humanLabel = ownerLabel('human', settings?.humanName)

  const submit = () => {
    const name = draft.trim().replace(/^agent:/, '')
    if (name) onChange(`agent:${name}`)
    setDraft('')
    setCreating(false)
    setShowAllAgents(false)
  }

  // 默认只展示当前选中的提出者；未展开时不平铺历史 AI 列表，避免与下方「执行人」行的 AI 列表重复
  const visibleAgents = showAllAgents
    ? knownAgents
    : value.startsWith('agent:')
      ? [value]
      : []
  const hiddenCount = Math.max(0, knownAgents.length - visibleAgents.length)

  return (
    <div className="flex items-start gap-2.5 min-h-7">
      <span className="w-20 shrink-0 text-label text-text-secondary inline-flex items-center gap-1.5 pt-1">
        <Icon name={value === 'human' ? 'user' : 'bot'} size={12} />
        <span>提出者</span>
      </span>

      <div className="flex-1 min-w-0 flex items-center gap-1.5 flex-wrap">
        <button
          type="button"
          onClick={() => onChange('human')}
          title="我提出的"
          className={cn(
            'inline-flex items-center gap-1.5 h-7 px-2.5 rounded-button text-label border transition-colors',
            value === 'human'
              ? 'bg-bg-card text-text-primary font-semibold border-text-primary/30 shadow-card'
              : 'bg-transparent text-text-secondary border-border/70 hover:text-text-primary hover:bg-surface-subtle'
          )}
        >
          <Icon name="user" size={11} />
          {humanLabel}
        </button>

        {visibleAgents.map((a) => {
          const active = value === a
          return (
            <button
              key={a}
              type="button"
              onClick={() => onChange(a)}
              title={`${agentName(a)} 提出`}
              className={cn(
                'inline-flex items-center gap-1.5 h-7 px-2.5 rounded-button text-label border transition-colors',
                active
                  ? 'bg-bg-card text-text-primary font-semibold border-text-primary/30 shadow-card'
                  : 'bg-transparent text-text-secondary border-border/70 hover:text-text-primary hover:bg-surface-subtle'
              )}
            >
              <Icon name="bot" size={11} />
              {agentName(a)}
            </button>
          )
        })}

        {!showAllAgents && hiddenCount > 0 && (
          <button
            type="button"
            onClick={() => setShowAllAgents(true)}
            className="inline-flex items-center gap-1 h-7 px-2 rounded-button text-caption text-text-secondary hover:text-text-primary hover:bg-surface-subtle border border-transparent transition-colors"
            title="展开更多提出者候选"
          >
            {value === 'human' ? `切换其他提出者 (${hiddenCount})` : `更多 (${hiddenCount})`}
          </button>
        )}

        {showAllAgents && (
          <>
            {creating ? (
              <input
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={submit}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    submit()
                  }
                  if (e.key === 'Escape') {
                    setCreating(false)
                    setDraft('')
                  }
                }}
                placeholder="agent 名，回车确认"
                maxLength={30}
                className="h-7 w-32 px-2.5 rounded-button text-label bg-bg-card
                  border border-accent outline-none placeholder:text-text-secondary/60"
              />
            ) : (
              <button
                type="button"
                onClick={() => setCreating(true)}
                title="指定其他 agent"
                className="inline-flex items-center gap-1 h-7 px-2 rounded-button text-caption
                  text-text-secondary border border-dashed border-border hover:border-accent
                  hover:text-accent transition-colors"
              >
                <Icon name="plus" size={10} />
                其他
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                setShowAllAgents(false)
                setCreating(false)
              }}
              className="inline-flex items-center h-7 px-1.5 text-caption text-text-secondary hover:text-text-primary"
            >
              收起
            </button>
          </>
        )}
      </div>
    </div>
  )
}
