import React, { useCallback, useEffect, useState } from 'react'
import { Icon } from '../ui/Icon'
import { Button } from '../ui/Button'
import { MarkdownContent } from '../ui/MarkdownContent'
import { invoke } from '../../lib/ipc-client'
import { humanizeActor } from '../../lib/timeline-display'
import { useSettingsStore } from '../../stores/settings.store'
import { STATUS_META } from '../../lib/constants'
import type { ReviewDiffItem, FieldChange } from '../../types/todo'
import { describeFieldChange } from '../../types/field-meta'
import { formatTimeOnly } from '../../lib/date'

/** 收起来时给几行：一次描述追加动辄上千字，全铺开是一面墙 */
const PREVIEW_LINES = 8

interface ReviewDiffProps {
  todoId: string
  /** 批注成功后通知外层（通常是刷新评论线程，让批注立刻出现在下面） */
  onAnnotated?: () => void
}

/**
 * 「本次变更」（1.0.73，主用户提单 `482e4b03`）
 *
 * ── 它要解决什么 ──
 *
 * 提单原文：「验收阶段渲染本次变更 diff，替代纯文字结论」，
 * 现状是「人验收时看不到 agent 这次到底改了什么，只有描述追加后的文本」。
 *
 * ── 与上面「变更记录」的分工（很重要，别混）──
 *
 * - **变更记录**答「这条事项**一路怎么走过来的**」—— 是历史，越全越好；
 * - **本次变更**答「**这一次交付**改了什么」—— 是待验的标的物，只该有这一次。
 *
 * 所以两者不是冗余的。人在验收时的真实动作是"对照这次的改动决定放不放行"，
 * 而在一屏历史里找他这次做了什么，正是提单说的"验收体验弱"。
 *
 * ── 为什么每条可批注，且批注走评论 ──
 *
 * 提单要求「人可逐条批注后通过/驳回」。批注不新造一套存储 ——
 * **评论就是本产品承载往来的唯一位置**（1.0.54 定的边界：
 * 描述=规格、评论=往来），而且批注落进评论后，
 * **驳回/返工的既有通知链、`todo get` 的读取入口、评论线程的 UI 全都自动生效**。
 * 为批注另建一张表，等于把这些全部重做一遍，还多出"两处往来对不上"的风险。
 *
 * 批注正文里带上被批注的那条变更（`关于：优先级 普通 → 高`），
 * 这样在评论线程里单看一条也知道它在说什么 —— 不依赖上下文（评论会被折叠/翻页）。
 *
 * ── 没交付过就不渲染 ──
 *
 * `todo:reviewDiff` 返回 null（从没进过待验收）时整块不出现。
 * 渲染一个"本次没有变更"的空框是**说错话** —— 事实是"还没交付过"，
 * 不是"交付了但什么都没改"。本项目反复在治"缺失 ≠ 否定"。
 */
export const ReviewDiff: React.FC<ReviewDiffProps> = ({ todoId, onAnnotated }) => {
  const { settings } = useSettingsStore()
  const [items, setItems] = useState<ReviewDiffItem[] | null>(null)
  /** 正在批注哪一条（用下标作 key：同一条变更可能有两条一样的 summary） */
  const [annotating, setAnnotating] = useState<number | null>(null)
  /** 已展开全文的那几条：描述追加动辄上千字，默认先收起 */
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    let alive = true
    void invoke('todo:reviewDiff', { todoId })
      .then((list) => {
        if (alive) setItems(list)
      })
      .catch(() => {
        if (alive) setItems(null)
      })
    return () => {
      alive = false
    }
  }, [todoId])

  useEffect(() => load(), [load])

  const submit = async (item: ReviewDiffItem) => {
    const body = draft.trim()
    if (!body || busy) return
    setBusy(true)
    try {
      /**
       * 批注 = 一条普通评论，但**正文里带上被批注的那条变更**。
       *
       * 为什么不另加 `kind`：`kind` 的既有取值（comment/reject/rework/system）
       * 每一个都对应**一种权限与一条通知链**（reject 是裁决、会触发驳回流转）。
       * 批注是"就某条改动说一句话"，它不是裁决 —— 硬塞进 reject 会把
       * "退回进行中"这个动作一起带出来，那是越权。
       */
      await invoke('todo:addComment', {
        todoId,
        body: `【批注·${item.summary}】\n${body}`
      })
      setDraft('')
      setAnnotating(null)
      onAnnotated?.()
    } finally {
      setBusy(false)
    }
  }

  // null = 还没交付过 → 整块不渲染（不是渲染空框）
  if (!items) return null
  // 交付了但确实没有可列的变化（例如只推了状态）→ 也要说明，不静默留白
  if (items.length === 0) {
    return (
      <div className="flex flex-col gap-1 pt-2 border-t border-border">
        <span className="text-content font-medium text-text-primary inline-flex items-center gap-1">
          <Icon name="checkCircle" size={13} />
          本次变更
          <span className="text-label text-text-secondary font-normal">· 这次交付</span>
        </span>
        <p className="text-label text-text-secondary px-2">
          本次仅变更状态，未修改内容。
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-1 pt-2 border-t border-border">
      <span className="text-content font-medium text-text-primary inline-flex items-center gap-1">
        <Icon name="checkCircle" size={13} />
        本次变更
        <span className="text-label text-text-secondary font-normal">
          {items.length} 条 · 这次交付
        </span>
      </span>

      {items.map((item, i) => {
        /**
         * 描述类变更现在按 Markdown 渲染（卡 `35fa2cbc`）
         *
         * 原来是把新增行逐行铺成等宽的 `+ 文本`：agent 的交付说明本身是 Markdown
         * （标题、列表、反引号），这么铺出来就是一面"符号墙"，一屏几千像素，
         * 验收时既看不出改了哪几块，也读不动。现在整段当 Markdown 渲染，
         * 长内容先收前 8 行，剩下的点开再看 —— 一次交付动辄上千字是常态。
         */
        const lines = item.lines ?? []
        const added = lines.filter((l) => l.type === 'add').map((l) => l.text)
        const text = (added.length > 0 ? added : lines.map((l) => l.text)).join('\n').trim()
        const totalLines = text ? text.split('\n').length : 0
        const isOpen = expanded.has(i)
        const shown = isOpen ? text : text.split('\n').slice(0, PREVIEW_LINES).join('\n')

        return (
          <div key={`${item.kind}-${item.at}-${i}`} className="flex flex-col gap-1 px-2 py-1">
            <div className="flex items-start gap-1.5 text-label">
              <span className="shrink-0 text-text-secondary w-8 text-right tabular-nums leading-5">
                {formatTimeOnly(item.at)}
              </span>
              {/* 摘要本身带身份，走与「变更记录」同一个 humanizeActor，不再重复渲染一遍作者 */}
              <span className="flex-1 min-w-0 break-words text-text-secondary leading-5">
                {humanizeActor(item.summary, item.actor, settings?.humanName)}
              </span>
              <button
                type="button"
                onClick={() => {
                  setAnnotating(annotating === i ? null : i)
                  setDraft('')
                }}
                className="shrink-0 text-label text-text-secondary hover:text-accent transition-colors"
                title="添加批注"
              >
                {annotating === i ? '取消' : '批注'}
              </button>
            </div>

            {/* 描述：按 Markdown 渲染，长内容先收着 */}
            {totalLines > 0 && (
              <div className="pl-10 flex flex-col gap-1">
                <div className="rounded-card border border-border/60 bg-surface-subtle px-2.5 py-2">
                  <MarkdownContent content={shown} className="gap-1" />
                </div>
                {totalLines > PREVIEW_LINES && (
                  <button
                    type="button"
                    onClick={() =>
                      setExpanded((prev) => {
                        const next = new Set(prev)
                        if (next.has(i)) next.delete(i)
                        else next.add(i)
                        return next
                      })
                    }
                    className="self-start text-caption text-text-secondary hover:text-accent transition-colors"
                  >
                    {isOpen ? '收起' : `展开全文（共 ${totalLines} 行）`}
                  </button>
                )}
              </div>
            )}

            {/* 状态：箭头（与动态同一套色点，不新造视觉） */}
            {item.status && (
              <div className="pl-10 flex items-center gap-1.5 text-label text-text-secondary">
                <StatusDot status={item.status.from} />
                <span>{item.status.from ? STATUS_META[item.status.from].label : '新建'}</span>
                <span aria-hidden>→</span>
                <StatusDot status={item.status.to} />
                <span className={item.status.isRejection ? 'text-red-500 font-medium' : undefined}>
                  {STATUS_META[item.status.to].label}
                </span>
              </div>
            )}

            {/* 字段：逐条 before → after */}
            {item.fields && item.fields.length > 0 && (
              <div className="pl-10 flex flex-col">
                {item.fields.map((f, fi) => (
                  <span key={fi} className="text-label text-text-primary">
                    {fieldLine(f)}
                  </span>
                ))}
              </div>
            )}

            {annotating === i && (
              <div className="pl-10 flex flex-col gap-1 mt-1">
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                      e.preventDefault()
                      void submit(item)
                    }
                  }}
                  placeholder="添加批注…（⌘/Ctrl + Enter 发送）"
                  rows={2}
                  maxLength={2000}
                  className="w-full bg-transparent border border-border rounded-input px-2 py-1.5
                    text-label outline-none resize-y placeholder:text-text-secondary/60
                    focus:border-accent transition-colors"
                />
                <div className="flex justify-end">
                  <Button variant="ghost" onClick={() => void submit(item)} disabled={busy}>
                    发批注
                  </Button>
                </div>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

/** 状态色点：与动态/看板同一套变量，不新造颜色 */
const StatusDot: React.FC<{ status: string | null }> = ({ status }) => {
  if (!status) return <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-border" />
  const meta = STATUS_META[status as keyof typeof STATUS_META]
  return (
    <span
      className="w-1.5 h-1.5 rounded-full shrink-0"
      style={{ backgroundColor: meta ? `var(${meta.colorVar})` : 'var(--color-text-secondary)' }}
    />
  )
}

/**
 * 字段变化 → 一行人话
 *
 * ⚠️ 取值映射**不在这里定义** —— 走 `@shared/field-meta`，
 * 与主进程的审计翻译层共用同一份（单源）。
 * 曾经这里是复制一份的写法，而那正是本项目反复在治的病：
 * 一处加字段、另一处没加，同一个字段两个叫法，**不报错、只是说错话**。
 */
function fieldLine(f: FieldChange): string {
  return describeFieldChange(f)
}
