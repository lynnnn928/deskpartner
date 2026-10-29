import React, { useState } from 'react'
import { useTodoStore } from '../../stores/todo.store'
import { Icon } from '../ui/Icon'
import { cn, shortId } from '../../lib/utils'

interface ParentPickerProps {
  /** 当前父需求 id，null = 顶层事项 */
  value: string | null
  /** 当前这条自己的 id（编辑模式下要排除掉，不能选自己当爹） */
  selfId?: string
  onChange: (value: string | null) => void
}

export const ParentPicker: React.FC<ParentPickerProps> = ({ value, selfId, onChange }) => {
  const { todos } = useTodoStore()
  const [open, setOpen] = useState(false)
  const [keyword, setKeyword] = useState('')

  const candidates = todos.filter(
    (t) => t.id !== selfId && t.status !== 'done' && t.status !== 'discarded'
  )
  const matched = keyword.trim()
    ? candidates.filter((t) => t.title.toLowerCase().includes(keyword.trim().toLowerCase()))
    : candidates.slice(0, 8)

  const selected = todos.find((t) => t.id === value)

  return (
    <div className="flex items-center gap-2.5 min-h-7 relative">
      <span className="w-20 shrink-0 text-label text-text-secondary inline-flex items-center gap-1.5">
        <Icon name="gitBranch" size={12} />
        <span>父需求</span>
      </span>

      <div className="flex items-center gap-1.5 min-w-0 flex-1">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          title={selected ? selected.title : '顶层事项（无父级）'}
          className={cn(
            'inline-flex items-center justify-between gap-1.5 h-7 px-2.5 rounded-button text-label border transition-colors min-w-0 max-w-full',
            value
              ? 'bg-bg-card border-text-primary/30 text-text-primary font-medium shadow-card flex-1'
              : 'bg-bg-card border-border text-text-secondary hover:text-text-primary'
          )}
        >
          <span className="truncate min-w-0 text-left">
            {selected ? selected.title : '顶层事项（无父级）'}
          </span>
          <Icon name="chevronLeft" size={10} className="-rotate-90 shrink-0 text-text-secondary" />
        </button>

        {value && (
          <button
            type="button"
            onClick={() => onChange(null)}
            className="text-caption text-text-secondary hover:text-danger transition-colors px-1.5 shrink-0"
            title="取消父需求，回到顶层"
          >
            清除
          </button>
        )}
      </div>

      {open && (
        <div
          className="absolute z-50 top-full left-20 mt-1 w-80 max-w-full bg-bg-card border border-border rounded-card py-1
            shadow-float"
        >
          <input
            autoFocus
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="搜索父事项标题…"
            className="w-full px-3 py-1.5 text-label bg-transparent outline-none
              border-b border-border placeholder:text-text-secondary/60"
          />
          <div
            className="max-h-44 overflow-y-auto"
            onMouseLeave={() => setKeyword('')}
          >
            <div
              onClick={() => {
                onChange(null)
                setOpen(false)
              }}
              className="px-3 py-1.5 text-label text-text-secondary cursor-pointer hover:bg-surface-subtle"
            >
              （顶层事项，不挂靠）
            </div>
            {matched.map((t) => (
              <div
                key={t.id}
                onClick={() => {
                  onChange(t.id)
                  setOpen(false)
                }}
                className={cn(
                  'px-3 py-1.5 text-label cursor-pointer hover:bg-surface-subtle flex items-center justify-between gap-2',
                  t.id === value && 'text-accent font-medium bg-accent/5'
                )}
                title={t.title}
              >
                <span className="truncate">{t.title}</span>
                <span className="font-mono text-caption text-text-secondary/70 shrink-0">#{shortId(t.id)}</span>
              </div>
            ))}
            {matched.length === 0 && (
              <div className="px-3 py-1.5 text-label text-text-secondary/70">没有匹配的事项</div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
