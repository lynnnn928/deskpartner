import React, { useEffect, useMemo, useState } from 'react'
import { Icon } from '../ui/Icon'
import { Button } from '../ui/Button'
import { useTodoStore } from '../../stores/todo.store'
import { useProjectStore } from '../../stores/project.store'
import { useSettingsStore } from '../../stores/settings.store'
import { ownerLabel } from '../../lib/todo-filter'
import { effectiveExecutor } from '../../lib/assignable-executors'
import { STATUS_META } from '../../lib/constants'
import { invoke } from '../../lib/ipc-client'
import type { TodoStatus } from '../../types/enums'
import { cn } from '../../lib/utils'

/**
 * 统计与工作洞察页（参考 Linear Insights 重构升级）
 *
 * 四层结构：
 * 1. 核心健康度 KPI 卡片（周期吞吐与净消化、当前在制与积压、待你拍板瓶颈、平均交付周期）
 * 2. 趋势与存量结构（创建 vs 完成每日趋势柱状图 + 当前状态构成比例条）
 * 3. 人机协同交付榜（按真实执行人统计已完成 / 待验收 / 进行中）与项目完成率对比
 * 4. 底部默认折叠的「本地运行与 CLI 诊断统计」
 */

const RANGES = [
  { key: '7d', label: '近 7 天', days: 7 },
  { key: '30d', label: '近 30 天', days: 30 },
  { key: 'all', label: '全部', days: 0 }
] as const
type RangeKey = (typeof RANGES)[number]['key']

interface StatsData {
  total: number
  sessions: number
  failed: number
  durationMs: { p50: number; p95: number } | null
  bySurface: Record<string, number>
  byCategory: Record<string, number>
  byEvent: Record<string, number>
  firstTs: string | null
  lastTs: string | null
}

const SURFACE_LABEL: Record<string, string> = {
  gui: '界面',
  cli: 'CLI',
  pipe: '管道',
  headless: '无头'
}
const CATEGORY_LABEL: Record<string, string> = {
  read: '读取',
  write: '写入',
  config: '改设置',
  destructive: '删除',
  admin: '管理'
}

const BREAKDOWN_STATUSES: TodoStatus[] = [
  'proposed',
  'todo',
  'in_progress',
  'awaiting_review',
  'suspended',
  'done'
]

export const StatsView: React.FC = () => {
  const [data, setData] = useState<StatsData | null>(null)
  const [range, setRange] = useState<RangeKey>('7d')
  const [selectedProjectId, setSelectedProjectId] = useState<string>('all')
  const [loading, setLoading] = useState(true)
  const { todos } = useTodoStore()
  const { projects } = useProjectStore()
  const { settings } = useSettingsStore()

  const activeProjects = useMemo(() => projects.filter((p) => !p.archived), [projects])
  const days = RANGES.find((r) => r.key === range)?.days ?? 7
  const since = useMemo(() => {
    if (!days) return undefined
    return new Date(Date.now() - days * 86400000).toISOString()
  }, [days])

  const load = async () => {
    setLoading(true)
    try {
      const d = (await invoke('telemetry:stats', { since })) as StatsData | null
      setData(d)
    } catch {
      setData(null)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [since])

  const handleExport = async () => {
    try {
      const rows = await invoke('telemetry:export', { since })
      const ndjson = rows.map((r) => JSON.stringify(r)).join('\n')
      const blob = new Blob([ndjson], { type: 'application/x-ndjson' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `desk-partner-usage-${new Date().toISOString().slice(0, 10)}.ndjson`
      a.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      console.error('导出失败:', e)
    }
  }

  /** 按所选项目过滤后的事项集合 */
  const scopedTodos = useMemo(
    () =>
      selectedProjectId === 'all'
        ? todos
        : todos.filter((t) => t.projectId === selectedProjectId),
    [todos, selectedProjectId]
  )

  // ── 一、核心健康度 KPI 指标计算 ──
  const kpi = useMemo(() => {
    const sinceTs = days ? Date.now() - days * 86400000 : 0
    const nowTs = Date.now()
    let periodCreated = 0
    let periodDone = 0
    let proposedCount = 0
    let todoCount = 0
    let inProgressCount = 0
    let awaitingReviewCount = 0
    let suspendedCount = 0
    let doneCount = 0
    let overdueCount = 0
    const cycleHours: number[] = []

    for (const t of scopedTodos) {
      if (t.status === 'proposed') proposedCount++
      else if (t.status === 'todo') todoCount++
      else if (t.status === 'in_progress') inProgressCount++
      else if (t.status === 'awaiting_review') awaitingReviewCount++
      else if (t.status === 'suspended') suspendedCount++
      else if (t.status === 'done') doneCount++

      if (
        t.dueAt &&
        t.status !== 'done' &&
        t.status !== 'discarded' &&
        new Date(t.dueAt).getTime() < nowTs
      ) {
        overdueCount++
      }

      const cTs = t.createdAt ? new Date(t.createdAt).getTime() : 0
      if (cTs >= sinceTs) periodCreated++

      const dTs = t.completedAt ? new Date(t.completedAt).getTime() : 0
      if (dTs >= sinceTs && t.status === 'done') {
        periodDone++
        if (cTs > 0 && dTs >= cTs) {
          cycleHours.push((dTs - cTs) / 3600000)
        }
      }
    }

    cycleHours.sort((a, b) => a - b)
    const medianHours =
      cycleHours.length > 0 ? cycleHours[Math.floor(cycleHours.length / 2)] : null
    const cycleLabel =
      medianHours === null
        ? '—'
        : medianHours < 1
          ? `${Math.max(1, Math.round(medianHours * 60))} 分钟`
          : medianHours < 24
            ? `${medianHours.toFixed(1)} 小时`
            : `${(medianHours / 24).toFixed(1)} 天`

    const netDelta = periodDone - periodCreated
    const activeWip = proposedCount + todoCount + inProgressCount + awaitingReviewCount
    const actionableTotal = activeWip + doneCount + suspendedCount

    return {
      periodCreated,
      periodDone,
      netDelta,
      activeWip,
      proposedCount,
      todoCount,
      inProgressCount,
      awaitingReviewCount,
      suspendedCount,
      doneCount,
      overdueCount,
      cycleLabel,
      cycleSamples: cycleHours.length,
      actionableTotal
    }
  }, [scopedTodos, days])

  // ── 二、每日趋势曲线（新建 vs 完成） ──
  const curve = useMemo(() => {
    const span = days || 30
    const buckets: { day: string; created: number; done: number }[] = []
    const map = new Map<string, { created: number; done: number }>()
    const pad = (n: number) => String(n).padStart(2, '0')
    for (let i = span - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000)
      const key = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
      map.set(key, { created: 0, done: 0 })
      buckets.push({ day: key, created: 0, done: 0 })
    }
    for (const t of scopedTodos) {
      if (t.createdAt) {
        const cd = new Date(t.createdAt)
        if (!Number.isNaN(cd.getTime())) {
          const cKey = `${cd.getFullYear()}-${pad(cd.getMonth() + 1)}-${pad(cd.getDate())}`
          const c = map.get(cKey)
          if (c) c.created++
        }
      }
      if (t.completedAt && t.status === 'done') {
        const dd = new Date(t.completedAt)
        if (!Number.isNaN(dd.getTime())) {
          const dKey = `${dd.getFullYear()}-${pad(dd.getMonth() + 1)}-${pad(dd.getDate())}`
          const dn = map.get(dKey)
          if (dn) dn.done++
        }
      }
    }
    return buckets.map((b) => ({ day: b.day, ...(map.get(b.day) ?? b) }))
  }, [scopedTodos, days])
  const curveMax = Math.max(1, ...curve.map((d) => Math.max(d.created, d.done)))

  // ── 三、执行人交付与在制负载分布（按真实执行人 effectiveExecutor 统计） ──
  const executorRows = useMemo(() => {
    const sinceTs = days ? Date.now() - days * 86400000 : 0
    const acc = new Map<
      string,
      { doneInPeriod: number; awaitingReview: number; inProgressOrTodo: number }
    >()
    for (const t of scopedTodos) {
      if (t.status === 'discarded') continue
      const actor = effectiveExecutor({
        createdBy: t.createdBy || 'human',
        executedBy: t.executedBy ?? null
      })
      const cur = acc.get(actor) ?? {
        doneInPeriod: 0,
        awaitingReview: 0,
        inProgressOrTodo: 0
      }
      if (
        t.status === 'done' &&
        t.completedAt &&
        new Date(t.completedAt).getTime() >= sinceTs
      ) {
        cur.doneInPeriod++
      } else if (t.status === 'awaiting_review') {
        cur.awaitingReview++
      } else if (t.status === 'in_progress' || t.status === 'todo') {
        cur.inProgressOrTodo++
      }
      acc.set(actor, cur)
    }
    return [...acc.entries()]
      .map(([actor, v]) => ({
        actor,
        ...v,
        total: v.doneInPeriod + v.awaitingReview + v.inProgressOrTodo
      }))
      .filter((r) => r.total > 0)
      .sort((a, b) => b.doneInPeriod - a.doneInPeriod || b.total - a.total)
  }, [scopedTodos, days])
  const executorMax = Math.max(1, ...executorRows.map((r) => r.total))

  // ── 四、各项目活跃负载与完成率对比（排除 discarded） ──
  const projectRows = useMemo(() => {
    const rows = activeProjects
      .map((p) => {
        const pt = todos.filter((t) => t.projectId === p.id && t.status !== 'discarded')
        const active = pt.filter((t) => t.status !== 'done' && t.status !== 'discarded').length
        const done = pt.filter((t) => t.status === 'done').length
        const total = active + done
        const rate = total > 0 ? Math.round((done / total) * 100) : 0
        return {
          id: p.id,
          name: p.name,
          color: p.color,
          active,
          done,
          total,
          rate
        }
      })
      .filter((r) => r.total > 0)
      .sort((a, b) => b.active - a.active || b.total - a.total)
    return rows
  }, [todos, activeProjects])

  const surfaceRows = toRows(data?.bySurface, SURFACE_LABEL)
  const categoryRows = toRows(data?.byCategory, CATEGORY_LABEL)
  const eventRows = toRows(data?.byEvent).slice(0, 10)

  const firstDay = curve[0]?.day.slice(5) ?? ''
  const midDay = curve[Math.floor(curve.length / 2)]?.day.slice(5) ?? ''
  const lastDay = curve[curve.length - 1]?.day.slice(5) ?? ''

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="max-w-5xl mx-auto w-full px-6 py-5 flex flex-col gap-4">
        {/* 顶栏：标题 + 时间范围切换 + 项目范围切换 + 刷新 / 导出 */}
        <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-border">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-title font-semibold text-text-primary tracking-title">统计</h1>
            <div className="inline-flex items-center gap-0.5 rounded-button bg-surface-subtle p-0.5 border border-border/70">
              {RANGES.map((r) => (
                <button
                  key={r.key}
                  type="button"
                  onClick={() => setRange(r.key)}
                  className={cn(
                    'px-3 py-1 rounded-xs text-label transition-colors cursor-pointer',
                    range === r.key
                      ? 'bg-bg-card text-text-primary font-semibold shadow-sm'
                      : 'text-text-secondary hover:text-text-primary'
                  )}
                >
                  {r.label}
                </button>
              ))}
            </div>

            {activeProjects.length > 1 && (
              <div className="inline-flex items-center gap-1 flex-wrap">
                <button
                  type="button"
                  onClick={() => setSelectedProjectId('all')}
                  className={cn(
                    'h-7 px-2.5 rounded-button text-caption border transition-colors cursor-pointer',
                    selectedProjectId === 'all'
                      ? 'bg-accent/10 text-accent border-accent/30 font-semibold'
                      : 'bg-bg-card text-text-secondary border-border hover:text-text-primary'
                  )}
                >
                  全部项目
                </button>
                {activeProjects.map((proj) => {
                  const active = selectedProjectId === proj.id
                  return (
                    <button
                      key={proj.id}
                      type="button"
                      onClick={() => setSelectedProjectId(proj.id)}
                      className={cn(
                        'h-7 px-2.5 rounded-button text-caption border transition-colors inline-flex items-center gap-1.5 cursor-pointer',
                        active
                          ? 'bg-accent/10 text-accent border-accent/30 font-semibold'
                          : 'bg-bg-card text-text-secondary border-border hover:text-text-primary'
                      )}
                    >
                      <span
                        className="w-2 h-2 rounded-full shrink-0"
                        style={{ backgroundColor: proj.color }}
                      />
                      <span>{proj.name}</span>
                    </button>
                  )
                })}
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="border border-border bg-bg-card hover:bg-surface-subtle px-2.5 text-text-primary cursor-pointer"
              onClick={() => void load()}
            >
              <span className="inline-flex items-center gap-1.5">
                <Icon name="refreshCw" size={13} />
                刷新
              </span>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="border border-border bg-bg-card hover:bg-surface-subtle px-2.5 text-text-primary cursor-pointer"
              onClick={() => void handleExport()}
            >
              导出 NDJSON
            </Button>
          </div>
        </div>

        {/* ── 第一层：4 张核心健康度 KPI 卡片 ── */}
        <section className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <div className="rounded-card border border-border bg-bg-card p-4 shadow-sm flex flex-col justify-between gap-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-label font-medium text-text-secondary">周期吞吐量</span>
              <span
                className={cn(
                  'px-2 py-0.5 rounded-full text-caption font-mono font-medium',
                  kpi.netDelta > 0
                    ? 'bg-success/10 text-success'
                    : kpi.netDelta < 0
                      ? 'bg-warning/10 text-warning'
                      : 'bg-surface-subtle text-text-secondary'
                )}
              >
                {kpi.netDelta > 0
                  ? `净消化 +${kpi.netDelta}`
                  : kpi.netDelta < 0
                    ? `净新增 +${Math.abs(kpi.netDelta)}`
                    : '收支平衡'}
              </span>
            </div>
            <div className="flex items-baseline gap-2">
              <span className="text-title font-semibold font-mono text-success">
                {kpi.periodDone}
              </span>
              <span className="text-caption text-text-secondary">完成</span>
              <span className="text-text-secondary/40 font-mono">/</span>
              <span className="text-body font-semibold font-mono text-text-primary">
                {kpi.periodCreated}
              </span>
              <span className="text-caption text-text-secondary">新建</span>
            </div>
            <div className="text-caption text-text-secondary">
              {days ? `近 ${days} 天新增与收口对比` : '全部历史新增与收口对比'}
            </div>
          </div>

          <div className="rounded-card border border-border bg-bg-card p-4 shadow-sm flex flex-col justify-between gap-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-label font-medium text-text-secondary">当前在制与排期</span>
              <span className="px-2 py-0.5 rounded-full bg-surface-subtle text-caption font-mono text-text-secondary">
                活跃池
              </span>
            </div>
            <div className="flex items-baseline gap-2">
              <span className="text-title font-semibold font-mono text-text-primary">
                {kpi.activeWip}
              </span>
              <span className="text-caption text-text-secondary">条未结束</span>
            </div>
            <div className="text-caption text-text-secondary font-mono flex items-center gap-2.5 flex-wrap">
              <span>进行中 {kpi.inProgressCount}</span>
              <span>·</span>
              <span>待办 {kpi.todoCount}</span>
              <span>·</span>
              <span>待确认 {kpi.proposedCount}</span>
            </div>
          </div>

          <div className="rounded-card border border-border bg-bg-card p-4 shadow-sm flex flex-col justify-between gap-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-label font-medium text-text-secondary">待你拍板与验收</span>
              {(kpi.awaitingReviewCount > 0 || kpi.overdueCount > 0) && (
                <span className="px-2 py-0.5 rounded-full bg-warning/10 text-warning text-caption font-medium">
                  关注关口
                </span>
              )}
            </div>
            <div className="flex items-baseline gap-2">
              <span className="text-title font-semibold font-mono text-text-primary">
                {kpi.awaitingReviewCount + kpi.proposedCount}
              </span>
              <span className="text-caption text-text-secondary">条等待决策</span>
            </div>
            <div className="text-caption text-text-secondary font-mono flex items-center gap-2.5 flex-wrap">
              <span className={cn(kpi.awaitingReviewCount > 0 && 'text-warning font-semibold')}>
                待验收 {kpi.awaitingReviewCount}
              </span>
              <span>·</span>
              <span>待确认 {kpi.proposedCount}</span>
              {kpi.overdueCount > 0 && (
                <>
                  <span>·</span>
                  <span className="text-danger font-semibold">已逾期 {kpi.overdueCount}</span>
                </>
              )}
            </div>
          </div>

          <div className="rounded-card border border-border bg-bg-card p-4 shadow-sm flex flex-col justify-between gap-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-label font-medium text-text-secondary">中位交付周期</span>
              <span className="px-2 py-0.5 rounded-full bg-surface-subtle text-caption font-mono text-text-secondary">
                P50
              </span>
            </div>
            <div className="flex items-baseline gap-2">
              <span className="text-title font-semibold font-mono text-text-primary">
                {kpi.cycleLabel}
              </span>
            </div>
            <div className="text-caption text-text-secondary">
              {kpi.cycleSamples > 0
                ? `基于周期内 ${kpi.cycleSamples} 条已完成事项计算`
                : '该时间范围内暂无完成样本'}
            </div>
          </div>
        </section>

        {/* ── 第二层：每日新建 vs 完成趋势 + 当前存量状态结构 ── */}
        <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Panel
            title="新建与完成趋势"
            hint={days ? `近 ${days} 天（峰值 ${curveMax}/天）` : `近 30 天（峰值 ${curveMax}/天）`}
          >
            <div className="flex items-end gap-1 h-28 pt-2">
              {curve.map((d, i) => (
                <div
                  key={i}
                  className="flex-1 flex items-end gap-px min-w-0 h-full group"
                  title={`${d.day}：新建 ${d.created} 条 · 完成 ${d.done} 条`}
                >
                  <span
                    className="flex-1 rounded-t-xs bg-text-done/50 group-hover:bg-text-done transition-colors"
                    style={{ height: `${d.created > 0 ? Math.max(8, (d.created / curveMax) * 100) : 3}%` }}
                  />
                  <span
                    className="flex-1 rounded-t-xs bg-success group-hover:opacity-90 transition-opacity"
                    style={{ height: `${d.done > 0 ? Math.max(8, (d.done / curveMax) * 100) : 3}%` }}
                  />
                </div>
              ))}
            </div>
            <div className="flex items-center justify-between text-caption font-mono text-text-secondary pt-1 border-t border-border/50">
              <span>{firstDay}</span>
              <span>{midDay}</span>
              <span>{lastDay}</span>
            </div>
            <div className="flex items-center gap-4 text-caption text-text-secondary">
              <span className="inline-flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-xs bg-text-done/50" /> 新建事项（{kpi.periodCreated}）
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-xs bg-success" /> 完成收口（{kpi.periodDone}）
              </span>
            </div>
          </Panel>

          <Panel title="存量状态结构分布" hint={`有效事项共 ${kpi.actionableTotal} 条（不含已废弃）`}>
            {/* 分段水平比例条 */}
            <div className="h-3 w-full rounded-full bg-surface-muted overflow-hidden flex gap-0.5 p-0.5">
              {BREAKDOWN_STATUSES.map((status) => {
                const count =
                  status === 'proposed'
                    ? kpi.proposedCount
                    : status === 'todo'
                      ? kpi.todoCount
                      : status === 'in_progress'
                        ? kpi.inProgressCount
                        : status === 'awaiting_review'
                          ? kpi.awaitingReviewCount
                          : status === 'suspended'
                            ? kpi.suspendedCount
                            : kpi.doneCount
                if (count === 0 || kpi.actionableTotal === 0) return null
                const pct = Math.max(2, (count / kpi.actionableTotal) * 100)
                return (
                  <div
                    key={status}
                    title={`${STATUS_META[status].label}：${count} 条`}
                    className="h-full first:rounded-l-full last:rounded-r-full transition-all"
                    style={{
                      width: `${pct}%`,
                      backgroundColor: `var(${STATUS_META[status].colorVar})`
                    }}
                  />
                )
              })}
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 pt-1.5">
              {BREAKDOWN_STATUSES.map((status) => {
                const count =
                  status === 'proposed'
                    ? kpi.proposedCount
                    : status === 'todo'
                      ? kpi.todoCount
                      : status === 'in_progress'
                        ? kpi.inProgressCount
                        : status === 'awaiting_review'
                          ? kpi.awaitingReviewCount
                          : status === 'suspended'
                            ? kpi.suspendedCount
                            : kpi.doneCount
                const pct =
                  kpi.actionableTotal > 0 ? Math.round((count / kpi.actionableTotal) * 100) : 0
                return (
                  <div
                    key={status}
                    className="rounded-button border border-border/60 bg-surface-subtle px-2.5 py-1.5 flex items-center justify-between gap-2 text-caption"
                  >
                    <span className="inline-flex items-center gap-1.5 text-text-secondary truncate">
                      <span
                        className="w-2 h-2 rounded-full shrink-0"
                        style={{ backgroundColor: `var(${STATUS_META[status].colorVar})` }}
                      />
                      <span className="truncate">{STATUS_META[status].label}</span>
                    </span>
                    <span className="font-mono text-text-primary font-semibold shrink-0">
                      {count}{' '}
                      <span className="text-text-secondary font-normal opacity-75">({pct}%)</span>
                    </span>
                  </div>
                )
              })}
            </div>
          </Panel>
        </section>

        {/* ── 第三层：执行人交付与负载分布 & 项目进展对比 ── */}
        <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Panel title="执行人交付与当前负载" hint="按实际执行人统计（已完成 / 待验收 / 进行中）">
            {executorRows.length === 0 && <EmptyRow text="该范围内尚无执行人活动数据" />}
            {executorRows.map((r) => (
              <div key={r.actor} className="flex flex-col gap-1 py-1">
                <div className="flex items-center justify-between gap-2 text-label">
                  <span className="font-medium text-text-primary truncate">
                    {ownerLabel(r.actor, settings?.humanName)}
                  </span>
                  <div className="flex items-center gap-2.5 font-mono text-caption shrink-0">
                    <span className="text-success">完成 {r.doneInPeriod}</span>
                    {r.awaitingReview > 0 && (
                      <span className="text-warning">待验收 {r.awaitingReview}</span>
                    )}
                    {r.inProgressOrTodo > 0 && (
                      <span className="text-text-secondary">在制 {r.inProgressOrTodo}</span>
                    )}
                  </div>
                </div>
                <div className="h-2 w-full rounded-full bg-surface-muted overflow-hidden flex gap-px">
                  {r.doneInPeriod > 0 && (
                    <div
                      className="h-full bg-success"
                      style={{ width: `${(r.doneInPeriod / executorMax) * 100}%` }}
                      title={`已完成：${r.doneInPeriod}`}
                    />
                  )}
                  {r.awaitingReview > 0 && (
                    <div
                      className="h-full bg-warning"
                      style={{ width: `${(r.awaitingReview / executorMax) * 100}%` }}
                      title={`待验收：${r.awaitingReview}`}
                    />
                  )}
                  {r.inProgressOrTodo > 0 && (
                    <div
                      className="h-full bg-accent"
                      style={{ width: `${(r.inProgressOrTodo / executorMax) * 100}%` }}
                      title={`在制与排期：${r.inProgressOrTodo}`}
                    />
                  )}
                </div>
              </div>
            ))}
          </Panel>

          <Panel title="项目进展与完成率" hint="未完成事项 vs 累计已完成">
            {projectRows.length === 0 && <EmptyRow text="还没有项目数据" />}
            {projectRows.map((r) => (
              <div key={r.id} className="flex flex-col gap-1 py-1">
                <div className="flex items-center justify-between gap-2 text-label">
                  <span className="inline-flex items-center gap-1.5 font-medium text-text-primary truncate">
                    <span
                      className="w-2.5 h-2.5 rounded-full shrink-0"
                      style={{ backgroundColor: r.color }}
                    />
                    <span className="truncate">{r.name}</span>
                  </span>
                  <div className="flex items-center gap-2.5 font-mono text-caption text-text-secondary shrink-0">
                    <span>未完成 {r.active}</span>
                    <span>·</span>
                    <span>已完成 {r.done}</span>
                    <span className="text-text-primary font-semibold">{r.rate}%</span>
                  </div>
                </div>
                <div className="h-2 w-full rounded-full bg-surface-muted overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all"
                    style={{
                      width: `${Math.max(4, r.rate)}%`,
                      backgroundColor: r.color
                    }}
                  />
                </div>
              </div>
            ))}
          </Panel>
        </section>

        {/* ── 第四层：默认折叠的本地运行与 CLI 诊断数据 ── */}
        <details className="rounded-card border border-border bg-bg-card p-4 shadow-sm">
          <summary className="cursor-pointer flex items-center justify-between gap-2 text-content font-semibold text-text-primary">
            <span>系统运行与 CLI 诊断数据（事件总数：{data?.total ?? 0}）</span>
            <span className="text-caption font-normal text-text-secondary">
              点击展开查看进程实例、CLI 耗时与调用分布
            </span>
          </summary>

          <div className="mt-3.5 pt-3 border-t border-border/60 flex flex-col gap-3">
            {loading && !data && <EmptyRow text="读取中…" />}
            {data && data.total === 0 && <EmptyRow text="该时间范围内还没有记录" />}

            {data && data.total > 0 && (
              <>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <StatCard label="事件总数" value={data.total} />
                  <StatCard label="进程实例数" value={data.sessions} hint="含每次 CLI 调用" />
                  <StatCard
                    label="失败"
                    value={data.failed}
                    hint={data.failed > 0 ? '可用于排查' : '无'}
                  />
                  <StatCard
                    label="CLI 调用耗时"
                    value={data.durationMs ? `${data.durationMs.p50}ms` : '—'}
                    hint={data.durationMs ? `P95 ${data.durationMs.p95}ms` : '本轮无调用'}
                  />
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  <Panel title="使用入口分布">
                    {surfaceRows.map((r) => (
                      <BarRow
                        key={r.label}
                        label={r.label}
                        value={r.value}
                        max={Math.max(1, ...surfaceRows.map((x) => x.value))}
                      />
                    ))}
                  </Panel>
                  <Panel title="操作类型分布">
                    {categoryRows.map((r) => (
                      <BarRow
                        key={r.label}
                        label={r.label}
                        value={r.value}
                        max={Math.max(1, ...categoryRows.map((x) => x.value))}
                        color="var(--color-success)"
                      />
                    ))}
                  </Panel>
                </div>

                <Panel title="高频事件 Top 10">
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-6 gap-y-2">
                    {eventRows.map((r) => (
                      <BarRow
                        key={r.label}
                        label={r.label}
                        value={r.value}
                        max={Math.max(1, ...eventRows.map((x) => x.value))}
                        color="var(--color-text-secondary)"
                      />
                    ))}
                  </div>
                </Panel>
              </>
            )}
          </div>
        </details>
      </div>
    </div>
  )
}

function toRows(rec: Record<string, number> | undefined, labelMap?: Record<string, string>) {
  if (!rec) return []
  return Object.entries(rec)
    .map(([k, v]) => ({ label: labelMap?.[k] ?? k, value: v }))
    .sort((a, b) => b.value - a.value)
}

const EmptyRow: React.FC<{ text: string }> = ({ text }) => (
  <div className="text-label text-text-secondary py-4 text-center">{text}</div>
)

const StatCard: React.FC<{ label: string; value: React.ReactNode; hint?: string }> = ({
  label,
  value,
  hint
}) => (
  <div className="rounded-card border border-border bg-surface-subtle px-4 py-3">
    <div className="text-label text-text-secondary">{label}</div>
    <div className="text-xl font-semibold text-text-primary font-mono mt-0.5">{value}</div>
    {hint && <div className="text-caption text-text-secondary/70 mt-0.5">{hint}</div>}
  </div>
)

const Panel: React.FC<{ title: string; hint?: string; children: React.ReactNode }> = ({
  title,
  hint,
  children
}) => (
  <div className="rounded-card border border-border bg-bg-card p-4 shadow-sm flex flex-col gap-2.5">
    <div className="text-content font-semibold text-text-primary flex items-center justify-between gap-2 pb-1.5 border-b border-border/50">
      <span>{title}</span>
      {hint && <span className="text-caption text-text-secondary font-normal">{hint}</span>}
    </div>
    <div className="flex flex-col gap-2">{children}</div>
  </div>
)

const BarRow: React.FC<{ label: string; value: number; max: number; color?: string }> = ({
  label,
  value,
  max,
  color
}) => (
  <div className="flex items-center gap-3 text-label">
    <span className="w-28 shrink-0 text-text-secondary truncate" title={label}>
      {label}
    </span>
    <div className="flex-1 h-2 rounded-full bg-surface-muted overflow-hidden">
      <div
        className="h-full rounded-full"
        style={{ width: `${(value / max) * 100}%`, background: color ?? 'var(--color-accent)' }}
      />
    </div>
    <span className="w-10 text-right text-text-secondary font-mono">{value}</span>
  </div>
)
