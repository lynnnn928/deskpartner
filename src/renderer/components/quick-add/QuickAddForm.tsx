import React, { useState, useRef, useEffect } from 'react'
import { Button } from '../ui/Button'
import { ReminderPicker } from './ReminderPicker'
import { CategoryPicker } from './CategoryPicker'
import { ProjectPicker } from './ProjectPicker'
import { ParentPicker } from './ParentPicker'
import { OwnerPicker } from './OwnerPicker'
import { effectiveExecutor } from '../../lib/assignable-executors'
import { ownerLabel } from '../../lib/todo-filter'
import { PriorityPicker } from './PriorityPicker'
import { DuePicker } from './DuePicker'
import { TypePicker } from './TypePicker'
import { VersionPicker } from './VersionPicker'
import { useQuickAddRoute } from './useQuickAddRoute'
import { EmptyValidator } from './EmptyValidator'
import { CommentThread } from './CommentThread'
// 「本次变更」（1.0.73，`482e4b03`）：验收时看这一次交付改了什么
import { ReviewDiff } from './ReviewDiff'
import { useTodoStore } from '../../stores/todo.store'
import { useUIStore } from '../../stores/ui.store'
import { Icon } from '../ui/Icon'
import { MarkdownContent } from '../ui/MarkdownContent'
import { STATUS_META } from '../../lib/constants'
import { useCategoryStore } from '../../stores/category.store'
import { useProjectStore } from '../../stores/project.store'
import { useSettingsStore } from '../../stores/settings.store'
import type { TodoPriority, TodoStatus, TodoType } from '../../types/enums'
import { formatTodoAgentPrompt, shortId } from '../../lib/utils'
import type { TodoOwner } from '../../types/todo'
import type { SpacingPreset } from '../../types/enums'
import { invoke } from '../../lib/ipc-client'
import { formatTimeOnly } from '../../lib/date'
import { planStamp, humanizeActor } from '../../lib/timeline-display'
import type { TimelineEntry } from '../../types/todo'
import { cn } from '../../lib/utils'
// 没保存的输入先存哪儿（卡 6a595ad0）—— 为什么是 sessionStorage 见该文件的说明
import {
  clearQuickAddDraft,
  quickAddDraftFromTodo,
  readQuickAddDraft,
  sameQuickAddDraft,
  writeQuickAddDraft,
  type QuickAddDraft
} from '../../lib/unsaved-drafts'

/** 弹窗内边距档位 */
const PADDING_MAP: Record<SpacingPreset, { padding: number; gap: number }> = {
  compact: { padding: 16, gap: 8 },
  standard: { padding: 20, gap: 12 },
  spacious: { padding: 26, gap: 16 }
}

/**
 * 上一次速记落在哪个项目（会话外的记忆，1.0.48）
 *
 * 速记的默认值必须是"你上次在忙的那摊"，不是"列表里第一个"：
 * 一个人日常可能同时在推三四个项目，但记东西是连续的一串 ——
 * 连续记的五条里有四条属于同一个项目，每次重新选就是四遍无用功。
 * 存在 localStorage 而不是设置项：它是这一个入口的习惯，不是偏好配置。
 */
const LAST_PROJECT_KEY = 'deskpartner.quickAdd.lastProjectId'

function readLastProjectId(): string | null {
  try {
    return window.localStorage.getItem(LAST_PROJECT_KEY)
  } catch {
    return null
  }
}

function writeLastProjectId(id: string | null): void {
  try {
    if (id) window.localStorage.setItem(LAST_PROJECT_KEY, id)
  } catch {
    /* 隐私模式下写不进去也不该影响记一条待办 */
  }
}

/** 新增时的默认项目：调用方明确指定的 > 上次那个（还在的话）> 第一个 */
function pickInitialProject(
  projects: { id: string }[],
  preferredProjectId?: string | null
): string | null {
  // 显式项目来自发起新增的看板调用方；即使项目列表尚未从主进程
  // 加载完成，也要先保留它，不能被 localStorage/第一个项目抢先覆盖。
  if (preferredProjectId) return preferredProjectId
  const last = readLastProjectId()
  if (last && projects.some((p) => p.id === last)) return last
  return projects[0]?.id ?? null
}

export const QuickAddForm: React.FC = () => {
  const [title, setTitle] = useState('')
  const [remindAt, setRemindAt] = useState<string | null>(null)
  const [categoryIds, setCategoryIds] = useState<string[]>([])
  const [showOptions, setShowOptions] = useState(false)
  const [emptyError, setEmptyError] = useState(false)
  /** 编号 chip 的复制反馈（1.6s 后自动收起） */
  const [copiedId, setCopiedId] = useState(false)
  /** 项目必填未满足（1.0.37）：与标题空错误同手法，落在对应字段上 */
  const [projectError, setProjectError] = useState(false)
  const titleRef = useRef<HTMLTextAreaElement>(null)

  // ── 归属字段（项目 / 父需求 / 分类 / 提出者+执行者 / 类型）──
  const [projectId, setProjectId] = useState<string | null>(null)
  const [parentId, setParentId] = useState<string | null>(null)
  /**
   * 状态（2026-09-24 主用户拍板：详情页要能改）
   *
   * 此前详情页能改文字却改不了状态，要改只能回看板拖列 ——
   * 「改到一半必须回看板」，动线断在这里。
   * 与看板列同一份枚举（STATUS_META），不新增第二份。
   */
  const [status, setStatus] = useState<TodoStatus>('todo')
  const [owner, setOwner] = useState<TodoOwner>('human')
  /** 执行者。null = 执行者即提出者（提出即执行），只有显式指派才分离 */
  const [executedBy, setExecutedBy] = useState<TodoOwner | null>(null)
  const [todoType, setTodoType] = useState<TodoType>('task')

  // ── 详细版字段 ──
  const [showDetail, setShowDetail] = useState(false)
  const [description, setDescription] = useState('')
  const [priority, setPriority] = useState<TodoPriority>('normal')
  const [dueAt, setDueAt] = useState<string | null>(null)
  /** 解决于版本（v24）；只在编辑模式可改，见 VersionPicker 的注释 */
  const [fixedInVersion, setFixedInVersion] = useState<string | null>(null)
  /**
   * 当前版本号：给「标为 <当前版本>」这个快捷按钮用。
   *
   * 从主进程 `app:info` 取而不是在渲染层 import package.json ——
   * 打包后版本号是 app.getVersion() 的事（开发态与安装态可能不同源），
   * 顺带也不必把 package.json 打进渲染产物。
   */
  const [appVersion, setAppVersion] = useState<string | undefined>(undefined)
  useEffect(() => {
    let alive = true
    invoke('app:info')
      .then((r) => {
        if (alive) setAppVersion(r?.version)
      })
      .catch(() => {
        // 取不到就不给那个快捷按钮（见 VersionPicker），不影响手工填
      })
    return () => {
      alive = false
    }
  }, [])
  const descRef = useRef<HTMLTextAreaElement>(null)

  /**
   * 描述框自增高：内容多高，框就多高（封顶 40vh，超出在框内滚动）
   *
   * 固定 3 行在详情抽屉里根本不够 —— 长描述被压在一巴掌大的框里滚，
   * 上下文全藏起来了（31 版实测反馈）。自增高后短描述不占地方、
   * 长描述整篇铺开；封顶保证抽屉里描述之后的字段（类型/截止/提交）仍够得着。
   *
   * height 先归 auto 再量 scrollHeight：带旧高度量会量出旧值，框只会越来越大。
   */
  const resizeDesc = () => {
    const el = descRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, Math.round(window.innerHeight * 0.4))}px`
  }
  useEffect(resizeDesc, [description, showDetail])

  const resizeTitle = () => {
    const el = titleRef.current
    if (!el) return
    el.style.height = 'auto'
    if (el.scrollHeight > 0) {
      el.style.height = `${Math.min(el.scrollHeight, 140)}px`
    }
  }
  useEffect(resizeTitle, [title])

  const { createTodo, updateTodo, todos } = useTodoStore()
  const showToast = useUIStore((s) => s.showToast)
  const { categories } = useCategoryStore()
  const { projects } = useProjectStore()
  const { settings } = useSettingsStore()

  /**
   * 编辑模式 / 初始状态：从 URL 参数读取
   *
   * **必须监听 hashchange，不能用 useMemo(…, [])。**
   *
   * 这个窗口是复用的（关闭只是隐藏，不销毁），主进程靠改 hash 来切换
   * "新增 / 编辑"。但 `loadURL` 只改 hash 时 Chromium 走的是
   * **同文档导航** —— 不会重新加载 JS，组件也不会重新挂载。
   * 于是 useMemo 只在挂载时算一次，之后一直停在旧模式：
   * 表现就是"双击卡片却弹出新增待办"。
   */
  const routeParams = useQuickAddRoute()

  const editingTodoId = routeParams.todoId
  const focusCommentId = routeParams.commentId

  /**
   * 新建时的初始状态
   *
   * 从看板某一列点「+ 添加任务」进来时带上，新任务直接落在那一列，
   * 不必先建成"待办"再拖过去。
   *
   * 刻意不接受 'done'：直接新建一条"已完成"的任务没有意义，
   * 与"已完成列不给新增入口"保持一致。
   * 'awaiting_review' 同理：没有执行过程的事谈不上"待验收"（CLI 侧同此约束）。
   * 'discarded' 同理（53d252ea）：「不做了」是结论，凭空新建一条等于自相矛盾。
   */
  const initialStatus =
    routeParams.status === 'proposed' ||
    routeParams.status === 'todo' ||
    routeParams.status === 'in_progress' ||
    routeParams.status === 'suspended'
      ? (routeParams.status as TodoStatus)
      : undefined

  /**
   * 「有没有没保存的修改」的基准（卡 6a595ad0）
   *
   * 判据只有一条：**当前表单 ≠ 上一次装载完成时的样子**。基准在三处更新 ——
   * 跟着路由装载（或恢复草稿）、提交成功、用户明确放弃草稿。
   * 为 null 表示"还没装载完"，这时一律算干净（否则刚打开就算有修改）。
   */
  const [baseline, setBaseline] = useState<QuickAddDraft | null>(null)
  /** 这一屏内容是从"上次没保存的草稿"恢复来的（提示行 + 放弃入口用） */
  const [restoredDraft, setRestoredDraft] = useState(false)

  /** 表单这一刻的样子：判"改没改"、落草稿，都用它 */
  const formNow: QuickAddDraft = {
    title,
    remindAt,
    categoryIds,
    showOptions,
    projectId,
    parentId,
    status,
    owner,
    executedBy,
    todoType,
    showDetail,
    description,
    priority,
    dueAt,
    fixedInVersion
  }
  const dirty = baseline !== null && !sameQuickAddDraft(formNow, baseline)

  /**
   * 给下面"装载" effect 读的最新脏值
   *
   * 它不能进那个 effect 的依赖数组：那个 effect 重跑的时机恰恰是**危险的时刻**
   * （store 一刷新 todos 就换引用），它必须读"此刻"的值，而不是自己注册时的值。
   */
  const dirtyRef = useRef(false)
  useEffect(() => {
    dirtyRef.current = dirty
  })

  /**
   * 把一份快照铺进表单
   *
   * 装载 / 恢复草稿 / 放弃草稿共用它 —— 三处各写一遍的话，字段迟早漂开，
   * 而"漂开"的表现就是某一次装载少填了一个字段（看着像丢数据）。
   */
  const applySnapshot = (s: QuickAddDraft) => {
    setTitle(s.title)
    setRemindAt(s.remindAt)
    setCategoryIds(s.categoryIds)
    setShowOptions(s.showOptions)
    setProjectId(s.projectId)
    setParentId(s.parentId)
    setStatus(s.status)
    setOwner(s.owner)
    setExecutedBy(s.executedBy)
    setTodoType(s.todoType)
    setShowDetail(s.showDetail)
    setDescription(s.description)
    setPriority(s.priority)
    setDueAt(s.dueAt)
    setFixedInVersion(s.fixedInVersion)
  }

  // 编辑模式：预填数据
  useEffect(() => {
    if (editingTodoId) {
      const todo = todos.find((t) => t.id === editingTodoId)
      if (todo) {
        /**
         * 有没保存的修改时**一律不重填**（卡 6a595ad0）
         *
         * 这个窗口是常驻的（关闭只是 hide），而主进程每次 dataChanged 都会广播到
         * 这里、触发一次 fetchTodos —— 于是 `todos` 一换引用这个 effect 就重跑：
         * 哪怕用户只是在自己这条下面发了一条评论（todo:addComment 也广播 todo），
         * 刚才打了一半的标题 / 描述会被**静默**换回库里的旧值。
         * 边界很具体：同一个窗口、同一个人、没有任何提示。
         */
        if (dirtyRef.current) return
        /**
         * 上次没保存的草稿优先于库里的值
         *
         * 换一条事项是**整页重载**（见 windows.ts 复用分支的说明），内存里的东西
         * 活不过那一刻；用户回来要接着改的正是草稿里那一段。库里的值当基准，
         * 只在草稿存在时换成草稿，并由下面的提示行说明"这是上次那段"。
         */
        const draft = readQuickAddDraft(routeParams)
        const loaded = draft ?? quickAddDraftFromTodo(todo)
        applySnapshot(loaded)
        setBaseline(loaded)
        setRestoredDraft(!!draft)
      }
    } else {
      // 新增模式：默认选中第一个分类
      //
      // 这里曾经写 `setCategoryId(...)` —— v9 把分类改成多值后函数名已变，
      // 但这一行漏改，导致**每次进入新增模式都会抛 ReferenceError**。
      // 而它的调用点在 useEffect 里，异常被 React 吞成"看起来没事"，
      // 只是默认分类一直没选上。
      if (categories.length > 0 && categoryIds.length === 0) {
        setCategoryIds([categories[0].id])
      }
      /**
       * 项目必填（1.0.37）：新增时默认落在**上次那个**项目。
       *
       * 默认选中而不是留空等人选 —— 记一条待办时多一次点击就是多一次放弃的机会
       * （「新项目」按钮能就地新建，所以默认值不会把人锁死）。
       * 1.0.48 起优先用上次提交的项目，取不到才回退到第一个。
       */
      // 新增窗口由调用方带来的项目优先；一旦表单已有项目，就不再因看板
      // 导航、项目列表刷新或另一个渲染窗口的 store 变化而悄悄改归属。
      const wanted = pickInitialProject(projects, routeParams.projectId)
      if (wanted && !projectId) {
        setProjectId(wanted)
      }
    }
  }, [editingTodoId, todos, categories, projects])

  /**
   * 没保存的内容随手落一份草稿（卡 6a595ad0）
   *
   * 为什么落到 sessionStorage 而不只是留在内存里：**换一条事项时主进程是整页重载**
   * （见 windows.ts 复用分支的说明）—— 内存里的东西活不过那一刻，草稿得活过重载。
   *
   * 只在有改动时写；**从不在"看起来干净"时删**。store 刷新把表单换回库里的值
   * 那一刻，表单也看着干净，但用户的字还在草稿里 —— 那是他回来的唯一线索。
   * 清除点只有两个：提交成功、用户点「放弃这些修改」。
   *
   * 刻意不写依赖数组：这个表单十几个字段，写全等于"每次渲染都跑一遍"，
   * 而漏写一个字段的代价是一次静默丢失 —— 每次渲染比一次字段，便宜得多。
   */
  useEffect(() => {
    if (dirty) writeQuickAddDraft(routeParams, formNow)
  })

  /**
   * 已批准的 agent（「交给 AI」的候选）
   *
   * 只列**批准过的**：没批准的 agent 连写权限都没有，把活派给它，
   * 那条待办只会静静躺在看板上没人动。
   */
  const [approvedAgents, setApprovedAgents] = useState<{ id: string; displayName: string }[]>([])
  useEffect(() => {
    let alive = true
    void invoke('agent:list')
      .then((list) => {
        if (!alive) return
        setApprovedAgents(
          (list ?? [])
            .filter((a) => a.approved)
            .map((a) => ({ id: a.id, displayName: a.displayName }))
        )
      })
      .catch(() => {
        /* 取不到就不显示这一行 —— 速记不该因为查不到 agent 而变形 */
      })
    return () => {
      alive = false
    }
  }, [])

  // 打开时自动聚焦
  useEffect(() => {
    setTimeout(() => titleRef.current?.focus(), 100)
  }, [])

  /**
   * 失焦就把窗口收起来
   *
   * 早先的规则是"空表单才自动关，有内容就留着"—— 本意是别把填了一半的
   * 内容弄丢，但结果是：只要填了东西，这个置顶窗口就**一直压在看板上**，
   * 而透明窗口的整个矩形区域都会接收鼠标事件，用户根本点不到底下的看板。
   *
   * 现在改成总是 hide()：
   * - 窗口只是隐藏、不销毁，**内容原样留着**，谈不上"丢"
   * - 让开位置，用户能接着操作看板
   * - 再次打开同一条时 hash 不变、页面不重载，内容还在
   * - 换一条时 hash 变了，routeParams 变化会触发重置（见下面的 effect）
   */
  useEffect(() => {
    const mountedAt = Date.now()
    const handleBlur = () => {
      // 刚打开时的假失焦不算（窗口可能还没真正拿到焦点）
      if (Date.now() - mountedAt < 300) return
      invoke('window:hideQuickAdd')
    }
    window.addEventListener('blur', handleBlur)
    return () => window.removeEventListener('blur', handleBlur)
  }, [])

  const handleSubmit = async () => {
    if (!title.trim()) {
      setEmptyError(true)
      return
    }

    /**
     * 项目必填（1.0.37）：没有可选项目时不许提交。
     *
     * 正常情况下进不来（打开时默认选中第一个），但有两种真实的空档：
     * 本机一个项目都没有、或这条原来挂的项目被删了。
     * 这时把错误落在项目那一行上并说清怎么办 —— 直接提交会被数据层拒绝，
     * 而"保存失败"这种笼统提示会让人以为是自己哪里填错了。
     */
    if (!projectId) {
      setProjectError(true)
      return
    }

    // 详细字段只有在展开过时才参与提交，避免误把隐藏态的空值写进库
    const detail = showDetail
      ? {
          description: description.trim() || null,
          priority,
          dueAt
        }
      : {}

    try {
      if (editingTodoId) {
        await updateTodo({
          id: editingTodoId,
          title: title.trim(),
          categoryIds,
          projectId,
          parentId,
          createdBy: owner,
          executedBy,
          type: todoType,
          remindAt,
          /**
           * 版本归属独立于 detail 展开态提交（v24）。
           * detail 那一坨是"用户没展开详情就别动它"的防误写，
           * 而版本属于编辑模式下**常驻**的字段（见 VersionPicker 的注释），
           * 放进 detail 会让"改了版本却没展开详情"静默丢失。
           */
          fixedInVersion,
          // 状态：详情页改了才提交（1.0.49）。守卫仍在 repo 层——
          // 例如父需求直接置完成会被 G6 拦下，错误照常抛给这里显示
          status,
          ...detail
        })
      } else {
        await createTodo({
          title: title.trim(),
          categoryIds,
          projectId,
          parentId,
          createdBy: owner,
          executedBy,
          type: todoType,
          remindAt,
          // 从列内入口进来时带上目标状态；从顶栏进来则为默认（待办）
          ...(initialStatus ? { status: initialStatus } : {}),
          ...detail
        })
      }
      // 关窗前记下"这次记在哪一摊"，下一次速记直接落这儿
      writeLastProjectId(projectId)
      /**
       * 保存成功 = 这份草稿已经落地（卡 6a595ad0）
       *
       * 不清的话，下次打开同一条会把它当成"上次没保存的修改"再恢复一遍 ——
       * 内容一样，但那个提示就成了假话。
       */
      clearQuickAddDraft(routeParams)
      setRestoredDraft(false)
      // 关闭窗口。用 IPC 而不是 window.close()：
      // 主进程现在是隐藏复用这个窗口，销毁掉就失去复用的意义了
      invoke('window:hideQuickAdd')
      if (editingTodoId) {
        /**
         * 编辑保存后**不重置表单**（卡 6a595ad0）
         *
         * 重置会把表单清空，指望"清空 + 装载 effect 重跑"把库里的值铺回来 ——
         * 而那次重跑的前提是 todos 恰好换了引用，不值得赌：赌输了，用户下次打开
         * 同一条（同一条不再重载，见 windows.ts）看到的是一个**空抽屉**。
         * 留着刚提交的内容、把基准置空（= 干净）就够了；标题首尾空格由下一次
         * 装载抹平。
         */
        setBaseline(null)
      } else {
        // 新增是另一回事：记完一条接着记下一条，表单该空
        resetForm()
      }
    } catch (err) {
      // 保存失败必须看得见：内容还留在框里，人以为没点上就会再点一遍
      showToast(err instanceof Error ? `保存失败：${err.message}` : '保存失败')
    }
  }

  const handleCancel = () => {
    invoke('window:hideQuickAdd')
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
    }
    if (e.key === 'Escape') handleCancel()
  }

  /**
   * 放弃草稿：回到"库里那条的样子"（卡 6a595ad0）
   *
   * 与"把输入框里的字删掉"是两回事 —— 草稿不清掉，下次打开还会把它恢复回来。
   * 这是除"提交成功"之外唯一让草稿消失的地方，提示行上那个按钮就是它。
   */
  const discardDraft = () => {
    clearQuickAddDraft(routeParams)
    setRestoredDraft(false)
    const todo = editingTodoId ? todos.find((t) => t.id === editingTodoId) : null
    if (todo) {
      const saved = quickAddDraftFromTodo(todo)
      applySnapshot(saved)
      setBaseline(saved)
      return
    }
    // 新增模式没有"库里那条"可回，回到刚打开这张卡片的样子
    resetForm()
  }

  const resetForm = () => {
    const nextCategoryIds = categories[0] ? [categories[0].id] : []
    // 项目不清空：速记是连着记一串，下一次大概率还是同一个项目
    const nextProjectId = pickInitialProject(projects, routeParams.projectId)
    setTitle('')
    setRemindAt(null)
    setCategoryIds(nextCategoryIds)
    setProjectId(nextProjectId)
    setParentId(null)
    setOwner('human')
    setExecutedBy(null)
    setTodoType('task')
    setShowOptions(false)
    setEmptyError(false)
    setProjectError(false)
    setShowDetail(false)
    setDescription('')
    setPriority('normal')
    setDueAt(null)
    setFixedInVersion(null)
    /**
     * 重置后的样子就是新的基准（卡 6a595ad0）
     *
     * 不重设的话，"清空"这件事本身会被判成"有未保存的修改"：每记完一条、
     * 每次打开新增弹窗都会先弹一次"要不要保留草稿"。`status` 取当前值，
     * 因为 resetForm 本来就不动它（新增不看这个状态，它只服务于编辑模式那一行按钮）。
     */
    setBaseline({
      title: '',
      remindAt: null,
      categoryIds: nextCategoryIds,
      showOptions: false,
      projectId: nextProjectId,
      parentId: null,
      status,
      owner: 'human',
      executedBy: null,
      todoType: 'task',
      showDetail: false,
      description: '',
      priority: 'normal',
      dueAt: null,
      fixedInVersion: null
    })
    setRestoredDraft(false)
  }

  /**
   * 切回新增模式时清空表单
   *
   * 因为窗口是复用的：编辑完 A 再点新增（或再双击 B），
   * 不清空就会带着 A 的内容。
   */
  useEffect(() => {
    if (!editingTodoId) resetForm()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingTodoId])

  /**
   * 当前编辑的这一条下面的子任务
   *
   * 卡片那边为了减负把具体内容收掉了（方案 A），这里补回来：
   * 详情抽屉正该承担"拆开看是哪些"这种整理层的信息。
   * 数据来自 store 里已有的全量 todos，不需要新的 IPC。
   */
  const children = React.useMemo(
    () => (editingTodoId ? todos.filter((t) => t.parentId === editingTodoId) : []),
    [todos, editingTodoId]
  )
  const childrenDone = children.filter((t) => t.status === 'done').length

  /**
   * 所属父需求（2026-09-24 主用户实测：只有"父→子"一半，反向没有入口）
   *
   * 原来的详情抽屉只画了「自己是父任务」这一种情形：列出子任务、可点进去。
   * 但反过来 —— 自己**挂在谁下面** —— 既看不到、也点不过去。
   * 于是"这条是为哪个需求做的"在界面上无从得知，只能靠记。
   *
   * 与子任务清单对称：那半边在下面渲染，这半边放在顶部（一打开就该看到）。
   */
  const parent = React.useMemo(
    () => (parentId ? todos.find((t) => t.id === parentId) ?? null : null),
    [todos, parentId]
  )

  /**
   * 这一条的完整变更时序（1.0.62）：状态流转 + 审计留痕合并成一条线
   *
   * 此前这里只画**状态流转**（v14 的 todo_transitions），而审计事件
   * （谁改了描述、谁删了哪条评论）虽然从 1.0.52/1.0.55 起就一直在写，
   * 但**界面上没有任何入口** —— 消费者只有 CLI。于是同一个"变更记录"
   * 被劈成两半：界面上只能看到"它怎么走到这个状态的"，
   * 看不到"它被改成了什么、有什么东西被删了"。
   *
   * 为什么把两条线**合并**而不是并排两块：它们是互补的，不是重复的 ——
   * 流转回答"状态怎么变"，审计回答"内容被改成什么/什么东西被删"。
   * 分开看，人要在脑子里做一次归并才能还原"先改了规格、再推验收、又被退回"
   * 这条真实因果。合成一条线，因果是**读出来的**。
   */
  const [timeline, setTimeline] = useState<TimelineEntry[]>([])
  useEffect(() => {
    if (!editingTodoId) {
      setTimeline([])
      return
    }
    let alive = true
    void invoke('todo:timeline', { todoId: editingTodoId })
      .then((list) => {
        if (alive) setTimeline(list ?? [])
      })
      .catch(() => {
        if (alive) setTimeline([])
      })
    return () => {
      alive = false
    }
  }, [editingTodoId])

  /**
   * 评论线程的刷新令牌（1.0.73）
   *
   * 「本次变更」里的批注是**发进评论线程**的（复用既有往来通道），
   * 而两个组件各拉各的数据 —— 不通知的话，人发完批注要手动关闭再打开
   * 才看得见它，看着像"批注没发出去"。
   *
   * 用自增计数器而不是把评论列表提升到父组件：线程内部还有折叠状态、
   * 回复目标、展开更多，把它们全搬到父层只为了通知一次刷新，代价远大于收益。
   */
  const [commentsToken, setCommentsToken] = useState(0)
  const [showAllTimeline, setShowAllTimeline] = useState(false)
  const [editingDesc, setEditingDesc] = useState(false)

  useEffect(() => {
    setEditingDesc(false)
  }, [editingTodoId])

  const spacing = PADDING_MAP[settings.quickAddPadding] ?? PADDING_MAP.standard
  const showDetailSection = Boolean(editingTodoId) || showDetail
  const showDescPreview = Boolean(editingTodoId) && !editingDesc && Boolean(description.trim())
  const showOptionsSection = Boolean(editingTodoId) || showOptions
  const visibleTimeline =
    showAllTimeline || timeline.length <= 6 ? timeline : timeline.slice(-5)

  return (
    /**
     * 编辑模式（抽屉）：采用「顶部文档区 + 中部结构化属性表 + 底部动态协作区 + 常驻操作栏」三段式层次。
     */
    <div
      className={cn(
        'relative',
        'flex flex-col',
        editingTodoId && 'flex-1 min-h-0',
        !editingTodoId && 'frosted-glass window-frame'
      )}
      style={{
        borderRadius: editingTodoId ? 0 : settings.quickAddBorderRadius,
        padding: spacing.padding,
        gap: spacing.gap
      }}
    >
      {/* ── 一、顶部元信息栏：左侧编号与父需求面包屑，右侧关闭按钮 ── */}
      <div className="flex items-center justify-between gap-2 min-h-6">
        <div className="flex items-center gap-1.5 min-w-0 flex-1">
          {editingTodoId ? (
            <>
              <button
                type="button"
                data-testid="detail-copy-agent-prompt-btn"
                onClick={() => {
                  const currentProjName = projects.find((p) => p.id === projectId)?.name ?? null
                  const promptText = formatTodoAgentPrompt({ id: editingTodoId, title }, currentProjName)
                  void navigator.clipboard.writeText(promptText).then(() => {
                    setCopiedId(true)
                    window.setTimeout(() => setCopiedId(false), 1600)
                  })
                }}
                className="inline-flex items-center gap-1 h-6 px-2 rounded-button text-caption font-mono
                  text-text-secondary bg-surface-subtle border border-border/70 hover:text-text-primary hover:border-text-secondary
                  transition-colors shrink-0"
                title={`点击复制给 AI：${formatTodoAgentPrompt({ id: editingTodoId, title }, projects.find((p) => p.id === projectId)?.name ?? null)}`}
              >
                #{shortId(editingTodoId)}
                <Icon name="copy" size={10} />
              </button>
              {copiedId && <span className="text-caption text-success font-medium shrink-0">已复制给 AI</span>}

              {parent && (
                <button
                  type="button"
                  onClick={() => void invoke('window:showQuickAdd', { todoId: parent.id })}
                  title={`打开父需求「${parent.title}」的详情`}
                  className="inline-flex items-center gap-1.5 h-6 px-2 rounded-button text-caption
                    text-text-secondary bg-surface-subtle border border-border/70 hover:text-text-primary hover:border-text-secondary
                    transition-colors min-w-0 max-w-full"
                >
                  <Icon name="gitBranch" size={11} className="shrink-0" />
                  <span className="text-text-secondary/70 shrink-0">属于</span>
                  <span className="truncate text-text-primary font-medium min-w-0">{parent.title}</span>
                  <span className="font-mono opacity-60 shrink-0">#{shortId(parent.id)}</span>
                </button>
              )}
            </>
          ) : (
            <span className="text-caption font-semibold text-text-secondary tracking-label uppercase">
              新建事项
            </span>
          )}
        </div>

        <button
          onClick={handleCancel}
          className="h-6 w-6 flex items-center justify-center rounded-button text-text-secondary hover:bg-surface-muted hover:text-text-primary transition-colors shrink-0"
          title="关闭"
          aria-label="关闭"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <line x1="0.5" y1="0.5" x2="9.5" y2="9.5" stroke="currentColor" strokeWidth="1.2" />
            <line x1="9.5" y1="0.5" x2="0.5" y2="9.5" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        </button>
      </div>

      {/* 草稿恢复提示（卡 6a595ad0） */}
      {restoredDraft && (
        <div className="flex items-center justify-between gap-2 px-3 py-1.5 rounded-button bg-accent/5 border border-accent/20 text-caption text-text-secondary">
          <div className="flex items-center gap-1.5 min-w-0">
            <Icon name="clock" size={11} className="shrink-0 text-accent" />
            <span className="truncate">已恢复上次没保存的修改（未提交）</span>
          </div>
          <button
            type="button"
            onClick={discardDraft}
            className="text-accent font-medium hover:underline shrink-0"
          >
            放弃这些修改
          </button>
        </div>
      )}

      {/* ── 二、文档核心区：无底框大标题 + 紧随其后的规格描述框 ── */}
      <div className="flex flex-col gap-2">
        <div>
          <textarea
            ref={titleRef}
            rows={1}
            value={title}
            onChange={(e) => {
              setTitle(e.target.value)
              if (e.target.value.trim()) setEmptyError(false)
              resizeTitle()
            }}
            onKeyDown={handleKeyDown}
            placeholder="输入事项标题……"
            className={cn(
              'w-full bg-transparent rounded-input px-2.5 py-1.5 -mx-2.5 text-body font-semibold text-text-primary outline-none resize-none leading-snug break-words',
              'placeholder:text-text-secondary/50 placeholder:font-normal',
              'hover:bg-surface-subtle focus:bg-bg-card focus:ring-1 focus:ring-accent/30 transition-colors',
              emptyError && 'ring-1 ring-danger'
            )}
            maxLength={500}
          />
          {emptyError && <EmptyValidator />}
        </div>

        {showDetailSection && (
          <>
            {showDescPreview && (
              <div
                role="button"
                tabIndex={0}
                onClick={() => {
                  setEditingDesc(true)
                  window.setTimeout(() => {
                    descRef.current?.focus()
                    resizeDesc()
                  }, 0)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    setEditingDesc(true)
                    window.setTimeout(() => {
                      descRef.current?.focus()
                      resizeDesc()
                    }, 0)
                  }
                }}
                title="点击切入编辑描述"
                className="group relative w-full bg-surface-subtle border border-border/80 hover:border-border rounded-input px-3.5 py-2.5 max-h-60 overflow-y-auto cursor-text transition-colors"
              >
                <span className="absolute right-2.5 top-2 px-1.5 py-0.5 rounded-xs bg-bg-card border border-border/70 text-caption text-text-secondary opacity-0 group-hover:opacity-100 transition-opacity">
                  点击编辑
                </span>
                <MarkdownContent content={description} />
              </div>
            )}
            <textarea
              ref={descRef}
              value={description}
              onChange={(e) => {
                if (!showDetail) setShowDetail(true)
                setDescription(e.target.value)
                resizeDesc()
              }}
              onBlur={() => setEditingDesc(false)}
              placeholder="补充背景、验收标准或具体说明（选填，支持 Markdown）…"
              rows={editingTodoId ? 4 : 4}
              maxLength={10000}
              onKeyDown={(e) => {
                if (e.key === 'Escape') handleCancel()
              }}
              className={cn(
                'w-full bg-surface-subtle border border-border/80 rounded-input px-3 py-2 text-label text-text-primary leading-relaxed outline-none resize-y placeholder:text-text-secondary/60 focus:bg-bg-card focus:border-accent transition-colors',
                showDescPreview && 'hidden'
              )}
            />
          </>
        )}
      </div>

      {/* ── 三、结构化属性面板（Property Sheet：左固定宽标签 + 右对齐控件） ── */}
      <div className="rounded-card border border-border bg-surface-subtle p-3 flex flex-col gap-2.5">
        {/* 状态（仅编辑模式） */}
        {editingTodoId && (
          <div className="flex items-start gap-2.5 min-h-7">
            <span className="w-20 shrink-0 text-label text-text-secondary inline-flex items-center gap-1.5 pt-1">
              <Icon name="circle" size={12} />
              <span>状态</span>
            </span>
            <div className="flex-1 min-w-0 flex items-center gap-1 flex-wrap">
              {(Object.keys(STATUS_META) as TodoStatus[]).map((s) => {
                const active = status === s
                return (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setStatus(s)}
                    aria-pressed={active}
                    title={active ? `当前状态：${STATUS_META[s].label}` : `改为「${STATUS_META[s].label}」`}
                    className={cn(
                      'inline-flex items-center gap-1.5 h-7 px-2.5 rounded-button text-caption border transition-colors',
                      active
                        ? 'bg-bg-card text-text-primary font-semibold border-text-primary/30 shadow-card'
                        : 'bg-transparent text-text-secondary border-border/70 hover:text-text-primary hover:bg-bg-card'
                    )}
                  >
                    <span
                      className="w-1.5 h-1.5 rounded-full shrink-0"
                      style={{ backgroundColor: `var(${STATUS_META[s].colorVar})` }}
                    />
                    {STATUS_META[s].label}
                  </button>
                )
              })}
            </div>
          </div>
        )}

        {/* 项目 */}
        <ProjectPicker
          value={projectId}
          onChange={(id) => {
            setProjectId(id)
            if (projectError) setProjectError(false)
          }}
          invalid={projectError}
        />
        {projectError && (
          <p className="text-caption text-danger pl-20">
            请选择所属项目，或点击「＋ 新项目」当场新建。
          </p>
        )}

        {/* 提出者 */}
        <OwnerPicker
          value={owner}
          onChange={setOwner}
          executedBy={executedBy}
          onExecutedByChange={setExecutedBy}
        />

        {/* 执行人 + 交给 AI（合并为单行属性，保留 b95e6bbb 闸门判据） */}
        {(editingTodoId || approvedAgents.length > 0) && (
          <div className="flex items-start gap-2.5 min-h-7">
            <span className="w-20 shrink-0 text-label text-text-secondary inline-flex items-center gap-1.5 pt-1">
              <Icon name="bot" size={12} />
              <span>执行人</span>
            </span>
            <div className="flex-1 min-w-0 flex items-center gap-1.5 flex-wrap min-h-7">
              {editingTodoId && (
                <div className="inline-flex items-center gap-1.5 text-caption text-text-secondary mr-1">
                  <span className="sr-only">执行人：</span>
                  <span className="inline-flex items-center gap-1 h-7 px-2.5 rounded-button bg-bg-card border border-border/80 text-label text-text-primary font-medium">
                    <Icon name={(executedBy ?? owner) === 'human' ? 'user' : 'bot'} size={11} />
                    {ownerLabel(effectiveExecutor({ createdBy: owner, executedBy }), settings?.humanName)}
                  </span>
                  {!executedBy ? (
                    <span className="text-text-secondary/70">（默认由提出者执行）</span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setExecutedBy(null)}
                      className="text-caption text-text-secondary hover:text-accent underline"
                    >
                      恢复默认
                    </button>
                  )}
                </div>
              )}

              {approvedAgents.length > 0 && (
                <div className="inline-flex items-center gap-1.5 flex-wrap">
                  <span className="text-caption text-text-secondary">指派 AI：</span>
                  {approvedAgents.map((a) => {
                    const active = executedBy === a.id
                    return (
                      <button
                        key={a.id}
                        type="button"
                        onClick={() => setExecutedBy(active ? null : (a.id as TodoOwner))}
                        title={active ? `取消交给 ${a.displayName}` : `交给 ${a.displayName} 去做`}
                        className={cn(
                          'inline-flex items-center gap-1 h-7 px-2.5 rounded-button text-label border transition-colors',
                          active
                            ? 'bg-bg-card text-text-primary font-semibold border-text-primary/30 shadow-card'
                            : 'bg-transparent text-text-secondary border-border/70 hover:text-text-primary hover:bg-bg-card'
                        )}
                      >
                        <Icon name="bot" size={11} />
                        {a.displayName}
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        )}

        {/* 详细字段：类型 / 优先级 / 截止时间 / 解决版本 */}
        {showDetailSection && (
          <div className="flex flex-col gap-2.5 pt-2 border-t border-border/60">
            <TypePicker value={todoType} onChange={setTodoType} />
            <PriorityPicker
              value={priority}
              onChange={(nextPriority) => {
                if (!showDetail) setShowDetail(true)
                setPriority(nextPriority)
              }}
            />
            <DuePicker
              value={dueAt}
              onChange={(nextDueAt) => {
                if (!showDetail) setShowDetail(true)
                setDueAt(nextDueAt)
              }}
            />
            {editingTodoId && (
              <VersionPicker
                value={fixedInVersion}
                onChange={setFixedInVersion}
                currentVersion={appVersion}
              />
            )}
          </div>
        )}

        {/* 扩展归属与提醒：标签 / 父需求 / 定时提醒 */}
        {showOptionsSection && (
          <div className="flex flex-col gap-2.5 pt-2 border-t border-border/60">
            <CategoryPicker
              value={categoryIds}
              onChange={(nextIds) => {
                if (!showOptions) setShowOptions(true)
                setCategoryIds(nextIds)
              }}
            />
            <ParentPicker
              value={parentId}
              selfId={editingTodoId ?? undefined}
              onChange={(nextParentId) => {
                if (!showOptions) setShowOptions(true)
                setParentId(nextParentId)
              }}
            />
            <ReminderPicker
              value={remindAt}
              onChange={(nextRemindAt) => {
                if (!showOptions) setShowOptions(true)
                setRemindAt(nextRemindAt)
              }}
            />
          </div>
        )}

        {/* 速记新增模式下的按需展开入口（保持新建弹窗短小轻快） */}
        {!editingTodoId && (!showDetail || !showOptions) && (
          <div className="flex items-center gap-3 pt-1 border-t border-border/50">
            {!showDetail && (
              <button
                type="button"
                onClick={() => {
                  setShowDetail(true)
                  setTimeout(() => descRef.current?.focus(), 50)
                }}
                className="text-caption text-text-secondary hover:text-accent transition-colors"
              >
                + 描述 / 优先级 / 截止时间
              </button>
            )}
            {!showOptions && (
              <button
                type="button"
                onClick={() => setShowOptions(true)}
                className="text-caption text-text-secondary hover:text-accent transition-colors"
              >
                + 标签 / 父需求 / 提醒
              </button>
            )}
          </div>
        )}
      </div>

      {/* ── 四、动态与协作区（子任务 / 本次变更 / 评论 / 变更记录） ── */}
      {children.length > 0 && (
        <div className="flex flex-col gap-1.5 pt-2 border-t border-border">
          <div className="flex items-center justify-between">
            <span className="text-label font-semibold text-text-primary inline-flex items-center gap-1.5">
              <Icon name="gitBranch" size={13} />
              <span>子任务</span>
              <span className="font-mono text-caption text-text-secondary font-normal">
                {childrenDone}/{children.length}
              </span>
            </span>
          </div>

          <div className="rounded-card border border-border bg-bg-card divide-y divide-border/50 overflow-hidden">
            {children.map((c) => {
              const done = c.status === 'done'
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => void invoke('window:showQuickAdd', { todoId: c.id })}
                  title="打开这条子事项的详情"
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-left
                    hover:bg-surface-subtle transition-colors group"
                >
                  <Icon
                    name={done ? 'checkCircle' : 'circle'}
                    size={13}
                    className={cn('shrink-0', done ? 'text-success' : 'text-text-secondary')}
                  />
                  <span
                    className={cn(
                      'text-label min-w-0 flex-1 truncate',
                      done ? 'text-text-secondary' : 'text-text-primary font-medium'
                    )}
                  >
                    {c.title}
                  </span>
                  <span className="text-caption font-mono text-text-secondary/70 shrink-0">
                    #{shortId(c.id)}
                  </span>
                  <span className="text-caption text-text-secondary shrink-0">
                    {STATUS_META[c.status].label}
                  </span>
                </button>
              )
            })}
          </div>
        </div>
      )}

      {/* 本次变更（1.0.73，主用户提单 482e4b03） */}
      {editingTodoId && (
        <ReviewDiff todoId={editingTodoId} onAnnotated={() => setCommentsToken((n) => n + 1)} />
      )}

      {/* 评论线程（1.0.54） */}
      {editingTodoId && (
        <CommentThread
          todoId={editingTodoId}
          refreshToken={commentsToken}
          focusCommentId={focusCommentId}
        />
      )}

      {/* 变更记录（1.0.62）：流转 + 留痕合并成一条线 */}
      {timeline.length > 1 && (
        <div className="flex flex-col gap-1.5 pt-2 border-t border-border">
          <div className="flex items-center justify-between">
            <span className="text-label font-semibold text-text-primary inline-flex items-center gap-1.5">
              <Icon name="clock" size={13} />
              <span>变更记录</span>
              <span className="font-mono text-caption text-text-secondary font-normal">
                {timeline.length} 步
              </span>
            </span>
            {timeline.length > 6 && (
              <button
                type="button"
                onClick={() => setShowAllTimeline(!showAllTimeline)}
                className="text-caption text-text-secondary hover:text-accent transition-colors"
              >
                {showAllTimeline ? '只看最近 5 步' : `展开全部 ${timeline.length} 步`}
              </button>
            )}
          </div>

          <div className="rounded-card border border-border/70 bg-surface-subtle px-2.5 py-2 flex flex-col gap-0.5">
            {visibleTimeline.map((t, i) => {
              const prev = i > 0 ? visibleTimeline[i - 1] : null
              const { newDay, dayLabel, showTime } = planStamp(t.at, prev?.at ?? null)

              return (
                <div key={t.timelineSeq} className="flex flex-col">
                  {newDay && (
                    <span className="text-caption font-medium text-text-secondary pt-1.5 pb-0.5 pl-10">
                      {dayLabel}
                    </span>
                  )}
                  <div className="flex items-start gap-2 px-1.5 py-0.5 rounded-xs text-caption">
                    <span
                      className="text-text-secondary shrink-0 w-9 text-right tabular-nums font-mono"
                      title="发生时间"
                    >
                      {showTime ? formatTimeOnly(t.at) : ''}
                    </span>
                    <span className="min-w-0 flex-1 text-text-primary break-words">
                      {humanizeActor(t.what, t.actor, settings?.humanName)}
                    </span>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* ── 五、底部常驻操作栏 ── */}
      <div
        className={cn(
          'flex justify-end gap-2 mt-1',
          editingTodoId && 'sticky bottom-0 z-10 -mx-2 px-2 pt-2.5 pb-1 bg-bg-primary border-t border-border'
        )}
      >
        <Button variant="ghost" onClick={handleCancel}>取消</Button>
        <Button variant="primary" onClick={handleSubmit}>提交保存</Button>
      </div>
    </div>
  )
}
