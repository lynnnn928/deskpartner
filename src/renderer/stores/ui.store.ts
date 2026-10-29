import { create } from 'zustand'
import type { TodoStatus, TodoPriority, TodoType } from '../types/enums'
import type { Todo } from '../types/todo'
import { DEFAULT_TIME_RANGE, type TimeRange } from '../lib/timeline-group'
import type { DueScope } from '../lib/due-scope'

/**
 * 一次可撤销的操作（1.0.48 做真）
 *
 * 此前 undoQueue 只有 id 和定时器，**没有任何调用方往里放东西**，
 * 界面上的「撤销」是个点了只会把提示条关掉的空按钮 ——
 * 比没有更糟：它让人以为删掉的东西还回得来。
 *
 * 现在每次入队都带一份**操作前的完整快照**：
 * 删 → 恢复这条（含 id / 提出者 / 时间戳，子任务引用不断）；
 * 拖 → 回原状态。快照由调用方在动作发生前取，主进程不存回收站。
 */
export interface UndoItem {
  /** 用被操作事项的 id 做键：同一条连续操作只留最后一次 */
  id: string
  /** 提示条上要说的话，如「已删除「写周报」」 */
  label: string
  /** 操作前的完整事项 */
  snapshot: Todo
  /** 4 秒后自动消失（这期间不撤就等于认了） */
  timeout: ReturnType<typeof setTimeout>
}

/** 撤销窗口：4 秒 —— 够反应过来，又不至于一直挡着看板 */
const UNDO_TTL_MS = 4000

/** 全局轻提示停留时长 */
const TOAST_TTL_MS = 3500

/** toast 自动消失的定时器：模块级即可，它不属于界面状态 */
let toastTimer: ReturnType<typeof setTimeout> | null = null

/**
 * 看板窗口的形态
 *
 * 同一批数据的两副面孔：
 * - 看板：按**状态**分列，答"接下来做什么"
 * - 动态：按**时间**铺开，答"发生过什么"
 *
 * （方向视图——按标签跨状态聚合——经 PO 评审撤下：看板本来就跨状态，
 * 按分类筛选即得同貌，方向形态只剩完成度汇总这一条立身之本，
 * 归复盘级需求。代码在 git 历史，不回退提交。）
 *
 * 切换只换呈现方式，**不换筛选条件** —— 所以它和筛选放在同一个 store 里，
 * 选了某个标签之后切形态，看的还是这个标签。
 */
export type BoardView = 'kanban' | 'timeline'

/**
 * 项目工作空间的导航范围；项目不是普通筛选，而是当前工作的家。
 * 状态和时间范围由主面板的筛选控件管理，不在导航层重复表达。
 */
export type WorkspaceMode = 'workbench' | 'project' | 'all'

/** 工作空间内的事项集合。current 是默认工作，历史集合需显式进入。 */
export type WorkItemScope = 'current' | 'ended' | 'all'


/**
 * 主窗口内容区视图（1.0.48）
 *
 * 主窗口是多视图容器：board=看板/动态（两种形态）、notifications=通知中心、
 * stats=统计、settings=设置、user=用户页。Stats/Settings 独立窗口同期退役。
 * 选一个智能视图必然回到 board（点「今天」就是想看板，不是想留在通知里）。
 */
export type MainView =
  | 'board'
  | 'notifications'
  | 'approval'
  | 'stats'
  | 'releases'
  | 'settings'
  | 'user'
  | 'quickstart'

interface UIState {
  // 看板筛选
  searchKeyword: string
  filterCategory: string | null
  filterStatus: TodoStatus | null
  showUnreadOnly: boolean
  /**
   * 按归属筛选：'all' 不限，其余是具体的 owner 值
   *
   * 精确到"哪个 agent"而不是只分人类/AI —— agent 有很多个
   * （Alice、Bob、Codex…），笼统归成一大类看不出是谁做的。
   * 可选值是动态的，从数据里提取，见 lib/todo-filter 的 collectOwners。
   */
  filterOwner: string
  /** 按执行人筛选（与详情页「执行人」对齐）：'all' 不限，其余是具体身份或 'agent' */
  filterExecutor: string
  /** 看板泳道列宽（px，默认 288，范围 240~420，支持拖拽列右缘调节） */
  kanbanColumnWidth: number
  /**
   * 按项目筛选：null 不限，其余是项目 id
   *
   * 项目比标签更高一层 —— 标签说"这件事是什么性质"，项目说"这件事属于哪摊"。
   * 人想知道"DeskPartner 这事推进到哪了"时，要的是后者。
   */
  filterProject: string | null
  /** 全局查找的项目多选；项目空间仍使用 filterProject 作为唯一上下文。 */
  filterProjectIds: string[]
  /** 当前导航上下文：跨项目工作台、某个项目，或明确的全量查找。 */
  workspaceMode: WorkspaceMode
  /** 新进入项目时的落地页请求；消费后恢复默认事项页。 */
  projectEntryTab: 'overview' | 'items'
  /** 从项目页等入口直达用户页特定分区与项目范围 */
  userEntryTarget: {
    section: 'about' | 'protocol' | 'rules' | 'team' | 'access'
    projectId?: string
  } | null

  setProjectEntryTab: (tab: 'overview' | 'items') => void
  openUserSection: (
    section: 'about' | 'protocol' | 'rules' | 'team' | 'access',
    projectId?: string
  ) => void
  clearUserEntryTarget: () => void
  /** 当前上下文中的状态范围；状态细分由 filterStatus 单独表达。 */
  workItemScope: WorkItemScope

  /**
   * 按优先级筛选：'all' 不限
   *
   * CLI 的 `todo list --priority` 一直有，界面此前没有 ——
   * agent 报「还有 3 条 urgent 没做」时，人筛不出来只能逐列扫，
   * 于是这句话无法核实。判据：agent 说的信息要能在界面上被验证。
   */
  filterPriority: TodoPriority | 'all'
  /**
   * 按事项类型筛选：'all' 不限
   *
   * 同 filterPriority：CLI 的 `todo list --type` 一直有，
   * agent 报「有 5 个 bug 待修」时界面无法核实。
   */
  filterType: TodoType | 'all'
  /**
   * 按「解决于版本」筛选：null 不限，其余是版本号 / UNSET_FIXED / ANY_FIXED
   *
   * 主用户 2026-09-29 的原话：「我现在既不清楚你当前版本准备处理哪些问题，
   * 也不知道发布后具体解决了哪些问题」。看板此前只能答"在做/已做完"
   * （靠状态列），答不了"归哪一版"—— 版本与事项的映射只能去翻 README。
   * 这条筛选把它补上：发版时标版本，之后按版本筛即可同时回答两个问题。
   */
  filterFixedIn: string | null

  /** 当前形态：看板 / 动态 */
  boardView: BoardView

  /** 内容区当前视图：看板/动态 还是 通知中心 */
  mainView: MainView

  /**
   * 动态的时间范围
   *
   * **只在动态形态生效**：看板答的是"当下要做什么"，按时间切它没有意义
   * （那是「今天/逾期」视角该干的事）。所以它跟着形态走，不进共享筛选。
   */
  filterTimeRange: TimeRange

  /**
   * 看板形态的**创建时间**范围
   *
   * 与上面的 filterTimeRange 是两套独立状态，不能合并：
   * 动态那条按"节点发生时间"切（完成、验收这些动作的时间），
   * 看板这条按"什么时候记下来的"切。如果在动态里选了「近 7 天」、
   * 切回看板发现卡片也被过滤了（而且滤掉的依据完全不同），那是很难解释的错乱。
   *
   * 复用同一个 TimeRange 结构是为了省掉一套重复的 UI 与自然日口径
   * （边界怎么算这个问题已经在该模块里解决过一次）。
   *
   * 会话级，不落库：筛选是"我现在要看什么"，不是"我的数据有什么属性"。
   */
  filterCreatedRange: TimeRange

  /**
   * 「今天 / 逾期」视角
   *
   * **只在看板形态生效**：动态那条河有自己的时间范围（按发生时间切），
   * 这里切的是"该处理的"（按截止时间切），两套口径不能混。
   */
  filterDue: DueScope

  /**
   * 已折叠的看板列
   *
   * **会话级状态，刻意不落库**：折叠是"此刻想多看两列"的临时动作，
   * 不是偏好设置 —— 下次打开还折叠着，反而让人疑惑"我的列去哪了"。
   */
  collapsedColumns: TodoStatus[]
  toggleColumn: (status: TodoStatus) => void

  /**
   * 视角：在看谁的（cc7df746）
   *
   * 'all' = 全部；'mine' = 与我相关（我提的 + 指派给我的）；'agent:<id>' = 与某个 agent 相关。
   * 与 filterOwner（提出者）是两个维度，见 matchesViewScope 的说明。
   *
   * 会话级，不落库：与列折叠同理 —— 下次打开停在某个 agent 视角上，
   * 人只会以为"我的待办少了"。
   */
  viewScope: string

  // 撤销队列
  undoQueue: UndoItem[]

  /**
   * 全局轻提示（1.0.48）
   *
   * 此前失败的 IPC 只落在 console.error —— 界面上没有任何痕迹，
   * 人看到的是"我点了但没反应"。失败必须看得见，哪怕是短短一句。
   */
  toast: string | null
  showToast: (message: string) => void
  clearToast: () => void

  // 多选模式
  multiSelectMode: boolean
  selectedIds: string[]

  // 操作
  setSearchKeyword: (keyword: string) => void
  setFilterCategory: (id: string | null) => void
  setFilterStatus: (status: TodoStatus | null) => void
  setShowUnreadOnly: (show: boolean) => void
  setFilterOwner: (owner: string) => void
  setFilterExecutor: (executor: string) => void
  setKanbanColumnWidth: (width: number) => void
  setFilterProject: (id: string | null) => void
  setFilterProjectIds: (ids: string[]) => void
  /** 进入项目空间；同一项目重复进入也保持项目上下文。 */
  enterProject: (id: string) => void
  /** 返回跨项目工作台，集中看当前仍需处理的事项。 */
  enterWorkbench: () => void
  /** 打开明确的全量事项查找入口。 */
  enterAllItems: () => void
  /** 切换当前状态范围，不改变项目归属。 */
  setWorkItemScope: (scope: WorkItemScope) => void
  /** 切换上下文时清除会隐藏内容的临时条件，保留展示偏好。 */
  resetTransientFilters: () => void
  setFilterPriority: (p: TodoPriority | 'all') => void
  setFilterType: (t: TodoType | 'all') => void
  setFilterFixedIn: (v: string | null) => void
  setBoardView: (view: BoardView) => void
  setMainView: (view: MainView) => void
  setFilterTimeRange: (range: TimeRange) => void
  setFilterCreatedRange: (range: TimeRange) => void
  setFilterDue: (scope: DueScope) => void
  setViewScope: (scope: string) => void
  removeUndoItem: (id: string) => void
  /**
   * 入队一次可撤销操作：label + 操作前快照。
   * 同一条事项连续操作只留最后一次（否则队列堆一串，撤的是不知哪一次）。
   */
  pushUndo: (item: { id: string; label: string; snapshot: Todo }) => void
  toggleMultiSelect: () => void
  toggleSelectId: (id: string) => void
  clearSelection: () => void
  /**
   * 驳回理由弹框的挂起态（1.0.54）。
   *
   * 「待验收 → 进行中」被拦下时置入，由看板渲染理由输入框；
   * 提交/取消后清空。放在 store 而不是组件 state：拖拽发生在
   * useDragSort（非组件），它需要一个无处不达的通道把意图交给 UI。
   */
  pendingReject: PendingReject | null
  setPendingReject: (p: PendingReject | null) => void

  /**
   * 「去审批」的待处理申请 id（1.0.55，主用户驳回 2ccc6fc6）。
   *
   * 她的原话：「审批通知还在通知里，应该迁移到审批中」——
   * 点一条审批通知，应该直接落到**那一条申请**上，而不是只把人丢到审批页
   * 让他在队列里自己找。审批页读到它就把这条高亮出来，然后清空。
   */
  focusGrantId: string | null
  setFocusGrantId: (id: string | null) => void
}

export interface PendingReject {
  id: string
  title: string
  /** 拖拽前的整条快照 —— 提交失败时回滚，取消时也回到原位 */
  snapshot: Todo
}

export const useUIStore = create<UIState>()((set) => ({
  searchKeyword: '',
  filterCategory: null,
  filterStatus: null,
  showUnreadOnly: false,
  filterOwner: 'all',
  filterExecutor: 'all',
  kanbanColumnWidth: (() => {
    try {
      const raw = typeof window !== 'undefined' ? window.localStorage.getItem('deskpartner.kanbanColumnWidth') : null
      const parsed = raw ? Number(raw) : NaN
      return Number.isFinite(parsed) && parsed >= 240 && parsed <= 420 ? Math.round(parsed) : 288
    } catch {
      return 288
    }
  })(),
  filterProject: null,
  filterProjectIds: [],
  workspaceMode: 'workbench',
  projectEntryTab: 'items',
  userEntryTarget: null,
  workItemScope: 'current',
  filterPriority: 'all',
  filterType: 'all',
  filterFixedIn: null,
  boardView: 'kanban',
  mainView: 'board',
  filterTimeRange: DEFAULT_TIME_RANGE,
  filterCreatedRange: DEFAULT_TIME_RANGE,
  filterDue: 'all',
  viewScope: 'mine',
  collapsedColumns: [],
  undoQueue: [],
  toast: null,
  multiSelectMode: false,
  selectedIds: [],

  setSearchKeyword: (keyword) => set({ searchKeyword: keyword }),
  setFilterCategory: (id) => set({ filterCategory: id }),
  setFilterStatus: (status) =>
    set((state) => {
      const ended = status !== null && ['done', 'suspended', 'discarded'].includes(status)
      const scope: WorkItemScope = status === null ? state.workItemScope : ended ? 'ended' : 'current'
      return {
        filterStatus: status,
        workItemScope: scope,
        filterDue: 'all',
        selectedIds: [],
        multiSelectMode: false
      }
    }),
  setShowUnreadOnly: (show) => set({ showUnreadOnly: show }),
  setFilterOwner: (owner) => set({ filterOwner: owner }),
  setFilterExecutor: (executor) => set({ filterExecutor: executor }),
  setKanbanColumnWidth: (width) => {
    const clamped = Math.max(240, Math.min(420, Math.round(width)))
    try {
      if (typeof window !== 'undefined') {
        window.localStorage.setItem('deskpartner.kanbanColumnWidth', String(clamped))
      }
    } catch {
      /* ignore storage errors */
    }
    set({ kanbanColumnWidth: clamped })
  },
  setFilterProject: (id) => set({ filterProject: id, filterProjectIds: [] }),
  setFilterProjectIds: (ids) => set({ filterProjectIds: ids, filterProject: null }),
  setProjectEntryTab: (tab) => set({ projectEntryTab: tab }),
  openUserSection: (section, projectId) =>
    set({
      userEntryTarget: { section, projectId },
      mainView: 'user'
    }),
  clearUserEntryTarget: () => set({ userEntryTarget: null }),
  resetTransientFilters: () =>
    set({
      searchKeyword: '',
      filterCategory: null,
      filterOwner: 'all',
      filterExecutor: 'all',
      filterPriority: 'all',
      filterType: 'all',
      filterFixedIn: null,
      filterCreatedRange: DEFAULT_TIME_RANGE,
      filterTimeRange: DEFAULT_TIME_RANGE,
      filterDue: 'all',
      selectedIds: [],
      multiSelectMode: false
    }),
  enterProject: (id) =>
    set({
      workspaceMode: 'project',
      projectEntryTab: 'items',
      workItemScope: 'current',
      boardView: 'kanban',
      filterProject: id,
      filterProjectIds: [],
      searchKeyword: '',
      filterCategory: null,
      filterOwner: 'all',
      filterExecutor: 'all',
      filterPriority: 'all',
      filterType: 'all',
      filterFixedIn: null,
      filterCreatedRange: DEFAULT_TIME_RANGE,
      filterTimeRange: DEFAULT_TIME_RANGE,
      filterDue: 'all',
      filterStatus: null,
      viewScope: 'all',
      selectedIds: [],
      multiSelectMode: false,
      mainView: 'board'
    }),
  enterWorkbench: () =>
    set({
      workspaceMode: 'workbench',
      workItemScope: 'current',
      boardView: 'kanban',
      filterProject: null,
      filterProjectIds: [],
      searchKeyword: '',
      filterCategory: null,
      filterOwner: 'all',
      filterExecutor: 'all',
      filterPriority: 'all',
      filterType: 'all',
      filterFixedIn: null,
      filterCreatedRange: DEFAULT_TIME_RANGE,
      filterTimeRange: DEFAULT_TIME_RANGE,
      filterDue: 'all',
      filterStatus: null,
      viewScope: 'mine',
      selectedIds: [],
      multiSelectMode: false,
      mainView: 'board'
    }),
  enterAllItems: () =>
    set({
      workspaceMode: 'all',
      workItemScope: 'all',
      boardView: 'kanban',
      filterProject: null,
      filterProjectIds: [],
      searchKeyword: '',
      filterCategory: null,
      filterOwner: 'all',
      filterExecutor: 'all',
      filterPriority: 'all',
      filterType: 'all',
      filterFixedIn: null,
      filterCreatedRange: DEFAULT_TIME_RANGE,
      filterTimeRange: DEFAULT_TIME_RANGE,
      filterDue: 'all',
      filterStatus: null,
      viewScope: 'all',
      selectedIds: [],
      multiSelectMode: false,
      mainView: 'board'
    }),
  setWorkItemScope: (scope) =>
    set((state) => ({
      workItemScope: scope,
      mainView: 'board',
      // 精确状态属于范围之下的细化筛选；切换范围后清掉不兼容值。
      // 「全部」不保留旧状态，否则按钮看似切到全部、列表却仍只有一列。
      filterStatus:
        scope === 'all' ||
        (state.filterStatus &&
          ((scope === 'current' && ['done', 'suspended', 'discarded'].includes(state.filterStatus)) ||
            (scope === 'ended' && !['done', 'suspended', 'discarded'].includes(state.filterStatus))))
          ? null
          : state.filterStatus,
      filterDue: 'all',
      selectedIds: [],
      multiSelectMode: false
    })),
  setFilterPriority: (p) => set({ filterPriority: p }),
  setFilterType: (t) => set({ filterType: t }),
  setFilterFixedIn: (v) => set({ filterFixedIn: v }),
  setBoardView: (view) => set({ boardView: view }),
  setMainView: (view) => set({ mainView: view }),
  setFilterTimeRange: (range) => set({ filterTimeRange: range }),
  setFilterCreatedRange: (range) => set({ filterCreatedRange: range }),
  setFilterDue: (scope) => set({ filterDue: scope }),
  setViewScope: (scope) => set({ viewScope: scope }),
  toggleColumn: (status) =>
    set((s) => ({
      collapsedColumns: s.collapsedColumns.includes(status)
        ? s.collapsedColumns.filter((c) => c !== status)
        : [...s.collapsedColumns, status]
    })),
  removeUndoItem: (id) =>
    set((s) => ({
      undoQueue: s.undoQueue.filter((u) => {
        if (u.id !== id) return true
        clearTimeout(u.timeout)
        return false
      })
    })),
  pushUndo: ({ id, label, snapshot }) =>
    set((s) => {
      // 同一条事项上一条还没撤，先清掉它的定时器 —— 队列里只留最后一次
      const rest = s.undoQueue.filter((u) => {
        if (u.id !== id) return true
        clearTimeout(u.timeout)
        return false
      })
      const timeout = setTimeout(() => {
        useUIStore.getState().removeUndoItem(id)
      }, UNDO_TTL_MS)
      return { undoQueue: [...rest, { id, label, snapshot, timeout }] }
    }),
  showToast: (message) => {
    if (toastTimer) clearTimeout(toastTimer)
    toastTimer = setTimeout(() => {
      toastTimer = null
      useUIStore.setState({ toast: null })
    }, TOAST_TTL_MS)
    set({ toast: message })
  },
  clearToast: () => {
    if (toastTimer) {
      clearTimeout(toastTimer)
      toastTimer = null
    }
    set({ toast: null })
  },
  toggleMultiSelect: () =>
    set((s) => ({ multiSelectMode: !s.multiSelectMode, selectedIds: [] })),
  toggleSelectId: (id) =>
    set((s) => ({
      selectedIds: s.selectedIds.includes(id)
        ? s.selectedIds.filter((i) => i !== id)
        : [...s.selectedIds, id]
    })),
  clearSelection: () => set({ selectedIds: [], multiSelectMode: false }),
  pendingReject: null,
  setPendingReject: (p) => set({ pendingReject: p }),
  focusGrantId: null,
  setFocusGrantId: (id) => set({ focusGrantId: id })
}))
