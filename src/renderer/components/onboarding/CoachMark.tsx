import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '../ui/Button'
import { useAgentStore } from '../../stores/agent.store'
import { useTodoStore } from '../../stores/todo.store'
import { useUIStore } from '../../stores/ui.store'
import { useOnboardingStatus } from '../../lib/use-onboarding-status'
import { isPendingAgent } from '../../lib/grant-state'
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
 *
 * ── 蒙版与「下一步」（1.0.147 用户要求，参考一套 1/7 引导卡的样式）──
 *
 * 气泡出现时整窗压暗，只留锚点那一块亮着 —— 这样"指着谁"不用读文案也看得出来。
 * 底部只放两个动作：`跳过引导` / `下一步`，点遮罩与按 Esc 等同于「下一步」。
 * 计数 `n/N` **刻意不做**：清单卡头有 `doneCount/5`，两者会出现在同一屏。
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
/**
 * 遮罩给锚点留的亮区余量
 *
 * 亮区不贴着控件边：留一圈余量，高亮框才不会压在控件自己的边界上，
 * 也让"没被压暗的那块"看起来是**框出来的**，而不是遮罩漏了。
 */
const HOLE_PAD = 4

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

/** 视口内的一块矩形（遮罩挡板与亮区都用它摆位） */
interface Box {
  top: number
  left: number
  width: number
  height: number
}

/** 锚点周围那块不压暗的亮区，含 `HOLE_PAD` 的余量，并夹在视口内 */
function holeAround(rect: DOMRect): Box {
  const left = Math.max(0, rect.left - HOLE_PAD)
  const top = Math.max(0, rect.top - HOLE_PAD)
  const right = Math.min(window.innerWidth, rect.right + HOLE_PAD)
  const bottom = Math.min(window.innerHeight, rect.bottom + HOLE_PAD)
  return { top, left, width: Math.max(0, right - left), height: Math.max(0, bottom - top) }
}

/**
 * 遮罩的四块挡板：把亮区让出来，其余四边压暗
 *
 * ── 为什么不是「整窗压一层 + 锚点上再叠一块亮色」──
 *
 * 叠不回去：遮罩是半透明的，锚点透出来的像素已经被拉灰了，
 * 「肉眼可见」就打了折。真正留一个洞，锚点还是原来的亮度与颜色。
 *
 * ── 为什么是四块，而不是 `box-shadow: 0 0 0 9999px …` 挖洞 ──
 *
 * 那是最省事的写法，但它必须是内联色值 —— 阴影闸门（1.0.116）之后
 * 内联 `boxShadow` 字面量是明确的盲区禁写法。四块挡板只写几何，
 * 颜色仍旧经工具类（`bg-black/40`，与对话框遮罩同一档）。
 *
 * 四块**互不重叠**：上 / 下是通栏的，左右两块只占亮区那一段高度 ——
 * 叠起来会在拼缝处压两遍、黑一道。用例按"任何一块都盖不到锚点"钉住这条几何。
 */
function maskPanels(hole: Box): Box[] {
  const right = hole.left + hole.width
  const bottom = hole.top + hole.height
  return [
    { top: 0, left: 0, width: window.innerWidth, height: hole.top },
    { top: bottom, left: 0, width: window.innerWidth, height: Math.max(0, window.innerHeight - bottom) },
    { top: hole.top, left: 0, width: hole.left, height: hole.height },
    { top: hole.top, left: right, width: Math.max(0, window.innerWidth - right), height: hole.height }
  ]
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
  /**
   * 视口尺寸（`宽x高`），只用来**触发重画**
   *
   * 遮罩的四块挡板按 `innerWidth/innerHeight` 铺满：窗口被拉大之后不重算，
   * 边上就会留一条没压暗的缝。锚点矩形不一定会跟着变（纵向拉伸时行宽、行高都不动），
   * 所以不能指望上面那轮 400ms 轮询顺手把遮罩带出来。
   */
  const [viewport, setViewport] = useState<string>(() => `${window.innerWidth}x${window.innerHeight}`)
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
      pendingApproval: agents.some(isPendingAgent),
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
  /** 锚点周围那块亮区；遮罩与高亮框都按它摆 */
  const hole = anchorRect ? holeAround(anchorRect) : null
  const visible = Boolean(mark && placement && hole)

  /**
   * 关掉这一条，下一条按顺序接上
   *
   * 只记「这一条关过」（`rememberSeen`），不碰 `skipped`：下一条该不该出现由它
   * 自己的触发条件决定 —— 条件不成立就自然没有，而不是硬塞一条出来指空气。
   *
   * 点遮罩、按 Esc、点「下一步」都走这**同一个**动作。遮罩选的是「知道了」那种
   * 含义，不是「跳过引导」：误点的最坏结果只是这一条少看了，用户页的
   * 「重新看引导」能把它调回来；若遮罩等于跳过，一次误点就把后面五条全关掉，
   * 那个不可逆。
   */
  const acknowledge = useCallback(() => {
    if (!mark) return
    setSeen(rememberSeen(mark.id))
    setAnchorRect(null)
  }, [mark])

  const skipRest = useCallback(() => {
    setSeen(skipAllCoaches())
    setAnchorRect(null)
  }, [])

  /** Esc 等同于「下一步」：气泡出来之后随手一按就能收掉，不必去找那颗按钮 */
  useEffect(() => {
    if (!visible) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      acknowledge()
    }
    window.addEventListener('keydown', onKeyDown)
    /** 窗口被拉伸时重算挡板尺寸，避免边上留一条没压暗的缝 */
    const onResize = (): void => {
      setViewport((current) => {
        const next = `${window.innerWidth}x${window.innerHeight}`
        return current === next ? current : next
      })
    }
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('resize', onResize)
    }
  }, [visible, acknowledge])

  if (!mark || !placement || !hole) return null
  /** ⚠️ 没有 `n/N`：清单卡头就在同一页写着 `doneCount/5`（见下方注释） */
  const panels = maskPanels(hole)

  return (
    <>
      {/**
       * 遮罩：四块挡板把锚点让出来
       *
       * 容器 `pointer-events-none`、挡板 `pointer-events-auto` —— 亮区里**没有**
       * 任何东西接事件，点击照旧落到被高亮的那个控件上。气泡自己 z-50，
       * 在遮罩之上。
       *
       * 为什么右下角不要 `n/N`（此前评审已经删过一次 `n/3`）：
       * 上手清单卡头写着 `doneCount/5`，而清单与列表在同一个视图里
       * （`WorkbenchView`：清单在上、`todo-row` 在下），气泡 3 指的就是列表里那一行 ——
       * 两个进度数同屏并存，人会以为有两套进度。所以这里只留动作，不留计数。
       */}
      <div
        data-testid="coach-mark-mask"
        data-viewport={viewport}
        aria-hidden="true"
        className="fixed inset-0 z-40 pointer-events-none"
      >
        {panels.map((panel, index) => (
          <div
            key={index}
            data-testid="coach-mark-mask-panel"
            onClick={acknowledge}
            className="absolute bg-black/40 pointer-events-auto"
            style={{ top: panel.top, left: panel.left, width: panel.width, height: panel.height }}
          />
        ))}
        {/**
         * 高亮框：亮区外边再描一道，让人一眼看出气泡指的是哪一块。
         * 只做视觉，不接事件（否则又挡住它框住的那个控件）。
         */}
        <div
          data-testid="coach-mark-hole"
          aria-hidden="true"
          className="absolute rounded-button border-2 border-accent pointer-events-none"
          style={{ top: hole.top, left: hole.left, width: hole.width, height: hole.height }}
        />
      </div>
      <div
        ref={bubbleRef}
        role="dialog"
        aria-label={mark.title}
        aria-describedby="coach-mark-body"
        data-testid="coach-mark"
        className="fixed z-50 w-72 rounded-card border border-border bg-bg-card shadow-card px-3 py-2.5"
        style={{ top: placement.top, left: placement.left }}
      >
        <div className="text-label font-semibold text-text-primary">{mark.title}</div>
        <p id="coach-mark-body" className="mt-0.5 text-caption leading-relaxed text-text-secondary">
          {mark.body}
        </p>
        <div className="mt-2 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={skipRest}
            data-testid="coach-mark-skip"
            className="text-caption text-text-secondary hover:text-text-primary cursor-pointer"
          >
            跳过引导
          </button>
          <Button variant="primary" size="sm" onClick={acknowledge} data-testid="coach-mark-next">
            下一步
          </Button>
        </div>
      </div>
    </>
  )
}
