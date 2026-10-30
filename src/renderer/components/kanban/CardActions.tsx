import React, { useState } from 'react'
import { cn } from '../../lib/utils'
import { Icon } from '../ui/Icon'

interface CardActionsProps {
  todoId: string
  isPinned: boolean
  copyText?: string
  onEdit: (id: string) => void
  onDelete: (id: string) => void
  onPin: (id: string) => void
}

/**
 * 卡片快捷操作按钮 — 复制给 AI / 编辑 / 置顶 / 删除（卡 `58d024f6`）
 *
 * 刻意不用绝对定位：卡片平时在这一行显示时间，悬停时由 TodoCard 用本组件
 * 替换掉时间。两者互斥而非重叠，卡片高度也不会因悬停而跳动。
 */
export const CardActions: React.FC<CardActionsProps> = ({
  todoId,
  isPinned,
  copyText,
  onEdit,
  onDelete,
  onPin
}) => {
  const [copied, setCopied] = useState(false)

  return (
    <div className="flex items-center gap-0.5 -mr-1">
      {copyText && (
        <button
          type="button"
          data-testid={`card-copy-btn-${todoId.slice(0, 8)}`}
          onClick={(e) => {
            e.stopPropagation()
            void navigator.clipboard?.writeText?.(copyText)?.then(() => {
              setCopied(true)
              window.setTimeout(() => setCopied(false), 1500)
            })
          }}
          className={cn(
            'w-6 h-6 flex items-center justify-center rounded-md transition-colors',
            copied
              ? 'text-success bg-success/10'
              : 'text-text-secondary hover:bg-accent/10 hover:text-accent'
          )}
          title={copied ? '已复制，可直接粘贴给 AI' : `复制给 AI：${copyText}`}
        >
          <Icon name={copied ? 'checkCircle' : 'copy'} size={14} />
        </button>
      )}
      <button
        onClick={(e) => { e.stopPropagation(); onEdit(todoId) }}
        className={cn(
          'w-6 h-6 flex items-center justify-center rounded-md text-text-secondary',
          'hover:bg-accent/10 hover:text-accent transition-colors'
        )}
        title="编辑"
      >
        <Icon name="pencil" size={14} />
      </button>
      <button
        onClick={(e) => { e.stopPropagation(); onPin(todoId) }}
        className={cn(
          'w-6 h-6 flex items-center justify-center rounded-md',
          'hover:bg-accent/10 transition-colors',
          isPinned ? 'text-accent' : 'text-text-secondary hover:text-accent'
        )}
        title={isPinned ? '取消置顶' : '置顶'}
      >
        <Icon name="pin" size={14} />
      </button>
      <button
        onClick={(e) => { e.stopPropagation(); onDelete(todoId) }}
        className={cn(
          'w-6 h-6 flex items-center justify-center rounded-md text-text-secondary',
          'hover:bg-red-50 hover:text-red-500 transition-colors'
        )}
        title="删除"
      >
        <Icon name="trash" size={14} />
      </button>
    </div>
  )
}
