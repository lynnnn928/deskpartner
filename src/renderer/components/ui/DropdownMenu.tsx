import React, { useState, useRef, useEffect } from 'react'
import { cn } from '../../lib/utils'

export interface DropdownMenuProps {
  trigger: React.ReactNode
  children: React.ReactNode
  className?: string
  /**
   * 外层容器的类名（1.0.48）
   *
   * 侧边栏的项目行要撑满整行，而容器原本写死 inline-block ——
   * 菜单定位需要它做 relative，**宽度则必须由调用方说了算**。
   */
  containerClassName?: string
  align?: 'left' | 'right'
  /**
   * 用什么手势打开。
   *
   * 默认左键点击；悬浮球必须用 'contextmenu' ——
   * 它的左键已经被"打开快速面板"占用了。此前两者都挂在左键上，
   * 结果点一次球同时弹出菜单和面板（两个浮层叠在一起）。
   */
  triggerOn?: 'click' | 'contextmenu'
  /**
   * 打开状态变化时通知外部
   *
   * 悬浮球用它切换鼠标穿透：菜单开着时必须让窗口接收鼠标事件，
   * 否则"点别处关闭"根本收不到事件（见 EdgeHide 里的说明）。
   */
  onOpenChange?: (open: boolean) => void
}

export const DropdownMenu: React.FC<DropdownMenuProps> = ({
  trigger,
  children,
  className,
  containerClassName,
  align = 'right',
  triggerOn = 'click',
  onOpenChange
}) => {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // 放进 ref：外部每次渲染都可能传新函数，直接进依赖会反复触发
  const onOpenChangeRef = useRef(onOpenChange)
  onOpenChangeRef.current = onOpenChange
  useEffect(() => {
    onOpenChangeRef.current?.(open)
  }, [open])

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    if (open) document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const toggle = (e: React.MouseEvent) => {
    // 右键要吃掉浏览器默认菜单，否则原生菜单会盖在我们这层上面
    if (triggerOn === 'contextmenu') e.preventDefault()
    setOpen((v) => !v)
  }

  return (
    <div ref={ref} className={cn('relative inline-block', containerClassName)}>
      <div
        onClick={triggerOn === 'click' ? toggle : undefined}
        onContextMenu={triggerOn === 'contextmenu' ? toggle : undefined}
      >
        {trigger}
      </div>
      {open && (
        <div
          className={cn(
            'absolute z-50 mt-1 min-w-40 frosted-glass rounded-card py-1 shadow-float',
            '',
            align === 'right' ? 'right-0' : 'left-0',
            className
          )}
        >
          {React.Children.map(children, (child) => {
            if (React.isValidElement<DropdownMenuItemProps>(child)) {
              return React.cloneElement(child, {
                onClick: (e: React.MouseEvent<HTMLDivElement>) => {
                  child.props.onClick?.(e)
                  setOpen(false)
                }
              })
            }
            return child
          })}
        </div>
      )}
    </div>
  )
}

export interface DropdownMenuItemProps extends React.HTMLAttributes<HTMLDivElement> {
  danger?: boolean
}

export const DropdownMenuItem: React.FC<DropdownMenuItemProps> = ({
  className,
  danger,
  children,
  ...props
}) => {
  return (
    <div
      className={cn(
        'flex items-center gap-2 px-3 py-2 text-content cursor-pointer transition-colors',
        'hover:bg-accent/10',
        danger && 'text-red-500 hover:bg-red-50',
        className
      )}
      {...props}
    >
      {children}
    </div>
  )
}
