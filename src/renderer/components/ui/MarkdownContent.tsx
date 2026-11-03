import React, { useMemo } from 'react'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import type { Content, Root, PhrasingContent, Table } from 'mdast'
import { cn } from '../../lib/utils'
import { invoke } from '../../lib/ipc-client'

interface MarkdownContentProps {
  content: string
  className?: string
}

/**
 * Markdown 阅读视图渲染器（Read-First, Edit-on-Demand 契约组件）
 *
 * ── 为什么用解析器，而不是自己扫字符串（卡 `93929ec9`）──
 *
 * 1.0.142 及以前这里是手写的二百行扫描器，只认标题/列表/引用/代码/分割线/加粗/
 * 行内代码。代价是**每缺一种语法都要等一次用户反馈**：表格是主用户截图报上来的
 * （卡 `51671d3e`），再往下还缺链接、嵌套列表、强调、删除线。
 *
 * 现在换成 `unified + remark-parse + remark-gfm` 解析成 mdast，再由本文件把节点
 * 映射成 React 元素。**安全面没有变小**：全程不碰 `innerHTML`，raw HTML 节点除了
 * 一个裸 `<br>` 之外一律丢弃（注释也一并丢）。
 *
 * ── 为什么样式还写在这里 ──
 *
 * 库只负责"这是什么"，长什么样仍是本项目的事：所有字号、边框、间距都走现有 token
 * 类，和文档页、评论、变更流共用同一套观感 —— 不引入库自带的 CSS。
 *
 * ── 链接的点击 ──
 *
 * 主进程只允许打开产品官网与 GitHub 仓库（`app:openExternal` 的前缀白名单，卡
 * `5eaf6d1d`）。所以这里先尝试打开；被拒时把 URL 复制到剪贴板并提示，而不是点了
 * 没反应 —— 让人知道自己拿到的是什么。
 */

const parser = unified().use(remarkParse).use(remarkGfm)

/** 只有这个形状的 HTML 放行（文档作者用它在一个单元格里分行） */
const BR_ONLY = /^<br\s*\/?>$/i

async function openOrCopy(href: string): Promise<void> {
  try {
    const res = (await invoke('app:openExternal', { url: href })) as { opened?: boolean } | null
    if (res?.opened) return
  } catch {
    /* 落到复制分支 */
  }
  try {
    await navigator.clipboard.writeText(href)
  } catch {
    /* 剪贴板不可用时不阻断阅读 */
  }
}

export const MarkdownContent: React.FC<MarkdownContentProps> = ({ content, className }) => {
  const tree = useMemo<Root | null>(() => {
    const cleaned = content.replace(/<!--[\s\S]*?-->/g, '').trim()
    if (!cleaned) return null
    try {
      return parser.parse(cleaned) as Root
    } catch {
      return null
    }
  }, [content])

  if (!tree) return null

  return <div className={cn('flex flex-col gap-1.5', className)}>{renderBlocks(tree.children)}</div>
}

/* ───────────────────────── 块级 ───────────────────────── */

function renderBlocks(nodes: Content[], depth = 0): React.ReactNode[] {
  return nodes.map((node, index) => renderBlock(node, `${depth}-${index}`))
}

function renderBlock(node: Content, key: string): React.ReactNode {
  switch (node.type) {
    case 'heading': {
      const level = node.depth
      return (
        <div
          key={key}
          className={cn(
            'font-semibold text-text-primary',
            level === 1
              ? 'text-content pt-1 pb-0.5 border-b border-border/50'
              : level === 2
                ? 'text-content pt-1'
                : 'text-label pt-0.5'
          )}
        >
          {renderInline(node.children)}
        </div>
      )
    }
    case 'paragraph':
      return (
        <p key={key} className="text-label text-text-primary leading-relaxed break-words">
          {renderInline(node.children)}
        </p>
      )
    case 'list': {
      const items = node.children
      return (
        <ul key={key} className="flex flex-col gap-1 pl-0.5">
          {items.map((item, itemIndex) => (
            <ListItem
              key={`${key}-${itemIndex}`}
              node={item}
              orderedNumber={node.ordered ? (node.start ?? 1) + itemIndex : null}
            />
          ))}
        </ul>
      )
    }
    case 'blockquote':
      return (
        <blockquote
          key={key}
          className="border-l-2 border-border pl-3 py-0.5 text-label text-text-secondary leading-relaxed flex flex-col gap-1"
        >
          {renderBlocks(node.children, 1)}
        </blockquote>
      )
    case 'code':
      return (
        <pre
          key={key}
          className="rounded-button border border-border/70 bg-surface-muted px-3 py-2 font-mono text-caption text-text-primary overflow-x-auto leading-relaxed"
        >
          <code>{node.value}</code>
        </pre>
      )
    case 'thematicBreak':
      return <hr key={key} className="border-border/60 my-1.5" />
    case 'table':
      return <TableBlock key={key} node={node} />
    case 'html':
      // 裸 <br> 之外的任何 HTML（含注释）都不渲染 —— 这个组件的契约是"不用 innerHTML"
      return BR_ONLY.test(node.value.trim()) ? <br key={key} /> : null
    case 'definition':
    case 'footnoteDefinition':
      return null
    default: {
      // 兜底：把有子节点/有文本的节点当普通块渲染，别整段吞掉
      const loose = node as unknown as { children?: PhrasingContent[]; value?: unknown }
      if (Array.isArray(loose.children)) {
        return <div key={key}>{renderInline(loose.children)}</div>
      }
      return null
    }
  }
}

const ListItem: React.FC<{
  node: Extract<Content, { type: 'listItem' }>
  orderedNumber: number | null
}> = ({ node, orderedNumber }) => {
  const checked = node.checked
  const ordered = orderedNumber
  /** listItem 的 children 一般是 paragraph（+ 嵌套 list）：段落内容内联渲染，嵌套列表另行成块 */
  const inlineNodes: PhrasingContent[] = []
  const nested: Content[] = []
  for (const child of node.children) {
    if (child.type === 'paragraph') inlineNodes.push(...child.children)
    else nested.push(child)
  }
  return (
    <li className="flex items-start gap-2 text-label text-text-primary leading-relaxed">
      {checked !== null && checked !== undefined ? (
        <span
          aria-hidden
          className={cn(
            'mt-1 w-3.5 h-3.5 rounded-xs border flex items-center justify-center shrink-0 text-caption',
            checked ? 'bg-accent border-accent text-white' : 'border-border bg-bg-card'
          )}
        >
          {checked ? '✓' : ''}
        </span>
      ) : ordered !== null ? (
        <span className="font-mono text-caption text-text-secondary shrink-0 mt-0.5">{ordered}.</span>
      ) : (
        <span className="mt-2 w-1.5 h-1.5 rounded-full bg-text-secondary/50 shrink-0" />
      )}
      <span className={cn('flex-1 min-w-0 break-words', checked ? 'line-through text-text-secondary' : '')}>
        {renderInline(inlineNodes)}
        {nested.length > 0 && <span className="block mt-1">{renderBlocks(nested, 2)}</span>}
      </span>
    </li>
  )
}

const TableBlock: React.FC<{ node: Table }> = ({ node }) => {
  const alignClass = (index: number): string => {
    const align = node.align?.[index]
    return align === 'center' ? 'text-center' : align === 'right' ? 'text-right' : 'text-left'
  }
  const [head, ...body] = node.children
  return (
    <div className="my-1 overflow-x-auto">
      <table className="w-full border-collapse text-caption text-text-primary">
        {head && (
          <thead>
            <tr>
              {head.children.map((cell, index) => (
                <th
                  key={index}
                  className={cn(
                    'border border-border/70 bg-surface-muted px-2 py-1 font-semibold align-top break-words',
                    alignClass(index)
                  )}
                >
                  {renderInline(cell.children)}
                </th>
              ))}
            </tr>
          </thead>
        )}
        <tbody>
          {body.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.children.map((cell, cellIndex) => (
                <td
                  key={cellIndex}
                  className={cn('border border-border/60 px-2 py-1 align-top break-words', alignClass(cellIndex))}
                >
                  {renderInline(cell.children)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/* ───────────────────────── 行内 ───────────────────────── */

function renderInline(nodes: PhrasingContent[]): React.ReactNode[] {
  return nodes.map((node, index) => renderInlineNode(node, `i-${index}`))
}

function renderInlineNode(node: PhrasingContent, key: string): React.ReactNode {
  switch (node.type) {
    case 'text':
      return node.value
    case 'strong':
      return (
        <strong key={key} className="font-semibold text-text-primary">
          {renderInline(node.children)}
        </strong>
      )
    case 'emphasis':
      return (
        <em key={key} className="italic">
          {renderInline(node.children)}
        </em>
      )
    case 'delete':
      return (
        <s key={key} className="text-text-secondary">
          {renderInline(node.children)}
        </s>
      )
    case 'inlineCode':
      return (
        <code
          key={key}
          className="px-1.5 py-0.5 mx-0.5 rounded-xs bg-surface-muted border border-border/60 font-mono text-caption text-text-primary"
        >
          {node.value}
        </code>
      )
    case 'break':
      return <br key={key} />
    case 'html':
      return BR_ONLY.test(node.value.trim()) ? <br key={key} /> : null
    case 'link': {
      const href = node.url
      return (
        <a
          key={key}
          href={href}
          title={href}
          className="text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent cursor-pointer break-all"
          onClick={(event) => {
            event.preventDefault()
            void openOrCopy(href)
          }}
        >
          {renderInline(node.children)}
        </a>
      )
    }
    case 'image':
      // 不加载远程图片：文档里的图按"图 + 说明"呈现，点开才走外链
      return (
        <a
          key={key}
          href={node.url}
          title={node.url}
          className="text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent cursor-pointer break-all"
          onClick={(event) => {
            event.preventDefault()
            void openOrCopy(node.url)
          }}
        >
          {node.alt || '图片'}
        </a>
      )
    case 'linkReference':
    case 'imageReference':
    case 'footnoteReference':
      return null
    default: {
      const loose = node as unknown as { children?: PhrasingContent[]; value?: unknown }
      if (Array.isArray(loose.children)) {
        return <React.Fragment key={key}>{renderInline(loose.children)}</React.Fragment>
      }
      return typeof loose.value === 'string' ? loose.value : null
    }
  }
}
