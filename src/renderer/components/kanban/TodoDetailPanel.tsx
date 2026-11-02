import React, { useEffect, useRef, useState } from 'react'
import { QuickAddForm } from '../quick-add/QuickAddForm'
import { Icon } from '../ui/Icon'
import { cn } from '../../lib/utils'

/**
 * 事项详情右栏（卡 `6ba3db21`）
 *
 * ## 它替换的是什么
 *
 * 双击卡片原先走 `window:showQuickAdd` —— 主进程开一个**独立的贴右窗口**盖在看板上。
 * 看板本身不让位，于是"对照着看板决定这条该归到哪"这件事，靠的是记忆而不是眼睛。
 * 这里把它搬进看板窗口内部：三列真实收窄，右栏随窗口一起动。
 *
 * ## 一期只改看板内这条路
 *
 * 通知、审批、版本、时间线、项目概览等入口**仍然**开独立窗口。那些页面没有"看着列表
 * 改这一条"的用法，先别为了统一而统一 —— 等这条站稳再收口。
 *
 * ## 宽度为什么可拖
 *
 * 详情里承载的东西差异很大（只改标题 vs 对着长描述 + 子任务 + 流转历史），
 * 宽度写死等于替所有人做决定。范围与独立抽屉接近，但上限更低：
 * 右栏再宽也要给三列留活路。
 */
const MIN_WIDTH = 360
const MAX_WIDTH = 760
const DEFAULT_WIDTH = 480
const WIDTH_KEY = 'deskpartner.detailPanelWidth'

const readWidth = (): number => {
  try {
    const raw = typeof window !== 'undefined' ? window.localStorage.getItem(WIDTH_KEY) : null
    const parsed = raw ? Number(raw) : NaN
    return Number.isFinite(parsed) && parsed >= MIN_WIDTH && parsed <= MAX_WIDTH
      ? Math.round(parsed)
      : DEFAULT_WIDTH
  } catch {
    return DEFAULT_WIDTH
  }
}

export interface TodoDetailPanelProps {
  todoId: string
  onClose: () => void
  /** 详情里点父/子事项：就地切换（不另开窗口） */
  onOpenTodo?: (id: string) => void
}

export const TodoDetailPanel: React.FC<TodoDetailPanelProps> = ({ todoId, onClose, onOpenTodo }) => {
  const [width, setWidth] = useState(readWidth)
  const dragRef = useRef(0)
  /**
   * 打开前焦点在哪
   *
   * 关掉右栏要把焦点还回那张卡片：否则焦点落回 body，键盘用户得从头 Tab 一遍。
   * 记的是**元素**而不是选择器 —— 卡片重渲染后选择器可能指向另一条。
   */
  const openerRef = useRef<HTMLElement | null>(null)
  useEffect(() => {
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    return () => {
      const opener = openerRef.current
      if (opener && document.contains(opener)) opener.focus()
    }
  }, [])

  /**
   * Esc 关右栏
   *
   * 为什么在面板这一层听，而不是只靠表单里的 onKeyDown：
   * 表单的键盘处理挂在它自己的容器上，焦点落在右栏空白处（或刚点过滚动条）时收不到。
   * 右栏是这一层的"可关闭容器"，Esc 在这里兜底最稳；表单里那一份照旧，
   * 重复触发只是多调一次 onClose（幂等）。
   */
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  /**
   * 拖动左缘调宽
   *
   * 面板贴右，所以**向左拖 = 变宽** —— 与独立抽屉同一手感（窗口边缘跟着手走）。
   * 只在收手时落 localStorage：拖动过程每帧写一次没有意义，还会把主线程堵在存储上。
   */
  const startDrag = (e: React.PointerEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = width
    let next = startW
    const onMove = (ev: PointerEvent) => {
      next = Math.min(Math.max(startW + (startX - ev.clientX), MIN_WIDTH), MAX_WIDTH)
      setWidth(next)
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      dragRef.current = next
      try {
        window.localStorage.setItem(WIDTH_KEY, String(Math.round(next)))
      } catch {
        /* 存不进去不影响这次拖动 */
      }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  return (
    <aside
      data-testid="todo-detail-panel"
      style={{ width }}
      className="relative shrink-0 min-h-0 flex flex-col border-l border-border bg-bg-primary"
    >
      <div
        onPointerDown={startDrag}
        role="separator"
        aria-orientation="vertical"
        aria-label="拖动调整详情宽度"
        title="拖动调整宽度"
        className="absolute left-0 top-0 bottom-0 w-1.5 cursor-col-resize z-10 bg-transparent hover:bg-accent/20 transition-colors"
      />
      <div className="shrink-0 flex items-center justify-between pl-3 pr-2 py-1.5 border-b border-border">
        <span className="text-caption text-text-secondary">事项详情</span>
        <button
          type="button"
          onClick={onClose}
          data-testid="todo-detail-close"
          aria-label="关闭详情"
          title="关闭（Esc）"
          className={cn(
            'w-6 h-6 flex items-center justify-center rounded-button transition-colors',
            'text-text-secondary hover:bg-black/5 hover:text-text-primary'
          )}
        >
          <Icon name="x" size={13} />
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto">
        <QuickAddForm embeddedTodoId={todoId} onClose={onClose} onOpenTodo={onOpenTodo} />
      </div>
    </aside>
  )
}
