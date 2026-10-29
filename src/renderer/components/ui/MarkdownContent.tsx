import React from 'react'
import { cn } from '../../lib/utils'

interface MarkdownContentProps {
  content: string
  className?: string
}

/**
 * 轻量安全的 Markdown 阅读视图渲染器（Read-First, Edit-on-Demand 契约组件）：
 * 支持标题（# ~ ###）、无序/有序列表、任务复选框（- [ ] / - [x]）、引用块（>）、
 * 代码块（```）、行内代码（`code`）、加粗（**bold**）与分割线（---），自动过滤 HTML 注释。
 */
export const MarkdownContent: React.FC<MarkdownContentProps> = ({ content, className }) => {
  const cleaned = content.replace(/<!--[\s\S]*?-->/g, '').trim()
  if (!cleaned) return null

  const lines = cleaned.split(/\r?\n/)
  const blocks: React.ReactNode[] = []
  let i = 0
  let key = 0

  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trim()

    // 空行跳过
    if (!trimmed) {
      i++
      continue
    }

    // 代码块 ```
    if (trimmed.startsWith('```')) {
      const codeLines: string[] = []
      i++
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        codeLines.push(lines[i])
        i++
      }
      if (i < lines.length) i++ // 跳过结束 ```
      blocks.push(
        <pre
          key={key++}
          className="rounded-button border border-border/70 bg-surface-muted px-3 py-2 font-mono text-caption text-text-primary overflow-x-auto leading-relaxed"
        >
          <code>{codeLines.join('\n')}</code>
        </pre>
      )
      continue
    }

    // 分割线 ---
    if (/^-{3,}$/.test(trimmed)) {
      blocks.push(<hr key={key++} className="border-border/60 my-1.5" />)
      i++
      continue
    }

    // 标题 # / ## / ###
    const headingMatch = trimmed.match(/^(#{1,4})\s+(.+)$/)
    if (headingMatch) {
      const level = headingMatch[1].length
      const text = headingMatch[2]
      blocks.push(
        <div
          key={key++}
          className={cn(
            'font-semibold text-text-primary',
            level === 1
              ? 'text-content pt-1 pb-0.5 border-b border-border/50'
              : level === 2
                ? 'text-content pt-1'
                : 'text-label pt-0.5'
          )}
        >
          {renderInline(text)}
        </div>
      )
      i++
      continue
    }

    // 引用块 >
    if (trimmed.startsWith('>')) {
      const quoteLines: string[] = []
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        quoteLines.push(lines[i].trim().replace(/^>\s?/, ''))
        i++
      }
      blocks.push(
        <blockquote
          key={key++}
          className="border-l-2 border-border pl-3 py-0.5 text-label text-text-secondary leading-relaxed"
        >
          {quoteLines.map((q, idx) => (
            <div key={idx}>{renderInline(q)}</div>
          ))}
        </blockquote>
      )
      continue
    }

    // 列表项（- / * / • / 1.）
    if (/^(?:[-*•]|\d+\.)\s+/.test(trimmed)) {
      const listItems: { text: string; checked?: boolean; ordered?: string }[] = []
      while (i < lines.length && /^(?:[-*•]|\d+\.)\s+/.test(lines[i].trim())) {
        const rawItem = lines[i].trim()
        const checkMatch = rawItem.match(/^[-*•]\s+\[([ xX])\]\s+(.+)$/)
        if (checkMatch) {
          listItems.push({
            checked: checkMatch[1].toLowerCase() === 'x',
            text: checkMatch[2]
          })
        } else {
          const ordMatch = rawItem.match(/^(\d+\.)\s+(.+)$/)
          if (ordMatch) {
            listItems.push({ ordered: ordMatch[1], text: ordMatch[2] })
          } else {
            listItems.push({ text: rawItem.replace(/^[-*•]\s+/, '') })
          }
        }
        i++
      }
      blocks.push(
        <ul key={key++} className="flex flex-col gap-1 pl-0.5">
          {listItems.map((item, idx) => (
            <li key={idx} className="flex items-start gap-2 text-label text-text-primary leading-relaxed">
              {item.checked !== undefined ? (
                <span
                  aria-hidden
                  className={cn(
                    'mt-1 w-3.5 h-3.5 rounded-xs border flex items-center justify-center shrink-0 text-caption',
                    item.checked
                      ? 'bg-accent border-accent text-white'
                      : 'border-border bg-bg-card'
                  )}
                >
                  {item.checked ? '✓' : ''}
                </span>
              ) : item.ordered ? (
                <span className="font-mono text-caption text-text-secondary shrink-0 mt-0.5">
                  {item.ordered}
                </span>
              ) : (
                <span className="mt-2 w-1.5 h-1.5 rounded-full bg-text-secondary/50 shrink-0" />
              )}
              <span className={cn('flex-1 min-w-0 break-words', item.checked && 'line-through text-text-secondary')}>
                {renderInline(item.text)}
              </span>
            </li>
          ))}
        </ul>
      )
      continue
    }

    // 普通段落
    blocks.push(
      <p key={key++} className="text-label text-text-primary leading-relaxed break-words">
        {renderInline(trimmed)}
      </p>
    )
    i++
  }

  return <div className={cn('flex flex-col gap-1.5', className)}>{blocks}</div>
}

/**
 * 渲染行内 Markdown（**加粗** 与 `行内代码`）
 */
function renderInline(text: string): React.ReactNode {
  const tokenRegex = /(\*\*[^*]+\*\*|`[^`]+`)/g
  const parts = text.split(tokenRegex)
  if (parts.length === 1) return text

  return parts.map((part, idx) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return (
        <strong key={idx} className="font-semibold text-text-primary">
          {part.slice(2, -2)}
        </strong>
      )
    }
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return (
        <code
          key={idx}
          className="px-1.5 py-0.5 mx-0.5 rounded-xs bg-surface-muted border border-border/60 font-mono text-caption text-text-primary"
        >
          {part.slice(1, -1)}
        </code>
      )
    }
    return part
  })
}
