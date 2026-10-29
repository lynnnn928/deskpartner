import React, { useEffect, useState, useCallback, useRef } from 'react'
import { FloatBallCore } from './FloatBallCore'
import { DropdownMenu, DropdownMenuItem } from '../ui/DropdownMenu'
import { Icon } from '../ui/Icon'

interface EdgeHideProps {
  /** 左键单击：开/收快速面板（唯一入口） */
  onClick: () => void
  /** 双击：打开看板 */
  onDoubleClick: () => void
  /** 悬浮球当前的屏幕坐标，面板据此决定往左还是往右展开 */
  onAnchorChange?: (anchor: { x: number; y: number }) => void
  onShowKanban: () => void
  onShowSettings: () => void
  onQuit: () => void
  hasUnread?: boolean
  edgeHideEnabled?: boolean
}

export const EdgeHide: React.FC<EdgeHideProps> = ({
  onClick,
  onDoubleClick,
  onAnchorChange,
  onShowKanban,
  onShowSettings,
  onQuit,
  hasUnread = false,
  edgeHideEnabled = true
}) => {
  const [position, setPosition] = useState({ x: window.screen.width - 80, y: Math.floor(window.screen.height / 2) })
  const [isEdgeHidden, setIsEdgeHidden] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  /**
   * 悬浮球的屏幕坐标，作为面板展开的锚点
   *
   * 用 ref 不用 state：它只在打开面板的那一刻被读一次，
   * 放进 state 会让每次 mousemove 都触发重渲染。
   */
  const anchorRef = useRef({ x: window.screen.width - 80, y: Math.floor(window.screen.height / 2) })
  const dragOffset = useRef({ x: 0, y: 0 })
  /** 本次按下是否真的产生了位移；用于把「拖动」和「点击」区分开 */
  const didDragRef = useRef(false)
  /** 按下时的鼠标坐标，用来算位移（放 ref 里避免让 effect 依赖 position） */
  const dragStartRef = useRef({ x: 0, y: 0 })
  /**
   * 拖拽过程中的最新位置（1.0.38）
   *
   * 拖拽期间 DOM 已经被直接改过了，这里只是**暂存**，
   * 等 mouseup 时一次性交给 React —— 见 handleMouseMove 里的说明。
   */
  const pendingPos = useRef<{ x: number; y: number } | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  /** 位移超过该像素数才算拖动，避免手抖把单击吃掉 */
  const DRAG_THRESHOLD = 4

  // 位置变化时同步锚点：面板要贴着球展开，得知道球现在在哪
  useEffect(() => {
    anchorRef.current = position
    onAnchorChange?.(position)
  }, [position, onAnchorChange])

  /**
   * 菜单是否开着
   *
   * 用 ref 是因为要读它的地方是原生事件监听器（挂载时注册一次），
   * 读 state 会永远读到挂载那一刻的旧值。
   */
  const menuOpenRef = useRef(false)

  // 控制点击穿透：悬浮球区域拦截鼠标，其他区域穿透
  useEffect(() => {
    const ballEl = containerRef.current
    if (!ballEl) return

    const handleEnter = () => {
      window.api.invoke('window:setIgnoreMouseEvents', { ignore: false })
    }
    const handleLeave = () => {
      /**
       * 菜单开着时**不能**恢复穿透。
       *
       * 穿透之后点击会直接落到下面的窗口，我们连 mousedown 都收不到 ——
       * DropdownMenu 里那段"点外部关闭"就永远不触发，
       * 表现就是「右键打开菜单后，只能再右键一次才能关掉」。
       * 所以菜单开着期间让整个窗口保持接收鼠标事件。
       */
      if (menuOpenRef.current) return
      window.api.invoke('window:setIgnoreMouseEvents', { ignore: true })
    }

    ballEl.addEventListener('mouseenter', handleEnter)
    ballEl.addEventListener('mouseleave', handleLeave)
    return () => {
      ballEl.removeEventListener('mouseenter', handleEnter)
      ballEl.removeEventListener('mouseleave', handleLeave)
    }
  }, [])

  // 拖拽逻辑
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return
    setIsDragging(true)
    didDragRef.current = false
    dragStartRef.current = { x: e.clientX, y: e.clientY }
    dragOffset.current = {
      x: e.clientX - position.x,
      y: e.clientY - position.y
    }
    e.preventDefault()
  }, [position])

  useEffect(() => {
    if (!isDragging) return

    const handleMouseMove = (e: MouseEvent) => {
      const newX = e.clientX - dragOffset.current.x
      const newY = e.clientY - dragOffset.current.y

      // 超过阈值才登记为拖动。拖动结束浏览器仍会派发 click，
      // 若不拦截，每次挪动悬浮球都会顺带弹出"新增待办"。
      if (
        Math.abs(e.clientX - dragStartRef.current.x) > DRAG_THRESHOLD ||
        Math.abs(e.clientY - dragStartRef.current.y) > DRAG_THRESHOLD
      ) {
        didDragRef.current = true
      }

      /**
       * 拖拽期间**直接写 DOM**，不走 setState（1.0.38）。
       *
       * mousemove 每秒能触发几十次，每次 setState 都会重渲染整棵
       * 悬浮球组件树（FloatBallCore + DropdownMenu + Icon），
       * 拖动时肉眼可见掉帧、CPU 也高。
       *
       * 为什么这里可以放心绕开 React：拖拽期间 `isDragging` 为 true，
       * 贴边检测那个 effect 会直接 return，`position` 此刻**只影响样式**，
       * 不影响任何逻辑判断（锚点 ref 也是在 mouseup 后才有意义）。
       * 落 state 的时机挪到 mouseup —— 一次拖拽只重渲染一次。
       */
      const el = containerRef.current
      if (el) {
        el.style.left = `${newX}px`
        el.style.top = `${newY}px`
      }
      pendingPos.current = { x: newX, y: newY }
    }

    const handleMouseUp = () => {
      setIsDragging(false)
      // 松手时才把最终位置交回 React，让锚点、贴边检测照常跑
      if (pendingPos.current) {
        setPosition(pendingPos.current)
        pendingPos.current = null
      }
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isDragging])

  /** 包一层：拖动过就吞掉这次点击，不再透传给悬浮球 */
  const swallowDrag = useCallback((fn: () => void) => {
    return () => {
      if (didDragRef.current) {
        didDragRef.current = false
        return
      }
      fn()
    }
  }, [])

  // 贴边检测
  useEffect(() => {
    if (!edgeHideEnabled || isDragging) return
    const screenW = window.screen.width
    const threshold = 10
    const nearLeft = position.x <= threshold
    const nearRight = position.x >= screenW - threshold - 48

    if (nearLeft || nearRight) {
      setIsEdgeHidden(true)
    } else {
      setIsEdgeHidden(false)
    }
  }, [position, edgeHideEnabled, isDragging])

  // 右键菜单：吃掉浏览器原生菜单，交给自定义菜单接管
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
  }, [])

  /** 菜单开合 → 切换鼠标穿透（开着时必须能收到"点别处"的那次点击） */
  const handleMenuOpenChange = useCallback((open: boolean) => {
    menuOpenRef.current = open

    if (open) {
      window.api.invoke('window:setIgnoreMouseEvents', { ignore: false })
      return
    }
    // 关闭时按鼠标实际位置恢复：还停在球上就继续接收，否则还原穿透
    const inside = containerRef.current?.matches(':hover') ?? false
    window.api.invoke('window:setIgnoreMouseEvents', { ignore: !inside })
  }, [])

  return (
    <div
      ref={containerRef}
      className="fixed z-[9999]"
      style={{
        left: isEdgeHidden
          ? position.x < window.screen.width / 2
            ? -36
            : window.screen.width - 8
          : position.x,
        top: position.y,
        transition: isDragging ? 'none' : 'left 0.3s ease'
      }}
      onMouseDown={handleMouseDown}
      onMouseEnter={() => isEdgeHidden && setIsEdgeHidden(false)}
      onMouseLeave={() => {
        if (edgeHideEnabled) {
          const screenW = window.screen.width
          if (position.x <= 10 || position.x >= screenW - 58) {
            setIsEdgeHidden(true)
          }
        }
      }}
    >
      {/*
        菜单只在**右键**出现。

        刻意不再放「快速面板」和「新增待办」：
        - 快速面板 = 左键单击，同一个手势没必要给两条路
        - 新增待办 = 面板里的输入框（而且面板本身就一键可达）
        菜单只留"左键到不了"的：打开看板 / 设置 / 退出。
        一个目的地一个入口，避免"三个入口都能加待办，不知道该点哪个"。
      */}
      <DropdownMenu
        triggerOn="contextmenu"
        onOpenChange={handleMenuOpenChange}
        trigger={
          <div onContextMenu={handleContextMenu}>
            <FloatBallCore
              onClick={swallowDrag(onClick)}
              onDoubleClick={swallowDrag(onDoubleClick)}
              onContextMenu={handleContextMenu}
              hasUnread={hasUnread}
            />
          </div>
        }
      >
        <DropdownMenuItem onClick={onShowKanban}>
          <span className="inline-flex items-center gap-2"><Icon name="layoutBoard" size={14} /> 打开看板</span>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onShowSettings}>
          <span className="inline-flex items-center gap-2"><Icon name="settings" size={14} /> 设置</span>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onQuit} danger>
          <span className="inline-flex items-center gap-2"><Icon name="logOut" size={14} /> 退出</span>
        </DropdownMenuItem>
      </DropdownMenu>
    </div>
  )
}
