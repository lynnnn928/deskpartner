import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Icon, type IconName } from '../ui/Icon'
import { DropdownMenu, DropdownMenuItem } from '../ui/DropdownMenu'
import { Dialog } from '../ui/Dialog'
import { Button } from '../ui/Button'
import { Segmented } from '../settings/Section'
import { useUIStore } from '../../stores/ui.store'
import { useTodoStore } from '../../stores/todo.store'
import { useProjectStore } from '../../stores/project.store'
import { useSettingsStore } from '../../stores/settings.store'
import { matchesTodoFilter, ownerLabel, type TodoFilter } from '../../lib/todo-filter'
import { countAwaitingApproval } from '../../lib/grant-state'
import { invoke } from '../../lib/ipc-client'
import { cn } from '../../lib/utils'
import { GUI_READER } from '../../lib/notification-subject'
import { PROJECT_HANDOFF_TEMPLATE } from '../../types/project'
import type { UpdateStatus } from '../../types/ipc'
import { buildProjectPrompt } from '../../lib/onboarding-prompts'
import { useCliAccess } from '../../lib/use-cli-access'
import partnerBadge from '../../assets/partner-badge.svg'

const PROJECT_COLOR_PRESETS = [
  '#5388F6',
  '#10B981',
  '#F59E0B',
  '#EF4444',
  '#8B5CF6',
  '#EC4899',
  '#06B6D4',
  '#64748B'
]

const CLEAN_HANDOFF_SKELETON = `# 项目目标

# 当前决定

# 工作入口

# 下一步
`

/**
 * 侧栏只负责导航，不再同时承担状态筛选。
 * 状态、时间和负责人等细化条件属于项目事项页/我的工作页的内容区。
 */
export const Sidebar: React.FC = () => {
  const {
    mainView,
    setMainView,
    workspaceMode,
    filterProject,
    enterProject,
    enterWorkbench,
    searchKeyword,
    filterCategory,
    filterOwner,
    filterExecutor,
    filterPriority,
    filterType,
    filterFixedIn,
    filterCreatedRange
  } = useUIStore()
  const { todos } = useTodoStore()
  const { projects, createProject, updateProject, deleteProject } = useProjectStore()
  const { settings } = useSettingsStore()
  // 项目接入提示词同样要自带入口（1.0.132，卡 `25caac02`）：没接过产品的 agent 没有 `dp` 命令
  const access = useCliAccess()
  const projectPrompt = buildProjectPrompt(access)
  const showToast = useUIStore((s) => s.showToast)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [renameColor, setRenameColor] = useState('#5388F6')
  const [deleting, setDeleting] = useState<string | null>(null)
  const [deleteConfirmed, setDeleteConfirmed] = useState(false)
  const [showArchived, setShowArchived] = useState(false)
  const [pendingCount, setPendingCount] = useState(0)
  const [unreadCount, setUnreadCount] = useState(0)
  const [creating, setCreating] = useState(false)
  const [createTab, setCreateTab] = useState<'manual' | 'agent'>('manual')
  const [createName, setCreateName] = useState('')
  const [createColor, setCreateColor] = useState('#5388F6')
  const [createHandoff, setCreateHandoff] = useState('')
  const [approvedAgents, setApprovedAgents] = useState<string[]>([])
  const [selectedPromptAgent, setSelectedPromptAgent] = useState<string>('')
  const [agentPromptCopied, setAgentPromptCopied] = useState(false)
  const [updateState, setUpdateState] = useState<UpdateStatus | null>(null)
  /** 侧栏这边发起的下载：下完就自动重启安装（卡 `99870984`），不必再等用户去设置页点第二次 */
  const autoInstallAfterDownloadRef = useRef(false)

  /**
   * 主界面的新版提醒（卡 `99870984`）
   *
   * 主进程在启动约 2 秒后就会在后台查一次更新，但结果此前只出现在
   * 「设置 → 系统」最底部 —— 用户不进设置页就永远不知道有新版本。
   *
   * 这里挂载即拉一次，并在**启动后 15 秒内**每 1.5 秒再拉一次：那个"第 2 秒
   * 查出来的结果"因此能在侧栏上自己冒出来。过了这段窗口只在真有事
   * （checking / downloading）时继续盯着 —— 下载进度要动，空闲态则不必常驻轮询。
   */
  useEffect(() => {
    let alive = true
    const mountedAt = Date.now()
    let lastStatus: UpdateStatus['status'] | null = null
    const pull = async () => {
      try {
        const next = await invoke('app:getUpdateState')
        if (!alive) return
        lastStatus = next?.status ?? null
        setUpdateState(next ?? null)
      } catch {
        // 更新状态读不到不影响导航
      }
    }
    void pull()
    const timer = window.setInterval(() => {
      const busy = lastStatus === 'checking' || lastStatus === 'downloading'
      if (busy || Date.now() - mountedAt < 15_000) void pull()
    }, 1500)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [])

  useEffect(() => {
    if (updateState?.status !== 'downloaded' || !autoInstallAfterDownloadRef.current) return
    autoInstallAfterDownloadRef.current = false
    void invoke('app:quitAndInstallUpdate').catch(() => undefined)
  }, [updateState?.status])

  useEffect(() => {
    let alive = true
    const tick = async () => {
      try {
        const [agents, grants, profileProposals, protocolProposals, handoffProposals, ruleProposals, unread] = await Promise.all([
          invoke('agent:list'),
          invoke('agent:listGrants', { activeOnly: true, limit: 0 }),
          invoke('profile:proposals'),
          invoke('protocol:proposals'),
          invoke('project:handoffProposals'),
          invoke('rules:proposals'),
          // 角标数的是**主用户**还没看过的（卡 `c13dbb16`）：带上主体才不会被
          // 别的写方翻全局已读位吃掉，也与通知页页头同一个口径。
          invoke('notification:unreadCount', { reader: GUI_READER })
        ])
        if (alive) {
          setPendingCount(countAwaitingApproval(agents, grants, profileProposals.length, protocolProposals.length, handoffProposals.length, ruleProposals.length))
          setUnreadCount(unread)
          const approved = (agents as Array<{ id: string; approved: boolean; hasCredential?: boolean }>)
            .filter((a) => a.approved && a.hasCredential !== false)
            .map((a) => a.id)
          setApprovedAgents(approved)
          setSelectedPromptAgent((prev) => (prev && approved.includes(prev) ? prev : (approved[0] ?? '')))
        }
      } catch {
        // 角标读取失败不能阻塞导航
      }
    }
    void tick()
    const timer = window.setInterval(() => void tick(), 5000)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [])

  const baseFilter: TodoFilter = useMemo(
    () => ({
      keyword: searchKeyword,
      categoryId: filterCategory,
      owner: filterOwner,
      executor: filterExecutor,
      projectId: null,
      createdRange: filterCreatedRange,
      priority: filterPriority,
      type: filterType,
      fixedIn: filterFixedIn ?? undefined
    }),
    [searchKeyword, filterCategory, filterOwner, filterExecutor, filterPriority, filterType, filterFixedIn, filterCreatedRange]
  )
  const actionableCount = (projectId: string | null) =>
    todos
      .filter((todo) => (projectId === null || todo.projectId === projectId) && matchesTodoFilter(todo, baseFilter))
      .filter((todo) => !['done', 'discarded', 'suspended'].includes(todo.status)).length

  const todosInProject = (id: string) => todos.filter((todo) => todo.projectId === id)

  const submitRename = async () => {
    if (!renaming || !renameDraft.trim()) return
    try {
      await updateProject({ id: renaming, name: renameDraft.trim(), color: renameColor })
      setRenaming(null)
    } catch (err) {
      showToast(err instanceof Error ? `重命名失败：${err.message}` : '重命名失败')
    }
  }

  /**
   * 永久删除（卡 `c177e466`，2026-10-09 已定口径）：**清空整个项目**，不迁移。
   *
   * 旧实现先把事项迁到别的项目再删，默认落点是"除自己以外的第一个项目" ——
   * 于是**不选承接项目也能删**（主用户 2026-10-22 复核时点出的就是它），
   * 而且"迁不走"时还会把事项的 project_id 置空，与"事项必须归项目"冲突。
   * 界面不再问承接项目；只想让项目"消失"请用归档（可逆）。
   *
   * 最后一个项目由数据层拒绝（事项无处可归），错误原样提示即可。
   */
  const submitDelete = async () => {
    if (!deleting || !deleteConfirmed) return
    try {
      await deleteProject(deleting)
      if (filterProject === deleting) enterWorkbench()
      setDeleting(null)
      setDeleteConfirmed(false)
    } catch (err) {
      showToast(err instanceof Error ? `永久删除失败：${err.message}` : '永久删除失败')
    }
  }

  /** 归档 / 取消归档：只置一个标志位，数据一条不动 —— 所以随时可逆。 */
  const submitArchive = async (id: string, archived: boolean) => {
    try {
      await updateProject({ id, archived })
      showToast(archived ? '已归档：事项与接手说明都还在，可在「已归档」里恢复' : '已取消归档')
    } catch (err) {
      showToast(err instanceof Error ? `${archived ? '归档' : '取消归档'}失败：${err.message}` : '归档操作失败')
    }
  }

  const submitCreate = async () => {
    const name = createName.trim()
    if (!name) {
      showToast('项目名称不能为空')
      return
    }
    if (projects.some((project) => project.name.trim().toLocaleLowerCase() === name.toLocaleLowerCase())) {
      showToast('项目名称已存在')
      return
    }
    try {
      const project = await createProject({ name, color: createColor, handoffMarkdown: createHandoff.trim() })
      setCreating(false)
      setCreateName('')
      setCreateHandoff('')
      enterProject(project.id)
      useUIStore.getState().setProjectEntryTab('overview')
      showToast(`项目「${project.name}」已创建`)
    } catch (err) {
      showToast(err instanceof Error ? `创建项目失败：${err.message}` : '创建项目失败')
    }
  }

  const humanName = settings.humanName?.trim() || '我'
  const appName = settings.appName?.trim() || 'DeskPartner'

  useEffect(() => {
    document.title = appName
  }, [appName])
  const nav = (view: 'notifications' | 'approval' | 'stats' | 'settings' | 'user' | 'quickstart') => setMainView(view)

  return (
    <aside className="sidebar-nav w-sidebar shrink-0 flex flex-col border-r border-border bg-black/[0.02]">
      <div className="px-4 pt-3.5 pb-3 flex items-baseline gap-1.5 shrink-0">
        <img
          src={settings.appIcon || partnerBadge}
          alt=""
          draggable={false}
          data-testid="sidebar-app-icon"
          className={cn(
            'w-5 h-5 rounded-full object-contain shrink-0 pointer-events-none select-none mr-0.5 self-center',
            settings.appIcon && 'bg-white'
          )}
        />
        <span className="text-column-title font-semibold text-text-primary tracking-tight truncate">{appName}</span>
        <span className="w-1.5 h-1.5 rounded-full bg-accent inline-block -translate-y-px" />
      </div>

      <div className="flex-1 min-h-0 flex flex-col px-2">
        <div className="shrink-0">
          <NavSection label="工作台">
            <NavButton icon="layers" active={workspaceMode === 'workbench' && mainView === 'board'} onClick={enterWorkbench}>
              我的工作
            </NavButton>
            <NavButton icon="bell" active={mainView === 'notifications'} onClick={() => setMainView('notifications')} badge={unreadCount}>通知</NavButton>
            <NavButton icon="shield" active={mainView === 'approval'} onClick={() => setMainView('approval')} badge={pendingCount}>审批</NavButton>
            <NavButton icon="barChart" active={mainView === 'stats'} onClick={() => nav('stats')}>统计</NavButton>
          </NavSection>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto">
          <NavSection label="项目">
            <button type="button" onClick={() => { setCreating(true); setCreateTab('manual'); setCreateName(''); setCreateHandoff('') }} className="nav-item w-full flex items-center gap-2 px-2 py-1.5 rounded-button text-label text-accent hover:bg-accent/10 transition-colors cursor-pointer">
              <Icon name="plus" size={14} /><span>新增项目</span>
            </button>
            {projects.filter((project) => !project.archived).map((project) => (
              <DropdownMenu
                key={project.id}
                containerClassName="w-full"
                align="left"
                triggerOn="contextmenu"
                trigger={
                  <button type="button" onClick={() => enterProject(project.id)} aria-current={workspaceMode === 'project' && filterProject === project.id ? 'page' : undefined} data-active={workspaceMode === 'project' && filterProject === project.id ? 'true' : 'false'} className={cn(
                    'nav-item w-full flex items-center gap-2 px-2 py-1.5 rounded-button text-label transition-colors',
                    workspaceMode === 'project' && filterProject === project.id ? 'bg-accent text-white' : 'text-text-secondary hover:bg-black/5 hover:text-text-primary'
                  )}>
                    <span className="w-2 h-2 rounded-full shrink-0" style={{ background: project.color }} />
                    <span className="flex-1 min-w-0 truncate text-left">{project.name}</span>
                    <span className="font-mono text-caption opacity-70">{actionableCount(project.id)}</span>
                  </button>
                }
              >
                <DropdownMenuItem onClick={() => { setRenaming(project.id); setRenameDraft(project.name); setRenameColor(project.color || '#5388F6') }}><Icon name="pencil" size={13} />重命名</DropdownMenuItem>
                <DropdownMenuItem onClick={() => void submitArchive(project.id, true)}><Icon name="archive" size={13} />归档项目</DropdownMenuItem>
                <DropdownMenuItem danger onClick={() => { setDeleting(project.id); setDeleteConfirmed(false) }}><Icon name="trash" size={13} />永久删除…</DropdownMenuItem>
              </DropdownMenu>
            ))}
            {projects.filter((project) => !project.archived).length === 0 && <div className="px-2 py-2 text-label text-text-secondary/70">还没有项目</div>}
            {projects.some((project) => project.archived) && (
              <>
                <button
                  type="button"
                  onClick={() => setShowArchived((value) => !value)}
                  aria-expanded={showArchived}
                  className="nav-item w-full flex items-center gap-2 px-2 py-1.5 mt-1 rounded-button text-label text-text-secondary/70 hover:bg-black/5 transition-colors"
                >
                  <Icon name="chevronLeft" size={12} className={showArchived ? '-rotate-90' : 'rotate-180'} />
                  <span className="flex-1 text-left">已归档（{projects.filter((project) => project.archived).length}）</span>
                </button>
                {showArchived && projects.filter((project) => project.archived).map((project) => (
                  <DropdownMenu
                    key={project.id}
                    containerClassName="w-full"
                    align="left"
                    triggerOn="contextmenu"
                    trigger={
                      <button type="button" onClick={() => enterProject(project.id)} aria-current={workspaceMode === 'project' && filterProject === project.id ? 'page' : undefined} className={cn(
                        'nav-item w-full flex items-center gap-2 px-2 py-1.5 rounded-button text-label transition-colors',
                        workspaceMode === 'project' && filterProject === project.id ? 'bg-accent text-white' : 'text-text-secondary/70 hover:bg-black/5 hover:text-text-primary'
                      )}>
                        <span className="w-2 h-2 rounded-full shrink-0 opacity-60" style={{ background: project.color }} />
                        <span className="flex-1 min-w-0 truncate text-left">{project.name}</span>
                        <span className="font-mono text-caption opacity-70">{actionableCount(project.id)}</span>
                      </button>
                    }
                  >
                    <DropdownMenuItem onClick={() => void submitArchive(project.id, false)}><Icon name="archive" size={13} />取消归档</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => { setRenaming(project.id); setRenameDraft(project.name); setRenameColor(project.color || '#5388F6') }}><Icon name="pencil" size={13} />重命名</DropdownMenuItem>
                    <DropdownMenuItem danger onClick={() => { setDeleting(project.id); setDeleteConfirmed(false) }}><Icon name="trash" size={13} />永久删除…</DropdownMenuItem>
                  </DropdownMenu>
                ))}
              </>
            )}
          </NavSection>
        </div>
      </div>

      {updateState &&
        (updateState.status === 'available' ||
          updateState.status === 'downloading' ||
          updateState.status === 'downloaded') && (
          <div
            data-testid="sidebar-update-banner"
            className="shrink-0 mx-2 mb-1 rounded-card border border-accent/30 bg-accent/10 px-2.5 py-2 flex flex-col gap-1.5"
          >
            <div className="flex items-center gap-1.5">
              <Icon name="refreshCw" size={13} className="text-accent shrink-0" />
              <span className="flex-1 min-w-0 text-caption font-medium text-text-primary">
                {updateState.status === 'available' && `发现新版本 v${updateState.availableVersion}`}
                {updateState.status === 'downloading' &&
                  `正在下载 v${updateState.availableVersion}（${updateState.progressPercent ?? 0}%）…`}
                {updateState.status === 'downloaded' && `新版本 v${updateState.availableVersion} 已就绪`}
              </span>
            </div>
            {updateState.status === 'available' && (
              <Button
                variant="primary"
                size="sm"
                data-testid="sidebar-update-btn"
                onClick={() => {
                  autoInstallAfterDownloadRef.current = true
                  void invoke('app:downloadUpdate')
                    .then((next) => setUpdateState(next ?? null))
                    .catch(() => undefined)
                }}
              >
                立即更新
              </Button>
            )}
            {updateState.status === 'downloaded' && (
              <Button
                variant="primary"
                size="sm"
                data-testid="sidebar-install-btn"
                onClick={() => {
                  void invoke('app:quitAndInstallUpdate').catch(() => undefined)
                }}
              >
                重启并安装
              </Button>
            )}
          </div>
        )}

      <div className="shrink-0 border-t border-border px-2 py-2 flex items-center gap-1">
        <button
          type="button" onClick={() => setMainView('user')}
          className={cn('flex-1 min-w-0 flex items-center gap-2 px-2 py-1.5 rounded-button text-label transition-colors', mainView === 'user' ? 'bg-accent text-white' : 'text-text-primary hover:bg-black/5')}
          title={`${humanName}（用户与团队：档案、协议、Agent）`}
        >
          <span className={cn('w-5 h-5 rounded-full text-caption flex items-center justify-center shrink-0', mainView === 'user' ? 'bg-white/25 text-white' : 'bg-accent text-white')}>{humanName.slice(0, 1)}</span>
          <span className="flex-1 min-w-0 truncate text-left">{humanName}</span>
        </button>
        <button
          type="button" onClick={() => nav('quickstart')}
          aria-current={mainView === 'quickstart' ? 'page' : undefined}
          className={cn('shrink-0 w-7 h-7 flex items-center justify-center rounded-button transition-colors', mainView === 'quickstart' ? 'bg-accent text-white' : 'text-text-secondary hover:bg-black/5 hover:text-text-primary')}
          title="快速上手"
        >
          <Icon name="help" size={14} />
        </button>
        <button
          type="button" onClick={() => nav('settings')}
          aria-current={mainView === 'settings' ? 'page' : undefined}
          className={cn('shrink-0 w-7 h-7 flex items-center justify-center rounded-button transition-colors', mainView === 'settings' ? 'bg-accent text-white' : 'text-text-secondary hover:bg-black/5 hover:text-text-primary')}
          title="设置"
        >
          <Icon name="settings" size={14} />
        </button>
      </div>
      {creating && (
        <Dialog open onClose={() => setCreating(false)} className="w-dialog-lg max-w-dialog-lg max-h-dialog overflow-y-auto">
          <div className="w-full flex flex-col gap-4">
            <div className="flex items-center justify-between gap-3 pb-3 border-b border-border/60">
              <div className="flex items-center gap-3 flex-wrap">
                <h3 className="text-body font-semibold text-text-primary">新增项目</h3>
                <Segmented
                  value={createTab}
                  onChange={setCreateTab}
                  options={[
                    { value: 'manual', label: '手动创建' },
                    { value: 'agent', label: '由 AI 助手接入已有项目' }
                  ]}
                />
              </div>
              <button
                type="button"
                onClick={() => setCreating(false)}
                aria-label="关闭"
                className="w-6 h-6 flex items-center justify-center rounded-button text-text-secondary hover:bg-surface-muted hover:text-text-primary transition-colors cursor-pointer"
              >
                <Icon name="x" size={14} />
              </button>
            </div>

            {createTab === 'manual' ? (
              <>
                <div className="flex flex-col gap-1.5">
                  <label className="text-label font-medium text-text-primary" htmlFor="new-project-name">
                    项目名称
                  </label>
                  <input
                    id="new-project-name"
                    autoFocus
                    value={createName}
                    onChange={(e) => setCreateName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void submitCreate()
                      if (e.key === 'Escape') setCreating(false)
                    }}
                    placeholder="例如：DeskPartner、个人网站、季度规划…"
                    maxLength={60}
                    className="w-full h-9 px-3 rounded-button border border-border bg-bg-card text-content text-text-primary placeholder:text-text-secondary/50 outline-none focus:border-accent transition-colors"
                  />
                </div>

                <div className="flex flex-col gap-1.5">
                  <span className="text-label font-medium text-text-primary">项目标识色</span>
                  <div className="flex items-center gap-2 flex-wrap">
                    {PROJECT_COLOR_PRESETS.map((c) => {
                      const active = createColor.toLowerCase() === c.toLowerCase()
                      return (
                        <button
                          key={c}
                          type="button"
                          onClick={() => setCreateColor(c)}
                          title={`选择标识色 ${c}`}
                          className={cn(
                            'w-6 h-6 rounded-full transition-transform cursor-pointer flex items-center justify-center',
                            active ? 'ring-2 ring-offset-2 ring-accent scale-110' : 'hover:scale-105 opacity-85 hover:opacity-100'
                          )}
                          style={{ backgroundColor: c }}
                        />
                      )
                    })}
                    <label
                      className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-button border border-border bg-bg-card text-caption text-text-secondary hover:text-text-primary cursor-pointer ml-1"
                      title="自定义其他颜色"
                    >
                      <input
                        type="color"
                        value={createColor}
                        onChange={(e) => setCreateColor(e.target.value)}
                        className="w-3.5 h-3.5 rounded-xs border-0 bg-transparent cursor-pointer"
                      />
                      <span>自定义</span>
                    </label>
                  </div>
                </div>

                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <label className="text-label font-medium text-text-primary" htmlFor="new-project-handoff">
                      项目接手说明 <span className="font-normal text-caption text-text-secondary">（选填，支持 Markdown）</span>
                    </label>
                    <button
                      type="button"
                      onClick={() => setCreateHandoff(CLEAN_HANDOFF_SKELETON)}
                      className="text-caption text-accent hover:underline cursor-pointer"
                    >
                      填入章节骨架
                    </button>
                  </div>
                  <textarea
                    id="new-project-handoff"
                    value={createHandoff}
                    onChange={(e) => setCreateHandoff(e.target.value)}
                    rows={14}
                    placeholder={'# 项目目标\n记录项目要解决的问题与交付目标\n\n# 当前决定\n记录已确认的方向与边界\n\n# 工作入口\n记录代码仓库、文档或关键链接\n\n# 下一步\n记录近期计划推进的事项'}
                    className="w-full min-h-60 max-h-scroll-sm resize-y px-3 py-2.5 rounded-button border border-border bg-bg-card text-label text-text-primary font-mono leading-relaxed placeholder:text-text-secondary/50 outline-none focus:border-accent transition-colors"
                  />
                </div>

                <div className="flex justify-end gap-2 pt-2 border-t border-border/60">
                  <Button variant="ghost" size="sm" onClick={() => setCreating(false)}>
                    取消
                  </Button>
                  <Button variant="primary" size="sm" onClick={() => void submitCreate()}>
                    创建项目
                  </Button>
                </div>
              </>
            ) : (
              <>
                <p className="text-label text-text-secondary leading-relaxed">
                  复制下方提示词发给你的 AI 助手，它会协助你完成项目创建、拟定接手说明并登记初始事项。
                </p>
                {approvedAgents.length > 0 ? (
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-caption font-medium text-text-secondary shrink-0">
                      选择目标助手：
                    </span>
                    {approvedAgents.map((agentId) => {
                      const active = (selectedPromptAgent || approvedAgents[0]) === agentId
                      return (
                        <button
                          key={agentId}
                          type="button"
                          onClick={() => setSelectedPromptAgent(agentId)}
                          className={cn(
                            'inline-flex items-center gap-1.5 h-7 px-2.5 rounded-button text-caption border transition-colors cursor-pointer',
                            active
                              ? 'bg-bg-card text-text-primary font-semibold border-text-primary/30 shadow-sm'
                              : 'bg-transparent text-text-secondary border-border/70 hover:text-text-primary hover:bg-surface-subtle'
                          )}
                        >
                          <Icon name="bot" size={11} />
                          {ownerLabel(agentId, settings.humanName)}
                        </button>
                      )
                    })}
                  </div>
                ) : (
                  <div className="rounded-button border border-border bg-surface-subtle px-3 py-2 text-caption text-text-secondary">
                    当前尚无已批准的 AI 助手。复制下方提示词发给助手后，它会先引导你完成接入审批，随后自动接入项目。
                  </div>
                )}
                <div className="rounded-card border border-border bg-surface-subtle p-3.5 text-label text-text-primary leading-relaxed max-h-56 overflow-y-auto whitespace-pre-wrap">
                  {approvedAgents.length > 0
                    ? `请以 ${selectedPromptAgent || approvedAgents[0]} 的身份，按以下要求接入已有项目到 DeskPartner。\n\n${projectPrompt}`
                    : `请先办理 DeskPartner 的 agent 身份注册与凭据手续，等主用户在「审批」页批准后，按以下要求接入已有项目。\n\n${projectPrompt}`}
                </div>
                <div className="flex justify-end gap-2 pt-2 border-t border-border/60">
                  <Button variant="ghost" size="sm" onClick={() => setCreating(false)}>
                    关闭
                  </Button>
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={async () => {
                      const targetAgent = selectedPromptAgent || approvedAgents[0]
                      const prefix = approvedAgents.length > 0
                        ? `请以 ${targetAgent} 的身份，按以下要求接入已有项目到 DeskPartner。\n\n`
                        : `请先办理 DeskPartner 的 agent 身份注册与凭据手续，等主用户在「审批」页批准后，按以下要求接入已有项目。\n\n`
                      try {
                        await navigator.clipboard.writeText(prefix + projectPrompt)
                        setAgentPromptCopied(true)
                        window.setTimeout(() => setAgentPromptCopied(false), 2200)
                      } catch {
                        showToast('无法复制，请检查系统剪贴板权限')
                      }
                    }}
                  >
                    {agentPromptCopied ? '已复制提示词' : '复制提示词'}
                  </Button>
                </div>
              </>
            )}
          </div>
        </Dialog>
      )}

      {renaming && (
        <Dialog open onClose={() => setRenaming(null)}>
          <div className="w-88 flex flex-col gap-3.5">
            <div className="flex items-center justify-between pb-2.5 border-b border-border/60">
              <h3 className="text-body font-semibold text-text-primary">重命名项目</h3>
              <button
                type="button"
                onClick={() => setRenaming(null)}
                aria-label="关闭"
                className="w-6 h-6 flex items-center justify-center rounded-button text-text-secondary hover:bg-surface-muted hover:text-text-primary transition-colors cursor-pointer"
              >
                <Icon name="x" size={14} />
              </button>
            </div>
            <label className="flex flex-col gap-1.5 text-label text-text-secondary">
              新项目名称
              <input
                autoFocus
                value={renameDraft}
                onChange={(e) => setRenameDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void submitRename()
                  if (e.key === 'Escape') setRenaming(null)
                }}
                maxLength={30}
                className="w-full h-9 px-3 rounded-button border border-border text-content text-text-primary bg-bg-card outline-none focus:border-accent transition-colors"
              />
            </label>
            <div className="flex flex-col gap-1.5">
              <span className="text-label text-text-secondary">项目标识色</span>
              <div className="flex items-center gap-2 flex-wrap">
                {PROJECT_COLOR_PRESETS.map((c) => {
                  const active = renameColor.toLowerCase() === c.toLowerCase()
                  return (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setRenameColor(c)}
                      title={`选择标识色 ${c}`}
                      className={cn(
                        'w-6 h-6 rounded-full transition-transform cursor-pointer flex items-center justify-center',
                        active ? 'ring-2 ring-offset-2 ring-accent scale-110' : 'hover:scale-105 opacity-85 hover:opacity-100'
                      )}
                      style={{ backgroundColor: c }}
                    />
                  )
                })}
                <label
                  className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-button border border-border bg-bg-card text-caption text-text-secondary hover:text-text-primary cursor-pointer ml-1"
                  title="自定义其他颜色"
                >
                  <input
                    type="color"
                    value={renameColor}
                    onChange={(e) => setRenameColor(e.target.value)}
                    className="w-3.5 h-3.5 rounded-xs border-0 bg-transparent cursor-pointer"
                  />
                  <span>自定义</span>
                </label>
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2 border-t border-border/60">
              <Button variant="ghost" size="sm" onClick={() => setRenaming(null)}>
                取消
              </Button>
              <Button variant="primary" size="sm" onClick={() => void submitRename()}>
                保存
              </Button>
            </div>
          </div>
        </Dialog>
      )}
      {deleting && (
        <Dialog open onClose={() => { setDeleting(null); setDeleteConfirmed(false) }}>
          <div className="w-dialog-sm flex flex-col gap-3">
            <h3 className="text-body font-medium text-text-primary">永久删除项目「{projects.find((project) => project.id === deleting)?.name ?? ''}」</h3>
            <p className="text-label text-text-secondary leading-relaxed">
              将一并删除该项目下的 {todosInProject(deleting).length} 条事项、评论、接手说明与版本记录，
              <span className="text-red-500">删除后不可恢复</span>。若需保留数据，请使用<span className="text-text-primary">「归档项目」</span>。
            </p>
            <label className="flex items-start gap-2 text-label text-text-primary cursor-pointer">
              <input type="checkbox" checked={deleteConfirmed} onChange={(e) => setDeleteConfirmed(e.target.checked)} className="mt-0.5 accent-accent" />
              <span>我确认永久删除该项目及其全部数据</span>
            </label>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => { setDeleting(null); setDeleteConfirmed(false) }}>取消</Button>
              <Button
                variant="ghost"
                size="sm"
                className="border border-border bg-surface-subtle hover:bg-surface-muted text-text-primary"
                onClick={() => {
                  const targetId = deleting
                  setDeleting(null)
                  setDeleteConfirmed(false)
                  if (targetId) {
                    void submitArchive(targetId, true)
                    if (filterProject === targetId) enterWorkbench()
                  }
                }}
              >
                归档项目
              </Button>
              <Button variant="danger" size="sm" disabled={!deleteConfirmed} onClick={() => void submitDelete()}>永久删除</Button>
            </div>
          </div>
        </Dialog>
      )}
    </aside>
  )
}

const NavSection: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <section className="mb-3">
    <div className="nav-group-label px-2 pt-2 pb-1 text-label text-text-secondary/60">{label}</div>
    <div className="flex flex-col gap-0.5">{children}</div>
  </section>
)

const NavButton: React.FC<{ icon: IconName; active: boolean; onClick: () => void; badge?: number; children: React.ReactNode }> = ({ icon, active, onClick, badge, children }) => (
  <button type="button" onClick={onClick} aria-current={active ? 'page' : undefined} data-active={active ? 'true' : 'false'} className={cn('nav-item w-full flex items-center gap-2 px-2 py-1.5 rounded-button text-label transition-colors', active ? 'bg-accent text-white' : 'text-text-secondary hover:bg-black/5 hover:text-text-primary')}>
    <Icon name={icon} size={14} />
    <span className="flex-1 text-left">{children}</span>
    {!!badge && <span className={cn('text-caption font-mono', active ? 'opacity-90' : 'text-red-500')}>{badge}</span>}
  </button>
)
