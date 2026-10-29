import React from 'react'
import { cn } from '../../lib/utils'
import { PRIORITY_META } from '../../lib/constants'
import { Icon } from '../ui/Icon'
import type { TodoPriority } from '../../types/enums'

interface PriorityPickerProps {
  value: TodoPriority
  onChange: (value: TodoPriority) => void
}

/** 优先级顺序：低 → 普通 → 高 → 紧急 */
const ORDER: readonly TodoPriority[] = ['low', 'normal', 'high', 'urgent']

/**
 * 优先级选择器 — 紧凑分段控制器（与 TypePicker 视觉完全一致）
 */
export const PriorityPicker: React.FC<PriorityPickerProps> = ({ value, onChange }) => {
  return (
    <div className="flex items-center gap-2.5 min-h-7">
      <span className="w-20 shrink-0 text-label text-text-secondary inline-flex items-center gap-1.5">
        <Icon name="alertTriangle" size={12} />
        <span>优先级</span>
      </span>
      <div className="inline-flex items-center p-0.5 rounded-button bg-surface-muted border border-border/70">
        {ORDER.map((p) => {
          const meta = PRIORITY_META[p]
          const active = value === p
          return (
            <button
              key={p}
              type="button"
              onClick={() => onChange(p)}
              className={cn(
                'inline-flex items-center gap-1.5 h-6 px-2.5 rounded-xs text-caption transition-colors',
                active
                  ? 'bg-bg-card text-text-primary font-semibold shadow-card'
                  : 'text-text-secondary hover:text-text-primary'
              )}
              title={meta.label}
            >
              {(p === 'urgent' || p === 'high') && (
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
