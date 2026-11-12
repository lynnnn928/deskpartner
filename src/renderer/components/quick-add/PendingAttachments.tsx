import React from 'react'
import { Button } from '../ui/Button'
import { Icon } from '../ui/Icon'
import { cn } from '../../lib/utils'
import { formatSize, pendingTotalBytes, type PendingAttachment } from '../../lib/attachment-intake'
import { MAX_ATTACHMENT_TOTAL_BYTES } from '../../lib/constants'

/**
 * 新建卡片上的「待挂附件」（卡 `fc11793f`）
 *
 * ── 它为什么不是 `TodoAttachments` ──
 *
 * 那一块是**已挂附件**的列表：它拿一个事项 id 去拉、去挂、去删。新建时那一条还没有 id，
 * 这里只是一份"先留在这张表单上"的清单 —— 保存时先建事项、再逐个挂上去。
 * 两块的共同点只有"怎么收一份东西进来"，那一层在 `lib/attachment-intake`。
 *
 * ── 文案要照实说 ──
 *
 * 界面上写的是"保存时一起挂上"，因为此刻它们确实还没挂上；写成"附件"会让人以为
 * 已经挂好了。总量上限也摆在这儿：满了能当场看出来，而不是挂不上时才知道。
 */
export interface PendingAttachmentsProps {
  items: PendingAttachment[]
  /** 已经是一句能给人看的话（超限 / 读不到 / 空内容） */
  problem: string | null
  busy: boolean
  onPick: () => void
  onRemove: (index: number) => void
  /** 粘贴那一行的后半句（提交失败重挂时换一句） */
  hint?: string
}

export const PendingAttachments: React.FC<PendingAttachmentsProps> = ({
  items,
  problem,
  busy,
  onPick,
  onRemove,
  hint = '保存时一起挂上'
}) => (
  <div data-testid="pending-attachments" className="flex flex-col gap-2">
    <div className="flex items-center justify-between gap-2">
      <span className="text-caption text-text-secondary">
        附件
        {items.length > 0 && ` ${items.length} · 共 ${formatSize(pendingTotalBytes(items))}`}
      </span>
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-caption text-text-secondary/70">
          上限 {formatSize(MAX_ATTACHMENT_TOTAL_BYTES)}
        </span>
        <Button
          variant="ghost"
          size="sm"
          data-testid="pending-attachment-add"
          disabled={busy}
          onClick={onPick}
          title="选图片或文件，保存这条事项时一起挂上"
        >
          <Icon name="plus" size={13} />
          {busy ? '处理中…' : '图片 / 文件'}
        </Button>
      </div>
    </div>

    {/* 粘贴目标：与详情里那块同一句话 —— 同一件事在哪儿都说一样的话 */}
    <div
      data-testid="pending-attachment-paste-zone"
      className={cn(
        'flex items-center justify-center gap-1.5 rounded-card border border-dashed border-border/80',
        'px-3 py-2 text-center text-caption text-text-secondary'
      )}
    >
      <Icon name="plus" size={11} />
      Ctrl+V 粘贴图片或文件 · {hint}
    </div>

    {items.length > 0 && (
      <ul className="flex flex-col gap-1">
        {items.map((item, index) => (
          <li
            key={`${item.kind}:${item.name}:${index}`}
            data-testid="pending-attachment-item"
            className="flex items-center gap-2 rounded-button border border-border/70 bg-surface-subtle px-2 py-1"
          >
            <span
              className="min-w-0 flex-1 truncate text-caption text-text-primary"
              title={item.kind === 'path' ? item.path : item.name}
            >
              {item.name}
            </span>
            <span className="shrink-0 text-caption text-text-secondary/70">{formatSize(item.size)}</span>
            <button
              type="button"
              data-testid="pending-attachment-remove"
              aria-label={`从待挂清单里移除 ${item.name}`}
              title="从待挂清单里移除（它还没有挂上去）"
              onClick={() => onRemove(index)}
              className={cn(
                'h-5 w-5 shrink-0 flex items-center justify-center rounded-button',
                'text-text-secondary transition-colors hover:text-danger cursor-pointer'
              )}
            >
              <Icon name="x" size={11} />
            </button>
          </li>
        ))}
      </ul>
    )}

    {problem && (
      <p data-testid="pending-attachment-error" className="text-caption text-danger leading-relaxed">
        {problem}
      </p>
    )}
  </div>
)
