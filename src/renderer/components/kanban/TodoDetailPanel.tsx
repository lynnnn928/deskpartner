import React, { useCallback, useEffect, useRef, useState } from 'react'
import { QuickAddForm } from '../quick-add/QuickAddForm'
import { Icon } from '../ui/Icon'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { clearQuickAddDraftForTodo } from '../../lib/unsaved-drafts'
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
  /** 表单里有没有未保存的改动 —— 关右栏要不要先问一句，全看它 */
  const [dirty, setDirty] = useState(false)
  /** 「放弃未保存的修改？」开着的时候，关右栏先落到这个框上 */
  const [confirmOpen, setConfirmOpen] = useState(false)

  /**
   * 打开前焦点在哪 + 当前看的是哪一条
   *
   * 关掉右栏要把焦点还回那张卡片：否则焦点落回 body，键盘用户得从头 Tab 一遍。
   *
   * 两条线索都要：`todoIdRef` 给"详情里点父子事项、就地换了一条"的情况 ——
   * 那时该回到**最后看的那条**的卡片，而不是最初双击的那张。
   * `openerRef` 是兜底：那条卡片被筛掉/换了视图时，退回打开前真正有焦点的元素。
   */
  const openerRef = useRef<HTMLElement | null>(null)
  const todoIdRef = useRef(todoId)
  useEffect(() => {
    todoIdRef.current = todoId
  }, [todoId])
  /**
   * 换了一条事项 = 换了一次编辑（卡 `82e4b1f6`）
   *
   * 详情里点父/子事项是**就地**换 id，面板不卸载。表单那边因此必须重挂
   * （下面的 `key={todoId}`）：窗口形态换一条本来就是整页重载，内嵌形态得同义，
   * 否则"有改动就不重填"的守卫会让新一条顶着上一条的内容，保存就写错了条目。
   *
   * 换完之后"有没有未保存的改动"要重新算 —— 旧那条的脏状态不属于新这条，
   * 留着会让关右栏时白弹一次确认框。
   */
  useEffect(() => {
    setDirty(false)
    setConfirmOpen(false)
  }, [todoId])
  useEffect(() => {
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    return () => {
      const card = document.querySelector<HTMLElement>(`[data-todo-id="${todoIdRef.current}"]`)
      const opener = openerRef.current
      const target =
        card ??
        (opener && opener !== document.body && document.contains(opener) ? opener : null)
      // preventScroll：卡片在列表很下面时，别把看板拽回去 —— 人刚看完详情，视野该留在原地
      target?.focus({ preventScroll: true })
    }
  }, [])

  /**
   * 请求关闭：有未保存的改动先问一句
   *
   * 关闭按钮、Esc、表单里的「取消」都汇到这里 —— 三条路各写一遍"脏了就拦"，
   * 迟早漏一条，而漏掉的那条就是丢改动的那条。
   */
  const requestClose = useCallback(() => {
    if (dirty) {
      setConfirmOpen(true)
      return
    }
    onClose()
  }, [dirty, onClose])

  /**
   * Esc 关右栏
   *
   * 为什么在面板这一层听，而不是只靠表单里的 onKeyDown：
   * 表单的键盘处理挂在它自己的容器上，焦点落在右栏空白处（或刚点过滚动条）时收不到。
   * 右栏是这一层的"可关闭容器"，Esc 在这里兜底最稳；表单里那一份照旧 ——
   * 两处都走 requestClose，重复触发只是多弹一次同一个确认框（幂等）。
   *
   * 确认框开着时 Esc 只关框（=「继续编辑」），不会连右栏一起关掉。
   */
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (confirmOpen) {
        setConfirmOpen(false)
        return
      }
      requestClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [confirmOpen, requestClose])

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
    <>
      <aside
        data-testid="todo-detail-panel"
        style={{ width }}
        className="relative shrink-0 min-h-0 flex flex-col my-3 mr-3 rounded-card border border-border bg-bg-card shadow-card overflow-hidden"
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
            onClick={requestClose}
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
          <QuickAddForm
            key={todoId}
            embeddedTodoId={todoId}
            onClose={onClose}
            onOpenTodo={onOpenTodo}
            onRequestClose={requestClose}
            onDirtyChange={setDirty}
          />
        </div>
      </aside>
      {/*
        放弃未保存的修改（卡 `6ba3db21`）
        
        右栏一关，表单里那段没提交的东西就没了 —— 而「关详情」这个动作本身
        读不出这个代价。所以只在真的改过（dirty）时才多这一步：干净的右栏
        关起来不该被拦。
      */}
      <Dialog open={confirmOpen} onClose={() => setConfirmOpen(false)}>
        <div className="flex w-full flex-col gap-3" role="alertdialog" aria-labelledby="discard-draft-title">
          <h3 id="discard-draft-title" className="text-body font-medium text-text-primary">
            放弃未保存的修改？
          </h3>
          <p className="text-label leading-relaxed text-text-secondary">
            这条事项的改动还没保存，关掉右栏后就没有了。
          </p>
          <div className="flex items-center justify-end gap-2 pt-1">
            <Button
              variant="ghost"
              size="sm"
              autoFocus
              data-testid="todo-detail-keep-editing"
              onClick={() => setConfirmOpen(false)}
            >
              继续编辑
            </Button>
            <Button
              variant="danger"
              size="sm"
              data-testid="todo-detail-discard"
              onClick={() => {
                /**
                 * 「放弃修改」必须真的丢（卡 `77aedd14`）
                 *
                 * 表单在"有改动"时每次渲染都往 sessionStorage 写一份草稿；
                 * 只关面板、不清草稿，下次打开同一条会把原文原样恢复出来 ——
                 * 那和这个按钮说的话正相反，等于给了一个假确认。
                 */
                clearQuickAddDraftForTodo(todoId)
                setConfirmOpen(false)
                setDirty(false)
                onClose()
              }}
            >
              放弃修改
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  )
}
