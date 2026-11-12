import React, { useEffect, useRef, useState } from 'react'
import { TodoDetailShell, DETAIL_DRAG_HANDLE_CLASS } from '../quick-add/TodoDetailShell'

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
 * ## 外壳已经统一，只差位置（卡 `1d3d7006`）
 *
 * 标题条、关闭方式、未保存提醒、卡片外观都在 `TodoDetailShell` 里，独立窗口用的是
 * 同一份 —— 两块形态不该像两个产品。这里只剩"右栏"这一侧自己的事：宽度可拖、注意力
 * 回到哪张卡片上。
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
    <TodoDetailShell
      todoId={todoId}
      embeddedTodoId={todoId}
      onClose={onClose}
      onOpenTodo={onOpenTodo}
      testId="todo-detail-panel"
      // 自留边距：右栏是内容区里的一张卡片，不是贴窗口边缘的整列面板（卡 `35fa2cbc`）
      className="my-3 mr-3"
      style={{ width }}
    >
      <div
        onPointerDown={startDrag}
        role="separator"
        aria-orientation="vertical"
        aria-label="拖动调整详情宽度"
        title="拖动调整宽度"
        className={DETAIL_DRAG_HANDLE_CLASS}
      />
    </TodoDetailShell>
  )
}
