import React from 'react'
import { Icon } from '../ui/Icon'

interface VersionPickerProps {
  value: string | null
  onChange: (value: string | null) => void
  currentVersion?: string
}

export const VersionPicker: React.FC<VersionPickerProps> = ({
  value,
  onChange,
  currentVersion
}) => (
  <div className="flex items-center gap-2.5 min-h-7">
    <span className="w-20 shrink-0 text-label text-text-secondary inline-flex items-center gap-1.5">
      <Icon name="checkCircle" size={12} />
      <span>解决版本</span>
    </span>
    <div className="flex items-center gap-1.5 flex-wrap">
      <input
        type="text"
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value.trim() ? e.target.value : null)}
        placeholder="如 1.0.120（留空未标）"
        title="这条事项是在哪个版本收口的。留空表示尚未标注"
        className="h-7 px-2.5 rounded-button border border-border bg-bg-card text-label
          text-text-primary w-44 outline-none focus:border-accent transition-colors
          placeholder:text-text-secondary/60"
      />
      {currentVersion && value !== currentVersion && (
        <button
          type="button"
          onClick={() => onChange(currentVersion)}
          title={`标成当前版本 ${currentVersion}`}
          className="h-7 px-2.5 rounded-button text-caption border border-border bg-bg-card
            text-text-secondary hover:text-text-primary hover:border-accent transition-colors"
        >
          标为 {currentVersion}
        </button>
      )}
      {value && (
        <button
          type="button"
          onClick={() => onChange(null)}
          className="px-1.5 text-caption text-text-secondary hover:text-danger transition-colors"
        >
          清空
        </button>
      )}
    </div>
  </div>
)
