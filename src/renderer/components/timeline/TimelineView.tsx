import React, { useEffect, useMemo, useState } from 'react'
import { useTodoStore } from '../../stores/todo.store'
import { useUIStore } from '../../stores/ui.store'
import { useSettingsStore } from '../../stores/settings.store'
import { matchesTodoFilter, matchesViewScope, ownerLabel, type TodoFilter } from '../../lib/todo-filter'
import { formatDayHeading, formatTimeOnly } from '../../lib/date'
import { buildTimeline, TIMELINE_KIND_LABEL, type TimelineEvent } from '../../lib/timeline-group'
import { STATUS_META } from '../../lib/constants'
import { stripMarkdown } from '../../lib/markdown'
import type { TodoTransition } from '../../types/todo'
import { invoke } from '../../lib/ipc-client'

/** agent 的标识色，与卡片上的归属徽标保持一致 */
const AGENT_COLOR = '#A855F7'

/**
 * 动态一屏渲染多少条（2026-09-25）。
 *
 * 默认时间范围是「全部」，全量铺开会有 900+ 节点 —— 那一屏的主线程开销
 * 就是切换卡顿的根因（14ae2eae）。首屏只渲染这些，其余走底部「显示更多」。
 */
const TIMELINE_PAGE_SIZE = 100

/** 动态里的一条节点 */
const TimelineRow: React.FC<{
  event: TimelineEvent
  isLast: boolean
  /** 人给自己取的名字（没取则显示「我」） */
  humanName?: string
}> = ({ event, isLast, humanName }) => {
  const { todo, kind, at } = event
  /**
   * 主语一律用事件自带的动作人（铺节点时已按真相算好）：
   * 新建=谁记的、完成=谁拍板验收的、推进=谁推的 —— 都是流转记录里的 actor，
   * 不再按提出者/执行者猜（agent 交付的事被显示成"agent 验收通过了"就是这么来的）。
   * actor 为空（旧数据未记录）就如实写"未记录"，不猜。
   */
  const displayActor = event.actor ? ownerLabel(event.actor, humanName) : '未记录'
  const isAgent = (event.actor ?? '').startsWith('agent:')
  const isCompleted = kind === 'completed'
  /**
   * 流转的"从哪到哪"。fromStatus 理论上不会是 null（那种已被创建节点覆盖，
   * 铺节点时就被滤掉了），这里仍按类型守卫兜底，不赌数据。
   *
   * ⚠️ 判据是"**带 transition 的节点**"而不是 `kind === 'transitioned'`
   * （1.0.72 修）。加 `rejected` 那种节点时写死 kind 判断会让它**丢掉状态箭头** ——
   * 而"从待验收退回进行中"正是驳回这条动态的信息本体。
   * 判据：**看数据在不在，别看它叫什么名字**；新增节点类型时不必回来改这里。
   */
  const transition = event.transition
  const fromMeta = transition?.fromStatus ? STATUS_META[transition.fromStatus] : null
  const toMeta = transition ? STATUS_META[transition.toStatus] : null
  /** 驳回要一眼认出来：它是裁决，不是推进 */
  const isRejected = kind === 'rejected'

  return (
    <div className="flex gap-2.5 -mx-2 px-2 rounded-input hover:bg-black/[0.03] transition-colors">
      {/* 时间线轴：圆点 + 竖线 */}
      <div className="flex flex-col items-center shrink-0 pt-1.75">
        {/*
          驳回用红色空心点，与完成的实心点区分开（1.0.72）。
          为什么不给它上"动作人颜色"：那条颜色编码的是**谁做的**，
          而驳回这条动态里更该被一眼认出的是**这是裁决** ——
          扫时间线的人先看形状与颜色，再读字。
          配色复用状态色板里的 red，与通知中心的"退回"同一套，不新造。
        */}
        <span
          className={
            isRejected
              ? 'w-2 h-2 rounded-full shrink-0 border-2 border-red-500 bg-transparent'
              : 'w-1.5 h-1.5 rounded-full shrink-0'
          }
          style={
            isRejected
              ? undefined
              : { backgroundColor: isAgent ? AGENT_COLOR : 'var(--color-text-secondary)' }
          }
          title={isRejected ? '验收未通过，被退回' : undefined}
        />
        {!isLast && <span className="w-px flex-1 bg-border my-1" />}
      </div>

      <div
        className="flex-1 min-w-0 pb-4 cursor-pointer"
        /*
         * 点开这条事项的详情。
         *
         * 走 IPC 让主进程开窗口 —— 弹窗是另一个 BrowserWindow，
         * zustand store 不跨窗口，直接调 store 只会改到当前窗口的状态。
         * 与看板卡片双击同一个入口。
         */
        onClick={() => invoke('window:showQuickAdd', { todoId: todo.id })}
        title="点击查看详情"
      >
        {/*
          一行交代「谁 · 做了什么 · 什么时候」。
          「做了什么」是最要紧的那一笔 —— 此前动态里只有事项和时间，
          看不出这条是新登记的、还是刚做完的，也就读不出它发生了什么。
          归属在这里连「我」也标：卡片上只标非 human（每条都标等于没信息），
          但动态是日志，「谁做的」本身就是主要信息。
        */}
        <div className="flex items-baseline gap-1.5 text-label">
          <span className="font-medium text-text-primary">{displayActor}</span>
          <span
            className={
              isCompleted
                ? 'text-success font-medium'
                : isRejected
                  ? 'text-danger font-medium'
                  : 'text-text-secondary'
            }
          >
            {TIMELINE_KIND_LABEL[kind]}
          </span>
          <span className="text-text-secondary/70 font-mono text-caption">{formatTimeOnly(at)}</span>
        </div>

        <p className="text-content font-normal text-text-primary leading-snug mt-0.5 break-words">
          {todo.title}
        </p>

        {/*
          流转节点补一行"从哪到哪"：光看"推进了"不知道推进到哪，
          状态箭头才是这条动态的信息本体。颜色用各状态的主题色圆点。
        */}
        {fromMeta && toMeta && (
          <div className="flex items-center gap-1.5 text-caption text-text-secondary mt-1">
            <span
              className="w-1.5 h-1.5 rounded-full shrink-0"
              style={{ backgroundColor: `var(${fromMeta.colorVar})` }}
            />
            <span>{fromMeta.label}</span>
            <span aria-hidden>→</span>
            <span
              className="w-1.5 h-1.5 rounded-full shrink-0"
              style={{ backgroundColor: `var(${toMeta.colorVar})` }}
            />
            <span>{toMeta.label}</span>
          </div>
        )}

        {/*
          描述只在「完成」节点显示：剥离 Markdown 源码符号，展示干净的纯文本摘要。
        */}
        {isCompleted && todo.description && (
          <p className="text-label text-text-secondary leading-relaxed mt-1 line-clamp-3 break-words">
            {stripMarkdown(todo.description)}
          </p>
        )}
      </div>
    </div>
  )
}

/**
 * 动态视图
 *
 * 看板答「接下来要做什么」，动态答「发生过什么」。
 * 每条是一个关键节点：新建 / 完成 —— 而不是"当前有哪些已完成的事"。
 *
 * 这是「人机共享」里最要紧的一块：agent 做完事登记进来（`--status done`），
 * 人在这里看得见是谁、什么时候、做完了什么，以及它为什么这么做。
 */
export const TimelineView: React.FC = () => {
  const { todos } = useTodoStore()
  const { settings } = useSettingsStore()
  const {
    searchKeyword,
    filterCategory,
    filterOwner,
    filterExecutor,
    filterProject,
    filterProjectIds,
    filterTimeRange,
    filterStatus,
    filterPriority,
    filterType,
    filterFixedIn
  } = useUIStore()
  // 视角（在看谁的事）与形态无关：看板和动态都得跟着它收窄
  const viewScope = useUIStore((s) => s.viewScope)

  /**
   * 中间流转（v14）。
   *
   * 跟着 todos 的引用刷新：todos 在每次 dataChanged 后都会换新引用，
   * 而状态变化必然伴随一次 dataChanged —— 借它的节奏带出流转，
   * 不用再单独订阅或轮询。
   */
  const [transitions, setTransitions] = useState<TodoTransition[]>([])
  useEffect(() => {
    let cancelled = false
    invoke('todo:listTransitions')
      .then((rows) => {
        if (!cancelled) setTransitions(rows)
      })
      .catch(() => {
        // 拉不到流转就让动态退回"只有新建/完成"的旧貌，不该因此白屏
      })
    return () => {
      cancelled = true
    }
  }, [todos])

  // 与看板共用同一份判断逻辑：切形态时筛选条件不该被重置，
  // 两处各写一份也迟早会出现"数字和内容对不上"
  const filter: TodoFilter = useMemo(
    () => ({
      keyword: searchKeyword,
      categoryId: filterCategory,
      owner: filterOwner,
      executor: filterExecutor,
      projectId: filterProject,
      projectIds: filterProjectIds,
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
      filterPriority,
      filterType,
      filterFixedIn
    ]
  )

  // 事项属性筛选在这里做；时间线展示项目发生过的全部事件（包含已完成事项），不受看板「当前工作」列范围截断
  const visibleTodos = useMemo(
    () =>
      todos.filter(
        (t) =>
          matchesViewScope(t, viewScope) &&
          matchesTodoFilter(t, filter) &&
          // 状态类智能视图（1.0.48）：看板只渲染目标列，动态也按同一范围收窄
          (filterStatus === null || t.status === filterStatus)
      ),
    [todos, filter, viewScope, filterStatus]
  )
  const groups = useMemo(
    () => buildTimeline(visibleTodos, transitions, filterTimeRange),
    [visibleTodos, transitions, filterTimeRange]
  )

  /**
   * 分批渲染（2026-09-25，修「看板 ↔ 动态切换卡顿」14ae2eae）
   *
   * 根因：默认时间范围是 `all`，而库里是 309 条事项 + 611 条流转，
   * 一次性铺出 **900 多个节点**、每个节点都有归属徽标/日期/状态色要算 ——
   * 主线程被整块占住，自动探针量切换耗时直接 20 秒超时未返回。
   *
   * 修法不是改默认时间范围（那会让人看不到更早的动态），
   * 而是**首屏限量 + 底部「显示更多」**：信息一点没少，按住的是第一次渲染的量。
   */
  const [limit, setLimit] = useState(TIMELINE_PAGE_SIZE)
  // 换时间范围/筛选条件就回到第一页，否则会停在上一批的条数上，看着像漏了
  useEffect(() => {
    setLimit(TIMELINE_PAGE_SIZE)
  }, [filterTimeRange, viewScope, filterStatus])

  const total = useMemo(() => groups.reduce((s, g) => s + g.items.length, 0), [groups])
  /** 按分组顺序裁剪到 limit 条，分组结构保持完整（不会出现半个日期段） */
  const shownGroups = useMemo(() => {
    let used = 0
    const out: typeof groups = []
    for (const g of groups) {
      const rest = limit - used
      if (rest <= 0) break
      const items = g.items.slice(0, rest)
      if (items.length) out.push({ key: g.key, items })
      used += items.length
    }
    return out
  }, [groups, limit])

  if (!groups.length) {
    return (
      <div className="flex-1 min-h-0 flex items-center justify-center px-8">
        <p className="text-label text-text-secondary text-center leading-relaxed">
          这个范围里还没有动态。
          <br />
          换个时间范围试试，或新建 / 完成一条事项。
        </p>
      </div>
    )
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5">
      <div className="max-w-4xl mx-auto flex flex-col gap-3.5">
        {shownGroups.map((g) => (
          <section
            key={g.key}
            className="rounded-card border border-border bg-bg-card px-5 py-4 shadow-sm"
          >
            <div className="text-caption font-semibold text-text-secondary tracking-label mb-3 pb-2 border-b border-border/60">
              {formatDayHeading(g.items[0].at)}
            </div>
            {g.items.map((e, i) => (
              <TimelineRow
                key={`${e.todo.id}-${e.kind}-${e.at}`}
                event={e}
                isLast={i === g.items.length - 1}
                humanName={settings?.humanName}
              />
            ))}
          </section>
        ))}

        {/*
          分批的出口必须看得见：只渲染前 N 条却不告诉人还有多少，
          他会以为动态就这些 —— 那比卡顿更糟（信息被悄悄藏了）。
        */}
        {total > limit && (
          <button
            type="button"
            onClick={() => setLimit((n) => n + TIMELINE_PAGE_SIZE)}
            className="w-full py-2.5 text-label text-text-secondary hover:text-text-primary
              border border-border rounded-card bg-bg-card hover:bg-surface-subtle transition-colors"
            title={`共 ${total} 条，已显示 ${Math.min(limit, total)} 条`}
          >
            显示更多（还有 {total - Math.min(limit, total)} 条）
          </button>
        )}
      </div>
    </div>
  )
}
