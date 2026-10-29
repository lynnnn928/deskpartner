import React from 'react'
import { Icon } from '../ui/Icon'
import { useUIStore } from '../../stores/ui.store'
import { useCategoryStore } from '../../stores/category.store'
import { useProjectStore } from '../../stores/project.store'
import { useSettingsStore } from '../../stores/settings.store'
import {
  NO_PROJECT,
  ALL_AGENTS,
  UNSET_FIXED,
  ANY_FIXED,
  ownerLabel
} from '../../lib/todo-filter'
import { TIME_RANGE_LABEL } from '../../lib/timeline-group'
import { DUE_SCOPE_LABEL } from '../../lib/due-scope'
import { PRIORITY_META, TYPE_META, STATUS_META } from '../../lib/constants'

/**
 * 筛选 chips 回显条（1.0.48，v2 设计：内容区管 chips）
 *
 * 筛选控件收进顶栏弹层后，人需要一个**常显的地方回答「现在筛着什么」**——
 * 否则弹层一关，"为什么只剩这几张卡"就成了谜。每个 chip 带 x 可单独摘掉。
 * 没有激活的筛选时整条不渲染（不占版面）。
 *
 * 右端那个数字是「筛选出 N 条」（f6f78ada）：N = 屏幕上真正渲染出来的卡片数，
 * 由窗口层算好传进来 —— 与搜索行同一个 N，不再各算一份完成率。
 */
export const ChipsBar: React.FC<{
  /**
   * 看板上真正渲染出来的卡片数（f6f78ada）
   *
   * undefined = 这一形态不报卡片数（动态那边报的是事项数），此时不显示。
   */
  visibleCount?: number
}> = ({ visibleCount }) => {
  const {
    searchKeyword,
    setSearchKeyword,
    filterCategory,
    setFilterCategory,
    filterOwner,
    setFilterOwner,
    filterExecutor,
    setFilterExecutor,
    filterProject,
    setFilterProject,
    filterPriority,
    setFilterPriority,
    filterType,
    setFilterType,
    filterFixedIn,
    setFilterFixedIn,
    filterStatus,
    setFilterStatus,
    filterDue,
    setFilterDue,
    workspaceMode,
    boardView,
    filterTimeRange,
    setFilterTimeRange,
    filterCreatedRange,
    setFilterCreatedRange,
    viewScope,
    setViewScope
  } = useUIStore()
  const { categories } = useCategoryStore()
  const { projects } = useProjectStore()
  const { settings } = useSettingsStore()

  const isTimeline = boardView === 'timeline'
  const range = isTimeline ? filterTimeRange : filterCreatedRange

  const chips: { key: string; label: string; onClear: () => void }[] = []
  if (searchKeyword.trim()) {
    chips.push({
      key: 'kw',
      label: `搜索 ${searchKeyword.trim()}`,
      onClear: () => setSearchKeyword('')
    })
  }
  if (filterCategory) {
    chips.push({
      key: 'cat',
      label: `标签 ${categories.find((c) => c.id === filterCategory)?.name ?? ''}`,
      onClear: () => setFilterCategory(null)
    })
  }
  if (filterOwner !== 'all') {
    chips.push({
      key: 'owner',
      label: `提出者 ${filterOwner === ALL_AGENTS ? '所有 AI' : ownerLabel(filterOwner, settings?.humanName)}`,
      onClear: () => setFilterOwner('all')
    })
  }
  if (filterExecutor !== 'all') {
    chips.push({
      key: 'executor',
      label: `执行人 ${filterExecutor === ALL_AGENTS ? '所有 AI' : ownerLabel(filterExecutor, settings?.humanName)}`,
      onClear: () => setFilterExecutor('all')
    })
  }
  if (filterProject && workspaceMode !== 'project') {
    chips.push({
      key: 'proj',
      label: `项目 ${
        filterProject === NO_PROJECT
          ? '项目归属缺失'
          : (projects.find((p) => p.id === filterProject)?.name ?? '')
      }`,
      onClear: () => setFilterProject(null)
    })
  }
  if (filterStatus) {
    chips.push({
      key: 'status',
      label: `状态 ${STATUS_META[filterStatus].label}`,
      onClear: () => setFilterStatus(null)
    })
  }
  if (filterPriority !== 'all') {
    chips.push({
      key: 'prio',
      label: `优先级 ${PRIORITY_META[filterPriority].label}`,
      onClear: () => setFilterPriority('all')
    })
  }
  if (filterType !== 'all') {
    chips.push({
      key: 'type',
      label: `类型 ${TYPE_META[filterType].label}`,
      onClear: () => setFilterType('all')
    })
  }
  if (filterFixedIn !== null) {
    chips.push({
      key: 'fixed',
      label: `解决版本 ${
        filterFixedIn === UNSET_FIXED
          ? '未标注'
          : filterFixedIn === ANY_FIXED
            ? '已标注'
            : filterFixedIn
      }`,
      onClear: () => setFilterFixedIn(null)
    })
  }
  if (range.key !== 'all') {
    chips.push({
      key: 'range',
      label: isTimeline ? `发生时间 ${TIME_RANGE_LABEL[range.key]}` : `创建时间 ${TIME_RANGE_LABEL[range.key]}`,
      onClear: () =>
        isTimeline ? setFilterTimeRange({ key: 'all' }) : setFilterCreatedRange({ key: 'all' })
    })
  }
  if (!isTimeline && filterDue !== 'all') {
    chips.push({
      key: 'due',
      label: `截止时间 ${DUE_SCOPE_LABEL[filterDue]}`,
      onClear: () => setFilterDue('all')
    })
  }
  if (viewScope !== 'all') {
    chips.push({
      key: 'scope',
      label: `视角 ${viewScope === 'mine' ? '我的' : viewScope}`,
      onClear: () => setViewScope('all')
    })
  }

  if (chips.length === 0) return null

  return (
    <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-border overflow-x-auto shrink-0">
      {chips.map((c) => (
        <span
          key={c.key}
          className="inline-flex items-center gap-1 h-6 pl-2 pr-1 rounded-tag border border-border text-label text-text-secondary whitespace-nowrap"
        >
          {c.label}
          <button
            type="button"
            onClick={c.onClear}
            className="w-4 h-4 inline-flex items-center justify-center rounded-full hover:bg-black/10 hover:text-text-primary"
            aria-label={`清除筛选：${c.label}`}
          >
            <Icon name="x" size={10} />
          </button>
        </span>
      ))}
      {visibleCount !== undefined && (
        <span className="ml-auto text-label text-text-secondary whitespace-nowrap">
          筛选出 {visibleCount} 条
        </span>
      )}
    </div>
  )
}
