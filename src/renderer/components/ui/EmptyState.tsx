import React from 'react'

/**
 * 空态块（1.0.114 从 PagePrimitives 拆出，卡 290a99e5）
 *
 * 与 StatusBadge 同一次拆分：展示件从页面骨架里独立成文，
 * 渲染输出一个字没改（渲染断言见 tests/renderer/components/ui/empty-state-render-*.test.tsx）。
 */
export const EmptyState: React.FC<{
  title: string
  description?: React.ReactNode
  action?: React.ReactNode
  className?: string
}> = ({ title, description, action, className = '' }) => (
  <div className={`empty-state rounded-card border border-dashed border-border p-5 text-center ${className}`}>
    <div className="text-label font-medium text-text-primary">{title}</div>
    {description && <div className="mt-1 text-label text-text-secondary">{description}</div>}
    {action && <div className="mt-3">{action}</div>}
  </div>
)
