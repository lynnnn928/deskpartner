import React, { useCallback, useEffect, useState } from 'react'
import { Button } from '../ui/Button'
import { Segmented } from '../settings/Section'
import { Icon } from '../ui/Icon'
import { useUIStore } from '../../stores/ui.store'
import { useProjectStore } from '../../stores/project.store'
import { invoke } from '../../lib/ipc-client'
import { buildFreshPrompt, buildMigratePrompt, RECOMMENDED_AGENTS } from '../../lib/onboarding-prompts'
import { useCliAccess } from '../../lib/use-cli-access'
import { isPendingAgent } from '../../lib/grant-state'
import type { Agent } from '../../types/todo'

type PathKey = 'A' | 'B'

/** 产品官网与在线手册的唯一出处：客户端只做入口，手册内容随官网一起发布（卡 `5eaf6d1d`） */
export const OFFICIAL_WEBSITE_URL = 'https://lynnnn928.github.io/deskpartner/'
export const OFFICIAL_MANUAL_URL = 'https://lynnnn928.github.io/deskpartner/#manual'

/**
 * 帮助与快速上手（左下角 `?` 入口）
 *
 * 单页全宽布局，只保留「一张图看懂协同模型」「三步接入 AI 助手」两个本机交互区块；
 * 完整的 2~6 章使用手册已迁到产品官网，底部只留一个在线手册入口，
 * 免得同一份内容在客户端和官网两处各写一遍、各自过期（卡 `5eaf6d1d`）。
 */
export const QuickStartView: React.FC = () => {
  const setMainView = useUIStore((s) => s.setMainView)
  const enterWorkbench = useUIStore((s) => s.enterWorkbench)
  const showToast = useUIStore((s) => s.showToast)
  const projects = useProjectStore((s) => s.projects)

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

  /** 外链一律交给主进程打开：渲染层不碰 shell，URL 由主进程白名单再校验一遍 */
  const openExternalUrl = async (url: string) => {
    try {
      await invoke('app:openExternal', { url })
    } catch (e) {
      showToast((e as Error).message)
    }
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5">
      <div className="max-w-5xl mx-auto w-full flex flex-col gap-4">
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
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-2 text-caption font-mono">
                <span className="px-2.5 py-1 rounded-full bg-surface-subtle border border-border/70 text-text-secondary">
                  已接入助手 <strong className="text-text-primary">{approvedAgents.length}</strong>
                </span>
                <span className="px-2.5 py-1 rounded-full bg-surface-subtle border border-border/70 text-text-secondary">
                  活跃项目 <strong className="text-text-primary">{activeProjects.length}</strong>
                </span>
              </div>
              <Button
                variant="ghost"
                size="sm"
                data-testid="quickstart-open-website-btn"
                className="border border-border bg-surface-subtle hover:bg-surface-muted px-2.5 text-text-primary cursor-pointer"
                onClick={() => void openExternalUrl(OFFICIAL_WEBSITE_URL)}
              >
                访问产品官网 ↗
              </Button>
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

        {/* 完整手册在线看：客户端只留入口，内容不在本地维护（卡 `5eaf6d1d`） */}
        <div className="rounded-card border border-border bg-bg-card px-5 py-3.5 flex flex-wrap items-center justify-between gap-3">
          <span className="text-label text-text-secondary">
            想了解看板 7 个状态流转、4 档审批边界与桌面快捷工具？完整使用指南已统一发布在产品官网。
          </span>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              data-testid="quickstart-open-manual-btn"
              className="border border-border bg-surface-subtle hover:bg-surface-muted px-3 text-text-primary cursor-pointer"
              onClick={() => void openExternalUrl(OFFICIAL_MANUAL_URL)}
            >
              查看在线使用手册 ↗
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
