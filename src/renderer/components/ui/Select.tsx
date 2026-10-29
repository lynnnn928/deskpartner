import React, { useState, useRef, useEffect } from 'react'
import { Icon } from './Icon'
import { cn } from '../../lib/utils'

export interface SelectOption {
  value: string
  label: string
  color?: string
}

export interface SelectProps {
  value: string
  options: SelectOption[]
  onChange: (value: string) => void
  placeholder?: string
  className?: string
  ariaLabel?: string
}

export const Select: React.FC<SelectProps> = ({
  value,
  options,
  onChange,
  placeholder = '请选择',
  className,
  ariaLabel
}) => {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const selected = options.find((o) => o.value === value)

  useEffect(() => {
    if (!open) return
    const handleMouseDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', handleMouseDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handleMouseDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  return (
    <div ref={ref} className={cn('relative inline-block', className)}>
      <button
        type="button"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={() => setOpen(!open)}
        className={cn(
          'flex items-center justify-between gap-2 h-8 min-w-28 px-3 rounded-button border border-border bg-bg-card text-label transition-colors cursor-pointer',
          'hover:border-text-secondary/40 focus:outline-none',
          open && 'border-accent/60',
          selected ? 'text-text-primary font-medium' : 'text-text-secondary'
        )}
      >
        <span className="flex items-center gap-2 min-w-0 truncate">
          {selected?.color && (
            <span
              className="w-2 h-2 rounded-full shrink-0"
              style={{ backgroundColor: selected.color }}
            />
          )}
          <span className="truncate">{selected?.label ?? placeholder}</span>
        </span>
        <Icon
          name="chevronLeft"
          size={11}
          className={cn(
            'text-text-secondary/70 transition-transform shrink-0',
            open ? 'rotate-90 text-accent' : '-rotate-90'
          )}
        />
      </button>

      {open && (
        <div
          role="listbox"
          className="absolute right-0 z-50 mt-1.5 min-w-36 max-h-60 overflow-y-auto rounded-card border border-border bg-bg-card p-1 shadow-float"
        >
          {options.map((opt) => {
            const isSelected = opt.value === value
            return (
              <button
                key={opt.value}
                type="button"
                role="option"
                aria-selected={isSelected}
                onClick={() => {
                  onChange(opt.value)
                  setOpen(false)
                }}
                className={cn(
                  'w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-button text-label text-left cursor-pointer transition-colors whitespace-nowrap',
                  isSelected
                    ? 'bg-accent/10 text-accent font-semibold'
                    : 'text-text-primary hover:bg-surface-subtle font-normal'
                )}
              >
                <span className="flex items-center gap-2 truncate">
                  {opt.color && (
                    <span
                      className="w-2 h-2 rounded-full shrink-0"
                      style={{ backgroundColor: opt.color }}
                    />
                  )}
                  <span className="truncate">{opt.label}</span>
                </span>
                {isSelected && <span className="w-1.5 h-1.5 rounded-full bg-accent shrink-0" />}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
