import React from 'react'
import { cn } from '../../lib/utils'

export interface SliderProps {
  value: number
  min: number
  max: number
  step?: number
  onChange: (value: number) => void
  className?: string
  label?: string
  showValue?: boolean
}

export const Slider: React.FC<SliderProps> = ({
  value,
  min,
  max,
  step = 1,
  onChange,
  className,
  label,
  showValue = true
}) => {
  const percent = ((value - min) / (max - min)) * 100

  return (
    <div className={cn('flex items-center gap-3 w-52', className)}>
      {label && <span className="text-label text-text-secondary shrink-0">{label}</span>}
      <div className="relative flex-1 h-6 flex items-center">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="w-full h-1.5 appearance-none bg-border rounded-full outline-none cursor-pointer
            [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4
            [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-accent [&::-webkit-slider-thumb]:shadow-sm
            [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:transition-transform
            [&::-webkit-slider-thumb]:hover:scale-110"
          style={{
            background: `linear-gradient(to right, var(--color-accent) 0%, var(--color-accent) ${percent}%, var(--color-border) ${percent}%, var(--color-border) 100%)`
          }}
        />
      </div>
      {showValue && <span className="text-label text-text-secondary w-10 text-right">{value}</span>}
    </div>
  )
}
