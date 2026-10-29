import React from 'react'
import { cn } from '../../lib/utils'
import { Icon, type IconName } from '../ui/Icon'

interface SectionProps {
  title: string
  /** 分组说明，可选 */
  desc?: string
  /**
   * 层级（1.0.59，排版重构）
   * 1 = 一个 tab 下的独立设置卡片（基础预设 / 字号 / 悬浮球 …）
   * 2 = 大卡片内部的子组（品牌色 / 界面 / 文字 …）
   */
  level?: 1 | 2
  children: React.ReactNode
}

/** 设置分组容器：标题 + 说明 + 内容区 */
export const Section: React.FC<SectionProps> = ({ title, desc, level = 1, children }) => {
  if (level === 2) {
    return (
      <div className="pt-3 first:pt-0 border-t border-border/50 first:border-t-0">
        {/*
          二级标题层级（1.0.60）：
            一级 16px semibold  ← Section(level=1) / Group
            二级 14px semibold  ← 本处，与行标签同字号但更重
            行标签 14px normal  ← Row
        */}
        <h4 className="text-content font-semibold text-text-primary mb-1.5">{title}</h4>
        {desc && <p className="text-label text-text-secondary leading-relaxed mb-2.5">{desc}</p>}
        <div className="space-y-2.5">{children}</div>
      </div>
    )
  }

  return (
    <section className="rounded-card border border-border bg-bg-card p-5 shadow-sm">
      <div className="mb-3.5 pb-2.5 border-b border-border/60">
        <h3 className="text-column-title font-semibold tracking-title text-text-primary">{title}</h3>
        {desc && <p className="text-label text-text-secondary leading-relaxed mt-1">{desc}</p>}
      </div>
      <div className="space-y-3.5">{children}</div>
    </section>
  )
}

interface GroupProps {
  title: string
  desc?: string
  children: React.ReactNode
}

/**
 * 一级大分组容器（1.0.59）
 * 用于把若干 level=2 的子组收在一张设置卡片里（如「颜色」含品牌色/界面/文字）。
 */
export const Group: React.FC<GroupProps> = ({ title, desc, children }) => (
  <section className="rounded-card border border-border bg-bg-card p-5 shadow-sm">
    <div className="mb-3.5 pb-2.5 border-b border-border/60">
      <h3 className="text-column-title font-semibold tracking-title text-text-primary">{title}</h3>
      {desc && <p className="text-label text-text-secondary leading-relaxed mt-1">{desc}</p>}
    </div>
    <div className="space-y-4">{children}</div>
  </section>
)

interface RowProps {
  label: string
  /** 控件下方的补充说明 */
  hint?: string
  /** 标签与控件改为纵向排列，控件占满整行 */
  block?: boolean
  children: React.ReactNode
}

/** 设置行：左侧标签（带可选副标题说明），右侧紧凑控件 */
export const Row: React.FC<RowProps> = ({ label, hint, block = false, children }) => {
  if (block) {
    return (
      <div className="space-y-1.5 py-0.5">
        <span className="text-content text-text-primary">{label}</span>
        <div>{children}</div>
        {hint && <p className="text-label text-text-secondary">{hint}</p>}
      </div>
    )
  }

  return (
    <div className="flex items-center justify-between gap-6 py-0.5">
      <div className="min-w-0 flex flex-col gap-0.5">
        <span className="text-content text-text-primary">{label}</span>
        {hint && <p className="text-label text-text-secondary leading-snug">{hint}</p>}
      </div>
      <div className="shrink-0 flex items-center justify-end">{children}</div>
    </div>
  )
}

interface SegmentedProps<T extends string> {
  value: T
  options: { value: T; label: string; icon?: IconName }[]
  onChange: (value: T) => void
}

/** 分段按钮组：用于二选一 / 三选一这类低基数选项 */
export function Segmented<T extends string>({ value, options, onChange }: SegmentedProps<T>) {
  return (
    <div className="inline-flex items-center gap-1 rounded-button bg-surface-subtle p-1 border border-border/70">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className={cn(
            'inline-flex items-center gap-1.5 px-3 py-1 rounded-xs text-button transition-colors cursor-pointer',
            value === opt.value
              ? 'bg-accent text-white font-medium shadow-sm'
              : 'text-text-secondary hover:text-text-primary hover:bg-surface-muted'
          )}
        >
          {opt.icon && <Icon name={opt.icon} size={13} />}
          {opt.label}
        </button>
      ))}
    </div>
  )
}
