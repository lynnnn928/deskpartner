import React, { useEffect, useState } from 'react'
import { cn } from '../../lib/utils'

interface ColorFieldProps {
  label: string
  /** 当前生效色值（未自定义时为默认值） */
  value: string
  /** 是否被用户自定义过 */
  isCustom: boolean
  onChange: (color: string) => void
  onReset: () => void
}

const HEX_RE = /^#[0-9a-fA-F]{6}$/

/**
 * 颜色设置项：紧凑子卡片形态（色块 + 标签 + Hex 输入 + 重置）
 */
export const ColorField: React.FC<ColorFieldProps> = ({
  label,
  value,
  isCustom,
  onChange,
  onReset
}) => {
  const [draft, setDraft] = useState(value)
  const [invalid, setInvalid] = useState(false)

  // 外部色值变化（如一键还原）时同步输入框
  useEffect(() => {
    setDraft(value)
    setInvalid(false)
  }, [value])

  const commit = (raw: string) => {
    const next = raw.trim()
    if (HEX_RE.test(next)) {
      setInvalid(false)
      onChange(next.toUpperCase())
      setDraft(next.toUpperCase())
    } else {
      setInvalid(true)
    }
  }

  return (
    <div className="flex items-center justify-between gap-2.5 rounded-button border border-border/70 bg-surface-subtle px-3 py-2">
      <div className="flex items-center gap-2 min-w-0">
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value.toUpperCase())}
          className="w-6 h-6 rounded-xs border border-border cursor-pointer bg-transparent p-0 shrink-0"
          title="点击取色"
          aria-label={`${label}取色器`}
        />
        <span className="text-label font-medium text-text-primary truncate">{label}</span>
        {isCustom && (
          <span className="w-1.5 h-1.5 rounded-full bg-accent shrink-0" title="已自定义" />
        )}
      </div>

      <div className="flex items-center gap-1.5 shrink-0">
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => commit(draft)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit(draft)
          }}
          spellCheck={false}
          maxLength={7}
          aria-label={`${label}色值`}
          className={cn(
            'w-20 h-7 px-2 rounded-xs border bg-bg-card',
            'text-caption text-text-primary font-mono uppercase outline-none transition-colors',
            invalid ? 'border-danger' : 'border-border focus:border-accent'
          )}
        />

        <button
          type="button"
          onClick={onReset}
          disabled={!isCustom}
          className={cn(
            'text-caption px-1.5 py-0.5 rounded-xs transition-colors shrink-0',
            isCustom
              ? 'text-text-secondary hover:text-accent hover:bg-bg-card cursor-pointer'
              : 'text-text-secondary/30 cursor-not-allowed'
          )}
          title={isCustom ? '恢复默认色' : '当前已是默认色'}
        >
          重置
        </button>
      </div>
    </div>
  )
}
