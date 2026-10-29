import React, { useState, useRef, useCallback, useEffect } from 'react'
import { cn } from '../../lib/utils'
import { GlowEffect } from './GlowEffect'
import { UnreadBadge } from '../notification/UnreadBadge'
import { useSettingsStore } from '../../stores/settings.store'
import logoWhite from '../../assets/logo-white.svg'

interface FloatBallCoreProps {
  onClick: () => void
  onDoubleClick: () => void
  onContextMenu: (e: React.MouseEvent) => void
  hasUnread?: boolean
}

export const FloatBallCore: React.FC<FloatBallCoreProps> = ({
  onClick,
  onDoubleClick,
  onContextMenu,
  hasUnread = false
}) => {
  const { settings } = useSettingsStore()
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [isHovered, setIsHovered] = useState(false)

  // 单击/双击区分
  const handleClick = useCallback(() => {
    if (clickTimer.current) {
      clearTimeout(clickTimer.current)
      clickTimer.current = null
      onDoubleClick()
    } else {
      clickTimer.current = setTimeout(() => {
        clickTimer.current = null
        onClick()
      }, 250)
    }
  }, [onClick, onDoubleClick])

  /**
   * 卸载时清掉待触发的单击定时器（1.0.40）。
   *
   * 不清的话，那 250ms 内组件被卸载（窗口关闭/热重载）后定时器照样触发，
   * 回调里再调 onClick —— 对一个已经不在的悬浮球做事。轻微泄漏，
   * 但在开发期频繁热重载时会累积成一批悬挂回调。
   */
  useEffect(() => {
    return () => {
      if (clickTimer.current) {
        clearTimeout(clickTimer.current)
        clickTimer.current = null
      }
    }
  }, [])

  const size = settings.floatBallSize
  const opacity = settings.floatBallOpacity

  return (
    <div
      className={cn(
        'relative rounded-full flex items-center justify-center cursor-pointer',
        'frosted-glass shadow-float',
        'transition-all duration-200',
        isHovered && 'scale-110 shadow-card-hover'
      )}
      style={{
        width: size,
        height: size,
        // 严格使用用户设定值（默认 1 = 完全不透明），悬停反馈交给缩放与阴影
        opacity,
        // 球体主色由设置项驱动
        // null = 跟随全局强调色（2026-09-25）
        backgroundColor: settings.floatBallColor ?? 'var(--color-accent)'
      }}
      onClick={handleClick}
      onContextMenu={onContextMenu}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {/* 光晕 */}
      {hasUnread && settings.floatBallShowGlow && <GlowEffect />}

      {/* 中央图标：品牌 D 笑脸（白色版，衬在品牌蓝球体上） */}
      {settings.floatBallShowIcon && (
        <img
          src={settings.appIcon || logoWhite}
          alt=""
          draggable={false}
          style={{ width: size * 0.82, height: size * 0.82 }}
          className={cn(
            'pointer-events-none select-none',
            settings.appIcon && 'rounded-full object-contain bg-white'
          )}
        />
      )}

      {/* 未读红点 */}
      {hasUnread && <UnreadBadge />}
    </div>
  )
}
