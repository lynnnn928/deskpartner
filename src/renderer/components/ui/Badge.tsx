import React from 'react'
import { STATUS_META, PRIORITY_META } from '../../lib/constants'
import type { TodoStatus, TodoPriority } from '../../types/enums'
import { cn } from '../../lib/utils'

/**
 * 状态徽章（1.0.114 从 PagePrimitives 拆出，卡 290a99e5）
 *
 * 为什么单独成文：徽章是"每页都会用"的展示件，而 PagePrimitives 里混着
 * 页面骨架（PageHeader / SectionHeader / FilterBar / Pagination）与展示件
 * （Badge / EmptyState）。混在一起的代价是**找东西的成本**：
 * 想找一个徽章得先想到"它在页面骨架那个文件里"，于是各页干脆自己拼 class
 * （`rounded-full` 全仓 31 个文件 58 次，其中徽章形态那种写法在改动前就散着 8 处）。
 *
 * 拆分**不改任何渲染输出**：class 串一个字没动，只用一条渲染断言钉住
 * （tests/renderer/components/ui/badge-render-*.test.tsx）。
 */
export const StatusBadge: React.FC<{
  children: React.ReactNode
  tone?: 'neutral' | 'accent' | 'success' | 'warning' | 'danger'
}> = ({ children, tone = 'neutral' }) => {
  /**
   * 1.0.115（卡 5fdf9b6d 第二步）：tone 表从「令牌引用型任意值」改成**工具类**。
   *
   * 改之前这张表长这样：`border-[color:var(--color-success)]/30`。它能工作，
   * 但把颜色层的写法又抄了一遍 —— 同一个令牌在组件里以 `var(--color-success)`
   * 出现、在 tailwind 里以 `success` 出现，谁都不是唯一入口；颜色一旦改名，
   * 只有在用到它的组件里静默失效（构建不报、tsc 不管）。
   * 现在五个 tone 一律 `border-<名>/30 bg-<名>/10 text-<名>`，名字只有一个来源：
   * tailwind.config.ts 的 colors（颜色值仍在 variables.css 的通道变量里）。
   *
   * neutral 的底是派生的面（`--surface-muted`），走 backgroundColor 里登记的
   * `bg-surface-muted`；它没有 alpha 过体，所以这一档不用 `/NN` 写法。
   */
  const toneClass = {
    neutral: 'border-border bg-surface-muted text-text-secondary',
    accent: 'border-accent/30 bg-accent/10 text-accent',
    success: 'border-success/30 bg-success/10 text-success',
    warning: 'border-warning/30 bg-warning/10 text-warning',
    danger: 'border-danger/30 bg-danger/10 text-danger'
  }[tone]
  /**
   * ⚠️ `whitespace-nowrap shrink-0` 不是装饰（卡 `6ae61278`）：徽标放进 `min-w-0` 的 flex 行后，
   * 会先被压缩、再按字断行 —— 「需二次确认」被排成竖排一字一行，撑破卡片首行，
   * 而这枚徽标正是"待表态 vs 待补确认"唯一的视觉出口。宁可让标题 `truncate`，也不许把徽标压成一列。
   */
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-label font-medium whitespace-nowrap shrink-0 ${toneClass}`}
    >
      {children}
    </span>
  )
}

/**
 * 全站唯一的事项状态指示胶囊（同物同形契约组件，卡 d930dfb5）：
 * 统一采用「7 色专属状态小圆点 + 中性底色胶囊 + 状态中文名」，
 * 供「我的工作」「项目概览」「版本关联事项」「全局搜索」共用，
 * 消除各页面状态底色相同或无色彩纯灰字的分裂。
 */
export const TodoStatusPill: React.FC<{
  status: TodoStatus
  className?: string
}> = ({ status, className }) => {
  const meta = STATUS_META[status]
  if (!meta) return null
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-surface-subtle px-2.5 py-0.5 text-caption font-medium text-text-primary whitespace-nowrap shrink-0',
        className
      )}
    >
      <span
        className="w-1.5 h-1.5 rounded-full shrink-0"
        style={{ backgroundColor: `var(${meta.colorVar})` }}
        aria-hidden
      />
      <span>{meta.label}</span>
    </span>
  )
}

/**
 * 全站唯一的事项优先级指示胶囊（同物同形契约组件，卡 d930dfb5）：
 * 统一采用「优先级色点 + 中性胶囊」，消除列表行尾裸印刺眼红字「紧急」的突兀感。
 */
export const TodoPriorityBadge: React.FC<{
  priority: TodoPriority
  className?: string
}> = ({ priority, className }) => {
  const meta = PRIORITY_META[priority]
  if (!meta) return null
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border border-border/70 bg-surface-subtle px-2 py-0.5 text-caption font-medium text-text-primary whitespace-nowrap shrink-0',
        className
      )}
    >
      <span
        className="w-1.5 h-1.5 rounded-full shrink-0"
        style={{ backgroundColor: meta.color }}
        aria-hidden
      />
      <span>{meta.label}</span>
    </span>
  )
}
