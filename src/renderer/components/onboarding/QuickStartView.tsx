import React, { useCallback, useEffect, useState } from 'react'
import { Button } from '../ui/Button'
import { TodoStatusPill } from '../ui/Badge'
import { Segmented } from '../settings/Section'
import { Icon } from '../ui/Icon'
import { useUIStore } from '../../stores/ui.store'
import { useProjectStore } from '../../stores/project.store'
import { invoke } from '../../lib/ipc-client'
import { buildFreshPrompt, buildMigratePrompt, RECOMMENDED_AGENTS } from '../../lib/onboarding-prompts'
import { useCliAccess } from '../../lib/use-cli-access'
import { isPendingAgent } from '../../lib/grant-state'
import type { Agent } from '../../types/todo'
import { cn } from '../../lib/utils'

type DocSectionKey = 'quickstart' | 'workflow' | 'projects' | 'agents' | 'desktop' | 'data'
type PathKey = 'A' | 'B'

const DOC_SECTIONS: Array<{ key: DocSectionKey; label: string; badge?: string }> = [
  { key: 'quickstart', label: '1. 快速上手' },
  { key: 'workflow', label: '2. 事项与工作流' },
  { key: 'projects', label: '3. 项目与工作台' },
  { key: 'agents', label: '4. AI 团队与审批' },
  { key: 'desktop', label: '5. 桌面快捷工具' },
  { key: 'data', label: '6. 数据安全与备份' }
]

/**
 * 帮助与产品手册（左下角 `?` 入口）
 *
 * 采用与「用户与团队」一致的「左章节导航 + 右结构化图文内容」布局：
 * - 第一章「快速上手」结合可视化协作闭环图、本机真实接入状态检测与页内一键操作；
 * - 第二至六章提供完整的面向用户的产品使用手册。
 */
export const QuickStartView: React.FC = () => {
  const setMainView = useUIStore((s) => s.setMainView)
  const enterWorkbench = useUIStore((s) => s.enterWorkbench)
  const showToast = useUIStore((s) => s.showToast)
  const projects = useProjectStore((s) => s.projects)

  const [section, setSection] = useState<DocSectionKey>('quickstart')
  const [path, setPath] = useState<PathKey>('A')
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const [showPromptPreview, setShowPromptPreview] = useState(false)
  const [agents, setAgents] = useState<Agent[]>([])
  const [approvingId, setApprovingId] = useState<string | null>(null)

  const activeProjects = projects.filter((p) => !p.archived)
  const pendingAgents = agents.filter(isPendingAgent)
  const approvedAgents = agents.filter((a) => a.approved && a.hasCredential !== false)
  /**
   * 本机真实接入地址（1.0.132，卡 `25caac02`）：提示词要自带入口，否则没接过 DeskPartner 的
   * agent 第一步只有 `dp: command not found`（产品不写用户 PATH，见 `2cc71a13`）。
   */
  const access = useCliAccess()
  const activePrompt = path === 'A' ? buildMigratePrompt(access) : buildFreshPrompt(access)

  const refreshAgents = useCallback(async () => {
    try {
      const list = (await invoke('agent:list')) as Agent[]
      if (Array.isArray(list)) setAgents(list)
    } catch {
      /* ignore */
    }
  }, [])

  useEffect(() => {
    void refreshAgents()
    const timer = window.setInterval(() => void refreshAgents(), 4000)
    return () => window.clearInterval(timer)
  }, [refreshAgents])

  const copyText = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopiedKey(key)
      window.setTimeout(() => setCopiedKey(null), 2200)
    } catch {
      showToast('无法复制，请检查系统剪贴板权限')
    }
  }

  const handleCopyGuide = async () => {
    try {
      const text = await invoke('cli:agentGuide')
      if (typeof text !== 'string' || !text.trim()) throw new Error('未取到说明内容')
      await copyText('guide', text)
    } catch (e) {
      showToast((e as Error).message)
    }
  }

  const handleQuickApproveAgent = async (agentId: string) => {
    setApprovingId(agentId)
    try {
      await invoke('agent:setApproved', { id: agentId, approved: true })
      await refreshAgents()
      showToast('已批准该 AI 助手的写入权限')
    } catch (e) {
      showToast((e as Error).message)
    } finally {
      setApprovingId(null)
    }
  }

  return (
    <div className="flex-1 min-h-0 flex">
      {/* 左导航：产品手册章节列表 */}
      <nav
        aria-label="帮助与产品手册目录"
        className="w-48 shrink-0 border-r border-border bg-surface-subtle py-4 px-2.5 flex flex-col gap-0.5"
      >
        <div className="px-2.5 pb-2 mb-1 border-b border-border/60">
          <div className="text-content font-semibold text-text-primary">帮助与产品手册</div>
          <div className="text-caption text-text-secondary mt-0.5">面向用户的完整使用指南</div>
        </div>
        {DOC_SECTIONS.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => setSection(item.key)}
            aria-current={section === item.key ? 'page' : undefined}
            className={cn(
              'w-full text-left px-3 py-2 rounded-button text-label transition-colors cursor-pointer flex items-center justify-between gap-2',
              section === item.key
                ? 'bg-accent text-white font-medium'
                : 'text-text-secondary hover:bg-surface-muted hover:text-text-primary'
            )}
          >
            <span className="truncate">{item.label}</span>
          </button>
        ))}
      </nav>

      {/* 右内容区 */}
      <div className="flex-1 min-w-0 overflow-y-auto px-6 py-5">
        <div className="max-w-4xl mx-auto w-full flex flex-col gap-4">
          {section === 'quickstart' && (
            <>
              {/* 实时待批准助手提醒：让用户在快速上手页就能当场完成第 2 步批准 */}
              {pendingAgents.length > 0 && (
                <div className="rounded-card border border-warning/30 bg-warning/10 px-4 py-3 flex flex-wrap items-center justify-between gap-3">
                  <div className="flex flex-col gap-0.5">
                    <span className="text-content font-semibold text-text-primary">
                      检测到 {pendingAgents.length} 个新注册的 AI 助手正在等待你批准
                    </span>
                    <span className="text-label text-text-secondary">
                      {pendingAgents.map((a) => `${a.displayName || a.id} (${a.id})`).join('、')}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    {pendingAgents.map((a) => (
                      <Button
                        key={a.id}
                        variant="primary"
                        size="sm"
                        disabled={approvingId === a.id}
                        onClick={() => void handleQuickApproveAgent(a.id)}
                      >
                        {approvingId === a.id ? '批准中…' : `批准「${a.displayName || a.id}」`}
                      </Button>
                    ))}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="border border-border bg-bg-card hover:bg-surface-subtle px-2.5 text-text-primary cursor-pointer"
                      onClick={() => setMainView('approval')}
                    >
                      去审批页查看
                    </Button>
                  </div>
                </div>
              )}

              {/* 一、一张图看懂 DeskPartner 人机协同模型 */}
              <section className="rounded-card border border-border bg-bg-card p-5 shadow-sm">
                <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-border/60">
                  <div>
                    <h2 className="text-column-title font-semibold text-text-primary">
                      一张图看懂 DeskPartner 如何协同工作
                    </h2>
                    <p className="text-label text-text-secondary mt-1">
                      你负责定方向、拍板候选需求与最终验收；AI 助手负责读取项目背景、拆解执行并留痕交付。
                    </p>
                  </div>
                  <div className="flex items-center gap-2 text-caption font-mono">
                    <span className="px-2.5 py-1 rounded-full bg-surface-subtle border border-border/70 text-text-secondary">
                      已接入助手 <strong className="text-text-primary">{approvedAgents.length}</strong>
                    </span>
                    <span className="px-2.5 py-1 rounded-full bg-surface-subtle border border-border/70 text-text-secondary">
                      活跃项目 <strong className="text-text-primary">{activeProjects.length}</strong>
                    </span>
                  </div>
                </div>

                {/* 可视化三栏架构图解 */}
                <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_auto_1.15fr_auto_1fr] items-stretch">
                  <div className="rounded-card border border-border/80 bg-surface-subtle p-3.5 flex flex-col justify-between gap-2.5">
                    <div>
                      <div className="inline-flex items-center gap-1.5 text-caption font-semibold text-accent">
                        <Icon name="user" size={13} /> 主用户（你）
                      </div>
                      <div className="text-content font-semibold text-text-primary mt-1">
                        定方向与守关口
                      </div>
                    </div>
                    <ul className="space-y-1.5 text-caption text-text-secondary">
                      <li className="flex items-center gap-1.5">
                        <span className="w-1.5 h-1.5 rounded-full bg-accent shrink-0" />
                        随时用快捷键或悬浮球记下想法
                      </li>
                      <li className="flex items-center gap-1.5">
                        <span className="w-1.5 h-1.5 rounded-full bg-accent shrink-0" />
                        拍板「待确认」事项是否立项
                      </li>
                      <li className="flex items-center gap-1.5">
                        <span className="w-1.5 h-1.5 rounded-full bg-accent shrink-0" />
                        核对「待验收」成果并点完成或退回
                      </li>
                    </ul>
                  </div>

                  <div className="hidden sm:flex flex-col items-center justify-center text-text-secondary/60 px-1 font-mono text-caption">
                    <span>拍板 / 验收</span>
                    <span className="text-body text-accent">⇄</span>
                    <span>提醒 / 审批</span>
                  </div>

                  <div className="rounded-card border border-accent/30 bg-accent/5 p-3.5 flex flex-col justify-between gap-2.5">
                    <div>
                      <div className="inline-flex items-center gap-1.5 text-caption font-semibold text-accent">
                        <Icon name="layers" size={13} /> DeskPartner 共享工作台
                      </div>
                      <div className="text-content font-semibold text-text-primary mt-1">
                        本机唯一事实来源
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-1.5 text-caption">
                      <div className="rounded-xs bg-bg-card border border-border/70 px-2 py-1.5 text-text-primary font-medium">
                        项目接手说明
                      </div>
                      <div className="rounded-xs bg-bg-card border border-border/70 px-2 py-1.5 text-text-primary font-medium">
                        7 态事项看板
                      </div>
                      <div className="rounded-xs bg-bg-card border border-border/70 px-2 py-1.5 text-text-primary font-medium">
                        个人档案与协议
                      </div>
                      <div className="rounded-xs bg-bg-card border border-border/70 px-2 py-1.5 text-text-primary font-medium">
                        分级权限与审计
                      </div>
                    </div>
                  </div>

                  <div className="hidden sm:flex flex-col items-center justify-center text-text-secondary/60 px-1 font-mono text-caption">
                    <span>CLI / MCP</span>
                    <span className="text-body text-accent">⇄</span>
                    <span>读写 / 留痕</span>
                  </div>

                  <div className="rounded-card border border-border/80 bg-surface-subtle p-3.5 flex flex-col justify-between gap-2.5">
                    <div>
                      <div className="inline-flex items-center gap-1.5 text-caption font-semibold text-success">
                        <Icon name="bot" size={13} /> AI 助手团队
                      </div>
                      <div className="text-content font-semibold text-text-primary mt-1">
                        跨工具接力执行
                      </div>
                    </div>
                    <ul className="space-y-1.5 text-caption text-text-secondary">
                      <li className="flex items-center gap-1.5">
                        <span className="w-1.5 h-1.5 rounded-full bg-success shrink-0" />
                        自动读取接手说明，零重复交代
                      </li>
                      <li className="flex items-center gap-1.5">
                        <span className="w-1.5 h-1.5 rounded-full bg-success shrink-0" />
                        拆解子任务、写验证证据并推待验收
                      </li>
                      <li className="flex items-center gap-1.5">
                        <span className="w-1.5 h-1.5 rounded-full bg-success shrink-0" />
                        删除或改设置自动进入审批页等你点头
                      </li>
                    </ul>
                  </div>
                </div>
              </section>

              {/* 二、交互式三步接入向导 */}
              <section className="rounded-card border border-border bg-bg-card p-5 shadow-sm">
                <div className="flex flex-wrap items-center justify-between gap-3 pb-3.5 border-b border-border/60">
                  <div>
                    <h2 className="text-column-title font-semibold text-text-primary">
                      三步接入你的 AI 助手
                    </h2>
                    <p className="text-label text-text-secondary mt-1">
                      根据你当前是否已经安装了 AI 编程或办公助手，选择对应的引导路径。
                    </p>
                  </div>
                  <Segmented
                    value={path}
                    onChange={setPath}
                    options={[
                      { value: 'A', label: '我已经在用 AI 助手（整理迁入）' },
                      { value: 'B', label: '我还没有 AI 助手（从零开始）' }
                    ]}
                  />
                </div>

                {/* 三步卡片：带本机完成状态徽标与行内直达按钮 */}
                <div className="mt-4 grid gap-3 sm:grid-cols-3">
                  {/* STEP 01 */}
                  <div className="rounded-card border border-border/80 bg-surface-subtle p-4 flex flex-col justify-between gap-3">
                    <div className="flex flex-col gap-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="inline-flex items-center justify-center px-2 py-0.5 rounded-xs bg-bg-card border border-border/70 font-mono text-caption font-semibold text-accent">
                          STEP 01
                        </span>
                        <span className="text-caption text-text-secondary font-mono">发送指令</span>
                      </div>
                      <div className="text-content font-semibold text-text-primary">
                        {path === 'A' ? '复制「整理迁入」提示词' : '安装助手并发送开场提示词'}
                      </div>
                      <p className="text-label text-text-secondary leading-relaxed">
                        {path === 'A'
                          ? '点击下方按钮复制提示词，直接粘贴给你的 AI 助手。它会自动调用本机 CLI 完成身份注册并拟定档案草稿。'
                          : '从下方推荐清单任选一款助手安装后，复制提示词发给它，它会引导你建立档案和首个项目。'}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5 pt-2 border-t border-border/50">
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={() => void copyText('prompt', activePrompt)}
                      >
                        <Icon name="copy" size={12} className="mr-1" />
                        {copiedKey === 'prompt' ? '已复制提示词' : '复制开场提示词'}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="border border-border bg-bg-card hover:bg-surface-muted px-2 text-text-primary cursor-pointer"
                        onClick={() => setShowPromptPreview((prev) => !prev)}
                      >
                        {showPromptPreview ? '收起原文' : '预览原文'}
                      </Button>
                    </div>
                  </div>

                  {/* STEP 02 */}
                  <div className="rounded-card border border-border/80 bg-surface-subtle p-4 flex flex-col justify-between gap-3">
                    <div className="flex flex-col gap-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="inline-flex items-center justify-center px-2 py-0.5 rounded-xs bg-bg-card border border-border/70 font-mono text-caption font-semibold text-accent">
                          STEP 02
                        </span>
                        {approvedAgents.length > 0 ? (
                          <span className="px-2 py-0.5 rounded-full bg-success/10 text-success text-caption font-medium">
                            已批准 {approvedAgents.length} 个
                          </span>
                        ) : (
                          <span className="text-caption text-text-secondary font-mono">等待注册</span>
                        )}
                      </div>
                      <div className="text-content font-semibold text-text-primary">
                        在审批页批准身份与提议
                      </div>
                      <p className="text-label text-text-secondary leading-relaxed">
                        AI 助手注册并提交你的个人档案、协作协议草稿后，会汇总在「审批」页，由你确认后正式生效。
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5 pt-2 border-t border-border/50">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="border border-border bg-bg-card hover:bg-surface-muted px-2.5 text-text-primary cursor-pointer"
                        onClick={() => setMainView('approval')}
                      >
                        前往审批页 →
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="border border-border bg-bg-card hover:bg-surface-muted px-2.5 text-text-primary cursor-pointer"
                        onClick={() => setMainView('user')}
                      >
                        查看团队与档案
                      </Button>
                    </div>
                  </div>

                  {/* STEP 03 */}
                  <div className="rounded-card border border-border/80 bg-surface-subtle p-4 flex flex-col justify-between gap-3">
                    <div className="flex flex-col gap-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="inline-flex items-center justify-center px-2 py-0.5 rounded-xs bg-bg-card border border-border/70 font-mono text-caption font-semibold text-accent">
                          STEP 03
                        </span>
                        <span className="px-2 py-0.5 rounded-full bg-bg-card border border-border/70 text-caption font-mono text-text-secondary">
                          {activeProjects.length} 个项目
                        </span>
                      </div>
                      <div className="text-content font-semibold text-text-primary">
                        在项目看板推进与验收
                      </div>
                      <p className="text-label text-text-secondary leading-relaxed">
                        助手会按你确认的口径创建项目、编写接手说明并登记事项。日常在「我的工作」或项目看板即可全局掌控。
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5 pt-2 border-t border-border/50">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="border border-border bg-bg-card hover:bg-surface-muted px-2.5 text-text-primary cursor-pointer"
                        onClick={() => enterWorkbench()}
                      >
                        进入我的工作 →
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="border border-border bg-bg-card hover:bg-surface-muted px-2.5 text-text-primary cursor-pointer"
                        onClick={() => void handleCopyGuide()}
                      >
                        {copiedKey === 'guide' ? '已复制说明' : '复制完整接入说明'}
                      </Button>
                    </div>
                  </div>
                </div>

                {/* 按需展开的提示词原文预览 */}
                {showPromptPreview && (
                  <div className="mt-3 rounded-card border border-border bg-surface-subtle p-3.5 text-label text-text-primary font-mono leading-relaxed max-h-56 overflow-y-auto whitespace-pre-wrap">
                    {activePrompt}
                  </div>
                )}

                <div className="mt-3 rounded-button border border-border/70 bg-surface-subtle px-3.5 py-2.5 text-caption text-text-secondary">
                  <strong className="text-text-primary">更换过安装目录？</strong>
                  同目录升级无需重配；若重装时更换了安装位置，已开启的命令行终端或助手进程请重启一次（或重新复制上方开场提示词获取最新路径），MCP 助手请用最新 <code className="font-mono text-text-primary">mcp.cjs</code> 路径更新配置并重连。
                </div>
              </section>

              {/* 新手路径专属：推荐 AI 助手清单 */}
              {path === 'B' && (
                <section className="rounded-card border border-border bg-bg-card p-5 shadow-sm">
                  <div className="pb-3 border-b border-border/60">
                    <h2 className="text-content font-semibold text-text-primary">常用 AI 助手推荐</h2>
                    <p className="text-label text-text-secondary mt-1">
                      任选一款安装后，将上方的「从零开始」提示词发给它即可开始协作（DeskPartner 不会替你下载或安装第三方软件）。
                    </p>
                  </div>
                  <div className="mt-3.5 grid gap-3 sm:grid-cols-2">
                    {RECOMMENDED_AGENTS.map((agent, index) => (
                      <div
                        key={agent.name}
                        className="flex items-start gap-3 rounded-card border border-border/80 bg-surface-subtle px-4 py-3"
                      >
                        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-xs bg-bg-card border border-border/70 font-mono text-caption font-semibold text-text-secondary mt-0.5">
                          {String(index + 1).padStart(2, '0')}
                        </span>
                        <div className="min-w-0">
                          <div className="text-content font-semibold text-text-primary">{agent.name}</div>
                          <p className="mt-1 text-label leading-relaxed text-text-secondary">
                            {agent.note}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {/* 章节底部快速跳往下一章 */}
              <div className="rounded-card border border-border bg-bg-card px-5 py-3.5 flex items-center justify-between gap-3">
                <span className="text-label text-text-secondary">
                  想了解看板 7 个状态怎么流转、父子需求怎么拆解？
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="border border-border bg-surface-subtle hover:bg-surface-muted px-3 text-text-primary cursor-pointer"
                  onClick={() => setSection('workflow')}
                >
                  下一章：2. 事项与工作流 →
                </Button>
              </div>
            </>
          )}

          {section === 'workflow' && (
            <>
              <section className="rounded-card border border-border bg-bg-card p-5 shadow-sm">
                <div className="pb-3 border-b border-border/60">
                  <h2 className="text-column-title font-semibold text-text-primary">
                    2. 事项看板与 7 态工作流
                  </h2>
                  <p className="text-label text-text-secondary mt-1">
                    DeskPartner 将事项生命周期划分为 7 个标准状态，并在首尾设置「待确认」与「待验收」两道质量关口。
                  </p>
                </div>

                {/* 7 态真实胶囊与说明表 */}
                <div className="mt-4 grid gap-2.5">
                  {(
                    [
                      [
                        'proposed',
                        '当前工作 · 入口关口',
                        'AI 助手发现的新问题或待评估提议先落在此列。未经你拍板确认，不能围绕它拆解子任务或自行转入执行。'
                      ],
                      [
                        'todo',
                        '当前工作 · 已确认立项',
                        '已确认要做、排入队列等待启动的事项。'
                      ],
                      [
                        'in_progress',
                        '当前工作 · 正在执行',
                        '执行人（你或被指派的 AI 助手）正在处理的事项。若验收未通过被驳回，也会携带驳回理由退回此列。'
                      ],
                      [
                        'awaiting_review',
                        '当前工作 · 交付关口',
                        '执行人已完成并附上验证证据，等待验收人核对。详情抽屉会自动展示「本次变更」对比。'
                      ],
                      [
                        'done',
                        '已结束 · 验收通过',
                        '经由非执行人本人验收通过并正式收口的事项，可关联至具体发布版本号。'
                      ],
                      [
                        'suspended',
                        '已结束 · 暂时搁置',
                        '因外部条件未就绪而暂停推进的事项，待条件满足后可随时恢复。'
                      ],
                      [
                        'discarded',
                        '已结束 · 明确不做',
                        '经评估决定不再执行的事项（留作历史决策记录，不计入未完成工作量，也不计入完成率）。'
                      ]
                    ] as const
                  ).map(([status, stage, desc]) => (
                    <div
                      key={status}
                      className="rounded-button border border-border/70 bg-surface-subtle px-3.5 py-2.5 flex flex-col sm:flex-row sm:items-center gap-2.5"
                    >
                      <div className="w-28 shrink-0">
                        <TodoStatusPill status={status} />
                      </div>
                      <span className="w-36 shrink-0 text-caption font-mono text-text-secondary">
                        {stage}
                      </span>
                      <p className="text-label text-text-primary leading-relaxed flex-1">{desc}</p>
                    </div>
                  ))}
                </div>
              </section>

              <section className="rounded-card border border-border bg-bg-card p-5 shadow-sm">
                <div className="pb-3 border-b border-border/60">
                  <h3 className="text-content font-semibold text-text-primary">
                    三个角色分工与父子拆解规则
                  </h3>
                </div>
                <div className="mt-3.5 grid gap-3 sm:grid-cols-3">
                  <div className="rounded-button border border-border/70 bg-surface-subtle p-3.5">
                    <div className="text-content font-semibold text-text-primary">提出者（Owner）</div>
                    <p className="mt-1.5 text-label text-text-secondary leading-relaxed">
                      发起这条事项的人或 AI 助手。未单独指派执行人时，默认由提出者本人负责执行；指派他人执行后，提出者默认担任验收人。
                    </p>
                  </div>
                  <div className="rounded-button border border-border/70 bg-surface-subtle p-3.5">
                    <div className="text-content font-semibold text-text-primary">执行人（Executor）</div>
                    <p className="mt-1.5 text-label text-text-secondary leading-relaxed">
                      具体负责落地该事项的主体。执行人完成后只能推进至「待验收」，系统内置规则禁止执行人自己验收自己做的事。
                    </p>
                  </div>
                  <div className="rounded-button border border-border/70 bg-surface-subtle p-3.5">
                    <div className="text-content font-semibold text-text-primary">父需求与子任务</div>
                    <p className="mt-1.5 text-label text-text-secondary leading-relaxed">
                      复杂需求可拆解为多条子任务。只有当旗下所有子任务全部完成后，父需求才能转入「待验收」或「已完成」。
                    </p>
                  </div>
                </div>
              </section>
            </>
          )}

          {section === 'projects' && (
            <>
              <section className="rounded-card border border-border bg-bg-card p-5 shadow-sm">
                <div className="pb-3 border-b border-border/60">
                  <h2 className="text-column-title font-semibold text-text-primary">
                    3. 项目空间与跨项目工作台
                  </h2>
                  <p className="text-label text-text-secondary mt-1">
                    每条事项都归属于一个明确的项目。你既可以在「我的工作」跨项目集中处理今日要务，也可以进入单个项目查看完整上下文。
                  </p>
                </div>

                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <div className="rounded-card border border-border/80 bg-surface-subtle p-4 flex flex-col gap-2">
                    <div className="text-content font-semibold text-text-primary">
                      工作台 · 我的工作
                    </div>
                    <p className="text-label text-text-secondary leading-relaxed">
                      汇总所有未归档项目中仍需处理的事项（含候选确认、已排期、进行中与待验收），支持按「与我相关 / 全部 / 指定 AI 助手」切换视角，省去在多个项目间来回切换。
                    </p>
                  </div>
                  <div className="rounded-card border border-border/80 bg-surface-subtle p-4 flex flex-col gap-2">
                    <div className="text-content font-semibold text-text-primary">
                      项目接手说明（Handoff）
                    </div>
                    <p className="text-label text-text-secondary leading-relaxed">
                      每个项目的「概览」页都配有支持 Markdown 与 50 版修订历史的接手说明。在说明中写下 <code className="font-mono text-text-primary bg-bg-card px-1 rounded-xs">#8位编号</code> 会自动关联展示对应事项的实时状态。
                    </p>
                  </div>
                </div>

                <div className="mt-4 rounded-button border border-border/70 bg-surface-subtle p-4">
                  <div className="text-content font-semibold text-text-primary mb-2">
                    项目内五大页签职责
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2 text-label text-text-secondary">
                    <div>
                      <strong className="text-text-primary">概览：</strong>查看当前工作分布、今日/近 7 天动态、编辑项目名称与颜色、配置项目规则及维护接手说明。
                    </div>
                    <div>
                      <strong className="text-text-primary">事项：</strong>拖拽式看板视图（支持按当前工作 / 已结束 / 全部范围切换、多维筛选、批量修改与列宽拖拽调节）。
                    </div>
                    <div>
                      <strong className="text-text-primary">动态：</strong>按时间线回溯项目发生过的状态流转，以及查看该项目的专属通知收件箱。
                    </div>
                    <div>
                      <strong className="text-text-primary">版本与全局搜索：</strong>按版本号聚合查看每一版解决了哪些事项，或全文检索事项、评论与接手说明。
                    </div>
                  </div>
                </div>
              </section>
            </>
          )}

          {section === 'agents' && (
            <>
              <section className="rounded-card border border-border bg-bg-card p-5 shadow-sm">
                <div className="pb-3 border-b border-border/60">
                  <h2 className="text-column-title font-semibold text-text-primary">
                    4. AI 团队管理与安全审批边界
                  </h2>
                  <p className="text-label text-text-secondary mt-1">
                    所有 AI 助手在「用户与团队」中统一持证管理，权限状态与过往审批流水严格分离、全程留痕。
                  </p>
                </div>

                <div className="mt-4 grid gap-2.5">
                  {[
                    [
                      '第一档：只读查询',
                      '免审批通行',
                      '读取项目、事项、接手说明、统计与协作规则，任何本地工具均可安全读取。'
                    ],
                    [
                      '第二档：日常协作写入',
                      '批准身份后长期有效',
                      '创建事项、更新状态、发表评论。AI 助手首次注册后需由你在「审批」页批准身份并签发凭据，随时可暂停或吊销。'
                    ],
                    [
                      '第三档：修改界面设置',
                      '逐次或会话级授权',
                      '修改主题、字号、悬浮球外观等设置时，会触发顶部审批横幅，你可以选择「允许一次」或「长期允许」。'
                    ],
                    [
                      '第四档：删除数据与变更协议',
                      '逐条强制审批 + 二次确认',
                      '删除事项、版本、标签或修改你的个人档案、协作协议、项目接手说明，必须逐条经你在界面点击批准后由系统代为执行。若删除的父事项下含子任务，还需你二次确认。'
                    ]
                  ].map(([tier, badge, desc]) => (
                    <div
                      key={tier}
                      className="rounded-button border border-border/70 bg-surface-subtle px-3.5 py-2.5 flex flex-col sm:flex-row sm:items-center gap-2.5"
                    >
                      <span className="w-44 shrink-0 text-content font-semibold text-text-primary">
                        {tier}
                      </span>
                      <span className="w-40 shrink-0">
                        <span className="px-2 py-0.5 rounded-full bg-bg-card border border-border/70 text-caption font-medium text-text-secondary">
                          {badge}
                        </span>
                      </span>
                      <p className="text-label text-text-secondary leading-relaxed flex-1">{desc}</p>
                    </div>
                  ))}
                </div>
              </section>
            </>
          )}

          {section === 'desktop' && (
            <>
              <section className="rounded-card border border-border bg-bg-card p-5 shadow-sm">
                <div className="pb-3 border-b border-border/60">
                  <h2 className="text-column-title font-semibold text-text-primary">
                    5. 桌面快捷效率工具
                  </h2>
                  <p className="text-label text-text-secondary mt-1">
                    不打开主窗口也能随时捕捉灵感、查看焦点事项与处理审批。
                  </p>
                </div>

                <div className="mt-4 grid gap-3 sm:grid-cols-3">
                  <div className="rounded-card border border-border/80 bg-surface-subtle p-4 flex flex-col gap-2">
                    <div className="text-content font-semibold text-text-primary">桌面悬浮球</div>
                    <p className="text-label text-text-secondary leading-relaxed">
                      常驻桌面边缘（支持拖拽贴边自动半隐藏）。单击展开轻量事项面板，双击打开主窗口；有待审批或到期提醒时会呈现柔和呼吸光效。
                    </p>
                  </div>
                  <div className="rounded-card border border-border/80 bg-surface-subtle p-4 flex flex-col gap-2">
                    <div className="text-content font-semibold text-text-primary">
                      全局快捷键速记
                    </div>
                    <p className="text-label text-text-secondary leading-relaxed">
                      默认按下 <code className="font-mono text-text-primary bg-bg-card px-1.5 py-0.5 rounded-xs border border-border/60">Ctrl + Shift + N</code> 即可在任意软件上方唤起速记小窗，自动记忆你上次使用的项目，写完回车即走。
                    </p>
                  </div>
                  <div className="rounded-card border border-border/80 bg-surface-subtle p-4 flex flex-col gap-2">
                    <div className="text-content font-semibold text-text-primary">
                      顶部提醒与审批横幅
                    </div>
                    <p className="text-label text-text-secondary leading-relaxed">
                      事项到点提醒或 AI 助手发起高危操作申请时，屏幕顶部会滑出横幅，支持直接点击「稍后提醒」、「允许一次」或跳往详情。
                    </p>
                  </div>
                </div>
              </section>
            </>
          )}

          {section === 'data' && (
            <>
              <section className="rounded-card border border-border bg-bg-card p-5 shadow-sm">
                <div className="pb-3 border-b border-border/60">
                  <h2 className="text-column-title font-semibold text-text-primary">
                    6. 数据安全、备份与恢复
                  </h2>
                  <p className="text-label text-text-secondary mt-1">
                    所有数据 100% 存储在你的本机 SQLite 数据库（<code className="font-mono">user.db</code>）中，不经过任何云端服务器。
                  </p>
                </div>

                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <div className="rounded-card border border-border/80 bg-surface-subtle p-4 flex flex-col gap-2">
                    <div className="text-content font-semibold text-text-primary">
                      自动快照保护
                    </div>
                    <p className="text-label text-text-secondary leading-relaxed">
                      每次版本升级迁移数据库结构或执行全量导入前，系统都会自动在数据目录下生成带时间戳的备份文件（保留最近多份快照），防止意外覆盖。
                    </p>
                  </div>
                  <div className="rounded-card border border-border/80 bg-surface-subtle p-4 flex flex-col gap-2">
                    <div className="text-content font-semibold text-text-primary">
                      JSON 备份导出与导入
                    </div>
                    <p className="text-label text-text-secondary leading-relaxed">
                      在「设置 → 数据管理」中可随时将全部项目、事项、分类、版本与备忘导出为标准 JSON 文件，或在新电脑上一键恢复。
                    </p>
                  </div>
                </div>

                <div className="mt-4 pt-3.5 border-t border-border/60 flex items-center justify-end gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="border border-border bg-surface-subtle hover:bg-surface-muted px-3 text-text-primary cursor-pointer"
                    onClick={() => setMainView('settings')}
                  >
                    前往设置与数据管理 →
                  </Button>
                </div>
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
