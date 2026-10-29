import React from 'react'
import { useUIStore } from '../../stores/ui.store'
import { useCategoryStore } from '../../stores/category.store'
import { useProjectStore } from '../../stores/project.store'
import { useTodoStore } from '../../stores/todo.store'
import { useSettingsStore } from '../../stores/settings.store'
import {
  matchesTodoFilter,
  collectOwners,
  collectExecutors,
  collectFixedVersions,
  ownerLabel,
  ALL_AGENTS,
  UNSET_FIXED,
  ANY_FIXED,
  type TodoFilter
} from '../../lib/todo-filter'
import { TIME_RANGE_LABEL, type TimeRange, type TimeRangeKey } from '../../lib/timeline-group'
import { DUE_SCOPES, DUE_SCOPE_LABEL, countDueScope } from '../../lib/due-scope'
import { PRIORITY_META, PRIORITY_ORDER, TYPE_META, TYPE_ORDER, STATUS_META } from '../../lib/constants'
import type { TodoPriority, TodoType, TodoStatus } from '../../types/enums'
import { Select } from '../ui/Select'
import { cn } from '../../lib/utils'

/**
 * 时间范围选择器（两种形态共用）
 *
 * 动态用它切"节点发生时间"，看板用它切"事项创建时间" ——
 * 两处结构完全相同（快捷档 + 自定义），只是绑定不同状态、粒度不同，
 * 所以共用这一个组件，避免同一套选档 UI 写出两份并各自漂移。
 */
const TimeRangePicker: React.FC<{
  value: TimeRange
  onChange: (r: TimeRange) => void
  /** 明确标出时间维度名称（创建时间 / 发生时间），避免与下方的「截止时间」混淆 */
  prefix: string
  hint: string
}> = ({ value, onChange, prefix, hint }) => (
  <>
    <Select
      value={value.key}
      ariaLabel={hint}
      options={(Object.keys(TIME_RANGE_LABEL) as TimeRangeKey[]).map((k) => ({
        value: k,
        label: k === 'all' ? `全部${prefix}` : `${prefix}：${TIME_RANGE_LABEL[k]}`
      }))}
      onChange={(next) => onChange({ key: next as TimeRangeKey })}
    />

    {/*
      自定义日期：只在选了「自定义…」时出现，不当常驻控件 ——
      为低频操作长期占用搜索框的宽度不划算。
      铺在下一行而不是挤进第一行，避免把第一行的下拉挤到看不全。
    */}
    {value.key === 'custom' && (
      <div className="flex items-center gap-2 px-3 pb-2 text-label text-text-secondary w-full">
        <input
          type="date"
          value={value.from ?? ''}
          onChange={(e) => onChange({ ...value, from: e.target.value || null })}
          className="h-7 px-2 rounded-input border border-border bg-bg-card text-label
            text-text-primary focus:border-accent outline-none"
        />
        <span>至</span>
        <input
          type="date"
          value={value.to ?? ''}
          onChange={(e) => onChange({ ...value, to: e.target.value || null })}
          className="h-7 px-2 rounded-input border border-border bg-bg-card text-label
            text-text-primary focus:border-accent outline-none"
        />
        <span className="text-text-secondary/70">（只填一端也可以）</span>
      </div>
    )}
  </>
)

/** 搜索筛选栏 */
export const SearchBar: React.FC<{
  /** 挂载后自动聚焦搜索框（顶栏「搜索」按钮展开弹层时用） */
  autoFocus?: boolean
  /**
   * 看板上真正渲染出来的卡片数（f6f78ada）
   *
   * 由窗口层用 hooks/useBoardVisibility 算好传进来：chips 回显行与这里显示的是同一个 N。
   * undefined = 这一形态不报卡片数（动态报的是事项数），此时不显示。
   */
  visibleCount?: number
}> = ({ autoFocus = false, visibleCount }) => {
  const { settings } = useSettingsStore()
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
    filterProjectIds,
    setFilterProjectIds,
    workspaceMode,
    filterPriority,
    setFilterPriority,
    filterType,
    setFilterType,
    filterFixedIn,
    setFilterFixedIn,
    filterStatus,
    setFilterStatus,
    workItemScope,
    boardView,
    filterTimeRange,
    setFilterTimeRange,
    filterCreatedRange,
    setFilterCreatedRange,
    filterDue,
    setFilterDue
  } = useUIStore()
  const { categories } = useCategoryStore()
  const { projects } = useProjectStore()
  const { todos } = useTodoStore()

  /**
   * 筛选后的候选集（f6f78ada 起不再拿它当「完成率」）
   *
   * 现在喂两处：今天/逾期两个档位上的计数，以及动态形态那句「共 N 条事项」。
   * 看板角标那个「筛选出 N 条」**不用它** —— 那个数还要过工作空间状态、视角、
   * 截止时间三层，由 hooks/useBoardVisibility 算，与列里的卡片逐条一致。
   */
  const isTimeline = boardView === 'timeline'

  const filter: TodoFilter = React.useMemo(
    () => ({
      keyword: searchKeyword,
      categoryId: filterCategory,
      owner: filterOwner,
      executor: filterExecutor,
      projectId: filterProject,
      projectIds: filterProjectIds,
      // 创建时间只在看板形态生效：动态那条河按节点发生时间自己筛，
      // 两套口径同时挂上去会出现"什么都没改却少了一批正常卡片"
      createdRange: isTimeline ? undefined : filterCreatedRange,
      priority: filterPriority,
      type: filterType,
      fixedIn: filterFixedIn ?? undefined
    }),
    [
      searchKeyword,
      filterCategory,
      filterOwner,
      filterExecutor,
      filterProject,
      filterProjectIds,
      filterCreatedRange,
      isTimeline,
      filterPriority,
      filterType,
      filterFixedIn
    ]
  )
  const matched = React.useMemo(
    () => todos.filter((t) => matchesTodoFilter(t, filter)),
    [todos, filter]
  )

  const owners = React.useMemo(() => collectOwners(todos), [todos])
  const executors = React.useMemo(() => collectExecutors(todos), [todos])
  /**
   * 版本选项**从数据里动态提取** —— 与归属同一理由：有哪些版本只有数据知道。
   * 而且它是**累积**的（1.0.58 标过就一直在），不是"当前迭代"的临时列表。
   */
  const fixedVersions = React.useMemo(
    () => collectFixedVersions(workspaceMode === 'project' && filterProject ? todos.filter((todo) => todo.projectId === filterProject) : todos),
    [todos, workspaceMode, filterProject]
  )

  const hasFilter =
    Boolean(searchKeyword.trim()) ||
    filterCategory !== null ||
    filterOwner !== 'all' ||
    filterExecutor !== 'all' ||
    (workspaceMode !== 'project' && filterProject !== null) ||
    filterStatus !== null ||
    filterPriority !== 'all' ||
    filterType !== 'all' ||
    filterFixedIn !== null ||
    filterDue !== 'all' ||
    (isTimeline
      ? filterTimeRange.key !== 'all'
      : filterCreatedRange.key !== 'all')

  return (
    <div className="border-b border-border bg-surface-subtle">
      {/*
        加 flex-wrap：时间范围选了「自定义…」时，两个日期输入要自己占一行。
        没有 wrap 的话它会挤在下拉框旁边，把搜索框压到看不全。
      */}
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        {/* 搜索框 */}
        <div className="relative flex-1 min-w-44">
          <svg
            className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-text-secondary"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            />
          </svg>
          <input
            ref={autoFocus ? (el) => el?.focus() : undefined}
            type="text"
            value={searchKeyword}
            onChange={(e) => setSearchKeyword(e.target.value)}
            placeholder="筛选事项..." aria-label="筛选当前事项列表" title="只筛选当前页面已加载的事项，不搜索评论或接手说明"
            className="w-full h-8 pl-8 pr-3 rounded-button border border-border bg-bg-card text-content
              placeholder:text-text-secondary/60 focus:border-accent outline-none transition-colors"
          />
        </div>

        {/*
          项目是导航上下文，不是项目空间里的普通筛选：
          进入项目后不再重复渲染项目选择器；非项目空间才显示按项目筛选。
        */}
        {workspaceMode === 'project' ? null : (
          <Select
            value={filterProject ?? ''}
            ariaLabel="按项目筛选"
            options={[
              { value: '', label: '全部项目' },
              ...projects
                .filter((p) => !p.archived)
                .map((p) => ({
                  value: p.id,
                  label: p.name,
                  color: p.color
                }))
            ]}
            onChange={(val) => setFilterProject(val || null)}
          />
        )}

        {/* 状态是看板列的细化筛选：范围控件只决定当前/已结束/全部。 */}
        <Select
          value={filterStatus ?? ''}
          ariaLabel="按状态筛选"
          options={[
            { value: '', label: '全部状态' },
            ...(Object.keys(STATUS_META) as TodoStatus[])
              .filter((status) =>
                workItemScope === 'current'
                  ? !['done', 'suspended', 'discarded'].includes(status)
                  : workItemScope === 'ended'
                    ? ['done', 'suspended', 'discarded'].includes(status)
                    : true
              )
              .map((status) => ({
                value: status,
                label: STATUS_META[status].label,
                color: `var(${STATUS_META[status].colorVar})`
              }))
          ]}
          onChange={(val) => setFilterStatus((val || null) as TodoStatus | null)}
        />

        {/* 标签筛选（对齐详情页「标签」字段命名） */}
        <Select
          value={filterCategory ?? ''}
          ariaLabel="按标签筛选"
          options={[
            { value: '', label: '全部标签' },
            ...categories.map((cat) => ({
              value: cat.id,
              label: cat.name,
              color: cat.color
            }))
          ]}
          onChange={(val) => setFilterCategory(val || null)}
        />

        {/*
          提出者筛选（对齐详情页「提出者」字段）：选项从数据里动态提取
        */}
        <Select
          value={filterOwner}
          ariaLabel="按提出者筛选"
          options={[
            { value: 'all', label: '全部提出者' },
            { value: ALL_AGENTS, label: '所有 AI' },
            ...owners.map((o) => ({
              value: o,
              label: ownerLabel(o, settings?.humanName)
            }))
          ]}
          onChange={(val) => setFilterOwner(val)}
        />

        {/*
          执行人筛选（对齐详情页「执行人」字段）：与提出者拆分为两个独立维度
        */}
        <Select
          value={filterExecutor}
          ariaLabel="按执行人筛选"
          options={[
            { value: 'all', label: '全部执行人' },
            { value: ALL_AGENTS, label: '所有 AI' },
            ...executors.map((ex) => ({
              value: ex,
              label: ownerLabel(ex, settings?.humanName)
            }))
          ]}
          onChange={(val) => setFilterExecutor(val)}
        />

        {/*
          优先级筛选：CLI 的 `todo list --priority` 一直有，界面此前没有。
          agent 报「还有 3 条 urgent 没做」时，人筛不出来只能逐列扫 —— 这句话无法核实。
          选项用 PRIORITY_META 而不是另写一份枚举，避免两处枚举漂移。
        */}
        <Select
          value={filterPriority}
          ariaLabel="按优先级筛选"
          options={[
            { value: 'all', label: '全部优先级' },
            ...PRIORITY_ORDER.map((p) => ({
              value: p,
              label: PRIORITY_META[p].label,
              color: PRIORITY_META[p].color
            }))
          ]}
          onChange={(val) => setFilterPriority(val as TodoPriority | 'all')}
        />

        {/*
          类型筛选：同优先级 —— CLI 的 `todo list --type` 一直有。
          agent 报「有 5 个 bug 待修」时界面无法核实，这条补上就对齐了。
        */}
        <Select
          value={filterType}
          ariaLabel="按事项类型筛选"
          options={[
            { value: 'all', label: '全部类型' },
            ...TYPE_ORDER.map((t) => ({
              value: t,
              label: TYPE_META[t].label,
              color: TYPE_META[t].color
            }))
          ]}
          onChange={(val) => setFilterType(val as TodoType | 'all')}
        />

        {/*
          解决版本筛选（对齐详情页「解决版本」字段）
        */}
        <Select
          value={filterFixedIn ?? ''}
          ariaLabel="按「解决版本」筛选"
          options={[
            { value: '', label: '全部解决版本' },
            { value: UNSET_FIXED, label: '未标注版本' },
            { value: ANY_FIXED, label: '已标注版本' },
            ...fixedVersions.map((v) => ({
              value: v,
              label: v
            }))
          ]}
          onChange={(val) => setFilterFixedIn(val || null)}
        />

        {/*
          时间范围：**只在动态形态出现**。
          动态是一直播下去的长河，没有时间维度就只能从头翻；
          而看板答的是"当下要做什么"，按时间切它没有意义
          （那是「今天/逾期」视角该干的事）。
        */}
        {isTimeline && (
          <TimeRangePicker
            value={filterTimeRange}
            onChange={setFilterTimeRange}
            prefix="发生时间"
            hint="按发生时间筛选（动态的这条记录是什么时候产生的）"
          />
        )}

        {/*
          看板的创建时间范围：答的是"这批事是什么时候记进来的"。
        */}
        {!isTimeline && (
          <TimeRangePicker
            value={filterCreatedRange}
            onChange={setFilterCreatedRange}
            prefix="创建时间"
            hint="按创建时间筛选（这条是什么时候记进来的）"
          />
        )}

        {/* 看板：当尚无激活筛选（ChipsBar 未展开）时在此显示卡片总数；有筛选时交由下方 ChipsBar 展示，避免重复显示两遍 */}
        {!isTimeline && !hasFilter && visibleCount !== undefined && (
          <span className="ml-auto text-label text-text-secondary whitespace-nowrap">
            筛选出 {visibleCount} 条
          </span>
        )}

        {/*
          动态：给的是**事项数**而不是节点数 ——
          一条事项在动态里会摊成"新建 + 完成"两个节点，
          报节点数（比事项多）会让人对不上"我到底有多少件事"。
        */}
        {isTimeline && matched.length > 0 && (
          <span className="text-label text-text-secondary whitespace-nowrap">
            {hasFilter ? '筛选出' : '共'} {matched.length} 条事项
          </span>
        )}
      </div>

      {/*
        截止时间筛选（对齐详情页「截止时间」字段）：明确写出「截止时间」前置标签，
        与第一行的「创建时间」下拉框区分开。
      */}
      {!isTimeline && (
        <div className="flex items-center gap-2 px-3 pb-2">
          <span className="text-caption font-medium text-text-secondary shrink-0">截止时间</span>
          <div className="inline-flex items-center p-0.5 rounded-button bg-surface-muted border border-border/60">
            {DUE_SCOPES.map((s) => {
              const n = countDueScope(matched, s)
              const active = filterDue === s
              return (
                <button
                  key={s}
                  type="button"
                  onClick={() => setFilterDue(s)}
                  className={cn(
                    'h-6 px-2.5 rounded-input text-caption transition-colors inline-flex items-center gap-1 cursor-pointer',
                    active
                      ? s === 'overdue'
                        ? 'bg-bg-card text-danger font-semibold shadow-sm'
                        : 'bg-bg-card text-text-primary font-semibold shadow-sm'
                      : 'text-text-secondary hover:text-text-primary'
                  )}
                >
                  {DUE_SCOPE_LABEL[s]}
                  <span className={cn('font-mono', active ? '' : 'text-text-secondary/70')}>{n}</span>
                </button>
              )
            })}
          </div>
        </div>
      )}

    </div>
  )
}
