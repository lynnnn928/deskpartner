import React from 'react'
import { cn } from '../../lib/utils'
import { STATUS_META } from '../../lib/constants'
import { Icon } from '../ui/Icon'
import { useSettingsStore } from '../../stores/settings.store'
import type { SpacingPreset, TodoStatus } from '../../types/enums'

interface ColumnHeaderProps {
  status: TodoStatus
  count: number
  /** 提供时显示折叠按钮 */
  onToggle?: (status: TodoStatus) => void
}

/**
 * 列头样式
 *
 * 颜色只落在左侧那个小圆点上，不用整行色带 ——
 * 四列各挂一条色带时，屏幕顶部横着四条色块，注意力会被列头分走，
 * 而该被看见的是卡片内容。
 */

/** 列头高度档位（px） */
const HEADER_HEIGHT: Record<SpacingPreset, number> = {
  compact: 38,
  standard: 44,
  spacious: 52
}

export const ColumnHeader: React.FC<ColumnHeaderProps> = ({ status, count, onToggle }) => {
  const config = STATUS_META[status]
  const { settings } = useSettingsStore()
  const height = HEADER_HEIGHT[settings.kanbanColumnHeaderHeight] ?? HEADER_HEIGHT.standard

  return (
    <div
      className={cn('flex items-center gap-2 px-3.5 shrink-0 border-b border-border/50')}
      style={{ height }}
    >
      <span
        className="w-2 h-2 rounded-full shrink-0"
        style={{ backgroundColor: `var(${config.colorVar})` }}
        aria-hidden
      />
      <span className="text-content font-semibold text-text-primary">{config.label}</span>
      <span className="ml-1 px-1.5 py-0.5 rounded-full bg-surface-muted font-mono text-caption text-text-secondary leading-none">
        {count}
      </span>
      {onToggle && (
        <button
          type="button"
          onClick={() => onToggle(status)}
          className="ml-auto w-6 h-6 flex items-center justify-center rounded-button text-text-secondary hover:bg-surface-muted hover:text-text-primary transition-colors cursor-pointer"
          title={`折叠「${config.label}」列`}
          aria-label={`折叠「${config.label}」列`}
        >
          <Icon name="chevronLeft" size={12} />
        </button>
      )}
    </div>
  )
}
