import React, { useCallback, useEffect, useState } from 'react'
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
/** 气泡宽度（与 class 里的 `w-72` 一致：令牌闸门不允许在 class 串里写任意像素值） */
const BUBBLE_WIDTH = 288
const GAP = 10
const MARGIN = 12
/** 气泡大致高度，用来判断朝下还是朝上放 */
const BUBBLE_HEIGHT = 150

interface Placement {
  top: number
  left: number
}

/**
 * 气泡摆在哪儿：优先摆到锚点右侧，右边真没地方才摆到下面或上面
 *
 * 为什么不学常见做法"居中盖在锚点下方"：三处锚点里有两处贴着窗口左缘
 * （侧栏导航项、列表行），居中的结果是气泡左半截出窗、被边距夹回来之后
 * 飘在内容区中间 —— 指着谁看不出来。贴着右缘放，永远挨着它指的东西。
 */
function placeBeside(rect: DOMRect): Placement {
  const viewportW = window.innerWidth
  const viewportH = window.innerHeight
  const maxTop = Math.max(MARGIN, viewportH - BUBBLE_HEIGHT - MARGIN)

  if (rect.right + GAP + BUBBLE_WIDTH + MARGIN <= viewportW) {
    return { top: Math.min(Math.max(rect.top - 6, MARGIN), maxTop), left: rect.right + GAP }
  }

  const centered = rect.left + rect.width / 2 - BUBBLE_WIDTH / 2
  return {
    top:
      rect.bottom + BUBBLE_HEIGHT + GAP < viewportH
        ? rect.bottom + GAP
        : Math.max(MARGIN, rect.top - BUBBLE_HEIGHT - GAP),
    left: Math.min(Math.max(centered, MARGIN), Math.max(MARGIN, viewportW - BUBBLE_WIDTH - MARGIN))
  }
}

export const CoachMarkHost: React.FC = () => {
  const agents = useAgentStore((s) => s.agents)
  const todos = useTodoStore((s) => s.todos)
  const selectedTodoId = useUIStore((s) => s.selectedTodoId)
  const [seen, setSeen] = useState<CoachSeen>(() => readSeen())
  const [placement, setPlacement] = useState<Placement | null>(null)

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
    setPlacement(null)
    if (!mark) return
    let alive = true

    const measure = (): boolean => {
      const anchor = document.querySelector(mark.anchor)
      if (!anchor) return false
      const rect = anchor.getBoundingClientRect()
      // 侧栏收起/展开切换时会有一帧 0 尺寸：量到 0 说明还没排好，等下一次
      if (rect.width === 0 && rect.height === 0) return false
      if (!alive) return true
      setPlacement(placeBeside(rect))
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

    const onLayoutChange = (): void => {
      measure()
    }
    window.addEventListener('resize', onLayoutChange)
    return () => {
      alive = false
      window.removeEventListener('resize', onLayoutChange)
    }
  }, [mark])

  const dismiss = useCallback(() => {
    if (!mark) return
    setSeen(rememberSeen(mark.id))
    setPlacement(null)
  }, [mark])

  const skipRest = useCallback(() => {
    setSeen(skipAllCoaches())
    setPlacement(null)
  }, [])

  if (!mark || !placement) return null

  return (
    <div
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
