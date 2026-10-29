import React, { useEffect, useMemo, useState } from 'react'
import { Icon } from '../ui/Icon'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { invoke } from '../../lib/ipc-client'
import { cn } from '../../lib/utils'
import { ownerLabel } from '../../lib/todo-filter'
import { useSettingsStore } from '../../stores/settings.store'
import type { TodoComment, CommentAuthorType, CommentKind } from '../../types/todo'

interface CommentThreadProps {
  todoId: string
  /** 从项目全文检索进入时展开并定位这一条评论 */
  focusCommentId?: string | null
  /**
   * 外部触发的刷新令牌（1.0.73，`482e4b03`）
   *
   * 「本次变更」里的批注是发进这里的，但两个组件各拉各的数据 ——
   * 值一变就重取一次，让批注立刻出现在线程里。
   *
   * 为什么是"令牌"而不是父组件直接把评论列表传下来：线程内部还有折叠状态、
   * 回复目标、展开更多，把它们全提升到父层只为了通知一次刷新，代价远大于收益。
   */
  refreshToken?: number
}

/**
 * 事项评论线程（1.0.54，主用户 2026-09-28 设计改良）
 *
 * ── 为什么需要它 ──
 *
 * 此前 `description` 身兼两职：既是"原始需求规格"，又被当成"往来记录箱"。
 * 结果描述越接越长、分不清哪句是规格（主用户 09-24 实测踩过：6 条描述被
 * 追加成 3 代文本）。这里把"往来"从描述里剥出来，成为独立的评论线程。
 *
 * ── 边界 ──
 *
 * 规格留在上面的描述框（改 = 编辑规格）；这里只放往来（只增不改）。
 * 所以本组件的定位不是"另一个描述框"，而是**对话时间线**。
 *
 * ── 折叠规则（主用户指定）──
 *
 * 评论可折叠；**agent 评论不默认折叠** —— agent 产出是"人最该看到的
 * actionable 内容"，冗余刷屏主要来自人类/system 类。所以：
 * - agent 评论：默认展开，不可折叠；
 * - human / system 评论：超过阈值（3 条）时默认折叠，可展开。
 *
 * ── 回复 ──
 *
 * `parentId` 指向被回复的评论，楼中楼。顶层评论按时间正序，
 * 其回复紧随其后、缩进一级。
 */
export const CommentThread: React.FC<CommentThreadProps> = ({ todoId, refreshToken, focusCommentId }) => {
  const { settings } = useSettingsStore()
  const [comments, setComments] = useState<TodoComment[]>([])
  const [draft, setDraft] = useState('')
  const [replyTo, setReplyTo] = useState<TodoComment | null>(null)
  /** human/system 类评论的"展开更多"——默认折叠旧的那批 */
  const [showAllHuman, setShowAllHuman] = useState(false)
  const [busy, setBusy] = useState(false)

  /**
   * 拉评论。返回值是**结果**而不是 cleanup 函数 ——
   * 之前它返回一个取消函数，被 `useEffect(() => load(), [load])` 当成 cleanup 用，
   * 看着能用（React 接受任意函数），但那个"取消"靠闭包里的 `alive`，
   * 与 effect 自己的生命周期是两套东西；refreshToken 变时会同时触发两条路径，
   * 谁取消谁不明确。改成"effect 自己管生命周期"，判据只有一处。
   */
  const load = React.useCallback(async (): Promise<TodoComment[]> => {
    try {
      const list = await invoke('todo:comments', { todoId })
      return list ?? []
    } catch {
      return []
    }
  }, [todoId])

  useEffect(() => {
    let alive = true
    void load().then((list) => {
      if (alive) setComments(list)
    })
    return () => {
      alive = false
    }
    // refreshToken 变化 = 外部（本次变更的批注）刚写了一条，要重新取
  }, [load, refreshToken])

  useEffect(() => {
    if (!focusCommentId || !comments.some((comment) => comment.id === focusCommentId)) return
    // 命中项可能处在默认折叠的较早 human/system 评论中，先展开再定位。
    if (!showAllHuman) setShowAllHuman(true)
    const frame = window.requestAnimationFrame(() => {
      document.getElementById(`todo-comment-${focusCommentId}`)?.scrollIntoView({
        block: 'center',
        behavior: 'smooth'
      })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [comments, focusCommentId, showAllHuman])

  /**
   * 把扁平列表折成"顶层 + 其回复"两棵树。
   *
   * 回复的父可能不在前 N 条里（折叠时被切掉），此时把它当顶层渲染 ——
   * 宁可层级偶尔少一层，也不要让一条评论凭空消失。
   */
  const { roots, repliesOf } = useMemo(() => {
    const byParent = new Map<string, TodoComment[]>()
    const top: TodoComment[] = []
    const ids = new Set(comments.map((c) => c.id))
    for (const c of comments) {
      if (c.parentId && ids.has(c.parentId)) {
        const arr = byParent.get(c.parentId) ?? []
        arr.push(c)
        byParent.set(c.parentId, arr)
      } else {
        top.push(c)
      }
    }
    return { roots: top, repliesOf: byParent }
  }, [comments])

  /** 非 agent 的顶层评论（决定折叠哪些） */
  const foldableRoots = roots.filter((c) => c.authorType !== 'agent')
  const hiddenCount = Math.max(0, foldableRoots.length - 3)
  /** 折叠时保留最近 3 条 human/system + 全部 agent 评论 */
  const visibleRoots = useMemo(() => {
    if (showAllHuman || hiddenCount === 0) return roots
    const keep = new Set(foldableRoots.slice(-3).map((c) => c.id))
    return roots.filter((c) => c.authorType === 'agent' || keep.has(c.id))
  }, [roots, foldableRoots, hiddenCount, showAllHuman])

  const submit = async () => {
    const body = draft.trim()
    if (!body || busy) return
    setBusy(true)
    try {
      await invoke('todo:addComment', {
        todoId,
        body,
        parentId: replyTo?.id ?? null
      })
      setDraft('')
      setReplyTo(null)
      setShowAllHuman(true)
      setComments(await load())
    } finally {
      setBusy(false)
    }
  }

  /**
   * 删除确认：与看板"删父任务"同一形态（局部 Dialog，不落库不进 store）。
   *
   * 为什么要给界面留这个口子：评论只增不改，打错字或发错地方时，
   * 没有删除就只能再发一条"刚才那条作废"——那是把噪音留在时间线上。
   * 用 Dialog 而不是 window.confirm：本项目所有破坏性确认都走 Dialog，
   * 系统原生弹层在悬浮窗里样式割裂、且拿不到主题。
   */
  const [deletePrompt, setDeletePrompt] = useState<{ comment: TodoComment; replies: number } | null>(
    null
  )

  const doRemove = async () => {
    if (!deletePrompt) return
    const target = deletePrompt.comment
    setBusy(true)
    try {
      await invoke('todo:deleteComment', { id: target.id })
      if (replyTo?.id === target.id) setReplyTo(null)
      setDeletePrompt(null)
      setComments(await load())
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-2 pt-2 border-t border-border">
      <div className="flex items-center justify-between">
        <span className="text-label font-semibold text-text-primary inline-flex items-center gap-1.5">
          <Icon name="messageCircle" size={13} />
          <span>评论</span>
          {comments.length > 0 && (
            <span className="font-mono text-caption text-text-secondary font-normal">{comments.length}</span>
          )}
        </span>
        {hiddenCount > 0 && !showAllHuman && (
          <button
            type="button"
            onClick={() => setShowAllHuman(true)}
            className="text-caption text-text-secondary hover:text-accent transition-colors"
          >
            展开更早的 {hiddenCount} 条评论
          </button>
        )}
      </div>

      {visibleRoots.length > 0 && (
        <div className="flex flex-col gap-1">
          {visibleRoots.map((c) => (
            <CommentItem
              key={c.id}
              comment={c}
              replies={repliesOf.get(c.id) ?? []}
              humanName={settings?.humanName}
              focusCommentId={focusCommentId}
              onReply={setReplyTo}
              onDelete={(item) =>
                setDeletePrompt({
                  comment: item,
                  replies: comments.filter((x) => x.parentId === item.id).length
                })
              }
            />
          ))}
        </div>
      )}

      {/* 一体化评论输入卡 */}
      <div className="rounded-input border border-border bg-bg-card focus-within:border-accent transition-colors overflow-hidden">
        {replyTo && (
          <div className="flex items-center justify-between gap-2 bg-surface-subtle px-2.5 py-1 border-b border-border/60 text-caption text-text-secondary">
            <div className="flex items-center gap-1.5 min-w-0">
              <Icon name="messageCircle" size={11} className="shrink-0" />
              <span className="shrink-0">正在回复 {displayName(replyTo, settings?.humanName)}：</span>
              <span className="truncate text-text-primary">{replyTo.body}</span>
            </div>
            <button
              type="button"
              onClick={() => setReplyTo(null)}
              className="hover:text-text-primary shrink-0 px-1"
              title="取消回复"
            >
              ×
            </button>
          </div>
        )}
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault()
              void submit()
            }
          }}
          placeholder={replyTo ? '输入回复内容……（Ctrl + Enter 发送）' : '写一条评论……（Ctrl + Enter 发送）'}
          rows={2}
          maxLength={2000}
          className="w-full bg-transparent px-3 py-2 text-label outline-none resize-y placeholder:text-text-secondary/60"
        />
        <div className="flex items-center justify-between px-2.5 py-1.5 bg-surface-subtle border-t border-border/50">
          <span className="text-caption text-text-secondary/70">支持多行输入，Ctrl + Enter 快捷发送</span>
          <Button size="sm" variant="ghost" disabled={!draft.trim() || busy} onClick={submit}>
            {replyTo ? '发送回复' : '发送评论'}
          </Button>
        </div>
      </div>

      {/* 删除确认：与看板删父任务同形态，不落库、一次性 */}
      <Dialog open={!!deletePrompt} onClose={() => setDeletePrompt(null)}>
        {deletePrompt && (
          <div className="flex flex-col gap-3">
            <h3 className="text-title font-medium text-text-primary">删除这条评论？</h3>
            <p className="text-content text-text-secondary whitespace-pre-wrap break-words line-clamp-4">
              {deletePrompt.comment.body}
            </p>
            <p className="text-content text-text-primary">
              {deletePrompt.replies > 0 ? (
                <>
                  其下 <strong>{deletePrompt.replies}</strong> 条回复将一并删除。
                </>
              ) : (
                <span className="text-red-500">删除后无法恢复。</span>
              )}
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setDeletePrompt(null)}>
                取消
              </Button>
              <Button variant="ghost" onClick={doRemove} disabled={busy}>
                删除
              </Button>
            </div>
          </div>
        )}
      </Dialog>
    </div>
  )
}

/** 作者显示名：human 用设置里的人类名，agent 用 ownerLabel 的短名 */
function displayName(c: TodoComment, humanName?: string): string {
  if (c.authorType === 'system') return '系统'
  return ownerLabel(c.authorId ?? (c.authorType === 'human' ? 'human' : ''), humanName)
}

const KIND_META: Record<CommentKind, { label: string; color: string } | null> = {
  comment: null,
  reject: { label: '驳回', color: '#EF4444' },
  rework: { label: '返工', color: '#F59E0B' },
  system: { label: '系统', color: '#94A3B8' }
}

const AUTHOR_META: Record<CommentAuthorType, { color: string; icon: string }> = {
  human: { color: 'var(--color-status-todo)', icon: 'user' },
  agent: { color: '#A855F7', icon: 'bot' },
  system: { color: '#94A3B8', icon: 'clock' }
}

const CommentItem: React.FC<{
  comment: TodoComment
  replies: TodoComment[]
  humanName?: string
  focusCommentId?: string | null
  onReply: (c: TodoComment) => void
  onDelete: (c: TodoComment) => void
}> = ({ comment, replies, humanName, focusCommentId, onReply, onDelete }) => {
  const kind = KIND_META[comment.kind]
  const author = AUTHOR_META[comment.authorType]
  return (
    <div className="flex flex-col">
      <CommentRow
        comment={comment}
        kind={kind}
        author={author}
        humanName={humanName}
        highlighted={comment.id === focusCommentId}
        onReply={onReply}
        onDelete={onDelete}
      />
      {/* 楼中楼：缩进一级，不递归（只支持一层回复） */}
      {replies.map((r) => (
        <div key={r.id} className="pl-4 border-l border-border ml-2">
          <CommentRow
            comment={r}
            kind={KIND_META[r.kind]}
            author={AUTHOR_META[r.authorType]}
            humanName={humanName}
            highlighted={r.id === focusCommentId}
            onReply={onReply}
            onDelete={onDelete}
          />
        </div>
      ))}
    </div>
  )
}

const CommentRow: React.FC<{
  comment: TodoComment
  kind: { label: string; color: string } | null
  author: { color: string; icon: string }
  humanName?: string
  highlighted?: boolean
  onReply: (c: TodoComment) => void
  onDelete: (c: TodoComment) => void
}> = ({ comment, kind, author, humanName, highlighted, onReply, onDelete }) => (
  <div
    id={`todo-comment-${comment.id}`}
    data-comment-id={comment.id}
    className={cn(
      'group flex items-start gap-2 px-2 py-1 rounded-tag hover:bg-black/5 transition-colors',
      highlighted && 'bg-accent/10 ring-1 ring-accent/40'
    )}
  >
    <Icon
      name={author.icon as never}
      size={13}
      className="mt-0.5 shrink-0"
      // 作者色：人蓝 / agent 紫 / 系统灰，扫一眼分得出谁在说
    />
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-1.5 text-label">
        <span className="font-medium text-text-primary">{displayName(comment, humanName)}</span>
        {kind && (
          <span
            className="inline-flex items-center h-4 px-1 rounded-tag text-label font-medium"
            style={{ backgroundColor: kind.color + '26', color: kind.color }}
          >
            {kind.label}
          </span>
        )}
        <span className="text-text-secondary/60 ml-auto shrink-0">
          {formatShort(comment.createdAt)}
        </span>
      </div>
      {/* whitespace-pre-wrap：评论里的换行是有意义的（规格/步骤常多行） */}
      <p className="text-label text-text-primary whitespace-pre-wrap break-words">{comment.body}</p>
    </div>
    <div className="flex items-center gap-1.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
      <button
        type="button"
        onClick={() => onReply(comment)}
        className="text-label text-text-secondary hover:text-accent"
        title="回复这条评论"
      >
        回复
      </button>
      <button
        type="button"
        onClick={() => onDelete(comment)}
        className="text-label text-text-secondary hover:text-red-500"
        title="删除这条评论"
      >
        删除
      </button>
    </div>
  </div>
)

/** 紧凑时间：与流转历史同一口径（只给时分，日期在 tooltip 里补全） */
function formatShort(iso: string): string {
  const d = new Date(iso)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  return `${mm}-${dd} ${hh}:${mi}`
}
