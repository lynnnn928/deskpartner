import React, { useEffect, useState } from 'react'
import { cn } from '../../lib/utils'
import { buildAccelerator, formatAccelerator, isModifierKey } from '../../lib/shortcut'

interface ShortcutInputProps {
  value: string | null
  onChange: (accelerator: string | null) => void
}

/**
 * 全局快捷键录制控件
 * 点击进入录制态，捕获下一个含修饰键的组合并转成 Electron accelerator
 */
export const ShortcutInput: React.FC<ShortcutInputProps> = ({ value, onChange }) => {
  const [recording, setRecording] = useState(false)
  const [needModifier, setNeedModifier] = useState(false)

  useEffect(() => {
    if (!recording) return

    const handleKeyDown = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()

      // Esc 退出录制
      if (e.key === 'Escape') {
        setRecording(false)
        setNeedModifier(false)
        return
      }

      // 只按下修饰键时继续等待主键
      if (isModifierKey(e)) return

      const accelerator = buildAccelerator(e)
      if (!accelerator) {
        setNeedModifier(true)
        return
      }

      onChange(accelerator)
      setRecording(false)
      setNeedModifier(false)
    }

    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [recording, onChange])

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={() => {
          setRecording((prev) => !prev)
          setNeedModifier(false)
        }}
        className={cn(
          'min-w-36 px-3 py-1.5 rounded-button text-button border transition-colors',
          recording
            ? 'border-accent text-accent animate-pulse'
            : 'border-border text-text-primary hover:border-accent/60'
        )}
      >
        {recording ? '按下组合键…' : value ? formatAccelerator(value) : '未设置'}
      </button>

      {recording ? (
        <span className="text-label text-text-secondary">Esc 取消</span>
      ) : value ? (
        <button
          onClick={() => onChange(null)}
          className="text-label text-text-secondary hover:text-accent transition-colors"
        >
          清除
        </button>
      ) : null}

      {needModifier && <span className="text-label text-red-400">需含 Ctrl / Alt / Shift</span>}
    </div>
  )
}
