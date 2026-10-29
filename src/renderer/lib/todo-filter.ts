import type { Todo } from '../types/todo'
import type { TodoPriority, TodoType, TodoStatus } from '../types/enums'
import type { WorkspaceMode, WorkItemScope } from '../stores/ui.store'
import { isWithinTimeRange, type TimeRange } from './timeline-group'
import { useAgentStore } from '../stores/agent.store'

/**
 * 归属筛选
 *
 * 'all' = 不限；'agent' = **所有 agent**（通配，与 CLI 的 `--created-by agent` 同口径）；
 * 其余精确匹配提出者值（如 human / agent:alice）。
 *
 * 为什么要 'agent' 这一档：CLI 早就有（传 agent 看所有 agent 的），
 * 而界面只能逐个体精确匹配 —— 本机有 2 个 agent 时想"看看 AI 一共干了多少"
 * 就做不到（归属是单选）。agent 报"AI 处理了 N 条"时人无法核实。
 */
export type OwnerFilter = 'all' | 'agent' | string

/** 「所有 agent」这一档的哨兵值（与 CLI --created-by agent 对齐） */
export const ALL_AGENTS = 'agent'

/** 看板筛选条件 */
export interface TodoFilter {
  keyword: string
  categoryId: string | null
  owner: OwnerFilter
  /** 按执行人筛选（与详情页「执行人」字段对齐）：'all' 不限 / 'agent' 所有 AI / 具体身份 */
  executor?: OwnerFilter
  /** 项目 id；null 表示不限 */
  projectId?: string | null
  /** 全局查找的项目多选；空数组表示不限 */
  projectIds?: string[]
  /**
   * 创建时间范围（看板形态用）
   *
   * 切的是 created_at —— "这批事是什么时候记进来的"。
   * 和「今天 / 逾期」视角（切 due_at，"什么时候该做"）是两个完全不同的口径，
   * 可以同时生效：既"只看逾期的"又"只看本周记的"。
   */
  createdRange?: TimeRange
  /**
   * 优先级：'all' 或具体值；不传 = 不限
   *
   * CLI 的 `todo list --priority` 一直有，界面没有 ——
   * agent 报「还有 3 条 urgent 没做」时，人筛不出来，只能逐列扫。
   */
  priority?: TodoPriority | 'all'
  /**
   * 事项类型：'all' 或具体值；不传 = 不限
   *
   * 同 priority：CLI 的 `todo list --type` 一直有，界面没有 ——
   * agent 报「有 5 个 bug 待修」时无法核实。
   */
  type?: TodoType | 'all'
  /**
   * 解决于版本（v24）：'all' 不限 / 具体版本号 / UNSET_FIXED / ANY_FIXED
   *
   * 直接回答主用户 2026-09-29 提的两个问题：
   * 「这个版本准备处理哪些」= 筛版本号；「发布后解决了哪些」= 同一个动作。
   * 版本号与事项的映射由这条筛选打通，不必再去读 README。
   */
  fixedIn?: string
}

/**
 * 「未标注版本」这个筛选项的哨兵值
 *
 * 与项目那栏的 NO_PROJECT 同因：`null` 在 filter 里表示"不限"，
 * 表达不了"就要还没标版本的那批"。而这恰恰是最常用的一个 ——
 * 发版前要看的正是"还有哪些修完了却没标版本"。
 */
export const UNSET_FIXED = '__unset__'

/** 「已标注版本」哨兵：看所有已经归档到某版的事项（与 CLI --fixed-in any 同口径） */
export const ANY_FIXED = '__any__'

/**
 * 「未归入任何项目」这个筛选项的哨兵值
 *
 * projectId 为 null 在 filter 里表示"不限"，没法表达"就要没项目的那批"。
 * 而这件事恰恰有用：agent 批量记的东西如果没带项目，人一眼看不出来，
 * 得能专门把它们捞出来收拾。
 */
export const NO_PROJECT = '__none__'

/**
 * 已知 agent 的显示名 —— **仅作兜底**，不是权威（1.0.65 修 `4050942e`）
 *
 * 🚨 这张表曾经是唯一来源，而它的 key 还写错了（`qwen` 而实际是 `bob`），
 * 于是查不到就回退成原始 id，同一个 agent 在同一屏出现两个名字
 * （「提出者」写 `bob`、「交给 AI」写「Bob」，真实库 121 条中招）。
 *
 * 现在显示名的权威是 `agents` 表（可编辑），由 `agent.store` 提供。
 * 这张表**只在 store 还没加载出来时**顶上——那种情况下总比显示裸 id 好。
 *
 * 为什么不干脆删掉：删了的话，首屏那一瞬（store 还没 fetch 完）
 * 所有 agent 都会显示成 `alice` / `bob`，比"个别名字不准"更难看。
 * 留它兜底 + 让 store 覆盖，两头都不吃亏。
 *
 * ⚠️ 别再往这张表里加"新接的 agent" —— 加了也不解决问题：
 * 下次有人改了显示名（`agents` 表可编辑），这张表又对不上了。
 * 它的价值只剩"覆盖最常见的几个"。
 */
const AGENT_LABELS: Record<string, string> = {
  alice: 'Alice',
  bob: 'Bob',
  codex: 'Codex',
  trae: 'Trae'
}

/**
 * 把提出者值转成给人看的名字：agent:alice → Alice
 *
 * `humanName` 是人在设置里给自己取的名字（v15 起，首次启动会问一次）。
 * 传了就显示名字，没取名字（空串 / 不传）回退成「我」——
 * 动态页是两边都读的时间线，「我验收通过了」里的「我」对 agent 是歧义的，
 * 但也不能因为没取名字就显示 `human` 这种内部标识。
 *
 * ## 显示名的查找顺序（1.0.65 起）
 * ① `agents` 表（权威，可编辑）→ ② 兜底表 → ③ 去掉前缀的原始 id
 *
 * ①②③ 都要留着：agent 名单是异步加载的，首屏那一瞬 store 还是空的，
 * 查找必须能在那种情况下也给出合理结果。
 *
 * ## 为什么默认就去读 store，而不是让 12 处调用方各自传进来
 *
 * 一开始想的是"保持纯函数、由调用方传入查找函数"（12 个消费方里挑了 5 个改）。
 * 改到一半就发现那是个**依赖自觉**的设计：谁忘了传，就静默回退到那张
 * 兜底表 —— 而兜底表正是本缺陷的病根，症状会原样复现，且没有任何报错。
 * 判据：**凡"依赖使用方自觉"的设计都要验一遍**。
 *
 * 所以这里直接把 store 作为**默认**来源（不传也能拿到正确显示名），
 * `displayNames` 参数只留给测试注入假数据。宁可让这个 lib 依赖一个 store，
 * 也不要留 12 个可以漏接的点 —— 漏接的代价是"缺陷看起来修好了"。
 */
export function ownerLabel(
  owner: string,
  humanName?: string | null,
  /** 仅供测试注入；生产代码省略即可（默认读 agent.store） */
  displayNames?: (owner: string) => string | null
): string {
  if (owner === 'human') return humanName?.trim() || '我'
  if (owner.startsWith('agent:')) {
    const lookup = displayNames ?? defaultDisplayNameLookup
    // ① 权威来源：agents 表
    const fromStore = lookup(owner)
    if (fromStore) return fromStore
    // ② 兜底表
    const id = owner.slice('agent:'.length)
    return AGENT_LABELS[id] ?? id
  }
  return owner
}

/**
 * 默认显示名查找：读 `agent.store`
 *
 * 用 `getState()` 而不挂 hook —— `ownerLabel` 在 12 处被调用，其中
 * 好几处是模块级的工具函数或非组件上下文，hook 在那里用不了。
 * 代价是**组件不会因 agent 改名而自动重渲染**；
 * 但 store 变化时会 `fetchAgents()` 重取，且卡片/详情本来就随 todo 重取，
 * 实际影响面很小。真要讲究，可以在 store 订阅处广播一次刷新。
 */
function defaultDisplayNameLookup(owner: string): string | null {
  // 循环依赖兜底：store 在测试环境可能没初始化，此时静默走兜底表
  try {
    return useAgentStore.getState().getDisplayName(owner)
  } catch {
    return null
  }
}

/**
 * 从数据里提取出现过的提出者
 *
 * **动态取而不是写死选项** —— agent 有几个、叫什么，只有数据知道。
 * 写死的话每接一个新 agent 就得改一次前端，而且用户看不到它。
 */
export function collectOwners(todos: Array<{ createdBy: string }>): string[] {
  const set = new Set<string>()
  for (const t of todos) set.add(t.createdBy)
  // human 排最前，其余按名字排
  return Array.from(set).sort((a, b) => {
    if (a === 'human') return -1
    if (b === 'human') return 1
    return a.localeCompare(b)
  })
}

/**
 * 从数据里提取出现过的实际执行人（executedBy ?? createdBy）
 */
export function collectExecutors(
  todos: Array<{ createdBy: string; executedBy?: string | null }>
): string[] {
  const set = new Set<string>()
  for (const t of todos) set.add(t.executedBy ?? t.createdBy)
  return Array.from(set).sort((a, b) => {
    if (a === 'human') return -1
    if (b === 'human') return 1
    return a.localeCompare(b)
  })
}

/**
 * 从数据里提取出现过的版本号（降序：新的在前）
 *
 * **动态取而不是写死版本列表** —— 与 collectOwners 同一个理由：
 * 有哪些版本只有数据知道（而且它一直在长）。写死的话每发一版都要改前端。
 *
 * 排序按点分段的数值降序（1.0.59 > 1.0.10 > 1.0.9），
 * 不用字典序 —— 字典序会把 1.0.10 排在 1.0.9 前面，人一眼就看出不对。
 * 非标准格式（如 "1.1-beta"）退回字典序放在末尾，不因为格式怪就丢掉它。
 */
export function collectFixedVersions(todos: Array<{ fixedInVersion: string | null }>): string[] {
  const set = new Set<string>()
  for (const t of todos) if (t.fixedInVersion) set.add(t.fixedInVersion)

  const parts = (v: string): number[] | null => {
    const segs = v.split('.')
    const nums = segs.map((s) => Number(s))
    return nums.every((n) => Number.isInteger(n) && n >= 0) ? nums : null
  }

  return Array.from(set).sort((a, b) => {
    const pa = parts(a)
    const pb = parts(b)
    if (pa && pb) {
      for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pb[i] ?? 0) - (pa[i] ?? 0)
        if (d !== 0) return d
      }
      return 0
    }
    if (pa) return -1
    if (pb) return 1
    return b.localeCompare(a)
  })
}

/**
 * 视角：这条事跟"谁"有关（cc7df746）
 *
 * 与筛选里的「处理人」是两个维度，不能互相替代：
 * - 处理人筛的是**提出者**（谁记的），精确等于某个身份；
 * - 视角看的是**相关性** —— 提出者与执行者任一命中就算。
 *   "指派给我做的事"当然属于「我的」视角，但它不是我提的，
 *   用提出者筛永远筛不出来（这正是 agent 报给你的 bug 该出现的地方）。
 *
 * 'all' = 全部（不过滤）；'mine' = 与我相关；'agent:<id>' = 与某个 agent 相关。
 */
export function matchesViewScope(todo: Todo, scope: string): boolean {
  if (!scope || scope === 'all') return true
  const who = scope === 'mine' ? 'human' : scope
  return todo.createdBy === who || todo.executedBy === who
}

/**
 * 判断一条待办是否符合筛选条件
 *
 * 单独抽出来是因为**看板和筛选栏都要用它**：
 * 看板用它决定显示哪些卡片，筛选栏用它算"当前筛选下的完成率"。
 * 两处各写一份的话，改一处忘一处就会出现"数字对不上卡片"。
 */
export function matchesTodoFilter(todo: Todo, filter: TodoFilter): boolean {
  const kw = filter.keyword.trim().toLowerCase()
  // 关键字也匹配 id 前缀：界面上显示的 8 位短号可以直接粘回来搜（方案 H-1）
  if (kw && !todo.title.toLowerCase().includes(kw) && !todo.id.toLowerCase().startsWith(kw)) {
    return false
  }

  // 多值：带了这个标签就算命中（哪怕同时还带着别的标签）
  if (filter.categoryId && !todo.categoryIds.includes(filter.categoryId)) return false

  /*
   * 归属：三档
   * - 'all'  不限
   * - 'agent' 所有 agent（通配，与 CLI --created-by agent 同口径）
   * - 其余   精确匹配到具体的提出者（human / agent:alice / …）
   */
  if (filter.owner === ALL_AGENTS) {
    if (!todo.createdBy.startsWith('agent:')) return false
  } else if (filter.owner !== 'all' && todo.createdBy !== filter.owner) {
    return false
  }

  if (filter.executor && filter.executor !== 'all') {
    const actualExecutor = todo.executedBy ?? todo.createdBy
    if (filter.executor === ALL_AGENTS) {
      if (!actualExecutor.startsWith('agent:')) return false
    } else if (actualExecutor !== filter.executor) {
      return false
    }
  }

  if (filter.priority && filter.priority !== 'all' && todo.priority !== filter.priority) {
    return false
  }

  if (filter.type && filter.type !== 'all' && todo.type !== filter.type) return false

  // 解决于版本（v24）：与 CLI --fixed-in 的三个入口同语义
  if (filter.fixedIn) {
    if (filter.fixedIn === UNSET_FIXED) {
      if (todo.fixedInVersion !== null) return false
    } else if (filter.fixedIn === ANY_FIXED) {
      if (todo.fixedInVersion === null) return false
    } else if (todo.fixedInVersion !== filter.fixedIn) {
      return false
    }
  }

  if (filter.projectId) {
    if (filter.projectId === NO_PROJECT) {
      if (todo.projectId !== null) return false
    } else if (todo.projectId !== filter.projectId) {
      return false
    }
  }
  if (filter.projectIds && filter.projectIds.length > 0 && (!todo.projectId || !filter.projectIds.includes(todo.projectId))) {
    return false
  }

  if (filter.createdRange && !isWithinTimeRange(todo.createdAt, filter.createdRange)) {
    return false
  }

  return true
}

/**
 * 工作空间的状态集合：当前工作默认不让历史终态混入，历史必须由入口显式打开。
 * 这是看板、动态和项目计数共用的口径，避免项目空间各处各自解释“当前”。
 */
export function matchesWorkspaceStatus(
  status: TodoStatus,
  mode: WorkspaceMode,
  scope: WorkItemScope
): boolean {
  if (mode === 'all' || scope === 'all') return true
  if (scope === 'ended') return status === 'done' || status === 'suspended' || status === 'discarded'
  // workbench 与 project 的 current 都只呈现仍需处理的四种状态。
  return status === 'proposed' || status === 'todo' || status === 'in_progress' || status === 'awaiting_review'
}
