import React, { useCallback, useEffect, useState } from 'react'
import { Button } from '../ui/Button'
import { Icon } from '../ui/Icon'
import { useUIStore } from '../../stores/ui.store'
import { useProjectStore } from '../../stores/project.store'
import { invoke } from '../../lib/ipc-client'
import { buildFreshPrompt, buildMigratePrompt } from '../../lib/onboarding-prompts'
import { useCliAccess } from '../../lib/use-cli-access'
import { isPendingAgent } from '../../lib/grant-state'
import { cn } from '../../lib/utils'
import type { Agent } from '../../types/todo'

type PathKey = 'A' | 'B'

/** 产品官网与在线手册的唯一出处：客户端只做入口，手册内容随官网一起发布（卡 `5eaf6d1d`） */
export const OFFICIAL_WEBSITE_URL = 'https://lynnnn928.github.io/deskpartner/'
export const OFFICIAL_MANUAL_URL = 'https://lynnnn928.github.io/deskpartner/#manual'

/**
 * 快速上手（左下角 `?` 入口）
 *
 * ── 2026-11-12 重排（评审后）──
 *
 * 旧版上半屏是"一张图看懂 DeskPartner 如何协同工作"：三栏架构图 + 四个白底标签
 * （看着像按钮、点不动）。装好产品的人此刻只想知道**下一步点哪里**，而唯一的
 * 实心主按钮「复制开场提示词」被挤到页面中部；三步又把"注册"与"批准身份"写成一句，
 * 于是 agent 在等人批身份、人在等 agent 交草稿。
 *
 * 现在按"先做什么"排序，三栏图删掉（它解释的是产品，不是下一步）：
 *   ① 复制开场提示词 —— 模式只影响这一份文本
 *   ② 批准身份与草稿 —— 待批准的助手直接列在卡片里，当场批
 *   ③ 在看板立项与验收
 *
 * 提示词自带本机接入地址（1.0.132，卡 `25caac02`）：没接过 DeskPartner 的 agent
 * 第一步就是 `dp: command not found` —— 产品不写 PATH，入口必须写进正文。
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

  /** 整本接入说明：给"想自己看全文"的人一个出口，不占主流程的位置 */
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

  const modeChip = (key: PathKey, label: string) => (
    <button
      type="button"
      data-testid={`quickstart-mode-${key}`}
      aria-pressed={path === key}
      onClick={() => setPath(key)}
      className={cn(
        'px-2.5 py-1 rounded-input text-caption transition-colors cursor-pointer',
        path === key
          ? 'bg-bg-card text-text-primary font-medium shadow-sm'
          : 'bg-transparent text-text-secondary hover:text-text-primary'
      )}
    >
      {label}
    </button>
  )

  return (
    <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5">
      <div className="max-w-5xl mx-auto w-full flex flex-col gap-4">
        {/* ── 页头：一句话说清这一页是干什么的 ── */}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-column-title font-semibold tracking-title text-text-primary">
              接入你的 AI 助手
            </h2>
            <p className="mt-1 max-w-2xl text-label leading-relaxed text-text-secondary">
              把下面的开场提示词发给支持命令行或 MCP 的 AI 助手，它就能读写这台电脑上的项目与事项。
              提示词里已经填好本机路径，不用你自己去找。
            </p>
          </div>
        </div>

        {/* ── 三步：按"先做什么"排，待批准的助手在第 2 步当场批 ── */}
        <div className="grid gap-3 sm:grid-cols-3">
          {/* STEP 01 */}
          <section
            data-testid="quickstart-step1"
            className="rounded-card border border-border/80 bg-surface-subtle p-4 flex flex-col justify-between gap-3"
          >
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2">
                <span className="inline-flex items-center justify-center px-2 py-0.5 rounded-xs bg-bg-card border border-border/70 font-mono text-caption font-semibold text-accent">
                  STEP 01
                </span>
                <span className="text-caption text-text-secondary font-mono">发送提示词</span>
              </div>
              <div className="text-content font-semibold text-text-primary">复制开场提示词</div>
              <p className="text-label leading-relaxed text-text-secondary">
                {path === 'A'
                  ? '把提示词粘给你的 AI 助手。它会按里面的本机地址读取接入说明，然后申请注册身份。'
                  : '先装一款支持本地工具调用的助手，再把提示词发给它 —— 它会分几轮问你，把档案、协议和第一个项目建起来。'}
              </p>
              <div
                className="inline-flex items-center gap-0.5 self-start rounded-button border border-border/60 bg-surface-muted p-0.5"
                data-testid="quickstart-mode"
              >
                {modeChip('A', '我已在用 AI 助手')}
                {modeChip('B', '第一次用 AI 助手')}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-1.5 pt-2 border-t border-border/50">
              <Button variant="primary" size="sm" onClick={() => void copyText('prompt', activePrompt)}>
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
          </section>

          {/* STEP 02 */}
          <section
            data-testid="quickstart-step2"
            className="rounded-card border border-border/80 bg-surface-subtle p-4 flex flex-col justify-between gap-3"
          >
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2">
                <span className="inline-flex items-center justify-center px-2 py-0.5 rounded-xs bg-bg-card border border-border/70 font-mono text-caption font-semibold text-accent">
                  STEP 02
                </span>
                {pendingAgents.length > 0 ? (
                  <span className="px-2 py-0.5 rounded-full bg-warning/15 text-warning text-caption font-medium">
                    待批准 {pendingAgents.length} 个
                  </span>
                ) : approvedAgents.length > 0 ? (
                  <span className="px-2 py-0.5 rounded-full bg-success/10 text-success text-caption font-medium">
                    已批准 {approvedAgents.length} 个
                  </span>
                ) : (
                  <span className="text-caption text-text-secondary font-mono">等待注册</span>
                )}
              </div>
              <div className="text-content font-semibold text-text-primary">批准身份与草稿</div>
              <p className="text-label leading-relaxed text-text-secondary">
                注册了还不能写入：先批准它的身份，再和它确认个人档案与协作协议 ——
                它起草的内容在「审批」页采纳后才生效。
              </p>
              {pendingAgents.length > 0 && (
                <div className="flex flex-col gap-1.5 rounded-button border border-warning/30 bg-warning/10 p-2">
                  {pendingAgents.map((a) => (
                    <div key={a.id} className="flex items-center justify-between gap-2">
                      <span className="min-w-0 truncate text-caption text-text-primary">
                        {a.displayName || a.id}
                      </span>
                      <Button
                        variant="primary"
                        size="sm"
                        data-testid={`quickstart-approve-${a.id}`}
                        disabled={approvingId === a.id}
                        onClick={() => void handleQuickApproveAgent(a.id)}
                      >
                        {approvingId === a.id ? '批准中…' : '批准'}
                      </Button>
                    </div>
                  ))}
                </div>
              )}
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
                查看用户与团队
              </Button>
            </div>
          </section>

          {/* STEP 03 */}
          <section
            data-testid="quickstart-step3"
            className="rounded-card border border-border/80 bg-surface-subtle p-4 flex flex-col justify-between gap-3"
          >
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2">
                <span className="inline-flex items-center justify-center px-2 py-0.5 rounded-xs bg-bg-card border border-border/70 font-mono text-caption font-semibold text-accent">
                  STEP 03
                </span>
                <span className="px-2 py-0.5 rounded-full bg-bg-card border border-border/70 text-caption font-mono text-text-secondary">
                  {activeProjects.length} 个项目
                </span>
              </div>
              <div className="text-content font-semibold text-text-primary">在看板立项与验收</div>
              <p className="text-label leading-relaxed text-text-secondary">
                助手会按确认好的口径建项目、写接手说明、登记事项。日常在「我的工作」或项目看板里
                拍板立项、核对验收即可。
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
            </div>
          </section>
        </div>

        {/* 按需展开的提示词原文 */}
        {showPromptPreview && (
          <div className="rounded-card border border-border bg-surface-subtle p-3.5 text-label text-text-primary font-mono leading-relaxed max-h-56 overflow-y-auto whitespace-pre-wrap">
            {activePrompt}
          </div>
        )}

        {/* ── 日常还有这些接入场景（这三件事不在三步主流程里，但常用）── */}
        <section
          data-testid="quickstart-daily"
          className="rounded-card border border-border bg-bg-card px-5 py-4"
        >
          <h3 className="text-content font-semibold text-text-primary">日常还有这些接入场景</h3>
          <ul className="mt-2 flex flex-col gap-1.5 text-label text-text-secondary">
            <li className="flex gap-2">
              <span className="text-text-tertiary">·</span>
              <span>
                接入一个已有项目：左侧栏「+ 新增项目」→ 切到「由 AI 助手接入已有项目」，复制那里的提示词。
              </span>
            </li>
            <li className="flex gap-2">
              <span className="text-text-tertiary">·</span>
              <span>换一个助手接手在用的项目：进入该项目「概览」页 →「让 AI 接手项目」。</span>
            </li>
            <li className="flex items-center gap-2">
              <span className="text-text-tertiary">·</span>
              <span>想自己看整本接入说明：</span>
              <Button
                variant="ghost"
                size="sm"
                className="border border-border bg-surface-subtle hover:bg-surface-muted px-2 text-text-primary cursor-pointer"
                onClick={() => void handleCopyGuide()}
              >
                {copiedKey === 'guide' ? '已复制说明' : '复制完整接入说明'}
              </Button>
            </li>
          </ul>
        </section>

        {/* ── 排障：默认收起，第一次安装的人不需要先读它 ── */}
        <details className="rounded-card border border-border bg-bg-card px-5 py-3">
          <summary className="cursor-pointer text-label font-medium text-text-primary">
            助手提示找不到命令，或者换过安装目录？
          </summary>
          <div className="mt-2 flex flex-col gap-1.5 text-label leading-relaxed text-text-secondary">
            <p>
              纯网页版聊天工具跑不了本机命令 —— 换一个支持本地命令行或 MCP 的客户端再复制上方提示词。
            </p>
            <p>
              同目录升级不用重配；如果重装时换过安装位置，重启已打开的终端或助手进程，或重新复制一次
              上方提示词，让它拿到最新路径。
            </p>
          </div>
        </details>

        {/* ── 页脚：手册与官网合并成一行，不再各占一个主按钮 ── */}
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-border bg-bg-card px-5 py-3.5">
          <span className="text-label text-text-secondary">
            看板 7 个状态怎么流转、哪些动作要审批、桌面工具有哪些，都在在线手册里。
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
            <Button
              variant="ghost"
              size="sm"
              data-testid="quickstart-open-website-btn"
              className="border border-border bg-surface-subtle hover:bg-surface-muted px-3 text-text-primary cursor-pointer"
              onClick={() => void openExternalUrl(OFFICIAL_WEBSITE_URL)}
            >
              产品官网 ↗
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
