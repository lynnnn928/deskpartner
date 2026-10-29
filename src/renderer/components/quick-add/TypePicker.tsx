import React from 'react'
import { cn } from '../../lib/utils'
import { TYPE_META } from '../../lib/constants'
import { Icon } from '../ui/Icon'
import type { TodoType } from '../../types/enums'

interface TypePickerProps {
  value: TodoType
  onChange: (value: TodoType) => void
}

/**
 * 事项类型选择器 — 紧凑分段控制器（Segmented Control）
 */
export const TypePicker: React.FC<TypePickerProps> = ({ value, onChange }) => {
  const options: TodoType[] = ['task', 'feature', 'bug']

  return (
    <div className="flex items-center gap-2.5 min-h-7">
      <span className="w-20 shrink-0 text-label text-text-secondary inline-flex items-center gap-1.5">
        <Icon name="layers" size={12} />
        <span>类型</span>
      </span>
      <div className="inline-flex items-center p-0.5 rounded-button bg-surface-muted border border-border/70">
        {options.map((t) => {
          const meta = TYPE_META[t]
          const active = value === t
          return (
            <button
              key={t}
              type="button"
              onClick={() => onChange(t)}
              title={t === 'task' ? '普通事项（默认）' : meta.label}
              className={cn(
                'inline-flex items-center gap-1.5 h-6 px-2.5 rounded-xs text-caption transition-colors',
                active
                  ? 'bg-bg-card text-text-primary font-semibold shadow-card'
                  : 'text-text-secondary hover:text-text-primary'
              )}
            >
              {t !== 'task' && (
                <span
                  className="h-1.5 w-1.5 rounded-full shrink-0"
                  style={{ backgroundColor: meta.color }}
                />
              )}
              {meta.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}
