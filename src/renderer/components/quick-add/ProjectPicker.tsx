import React, { useState } from 'react'
import { useProjectStore } from '../../stores/project.store'
import { Icon } from '../ui/Icon'
import { cn } from '../../lib/utils'

interface ProjectPickerProps {
  /** 当前项目 id；1.0.37 起项目必填，不再接受 null */
  value: string | null
  onChange: (value: string) => void
  /** 校验失败时高亮，提示"这条还没选项目" */
  invalid?: boolean
}

/** 就地新增时循环取用的颜色 */
const NEW_PROJECT_COLORS = ['#5388F6', '#65C19C', '#F5A623', '#EF4444', '#A855F7'] // design-allow: 新建项目的候选色板（数据值，不是样式类；进令牌属色板统一那张卡）

export const ProjectPicker: React.FC<ProjectPickerProps> = ({ value, onChange, invalid }) => {
  const { projects, createProject } = useProjectStore()
  const [creating, setCreating] = useState(false)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState('')

  // 归档的不作为候选，但已选中的归档项目仍要显示（否则会看不出这条属于哪）
  const candidates = projects.filter((p) => !p.archived || p.id === value)

  const submit = async () => {
    const name = draft.trim()
    if (!name) {
      setCreating(false)
      return
    }
    const hit = projects.find((p) => p.name === name)
    if (hit) {
      onChange(hit.id)
    } else {
      try {
        const created = await createProject({
          name,
          color: NEW_PROJECT_COLORS[projects.length % NEW_PROJECT_COLORS.length]
        })
        onChange(created.id)
      } catch (e) {
        setError((e as Error).message)
        return
      }
    }
    setDraft('')
    setCreating(false)
    setError('')
  }

  return (
    <div className="flex items-start gap-2.5 min-h-7">
      <span
        className={cn(
          'w-20 shrink-0 text-label inline-flex items-center gap-1.5 pt-1',
          invalid ? 'text-danger font-medium' : 'text-text-secondary'
        )}
      >
        <Icon name="folder" size={12} />
        <span>项目</span>
        <span className="text-danger">*</span>
      </span>

      <div className="flex-1 min-w-0 flex items-center gap-1.5 flex-wrap">
        {candidates.map((p) => {
          const active = value === p.id
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => onChange(p.id)}
              title={p.name}
              className={cn(
                'inline-flex items-center gap-1.5 h-7 px-2.5 rounded-button text-label border transition-colors',
                active
                  ? 'bg-bg-card text-text-primary font-semibold border-text-primary/30 shadow-card'
                  : 'bg-transparent text-text-secondary border-border/70 hover:text-text-primary hover:bg-surface-subtle'
              )}
            >
              <span
                className="w-2 h-2 rounded-full shrink-0"
                style={{ backgroundColor: p.color }}
              />
              <span className="truncate max-w-36">{p.name}</span>
            </button>
          )
        })}

        {creating ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value)
              if (error) setError('')
            }}
            onBlur={submit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                submit()
              }
              if (e.key === 'Escape') {
                setCreating(false)
                setDraft('')
              }
            }}
            placeholder="项目名，回车确认"
            maxLength={50}
            className="h-7 w-32 px-2.5 rounded-button text-label bg-bg-card
              border border-accent outline-none placeholder:text-text-secondary/60"
          />
        ) : (
          <button
            type="button"
            onClick={() => setCreating(true)}
            title="就地新建项目"
            className="inline-flex items-center gap-1 h-7 px-2 rounded-button text-caption
              text-text-secondary border border-dashed border-border hover:border-accent
              hover:text-accent transition-colors"
          >
            <Icon name="plus" size={10} />
            新项目
          </button>
        )}

        {error && <span className="text-caption text-danger">{error}</span>}
      </div>
    </div>
  )
}
