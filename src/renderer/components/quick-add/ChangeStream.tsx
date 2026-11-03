import React, { useEffect, useMemo, useState } from 'react'
import { Icon } from '../ui/Icon'
import { Button } from '../ui/Button'
import { MarkdownContent } from '../ui/MarkdownContent'
import { invoke } from '../../lib/ipc-client'
import { humanizeActor, planStamp } from '../../lib/timeline-display'
import { useSettingsStore } from '../../stores/settings.store'
import { STATUS_META } from '../../lib/constants'
import { formatTimeOnly } from '../../lib/date'
import type { TimelineEntry, ReviewDiffItem, FieldChange } from '../../types/todo'
import { describeFieldChange } from '../../types/field-meta'

/** 收起时给两行：一次描述追加动辄上千字，全铺开就是一堵墙 */
const PREVIEW_LINES = 2
/** 历史超过这么多步就先只留最近 5 步 */
const FOLD_AFTER = 6

/** 时间线的粗分类 → 改动详情的类别（两边同源，靠这个对上号） */
const KIND_OF: Record<string, ReviewDiffItem['kind']> = {
  改描述: 'desc',
  流转: 'status',
  改字段: 'field'
}

interface ChangeStreamProps {
  todoId: string
  /** 从头到尾的时间线（旧 → 新，`timelineSeq` 是权威顺序） */
  timeline: TimelineEntry[]
  /** 最近一次进入待验收之后的改动；`null` = 从没进过待验收 */
  reviewItems: ReviewDiffItem[] | null
  /** 批注写进评论线程后，通知外层刷新 */
  onAnnotated?: () => void
}

/**
 * 「变更」：一条流（卡 `35fa2cbc`）
 *
 * ── 为什么只有一个「变更」，没有页签 ──
 *
 * 1.0.73 起这里是两块：「本次变更」（这一次交付改了什么，可逐条批注）和
 * 「变更记录」（从头到尾的流转）。主用户连着问了两次「这两之间的区别是什么」，
 * 后来直接说「变更记录和变更详情能不能合并」——她说对了：
 * **它们本来就是同一批事件**，只是一块只取"最近这次交付"、另一块取全部。
 * 分成两块要人自己把两边对起来看，正是这个功能想解决的问题。
 *
 * 所以现在是一条按时间正序的流：
 * - 普通行就是一条事件（谁、把什么改成了什么）；
 * - 落在「本次交付」窗口里的行，内容直接挂在行下（追加的正文按 Markdown 折叠两行、
 *   字段变化跟在行后），并多一个「批注」入口；
 * - 两段之间插一条分界线，说明"从这里开始是这次交付要验的东西"。
 *
 * 同一批事件为什么要按 `at` 对上号：时间线（`todo:timeline`）与改动详情
 * （`todo:reviewDiff`）在主进程是两次独立聚合，两边都从同一批审计事件/流转
 * 派生，所以 `at` 一致。对不上号时退化成普通行，**不编造**内容。
 *
 * ── 名字 ──
 *
 * 原先那块叫「本次变更」，主用户指出"其实不是本次变更，是改动详情"。
 * 合并之后不需要那个名字了：交付窗口由分界线表达，标题只剩「变更」。
 */
export const ChangeStream: React.FC<ChangeStreamProps> = ({
  todoId,
  timeline,
  reviewItems,
  onAnnotated
}) => {
  const { settings } = useSettingsStore()
  const [showAll, setShowAll] = useState(false)
  /** 已展开全文的行（按 timelineSeq：同一毫秒的两条也不会串） */
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  /** 正在批注的那一行 */
  const [annotating, setAnnotating] = useState<number | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)

  // 换事项：收起的留在收起、展开的收回，免得把上一条的滚动位置带过来
  useEffect(() => {
    setExpanded(new Set())
    setAnnotating(null)
    setDraft('')
    setShowAll(false)
  }, [todoId])

  const diffByAt = useMemo(() => {
    const map = new Map<string, ReviewDiffItem[]>()
    for (const it of reviewItems ?? []) {
      const arr = map.get(it.at) ?? []
      arr.push(it)
      map.set(it.at, arr)
    }
    return map
  }, [reviewItems])

  /** 本次交付的起点：改动里最早的那一条 */
  const cutAt = useMemo(() => {
    if (!reviewItems || reviewItems.length === 0) return null
    return reviewItems.reduce((min, it) => (it.at < min ? it.at : min), reviewItems[0].at)
  }, [reviewItems])

  const visible = showAll || timeline.length <= FOLD_AFTER ? timeline : timeline.slice(-5)

  const submit = async (seq: number, summary: string) => {
    const body = draft.trim()
    if (!body || busy) return
    setBusy(true)
    try {
      /**
       * 批注 = 一条普通评论，但**正文里带上被批注的那条变更**。
       *
       * 不另加 `kind`：`kind` 的既有取值每一个都对应一种权限与一条通知链
       * （reject 是裁决、会触发驳回流转），批注是"就某条改动说一句话"，
       * 硬塞进 reject 会把"退回进行中"一起带出来，那是越权。
       */
      await invoke('todo:addComment', { todoId, body: `【批注·${summary}】\n${body}` })
      setDraft('')
      setAnnotating(null)
      onAnnotated?.()
      void seq
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-1.5 pt-2 border-t border-border" data-testid="change-section">
      <div className="flex items-center justify-between gap-2">
        <span className="text-label font-semibold text-text-primary inline-flex items-center gap-1.5">
          <Icon name="clock" size={13} />
          <span>变更</span>
          <span className="font-mono text-caption text-text-secondary font-normal">
            {timeline.length}
          </span>
        </span>
        {timeline.length > FOLD_AFTER && (
          <button
            type="button"
            onClick={() => setShowAll(!showAll)}
            className="text-caption text-text-secondary hover:text-accent transition-colors shrink-0"
          >
            {showAll ? '只看最近 5 步' : `展开全部 ${timeline.length} 步`}
          </button>
        )}
      </div>

      <div className="rounded-card border border-border/70 bg-surface-subtle px-2.5 py-2 flex flex-col gap-0.5">
        {visible.map((t, i) => {
          const prev = i > 0 ? visible[i - 1] : null
          const { newDay, dayLabel } = planStamp(t.at, prev?.at ?? null)

          // 与改动详情对号（同一条事件在两边各聚合了一次，`at` + 类别能对上）
          const want = KIND_OF[t.kind]
          const candidates = diffByAt.get(t.at) ?? []
          const item = want ? candidates.find((c) => c.kind === want) : undefined

          const inDelivery = cutAt !== null && t.at >= cutAt
          const showBoundary = cutAt !== null && t.at >= cutAt && (!prev || prev.at < cutAt)

          const text = item
            ? humanizeActor(item.summary, item.actor, settings?.humanName)
            : humanizeActor(t.what, t.actor, settings?.humanName)

          const body = item?.kind === 'desc' ? addedText(item) : ''
          const bodyLines = body ? body.split('\n').length : 0
          const isOpen = expanded.has(t.timelineSeq)

          return (
            <div key={t.timelineSeq} className="flex flex-col">
              {newDay && (
                <span className="text-caption font-medium text-text-secondary pt-1.5 pb-0.5">
                  {dayLabel}
                </span>
              )}

              {showBoundary && (
                <div className="flex items-center gap-2 pt-1.5 pb-0.5 text-caption text-text-secondary">
                  <span className="h-px flex-1 bg-border" />
                  <span className="shrink-0">
                    本次交付 · {reviewItems?.length ?? 0} 项改动
                  </span>
                  <span className="h-px flex-1 bg-border" />
                </div>
              )}

              <div className="flex items-start gap-1.5 text-caption py-0.5">
                <span className="shrink-0 text-text-secondary tabular-nums font-mono">
                  {formatTimeOnly(t.at)}
                </span>
                <span className="min-w-0 flex-1 break-words line-clamp-2 text-text-primary">
                  {text}
                </span>
                {item && (
                  <button
                    type="button"
                    onClick={() => {
                      setAnnotating(annotating === t.timelineSeq ? null : t.timelineSeq)
                      setDraft('')
                    }}
                    className="shrink-0 text-caption text-text-secondary hover:text-accent transition-colors"
                    title="就这条改动写一条批注（写进评论）"
                  >
                    {annotating === t.timelineSeq ? '取消' : '批注'}
                  </button>
                )}
              </div>

              {/* 追加的正文：默认两行，点开才整段按 Markdown 渲染 */}
              {body && (
                <div className="flex flex-col gap-1 pb-0.5">
                  {isOpen ? (
                    <MarkdownContent content={body} className="gap-1 border-l-2 border-border pl-2" />
                  ) : (
                    <p className="text-label text-text-primary line-clamp-2 border-l-2 border-border pl-2">
                      {previewOf(body)}
                    </p>
                  )}
                  <button
                    type="button"
                    onClick={() =>
                      setExpanded((prevSet) => {
                        const next = new Set(prevSet)
                        if (next.has(t.timelineSeq)) next.delete(t.timelineSeq)
                        else next.add(t.timelineSeq)
                        return next
                      })
                    }
                    className="self-start text-caption text-text-secondary hover:text-accent transition-colors"
                  >
                    {isOpen ? '收起' : `展开全文（共 ${bodyLines} 行）`}
                  </button>
                </div>
              )}

              {/* 字段变化：跟在行后一行，不再另起一块 */}
              {item?.kind === 'field' && item.fields && item.fields.length > 0 && (
                <p className="text-label text-text-secondary pb-0.5 break-words">
                  {item.fields.map(fieldLine).join('；')}
                </p>
              )}

              {/* 状态变化：摘要本身已经写了「从 X 到 Y」，不再画一遍箭头（那正是重复） */}
              {item?.kind === 'status' && item.status?.isRejection && (
                <p className="text-label text-red-500 pb-0.5">退回到「{label(item.status.to)}」</p>
              )}

              {annotating === t.timelineSeq && (
                <div className="flex flex-col gap-1 pt-0.5">
                  <textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                        e.preventDefault()
                        void submit(t.timelineSeq, item?.summary ?? t.what)
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
                    <Button
                      variant="ghost"
                      onClick={() => void submit(t.timelineSeq, item?.summary ?? t.what)}
                      disabled={busy}
                    >
                      发批注
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/**
 * 取「追加的那部分正文」（卡 `35fa2cbc`）
 *
 * 追加块的正文是 agent 写的一整篇 Markdown，但 `desc-audit` 会在开头补一行
 * 自动戳 `补充（agent:xxx · 2026-11-02 09:35）：` 和一条 `---` 分隔线：
 * 作者与时间在行上已经有了，且那行里的时间是 UTC（09:35），与行上的本地
 * 17:35 打架 —— 两处对不上，读者只会以为数据错了。这里统一剥掉。
 */
export function addedText(item: ReviewDiffItem): string {
  const lines = (item.lines ?? [])
    .filter((l) => l.type === 'add')
    .map((l) => l.text)
  const kept = lines.filter((l) => {
    const s = l.trim()
    if (/^-{3,}$/.test(s)) return false
    // 自动戳：含「·」且整行就是 "补充（…）："
    if (/^补充（[^）]*·[^）]*）：$/.test(s)) return false
    return true
  })
  return kept.join('\n').replace(/^\n+/, '').trim()
}

/** 收起时的两行预览：去掉 Markdown 记号，取前两行有内容的 */
function previewOf(body: string): string {
  return (
    body
      .split('\n')
      .map((l) =>
        l
          .trim()
          .replace(/^#{1,6}\s+/, '')
          .replace(/^[-*•]\s+/, '')
          .replace(/^\d+\.\s+/, '')
      )
      .filter(Boolean)
      .slice(0, PREVIEW_LINES)
      .join(' ') || body
  )
}

/** 字段变化 → 一行人话（映射不在这里定义，走 `field-meta` 单源） */
function fieldLine(f: FieldChange): string {
  return describeFieldChange(f)
}

function label(status: string | null): string {
  if (!status) return '新建'
  return STATUS_META[status as keyof typeof STATUS_META]?.label ?? status
}

/**
 * 取「本次交付」的改动清单
 *
 * 取数放在这里而不是组件内部：外层要按 `null`（从没进过待验收）决定整块出不出，
 * 也要把条数交给分界线。
 */
export function useReviewDiff(todoId: string | null): ReviewDiffItem[] | null {
  const [items, setItems] = useState<ReviewDiffItem[] | null>(null)

  useEffect(() => {
    if (!todoId) {
      setItems(null)
      return
    }
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

  return items
}
