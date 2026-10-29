import React, { useEffect, useState } from 'react'
import { Input } from '../ui/Input'
import { Button } from '../ui/Button'
import { Select } from '../ui/Select'
import { MarkdownContent } from '../ui/MarkdownContent'
import { AgentAccessSection } from '../settings/sections/AgentAccessSection'
import { AgentRosterSection } from './AgentRosterSection'
import { useSettingsStore } from '../../stores/settings.store'
import { invoke } from '../../lib/ipc-client'
import { useUIStore } from '../../stores/ui.store'
import { getOnboardingStatus } from '../../lib/onboarding'
import { ownerLabel } from '../../lib/todo-filter'
import { stripMarkdown } from '../../lib/markdown'
import { cn } from '../../lib/utils'

const PROTOCOL_BLOCKS = ['roles', 'handoff', 'recording', 'communication', 'language'] as const
const PROFILE_BLOCKS = ['basics', 'habits', 'boundaries', 'completion'] as const
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

type ProtocolBlock = { blockKey: string; body: string; confirmed: boolean; source: string }
type ProfileBlock = { blockKey: string; body: string; confirmed: boolean; source: string }
type GateInfo = { id: string; what: string; enforcement: string; doThis: string; exitCode: number; errorCode: string | null }
type ProtocolProject = { id: string; name: string; archived: boolean; handoffMarkdown?: string | null }
type OnboardingAgent = { id: string; approved: boolean; hasCredential: boolean }

type ProfileRevision = { id: string; blockKey: string; body: string; confirmed: boolean; present: boolean; author: string; createdAt: string }
type ProtocolRevision = { id: string; blockKey: string; body: string; confirmed: boolean; present: boolean; author: string; createdAt: string }
type RuleItem = { key: string; category: string; what: string; enforcement: string; source: string }
type RuleRevision = { id: string; ruleKey: string; enforcement: string | null; hasOverride: boolean; author: string; createdAt: string }
type PermissionItem = { action: string; what: string; subject: string; decision: string; source: string }

/**
 * 面向普通用户的系统内置规则与流转守卫说明（去除 CLI 参数、内部代号与 Markdown 标记）
 */
const HUMAN_GATE_COPY: Record<string, { what: string; doThis: string }> = {
  G1: {
    what: '父需求还在「待确认」时，不能围绕它创建子任务',
    doThis: '需先由主用户拍板确认父需求进入执行阶段，再拆解子任务。'
  },
  G2: {
    what: '父需求转「待验收」时，其下所有子任务必须已全部完成',
    doThis: '请先将全部子任务推进至已完成，再把父需求提交验收。'
  },
  'G4-status': {
    what: '「待确认」的候选事项需经确认后才能流转到其他状态',
    doThis: '候选池由主用户拍板确认，AI 助手不能自行跳过确认环节。'
  },
  'G4-delete': {
    what: '删除「待确认」的事项需经审批授权',
    doThis: 'AI 助手发起删除申请后，需在「审批」页由你批准后当场执行。'
  },
  G6: {
    what: '父需求直接标记「已完成」时，其下所有子任务必须已全部完成',
    doThis: '请先完成所有子任务，或先将父需求转入「待验收」后再收口。'
  },
  G3: {
    what: '事项转「待验收」时未留下交付说明评论',
    doThis: '建议在事项评论中补充本次交付做了什么及验证结果，方便验收核对。'
  },
  G5: {
    what: '事项标记「已完成」时未留下结构化收口结论',
    doThis: '收口评论中应包含做了什么、如何验证与通过标准等关键要素。'
  },
  G7: {
    what: '「待确认」事项的描述缺少背景、目标或验收判据',
    doThis: '描述过于简略时系统会提醒补充背景与验收标准，便于评估拍板。'
  },
  G8: {
    what: 'AI 助手持有的接入说明版本落后于当前应用版本',
    doThis: '系统会提醒 AI 助手重新拉取最新版接入说明，保持协作规范同步。'
  },
  G9: {
    what: '在「待验收」事项下发表了评论，但未变更事项状态',
    doThis: '提醒验收人将结论同步落实到状态上（验收通过转「已完成」，驳回退回「进行中」）。'
  },
  G10: {
    what: '执行者不能自行验收自己负责的事项',
    doThis: '事项必须由执行者以外的验收人确认通过，避免自做自验。'
  },
  identity: {
    what: '未注册或未获批准的 AI 助手不能执行写入操作',
    doThis: '新接入的 AI 助手需先完成注册并在「审批」页获批后才能写入数据（只读查询不受影响）。'
  },
  grant: {
    what: '修改界面设置或删除数据等高危操作需单次审批授权',
    doThis: '系统会自动生成审批申请，由你在「审批」页批准后当场执行。'
  },
  ambiguous_identity: {
    what: '本机存在多个 AI 助手身份时，调用需明确声明当前身份',
    doThis: '要求 AI 助手在调用时显式携带自身身份标识，确保操作留痕可追溯。'
  },
  project_required: {
    what: '新建事项时必须指定所属项目',
    doThis: '每条事项都必须归属于明确的项目，避免产生无归属的孤儿事项。'
  }
}

const RULE_TABS = [
  { key: 'flow', label: '流转规则' },
  { key: 'permission', label: '权限矩阵' },
  { key: 'notice', label: '提醒' }
] as const

const ENFORCEMENT_LABELS: Record<string, string> = {
  block: '拦截',
  authorize: '需审批',
  notice: '仅提醒',
  off: '关闭'
}

const DECISION_LABELS: Record<string, string> = {
  allow: '允许',
  require_approval: '需审批',
  deny: '禁止'
}

type UserSection = 'about' | 'protocol' | 'rules' | 'team' | 'access'

const SECTIONS: Array<{ key: UserSection; label: string }> = [
  { key: 'about', label: '关于我' },
  { key: 'protocol', label: '协作协议' },
  { key: 'rules', label: '协作规则' },
  { key: 'team', label: '团队' },
  { key: 'access', label: '接入资料' }
]

/**
 * 用户与团队页（1.0.98 分区化）
 *
 * 统一承载「我 + 我的团队」：左导航分区，右侧内容。
 * 协议与档案只在这里维护；审批页只处理待确认申请，不放日常编辑。
 */
export const UserView: React.FC = () => {
  const { settings, updateSettings } = useSettingsStore()
  const [section, setSection] = useState<UserSection>('about')
  const [draft, setDraft] = useState(settings?.humanName ?? '')
  const [profileBlocks, setProfileBlocks] = useState<ProfileBlock[]>([])
  const [profileDrafts, setProfileDrafts] = useState<Record<string, string>>({})
  const [profileError, setProfileError] = useState('')
  const [protocolBlocks, setProtocolBlocks] = useState<ProtocolBlock[]>([])
  const [protocolDrafts, setProtocolDrafts] = useState<Record<string, string>>({})
  const [protocolProjects, setProtocolProjects] = useState<ProtocolProject[]>([])
  const [protocolProjectId, setProtocolProjectId] = useState('')
  const [protocolError, setProtocolError] = useState('')
  const [setupAgents, setSetupAgents] = useState<OnboardingAgent[]>([])
  const [ruleTab, setRuleTab] = useState<'flow' | 'permission' | 'notice'>('flow')
  const [rules, setRules] = useState<RuleItem[]>([])
  const [permissions, setPermissions] = useState<PermissionItem[]>([])
  const [rulesProjectId, setRulesProjectId] = useState('')
  const [rulesError, setRulesError] = useState('')
  const [profileRevisionKey, setProfileRevisionKey] = useState<string | null>(null)
  const [profileRevisions, setProfileRevisions] = useState<ProfileRevision[]>([])
  const [editingProfileKey, setEditingProfileKey] = useState<string | null>(null)
  const [protocolRevisionKey, setProtocolRevisionKey] = useState<string | null>(null)
  const [protocolRevisions, setProtocolRevisions] = useState<ProtocolRevision[]>([])
  const [editingProtocolKey, setEditingProtocolKey] = useState<string | null>(null)
  const [ruleRevisionKey, setRuleRevisionKey] = useState<string | null>(null)
  const [ruleRevisions, setRuleRevisions] = useState<RuleRevision[]>([])
  const [globalProtocolBlocks, setGlobalProtocolBlocks] = useState<ProtocolBlock[]>([])
  const [hardGates, setHardGates] = useState<GateInfo[]>([])
  const [showCompletedChecklist, setShowCompletedChecklist] = useState(false)
  const setMainView = useUIStore((state) => state.setMainView)
  const userEntryTarget = useUIStore((state) => state.userEntryTarget)
  const clearUserEntryTarget = useUIStore((state) => state.clearUserEntryTarget)

  useEffect(() => {
    if (!userEntryTarget) return
    setSection(userEntryTarget.section)
    if (userEntryTarget.projectId !== undefined) {
      setRulesProjectId(userEntryTarget.projectId)
      setProtocolProjectId(userEntryTarget.projectId)
    }
    clearUserEntryTarget()
  }, [userEntryTarget, clearUserEntryTarget])

  useEffect(() => {
    let alive = true
    const refresh = () => invoke('agent:list').then((agents) => {
      if (alive) setSetupAgents(agents as OnboardingAgent[])
    }).catch(() => undefined)
    void refresh()
    const timer = window.setInterval(() => void refresh(), 5000)
    return () => { alive = false; window.clearInterval(timer) }
  }, [])

  useEffect(() => {
    void invoke('protocol:get').then((result) => {
      setGlobalProtocolBlocks((result.blocks ?? []) as ProtocolBlock[])
      setHardGates((result.gates ?? []) as GateInfo[])
    }).catch((error) => setProtocolError(error instanceof Error ? error.message : String(error)))
  }, [])

  useEffect(() => {
    void invoke('project:list').then((projects) => {
      setProtocolProjects((projects as ProtocolProject[]).filter((project) => !project.archived))
    }).catch((error) => setProtocolError(error instanceof Error ? error.message : String(error)))
  }, [])

  useEffect(() => {
    setRuleRevisionKey(null)
    setRuleRevisions([])
    void invoke('rules:get', rulesProjectId ? { projectId: rulesProjectId } : undefined).then((result) => {
      setRules((result.rules ?? []) as RuleItem[])
      setPermissions((result.permissions ?? []) as PermissionItem[])
      setRulesError('')
    }).catch((error) => setRulesError(error instanceof Error ? error.message : String(error)))
  }, [rulesProjectId])

  useEffect(() => {
    void invoke('profile:get', protocolProjectId ? { projectId: protocolProjectId } : undefined).then((result) => {
      const blocks = (result.blocks ?? []) as ProfileBlock[]
      setProfileBlocks(blocks)
      setProfileDrafts(Object.fromEntries(blocks.map((block) => [block.blockKey, block.body])))
      setProfileError('')
    }).catch((error) => setProfileError(error instanceof Error ? error.message : String(error)))
  }, [protocolProjectId])

  useEffect(() => {
    setProfileRevisionKey(null)
    setProfileRevisions([])
    setEditingProfileKey(null)
    setProtocolRevisionKey(null)
    setProtocolRevisions([])
    setEditingProtocolKey(null)
    void invoke('protocol:get', protocolProjectId ? { projectId: protocolProjectId } : undefined).then((result) => {
      const blocks = (result.blocks ?? []) as ProtocolBlock[]
      setProtocolBlocks(blocks)
      setProtocolDrafts(Object.fromEntries(blocks.map((block) => [block.blockKey, block.body])))
      setHardGates((result.gates ?? []) as GateInfo[])
    }).catch((error) => setProtocolError(error instanceof Error ? error.message : String(error)))
  }, [protocolProjectId])

  const saveProfile = async (blockKey: string) => {
    try {
      const saved = await invoke('profile:set', { projectId: protocolProjectId || undefined, blockKey, body: profileDrafts[blockKey] ?? '' })
      setProfileBlocks((current) => current.map((block) => block.blockKey === blockKey ? { ...block, ...(saved as ProfileBlock) } : block))
      setEditingProfileKey((cur) => (cur === blockKey ? null : cur))
      if (profileRevisionKey === blockKey) {
        const revisions = await invoke('profile:revisions', { projectId: protocolProjectId || undefined, blockKey })
        setProfileRevisions(revisions as ProfileRevision[])
      }
      setProfileError('')
    } catch (error) {
      setProfileError(error instanceof Error ? error.message : String(error))
    }
  }

  const toggleProfileHistory = async (blockKey: string) => {
    if (profileRevisionKey === blockKey) {
      setProfileRevisionKey(null)
      return
    }
    setProfileRevisionKey(blockKey)
    try {
      const revisions = await invoke('profile:revisions', { projectId: protocolProjectId || undefined, blockKey })
      setProfileRevisions(revisions as ProfileRevision[])
    } catch (error) {
      setProfileError(error instanceof Error ? error.message : String(error))
    }
  }

  const rollbackProfile = async (revision: ProfileRevision) => {
    try {
      await invoke('profile:rollback', { id: revision.id })
      const result = await invoke('profile:get', protocolProjectId ? { projectId: protocolProjectId } : undefined)
      const blocks = result.blocks as ProfileBlock[]
      setProfileBlocks(blocks)
      setProfileDrafts(Object.fromEntries(blocks.map((block) => [block.blockKey, block.body])))
      const revisions = await invoke('profile:revisions', { projectId: protocolProjectId || undefined, blockKey: revision.blockKey })
      setProfileRevisions(revisions as ProfileRevision[])
      setProfileError('')
    } catch (error) {
      setProfileError(error instanceof Error ? error.message : String(error))
    }
  }

  const refreshRules = async () => {
    const result = await invoke('rules:get', rulesProjectId ? { projectId: rulesProjectId } : undefined)
    setRules((result.rules ?? []) as RuleItem[])
    setPermissions((result.permissions ?? []) as PermissionItem[])
  }

  const refreshRuleHistory = async (ruleKey: string) => {
    const revisions = await invoke('rules:revisions', { projectId: rulesProjectId || undefined, ruleKey })
    setRuleRevisions(revisions as RuleRevision[])
  }

  const updateRule = async (ruleKey: string, enforcement: string) => {
    try {
      await invoke('rules:setRule', { projectId: rulesProjectId || undefined, ruleKey, enforcement })
      await refreshRules()
      if (ruleRevisionKey === ruleKey) await refreshRuleHistory(ruleKey)
      setRulesError('')
    } catch (error) {
      setRulesError(error instanceof Error ? error.message : String(error))
    }
  }

  const resetRule = async (ruleKey: string) => {
    try {
      await invoke('rules:resetRule', { projectId: rulesProjectId || undefined, ruleKey })
      await refreshRules()
      if (ruleRevisionKey === ruleKey) await refreshRuleHistory(ruleKey)
      setRulesError('')
    } catch (error) {
      setRulesError(error instanceof Error ? error.message : String(error))
    }
  }

  const toggleRuleHistory = async (ruleKey: string) => {
    if (ruleRevisionKey === ruleKey) {
      setRuleRevisionKey(null)
      return
    }
    setRuleRevisionKey(ruleKey)
    try {
      await refreshRuleHistory(ruleKey)
    } catch (error) {
      setRulesError(error instanceof Error ? error.message : String(error))
    }
  }

  const rollbackRule = async (revision: RuleRevision) => {
    try {
      await invoke('rules:rollback', { id: revision.id })
      await refreshRules()
      const revisions = await invoke('rules:revisions', { projectId: rulesProjectId || undefined, ruleKey: revision.ruleKey })
      setRuleRevisions(revisions as RuleRevision[])
      setRulesError('')
    } catch (error) {
      setRulesError(error instanceof Error ? error.message : String(error))
    }
  }

  const saveProtocol = async (blockKey: string, confirmNow = true) => {
    try {
      const currentBlock = protocolBlocks.find((block) => block.blockKey === blockKey)
      const saved = await invoke('protocol:set', {
        projectId: protocolProjectId || undefined,
        blockKey,
        body: protocolDrafts[blockKey] ?? '',
        confirmed: confirmNow ? true : (currentBlock?.confirmed ?? false)
      })
      setProtocolBlocks((current) => current.map((block) => block.blockKey === blockKey ? { ...block, ...(saved as ProtocolBlock) } : block))
      if (!protocolProjectId) setGlobalProtocolBlocks((current) => current.map((block) => block.blockKey === blockKey ? { ...block, ...(saved as ProtocolBlock) } : block))
      setEditingProtocolKey((cur) => (cur === blockKey ? null : cur))
      if (protocolRevisionKey === blockKey) {
        const revisions = await invoke('protocol:revisions', { projectId: protocolProjectId || undefined, blockKey })
        setProtocolRevisions(revisions as ProtocolRevision[])
      }
      setProtocolError('')
    } catch (error) {
      setProtocolError(error instanceof Error ? error.message : String(error))
    }
  }

  const toggleProtocolHistory = async (blockKey: string) => {
    if (protocolRevisionKey === blockKey) {
      setProtocolRevisionKey(null)
      return
    }
    setProtocolRevisionKey(blockKey)
    try {
      const revisions = await invoke('protocol:revisions', { projectId: protocolProjectId || undefined, blockKey })
      setProtocolRevisions(revisions as ProtocolRevision[])
    } catch (error) {
      setProtocolError(error instanceof Error ? error.message : String(error))
    }
  }

  const rollbackProtocol = async (revision: ProtocolRevision) => {
    try {
      await invoke('protocol:rollback', { id: revision.id })
      const result = await invoke('protocol:get', protocolProjectId ? { projectId: protocolProjectId } : undefined)
      const blocks = (result.blocks ?? []) as ProtocolBlock[]
      setProtocolBlocks(blocks)
      setProtocolDrafts(Object.fromEntries(blocks.map((block) => [block.blockKey, block.body])))
      if (!protocolProjectId) setGlobalProtocolBlocks(blocks)
      const revisions = await invoke('protocol:revisions', { projectId: protocolProjectId || undefined, blockKey: revision.blockKey })
      setProtocolRevisions(revisions as ProtocolRevision[])
      setProtocolError('')
    } catch (error) {
      setProtocolError(error instanceof Error ? error.message : String(error))
    }
  }

  const confirmDefaultProtocol = async () => {
    try {
      const saved = await Promise.all(PROTOCOL_BLOCKS.map((blockKey) =>
        invoke('protocol:set', { blockKey, body: globalProtocolBlocks.find((block) => block.blockKey === blockKey)?.body ?? '', confirmed: true })
      ))
      setGlobalProtocolBlocks(saved as ProtocolBlock[])
      if (!protocolProjectId) setProtocolBlocks(saved as ProtocolBlock[])
      setProtocolError('')
    } catch (error) {
      setProtocolError(error instanceof Error ? error.message : String(error))
    }
  }

  const { hasRegisteredAgent, hasApprovedCredential, basicsConfirmed, globalProtocolConfirmed, projectHandoffConfirmed } =
    getOnboardingStatus(setupAgents, profileBlocks, globalProtocolBlocks, protocolProjects)
  const setupChecklist = [
    { label: '已登记一个 AI 助手', done: hasRegisteredAgent, action: '去接入资料', onClick: () => setSection('access') },
    { label: '至少一个助手已获批准并持有凭据', done: hasApprovedCredential, action: '前往审批页', onClick: () => setMainView('approval') },
    { label: '主用户基本情况已填写并确认', done: basicsConfirmed, action: '完善关于我', onClick: () => setSection('about') },
    { label: '全局协作协议已由你确认', done: globalProtocolConfirmed, action: '查看默认协议', onClick: () => setSection('protocol') },
    { label: '至少一个项目已有已确认的接手说明', done: projectHandoffConfirmed, action: '查看项目', onClick: () => setMainView('board') }
  ]
  const completedSetupCount = setupChecklist.filter((item) => item.done).length

  const selectedProject = protocolProjects.find((project) => project.id === protocolProjectId)
  const protocolScopeLabel = selectedProject ? `项目协议 · ${selectedProject.name}` : '全局协议 · 默认稿'
  const protocolSourceLabel = protocolProjectId
    ? '项目没有覆盖的区块会沿用全局协议'
    : '全局协议是所有项目的默认协作方式'

  useEffect(() => {
    setDraft(settings?.humanName ?? '')
  }, [settings?.humanName])

  const commit = (value: string) => {
    void updateSettings({ humanName: value.trim(), humanNameAsked: true })
  }

  const displayName = settings.humanName?.trim() || '我'

  return (
    <div className="flex-1 min-h-0 flex">
      {/* 左导航：分区列表 */}
      <nav aria-label="用户与团队分区" className="w-44 shrink-0 border-r border-border bg-surface-subtle py-4 px-2 flex flex-col gap-0.5">
        {SECTIONS.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => setSection(item.key)}
            aria-current={section === item.key ? 'page' : undefined}
            className={cn(
              'w-full text-left px-3 py-2 rounded-button text-label transition-colors cursor-pointer',
              section === item.key
                ? 'bg-accent text-white font-medium'
                : 'text-text-secondary hover:bg-surface-muted hover:text-text-primary'
            )}
          >
            {item.label}
          </button>
        ))}
      </nav>

      {/* 右内容区 */}
      <div className="flex-1 min-w-0 overflow-y-auto px-6 py-5">
        <div className="max-w-4xl mx-auto w-full flex flex-col gap-4">
          {setupAgents.some((agent) => !agent.approved) && (
            <div className="rounded-card border border-warning/30 bg-warning/10 px-4 py-3 flex items-center justify-between gap-3">
              <span className="text-label text-text-primary">有新接入的 AI 助手正在等待批准写入权限。</span>
              <Button type="button" variant="primary" size="sm" onClick={() => setMainView('approval')}>
                去审批
              </Button>
            </div>
          )}

          {section === 'about' && (
            <>
              {/* 主用户卡：只在“关于我”分区显示，避免每个分区重复 */}
              <div className="rounded-card border border-border bg-bg-card p-4 shadow-sm flex items-center gap-3.5 shrink-0">
                <span className="w-10 h-10 rounded-full bg-accent text-white text-body font-medium flex items-center justify-center shrink-0">
                  {displayName.slice(0, 1)}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="text-body font-medium text-text-primary">{displayName}</div>
                  <div className="text-label text-text-secondary mt-0.5">
                    主用户
                  </div>
                </div>
                <div className="shrink-0 w-44">
                  <Input
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={(e) => commit(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commit((e.target as HTMLInputElement).value)
                    }}
                    placeholder="怎么称呼你"
                    maxLength={20}
                    className="h-8 rounded-input border border-border px-2.5 text-label"
                    title="改称呼（留空则沿用「我」）"
                  />
                </div>
              </div>

              {/* 上手清单：未完成时展开，全部完成后自动收起为紧凑状态条（可按需展开） */}
              <section
                className="rounded-card border border-border bg-bg-card px-4 py-3 shadow-sm shrink-0"
                aria-labelledby="onboarding-checklist-title"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        'w-2 h-2 rounded-full shrink-0',
                        completedSetupCount === setupChecklist.length ? 'bg-success' : 'bg-accent'
                      )}
                    />
                    <h2 id="onboarding-checklist-title" className="text-content font-semibold text-text-primary">
                      接入上手清单
                    </h2>
                    {completedSetupCount === setupChecklist.length && (
                      <span className="text-caption text-text-secondary">已全部完成</span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-caption font-mono text-text-secondary">
                      {completedSetupCount} / {setupChecklist.length}
                    </span>
                    {completedSetupCount === setupChecklist.length && (
                      <button
                        type="button"
                        onClick={() => setShowCompletedChecklist((prev) => !prev)}
                        className="text-caption text-accent hover:underline cursor-pointer"
                      >
                        {showCompletedChecklist ? '收起' : '展开查看'}
                      </button>
                    )}
                  </div>
                </div>
                {(completedSetupCount < setupChecklist.length || showCompletedChecklist) && (
                  <ol className="mt-3 grid gap-2 sm:grid-cols-2">
                    {setupChecklist.map((item) => (
                      <li key={item.label} className="flex items-center gap-2 rounded-input bg-surface-subtle border border-border/60 px-3 py-2">
                        <span aria-label={item.done ? '已完成' : '未完成'} className={item.done ? 'text-success font-medium' : 'text-text-secondary/50'}>{item.done ? '✓' : '○'}</span>
                        <span className={`flex-1 text-label ${item.done ? 'text-text-secondary' : 'text-text-primary'}`}>{item.label}</span>
                        {!item.done && <button type="button" className="text-label text-accent hover:underline cursor-pointer" onClick={item.onClick}>{item.action}</button>}
                      </li>
                    ))}
                  </ol>
                )}
              </section>

              {/* 关于我 */}
              <section className="rounded-card border border-border bg-bg-card p-5 shadow-sm shrink-0">
                <div className="flex items-start justify-between gap-3 pb-3 border-b border-border/60">
                  <div>
                    <h2 className="text-column-title font-semibold text-text-primary">关于我</h2>
                    <p className="text-label text-text-secondary mt-1">供 Agent 了解你的偏好与协作边界。</p>
                  </div>
                  <span className="px-2 py-0.5 rounded-xs bg-surface-subtle text-caption text-text-secondary">{protocolProjectId ? '项目覆盖' : '全局档案'}</span>
                </div>
                {profileError && <p className="mt-2 text-label text-danger">{profileError}</p>}
                <div className="mt-4 grid gap-3.5">
                  {PROFILE_BLOCKS.map((key) => {
                    const block = profileBlocks.find((item) => item.blockKey === key)
                    const projectOnly = protocolProjectId && (key === 'basics' || key === 'habits')
                    const showingHistory = profileRevisionKey === key
                    const currentBody = block?.body ?? ''
                    const draftBody = profileDrafts[key] ?? currentBody
                    const isEditing = !projectOnly && (editingProfileKey === key || !currentBody.trim())
                    const rowCount = Math.max(3, Math.min(14, draftBody.split('\n').length + 1))
                    return (
                      <div key={key} className="grid gap-1.5 rounded-card border border-border/70 bg-surface-subtle p-3.5">
                        <div className="flex items-center justify-between gap-2 flex-wrap">
                          <div className="flex items-center gap-2">
                            <span className="text-content font-semibold text-text-primary">
                              {PROFILE_LABELS[key]}
                            </span>
                            <span className="px-2 py-0.5 rounded-full bg-bg-card border border-border/60 text-caption text-text-secondary">
                              {protocolProjectId ? (block?.source === 'project' ? '项目覆盖' : '沿用全局') : '全局'}
                            </span>
                            {block?.confirmed && currentBody.trim() && (
                              <span className="px-2 py-0.5 rounded-full bg-success/10 text-success text-caption font-medium">
                                已确认
                              </span>
                            )}
                          </div>
                          {!projectOnly && (
                            <div className="flex items-center gap-1.5">
                              {currentBody.trim() && (
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="ghost"
                                  className="border border-border bg-bg-card hover:bg-surface-muted px-2.5 text-text-primary cursor-pointer"
                                  onClick={() => {
                                    if (editingProfileKey === key) {
                                      setProfileDrafts((cur) => ({ ...cur, [key]: currentBody }))
                                      setEditingProfileKey(null)
                                    } else {
                                      setProfileDrafts((cur) => ({ ...cur, [key]: currentBody }))
                                      setEditingProfileKey(key)
                                    }
                                  }}
                                >
                                  {editingProfileKey === key ? '取消编辑' : '编辑'}
                                </Button>
                              )}
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                aria-expanded={showingHistory}
                                className="border border-border bg-bg-card hover:bg-surface-muted px-2.5 text-text-primary cursor-pointer"
                                onClick={() => void toggleProfileHistory(key)}
                              >
                                修订历史
                              </Button>
                            </div>
                          )}
                        </div>
                        {!isEditing && currentBody.trim() ? (
                          <div
                            role="button"
                            tabIndex={0}
                            onClick={() => {
                              if (!projectOnly) {
                                setProfileDrafts((cur) => ({ ...cur, [key]: currentBody }))
                                setEditingProfileKey(key)
                              }
                            }}
                            onKeyDown={(e) => {
                              if (!projectOnly && (e.key === 'Enter' || e.key === ' ')) {
                                e.preventDefault()
                                setProfileDrafts((cur) => ({ ...cur, [key]: currentBody }))
                                setEditingProfileKey(key)
                              }
                            }}
                            title={projectOnly ? undefined : '点击编辑'}
                            className={cn(
                              'rounded-input border border-border/60 bg-bg-card px-3.5 py-2.5 transition-colors',
                              !projectOnly && 'hover:border-border cursor-text'
                            )}
                          >
                            <MarkdownContent content={currentBody} />
                          </div>
                        ) : (
                          <div className="grid gap-2">
                            <textarea
                              value={draftBody}
                              onChange={(event) => setProfileDrafts((current) => ({ ...current, [key]: event.target.value }))}
                              rows={rowCount}
                              disabled={Boolean(projectOnly)}
                              placeholder={key === 'basics' ? '例如：怎么称呼、角色、语言、时区' : key === 'habits' ? '例如：偏好的汇报方式、节奏和沟通习惯' : key === 'boundaries' ? '例如：哪些事情 agent 可以自主决定，哪些必须先问' : '例如：什么条件满足时可以称为完成'}
                              className="w-full rounded-input border border-border bg-bg-card px-3 py-2 text-label text-text-primary leading-relaxed resize-y focus:border-accent outline-none transition-colors disabled:opacity-60"
                            />
                            {!projectOnly && (
                              <div className="flex items-center justify-end gap-2">
                                {currentBody.trim() && (
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => {
                                      setProfileDrafts((cur) => ({ ...cur, [key]: currentBody }))
                                      setEditingProfileKey(null)
                                    }}
                                  >
                                    取消
                                  </Button>
                                )}
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="primary"
                                  disabled={!draftBody.trim()}
                                  onClick={() => void saveProfile(key)}
                                >
                                  保存并确认
                                </Button>
                              </div>
                            )}
                          </div>
                        )}
                        {showingHistory && (
                          <div className="grid gap-2 rounded-input border border-border bg-bg-card p-3" aria-label={`${PROFILE_LABELS[key]}修订历史`}>
                            {profileRevisions.length === 0 ? <p className="text-label text-text-secondary">暂无修订记录。</p> : profileRevisions.map((revision) => (
                              <div key={revision.id} className="flex items-start gap-3 border-b border-border/60 pb-2 last:border-0 last:pb-0">
                                <div className="min-w-0 flex-1">
                                  <div className="text-caption text-text-secondary">{new Date(revision.createdAt).toLocaleString('zh-CN')} · {ownerLabel(revision.author, settings?.humanName)} · {revision.present ? (revision.confirmed ? '已确认' : '未确认') : '当时没有本项目覆盖'}</div>
                                  <p className="mt-1 whitespace-pre-wrap break-words text-label text-text-primary">{revision.present ? revision.body : (protocolProjectId ? '恢复后将沿用当前全局内容。' : '当时尚未填写。')}</p>
                                </div>
                                <Button type="button" size="sm" variant="ghost" className="border border-border bg-surface-subtle hover:bg-surface-muted px-2.5 text-text-primary cursor-pointer shrink-0" onClick={() => void rollbackProfile(revision)}>恢复到此版本</Button>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </section>
            </>
          )}

          {/* 协作协议 */}
          {section === 'protocol' && (
            <section className="rounded-card border border-border bg-bg-card p-5 shadow-sm shrink-0">
              <div className="flex flex-wrap items-start justify-between gap-3 pb-3 border-b border-border/60">
                <div>
                  <h2 className="text-column-title font-semibold text-text-primary">协作协议</h2>
                  <p className="mt-1 text-label text-text-secondary">{protocolSourceLabel}</p>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-caption text-text-secondary">
                    {protocolScopeLabel} · {protocolBlocks.length > 0 && protocolBlocks.every((block) => block.confirmed) ? '用户已确认' : '默认稿/覆盖内容尚未确认'}
                  </span>
                  <Select
                    ariaLabel="选择协议范围"
                    value={protocolProjectId}
                    onChange={setProtocolProjectId}
                    options={[
                      { value: '', label: '全局协议' },
                      ...protocolProjects.map((project) => ({ value: project.id, label: project.name }))
                    ]}
                  />
                </div>
              </div>
              {protocolProjects.length > 0 && (
                <div className="mt-3 flex items-center gap-1.5 flex-wrap">
                  <span className="text-caption text-text-secondary mr-1">适用范围：</span>
                  <button
                    type="button"
                    onClick={() => setProtocolProjectId('')}
                    className={cn(
                      'h-7 px-2.5 rounded-button text-caption border transition-colors cursor-pointer',
                      !protocolProjectId
                        ? 'bg-accent/10 text-accent border-accent/30 font-semibold'
                        : 'bg-surface-subtle text-text-secondary border-border/70 hover:text-text-primary'
                    )}
                  >
                    全局协议
                  </button>
                  {protocolProjects.map((project) => {
                    const active = protocolProjectId === project.id
                    return (
                      <button
                        key={project.id}
                        type="button"
                        onClick={() => setProtocolProjectId(project.id)}
                        className={cn(
                          'h-7 px-2.5 rounded-button text-caption border transition-colors cursor-pointer',
                          active
                            ? 'bg-accent/10 text-accent border-accent/30 font-semibold'
                            : 'bg-surface-subtle text-text-secondary border-border/70 hover:text-text-primary'
                        )}
                      >
                        项目 · {project.name}
                      </button>
                    )
                  })}
                </div>
              )}
              <details className="mt-3 rounded-input border border-border bg-surface-subtle p-3">
                <summary className="cursor-pointer text-label font-medium text-text-primary">查看系统内置规则（{hardGates.length} 条）</summary>
                <p className="mt-2 text-caption text-text-secondary">以下为系统内置规则，具体拦截方式可在「协作规则」中调整。</p>
                <ul className="mt-2 grid gap-2">
                  {hardGates.map((gate, idx) => {
                    const copy = HUMAN_GATE_COPY[gate.id]
                    const whatText = copy?.what ?? stripMarkdown(gate.what)
                    const doThisText = copy?.doThis ?? stripMarkdown(gate.doThis)
                    return (
                      <li key={gate.id} className="rounded-input bg-bg-card border border-border/50 px-3 py-2">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="text-content font-normal text-text-primary">
                            {idx + 1}. {whatText}
                          </span>
                          <span className="rounded-full bg-surface-muted px-2 py-0.5 text-caption text-text-secondary">
                            默认强度：{ENFORCEMENT_LABELS[gate.enforcement] ?? gate.enforcement}
                          </span>
                        </div>
                        <p className="mt-1 text-caption text-text-secondary">说明：{doThisText}</p>
                      </li>
                    )
                  })}
                </ul>
              </details>
              {!protocolProjectId && !globalProtocolConfirmed && globalProtocolBlocks.length > 0 && (
                <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-input border border-warning/30 bg-warning/10 px-3 py-2">
                  <span className="text-label text-warning font-medium">当前为默认模板，尚未确认。</span>
                  <button type="button" className="h-7 rounded-button bg-accent px-3 text-label text-white hover:opacity-90 cursor-pointer" onClick={() => void confirmDefaultProtocol()}>确认全部协议</button>
                </div>
              )}
              {protocolError && <p className="mt-2 text-label text-danger">{protocolError}</p>}
              <div className="mt-4 grid gap-3.5">
                {PROTOCOL_BLOCKS.map((key) => {
                  const block = protocolBlocks.find((item) => item.blockKey === key)
                  const currentBody = block?.body ?? ''
                  const draftBody = protocolDrafts[key] ?? currentBody
                  const isEditing = editingProtocolKey === key
                  const showingHistory = protocolRevisionKey === key
                  const rowCount = Math.max(4, Math.min(16, draftBody.split('\n').length + 1))
                  return (
                    <div key={key} className="grid gap-1.5 rounded-card border border-border/70 bg-surface-subtle p-3.5">
                      <div className="flex items-center justify-between gap-2 flex-wrap">
                        <div className="flex items-center gap-2">
                          <span className="text-content font-semibold text-text-primary">
                            {PROTOCOL_LABELS[key] ?? key}
                          </span>
                          <span className="px-2 py-0.5 rounded-full bg-bg-card border border-border/60 text-caption text-text-secondary">
                            {protocolProjectId ? (block?.source === 'project' ? '项目覆盖' : '沿用全局') : '全局'}
                          </span>
                          <span
                            className={cn(
                              'px-2 py-0.5 rounded-full text-caption font-medium',
                              block?.confirmed
                                ? 'bg-success/10 text-success'
                                : 'bg-warning/10 text-warning'
                            )}
                          >
                            {block?.confirmed ? '已确认' : '待确认'}
                          </span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          {!block?.confirmed && !isEditing && (
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              className="border border-accent/30 bg-accent/10 text-accent hover:bg-accent/15 px-2.5 cursor-pointer"
                              onClick={() => void saveProtocol(key, true)}
                            >
                              确认本项
                            </Button>
                          )}
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className="border border-border bg-bg-card hover:bg-surface-muted px-2.5 text-text-primary cursor-pointer"
                            onClick={() => {
                              if (isEditing) {
                                setProtocolDrafts((cur) => ({ ...cur, [key]: currentBody }))
                                setEditingProtocolKey(null)
                              } else {
                                setProtocolDrafts((cur) => ({ ...cur, [key]: currentBody }))
                                setEditingProtocolKey(key)
                              }
                            }}
                          >
                            {isEditing ? '取消编辑' : '编辑'}
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            aria-expanded={showingHistory}
                            className="border border-border bg-bg-card hover:bg-surface-muted px-2.5 text-text-primary cursor-pointer"
                            onClick={() => void toggleProtocolHistory(key)}
                          >
                            修订历史
                          </Button>
                        </div>
                      </div>

                      {!isEditing ? (
                        <div
                          role="button"
                          tabIndex={0}
                          onClick={() => {
                            setProtocolDrafts((cur) => ({ ...cur, [key]: currentBody }))
                            setEditingProtocolKey(key)
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault()
                              setProtocolDrafts((cur) => ({ ...cur, [key]: currentBody }))
                              setEditingProtocolKey(key)
                            }
                          }}
                          title="点击切入编辑"
                          className="rounded-input border border-border/60 bg-bg-card px-3.5 py-2.5 hover:border-border transition-colors cursor-text"
                        >
                          <MarkdownContent content={currentBody} />
                        </div>
                      ) : (
                        <div className="grid gap-2">
                          <textarea
                            value={draftBody}
                            onChange={(event) => setProtocolDrafts((current) => ({ ...current, [key]: event.target.value }))}
                            rows={rowCount}
                            className="w-full rounded-input border border-border bg-bg-card px-3 py-2 text-label text-text-primary leading-relaxed resize-y focus:border-accent outline-none transition-colors"
                          />
                          <div className="flex items-center justify-end gap-2">
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              onClick={() => {
                                setProtocolDrafts((cur) => ({ ...cur, [key]: currentBody }))
                                setEditingProtocolKey(null)
                              }}
                            >
                              取消
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="primary"
                              disabled={!draftBody.trim()}
                              onClick={() => void saveProtocol(key, true)}
                            >
                              保存并确认
                            </Button>
                          </div>
                        </div>
                      )}

                      {showingHistory && (
                        <div className="grid gap-2 rounded-input border border-border bg-bg-card p-3" aria-label={`${PROTOCOL_LABELS[key] ?? key}修订历史`}>
                          {protocolRevisions.length === 0 ? (
                            <p className="text-label text-text-secondary">暂无修订记录。</p>
                          ) : (
                            protocolRevisions.map((revision) => (
                              <div key={revision.id} className="flex items-start gap-3 border-b border-border/60 pb-2 last:border-0 last:pb-0">
                                <div className="min-w-0 flex-1">
                                  <div className="text-caption text-text-secondary">
                                    {new Date(revision.createdAt).toLocaleString('zh-CN')} · {ownerLabel(revision.author, settings?.humanName)} · {revision.confirmed ? '已确认' : '未确认'}
                                  </div>
                                  <p className="mt-1 whitespace-pre-wrap break-words text-label text-text-primary">
                                    {revision.body}
                                  </p>
                                </div>
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="ghost"
                                  className="border border-border bg-surface-subtle hover:bg-surface-muted px-2.5 text-text-primary cursor-pointer shrink-0"
                                  onClick={() => void rollbackProtocol(revision)}
                                >
                                  恢复到此版本
                                </Button>
                              </div>
                            ))
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </section>
          )}

          {/* 协作规则配置：流转规则 / 权限矩阵 / 提醒 */}
          {section === 'rules' && (
            <section className="rounded-card border border-border bg-bg-card p-5 shadow-sm shrink-0">
              <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-border/60">
                <div className="flex items-center gap-4">
                  <h2 className="text-column-title font-semibold text-text-primary">协作规则</h2>
                  <div className="inline-flex items-center gap-1 rounded-button bg-surface-subtle p-1 border border-border/70">
                    {RULE_TABS.map((tab) => (
                      <button
                        key={tab.key}
                        type="button"
                        className={cn(
                          'px-3 py-1 rounded-xs text-label transition-colors cursor-pointer',
                          ruleTab === tab.key
                            ? 'bg-bg-card text-text-primary font-semibold shadow-sm'
                            : 'text-text-secondary hover:text-text-primary'
                        )}
                        onClick={() => setRuleTab(tab.key)}
                      >
                        {tab.label}
                      </button>
                    ))}
                  </div>
                </div>
                <Select
                  ariaLabel="规则范围"
                  value={rulesProjectId}
                  onChange={setRulesProjectId}
                  options={[
                    { value: '', label: '全局规则' },
                    ...protocolProjects.map((project) => ({ value: project.id, label: project.name }))
                  ]}
                />
              </div>

              {protocolProjects.length > 0 && (
                <div className="mt-3 flex items-center gap-1.5 flex-wrap">
                  <span className="text-caption text-text-secondary mr-1">适用范围：</span>
                  <button
                    type="button"
                    onClick={() => setRulesProjectId('')}
                    className={cn(
                      'h-7 px-2.5 rounded-button text-caption border transition-colors cursor-pointer',
                      !rulesProjectId
                        ? 'bg-accent/10 text-accent border-accent/30 font-semibold'
                        : 'bg-surface-subtle text-text-secondary border-border/70 hover:text-text-primary'
                    )}
                  >
                    全局规则
                  </button>
                  {protocolProjects.map((project) => {
                    const active = rulesProjectId === project.id
                    return (
                      <button
                        key={project.id}
                        type="button"
                        onClick={() => setRulesProjectId(project.id)}
                        className={cn(
                          'h-7 px-2.5 rounded-button text-caption border transition-colors cursor-pointer',
                          active
                            ? 'bg-accent/10 text-accent border-accent/30 font-semibold'
                            : 'bg-surface-subtle text-text-secondary border-border/70 hover:text-text-primary'
                        )}
                      >
                        项目 · {project.name}
                      </button>
                    )
                  })}
                </div>
              )}

              {rulesError && <p className="mt-2 text-label text-danger">{rulesError}</p>}

              {/* 流转规则 */}
              {ruleTab === 'flow' && (
                <div className="mt-4 space-y-2">
                  {rules.filter((r) => r.category === 'flow').map((rule) => (
                    <React.Fragment key={rule.key}>
                      <div className="flex items-center justify-between gap-3 rounded-button border border-border/70 bg-surface-subtle px-3.5 py-2.5">
                        <div className="flex-1 min-w-0">
                          <div className="text-content font-normal text-text-primary truncate">{HUMAN_GATE_COPY[rule.key]?.what ?? stripMarkdown(rule.what)}</div>
                          <span className="text-caption text-text-secondary">来源：{rule.source === 'default' ? '出厂默认' : rule.source === 'global' ? '全局配置' : '项目覆盖'}</span>
                        </div>
                        <Select
                          ariaLabel={`${rule.key} 强度`}
                          value={rule.enforcement}
                          onChange={(value) => void updateRule(rule.key, value)}
                          options={['block', 'authorize', 'notice', 'off'].map((value) => ({
                            value,
                            label: ENFORCEMENT_LABELS[value] ?? value
                          }))}
                        />
                        <Button type="button" size="sm" variant="ghost" className="border border-border bg-bg-card hover:bg-surface-muted px-2.5 text-text-primary cursor-pointer" aria-expanded={ruleRevisionKey === rule.key} onClick={() => void toggleRuleHistory(rule.key)}>修订历史</Button>
                        {(rulesProjectId ? rule.source === 'project' : rule.source === 'global') && (
                          <Button type="button" size="sm" variant="ghost" className="border border-border bg-bg-card hover:bg-surface-muted px-2.5 text-text-primary cursor-pointer" aria-label={`${rule.key} 恢复继承或默认值`} onClick={() => void resetRule(rule.key)}>{rulesProjectId ? '恢复继承' : '恢复默认'}</Button>
                        )}
                      </div>
                      {ruleRevisionKey === rule.key && (
                        <div className="grid gap-2 rounded-input border border-border bg-surface-subtle p-3" aria-label={`${rule.key}修订历史`}>
                          {ruleRevisions.length === 0 ? <p className="text-label text-text-secondary">暂无修订记录。</p> : ruleRevisions.map((revision) => (
                            <div key={revision.id} className="flex items-center gap-3 border-b border-border/60 pb-2 last:border-0 last:pb-0">
                              <div className="min-w-0 flex-1">
                                <div className="text-caption text-text-secondary">{new Date(revision.createdAt).toLocaleString('zh-CN')} · {ownerLabel(revision.author, settings?.humanName)}</div>
                                <div className="mt-1 text-label text-text-primary">{revision.hasOverride ? `本层配置：${ENFORCEMENT_LABELS[revision.enforcement ?? ''] ?? revision.enforcement}` : (rulesProjectId ? '本层无覆盖：沿用全局或出厂默认' : '本层无覆盖：采用出厂默认')}</div>
                              </div>
                              <Button type="button" size="sm" variant="ghost" onClick={() => void rollbackRule(revision)}>恢复到此版本</Button>
                            </div>
                          ))}
                        </div>
                      )}
                    </React.Fragment>
                  ))}
                </div>
              )}

              {/* 权限矩阵 */}
              {ruleTab === 'permission' && (
                <div className="mt-4">
                  <p className="text-label text-text-secondary mb-2.5">权限仅可在界面中修改。</p>
                  <div className="rounded-button border border-border overflow-hidden">
                    <table className="w-full text-label">
                      <thead>
                        <tr className="border-b border-border bg-surface-subtle">
                          <th className="text-left py-2 px-3 text-text-secondary font-medium">动作</th>
                          <th className="text-left py-2 px-3 text-text-secondary font-medium">主体</th>
                          <th className="text-right py-2 px-3 text-text-secondary font-medium">决定</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border/60">
                        {permissions.map((perm, idx) => (
                          <tr key={`${perm.action}-${perm.subject}-${idx}`} className="hover:bg-surface-subtle transition-colors">
                            <td className="py-2 px-3 text-text-primary">{perm.what}</td>
                            <td className="py-2 px-3 text-text-secondary">{perm.subject === 'human' ? '主用户' : perm.subject === 'all_agents' ? '全部 agent' : perm.subject}</td>
                            <td className="py-2 px-3 text-right">
                              <Select
                                ariaLabel={`${perm.what} ${perm.subject}`}
                                value={perm.decision}
                                onChange={async (val) => {
                                  try {
                                    await invoke('rules:setPermission', { projectId: rulesProjectId || undefined, action: perm.action, subject: perm.subject, decision: val })
                                    const result = await invoke('rules:get', rulesProjectId ? { projectId: rulesProjectId } : undefined)
                                    setPermissions((result.permissions ?? []) as PermissionItem[])
                                  } catch (err) { setRulesError(err instanceof Error ? err.message : String(err)) }
                                }}
                                options={['allow', 'require_approval', 'deny'].map((v) => ({
                                  value: v,
                                  label: DECISION_LABELS[v] ?? v
                                }))}
                              />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* 提醒 */}
              {ruleTab === 'notice' && (
                <div className="mt-4 space-y-2">
                  {rules.filter((r) => r.category === 'notice').map((rule) => (
                    <React.Fragment key={rule.key}>
                      <div className="flex items-center justify-between gap-3 rounded-button border border-border/70 bg-surface-subtle px-3.5 py-2.5">
                        <div className="flex-1 min-w-0">
                          <div className="text-content font-normal text-text-primary truncate">{HUMAN_GATE_COPY[rule.key]?.what ?? stripMarkdown(rule.what)}</div>
                          <span className="text-caption text-text-secondary">来源：{rule.source === 'default' ? '出厂默认' : rule.source === 'global' ? '全局配置' : '项目覆盖'}</span>
                        </div>
                        <Select
                          ariaLabel={`${rule.key} 提醒`}
                          value={rule.enforcement}
                          onChange={(value) => void updateRule(rule.key, value)}
                          options={['notice', 'off'].map((value) => ({
                            value,
                            label: ENFORCEMENT_LABELS[value] ?? value
                          }))}
                        />
                        <Button type="button" size="sm" variant="ghost" className="border border-border bg-bg-card hover:bg-surface-muted px-2.5 text-text-primary cursor-pointer" aria-expanded={ruleRevisionKey === rule.key} onClick={() => void toggleRuleHistory(rule.key)}>修订历史</Button>
                        {(rulesProjectId ? rule.source === 'project' : rule.source === 'global') && (
                          <Button type="button" size="sm" variant="ghost" className="border border-border bg-bg-card hover:bg-surface-muted px-2.5 text-text-primary cursor-pointer" aria-label={`${rule.key} 恢复继承或默认值`} onClick={() => void resetRule(rule.key)}>{rulesProjectId ? '恢复继承' : '恢复默认'}</Button>
                        )}
                      </div>
                      {ruleRevisionKey === rule.key && (
                        <div className="grid gap-2 rounded-input border border-border bg-surface-subtle p-3" aria-label={`${rule.key}修订历史`}>
                          {ruleRevisions.length === 0 ? <p className="text-label text-text-secondary">暂无修订记录。</p> : ruleRevisions.map((revision) => (
                            <div key={revision.id} className="flex items-center gap-3 border-b border-border/60 pb-2 last:border-0 last:pb-0">
                              <div className="min-w-0 flex-1">
                                <div className="text-caption text-text-secondary">{new Date(revision.createdAt).toLocaleString('zh-CN')} · {ownerLabel(revision.author, settings?.humanName)}</div>
                                <div className="mt-1 text-label text-text-primary">{revision.hasOverride ? `本层配置：${ENFORCEMENT_LABELS[revision.enforcement ?? ''] ?? revision.enforcement}` : (rulesProjectId ? '本层无覆盖：沿用全局或出厂默认' : '本层无覆盖：采用出厂默认')}</div>
                              </div>
                              <Button type="button" size="sm" variant="ghost" onClick={() => void rollbackRule(revision)}>恢复到此版本</Button>
                            </div>
                          ))}
                        </div>
                      )}
                    </React.Fragment>
                  ))}
                </div>
              )}
            </section>
          )}

          {/* 团队 */}
          {section === 'team' && <AgentRosterSection />}

          {/* 接入资料 */}
          {section === 'access' && <div id="agent-access"><AgentAccessSection /></div>}
        </div>
      </div>
    </div>
  )
}
