import React, { useEffect, useState } from 'react'
import { KanbanBoard } from '../components/kanban/KanbanBoard'
import { SearchBar } from '../components/kanban/SearchBar'
import { TimelineView } from '../components/timeline/TimelineView'
import { Sidebar } from '../components/kanban/Sidebar'
import { ChipsBar } from '../components/kanban/ChipsBar'
import { BatchBar } from '../components/kanban/BatchBar'
import { NotificationsView } from '../components/notification/NotificationsView'
import { ApprovalView } from '../components/approval/ApprovalView'
import { StatsView } from '../components/stats/StatsView'
import { ReleasesView } from '../components/releases/ReleasesView'
import { SettingsView } from '../components/settings/SettingsView'
import { UserView } from '../components/user/UserView'
import { QuickStartView } from '../components/onboarding/QuickStartView'
import { WindowControls } from '../components/ui/WindowControls'
import { Toast } from '../components/ui/Toast'
import { Icon } from '../components/ui/Icon'
import { ProjectOverviewView } from '../components/project/ProjectOverviewView'
import { ProjectDocsView } from '../components/project/ProjectDocsView'
import { ViewScopeSwitcher } from '../components/kanban/ViewScopeSwitcher'
import { WorkbenchView } from '../components/workbench/WorkbenchView'
import { GlobalSearchView } from '../components/workbench/GlobalSearchView'
import { useSettingsStore } from '../stores/settings.store'
import { useProjectStore } from '../stores/project.store'
import { useUIStore, type MainView } from '../stores/ui.store'
import { useBoardVisibility } from '../hooks/useBoardVisibility'
import { invoke } from '../lib/ipc-client'
import { cn } from '../lib/utils'

/**
 * 看板主窗口入口（1.0.48 骨架重构，v2/v3 设计）
 *
 * 职责三分：
 * - 左侧边栏管「我在哪里」（工作台 / 项目 / 系统导航 + 用户 foot）
 * - 顶栏管「怎么看」（项目页签 / 形态胶囊 / 搜索 / 筛选 / 新增）
 * - 内容区管状态范围与 chips 回显（ChipsBar）
 *
 * 顶栏退役的：备忘铃铛（备忘并入批次 3 通知中心）、设置齿轮（侧边栏 foot）、
 * 置顶按钮（设置·看板与卡片里仍有开关）、形态切换左边的窗口标题（品牌位移到侧边栏）。
 */
const VIEW_LABEL: Record<MainView, string> = {
  board: '',
  notifications: '通知',
  approval: '审批',
  stats: '统计',
  releases: '版本',
  settings: '设置',
  user: '用户',
  quickstart: '快速上手'
}

const VALID_VIEWS: MainView[] = [
  'board',
  'notifications',
  'approval',
  'stats',
  'releases',
  'settings',
  'user',
  'quickstart'
]

/** 从 hash query 读目标视图（跨窗口深链：window:showKanban {view} → #/kanban?view=xxx） */
function readViewFromHash(): MainView | null {
  const raw = window.location.hash.split('?')[1] ?? ''
  const v = new URLSearchParams(raw).get('view') as MainView | null
  return v && VALID_VIEWS.includes(v) ? v : null
}

const Kanban: React.FC = () => {
  const { settings } = useSettingsStore()
  const {
    boardView,
    setBoardView,
    mainView,
    setMainView,
    filterProject,
    workspaceMode,
    projectEntryTab,
    setProjectEntryTab,
    workItemScope,
    setWorkItemScope,
    setFilterStatus
  } = useUIStore()
  const multiSelectMode = useUIStore((s) => s.multiSelectMode)
  const toggleMultiSelect = useUIStore((s) => s.toggleMultiSelect)
  const projects = useProjectStore((s) => s.projects)
  const inBoard = mainView === 'board'
  const selectedProject = projects.find((project) => project.id === filterProject) ?? null
  const [projectTab, setProjectTab] = useState<'overview' | 'items' | 'activity' | 'versions' | 'docs' | 'search'>('items')
  const [activityMode, setActivityMode] = useState<'timeline' | 'notifications'>('timeline')
  const [projectSearchQuery, setProjectSearchQuery] = useState('')
  const [projectSearchIds, setProjectSearchIds] = useState<string[]>([])
  /**
   * 全局搜索命中接手说明的落点（卡 c9dfbc87）：项目 + 关键词。
   * 带上项目 id 是因为这份意图要跨"换项目"活一小段路：人换了项目再看概览时，
   * 上一个项目的命中不该又冒出来（清理见下一个 effect）。
   */
  const [handoffFocus, setHandoffFocus] = useState<{ projectId: string; query: string } | null>(null)
  const showProjectTab = inBoard && workspaceMode === 'project'
  const showItemTools = showProjectTab && projectTab === 'items'
  const showProjectScope = showProjectTab && projectTab === 'items'

  /**
   * 角标数字（f6f78ada）：与看板渲染共用同一份判据（hooks/useBoardVisibility），
   * chips 回显行与搜索行显示的是同一个 N —— 各算一份就会出现"数字与卡片对不上"。
   * 只在看板形态真正渲染时传下去：动态那边报的是事项数，不是卡片数。
   */
  const { visibleCount } = useBoardVisibility()
  const boardVisibleCount = showItemTools && boardView === 'kanban' ? visibleCount : undefined

  useEffect(() => {
    if (workspaceMode === 'project') {
      /**
       * 落地页**一次算清**（卡 c9dfbc87）：带着搜索落点进来时落概览页 —— 接手说明就在
       * 概览里，落到事项页等于"点了搜索结果却看不到那处命中"。
       * 为什么不另补一句 setProjectTab('overview')：这个 effect 会因为自己下面那句
       * setProjectEntryTab('items') 再跑第二遍，第二遍再读 projectEntryTab 就把页签拨回去了
       * （最小复现实测：在点击处理里直接写 'overview' 的版本，最终仍是 'items'）。
       */
      setProjectTab(handoffFocus && handoffFocus.projectId === filterProject ? 'overview' : projectEntryTab)
      setProjectEntryTab('items')
      setBoardView('kanban')
      setActivityMode('timeline')
    }
    // 落点只在它自己那个项目里有效（卡 c9dfbc87）：残留的那条会在下次打开概览时
    // 又把一个早就不在这份说明里的词"定位"一次，看着像界面自己乱跳。
    // 返回同一个引用时 React 不重渲染，所以这条清不会把 effect 再踢一遍。
    setHandoffFocus((focus) => (focus && focus.projectId !== filterProject ? null : focus))
  }, [filterProject, workspaceMode, projectEntryTab, setProjectEntryTab, handoffFocus])

  useEffect(() => {
    if (!showItemTools) setPanelOpen(false)
  }, [showItemTools])

  /**
   * 深链同步：窗口复用时 loadURL 只改 hash 是同文档导航，组件不重挂载 ——
   * 监听 hashchange 才能把"去审批/去设置"的第二次点击也送达
   * （与设置页 ?section= 深链当年踩的是同一个坑）。
   */
  useEffect(() => {
    const initial = readViewFromHash()
    if (initial) setMainView(initial)
    const onHashChange = () => {
      const v = readViewFromHash()
      if (v) setMainView(v)
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [setMainView])

  /** 搜索与筛选共用一处展开入口，避免两个按钮打开同一工具栏。 */
  const [panelOpen, setPanelOpen] = useState(false)

  const handleNewTodo = () => {
    invoke('window:showQuickAdd', {
      todoId: undefined,
      projectId: workspaceMode === 'project' ? filterProject ?? undefined : undefined
    })
  }

  const openGlobalSearchTodo = (result: import('../types/project').ProjectSearchResult) => {
    if (result.projectId) {
      useUIStore.getState().enterProject(result.projectId)
      setProjectTab('items')
      setBoardView('kanban')
      setWorkItemScope('all')
      if (result.todoStatus) setFilterStatus(result.todoStatus)
      setMainView('board')
    }
    void invoke('window:showQuickAdd', {
      todoId: result.todoId,
      ...(result.commentId ? { commentId: result.commentId } : {})
    })
  }

  /** 项目内的全局搜索：同项目命中只开详情窗口，不改当前页面；跨项目命中才切项目。 */
  const openSearchResultInProject = (result: import('../types/project').ProjectSearchResult) => {
    if (result.projectId && result.projectId !== filterProject) {
      openGlobalSearchTodo(result)
      return
    }
    void invoke('window:showQuickAdd', {
      todoId: result.todoId,
      ...(result.projectId ? { projectId: result.projectId } : {}),
      ...(result.commentId ? { commentId: result.commentId } : {})
    })
  }

  const openGlobalSearchProject = (projectId: string, handoffQuery?: string) => {
    useUIStore.getState().enterProject(projectId)
    /**
     * 落页交给上面那个 effect 连落点一起算（卡 c9dfbc87），这里**不**直接
     * setProjectTab：换项目时那个 effect 会把页签重置一次，实测（最小复现）它排在
     * 点击处理之后 —— 在这里直接写 'overview' 会被它拨回事项页。
     * 不是接手说明的命中（关键词为空）就清掉落点，免得沿用上一次留下的那个词。
     */
    setHandoffFocus(handoffQuery ? { projectId, query: handoffQuery } : null)
    setBoardView('kanban')
    setMainView('board')
  }

  return (
    <div
      className="project-shell w-screen h-screen flex frosted-glass window-frame overflow-hidden"
      style={{ borderRadius: settings.kanbanBorderRadius }}
    >
      <Sidebar />

      <div className="flex-1 min-w-0 flex flex-col">
        {/* 顶栏：当前范围 + 常用目的地；搜索/筛选/新增仍只在看板形态出现 */}
        <div className="flex items-center justify-between pl-4 pr-1.5 py-1.5 titlebar-drag border-b border-border shrink-0">
          <div className="titlebar-no-drag flex items-center gap-3 min-w-0">
            <span className="text-column-title font-semibold text-text-primary truncate">
              {inBoard
                ? workspaceMode === 'project'
                  ? selectedProject?.name ?? '当前项目'
                  : workspaceMode === 'all'
                    ? '全量查找'
                    : '我的工作'
                : VIEW_LABEL[mainView]}
            </span>

            <nav aria-label="主导航" className="flex items-center gap-1 shrink-0">
              {inBoard && workspaceMode === 'project' && selectedProject ? (
                <div className="project-tabs flex items-center gap-0.5">
                  {([
                    ['overview', '概览', 'circle'],
                    ['items', '事项', 'layoutBoard'],
                    ['activity', '动态', 'clock'],
                    ['versions', '版本', 'tag'],
                    ['docs', '文档', 'fileText'],
                    ['search', '全局搜索', 'search']
                  ] as const).map(([tab, label, icon]) => (
                    <button
                      key={tab}
                      type="button"
                      onClick={() => {
                        setProjectTab(tab)
                        if (tab === 'overview') { setMainView('board'); setBoardView('kanban') }
                        else if (tab === 'activity') { setMainView('board'); setBoardView('timeline') }
                        else if (tab === 'items') { setMainView('board'); setBoardView('kanban') }
                        else if (tab === 'search') { setProjectSearchQuery(''); setProjectSearchIds([]); setMainView('board'); setBoardView('kanban') }
                        else { setMainView('board'); setBoardView('kanban') }
                      }}
                      aria-current={projectTab === tab ? 'page' : undefined}
                      className={cn(
                        'inline-flex items-center gap-1 h-7 px-2.5 rounded-button text-label transition-colors',
                        projectTab === tab
                          ? 'bg-bg-card text-text-primary shadow-sm'
                          : 'text-text-secondary hover:text-text-primary'
                      )}
                    >
                      <Icon name={icon} size={12} />{label}
                    </button>
                  ))}
                </div>
              ) : null}
            </nav>
          </div>

          <div className="titlebar-no-drag flex items-center gap-1">
            {/* 顶层只留一个跨项目入口；事项相关工具属于事项页，放在页内范围条上 */}
            {inBoard && workspaceMode === 'workbench' && (
              <button
                type="button"
                onClick={() => useUIStore.getState().enterAllItems()}
                className="h-8 inline-flex items-center gap-1.5 px-2.5 rounded-button border border-border text-label text-text-secondary hover:bg-black/5 hover:text-text-primary transition-colors"
              >
                <Icon name="search" size={14} />全局搜索
              </button>
            )}
            <WindowControls />
          </div>
        </div>

        {/* 我的工作是跨项目行动汇总：视角只在这里切换，进入项目后由负责人筛选承担相同语义。 */}
        {inBoard && workspaceMode === 'workbench' && (
          <div className="flex items-center gap-2.5 px-6 py-2 border-b border-border bg-bg-card/40 shrink-0" aria-label="工作视角">
            <span className="text-label text-text-secondary shrink-0">视角</span>
            <ViewScopeSwitcher />
          </div>
        )}

        {/* 项目事项的唯一范围入口：状态列本身表达具体状态，范围只负责当前/已结束/全部。
            事项页的工具（搜索与筛选 / 新增 / 批量）与范围同一行、靠右，属于事项页本身，不上顶栏。 */}
        {showProjectScope && (
          <div className="flex items-center gap-2 px-4 py-2 border-b border-border bg-bg-card/40 shrink-0" aria-label="项目内容范围">
            <div className="inline-flex items-center p-0.5 rounded-button bg-surface-muted border border-border/60">
              {([
                ['current', '当前工作'],
                ['ended', '已结束'],
                ['all', '全部']
              ] as const).map(([scope, label]) => (
                <button
                  key={scope}
                  type="button"
                  onClick={() => setWorkItemScope(scope)}
                  aria-pressed={workItemScope === scope}
                  className={cn(
                    'h-6 px-3 rounded-input text-label transition-colors cursor-pointer',
                    workItemScope === scope
                      ? 'bg-bg-card text-text-primary font-semibold shadow-sm'
                      : 'text-text-secondary hover:text-text-primary'
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
            {showItemTools && (
              <div className="ml-auto flex items-center gap-1.5" aria-label="事项工具">
                <button
                  type="button"
                  onClick={() => setPanelOpen((open) => !open)}
                  aria-expanded={panelOpen}
                  className={cn(
                    'h-7 inline-flex items-center gap-1.5 px-2.5 rounded-button border text-label transition-colors cursor-pointer',
                    panelOpen
                      ? 'text-accent bg-accent/10 border-accent/30 font-medium'
                      : 'text-text-secondary border-border bg-bg-card hover:bg-surface-subtle hover:text-text-primary'
                  )}
                  title="在当前项目的事项里搜索、筛选（范围：本项目当前列表）"
                >
                  <Icon name="search" size={13} />搜索与筛选
                </button>
                <button
                  onClick={toggleMultiSelect}
                  className={cn(
                    'h-7 px-2.5 rounded-button text-label border transition-colors cursor-pointer',
                    multiSelectMode
                      ? 'bg-accent/15 text-accent border-accent/30 font-medium'
                      : 'text-text-secondary border-border bg-bg-card hover:bg-surface-subtle hover:text-text-primary'
                  )}
                  title={multiSelectMode ? '退出批量操作' : '批量操作：勾选多条一起改'}
                >
                  批量
                </button>
                <button
                  onClick={handleNewTodo}
                  className="h-7 px-3 rounded-button text-label font-medium bg-accent text-white hover:opacity-90 transition-opacity cursor-pointer"
                >
                  + 新增
                </button>
              </div>
            )}
          </div>
        )}

        {/*
          筛选弹层：搜索框 + 全部细化筛选控件。
          今天/逾期与状态范围都属于主面板筛选，不再由侧栏智能视图承载。
          视角是「我的工作」页面与项目事项页的细化条件，不在这里复制第二套入口。
        */}
        {showItemTools && panelOpen && (
          <div className="shrink-0">
            <SearchBar autoFocus visibleCount={boardVisibleCount} />
          </div>
        )}

        {/* 内容区第一行：chips 回显（没有激活筛选时不渲染） */}
        {showItemTools && <ChipsBar visibleCount={boardVisibleCount} />}

        {/* 批量工具条只在实际事项列表中展示 */}
        {showItemTools && <BatchBar />}

        {/* 主体：看板两种形态 / 通知中心 / 统计 / 设置 / 用户 */}
        {mainView === 'notifications' && <NotificationsView />}
        {mainView === 'approval' && <ApprovalView />}
        {mainView === 'stats' && <StatsView />}
        {mainView === 'releases' && !(inBoard && workspaceMode === 'project' && projectTab === 'versions') && <ReleasesView projectId={workspaceMode === 'project' ? filterProject : null} />}
        {inBoard && workspaceMode === 'project' && projectTab === 'versions' && selectedProject && (
          <ReleasesView
            projectId={selectedProject.id}
            onOpenItems={() => {
              setProjectTab('items')
              setMainView('board')
              setBoardView('kanban')
            }}
          />
        )}
        {mainView === 'settings' && <SettingsView />}
        {mainView === 'user' && <UserView />}
        {mainView === 'quickstart' && <QuickStartView />}
        {inBoard && workspaceMode === 'project' && projectTab === 'search' && selectedProject && (
          <GlobalSearchView
            key={`${projectSearchQuery}|${projectSearchIds.join(',')}`}
            initialQuery={projectSearchQuery}
            initialProjectIds={projectSearchIds}
            onOpenTodo={openSearchResultInProject}
            onOpenProject={openGlobalSearchProject}
          />
        )}
        {inBoard && workspaceMode === 'project' && projectTab === 'docs' && selectedProject && (
          <ProjectDocsView
            projectId={selectedProject.id}
            onOpenOverview={() => {
              setProjectTab('overview')
              setMainView('board')
              setBoardView('kanban')
            }}
          />
        )}
        {inBoard && workspaceMode === 'project' && projectTab === 'overview' && selectedProject && (
          <ProjectOverviewView
            projectId={selectedProject.id}
            focusHandoffQuery={handoffFocus && handoffFocus.projectId === selectedProject.id ? handoffFocus.query : ''}
            onOpenItems={(status) => {
              setProjectTab('items')
              setMainView('board')
              setBoardView('kanban')
              if (status) {
                useUIStore.getState().setWorkItemScope('all')
                useUIStore.getState().setFilterStatus(status)
              }
            }}
            onOpenVersions={() => {
              setProjectTab('versions')
              setMainView('board')
              setBoardView('kanban')
            }}
          />
        )}
        {inBoard && workspaceMode === 'all' && (
          <GlobalSearchView onOpenTodo={openGlobalSearchTodo} onOpenProject={openGlobalSearchProject} />
        )}
        {/*
          「我的工作」独立行动汇总：在 enterWorkbench() 中已同步将 boardView 重置为 'kanban'，
          保留 `workspaceMode === 'workbench' && boardView === 'kanban' && <WorkbenchView />` 契约。
        */}
        {inBoard && workspaceMode === 'workbench' && boardView === 'kanban' && <WorkbenchView />}
        {inBoard && workspaceMode !== 'workbench' && workspaceMode !== 'all' && (workspaceMode !== 'project' || projectTab === 'items') && boardView === 'kanban' && (
          <KanbanBoard
            onOpenProjectSearch={workspaceMode === 'project' ? (query) => {
              setProjectSearchQuery(query ?? '')
              setProjectSearchIds(filterProject ? [filterProject] : [])
              setProjectTab('search')
              setBoardView('kanban')
              setMainView('board')
            } : undefined}
          />
        )}
        {inBoard && workspaceMode !== 'workbench' && workspaceMode !== 'all' && (workspaceMode !== 'project' || projectTab === 'activity') && boardView === 'timeline' && (
          <div className="flex-1 min-h-0 flex flex-col">
            {workspaceMode === 'project' && filterProject && (
              <div className="activity-switch shrink-0 flex flex-wrap items-center justify-between gap-3 px-6 py-2.5 border-b border-border bg-bg-card/50" role="tablist" aria-label="项目动态内容">
                <div className="inline-flex items-center p-0.5 rounded-button bg-surface-muted border border-border/60">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={activityMode === 'timeline'}
                    onClick={() => setActivityMode('timeline')}
                    className={cn(
                      'h-7 px-3 rounded-input text-label transition-colors inline-flex items-center gap-1.5 cursor-pointer',
                      activityMode === 'timeline'
                        ? 'bg-bg-card text-text-primary font-semibold shadow-sm'
                        : 'text-text-secondary hover:text-text-primary'
                    )}
                  >
                    <Icon name="clock" size={13} />项目动态
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={activityMode === 'notifications'}
                    onClick={() => setActivityMode('notifications')}
                    className={cn(
                      'h-7 px-3 rounded-input text-label transition-colors inline-flex items-center gap-1.5 cursor-pointer',
                      activityMode === 'notifications'
                        ? 'bg-bg-card text-text-primary font-semibold shadow-sm'
                        : 'text-text-secondary hover:text-text-primary'
                    )}
                  >
                    <Icon name="bell" size={13} />项目通知
                    <span className="rounded-tag bg-accent/12 px-1.5 py-0.5 text-caption text-accent font-medium">收件箱</span>
                  </button>
                </div>
                <span className="text-caption text-text-secondary">
                  {activityMode === 'timeline' ? '时间线：记录项目发生过什么。' : '收件箱：查看需要你知道或处理的项目消息。'}
                </span>
              </div>
            )}
            {activityMode === 'notifications' && workspaceMode === 'project' && filterProject ? (
              <NotificationsView projectId={filterProject} />
            ) : (
              <TimelineView />
            )}
          </div>
        )}

        {/* 全局轻提示：失败不能只落在控制台（1.0.48） */}
        <Toast />
      </div>
    </div>
  )
}

export default Kanban
