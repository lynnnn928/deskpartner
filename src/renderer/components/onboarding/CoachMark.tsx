import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '../ui/Button'
import { useAgentStore } from '../../stores/agent.store'
import { useTodoStore } from '../../stores/todo.store'
import { useUIStore } from '../../stores/ui.store'
import { useOnboardingStatus } from '../../lib/use-onboarding-status'
import {
  pickCoachMark,
  readOnboardingJump,
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

/**
 * 清单此刻有没有在替我们指路
 *
 * 「当前行在视口里」不能靠 `IntersectionObserver`：离屏窗口不合成帧，
 * 那个回调一次都不来（本仓库实测过同类问题）。这里直接量矩形，
 * 由宿主按 600ms 轮询 —— 判据简单，代价是两次 querySelector。
 *
 * 判据取"没在指路"而不是"在指路"：清单元素还没挂上 / 已收起 / 被滚出视口，
 * 三种情况都该由气泡接手，所以默认答案是"没在指路"。
 */
function isChecklistQuiet(): boolean {
  if (document.querySelector('[data-testid="onboarding-checklist-collapsed"]')) return true
  const section = document.querySelector('[data-testid="onboarding-checklist"]')
  if (!section) return true
  const rect = section.getBoundingClientRect()
  if (rect.width === 0 && rect.height === 0) return true
  return rect.bottom <= 0 || rect.top >= window.innerHeight
}

export const CoachMarkHost: React.FC = () => {
  const agents = useAgentStore((s) => s.agents)
  const todos = useTodoStore((s) => s.todos)
  const selectedTodoId = useUIStore((s) => s.selectedTodoId)
  const mainView = useUIStore((s) => s.mainView)
  const { status } = useOnboardingStatus()
  const [seen, setSeen] = useState<CoachSeen>(() => readSeen())
  /** 清单是否已收起/滚出视口；轮询更新，初值按当前 DOM 量一次 */
  const [checklistQuiet, setChecklistQuiet] = useState<boolean>(() => isChecklistQuiet())
  /** 锚点的位置；量不到就先不画（气泡不能指着空气） */
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null)
  /** 气泡自己的真实尺寸：渲染出来才知道这次文案有几行 */
  const [bubbleSize, setBubbleSize] = useState<BubbleSize | null>(null)
  const bubbleRef = useRef<HTMLDivElement | null>(null)
  /** 首帧把视口外的锚点滚进来这件事只做一次（见 measure 里的注释） */
  const didScrollRef = useRef(false)

  /**
   * 清单收起/展开、被滚出视口，都不会触发任何 store 更新 ——
   * 不给它一个轮询，气泡 1 就会一直以为清单还在指路而不出现（或反过来挡着清单）。
   */
  useEffect(() => {
    const timer = window.setInterval(() => {
      const next = isChecklistQuiet()
      setChecklistQuiet((current) => (current === next ? current : next))
    }, 600)
    return () => window.clearInterval(timer)
  }, [])

  const mark = pickCoachMark(
    {
      pendingApproval: agents.some((a) => !a.approved && !a.rejectedAt),
      approvalPage: mainView === 'approval',
      checklistQuiet,
      jumpedToAbout: readOnboardingJump() === 'about' && !status.basicsConfirmed,
      jumpedToProtocol: readOnboardingJump() === 'protocol' && !status.globalProtocolConfirmed,
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

    /** 两次量到的矩形是否已经不同 —— 不同才更新 state，别让 400ms 轮询一直重渲染 */
    const sameRect = (a: DOMRect | null, b: DOMRect): boolean =>
      a !== null &&
      Math.abs(a.top - b.top) < 0.5 &&
      Math.abs(a.left - b.left) < 0.5 &&
      Math.abs(a.width - b.width) < 0.5 &&
      Math.abs(a.height - b.height) < 0.5

    const clearIfShown = (): void => {
      if (alive) setAnchorRect((current) => (current === null ? current : null))
    }

    const measure = (): boolean => {
      const anchor = document.querySelector(mark.anchor)
      if (!anchor) {
        /**
         * 锚点消失了就把气泡收起来。
         *
         * 1.0.147 走查实测：从清单跳到用户页时气泡指「保存并确认」，切回「我的工作」
         * 之后那颗按钮已经不在了，气泡却还挂在原来的坐标上 —— 正好印证它指的
         * 是个不存在的东西。三处旧锚点都在同一页，所以以前没露过这个破绽。
         */
        clearIfShown()
        return false
      }
      const first = anchor.getBoundingClientRect()
      // 侧栏收起/展开切换时会有一帧 0 尺寸：量到 0 说明还没排好，等下一次
      if (first.width === 0 && first.height === 0) {
        clearIfShown()
        return false
      }
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
      const next = anchor.getBoundingClientRect()
      if (alive) setAnchorRect((current) => (sameRect(current, next) ? current : next))
      return true
    }

    measure()
    /**
     * 一直轮询，不再"量到一次就停"：气泡显示期间锚点可能被换掉（换视图、
     * 收起侧栏、列表重排），那时它必须跟着消失或跟上，而不是留在原地指空气。
     * 轮询只在有提示要显示的时候跑，代价是一次 querySelector + 一次量矩形。
     */
    const timer = window.setInterval(() => {
      measure()
    }, 400)

    /**
     * resize 与滚动还要立刻跟上：气泡贴着锚点，锚点被滚走之后它还留在原地，
     * 就成了"指着别的东西"。滚动监听用捕获，才收得到内层滚动容器的滚动。
     */
    const onLayoutChange = (): void => {
      measure()
    }
    window.addEventListener('resize', onLayoutChange)
    window.addEventListener('scroll', onLayoutChange, true)
    return () => {
      alive = false
      window.clearInterval(timer)
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
      <div className="flex items-center justify-end gap-2">
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
