import React, { useCallback, useEffect, useState } from 'react'
import { Section } from '../settings/Section'
import { Button } from '../ui/Button'
import { Icon } from '../ui/Icon'
import { StatusBadge } from '../ui/Badge'
import { invoke } from '../../lib/ipc-client'
import { isPendingAgent, isRetryableGrant, pickGrant } from '../../lib/grant-state'
import { APPROVAL_ACTION } from '../../lib/approval-copy'
import type { Agent, AgentGrant, GrantScope } from '../../types/todo'

const CMD_LABELS: Record<string, string> = {
  'todo add': '新建事项',
  'todo update': '更新事项',
  'todo close': '收口事项',
  'todo done': '完成事项',
  'todo reject': '退回事项',
  'todo comment': '发表评论',
  'todo delete-comment': '删除评论',
  'todo rm': '删除事项',
  'release add': '登记版本',
  'release update': '更新版本',
  'release rm': '删除版本',
  'project add': '创建项目',
  'project update': '更新项目',
  'project handoff-propose': '提议接手说明',
  'memo add': '发送备忘',
  'memo ack': '确认备忘'
}

function humanizeWriteCmd(cmd: string | null | undefined): string {
  if (!cmd) return '数据写入'
  const clean = cmd.trim()
  return CMD_LABELS[clean] ?? clean
}

/**
 * Agent 团队与权限账本（用户与团队 -> 团队分区）
 */
export const AgentRosterSection: React.FC = () => {
  const [agents, setAgents] = useState<Agent[]>([])
  const [grants, setGrants] = useState<AgentGrant[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [list, gs] = await Promise.all([
        invoke('agent:list'),
        invoke('agent:listGrants', { limit: 200 })
      ])
      const sameIfEqual = <T,>(prev: T[], next: T[]): T[] =>
        JSON.stringify(prev) === JSON.stringify(next) ? prev : next
      setAgents((prev) => sameIfEqual(prev, list))
      setGrants((prev) => sameIfEqual(prev, gs))
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => void refresh(), 5000)
    return () => window.clearInterval(timer)
  }, [refresh])

  const setRejected = async (id: string, rejected: boolean) => {
    setBusy(id)
    setError(null)
    try {
      await invoke('agent:setRejected', { id, rejected })
      await refresh()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const setApproved = async (id: string, approved: boolean) => {
    setBusy(id)
    setError(null)
    try {
      await invoke('agent:setApproved', { id, approved })
      await refresh()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const revokeGrants = async (id: string, scope?: GrantScope) => {
    setBusy(`${id}:${scope ?? 'all'}`)
    setError(null)
    try {
      await invoke('agent:revokeGrants', { id, ...(scope ? { scope } : {}) })
      await refresh()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const grantsOf = (agentId: string, scope: GrantScope) => pickGrant(grants, agentId, scope)
  const pendingAgents = agents.filter(isPendingAgent).length

  return (
    <Section title="Agent 团队" desc="管理已接入的 AI 助手写入权限、界面设置授权与高危操作授权状态。">
      {agents.length === 0 ? (
        <p className="text-label text-text-secondary">
          暂无已注册的 AI 助手。
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {pendingAgents > 0 && (
            <div className="rounded-button border border-warning/30 bg-warning/10 px-3 py-2 text-label text-text-primary">
              当前有 <span className="font-semibold">{pendingAgents}</span> 个 AI 助手正在等待批准写入权限。
            </div>
          )}
          <div className="grid gap-3">
            {agents.map((a) => {
              const cfg = grantsOf(a.id, 'config')
              const del = grantsOf(a.id, 'destructive')
              return (
                <div
                  key={a.id}
                  className="rounded-card border border-border bg-bg-card p-4 flex flex-col gap-3 shadow-xs"
                >
                  {/* 顶栏：色点 + 助手名称 + 状态胶囊 | 右侧权限操作 */}
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2.5 min-w-0 flex-wrap">
                      <span
                        className="h-2.5 w-2.5 rounded-full shrink-0"
                        style={{ background: a.color ?? 'var(--color-accent)' }}
                      />
                      <span className="text-content font-semibold text-text-primary truncate">
                        {a.displayName}
                      </span>
                      <StatusBadge tone={a.approved ? 'success' : a.rejectedAt ? 'danger' : 'warning'}>
                        {a.approved ? '已批准写入' : a.rejectedAt ? '已拒绝' : '待批准'}
                      </StatusBadge>
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0">
                      {a.rejectedAt && (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy === a.id}
                          onClick={() => void setRejected(a.id, false)}
                        >
                          撤销拒绝
                        </Button>
                      )}
                      {!a.approved && !a.rejectedAt && (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy === a.id}
                          onClick={() => void setRejected(a.id, true)}
                        >
                          拒绝
                        </Button>
                      )}
                      <Button
                        variant={a.approved ? 'ghost' : 'primary'}
                        size="sm"
                        disabled={busy === a.id}
                        onClick={() => void setApproved(a.id, !a.approved)}
                      >
                        {a.approved ? '收回写入权限' : '批准写入'}
                      </Button>
                    </div>
                  </div>

                  {/* 底栏三列权限与活动概览：固定不折行标签，彻底消除「界面设 / 置」断行问题 */}
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 rounded-button bg-surface-subtle border border-border/60 px-3.5 py-2.5 text-caption">
                    <ScopeCell
                      label="界面设置"
                      state={
                        cfg.active
                          ? cfg.active.expiresAt
                            ? `已授权（至 ${fmtTime(cfg.active.expiresAt)}）`
                            : APPROVAL_ACTION.allowAlways
                          : '每次需申请'
                      }
                      active={Boolean(cfg.active)}
                      onRevoke={cfg.active ? () => void revokeGrants(a.id, 'config') : undefined}
                      revokeBusy={busy === `${a.id}:config`}
                    />
                    <ScopeCell
                      label="删除数据"
                      state={
                        del.active
                          ? '单次已授权'
                          : del.latest && isRetryableGrant(del.latest)
                            ? APPROVAL_ACTION.badgeForceConfirm
                            : '每次需申请'
                      }
                      active={Boolean(del.active)}
                      onRevoke={
                        del.active ? () => void revokeGrants(a.id, 'destructive') : undefined
                      }
                      revokeBusy={busy === `${a.id}:destructive`}
                    />
                    <div className="flex items-center justify-between sm:justify-start gap-2 min-w-0">
                      <span className="text-text-secondary shrink-0 whitespace-nowrap">最近活动</span>
                      <span className="text-text-primary truncate font-mono">
                        {a.lastWriteAt
                          ? `${humanizeWriteCmd(a.lastWriteCmd)} · ${fmtTime(a.lastWriteAt)}`
                          : '暂无记录'}
                      </span>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {error && (
        <p className="text-label text-danger inline-flex items-center gap-1.5 mt-2">
          <Icon name="alertTriangle" size={14} />
          {error}
        </p>
      )}
    </Section>
  )
}

const ScopeCell: React.FC<{
  label: string
  state: string
  active?: boolean
  onRevoke?: () => void
  revokeBusy?: boolean
}> = ({ label, state, active, onRevoke, revokeBusy }) => (
  <div className="flex items-center justify-between sm:justify-start gap-2 min-w-0">
    <span className="text-text-secondary shrink-0 whitespace-nowrap">{label}</span>
    <span className={active ? 'text-accent font-medium truncate' : 'text-text-primary truncate'}>
      {state}
    </span>
    {onRevoke && (
      <button
        type="button"
        disabled={revokeBusy}
        onClick={onRevoke}
        className="text-caption text-danger hover:underline shrink-0 cursor-pointer"
      >
        收回
      </button>
    )}
  </div>
)

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
