import React, { useLayoutEffect, useRef, useState } from 'react'
import { QuickAddForm } from '../components/quick-add/QuickAddForm'
import { useQuickAddRoute } from '../components/quick-add/useQuickAddRoute'
import { invoke } from '../lib/ipc-client'

/** 拖动范围：低于下限时表单会挤成一团，高于上限则抽屉比看板还宽 */
const MIN_WIDTH = 360
const MAX_WIDTH = 1000

/** 新增/编辑待办弹窗窗口入口 */
const QuickAdd: React.FC = () => {
  // QuickAdd 是独立 BrowserWindow，无需通过 UI store 控制显隐
  // 直接渲染表单，窗口关闭由主进程管理（失焦自动关闭）
  //
  // 这里刻意不加压暗遮罩（如 bg-black/20）：遮罩是为"窗口内部再弹一层"设计的，
  // 目的是压暗它背后那张页面；而本窗口自身就是透明的，背后是桌面而非内容，
  // 加了只会变成悬浮在桌面上的一块黑色方块。

  const contentRef = useRef<HTMLDivElement>(null)
  const { todoId } = useQuickAddRoute()
  // 有 todoId 是看详情/编辑，没有是新增 —— 两种形态不一样，见下面说明
  const isDrawer = !!todoId

  const [width, setWidth] = useState(480)

  /**
   * 抽屉宽度每变一次就同步给主进程（它才知道窗口该多大）
   *
   * 不用 useEffect 依赖 width 自动发：那样每拖一像素就走一次 IPC，
   * 一次拖动上百次往返。这里只在真正提交边界时量一次。
   */
  const syncWidth = (w: number) => {
    void invoke('window:resizeQuickAdd', { height: window.innerHeight, width: w })
  }

  /**
   * 拖动把手：抽屉宽度
   *
   * 为什么值得做：详情页承载的东西在变多（子任务清单、流转历史），
   * 而"该给它多宽"只有用的人知道 —— 有人只改个标题，有人要对着长描述改。
   * 宽度写死等于替所有人做这个决定。
   *
   * 向左拖 = 变宽（抽屉从右边往左长），方向与窗口边缘的移动方向一致。
   */
  const startDrag = (e: React.PointerEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = width
    let next = startW
    let frame = 0

    const onMove = (ev: PointerEvent) => {
      next = Math.min(Math.max(startW + (startX - ev.clientX), MIN_WIDTH), MAX_WIDTH)
      setWidth(next)
      // 每帧最多同步一次窗口边界，避免一个像素一次 IPC
      if (!frame) {
        frame = requestAnimationFrame(() => {
          frame = 0
          syncWidth(next)
        })
      }
    }
    const onUp = () => {
      if (frame) cancelAnimationFrame(frame)
      syncWidth(next)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  /**
   * 把内容真实高度回报给主进程，由它调整窗口大小
   *
   * 窗口高度**不能写死** ——新增模式下：
   * - 高度不够 → 容器是垂直居中，超出部分上下同时被裁
   *   （打开已有任务详情时必现：描述/优先级/截止/标签全部展开，内容约 550px+）
   * - 高度过大 → 透明窗口的空白区照样吃鼠标事件，把底下的看板挡住
   *
   * 所以让"知道内容多高"的一侧来量：展开/折叠、标签换行、错误提示出现，
   * 都会改变真实高度，用 ResizeObserver 持续跟随。
   *
   * 抽屉模式下不需要：它的高度恒等于屏幕可用高度，内容自己滚动。
   * 这里跟着报反而会和抽屉的边界互相打架。
   *
   * 用 offsetHeight 而不是 getBoundingClientRect()：后者含 transform，
   * 入场动画期间会量出缩放中的中间值。
   */
  useLayoutEffect(() => {
    if (isDrawer) return
    const el = contentRef.current
    if (!el) return

    const report = () => {
      const h = el.offsetHeight
      if (h > 0) void invoke('window:resizeQuickAdd', { height: h })
    }

    report()
    const ro = new ResizeObserver(report)
    ro.observe(el)
    return () => ro.disconnect()
  }, [isDrawer])

  /**
   * 抽屉形态
   *
   * 新增仍是居中小卡片（速记要的是最小打扰）；
   * 详情/编辑改成贴右的全高抽屉 —— 看一条详情时人常常要对照着看板判断
   * "这条该归到哪"，居中弹窗一开就把那个上下文整块盖住了。
   *
   * 抽屉内部自己滚动（min-h-0 + overflow-y-auto），而不是让整个窗口变高：
   * 内容多的时候要么撑破屏幕、要么上下同时被裁，两种都是坏的。
   */
  if (isDrawer) {
    return (
      <div className="w-screen h-screen flex justify-end overflow-hidden">
        {/*
          不透明底色（bg-bg-primary），不是 frosted-glass —— 两个原因：

          1. 30 版实测 bug：这里写的类名是 frost-glass（少个 ed），样式根本不存在，
             抽屉等于完全透明，看板卡片整个透出来，字都读不清。
          2. 就算写对成 frosted-glass 也不该用：本窗口是独立的透明 BrowserWindow，
             叠在看板窗口上面，CSS 的 backdrop-filter 只能模糊本页面内的内容，
             隔着窗口模糊不到看板 —— 玻璃只剩一层半透明白，底下的看板照样透出来。
             详情抽屉是拿来"读"的，不该有任何透明度（用户 2026-09-20 明确口径）。

          window-frame 提供边框；底色走 --color-bg-primary，跟随主题换色。
        */}
        <div
          className="h-full flex flex-col min-h-0 overflow-hidden rounded-l-card border-l border-y border-border shadow-float bg-bg-primary relative"
          style={{ width }}
        >
          {/*
            拖动把手：贴着抽屉左缘的一条竖带。
            做成 6px 宽的可见条而不是 1px —— 看不见的东西没人会去拖。
          */}
          <div
            onPointerDown={startDrag}
            role="separator"
            aria-orientation="vertical"
            aria-label="拖动调整宽度"
            title="拖动调整宽度（双击重置为 480px）"
            onDoubleClick={() => {
              setWidth(480)
              syncWidth(480)
            }}
            className="absolute left-0 top-0 bottom-0 w-1.5 cursor-col-resize z-10
              bg-transparent hover:bg-accent/20 transition-colors"
          />
          <div ref={contentRef} className="flex-1 min-h-0 overflow-y-auto">
            <QuickAddForm />
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="w-screen h-screen flex items-center justify-center overflow-hidden">
      {/*
        max-h-screen + 滚动兜底：极矮的屏幕下主进程会把窗口夹到可用高度，
        此时内容不能继续溢出，改为自己滚 —— 否则底部按钮永远点不到。
      */}
      <div ref={contentRef} className="max-h-screen overflow-y-auto">
        <QuickAddForm />
      </div>
    </div>
  )
}

export default QuickAdd
