import React, { useState } from 'react'
import { useCategoryStore } from '../../stores/category.store'
import { cn } from '../../lib/utils'
import { Icon } from '../ui/Icon'

interface CategoryPickerProps {
  /** 已选标签 id 列表（多值） */
  value: string[]
  onChange: (value: string[]) => void
}

/**
 * 标签选择器 — 遵循「属性表替代全量胶囊平铺」规范：
 * 默认只展示当前已选中的标签（色点 + 中性底色胶囊），点「+ 选择标签」按需展开候选面板并支持搜索，
 * 避免 20+ 个未选中标签常驻铺满整个详情抽屉。
 */
export const CategoryPicker: React.FC<CategoryPickerProps> = ({ value, onChange }) => {
  const { categories } = useCategoryStore()
  const [open, setOpen] = useState(false)
  const [keyword, setKeyword] = useState('')

  const toggle = (id: string) => {
    onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id])
  }

  const selectedCategories = categories.filter((c) => value.includes(c.id))
  const filteredCategories = keyword.trim()
    ? categories.filter((c) => c.name.toLowerCase().includes(keyword.trim().toLowerCase()))
    : categories

  return (
    <div className="flex items-start gap-2.5 min-h-7">
      <span className="w-20 shrink-0 text-label text-text-secondary inline-flex items-center gap-1.5 pt-1">
        <Icon name="tag" size={12} />
        <span>标签</span>
      </span>

      <div className="flex-1 min-w-0 flex flex-col gap-1.5">
        <div className="flex items-center gap-1.5 flex-wrap min-h-7">
          {selectedCategories.map((cat) => (
            <button
              key={cat.id}
              type="button"
              onClick={() => toggle(cat.id)}
              title={`点击移除标签「${cat.name}」`}
              className="inline-flex items-center gap-1.5 h-6 px-2 rounded-button text-caption font-medium
                bg-bg-card text-text-primary border border-border shadow-card hover:border-text-secondary transition-colors"
            >
              <span
                className="w-2 h-2 rounded-full shrink-0"
                style={{ backgroundColor: cat.color }}
              />
              <span>{cat.name}</span>
              <Icon name="x" size={10} className="text-text-secondary/70 hover:text-text-primary" />
            </button>
          ))}

          <button
            type="button"
            onClick={() => {
              setOpen(!open)
              if (open) setKeyword('')
            }}
            className={cn(
              'inline-flex items-center gap-1 h-6 px-2 rounded-button text-caption border transition-colors',
              open
                ? 'border-accent/40 bg-accent/5 text-accent font-medium'
                : 'border-dashed border-border text-text-secondary hover:text-text-primary hover:border-text-secondary'
            )}
          >
            <Icon name={open ? 'chevronLeft' : 'plus'} size={10} className={open ? 'rotate-90' : undefined} />
            <span>{open ? '收起标签' : selectedCategories.length > 0 ? '增减标签' : `选择标签 (${categories.length})`}</span>
          </button>
        </div>

        {open && (
          <div className="rounded-input border border-border bg-bg-card p-2.5 shadow-card grid gap-2">
            {categories.length > 6 && (
              <div className="relative">
                <Icon
                  name="search"
                  size={12}
                  className="text-text-secondary pointer-events-none absolute left-2 top-1/2 -translate-y-1/2"
                />
                <input
                  type="text"
                  value={keyword}
                  onChange={(e) => setKeyword(e.target.value)}
                  placeholder="搜索标签…"
                  className="h-7 w-full rounded-xs border border-border bg-surface-subtle pl-6 pr-2 text-caption text-text-primary placeholder:text-text-secondary/60 focus:border-accent outline-none"
                />
              </div>
            )}

            <div className="flex items-center gap-1.5 flex-wrap max-h-36 overflow-y-auto pr-0.5">
              {filteredCategories.map((cat) => {
                const active = value.includes(cat.id)
                return (
                  <button
                    key={cat.id}
                    type="button"
                    onClick={() => toggle(cat.id)}
                    className={cn(
                      'inline-flex items-center gap-1.5 h-6 px-2 rounded-xs text-caption border transition-colors',
                      active
                        ? 'bg-surface-muted text-text-primary font-semibold border-text-primary/30'
                        : 'bg-transparent text-text-secondary border-border/60 hover:text-text-primary hover:bg-surface-subtle'
                    )}
                  >
                    <span
                      className="w-2 h-2 rounded-full shrink-0"
                      style={{ backgroundColor: cat.color }}
                    />
                    <span>{cat.name}</span>
                  </button>
                )
              })}
              {filteredCategories.length === 0 && (
                <span className="text-caption text-text-secondary py-1">没有匹配的标签</span>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
