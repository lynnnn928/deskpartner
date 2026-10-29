import React, { useEffect, useState } from 'react'
import { cn } from '../../lib/utils'
import { invoke, on } from '../../lib/ipc-client'
import { useUIStore } from '../../stores/ui.store'

type WindowAction = 'minimize' | 'toggleMaximize' | 'close'

interface WindowControlsProps {
  /** 是否显示最大化/还原按钮（不可缩放的窗口可关闭） */
  showMaximize?: boolean
  className?: string
}

/** 10x10 线性图标，跟随文字颜色 */
const ICONS: Record<'minimize' | 'maximize' | 'restore' | 'close', React.ReactNode> = {
  minimize: (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <line x1="0.5" y1="5" x2="9.5" y2="5" stroke="currentColor" strokeWidth="1" />
    </svg>
  ),
  maximize: (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1" />
    </svg>
  ),
  restore: (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <rect x="0.5" y="2.5" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1" />
      <path d="M2.5 2.5V0.5h7v7h-2" fill="none" stroke="currentColor" strokeWidth="1" />
    </svg>
  ),
  close: (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <line x1="0.5" y1="0.5" x2="9.5" y2="9.5" stroke="currentColor" strokeWidth="1" />
      <line x1="9.5" y1="0.5" x2="0.5" y2="9.5" stroke="currentColor" strokeWidth="1" />
    </svg>
  )
}

/**
 * 无边框窗口的自定义窗口控制按钮
 * 参照 Windows 11 观感：常规按钮悬停变浅底，关闭按钮悬停变红
 *
 * 最大化图标以**窗口自己的状态**为准（1.0.48）：
 * 此前靠组件内一个 useState 翻面，而双击标题栏、Win+↑ 这些路径不经过按钮，
 * 于是窗口已经最大化了、按钮还显示"最大化"，按一下反而是还原。
 * 现在挂载时问一次，之后听主进程广播。
 */
export const WindowControls: React.FC<WindowControlsProps> = ({
  showMaximize = true,
  className
}) => {
  const [maximized, setMaximized] = useState(false)
  const showToast = useUIStore((s) => s.showToast)

  useEffect(() => {
    const off = on('event:windowState', (data) => setMaximized(!!data?.maximized))
    void invoke('window:state')
      .then((res) => setMaximized(!!res?.maximized))
      .catch(() => {
        /* 查不到就保持默认态：图标错一次比整个标题栏挂掉好 */
      })
    return off
  }, [])

  const act = async (action: WindowAction) => {
    try {
      const res = await invoke('window:control', { action })
      if (res && typeof res.maximized === 'boolean') setMaximized(res.maximized)
    } catch (err) {
      // 窗口没关掉却什么都不说，人只会以为自己没点上
      showToast(err instanceof Error ? `窗口操作失败：${err.message}` : '窗口操作失败')
    }
  }

  const baseBtn = cn(
    'h-7 w-8 flex items-center justify-center rounded-button',
    'text-text-secondary transition-colors'
  )

  return (
    <div className={cn('titlebar-no-drag flex items-center gap-0.5', className)}>
      <button
        onClick={() => act('minimize')}
        className={cn(baseBtn, 'hover:bg-border/60 hover:text-text-primary')}
        title="最小化"
        aria-label="最小化"
      >
        {ICONS.minimize}
      </button>

      {showMaximize && (
        <button
          onClick={() => act('toggleMaximize')}
          className={cn(baseBtn, 'hover:bg-border/60 hover:text-text-primary')}
          title={maximized ? '向下还原' : '最大化'}
          aria-label={maximized ? '向下还原' : '最大化'}
        >
          {maximized ? ICONS.restore : ICONS.maximize}
        </button>
      )}

      <button
        onClick={() => act('close')}
        className={cn(baseBtn, 'hover:bg-red-500 hover:text-white')}
        title="关闭"
        aria-label="关闭"
      >
        {ICONS.close}
      </button>
    </div>
  )
}
