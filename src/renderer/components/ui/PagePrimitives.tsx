import React from 'react'
import { Button } from './Button'

/**
 * 页面骨架（1.0.114 起只放骨架）
 *
 * Badge / EmptyState 于 1.0.114 拆成同目录的 `Badge.tsx` / `EmptyState.tsx`
 * （卡 290a99e5）：骨架与展示件混在一个文件里，找东西的成本全落在调用方身上 ——
 * 想找个徽章得先想到"它在页面骨架那个文件里"，于是各页干脆自己拼 class。
 */

export const PageHeader: React.FC<{
  title: string
  eyebrow?: React.ReactNode
  description?: React.ReactNode
  leading?: React.ReactNode
  actions?: React.ReactNode
}> = ({ title, eyebrow, description, leading, actions }) => (
  <header className="flex shrink-0 items-start gap-4">
    {leading}
    <div className="min-w-0 flex-1">
      {eyebrow && <div className="mb-1 text-label font-medium uppercase tracking-label text-text-secondary">{eyebrow}</div>}
      <h1 className="text-title font-semibold tracking-title text-text-primary">{title}</h1>
      {description && <div className="mt-2 max-w-2xl text-body text-text-secondary leading-relaxed">{description}</div>}
    </div>
    {actions && <div className="shrink-0 flex items-center gap-2">{actions}</div>}
  </header>
)

export const SectionHeader: React.FC<{
  title: string
  description?: React.ReactNode
  className?: string
}> = ({ title, description, className = '' }) => (
  <div className={`flex items-start justify-between gap-3 ${className}`}>
    <div className="min-w-0">
      <h2 className="text-body font-semibold text-text-primary">{title}</h2>
      {description && <p className="mt-1 text-label text-text-secondary leading-relaxed">{description}</p>}
    </div>
  </div>
)

export const FilterBar: React.FC<{
  children: React.ReactNode
  label: string
  className?: string
}> = ({ children, label, className = '' }) => (
  <div role="group" aria-label={label} className={`flex flex-wrap items-center gap-2 ${className}`}>
    {children}
  </div>
)

export const Pagination: React.FC<{
  page: number
  pageCount: number
  total?: number
  pageSize?: number
  onPageChange: (page: number) => void
  disabled?: boolean
  label?: string
}> = ({ page, pageCount, total, pageSize, onPageChange, disabled = false, label = '分页' }) => (
  <nav aria-label={label} className="flex items-center justify-between gap-3 text-label text-text-secondary">
    <span>
      {total !== undefined && pageSize !== undefined ? `共 ${total} 条 · 每页 ${pageSize} 条 · ` : ''}
      第 {page} / {Math.max(1, pageCount)} 页
    </span>
    <div className="flex gap-1">
      <Button size="sm" variant="ghost" disabled={disabled || page <= 1} onClick={() => onPageChange(Math.max(1, page - 1))}>上一页</Button>
      <Button size="sm" variant="ghost" disabled={disabled || page >= pageCount} onClick={() => onPageChange(Math.min(pageCount, page + 1))}>下一页</Button>
    </div>
  </nav>
)
