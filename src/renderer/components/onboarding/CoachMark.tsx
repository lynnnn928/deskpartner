import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '../ui/Button'
import { useAgentStore } from '../../stores/agent.store'
import { useTodoStore } from '../../stores/todo.store'
import { useUIStore } from '../../stores/ui.store'
import {
  COACH_TOTAL,
  pickCoachMark,
  readSeen,
  rememberSeen,
  skipAllCoaches,
  type CoachSeen
} from '../../lib/coach-marks'

/**
 * 就地提示的宿主（卡 `a19054a1`，挂在看板窗口）
 *
 * ── 为什么是气泡指着真实控件，而不是再开一个演示窗 ──
 *
 * 用户对旧引导的原话是「演示式看不懂」：小窗里演一遍，关掉就没了。
 * 这里反过来 —— 气泡不动，锚在**正在挡着你的那个按钮**上；做完了它自己消失。
 *
 * ── 三处锚点为什么都在这个窗口 ──
 *
 * 审批导航项、「我的工作」的行、详情右栏的状态按钮全在看板窗口里。
 * 锚点跨窗口要配跨窗口的状态同步（另一个窗口什么时候知道该弹），
 * 代价远大于收益；现在一处宿主就够。
 *
 * ── 量位置为什么用定时器而不是 requestAnimationFrame ──
 *
 * 屏幕外的窗口里 rAF 不跑（离屏探针实测），气泡就会永远量不到位置。
 * 400ms 轮询只在"有提示要显示、锚点还没出现"时跑，量到即停。
 */
/**
 * 气泡尺寸
 *
 * 不写死成 `w-72` 的 288：class 里是 `w-72`，但那是 18rem，而根字号是 14px ——
 * 实测只有 252 宽（1.0.146 走查）。按 288 算摆位，右边明明放得下却被判成放不下。
 * 首帧先用一组估值把气泡画出来，画出来之后按**真实**尺寸重算一次位置，
 * 文案变成几行也能自己适配（`placeBeside` 的翻边判断全靠这个高度）。
 */
const ESTIMATED_SIZE: { width: number; height: number } = { width: 252, height: 160 }
const GAP = 10
const MARGIN = 12

interface Placement {
  top: number
  left: number
}

interface BubbleSize {
  width: number
  height: number
}

/**
 * 气泡摆在哪儿：默认摆到锚点右侧，右边真没地方才摆到下面或上面；`below` 直接摆下面。
 *
 * 为什么不学常见做法"居中盖在锚点下方"：三处锚点里有两处贴着窗口左缘
 * （侧栏导航项、列表行），居中的结果是气泡左半截出窗、被边距夹回来之后
 * 飘在内容区中间 —— 指着谁看不出来。贴着右缘放，永远挨着它指的东西。
 *
 * 尺寸由调用方给实测值：算得准，才不会在文案变高之后把翻边判反。
 */
function placeBeside(rect: DOMRect, size: BubbleSize, mode: 'beside' | 'below' = 'beside'): Placement {
  const viewportW = window.innerWidth
  const viewportH = window.innerHeight
  const maxLeft = Math.max(MARGIN, viewportW - size.width - MARGIN)
  const maxTop = Math.max(MARGIN, viewportH - size.height - MARGIN)
  const clampedLeft = (left: number): number => Math.min(Math.max(left, MARGIN), maxLeft)

  if (mode === 'below') {
    return { top: Math.min(rect.bottom + GAP, maxTop), left: clampedLeft(rect.left) }
  }

  if (rect.right + GAP + size.width + MARGIN <= viewportW) {
    return { top: Math.min(Math.max(rect.top - 6, MARGIN), maxTop), left: rect.right + GAP }
  }

  const centered = rect.left + rect.width / 2 - size.width / 2
  return {
    top:
      rect.bottom + GAP + size.height <= viewportH
        ? rect.bottom + GAP
        : Math.max(MARGIN, rect.top - size.height - GAP),
    left: clampedLeft(centered)
  }
}

export const CoachMarkHost: React.FC = () => {
  const agents = useAgentStore((s) => s.agents)
  const todos = useTodoStore((s) => s.todos)
  const selectedTodoId = useUIStore((s) => s.selectedTodoId)
  const [seen, setSeen] = useState<CoachSeen>(() => readSeen())
  /** 锚点的位置；量不到就先不画（气泡不能指着空气） */
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null)
  /** 气泡自己的真实尺寸：渲染出来才知道这次文案有几行 */
  const [bubbleSize, setBubbleSize] = useState<BubbleSize | null>(null)
  const bubbleRef = useRef<HTMLDivElement | null>(null)
  /** 首帧把视口外的锚点滚进来这件事只做一次（见 measure 里的注释） */
  const didScrollRef = useRef(false)

  const mark = pickCoachMark(
    {
      pendingApproval: agents.some((a) => !a.approved && !a.rejectedAt),
      firstProposed: todos.some((t) => t.status === 'proposed'),
      decidingProposed:
        Boolean(selectedTodoId) && todos.some((t) => t.id === selectedTodoId && t.status === 'proposed')
    },
    seen
  )

  useEffect(() => {
    setAnchorRect(null)
    setBubbleSize(null)
    didScrollRef.current = false
    if (!mark) return
    let alive = true

    const measure = (): boolean => {
      const anchor = document.querySelector(mark.anchor)
      if (!anchor) return false
      const first = anchor.getBoundingClientRect()
      // 侧栏收起/展开切换时会有一帧 0 尺寸：量到 0 说明还没排好，等下一次
      if (first.width === 0 && first.height === 0) return false
      if (!alive) return true
      /**
       * 锚点在折叠线以下就先滚进来（2026-11-13 实测：上手清单补到五行之后，
       * 「待确认」那条被挤到视口外，气泡于是指着一条看不见的行）。
       * 只在第一次做 —— 之后跟着用户自己滚动，不再把人拽回原处。
       */
      if (!didScrollRef.current && (first.bottom <= 0 || first.top >= window.innerHeight)) {
        didScrollRef.current = true
        anchor.scrollIntoView({ block: 'nearest' })
      }
      setAnchorRect(anchor.getBoundingClientRect())
      return true
    }

    if (!measure()) {
      const timer = window.setInterval(() => {
        if (measure()) window.clearInterval(timer)
      }, 400)
      return () => {
        alive = false
        window.clearInterval(timer)
      }
    }

    /**
     * resize 与滚动都要重新量：气泡贴着锚点，锚点被滚走之后它还留在原地，
     * 就成了"指着别的东西"。滚动监听用捕获，才收得到内层滚动容器的滚动。
     */
    const onLayoutChange = (): void => {
      measure()
    }
    window.addEventListener('resize', onLayoutChange)
    window.addEventListener('scroll', onLayoutChange, true)
    return () => {
      alive = false
      window.removeEventListener('resize', onLayoutChange)
      window.removeEventListener('scroll', onLayoutChange, true)
    }
  }, [mark])

  /**
   * 按画出来的真实尺寸重算一次摆位。文案长短决定高度，而"放得下放不下"就是比高度；
   * 写死一个估值会在改文案之后悄悄判反（1.0.146 就是这样压住上手清单的）。
   * happy-dom 里量到 0 —— 不是真尺寸就别覆盖估值。
   */
  useEffect(() => {
    const el = bubbleRef.current
    if (!el) return
    const width = el.offsetWidth
    const height = el.offsetHeight
    if (width <= 0 || height <= 0) return
    setBubbleSize((current) =>
      current && current.width === width && current.height === height ? current : { width, height }
    )
  }, [mark, anchorRect, bubbleSize])

  const placement = anchorRect ? placeBeside(anchorRect, bubbleSize ?? ESTIMATED_SIZE, mark?.placement) : null

  const dismiss = useCallback(() => {
    if (!mark) return
    setSeen(rememberSeen(mark.id))
    setAnchorRect(null)
  }, [mark])

  const skipRest = useCallback(() => {
    setSeen(skipAllCoaches())
    setAnchorRect(null)
  }, [])

  if (!mark || !placement) return null

  return (
    <div
      ref={bubbleRef}
      role="dialog"
      aria-label={mark.title}
      data-testid="coach-mark"
      className="fixed z-50 w-72 rounded-card border border-border bg-bg-card shadow-card px-3 py-2.5"
      style={{ top: placement.top, left: placement.left }}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-caption font-mono text-text-secondary" data-testid="coach-mark-step">
          {mark.step}/{COACH_TOTAL}
        </span>
        <button
          type="button"
          onClick={skipRest}
          data-testid="coach-mark-skip"
          className="text-caption text-text-secondary hover:text-text-primary cursor-pointer"
        >
          跳过引导
        </button>
      </div>
      <div className="mt-1 text-label font-semibold text-text-primary">{mark.title}</div>
      <p className="mt-0.5 text-caption leading-relaxed text-text-secondary">{mark.body}</p>
      <div className="mt-2 flex justify-end">
        <Button
          variant="ghost"
          size="sm"
          onClick={dismiss}
          data-testid="coach-mark-dismiss"
          className="border border-border bg-surface-subtle px-2.5"
        >
          知道了
        </Button>
      </div>
    </div>
  )
}
