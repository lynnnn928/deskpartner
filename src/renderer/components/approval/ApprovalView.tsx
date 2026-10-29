import React, { useCallback, useEffect, useState } from 'react'
import { Button } from '../ui/Button'
import { Icon, type IconName } from '../ui/Icon'
import { Pagination } from '../ui/PagePrimitives'
import { StatusBadge } from '../ui/Badge'
import { EmptyState } from '../ui/EmptyState'
import { invoke } from '../../lib/ipc-client'
import { isForceConfirmableGrant, isPendingAgent, isPendingGrant } from '../../lib/grant-state'
import { APPROVAL_ACTION, allowLabel, forceConfirmLabel, grantBadgeLabel } from '../../lib/approval-copy'
import { useUIStore } from '../../stores/ui.store'
import { useSettingsStore } from '../../stores/settings.store'
import { useTodoStore } from '../../stores/todo.store'
import { useProjectStore } from '../../stores/project.store'
import { cn } from '../../lib/utils'
import type { Agent, AgentGrant, Todo } from '../../types/todo'
import type { HandoffProposal } from '../../types/project'

type AuditType = 'all' | 'agent' | 'grant' | 'profile' | 'protocol' | 'handoff' | 'rules'
type AuditDecision = 'all' | 'pending' | 'approved' | 'rejected' | 'expired' | 'revoked'
type AuditExecution = 'all' | 'success' | 'failure' | 'unknown' | 'not_required'
type DatePreset = 'all' | 'today' | '7d' | '30d' | 'custom'
type AuditProject = { id: string; name: string; archived?: boolean }
type ApprovalHistoryRow = {
  id: string; type: Exclude<AuditType, 'all'>; agentId: string; agentName: string; projectId: string | null
  createdAt: string; activityAt: string; decision: Exclude<AuditDecision, 'all'>; decidedBy: string | null; decidedAt: string | null
  scope: string | null; summary: string; originalBody: string | null; proposedBody: string | null; decidedBody: string | null
  execution: Exclude<AuditExecution, 'all'>; execError: string | null; execSummary: string | null; requestArgv: string[]
}
type ProfileProposal = {
  id: string
  scope: 'global' | 'project'
  projectId: string | null
  blockKey: string
  body: string
  originalBody: string | null
  baseUpdatedAt: string | null
  decidedBody: string | null
  currentBody?: string | null
  currentUpdatedAt?: string | null
  stale?: boolean
  proposer: string
  status: 'pending' | 'approved' | 'rejected'
  createdAt: string
}

const PROFILE_LABELS: Record<string, string> = {
  basics: '基本情况',
  habits: '工作习惯',
  boundaries: '授权边界',
  completion: '完成标准'
}

const PROTOCOL_LABELS: Record<string, string> = {
  roles: '角色分工',
  handoff: '工作交接',
  recording: '记录与留痕',
  communication: '沟通和确认',
  language: '语言约定'
}

const TODO_STATUS_LABELS: Record<string, string> = {
  proposed: '待确认',
  todo: '待办',
  in_progress: '进行中',
  awaiting_review: '待验收',
  done: '已完成',
  suspended: '已挂起',
  discarded: '已废弃'
}

const TODO_PRIORITY_LABELS: Record<string, string> = {
  urgent: '紧急',
  high: '高',
  normal: '普通',
  low: '低'
}

const UI_KEY_LABELS: Record<string, string> = {
  theme: '主题配色',
  stylePreset: '视觉风格',
  fontSizeScale: '全局字号',
  floatBallSize: '悬浮球尺寸',
  floatBallOpacity: '悬浮球透明度',
  floatBallColor: '悬浮球颜色',
  floatBallEdgeHide: '贴边隐藏',
  kanbanAlwaysOnTop: '看板置顶'
}

const UI_VALUE_LABELS: Record<string, string> = {
  light: '浅色',
  dark: '深色',
  frosted: '磨砂',
  japanese: '和风',
  null: '默认',
  true: '开启',
  false: '关闭'
}

type RuleProposal = {
  id: string
  scope: 'global' | 'project'
  projectId: string | null
  category: string
  ruleKey: string
  proposedEnforcement: string
  originalEnforcement: string
  proposer: string
  status: 'pending' | 'approved' | 'rejected'
  createdAt: string
}

const RULE_LABELS: Record<string, string> = {
  G1: '候选事项需要先确认',
  G2: '子事项完成后才能收口',
  'G4-status': '待确认事项的状态变更',
  'G4-delete': '删除事项需要授权',
  G6: '交付需要留下收口记录',
  G10: '执行者不能自行验收',
  G3: '描述需要符合协作约定',
  G5: '验收结论需要写清楚',
  G7: '事项内容需要符合规范',
  G8: '接入说明版本需要保持同步',
  G9: '协作规范提醒'
}

const ENFORCEMENT_LABELS: Record<string, string> = {
  block: '拦截',
  authorize: '需审批',
  notice: '仅提醒',
  off: '关闭'
}

const BOILERPLATE_RECEIPTS = new Set([
  '已按你的允许执行完毕',
  '已执行',
  '已允许（该档授权不需要代为执行）'
])

function toDateInputValue(d: Date): string {
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

const AUDIT_TYPE_LABELS: Record<Exclude<AuditType, 'all'>, string> = {
  agent: 'Agent 接入',
  grant: '操作授权',
  profile: '档案修改',
  protocol: '协议修改',
  handoff: '项目接手说明',
  rules: '协作规则'
}

const AUDIT_DECISION_LABELS: Record<Exclude<AuditDecision, 'all'>, string> = {
  pending: '待处理',
  approved: '已批准',
  rejected: '已拒绝',
  expired: '已过期',
  revoked: '已撤回'
}

const AUDIT_EXECUTION_LABELS: Record<Exclude<AuditExecution, 'all'>, string> = {
  success: '已执行',
  failure: '执行失败',
  unknown: '结果未知',
  not_required: '无需执行'
}

const DATE_PRESET_LABELS: Record<Exclude<DatePreset, 'all'>, string> = {
  today: '今天',
  '7d': '近 7 天',
  '30d': '近 30 天',
  custom: '自定义'
}

type FilterOption = { value: string; label: string }

/**
 * 表头即筛选（Table Header as Filter）：
 * 采用自定义浮层菜单（Popover Listbox）替代 Windows 原生 <select>，
 * 每一列表头本身承担该列维度的下拉筛选，选中后直接在表头回显当前条件。
 */
const HeaderColumnFilter: React.FC<{
  label: string
  ariaLabel: string
  value: string
  options: FilterOption[]
  activeLabel?: string | null
  onChange: (nextValue: string) => void
  align?: 'left' | 'right'
  wrapperClassName?: string
}> = ({
  label,
  ariaLabel,
  value,
  options,
  activeLabel,
  onChange,
  align = 'left',
  wrapperClassName
}) => {
  const [open, setOpen] = useState(false)
  const containerRef = React.useRef<HTMLDivElement>(null)
  const isActive = Boolean(activeLabel)

  useEffect(() => {
    if (!open) return
    const handleMouseDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
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
    <div
      ref={containerRef}
      role="columnheader"
      className={cn(
        'relative flex items-center min-w-0',
        align === 'right' && 'justify-end',
        wrapperClassName
      )}
    >
      <button
        type="button"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={() => setOpen((prev) => !prev)}
        title={activeLabel ? `${label}：${activeLabel}（点击切换筛选）` : `点击按「${label}」筛选`}
        className={cn(
          'inline-flex items-center gap-1 rounded-xs px-1.5 py-0.5 -mx-1.5 transition-colors max-w-full cursor-pointer',
          isActive || open
            ? 'bg-accent/10 text-accent font-semibold'
            : 'text-text-secondary hover:text-text-primary hover:bg-surface-muted font-medium'
        )}
      >
        <span className="shrink-0">{label}</span>
        {activeLabel && (
          <span className="truncate text-accent font-semibold">· {activeLabel}</span>
        )}
        <Icon
          name="chevronLeft"
          size={10}
          className={cn(
            'shrink-0 transition-transform',
            open ? 'rotate-90 text-accent' : '-rotate-90',
            isActive ? 'text-accent' : 'text-text-secondary/70'
          )}
        />
      </button>

      {open && (
        <div
          role="listbox"
          aria-label={`${label}筛选项`}
          className={cn(
            'absolute top-full mt-1.5 z-50 min-w-36 max-h-64 overflow-y-auto rounded-card border border-border bg-bg-card p-1 shadow-float',
            align === 'right' ? 'right-0' : 'left-0'
          )}
        >
          {options.map((opt) => {
            const selected = opt.value === value
            return (
              <button
                key={opt.value || '__all__'}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => {
                  onChange(opt.value)
                  setOpen(false)
                }}
                className={cn(
                  'w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-button text-label text-left transition-colors whitespace-nowrap',
                  selected
                    ? 'bg-accent/10 text-accent font-semibold'
                    : 'text-text-primary hover:bg-surface-subtle font-normal'
                )}
              >
                <span className="truncate">{opt.label}</span>
                {selected && (
                  <span className="w-1.5 h-1.5 rounded-full bg-accent shrink-0" />
                )}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

export const ApprovalView: React.FC = () => {
  const { settings } = useSettingsStore()
  const { todos } = useTodoStore()
  const { projects } = useProjectStore()
  const [agents, setAgents] = useState<Agent[]>([])
  const [grants, setGrants] = useState<AgentGrant[]>([])
  const [history, setHistory] = useState<{ rows: ApprovalHistoryRow[]; total: number; offset: number; limit: number }>({ rows: [], total: 0, offset: 0, limit: 20 })
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{
    ok: boolean
    text: string
    grantId?: string
    canForce?: boolean
  } | null>(null)
  const [profileProposals, setProfileProposals] = useState<ProfileProposal[]>([])
  const [protocolProposals, setProtocolProposals] = useState<ProfileProposal[]>([])
  const [handoffProposals, setHandoffProposals] = useState<HandoffProposal[]>([])
  const [ruleProposals, setRuleProposals] = useState<RuleProposal[]>([])
  const [auditProjects, setAuditProjects] = useState<AuditProject[]>([])
  const [auditProject, setAuditProject] = useState('')
  const [proposalDrafts, setProposalDrafts] = useState<Record<string, string>>({})
  const [pendingCategory, setPendingCategory] = useState<'all' | 'agent' | 'grant' | 'profile' | 'protocol' | 'handoff' | 'rules'>('all')
  const [expandedPendingId, setExpandedPendingId] = useState<string | null>(null)
  const [auditType, setAuditType] = useState<AuditType>('all')
  const [auditDecision, setAuditDecision] = useState<AuditDecision>('all')
  const [auditExecution, setAuditExecution] = useState<AuditExecution>('all')
  const [auditPage, setAuditPage] = useState(1)
  const [expandedAuditId, setExpandedAuditId] = useState<string | null>(null)
  const [auditQuery, setAuditQuery] = useState('')
  const [auditAgent, setAuditAgent] = useState('')
  const [knownHistoryActors, setKnownHistoryActors] = useState<Array<{ id: string; name: string }>>([])
  const [datePreset, setDatePreset] = useState<DatePreset>('all')
  const [auditFrom, setAuditFrom] = useState('')
  const [auditUntil, setAuditUntil] = useState('')

  const refresh = useCallback(async () => {
    try {
      const [list, gs, profileProposalList, protocolProposalList, handoffProposalList, ruleProposalList, projectList, page] = await Promise.all([
        invoke('agent:list'),
        invoke('agent:listGrants', { activeOnly: true, limit: 0 }),
        invoke('profile:proposals'),
        invoke('protocol:proposals'),
        invoke('project:handoffProposals'),
        invoke('rules:proposals'),
        invoke('project:list'),
        invoke('approval:listHistory', {
          offset: (auditPage - 1) * 20,
          limit: 20,
          type: auditType === 'all' ? undefined : auditType,
          decision: auditDecision === 'all' ? undefined : auditDecision,
          execution: auditExecution === 'all' ? undefined : auditExecution,
          query: auditQuery || undefined,
          agentQuery: auditAgent || undefined,
          projectId: auditProject || undefined,
          from: auditFrom || undefined,
          until: auditUntil ? `${auditUntil}T23:59:59.999Z` : undefined
        })
      ])
      const sameIfEqual = <T,>(prev: T[], next: T[]): T[] =>
        JSON.stringify(prev) === JSON.stringify(next) ? prev : next
      setAgents((prev) => sameIfEqual(prev, list))
      setGrants((prev) => sameIfEqual(prev, gs))
      setProfileProposals((prev) => sameIfEqual(prev, profileProposalList as ProfileProposal[]))
      setProtocolProposals((prev) => sameIfEqual(prev, protocolProposalList as ProfileProposal[]))
      setHandoffProposals((prev) => sameIfEqual(prev, handoffProposalList as HandoffProposal[]))
      setRuleProposals((prev) => sameIfEqual(prev, ruleProposalList as RuleProposal[]))
      setAuditProjects((projectList as AuditProject[]).filter((project) => !project.archived))
      setHistory(page)
      setKnownHistoryActors((prev) => {
        const map = new Map(prev.map((item) => [item.id, item.name]))
        for (const row of page.rows ?? []) {
          if (row.agentId && !map.has(row.agentId)) {
            map.set(row.agentId, row.agentName || row.agentId)
          }
        }
        const next = Array.from(map.entries()).map(([id, name]) => ({ id, name }))
        return sameIfEqual(prev, next)
      })
      setHistoryError(null)
    } catch (e) {
      setError((e as Error).message)
      setHistoryError((e as Error).message)
    }
  }, [auditPage, auditType, auditDecision, auditExecution, auditQuery, auditAgent, auditProject, auditFrom, auditUntil])

  const historyRows = history.rows
  const historyPageCount = Math.max(1, Math.ceil(history.total / history.limit))
  const resetAuditFilters = (update: () => void) => {
    update()
    setAuditPage(1)
  }

  const handleDatePresetChange = (preset: DatePreset) => {
    setDatePreset(preset)
    setAuditPage(1)
    const now = new Date()
    if (preset === 'all') {
      setAuditFrom('')
      setAuditUntil('')
    } else if (preset === 'today') {
      const today = toDateInputValue(now)
      setAuditFrom(today)
      setAuditUntil(today)
    } else if (preset === '7d') {
      const start = new Date(now)
      start.setDate(start.getDate() - 6)
      setAuditFrom(toDateInputValue(start))
      setAuditUntil('')
    } else if (preset === '30d') {
      const start = new Date(now)
      start.setDate(start.getDate() - 29)
      setAuditFrom(toDateInputValue(start))
      setAuditUntil('')
    }
  }

  const hasActiveFilter =
    auditType !== 'all' ||
    auditDecision !== 'all' ||
    auditExecution !== 'all' ||
    auditProject !== '' ||
    auditQuery.trim() !== '' ||
    auditAgent.trim() !== '' ||
    datePreset !== 'all' ||
    auditFrom !== '' ||
    auditUntil !== ''

  const clearAllFilters = () => {
    setAuditType('all')
    setAuditDecision('all')
    setAuditExecution('all')
    setAuditProject('')
    setAuditQuery('')
    setAuditAgent('')
    setDatePreset('all')
    setAuditFrom('')
    setAuditUntil('')
    setAuditPage(1)
  }

  const humanDisplayName = settings.humanName?.trim() || '我'
  const nameOf = (id: string, fallbackName?: string) => {
    if (id === 'human' || id === 'user:human') return humanDisplayName
    const found = agents.find((a) => a.id === id)
    if (found?.displayName) return found.displayName
    if (fallbackName && fallbackName !== id && !fallbackName.startsWith('agent:')) return fallbackName
    return id.replace(/^agent:/, '')
  }

  /** 从授权申请的目标 ID 或参数里匹配看板事项，供待审批卡片展示事项详情 */
  const findGrantTargetTodo = (g: AgentGrant): Todo | null => {
    const candidates = [
      ...(g.targetIds ?? []),
      ...g.requestArgv.filter((arg) => /^[0-9a-f]{6,36}(-[0-9a-f-]+)?$/i.test(arg))
    ]
    for (const token of candidates) {
      const matched = todos.find((t) => t.id === token || t.id.startsWith(token))
      if (matched) return matched
    }
    return null
  }

  const pendingGrants = grants.filter((g) => isPendingGrant(g) || isForceConfirmableGrant(g))
  const pendingAgents = agents.filter(isPendingAgent)
  const pendingProfileProposals = profileProposals.filter((proposal) => proposal.status === 'pending')
  const pendingProtocolProposals = protocolProposals.filter((proposal) => proposal.status === 'pending')
  const pendingHandoffProposals = handoffProposals.filter((proposal) => proposal.status === 'pending')
  const pendingRuleProposals = ruleProposals.filter((proposal) => proposal.status === 'pending')
  const pendingTotal = pendingGrants.length + pendingAgents.length + pendingProfileProposals.length + pendingProtocolProposals.length + pendingHandoffProposals.length + pendingRuleProposals.length
  const pendingCounts = { all: pendingTotal, agent: pendingAgents.length, grant: pendingGrants.length, profile: pendingProfileProposals.length, protocol: pendingProtocolProposals.length, handoff: pendingHandoffProposals.length, rules: pendingRuleProposals.length }
  const visiblePendingTotal = pendingCounts[pendingCategory]

  const decideProposal = async (kind: 'profile' | 'protocol', id: string, decision: 'approved' | 'rejected', body?: string) => {
    setBusy(`${kind}:${id}`)
    setError(null)
    try {
      await invoke(kind === 'profile' ? 'profile:decide' : 'protocol:decide', { id, decision, body })
      await refresh()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }
  const decideHandoffProposal = async (id: string, decision: 'approved' | 'rejected', body?: string) => {
    setBusy(`handoff:${id}`)
    setError(null)
    try {
      await invoke('project:handoffDecide', { id, decision, body })
      await refresh()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }
  const decideRuleProposal = async (id: string, decision: 'approved' | 'rejected') => {
    setBusy(`rules:${id}`)
    setError(null)
    try {
      await invoke('rules:decide', { id, decision })
      await refresh()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }
  const resolveGrant = async (
    grantId: string,
    allow: boolean,
    longTerm = false,
    withForce = false
  ) => {
    setBusy(grantId)
    setError(null)
    setResult(null)
    try {
      const r = await invoke('agent:resolveGrant', { grantId, allow, longTerm, withForce })
      await refresh()
      if (allow && r?.execution) {
        setResult(
          r.execution.ok
            ? { ok: true, text: r.execution.message }
            : {
                ok: false,
                text: r.execution.message,
                grantId,
                canForce: r.execution.canForce === true
              }
        )
      } else if (allow) {
        setResult({ ok: true, text: '已批准' })
      } else {
        setResult({ ok: true, text: '已放弃该操作。' })
      }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }
  const setApproved = async (id: string) => {
    setBusy(id)
    setError(null)
    try { await invoke('agent:setApproved', { id, approved: true }); await refresh() } catch (e) { setError((e as Error).message) } finally { setBusy(null) }
  }
  const setRejected = async (id: string, rejected: boolean) => {
    setBusy(id)
    setError(null)
    try { await invoke('agent:setRejected', { id, rejected }); await refresh() } catch (e) { setError((e as Error).message) } finally { setBusy(null) }
  }

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => void refresh(), 5000)
    return () => window.clearInterval(timer)
  }, [refresh])

  const { focusGrantId, setFocusGrantId } = useUIStore()
  useEffect(() => {
    if (!focusGrantId) return
    const el = document.getElementById(`grant-${focusGrantId}`)
    el?.scrollIntoView({ block: 'center' })
    const timer = window.setTimeout(() => setFocusGrantId(null), 200)
    return () => window.clearTimeout(timer)
  }, [focusGrantId, setFocusGrantId])

  const showPendingPanel = pendingTotal > 0 || Boolean(result) || Boolean(error)

  return (
    <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5">
      <div className="max-w-page mx-auto flex flex-col gap-5">
        {/* ── 一、待审批队列：支持点击查看申请详情与关联事项 ── */}
        {showPendingPanel && (
          <section aria-label="待审批" className="flex flex-col gap-3 pb-3 border-b border-border/60">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <h2 className="text-column-title font-semibold tracking-title text-text-primary">待审批</h2>
                {pendingTotal > 0 && (
                  <StatusBadge tone="warning">{pendingTotal} 条待处理</StatusBadge>
                )}
              </div>
              {pendingTotal > 0 && (
                <div className="flex flex-wrap items-center gap-1" aria-label="待审批申请分类">
                  {(['all', 'agent', 'grant', 'profile', 'protocol', 'handoff', 'rules'] as const).map((category) => {
                    const count = pendingCounts[category]
                    const label = ({ all: '全部', agent: 'Agent 接入', grant: '操作授权', profile: '档案修改', protocol: '协议修改', handoff: '项目接手说明', rules: '协作规则' } as const)[category]
                    if (category !== 'all' && count === 0 && pendingCategory !== category) return null
                    return (
                      <Button
                        key={category}
                        size="sm"
                        variant={pendingCategory === category ? 'primary' : 'ghost'}
                        onClick={() => setPendingCategory(category)}
                      >
                        {label}{count > 0 ? ` · ${count}` : ''}
                      </Button>
                    )
                  })}
                </div>
              )}
            </div>

            {pendingTotal > 0 && visiblePendingTotal === 0 ? (
              <p className="text-label text-text-secondary">该分类下暂无待审批项</p>
            ) : pendingTotal > 0 ? (
              <div className="flex flex-col gap-2">
                {(pendingCategory === 'all' || pendingCategory === 'agent') && pendingAgents.map((a) => (
                  <div
                    key={a.id}
                    className="rounded-card border border-border bg-bg-card px-4 py-3 flex items-center justify-between gap-4 shadow-sm"
                  >
                    <div className="min-w-0 grid gap-1">
                      <div className="flex items-center gap-2 min-w-0">
                        <StatusBadge tone="accent">Agent 接入</StatusBadge>
                        <span className="text-content font-medium text-text-primary truncate">{a.displayName} 申请接入</span>
                      </div>
                      <div className="text-label text-text-secondary truncate">
                        标识：{a.id} · 批准后可读写事项与项目
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy === a.id}
                        onClick={() => void setRejected(a.id, true)}
                      >
                        {APPROVAL_ACTION.reject}
                      </Button>
                      <Button
                        variant="primary"
                        size="sm"
                        disabled={busy === a.id}
                        onClick={() => void setApproved(a.id)}
                      >
                        批准
                      </Button>
                    </div>
                  </div>
                ))}

                {(pendingCategory === 'all' || pendingCategory === 'profile') && profileProposals.map((proposal) => (
                  <div key={proposal.id} className="rounded-card border border-border bg-bg-card px-4 py-3 grid gap-2.5 shadow-sm">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <StatusBadge tone="warning">档案修改</StatusBadge>
                        <span className="text-content font-medium text-text-primary">{PROFILE_LABELS[proposal.blockKey] ?? proposal.blockKey}</span>
                      </div>
                      <span className="text-label text-text-secondary">{nameOf(proposal.proposer)} · {fmtTime(proposal.createdAt)}</span>
                    </div>
                    <div className="text-label text-text-secondary">{proposal.scope === 'project' ? `项目范围 · ${proposal.projectId ?? '未知项目'}` : '全局范围'}</div>
                    <div className={cn('grid gap-2.5 items-stretch', proposal.stale ? 'sm:grid-cols-3' : 'sm:grid-cols-2')}>
                      {proposal.stale && (
                        <div className="flex flex-col"><div className="text-label font-medium text-text-secondary mb-1">提议基准内容（已过期）</div><div className="flex-1 rounded-input bg-bg-primary border border-border p-2.5 text-label text-text-primary whitespace-pre-wrap min-h-36 max-h-80 overflow-y-auto">{proposal.originalBody ?? '（无历史原文）'}</div></div>
                      )}
                      <div className="flex flex-col"><div className="text-label font-medium text-text-secondary mb-1">当前生效内容</div><div className="flex-1 rounded-input bg-bg-primary border border-border p-2.5 text-label text-text-primary whitespace-pre-wrap min-h-36 max-h-80 overflow-y-auto">{(proposal.currentBody ?? proposal.originalBody) || '（当前为空）'}</div></div>
                      <div className="flex flex-col"><label className="text-label font-medium text-text-secondary mb-1 block">申请修改为（可编辑后采纳）</label><textarea className="flex-1 w-full min-h-36 max-h-80 resize-y rounded-input bg-bg-card border border-border p-2.5 text-label text-text-primary" value={proposalDrafts[proposal.id] ?? proposal.body} onChange={(event) => setProposalDrafts((drafts) => ({ ...drafts, [proposal.id]: event.target.value }))} /></div>
                    </div>
                    {proposal.stale && <p className="text-label text-danger" role="alert">当前内容已有更新，请让助手基于最新版本重新提交。</p>}
                    <div className="flex gap-2 justify-end">
                      <Button size="sm" disabled={busy === `profile:${proposal.id}`} onClick={() => void decideProposal('profile', proposal.id, 'rejected')}>拒绝</Button>
                      <Button variant="primary" size="sm" disabled={busy === `profile:${proposal.id}` || proposal.stale} onClick={() => void decideProposal('profile', proposal.id, 'approved', proposalDrafts[proposal.id] ?? proposal.body)}>采纳</Button>
                    </div>
                  </div>
                ))}

                {(pendingCategory === 'all' || pendingCategory === 'protocol') && protocolProposals.map((proposal) => (
                  <div key={proposal.id} className="rounded-card border border-border bg-bg-card px-4 py-3 grid gap-2.5 shadow-sm">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <StatusBadge tone="warning">协议修改</StatusBadge>
                        <span className="text-content font-medium text-text-primary">{PROTOCOL_LABELS[proposal.blockKey] ?? proposal.blockKey}</span>
                      </div>
                      <span className="text-label text-text-secondary">{nameOf(proposal.proposer)} · {fmtTime(proposal.createdAt)}</span>
                    </div>
                    <div className="text-label text-text-secondary">{proposal.scope === 'project' ? `项目范围 · ${proposal.projectId ?? '未知项目'}` : '全局范围'}</div>
                    <div className={cn('grid gap-2.5 items-stretch', proposal.stale ? 'sm:grid-cols-3' : 'sm:grid-cols-2')}>
                      {proposal.stale && (
                        <div className="flex flex-col"><div className="text-label font-medium text-text-secondary mb-1">提议基准内容（已过期）</div><div className="flex-1 rounded-input bg-bg-primary border border-border p-2.5 text-label text-text-primary whitespace-pre-wrap min-h-36 max-h-80 overflow-y-auto">{proposal.originalBody ?? '（无历史原文）'}</div></div>
                      )}
                      <div className="flex flex-col"><div className="text-label font-medium text-text-secondary mb-1">当前生效内容</div><div className="flex-1 rounded-input bg-bg-primary border border-border p-2.5 text-label text-text-primary whitespace-pre-wrap min-h-36 max-h-80 overflow-y-auto">{(proposal.currentBody ?? proposal.originalBody) || '（当前为空）'}</div></div>
                      <div className="flex flex-col"><label className="text-label font-medium text-text-secondary mb-1 block">申请修改为（可编辑后采纳）</label><textarea className="flex-1 w-full min-h-36 max-h-80 resize-y rounded-input bg-bg-card border border-border p-2.5 text-label text-text-primary" value={proposalDrafts[proposal.id] ?? proposal.body} onChange={(event) => setProposalDrafts((drafts) => ({ ...drafts, [proposal.id]: event.target.value }))} /></div>
                    </div>
                    {proposal.stale && <p className="text-label text-danger" role="alert">当前内容已有更新，请让助手基于最新版本重新提交。</p>}
                    <div className="flex gap-2 justify-end">
                      <Button size="sm" disabled={busy === `protocol:${proposal.id}`} onClick={() => void decideProposal('protocol', proposal.id, 'rejected')}>拒绝</Button>
                      <Button variant="primary" size="sm" disabled={busy === `protocol:${proposal.id}` || proposal.stale} onClick={() => void decideProposal('protocol', proposal.id, 'approved', proposalDrafts[proposal.id] ?? proposal.body)}>采纳</Button>
                    </div>
                  </div>
                ))}

                {(pendingCategory === 'all' || pendingCategory === 'handoff') && pendingHandoffProposals.map((proposal) => {
                  const projectName = auditProjects.find((project) => project.id === proposal.projectId)?.name ?? proposal.projectId
                  const busyKey = `handoff:${proposal.id}`
                  const snap = proposal.factsSnapshot ?? null
                  const cur = proposal.currentFacts ?? null
                  const sourceIds = proposal.sourceTodoIds ?? []
                  const factsDrifted = Boolean(
                    snap &&
                      cur &&
                      ((snap.version && cur.version && snap.version !== cur.version) ||
                        snap.schemaVersion !== cur.schemaVersion ||
                        (snap.mainTodo?.id ?? null) !== (cur.mainTodo?.id ?? null))
                  )
                  return (
                    <div key={proposal.id} className="rounded-card border border-border bg-bg-card px-4 py-3 grid gap-2.5 shadow-sm">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <StatusBadge tone="warning">接手说明</StatusBadge>
                          <span className="text-content font-medium text-text-primary">{projectName}</span>
                        </div>
                        <span className="text-label text-text-secondary">{nameOf(proposal.proposer)} · {fmtTime(proposal.createdAt)}</span>
                      </div>
                      <div className="text-label text-text-secondary">基于修订 #{proposal.baseRevision}</div>
                      {(snap || cur || sourceIds.length > 0) && (
                        <div data-testid="handoff-facts-compare" className="grid gap-2 sm:grid-cols-2">
                          <div className="rounded-input bg-bg-primary border border-border p-2.5 text-label grid gap-1">
                            <div className="font-medium text-text-secondary">提议依据的事实</div>
                            {snap ? (
                              <>
                                <div className="text-text-primary">
                                  版本：{snap.version ?? '未知'} · schema v{snap.schemaVersion}
                                </div>
                                <div className="text-text-primary">
                                  未完成：{snap.openTotal} 项（{TODO_STATUS_LABELS.in_progress} {snap.statusCounts.in_progress} · {TODO_STATUS_LABELS.awaiting_review} {snap.statusCounts.awaiting_review} · {TODO_STATUS_LABELS.todo} {snap.statusCounts.todo}）
                                </div>
                                <div className="text-text-primary truncate">
                                  主线：{snap.mainTodo ? `${snap.mainTodo.id.slice(0, 8)} ${snap.mainTodo.title}` : '无'}
                                </div>
                              </>
                            ) : (
                              <div className="text-text-secondary">（未记录提交时事实快照）</div>
                            )}
                            {sourceIds.length > 0 && (
                              <div className="text-text-secondary truncate">
                                来源事项：{sourceIds.map((tid) => {
                                  const hit = todos.find((t) => t.id === tid)
                                  return hit ? `${tid.slice(0, 8)} ${hit.title}` : tid.slice(0, 8)
                                }).join('、')}
                              </div>
                            )}
                          </div>
                          <div className="rounded-input bg-bg-primary border border-border p-2.5 text-label grid gap-1">
                            <div className="flex items-center justify-between gap-2">
                              <span className="font-medium text-text-secondary">当前事实</span>
                              {snap && cur && (
                                <span className={factsDrifted ? 'text-warning font-medium' : 'text-text-secondary'}>
                                  {factsDrifted ? '提议后事实有变化' : '与当前事实一致'}
                                </span>
                              )}
                            </div>
                            {cur ? (
                              <>
                                <div className="text-text-primary">
                                  版本：{cur.version ?? '未知'} · schema v{cur.schemaVersion}
                                </div>
                                <div className="text-text-primary">
                                  未完成：{cur.openTotal} 项（{TODO_STATUS_LABELS.in_progress} {cur.statusCounts.in_progress} · {TODO_STATUS_LABELS.awaiting_review} {cur.statusCounts.awaiting_review} · {TODO_STATUS_LABELS.todo} {cur.statusCounts.todo}）
                                </div>
                                <div className="text-text-primary truncate">
                                  主线：{cur.mainTodo ? `${cur.mainTodo.id.slice(0, 8)} ${cur.mainTodo.title}` : '无'}
                                </div>
                              </>
                            ) : (
                              <div className="text-text-secondary">（未读取到当前事实）</div>
                            )}
                          </div>
                        </div>
                      )}
                      <div className={cn('grid gap-2.5 items-stretch', proposal.stale ? 'sm:grid-cols-3' : 'sm:grid-cols-2')}>
                        {proposal.stale && (
                          <div className="flex flex-col"><div className="text-label font-medium text-text-secondary mb-1">提议基准内容（修订 #{proposal.baseRevision}，已过期）</div><div className="flex-1 rounded-input bg-bg-primary border border-border p-2.5 text-label text-text-primary whitespace-pre-wrap min-h-80 max-h-96 overflow-y-auto">{proposal.originalBody || '（空）'}</div></div>
                        )}
                        <div className="flex flex-col"><div className="text-label font-medium text-text-secondary mb-1">当前生效内容</div><div className="flex-1 rounded-input bg-bg-primary border border-border p-2.5 text-label text-text-primary whitespace-pre-wrap min-h-80 max-h-96 overflow-y-auto">{(proposal.currentBody ?? proposal.originalBody) || '（空）'}</div></div>
                        <div className="flex flex-col"><label className="text-label font-medium text-text-secondary mb-1 block">申请修改为（可编辑后采纳）</label><textarea className="flex-1 w-full min-h-80 max-h-96 resize-y rounded-input bg-bg-card border border-border p-2.5 text-label text-text-primary" value={proposalDrafts[proposal.id] ?? proposal.body} onChange={(event) => setProposalDrafts((drafts) => ({ ...drafts, [proposal.id]: event.target.value }))} /></div>
                      </div>
                      {proposal.stale && <p className="text-label text-danger" role="alert">当前内容已有更新，请让助手基于最新版本重新提交。</p>}
                      <div className="flex gap-2 justify-end">
                        <Button size="sm" disabled={busy === busyKey} onClick={() => void decideHandoffProposal(proposal.id, 'rejected')}>拒绝</Button>
                        <Button variant="primary" size="sm" disabled={busy === busyKey || proposal.stale} onClick={() => void decideHandoffProposal(proposal.id, 'approved', proposalDrafts[proposal.id] ?? proposal.body)}>采纳</Button>
                      </div>
                    </div>
                  )
                })}

                {(pendingCategory === 'all' || pendingCategory === 'rules') && pendingRuleProposals.map((proposal) => {
                  const busyKey = `rules:${proposal.id}`
                  const projectName = auditProjects.find((project) => project.id === proposal.projectId)?.name ?? proposal.projectId
                  return (
                    <div key={proposal.id} className="rounded-card border border-border bg-bg-card px-4 py-3 flex items-center justify-between gap-4 shadow-sm">
                      <div className="min-w-0 grid gap-1">
                        <div className="flex items-center gap-2">
                          <StatusBadge tone="warning">协作规则</StatusBadge>
                          <span className="text-content font-medium text-text-primary">{RULE_LABELS[proposal.ruleKey] ?? proposal.ruleKey}</span>
                        </div>
                        <div className="text-label text-text-secondary">
                          {proposal.scope === 'project' ? `项目 · ${projectName ?? '未知项目'}` : '全局'} · {nameOf(proposal.proposer)} · {fmtTime(proposal.createdAt)} · 强度：{ENFORCEMENT_LABELS[proposal.originalEnforcement] ?? proposal.originalEnforcement} → <strong className="text-text-primary">{ENFORCEMENT_LABELS[proposal.proposedEnforcement] ?? proposal.proposedEnforcement}</strong>
                        </div>
                      </div>
                      <div className="flex gap-1.5 shrink-0">
                        <Button size="sm" disabled={busy === busyKey} onClick={() => void decideRuleProposal(proposal.id, 'rejected')}>拒绝</Button>
                        <Button variant="primary" size="sm" disabled={busy === busyKey} onClick={() => void decideRuleProposal(proposal.id, 'approved')}>采纳</Button>
                      </div>
                    </div>
                  )
                })}

                {(pendingCategory === 'all' || pendingCategory === 'grant') && pendingGrants.map((g) => {
                  const title = humanizeGrantSummary(g.summary || g.command || '')
                  const targetTodo = findGrantTargetTodo(g)
                  const targetProject = targetTodo?.projectId
                    ? projects.find((p) => p.id === targetTodo.projectId)?.name ?? null
                    : null
                  const childCount = targetTodo
                    ? todos.filter((t) => t.parentId === targetTodo.id && t.status !== 'discarded').length
                    : 0
                  const pendingExpanded = expandedPendingId === g.id
                  const needsForceConfirm = isForceConfirmableGrant(g)
                  const forceReason = needsForceConfirm && g.execError ? humanizeHistoryError(g.execError) : null

                  return (
                    <div
                      key={g.id}
                      id={`grant-${g.id}`}
                      className={cn(
                        'rounded-card border bg-bg-card transition-colors shadow-sm overflow-hidden',
                        focusGrantId === g.id
                          ? 'border-accent bg-accent/5 ring-1 ring-accent/40'
                          : 'border-border'
                      )}
                    >
                      <div className="px-4 py-3 flex items-center justify-between gap-4">
                        <div
                          role="button"
                          tabIndex={0}
                          aria-expanded={pendingExpanded}
                          onClick={() => setExpandedPendingId(pendingExpanded ? null : g.id)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault()
                              setExpandedPendingId(pendingExpanded ? null : g.id)
                            }
                          }}
                          className="flex items-center gap-3 min-w-0 flex-1 cursor-pointer"
                        >
                          <div className="min-w-0 grid gap-1 flex-1">
                            <div className="flex items-center gap-2 min-w-0">
                              <StatusBadge tone={g.scope === 'config' ? 'warning' : 'danger'}>
                                {grantBadgeLabel(g.scope, needsForceConfirm)}
                              </StatusBadge>
                              <span className="text-content font-medium text-text-primary truncate">
                                {title || `${nameOf(g.agentId)} 申请${g.scope === 'config' ? '修改界面设置' : '删除数据'}`}
                              </span>
                              {targetProject && (
                                <span className="text-caption text-text-secondary bg-surface-subtle px-1.5 py-0.5 rounded-xs shrink-0">
                                  {targetProject}
                                </span>
                              )}
                            </div>
                            <div className="flex flex-wrap items-center gap-2 text-label text-text-secondary">
                              <span>申请人：{nameOf(g.agentId)}</span>
                              <span>·</span>
                              <span>{fmtTime(g.createdAt)}</span>
                              {targetTodo && (
                                <>
                                  <span>·</span>
                                  <span>状态：{TODO_STATUS_LABELS[targetTodo.status] ?? targetTodo.status}</span>
                                </>
                              )}
                              {childCount > 0 && (
                                <>
                                  <span>·</span>
                                  <span className="text-warning font-medium">含 {childCount} 个子任务</span>
                                </>
                              )}
                            </div>
                            {forceReason && (
                              <div className="text-caption text-danger">
                                {forceReason}
                              </div>
                            )}
                          </div>
                        </div>

                        <div className="flex items-center gap-1.5 shrink-0">
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-expanded={pendingExpanded}
                            onClick={() => setExpandedPendingId(pendingExpanded ? null : g.id)}
                          >
                            {pendingExpanded ? '收起详情' : '查看详情'}
                          </Button>
                          {needsForceConfirm ? (
                            <>
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={busy === g.id}
                                onClick={() => void resolveGrant(g.id, false)}
                              >
                                {APPROVAL_ACTION.withdraw}
                              </Button>
                              <Button
                                variant="dangerSolid"
                                size="sm"
                                disabled={busy === g.id}
                                onClick={() => void resolveGrant(g.id, true, false, true)}
                              >
                                {forceConfirmLabel('删除')}
                              </Button>
                            </>
                          ) : (
                            <>
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={busy === g.id}
                                onClick={() => void resolveGrant(g.id, false)}
                              >
                                {APPROVAL_ACTION.reject}
                              </Button>
                              {g.scope === 'config' && (
                                <Button
                                  size="sm"
                                  disabled={busy === g.id}
                                  onClick={() => void resolveGrant(g.id, true, true)}
                                >
                                  {APPROVAL_ACTION.allowAlways}
                                </Button>
                              )}
                              <Button
                                variant="primary"
                                size="sm"
                                disabled={busy === g.id}
                                onClick={() => void resolveGrant(g.id, true)}
                                /* 副作用不写进按钮名（卡 66be78f4）：「允许」已经说明是同意，*会立刻执行* 放在这里说 */
                                title="允许后立即执行这条申请；执行结果记在审批记录里"
                              >
                                {allowLabel(g.scope)}
                              </Button>
                            </>
                          )}
                        </div>
                      </div>

                      {/* 待审批项展开详情：直接展示目标事项内容与打开事项抽屉入口 */}
                      {pendingExpanded && (
                        <div className="px-4 pb-3.5 pt-2 bg-surface-subtle border-t border-border/60 grid gap-2.5 text-label">
                          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-caption">
                            <div>
                              <div className="text-text-secondary mb-0.5">申请操作</div>
                              <div className="text-text-primary font-medium">{g.scope === 'config' ? '修改界面设置' : '删除数据（一次性授权）'}</div>
                            </div>
                            <div>
                              <div className="text-text-secondary mb-0.5">申请人</div>
                              <div className="text-text-primary font-medium">{nameOf(g.agentId)}</div>
                            </div>
                            <div>
                              <div className="text-text-secondary mb-0.5">申请时间</div>
                              <div className="text-text-primary font-mono">{fmtFullTime(g.createdAt)}</div>
                            </div>
                            <div>
                              <div className="text-text-secondary mb-0.5">所属项目</div>
                              <div className="text-text-primary font-medium">{targetProject ?? '全局'}</div>
                            </div>
                          </div>

                          {targetTodo ? (
                            <div className="rounded-input bg-bg-card border border-border p-3 grid gap-1.5">
                              <div className="flex items-center justify-between gap-2">
                                <div className="flex items-center gap-2 min-w-0">
                                  <span className="text-caption font-medium text-text-secondary shrink-0">目标事项</span>
                                  <span className="text-label font-medium text-text-primary truncate">{targetTodo.title}</span>
                                </div>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => void invoke('window:showQuickAdd', { todoId: targetTodo.id })}
                                >
                                  打开事项详情
                                </Button>
                              </div>
                              <div className="flex flex-wrap items-center gap-3 text-caption text-text-secondary">
                                <span>当前状态：{TODO_STATUS_LABELS[targetTodo.status] ?? targetTodo.status}</span>
                                <span>优先级：{TODO_PRIORITY_LABELS[targetTodo.priority] ?? targetTodo.priority}</span>
                                <span>
                                  子任务：{childCount > 0 ? `${childCount} 个（删除后将保留为独立事项）` : '无'}
                                </span>
                              </div>
                              {targetTodo.description && (
                                <div className="mt-1 pt-1.5 border-t border-border/50 text-caption text-text-secondary whitespace-pre-wrap line-clamp-3">
                                  {targetTodo.description}
                                </div>
                              )}
                            </div>
                          ) : (
                            <div className="text-caption text-text-secondary">
                              申请内容：{title}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            ) : null}

            {error && (
              <div className="rounded-card border border-danger/30 bg-danger/5 px-4 py-2.5 text-label text-danger inline-flex items-center gap-2">
                <Icon name="alertTriangle" size={14} />
                <span>{error}</span>
              </div>
            )}

            {result && (
              <div
                role="status"
                className={cn(
                  'rounded-card border px-4 py-3 flex items-center justify-between gap-4',
                  result.ok
                    ? 'border-border bg-bg-card text-text-secondary'
                    : 'border-danger/30 bg-danger/5 text-danger'
                )}
              >
                <div className="min-w-0 grid gap-1">
                  <p className="text-content font-medium inline-flex items-center gap-2 text-text-primary">
                    <Icon
                      name={result.ok ? 'checkCircle' : 'alertTriangle'}
                      size={15}
                      className={result.ok ? 'text-success shrink-0' : 'text-danger shrink-0'}
                    />
                    <span className="break-words">{result.text}</span>
                  </p>
                </div>
                {result.canForce && result.grantId ? (
                  <div className="flex items-center gap-2 shrink-0">
                    <Button size="sm" variant="ghost" onClick={() => setResult(null)}>
                      取消
                    </Button>
                    <Button
                      variant="dangerSolid"
                      size="sm"
                      disabled={busy === result.grantId}
                      onClick={() => void resolveGrant(result.grantId!, true, false, true)}
                    >
                      {forceConfirmLabel('删除')}
                    </Button>
                  </div>
                ) : (
                  <Button size="sm" variant="ghost" onClick={() => setResult(null)}>
                    关闭
                  </Button>
                )}
              </div>
            )}
          </section>
        )}

        {/* ── 二、审批记录：表头即筛选（6 列表头自带下拉筛选） + 独立审批/执行结果列 + 纯人话详情 ── */}
        <section aria-label="审批记录" className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-2.5">
              <div className="flex items-baseline gap-2">
                <h2 className="text-column-title font-semibold tracking-title text-text-primary">审批记录</h2>
                <span className="font-mono text-label text-text-secondary">{history.total}</span>
              </div>

              {!showPendingPanel && (
                <div
                  aria-label="待审批"
                  className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-bg-card px-3 py-1 text-caption text-text-secondary"
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-success shrink-0" />
                  <span className="font-medium text-text-primary">待审批</span>
                  <span>·</span>
                  <span>当前无待处理申请</span>
                </div>
              )}
            </div>

            <div className="flex items-center gap-2 flex-wrap">
              {datePreset === 'custom' && (
                <div className="flex items-center gap-1.5 text-label text-text-secondary">
                  <input
                    aria-label="开始日期"
                    type="date"
                    value={auditFrom}
                    onChange={(event) => resetAuditFilters(() => setAuditFrom(event.target.value))}
                    className="h-8 rounded-button border border-border bg-bg-card px-2.5 text-label text-text-primary focus:outline-none"
                  />
                  <span>至</span>
                  <input
                    aria-label="结束日期"
                    type="date"
                    value={auditUntil}
                    onChange={(event) => resetAuditFilters(() => setAuditUntil(event.target.value))}
                    className="h-8 rounded-button border border-border bg-bg-card px-2.5 text-label text-text-primary focus:outline-none"
                  />
                </div>
              )}

              {hasActiveFilter && (
                <Button size="sm" variant="ghost" onClick={clearAllFilters}>
                  重置筛选
                </Button>
              )}

              <div className="relative w-56">
                <Icon
                  name="search"
                  size={13}
                  className="text-text-secondary pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2"
                />
                <input
                  aria-label="搜索审批记录"
                  value={auditQuery}
                  onChange={(event) => resetAuditFilters(() => setAuditQuery(event.target.value))}
                  placeholder="搜索申请内容或目标…"
                  className="h-8 w-full rounded-button border border-border bg-bg-card pl-7 pr-2.5 text-label text-text-primary placeholder:text-text-secondary/70 hover:border-text-secondary/40 focus:border-accent/50 focus:outline-none transition-colors"
                />
              </div>
            </div>
          </div>

          {historyError && (
            <p className="text-label text-danger" role="alert">审批历史读取失败：{historyError}</p>
          )}

          <div className="rounded-card border border-border bg-bg-card divide-y divide-border/50 shadow-sm">
            {/* 标准 7 列表头：筛选列自带自定义浮层菜单（表头即筛选），纯文字呈现 */}
            <div
              role="row"
              aria-label="审批记录表头"
              className="px-4 py-2 bg-surface-subtle rounded-t-card flex items-center gap-3 text-caption select-none"
            >
              <HeaderColumnFilter
                label="申请类型"
                ariaLabel="按申请类型筛选"
                activeLabel={auditType === 'all' ? null : AUDIT_TYPE_LABELS[auditType]}
                value={auditType}
                onChange={(next) => resetAuditFilters(() => setAuditType(next as AuditType))}
                wrapperClassName="w-28 shrink-0"
                options={[
                  { value: 'all', label: '全部类型' },
                  { value: 'grant', label: '操作授权' },
                  { value: 'agent', label: 'Agent 接入' },
                  { value: 'profile', label: '档案修改' },
                  { value: 'protocol', label: '协议修改' },
                  { value: 'handoff', label: '项目接手说明' },
                  { value: 'rules', label: '协作规则' }
                ]}
              />

              <div role="columnheader" className="flex-1 min-w-0 font-medium text-text-secondary">
                申请内容
              </div>

              <HeaderColumnFilter
                label="所属范围"
                ariaLabel="按所属范围筛选"
                activeLabel={
                  auditProject
                    ? (auditProjects.find((p) => p.id === auditProject)?.name ?? auditProject)
                    : null
                }
                value={auditProject}
                onChange={(next) => resetAuditFilters(() => setAuditProject(next))}
                wrapperClassName="w-28 shrink-0"
                options={[
                  { value: '', label: '全部范围' },
                  ...auditProjects.map((project) => ({ value: project.id, label: project.name }))
                ]}
              />

              <HeaderColumnFilter
                label="申请人"
                ariaLabel="按申请人筛选"
                activeLabel={auditAgent ? nameOf(auditAgent, auditAgent) : null}
                value={auditAgent}
                onChange={(next) => resetAuditFilters(() => setAuditAgent(next))}
                wrapperClassName="w-28 shrink-0"
                options={[
                  { value: '', label: '全部申请人' },
                  ...Array.from(
                    new Map([
                      ...agents.map((a) => [a.id, a.displayName || a.id.replace(/^agent:/, '')] as const),
                      ...knownHistoryActors.map((actor) => [actor.id, nameOf(actor.id, actor.name)] as const)
                    ]).entries()
                  ).map(([id, display]) => ({ value: id, label: display }))
                ]}
              />

              <HeaderColumnFilter
                label="审批结果"
                ariaLabel="按审批结果筛选"
                activeLabel={auditDecision === 'all' ? null : AUDIT_DECISION_LABELS[auditDecision]}
                value={auditDecision}
                onChange={(next) => resetAuditFilters(() => setAuditDecision(next as AuditDecision))}
                wrapperClassName="w-24 shrink-0"
                options={[
                  { value: 'all', label: '全部审批结果' },
                  { value: 'pending', label: '待处理' },
                  { value: 'approved', label: '已批准' },
                  { value: 'rejected', label: '已拒绝' },
                  { value: 'revoked', label: '已撤回' },
                  { value: 'expired', label: '已过期' }
                ]}
              />

              <HeaderColumnFilter
                label="执行结果"
                ariaLabel="按执行结果筛选"
                activeLabel={auditExecution === 'all' ? null : AUDIT_EXECUTION_LABELS[auditExecution]}
                value={auditExecution}
                onChange={(next) => resetAuditFilters(() => setAuditExecution(next as AuditExecution))}
                wrapperClassName="w-24 shrink-0"
                options={[
                  { value: 'all', label: '全部执行结果' },
                  { value: 'success', label: '已执行' },
                  { value: 'failure', label: '执行失败' },
                  { value: 'not_required', label: '无需执行' },
                  { value: 'unknown', label: '结果未知' }
                ]}
              />

              <HeaderColumnFilter
                label="时间"
                ariaLabel="按时间范围筛选"
                align="right"
                activeLabel={datePreset === 'all' ? null : DATE_PRESET_LABELS[datePreset]}
                value={datePreset}
                onChange={(next) => handleDatePresetChange(next as DatePreset)}
                wrapperClassName="w-24 shrink-0 pr-5"
                options={[
                  { value: 'all', label: '全部时间' },
                  { value: 'today', label: '今天' },
                  { value: '7d', label: '近 7 天' },
                  { value: '30d', label: '近 30 天' },
                  { value: 'custom', label: '自定义日期' }
                ]}
              />
            </div>

            {historyRows.length === 0 ? (
              <div className="p-6">
                <EmptyState
                  title="没有匹配的审批记录"
                  description={hasActiveFilter ? '当前筛选条件下没有记录，可点击表头切换条件或重置筛选。' : '暂无历史审批记录。'}
                />
              </div>
            ) : (
              historyRows.map((item) => {
                const expanded = expandedAuditId === item.id
                const typeLabel = ({ agent: 'Agent 接入', grant: item.scope === 'config' ? '界面授权' : '操作授权', profile: '档案修改', protocol: '协议修改', handoff: '项目接手说明', rules: '协作规则' } as const)[item.type] ?? item.type
                const decisionLabel = ({ pending: '待处理', approved: '已批准', rejected: '已拒绝', expired: '已过期', revoked: '已撤回' } as const)[item.decision]
                const rawProjectName = item.projectId
                  ? auditProjects.find((project) => project.id === item.projectId)?.name ?? item.projectId
                  : null
                const formatted = formatHistoryRow(item, rawProjectName)
                const actorDisplay = nameOf(item.agentId, item.agentName)
                const decisionCell = resolveDecisionCell(item.decision)
                const executionCell = resolveExecutionCell(item)
                const meaningfulReceipt = cleanHistoryReceipt(item.execSummary)
                const isForceGuardFailure =
                  item.type === 'grant' &&
                  item.decision === 'approved' &&
                  item.execution === 'failure' &&
                  /--force/.test(item.execError ?? '') &&
                  !(item.requestArgv ?? []).includes('--force')
                const targetTodoStillExists =
                  isForceGuardFailure &&
                  todos.length > 0 &&
                  todos.some((t) =>
                    (item.requestArgv ?? []).some(
                      (arg) =>
                        typeof arg === 'string' &&
                        arg.length >= 6 &&
                        !arg.startsWith('-') &&
                        (t.id === arg || t.id.startsWith(arg))
                    )
                  )
                const needsRowForceConfirm =
                  isForceGuardFailure &&
                  (grants.some((g) => g.id === item.id && isForceConfirmableGrant(g)) ||
                    targetTodoStillExists)
                const conciseError = item.execError
                  ? isForceGuardFailure && !needsRowForceConfirm && todos.length > 0
                    ? `${humanizeHistoryError(item.execError)}（目标事项已删除或已结案）`
                    : humanizeHistoryError(item.execError)
                  : null

                return (
                  <div
                    key={`${item.type}:${item.id}`}
                    className={cn(
                      'transition-colors',
                      expanded ? 'bg-surface-subtle' : 'hover:bg-black/5'
                    )}
                  >
                    <div
                      role="button"
                      tabIndex={0}
                      aria-expanded={expanded}
                      onClick={() => setExpandedAuditId(expanded ? null : item.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          setExpandedAuditId(expanded ? null : item.id)
                        }
                      }}
                      className="px-4 py-2.5 flex items-center gap-3 cursor-pointer"
                    >
                      {/* 列 1：申请类型（纯文字标签，无图标） */}
                      <div className="w-28 shrink-0 flex items-center">
                        <span className="inline-flex items-center rounded-xs bg-surface-subtle border border-border/70 px-2 py-0.5 text-caption font-medium text-text-secondary whitespace-nowrap truncate">
                          {typeLabel}
                        </span>
                      </div>

                      {/* 列 2：申请内容（统一 ItemTitle 14px/400 + 按需原因/回执 + 行内直达二次确认按钮） */}
                      <div className="min-w-0 flex-1 flex items-center justify-between gap-3">
                        <div className="min-w-0 flex-1 flex flex-col gap-0.5">
                          <span className="text-content font-normal text-text-primary truncate">
                            {formatted.title}
                          </span>
                          {(conciseError || meaningfulReceipt) && (
                            <div className="text-caption truncate">
                              {conciseError ? (
                                <span className="text-danger">{conciseError}</span>
                              ) : (
                                <span className="text-text-secondary">{meaningfulReceipt}</span>
                              )}
                            </div>
                          )}
                        </div>
                        {needsRowForceConfirm && (
                          <div
                            className="flex items-center gap-1.5 shrink-0"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={busy === item.id}
                              onClick={() => void resolveGrant(item.id, false)}
                            >
                              {APPROVAL_ACTION.withdraw}
                            </Button>
                            <Button
                              variant="dangerSolid"
                              size="sm"
                              disabled={busy === item.id}
                              onClick={() => void resolveGrant(item.id, true, false, true)}
                            >
                              {forceConfirmLabel('删除')}
                            </Button>
                          </div>
                        )}
                      </div>

                      {/* 列 3：所属范围（项目名或全局） */}
                      <div className="w-28 shrink-0 truncate text-label text-text-secondary">
                        {formatted.scopeLabel}
                      </div>

                      {/* 列 4：申请人 */}
                      <div className="w-28 shrink-0 truncate text-label text-text-secondary" title={item.agentId}>
                        {actorDisplay}
                      </div>

                      {/* 列 5：审批结果（独立列，不换行） */}
                      <div className="w-24 shrink-0 flex items-center">
                        <span
                          className={cn(
                            'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-caption font-medium whitespace-nowrap',
                            decisionCell.pillClass
                          )}
                        >
                          <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', decisionCell.dotClass)} />
                          <span>{decisionCell.label}</span>
                        </span>
                      </div>

                      {/* 列 6：执行结果（独立列，不换行） */}
                      <div className="w-24 shrink-0 flex items-center">
                        <span className={cn('text-caption whitespace-nowrap', executionCell.textClass)}>
                          {executionCell.label}
                        </span>
                      </div>

                      {/* 列 7：时间 + 展开箭头 */}
                      <div className="w-24 shrink-0 flex items-center justify-end gap-2">
                        <span className="font-mono text-caption text-text-secondary whitespace-nowrap">
                          {fmtTime(item.activityAt)}
                        </span>
                        <Icon
                          name="chevronLeft"
                          size={13}
                          className={cn(
                            'text-text-secondary/70 transition-transform shrink-0',
                            expanded ? 'rotate-90' : '-rotate-90'
                          )}
                        />
                      </div>
                    </div>

                    {/* 展开详情：以普通用户可读的业务信息与内容对比为主角，不展示底层命令行 */}
                    {expanded && (
                      <div className="px-4 pb-3.5 pt-0.5">
                        <div className="rounded-button border border-border/80 bg-bg-primary p-3 grid gap-2.5 text-label">
                          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-caption">
                            <div>
                              <div className="text-text-secondary mb-0.5">申请类型</div>
                              <div className="text-text-primary font-medium">{typeLabel}</div>
                            </div>
                            <div>
                              <div className="text-text-secondary mb-0.5">申请人</div>
                              <div className="text-text-primary font-medium truncate">
                                {actorDisplay}
                              </div>
                            </div>
                            <div>
                              <div className="text-text-secondary mb-0.5">申请时间</div>
                              <div className="text-text-primary font-mono">{fmtFullTime(item.createdAt)}</div>
                            </div>
                            <div>
                              <div className="text-text-secondary mb-0.5">审批处理</div>
                              <div className="text-text-primary font-medium">
                                {decisionLabel}
                                {item.decidedAt
                                  ? ` · 处理人：${nameOf(item.decidedBy ?? 'human')} (${fmtTime(item.decidedAt)})`
                                  : ''}
                              </div>
                            </div>
                          </div>

                          <div className="border-t border-border/50 pt-2 text-caption flex flex-wrap items-center gap-x-6 gap-y-1">
                            <span>
                              <span className="text-text-secondary">申请内容：</span>
                              <span className="text-text-primary font-medium">{formatted.title}</span>
                            </span>
                            <span>
                              <span className="text-text-secondary">执行结果：</span>
                              <span className={cn('font-medium', executionCell.textClass)}>
                                {executionCell.detailLabel}
                              </span>
                            </span>
                          </div>

                          {(conciseError || meaningfulReceipt) && (
                            <div className="text-caption flex items-center justify-between gap-3 flex-wrap">
                              {conciseError ? (
                                <div className="text-danger break-words">{conciseError}</div>
                              ) : (
                                <div className="text-text-secondary break-words">处理结果：{meaningfulReceipt}</div>
                              )}
                              {needsRowForceConfirm && (
                                <div className="flex items-center gap-2 shrink-0">
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    disabled={busy === item.id}
                                    onClick={() => void resolveGrant(item.id, false)}
                                  >
                                    {APPROVAL_ACTION.withdraw}
                                  </Button>
                                  <Button
                                    variant="dangerSolid"
                                    size="sm"
                                    disabled={busy === item.id}
                                    onClick={() => void resolveGrant(item.id, true, false, true)}
                                  >
                                    {forceConfirmLabel('删除')}
                                  </Button>
                                </div>
                              )}
                            </div>
                          )}

                          {item.type === 'rules' && (item.originalBody || item.proposedBody) && (
                            <div className="border-t border-border/50 pt-2 text-caption text-text-secondary">
                              规则强度变更：
                              <span className="text-text-primary font-medium ml-1">
                                {ENFORCEMENT_LABELS[item.originalBody ?? ''] ?? item.originalBody ?? '默认'}
                              </span>
                              <span className="mx-1.5">→</span>
                              <span className="text-text-primary font-medium">
                                {ENFORCEMENT_LABELS[item.proposedBody ?? ''] ?? item.proposedBody ?? '未记录'}
                              </span>
                            </div>
                          )}

                          {(item.type === 'profile' || item.type === 'protocol' || item.type === 'handoff') && (
                            <div className="grid gap-2 sm:grid-cols-3 pt-1 border-t border-border/50">
                              <div className="rounded-input bg-bg-card border border-border p-2.5">
                                <div className="text-caption font-medium text-text-secondary mb-1">修改前内容</div>
                                <div className="text-label text-text-primary whitespace-pre-wrap">{item.originalBody || '（空）'}</div>
                              </div>
                              <div className="rounded-input bg-bg-card border border-border p-2.5">
                                <div className="text-caption font-medium text-text-secondary mb-1">申请修改为</div>
                                <div className="text-label text-text-primary whitespace-pre-wrap">{item.proposedBody || '（空）'}</div>
                              </div>
                              <div className="rounded-input bg-bg-card border border-border p-2.5">
                                <div className="text-caption font-medium text-text-secondary mb-1">最终生效内容</div>
                                <div className="text-label text-text-primary whitespace-pre-wrap">{item.decidedBody || '（未采纳）'}</div>
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )
              })
            )}
          </div>

          {history.total > history.limit && (
            <Pagination
              page={auditPage}
              pageCount={historyPageCount}
              total={history.total}
              pageSize={history.limit}
              onPageChange={setAuditPage}
              label="审批记录分页"
            />
          )}
        </section>
      </div>
    </div>
  )
}

/**
 * 将后端原始命令摘要（如 `todo rm「xxx」`、`ui set --key=theme --value=light`）
 * 彻底转化为面向普通用户的自然语言描述（不露命令名与参数 flag）。
 */
export function humanizeGrantSummary(raw: string): string {
  const s = raw.trim()
  if (!s) return ''

  // 1. 删除类命令（注意真实库里 rm 与「 之间可能没有空格，用 \s*）
  const rmRules: Array<[RegExp, string]> = [
    [/^todo\s+rm\s*(「.+」)$/i, '删除事项$1'],
    [/^todo\s+rm(?:\s+--\S+)*$/i, '删除事项'],
    [/^todo\s+comment-rm\s*(「.+」)$/i, '删除评论$1'],
    [/^todo\s+comment-rm(?:\s+--\S+)*$/i, '删除评论'],
    [/^category\s+rm\s*(「.+」)$/i, '删除分类$1'],
    [/^category\s+rm(?:\s+--\S+)*$/i, '删除分类'],
    [/^release\s+rm\s*(「.+」)$/i, '删除版本$1'],
    [/^release\s+rm(?:\s+--\S+)*$/i, '删除版本'],
    [/^memo\s+rm\s*(「.+」)$/i, '删除备忘$1'],
    [/^memo\s+rm(?:\s+--\S+)*$/i, '删除备忘'],
    [/^project\s+rm\s*(「.+」)$/i, '删除项目$1'],
    [/^project\s+rm(?:\s+--\S+)*$/i, '删除项目']
  ]
  for (const [re, replacement] of rmRules) {
    if (re.test(s)) return s.replace(re, replacement)
  }

  // 2. 界面设置与重置
  const uiSetMatch = s.match(/^ui\s+set\s+--key=([^\s]+)(?:\s+--value=([^\s]+))?/i)
  if (uiSetMatch) {
    const key = UI_KEY_LABELS[uiSetMatch[1]] ?? uiSetMatch[1]
    const val = uiSetMatch[2] !== undefined ? (UI_VALUE_LABELS[uiSetMatch[2]] ?? uiSetMatch[2]) : ''
    return val ? `修改界面设置（${key}：${val}）` : `修改界面设置（${key}）`
  }
  if (/^ui\s+set$/i.test(s)) return '修改界面设置'

  const uiResetMatch = s.match(/^ui\s+reset\s+--key=([^\s]+)/i)
  if (uiResetMatch) {
    const key = UI_KEY_LABELS[uiResetMatch[1]] ?? uiResetMatch[1]
    return `重置界面设置（${key}）`
  }
  if (/^ui\s+reset$/i.test(s)) return '重置全部界面设置'

  // 3. 统计清理
  const telemetryMatch = s.match(/^telemetry\s+clear\s*（(.+)）$/i)
  if (telemetryMatch) return `清空统计数据（${telemetryMatch[1]}）`
  if (/^telemetry\s+clear/i.test(s)) return '清空统计数据'

  return s
}

function formatHistoryRow(
  item: ApprovalHistoryRow,
  projectName: string | null
): {
  icon: IconName
  iconTone: string
  title: string
  scopeLabel: string
} {
  if (item.type === 'grant') {
    const title = humanizeGrantSummary(item.summary)
    return {
      icon: item.scope === 'config' ? 'settings' : 'trash',
      iconTone: item.scope === 'config' ? 'bg-accent/10 text-accent' : 'bg-surface-muted text-text-secondary',
      title,
      scopeLabel: projectName ?? '全局'
    }
  }

  if (item.type === 'profile') {
    const rawKey = item.summary.replace(/^档案提议\s*·\s*/, '').trim()
    const keyLabel = PROFILE_LABELS[rawKey] ?? rawKey
    return {
      icon: 'user',
      iconTone: 'bg-surface-muted text-text-secondary',
      title: `修改用户档案 · ${keyLabel}`,
      scopeLabel: projectName ?? '全局'
    }
  }

  if (item.type === 'protocol') {
    const rawKey = item.summary.replace(/^协议提议\s*·\s*/, '').trim()
    const keyLabel = PROTOCOL_LABELS[rawKey] ?? rawKey
    return {
      icon: 'layers',
      iconTone: 'bg-surface-muted text-text-secondary',
      title: `修改协作协议 · ${keyLabel}`,
      scopeLabel: projectName ?? '全局'
    }
  }

  if (item.type === 'handoff') {
    const inlineProj = item.summary.replace(/^接手说明提议\s*·\s*/, '').trim()
    const effectiveProject = projectName || inlineProj || '全局'
    return {
      icon: 'fileText',
      iconTone: 'bg-surface-muted text-text-secondary',
      title: '更新项目接手说明',
      scopeLabel: effectiveProject
    }
  }

  if (item.type === 'rules') {
    const rawKey = item.summary.replace(/^协作规则提议\s*·\s*/, '').trim()
    const keyLabel = RULE_LABELS[rawKey] ?? rawKey
    return {
      icon: 'shield',
      iconTone: 'bg-surface-muted text-text-secondary',
      title: `调整协作规则 · ${keyLabel}`,
      scopeLabel: projectName ?? '全局'
    }
  }

  // agent
  const actionKey = item.summary.replace(/^Agent\s*接入\s*·\s*/i, '').trim()
  const actionLabel =
    ({
      registered: '提交接入申请',
      approved: '批准接入',
      rejected: '拒绝接入',
      revoked: '吊销接入权限'
    } as Record<string, string>)[actionKey] ?? item.summary
  return {
    icon: 'bot',
    iconTone: 'bg-surface-muted text-text-secondary',
    title: `Agent 接入 · ${actionLabel}`,
    scopeLabel: '全局'
  }
}

/**
 * 清洗历史记录里遗留的守卫长报错，消除 `--force`、`解绑`、`todo children`、`[TodoRepository]` 等内部术语
 */
export function humanizeHistoryError(rawError: string): string {
  const cleaned = rawError.replace(/^\[[A-Za-z0-9_.-]+\]\s*/, '').trim()
  if (/子任务|--force/.test(cleaned)) {
    const countMatch = cleaned.match(/(\d+)\s*个子任务/)
    return countMatch
      ? `未执行：包含 ${countMatch[1]} 个子任务，需二次确认后删除`
      : '未执行：包含子任务，需二次确认后删除'
  }
  if (/待确认.*G4|还在「待确认」/.test(cleaned)) {
    return '未执行：事项处于「待确认」状态，需先确认后才能操作'
  }
  if (/--yes/.test(cleaned)) {
    return '未执行：缺少删除确认'
  }
  if (/待办不存在|事项不存在/.test(cleaned)) {
    return '未执行：目标事项不存在或授权已失效'
  }
  const projMatch = cleaned.match(/项目不存在:\s*(.+)$/)
  if (projMatch) {
    return `未执行：目标项目「${projMatch[1].trim()}」不存在`
  }
  if (/不能用于这次动作|已失效/.test(cleaned)) {
    return '未执行：该授权已失效或目标已变更'
  }
  if (/floatBallColor/.test(cleaned)) {
    return '未执行：悬浮球颜色参数无效'
  }
  const firstClause = cleaned.split(/[；;\n—]/)[0]?.trim() || cleaned
  return firstClause.replace(/`[^`]+`/g, '').replace(/[。.]$/, '').trim()
}

/**
 * 过滤掉无增量信息的默认套话，以及早期版本误混入 exec_summary 的 CLI 未读提醒尾巴
 */
function cleanHistoryReceipt(rawSummary: string | null): string | null {
  if (!rawSummary) return null
  const trimmed = rawSummary.trim()
  if (!trimmed || BOILERPLATE_RECEIPTS.has(trimmed)) return null
  if (/\[未读\]|todo get|memo ack|notification list|todo list/.test(trimmed)) return null
  return trimmed
}

/**
 * 独立「审批结果」列展示
 */
function resolveDecisionCell(decision: Exclude<AuditDecision, 'all'>): {
  label: string
  dotClass: string
  pillClass: string
} {
  switch (decision) {
    case 'approved':
      return {
        label: '已批准',
        dotClass: 'bg-success',
        pillClass: 'bg-success/10 text-success'
      }
    case 'rejected':
      return {
        label: '已拒绝',
        dotClass: 'bg-danger',
        pillClass: 'bg-danger/10 text-danger'
      }
    case 'pending':
      return {
        label: '待处理',
        dotClass: 'bg-warning',
        pillClass: 'bg-warning/10 text-warning'
      }
    case 'revoked':
      return {
        label: '已撤回',
        dotClass: 'bg-text-secondary/50',
        pillClass: 'bg-surface-muted text-text-secondary'
      }
    case 'expired':
      return {
        label: '已过期',
        dotClass: 'bg-text-secondary/50',
        pillClass: 'bg-surface-muted text-text-secondary'
      }
  }
}

/**
 * 独立「执行结果」列展示（与「审批结果」分离）
 */
function resolveExecutionCell(item: ApprovalHistoryRow): {
  label: string
  detailLabel: string
  textClass: string
} {
  if (item.decision !== 'approved') {
    return {
      label: '—',
      detailLabel: '未批准，未执行',
      textClass: 'text-text-secondary/50'
    }
  }

  if (item.type === 'profile' || item.type === 'protocol' || item.type === 'handoff' || item.type === 'rules') {
    return {
      label: '已生效',
      detailLabel: '已采纳并生效',
      textClass: 'text-success font-medium'
    }
  }

  if (item.type === 'agent') {
    return {
      label: '已生效',
      detailLabel: '权限已更新',
      textClass: 'text-success font-medium'
    }
  }

  switch (item.execution) {
    case 'success':
      return {
        label: '已执行',
        detailLabel: '已按批准执行成功',
        textClass: 'text-success font-medium'
      }
    case 'failure':
      return {
        label: '执行失败',
        detailLabel: '执行未完成',
        textClass: 'text-danger font-medium'
      }
    case 'not_required':
      return {
        label: '已生效',
        detailLabel: '长期授权已生效',
        textClass: 'text-text-secondary'
      }
    case 'unknown':
    default:
      return {
        label: '已授权',
        detailLabel: '已发放一次性授权',
        textClass: 'text-text-secondary'
      }
  }
}

function fmtTime(iso: string): string {
  const d = new Date(iso)
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  return sameDay
    ? d.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString('zh-CN', {
        hour12: false,
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      })
}

function fmtFullTime(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleString('zh-CN', {
    hour12: false,
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
}
