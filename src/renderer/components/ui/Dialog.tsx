import React from 'react'
import { cn } from '../../lib/utils'

export interface DialogProps {
  open: boolean
  onClose: () => void
  children: React.ReactNode
  className?: string
}

export const Dialog: React.FC<DialogProps> = ({ open, onClose, children, className }) => {
  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* 遮罩 */}
      <div
        className="absolute inset-0 bg-black/20"
        onClick={onClose}
      />
      {/* 内容 */}
      <div
        className={cn(
          'relative z-10 frosted-glass rounded-quick-add p-5',
          'min-w-88 max-w-dialog',
          className
        )}
      >
        {children}
      </div>
    </div>
  )
}
