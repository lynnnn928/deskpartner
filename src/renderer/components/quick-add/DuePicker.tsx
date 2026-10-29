import React, { useState, useEffect } from 'react'
import { Icon } from '../ui/Icon'
import dayjs from 'dayjs'

interface DuePickerProps {
  value: string | null
  onChange: (value: string | null) => void
}

export const DuePicker: React.FC<DuePickerProps> = ({ value, onChange }) => {
  const [date, setDate] = useState(value ? dayjs(value).format('YYYY-MM-DD') : '')
  const [time, setTime] = useState(value ? dayjs(value).format('HH:mm') : '')

  useEffect(() => {
    setDate(value ? dayjs(value).format('YYYY-MM-DD') : '')
    setTime(value ? dayjs(value).format('HH:mm') : '')
  }, [value])

  const build = (d: string, t: string) => {
    if (d) {
      const dt = dayjs(`${d} ${t || '18:00'}`)
      if (dt.isValid()) {
        onChange(dt.toISOString())
        return
      }
    }
    onChange(null)
  }

  const handleClear = () => {
    setDate('')
    setTime('')
    onChange(null)
  }

  return (
    <div className="flex items-center gap-2.5 min-h-7">
      <span className="w-20 shrink-0 text-label text-text-secondary inline-flex items-center gap-1.5">
        <Icon name="clock" size={12} />
        <span>截止时间</span>
      </span>
      <div className="flex items-center gap-1.5 flex-wrap">
        <input
          type="date"
          value={date}
          onChange={(e) => {
            setDate(e.target.value)
            build(e.target.value, time)
          }}
          className="h-7 px-2 rounded-button border border-border text-label bg-bg-card
            focus:border-accent outline-none transition-colors"
        />
        <input
          type="time"
          value={time}
          onChange={(e) => {
            setTime(e.target.value)
            build(date, e.target.value)
          }}
          className="h-7 px-2 rounded-button border border-border text-label bg-bg-card
            focus:border-accent outline-none transition-colors"
        />
        {value && (
          <button
            type="button"
            onClick={handleClear}
            className="text-caption text-text-secondary hover:text-danger transition-colors px-1"
          >
            清除
          </button>
        )}
      </div>
    </div>
  )
}
