import { ipcMain, BrowserWindow, app, dialog, shell, nativeImage, type IpcMainInvokeEvent } from 'electron'
import { getDataDirPath, migrateDataDirectory } from './database/index'
import { TodoRepository } from './database/todo.repository'
import { CategoryRepository } from './database/category.repository'
import { ProjectRepository } from './database/project.repository'
import { ReleaseRepository } from './database/release.repository'
import { MemoRepository } from './database/memo.repository'
import { SettingsRepository } from './database/settings.repository'
import { BackupService } from './services/backup.service'
import { autoUpdateService } from './services/auto-update.service'
import { TimerService } from './services/timer.service'
import { NotificationService } from './services/notification.service'
import { TelemetryService } from './services/telemetry.service'
import { EventsRepository } from './database/events.repository'
import { AgentRepository } from './database/agent.repository'
import { NotificationRepository, type NotificationType } from './database/notification.repository'
import { ReminderReceiptRepository } from './database/reminder-receipt.repository'
// 事项评论（1.0.54）：详情页的评论线程走 IPC 读写
import { CommentRepository, type CommentKind } from './database/comment.repository'
import type { ApprovalHistoryFilter, GrantHistoryFilter, GrantScope, ListGrantsFilter } from './database/agent.repository'
import { pickExecSummary } from './lib/exec-summary'
import { buildExecReceipt } from './lib/exec-receipt'
import { buildDescChangeEvent } from './lib/desc-audit'
// 审计翻译层（1.0.62）：与 CLI 共用同一份判据，界面上也读得出"谁改了什么、删了什么"
import { buildTodoAudit, mergeTimeline } from './lib/audit-text'
// 「本次变更」聚合（1.0.73，`482e4b03`）：验收时看这一次交付改了什么
import { buildReviewDiff } from './lib/review-diff'
import { buildAgentGuideIndex, cliEnvVarAvailable, resolveLauncherPath, resolveMcpPath } from './cli/agent-guide'
import { executeApproved } from './cli/commands'
import { GATES } from './cli/gates'
import { ProtocolRepository } from './database/protocol.repository'
import { ProfileRepository } from './database/profile.repository'
import { RulesRepository } from './database/rules.repository'
import { DB_VERSION } from '../renderer/lib/constants'

/** 暴露本进程标识，供 ChangeBroadcastService 跳过自身产生的事件 */
export const LOCAL_ACTOR_ID = `proc-${process.pid}-${Date.now()}`
import type { IPCChannels, IPCChannelName } from '../renderer/types/ipc'
import type { CreateTodoInput, UpdateTodoInput, Todo } from '../renderer/types/todo'
import type { TodoStatus } from '../renderer/types/enums'
import type { AppSettings } from '../renderer/types/settings'
import type { WindowBounds, WindowPosition } from '../renderer/types/settings'
import type { CategoryCreateInput } from '../renderer/types/category'
import type {
  Project,
  CreateProjectInput,
  UpdateProjectInput
} from '../renderer/types/project'
import type {
  CreateReleaseInput,
  UpdateReleaseInput
} from '../renderer/types/release'

/** IPC 响应统一格式 */
interface IPCResponse<T = unknown> {
  ok: boolean
  data?: T
  error?: string
}

/** 成功响应 */
function ok<T>(data: T): IPCResponse<T> {
  return { ok: true, data }
}

/** 失败响应 */
function fail(error: string): IPCResponse<never> {
  return { ok: false, error }
}

/** 安全执行 IPC handler，捕获异常 */
function safeHandle<T>(
  fn: () => T
): IPCResponse<T> {
  try {
    const result = fn()
    return ok(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[IPC] 处理异常: ${message}`)
    return fail(message)
  }
}

/**
 * 异步版：handler 内部要 `await`（1.0.45「批准即执行」）
 *
 * 服务端代人执行一条命令是异步的（`executeApproved` 返回 Promise），
 * 而同步的 safeHandle 接不住 Promise —— 它的 try/catch 会漏掉
 * 异步阶段的异常，最终变成一个 unhandled rejection，
 * 界面上表现为"点了允许，什么都没发生，也没有报错"。
 */
async function safeHandleAsync<T>(
  fn: () => Promise<T>
): Promise<IPCResponse<T>> {
  try {
    return ok(await fn())
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[IPC] 处理异常: ${message}`)
    return fail(message)
  }
}

/**
 * 特权 IPC 通道的来源校验（1.0.40）
 *
 * 代码审查报告指出：ipc.ts 全部 handler 都不校验 sender，
 * 于是**任何一个渲染窗口**都能调特权通道 —— 悬浮球、快速添加、提醒横幅
 * 这些"小窗口"同样能调 `agent:setApproved` / `agent:revokeGrants` /
 * `backup:import`。
 *
 * 这些窗口的渲染层是我们自己的代码，正常不会这么干；但**防御纵深的意义
 * 正在于不依赖"上游一定不做错事"** —— 一个被注入或出错的浮球窗口，
 * 不该握着"批准 agent 写入"和"导入备份覆盖数据"这两把钥匙。
 *
 * 判据是窗口的 hash 路由（`loadRoute` 写进去的 `#/xxx`）。
 *
 * ⚠️ 只用于**写类特权通道**，不要顺手加给别的：
 * `settings:update` 走的是多窗口共享的 settings.store（浮球要存自己的位置），
 * 拦了会直接坏功能。上面这 4 个通道的调用方已逐个核对过，**只有设置页**会调。
 */
/**
 * 1.0.48：审批能力开始从设置页迁往主窗口用户页（v3 设计批次 4），
 * 过渡期两个窗口都放行 —— 设置页的「谁能写入」还在服役，
 * 用户页上线后设置页分区退役，届时这里再收窄回单窗。
 * /kanban 即主窗口（侧边栏 + 内容区视图都活在它里面）。
 * /reminder-banner：授权横幅直批（v3 设计拍板 G）——
 * 横幅是审批的第一现场，「允许/拒绝」按钮直接调 resolveGrant。
 */
const TRUSTED_WRITE_ROUTES = ['/settings', '/kanban', '/reminder-banner']

function assertFromSettings(e: IpcMainInvokeEvent, channel: string): void {
  const route = e.sender.getURL().match(/#(\/[a-z-]+)/)?.[1] ?? ''
  if (!TRUSTED_WRITE_ROUTES.includes(route)) {
    throw new Error(
      `[IPC] ${channel} 只能由设置/主窗口界面调用（当前来源：${route || '未知界面'}）`
    )
  }
}

/**
 * 收起顶部提醒横幅（如果它正开着）。
 *
 * 为什么需要：横幅是 `alwaysOnTop` 的 `screen-saver` 层、还 `skipTaskbar`
 * —— **没有任何自动收起机制**（`windows.ts` 里没有定时器，组件只在直批
 * 回执那条路上 2.6s 后自己收）。也就是说：只要它弹着，不收就一直钉在
 * 屏幕最上层，盖住所有窗口。
 *
 * 于是**每一个"这件事已经被处理了"的出口都必须记得收它**，否则就是
 * 「我已经批完了，它还在说我该去批准」。
 *
 * 2026-10-01（主用户报的横幅内容对不上）这一轮发现：授权申请那条路
 * （`agent:resolveGrant`）有收起逻辑，**批准身份这条路没有** ——
 * 新 agent 接入的横幅弹出来之后，无论你在审批页点「批准写入」还是
 * 「我不想批准它」，它都不收。加上上面那句"没有自动收起"，
 * 那条横幅就永久占着屏幕顶部。
 *
 * 找窗口按**路由精确匹配**（不是 `includes('reminder-banner')`）：
 * 后者只要 URL 里带这个子串就命中，太松；横幅只有一条路由，
 * 精确匹配不会漏，也不会误伤将来的别的路由。
 *
 * 失败静默：收横幅是收尾动作，不该让"批准"这个主操作失败。
 */
function hideReminderBanners(): void {
  for (const w of BrowserWindow.getAllWindows()) {
    try {
      if (w.isDestroyed()) continue
      const route = w.webContents.getURL().split('#')[1] ?? ''
      if (!route.startsWith('/reminder-banner')) continue
      w.hide()
    } catch {
      /* 窗口可能正在销毁，跳过 */
    }
  }
}

/**
 * IPC 注册中心
 * 统一注册所有 ipcMain.handle，类型安全
 *
 * @param onSettingsChanged 设置变更后的副作用钩子（重新注册快捷键、应用开机自启等）。
 *        返回字符串表示副作用失败，该提示会回传给渲染进程展示。
 */
export function registerIPC(
  todoRepo: TodoRepository,
  categoryRepo: CategoryRepository,
  projectRepo: ProjectRepository,
  releaseRepo: ReleaseRepository,
  memoRepo: MemoRepository,
  settingsRepo: SettingsRepository,
  /** agent 身份表（视角切换要列出已注册的 agent） */
  agentRepo: AgentRepository,
  backupService: BackupService,
  timerService: TimerService,
  notificationService: NotificationService,
  getWindows: () => {
    floatBall?: BrowserWindow | null
    quickAdd?: BrowserWindow | null
    kanban?: BrowserWindow | null
    settings?: BrowserWindow | null
  },
  onSettingsChanged?: (
    settings: AppSettings,
    partial: Partial<AppSettings>
  ) => string | undefined,
  telemetryService?: TelemetryService
): void {
  const protocolRepo = new ProtocolRepository()
  const profileRepo = new ProfileRepository()

  // ── 待办事项 ──
  ipcMain.handle('todo:create', (_e, input: CreateTodoInput) =>
    safeHandle(() => {
      const todo = todoRepo.create(input)
      broadcastDataChanged('todo', getWindows)
      // 如有提醒时间，注册定时器
      if (todo.remindAt) {
        timerService.scheduleReminder(todo.id, todo.remindAt)
      }
      // 只记结构化元数据，不记标题/描述正文
      telemetryService?.record({
        actor: 'human',
        surface: 'gui',
        category: 'todo',
        event: 'create',
        ok: true,
        props: {
          hasRemind: !!todo.remindAt,
          hasDue: !!todo.dueAt,
          priority: todo.priority
        }
      })
      return todo
    })
  )

  ipcMain.handle('todo:update', (_e, input: UpdateTodoInput) =>
    safeHandle(() => {
      /**
       * 界面改规格也要留痕（1.0.62，与 CLI `todo update` 同口径）
       *
       * 描述是"规格"，改它等于改写当初说定的事情。此前只有命令行路径
       * 写了 before/after，界面改动的这些一句话痕迹都没有 ——
       * 结果就是"agent 改的查得到、人自己改的查不到"。
       * 判据抽在 `buildDescChangeEvent` 里，两侧共用同一个答案。
       */
      const descBefore = input.id ? (todoRepo.getById(input.id)?.description ?? null) : null

      // G4 候选池闸门：界面路径统一由主进程盖章 source:'gui'（视为人的拍板），
      // 不信渲染层传值 —— 这个标注只在主进程侧写，防止被调用方伪造
      const todo = todoRepo.update({
        ...input,
        source: 'gui',
        // 动作人同理：渲染进程只被人操作，这里一律记 human，不信前端传值
        actor: 'human'
      })

      const descEvent = buildDescChangeEvent(descBefore, input.description)
      if (descEvent) {
        new EventsRepository().append('todo', 'human', {
          cmd: 'todo update',
          id: todo.id,
          ...descEvent
        })
      }
      broadcastDataChanged('todo', getWindows)
      // 更新提醒
      if (input.status === 'done') {
        timerService.cancelReminder(todo.id)
      } else if (todo.remindAt) {
        timerService.scheduleReminder(todo.id, todo.remindAt)
      }
      telemetryService?.record({
        actor: 'human',
        surface: 'gui',
        category: 'todo',
        event: 'update',
        ok: true,
        props: {
          changed: Object.keys(input).filter((k) => k !== 'id'),
          status: todo.status
        }
      })
      return todo
    })
  )

  /**
   * 撤销删除（1.0.48）：把整条快照**原样**放回库里。
   *
   * 输入是删除时留下的完整快照，不是 id —— 库里没有回收站，
   * 主进程无从"找回"，只能由发起删除的一方把它原样交回来。
   *
   * 1.0.111（卡 `df06e4d7`）起走 `restoreWithReport`：恢复的不只是主体，
   * 还有评论与父子关系；而"哪些子事项因为已被改派、没被挪回来"必须**整份带回渲染层** ——
   * 这里只回主体的话，界面读 `conflicts` 会读到 undefined（成功却报撤销失败）。
   */
  ipcMain.handle('todo:restore', (_e, { todo }: { todo: Todo }) =>
    safeHandle(() => {
      const result = todoRepo.restoreWithReport(todo)
      if (result.todo.remindAt) {
        timerService.scheduleReminder(result.todo.id, result.todo.remindAt)
      }
      broadcastDataChanged('todo', getWindows)
      return result
    })
  )

  /** 删父任务前的二次确认要用：它挂了几个子任务 */
  ipcMain.handle('todo:childCount', (_e, { id }: { id: string }) =>
    safeHandle(() => todoRepo.childCount(id))
  )

  ipcMain.handle('todo:delete', (_e, { id }: { id: string }) =>
    safeHandle(() => {
      // 界面路径：渲染进程只被人操作，视为人的拍板，G4 放行（含删除待确认条目）
      // 动作人记 human（渲染进程只被人操作）——删除留痕要靠它回答"谁删的"
      todoRepo.delete(id, 'gui', 'human')
      timerService.cancelReminder(id)
      broadcastDataChanged('todo', getWindows)
      telemetryService?.record({
        actor: 'human',
        surface: 'gui',
        category: 'todo',
        event: 'delete',
        ok: true
      })
    })
  )

  ipcMain.handle(
    'todo:batchUpdateStatus',
    (_e, { ids, status }: { ids: string[]; status: TodoStatus }) =>
      safeHandle(() => {
        todoRepo.batchUpdateStatus(ids, status)
        // 批量取消提醒
        if (status === 'done') {
          ids.forEach((id) => timerService.cancelReminder(id))
        }
        broadcastDataChanged('todo', getWindows)
        telemetryService?.record({
          actor: 'human',
          surface: 'gui',
          category: 'todo',
          event: 'batch_update_status',
          ok: true,
          props: { count: ids.length, status }
        })
      })
  )

  /**
   * 批量改 / 批量删（2026-09-24 主用户拍板的批量能力）
   *
   * 与单条 update/delete 同一道闸：source:'gui' + actor:'human' 只在主进程盖章。
   * 逐条执行的结果原样回给界面（updated/deleted + failed），
   * 界面据此说清"哪几条没成、为什么"—— 这正是批量最容易糊掉的地方。
   */
  ipcMain.handle(
    'todo:batchUpdate',
    (_e, { ids, patch }: { ids: string[]; patch: Omit<UpdateTodoInput, 'id'> }) =>
      safeHandle(() => {
        const result = todoRepo.batchUpdate(ids, { ...patch, source: 'gui', actor: 'human' })
        if (patch.status === 'done') {
          result.updated.forEach((id) => timerService.cancelReminder(id))
        }
        broadcastDataChanged('todo', getWindows)
        telemetryService?.record({
          actor: 'human',
          surface: 'gui',
          category: 'todo',
          event: 'batch_update',
          ok: result.failed.length === 0,
          props: { count: ids.length, ok: result.updated.length, failed: result.failed.length }
        })
        return result
      })
  )

  ipcMain.handle('todo:batchDelete', (_e, { ids }: { ids: string[] }) =>
    safeHandle(() => {
      const result = todoRepo.batchDelete(ids, 'gui')
      result.deleted.forEach((id) => timerService.cancelReminder(id))
      broadcastDataChanged('todo', getWindows)
      telemetryService?.record({
        actor: 'human',
        surface: 'gui',
        category: 'todo',
        event: 'batch_delete',
        ok: result.failed.length === 0,
        props: { count: ids.length, ok: result.deleted.length, failed: result.failed.length }
      })
      return result
    })
  )

  ipcMain.handle(
    'todo:list',
    (
      _e,
      filter?: { status?: TodoStatus; categoryId?: string; keyword?: string }
    ) => safeHandle(() => todoRepo.list(filter))
  )

  ipcMain.handle('todo:getById', (_e, { id }: { id: string }) =>
    safeHandle(() => todoRepo.getById(id))
  )

  /**
   * 状态流转
   *
   * - 不传 todoId：最近流转（动态视图用，全局，旧→新）
   * - 传 todoId：这一条的流转（详情抽屉用，旧→新）
   *
   * input 可能不传（无参调用），所以不直接解构 —— 解构 undefined 会直接抛错。
   * 两条路径共用同一个通道：同一个"历史"概念开两个通道，迟早有一个被漏改。
   */
  ipcMain.handle(
    'todo:listTransitions',
    (_e, input?: { limit?: number; todoId?: string }) =>
      safeHandle(() =>
        input?.todoId
          ? todoRepo.listTransitions(input.todoId)
          : todoRepo.listAllTransitions(input?.limit)
      )
  )

  /**
   * 一条事项的完整变更时序（1.0.62）：谁改了什么、删了什么、状态怎么变的
   *
   * ── 为什么要有这个入口 ──
   *
   * `buildTodoAudit` 从 1.0.60 起就在翻译 events，但消费方**只有 CLI**
   * （`src/main/cli/commands.ts` 三处）；渲染层一处都没有，ipc 里
   * `EventsRepository` 出现三次全是 append —— 所以留痕能力在**界面上等于不存在**，
   * 人验收不到。这条通道就是把"写侧有、读侧为零"的读侧补上。
   *
   * 返回的是**合并后的时序**（流转 + 审计），不是两块并列：
   * 两者互补（流转=状态怎么变，审计=内容被改成什么/什么东西被删），
   * 分开看就得让人在脑子里做一次归并才能还原因果。
   */
  ipcMain.handle('todo:timeline', (_e, { todoId }: { todoId: string }) =>
    safeHandle(() => {
      // TodoRepository.mapTransition 吐的是 camelCase 领域对象；这里只取合并要的字段，
      // 不把 repo 类型往渲染层契约里塞（两侧类型各声明各的，用测试锁不漂移）
      const transitions = todoRepo.listTransitions(todoId).map((t) => ({
        fromStatus: t.fromStatus,
        toStatus: t.toStatus,
        actor: t.actor,
        createdAt: t.createdAt,
        /**
         * `isRejection` 必须显式带过去（1.0.72）。
         *
         * ⚠️ 这里原先手工挑了四个字段，而新加的第五个没被带上 ——
         * 症状是「代码在、字段在、就是不生效」：翻译层收不到值，
         * 于是详情页与动态页对同一次驳回给出两种说法。
         *
         * 判据：**加字段时记得所有"手工挑字段"的映射点**。
         * 那种写法不会报错、tsc 也过（多传少传都不查），
         * 只在真跑到那条路径时静默说错话。
         */
        isRejection: t.isRejection
      }))
      return mergeTimeline(buildTodoAudit(todoId), transitions)
    })
  )

  /**
   * 「本次变更」（1.0.73，主用户提单 `482e4b03`）
   *
   * 验收时该看的是**这一次交付改了什么**，而不是这条事项的全部历史。
   * 边界、三类归并与排序判据都在 `buildReviewDiff` 里（纯函数，可测）。
   *
   * ⚠️ 取数与 `todo:timeline` **同源**（同样两处：审计事件 + 流转），
   * 但不复用 `mergeTimeline` 的结果 —— 那一步已经把三类拍平成
   * "一句人话 + kind"了，而这里需要**保留每一类的结构**
   * （描述 diff 的行、状态的箭头、字段的 before/after）。
   * 判据：**别为了复用而把结构拍平再重算**，那等于在渲染层做反向解析。
   */
  ipcMain.handle('todo:reviewDiff', (_e, { todoId }: { todoId: string }) =>
    safeHandle(() => {
      const transitions = todoRepo.listTransitions(todoId).map((t) => ({
        fromStatus: t.fromStatus,
        toStatus: t.toStatus,
        actor: t.actor,
        createdAt: t.createdAt,
        isRejection: t.isRejection
      }))
      return buildReviewDiff({ events: new EventsRepository().listForTodo(todoId, 200), transitions })
    })
  )

  /**
   * 事项评论（1.0.54）：规格留在 description，往来都走评论。
   *
   * 写入口一律广播 todo 变更 —— 评论数会显示在卡片上（"3 条评论"），
   * 别的窗口（悬浮球面板、看板）要跟着刷新，否则数字对不上。
   */
  ipcMain.handle('todo:comments', (_e, { todoId }: { todoId: string }) =>
    safeHandle(() => new CommentRepository().listByTodo(todoId))
  )
  ipcMain.handle('todo:commentCounts', (_e, { todoIds }: { todoIds: string[] }) =>
    safeHandle(() => new CommentRepository().countsByTodo(todoIds))
  )
  ipcMain.handle(
    'todo:addComment',
    (
      _e,
      input: { todoId: string; body: string; parentId?: string | null; kind?: CommentKind }
    ) =>
      safeHandle(() => {
        // 界面发评论一律记 human：评论是"人说的还是 agent 说的"由入口决定，
        // 渲染层不传身份，避免构造出一个假的 agent 评论。
        const comment = new CommentRepository().create({
          todoId: input.todoId,
          body: input.body,
          parentId: input.parentId ?? null,
          authorType: 'human',
          authorId: 'human',
          kind: input.kind ?? 'comment'
        })
        broadcastDataChanged('todo', getWindows)
        return comment
      })
  )
  ipcMain.handle('todo:deleteComment', (_e, { id }: { id: string }) =>
    safeHandle(() => {
      /**
       * 界面删评论必须与 CLI `todo delete-comment` 同等待遇（1.0.62）
       *
       * 68c7ccc1 选②时只给 CLI 写了 `comment_deleted` 事件，界面这条路径
       * 仍是裸删 —— 结果就是"agent 删留痕、人删零痕迹"，而界面恰恰是那个
       * 不看命令行的人在用的入口。两条路径分叉写在同一件事上是看不见的，
       * 但它决定了"这条删除究竟有没有留痕"这个问题的答案。
       */
      const commentRepo = new CommentRepository()
      const hit = commentRepo.resolveId(id)
      if (!hit) throw new Error(`找不到评论「${id}」（它可能已经被删掉了）`)
      // foreign key CASCADE 会连带删掉回复，这里先把它们取出来记进事件：
      // 删完之后就再也问不出"那条回复原本挂在谁下面"了。
      const replies = commentRepo.listByTodo(hit.todoId).filter((c) => c.parentId === hit.id)
      commentRepo.remove(hit.id)
      new EventsRepository().append('comment_deleted', 'human', {
        comment: hit,
        cascadedReplies: replies
      })
      broadcastDataChanged('todo', getWindows)
    })
  )

  // ── 分类标签 ──
  ipcMain.handle(
    'category:create',
    (_e, input: CategoryCreateInput) =>
      safeHandle(() => {
        const cat = categoryRepo.create(input)
        broadcastDataChanged('category', getWindows)
        return cat
      })
  )

  ipcMain.handle(
    'category:update',
    (_e, { id, name, color }: { id: string; name?: string; color?: string }) =>
      safeHandle(() => {
        /**
         * color 必须真的传下去。
         * 此前这里只写了 `{ name }`，color 收了却没用 ——
         * 界面上改色看起来成功了（没报错、弹窗也关了），
         * 刷新后颜色原样，是一次**静默失效**。
         */
        const cat = categoryRepo.update(id, { name, color })
        broadcastDataChanged('category', getWindows)
        return cat
      })
  )

  ipcMain.handle(
    'category:merge',
    (_e, { fromId, toId }: { fromId: string; toId: string }) =>
      safeHandle(() => {
        const result = categoryRepo.merge(fromId, toId)
        // 待办的标签变了，只广播 category 的话看板上的卡片不会刷新
        broadcastDataChanged('category', getWindows)
        broadcastDataChanged('todo', getWindows)
        return result
      })
  )

  ipcMain.handle('category:delete', (_e, { id }: { id: string }) =>
    safeHandle(() => {
      // 返回迁移条数：删分类会把其下待办迁到默认分类，
      // 不告诉用户的话，他会以为任务跟着一起没了
      const result = categoryRepo.delete(id)
      broadcastDataChanged('category', getWindows)
      broadcastDataChanged('todo', getWindows)
      return result
    })
  )

  ipcMain.handle('category:list', () =>
    safeHandle(() => categoryRepo.list())
  )

  ipcMain.handle('category:reorder', (_e, { ids }: { ids: string[] }) =>
    safeHandle(() => {
      categoryRepo.reorder(ids)
      broadcastDataChanged('category', getWindows)
    })
  )

  // ── 项目（顶层容器）──
  ipcMain.handle('project:create', (e, input: CreateProjectInput) =>
    safeHandle(() => {
      assertFromSettings(e, 'project:create')
      const project = projectRepo.create({ ...input, actor: 'human' })
      broadcastDataChanged('project', getWindows)
      return project
    })
  )

  ipcMain.handle('project:update', (e, input: UpdateProjectInput) =>
    safeHandle(() => {
      assertFromSettings(e, 'project:update')
      // 界面的保存一律记 human：作者不由渲染层自报，防止修订里出现被冒名的 agent
      // 版本随保存一起记进覆盖声明（v47）：说明自称"覆盖到哪一版"必须有出处
      const project = projectRepo.update({ ...input, actor: 'human' }, { version: app.getVersion() })
      broadcastDataChanged('project', getWindows)
      return project
    })
  )

  /**
   * **永久删除**项目（1.0.111 改口径，卡 `c177e466`）
   *
   * 其下事项**跟着一起删**：项目内的事项、评论、流转、通知、接手说明与版本登记
   * 全部清掉，不迁移、不保留。旧实现是"先迁走再删"，默认落点让
   * "不选承接项目也能删"，还会把事项的 project_id 置空（与"事项必须归项目"冲突）。
   * 只想让项目消失请看归档（`project:update` 置 archived），那是可逆的。
   *
   * 返回逐表条数（ProjectPurgeResult），让界面能说清"清掉了什么"。
   */
  ipcMain.handle('project:delete', (_e, { id }: { id: string }) =>
    safeHandle(() => {
      const result = projectRepo.delete(id)
      broadcastDataChanged('project', getWindows)
      broadcastDataChanged('todo', getWindows)
      return result
    })
  )

  /** 含已归档的，界面自己决定展不展示 */
  ipcMain.handle('project:list', () => safeHandle(() => projectRepo.list()))
  ipcMain.handle('project:detail', (_e, { id }: { id: string }) =>
    safeHandle(() => projectRepo.getDetail(id))
  )
  ipcMain.handle('project:search', (_e, { id, query }: { id: string; query: string }) =>
    safeHandle(() => projectRepo.search(id, query))
  )
  ipcMain.handle('project:searchAll', (_e, { query, projectIds }: { query: string; projectIds?: string[] }) =>
    safeHandle(() => projectRepo.searchMany(query, projectIds))
  )

  // ── 接手说明修订历史（schema v35，36b44adb）──
  /** 读：倒序，含全文（界面做行级差异要用） */
  ipcMain.handle('project:handoffRevisions', (_e, { id, limit }: { id: string; limit?: number }) =>
    safeHandle(() => projectRepo.listHandoffRevisions(id, limit))
  )
  /**
   * 回滚 = 把旧版写成新的一次保存。写类通道：沿用 sender 路由校验，
   * 只有主窗口/设置页能调（与 backup:import 同一道门），悬浮球等小窗口不行。
   */
  ipcMain.handle(
    'project:handoffRollback',
    (e, { id, revisionId }: { id: string; revisionId: string }) =>
      safeHandle(() => {
        assertFromSettings(e, 'project:handoffRollback')
        const result = projectRepo.rollbackHandoff(id, revisionId, 'human', { version: app.getVersion() })
        if (result.changed) broadcastDataChanged('project', getWindows)
        return result
      })
  )
  /** Agent 提议列表只读；决定只允许受信任的主窗口/审批页发起。 */
  ipcMain.handle('project:handoffProposals', () =>
    safeHandle(() => projectRepo.listHandoffProposals('pending', { version: app.getVersion() }))
  )
  ipcMain.handle(
    'project:handoffDecide',
    (e, input: { id: string; decision: 'approved' | 'rejected'; body?: string }) =>
      safeHandle(() => {
        assertFromSettings(e, 'project:handoffDecide')
        const result = projectRepo.decideHandoffProposal(input.id, input.decision, 'human', input.body, {
          version: app.getVersion()
        })
        broadcastDataChanged('project', getWindows)
        return result
      })
  )

  // ── 项目关联本地 Markdown 文档目录（方案 C，卡 a3bd40d8 / 095b2006）──
  ipcMain.handle('project:pickDocsDir', (e, { id }: { id: string }) =>
    safeHandleAsync(async () => {
      assertFromSettings(e, 'project:pickDocsDir')
      const ownerWin = BrowserWindow.fromWebContents(e.sender)
      const dialogOpts: Electron.OpenDialogOptions = {
        title: '选择项目关联的本地文档目录（只读索引与渲染）',
        properties: ['openDirectory']
      }
      const res = ownerWin
        ? await dialog.showOpenDialog(ownerWin, dialogOpts)
        : await dialog.showOpenDialog(dialogOpts)
      if (res.canceled || res.filePaths.length === 0) return null
      const updated = projectRepo.update(
        { id, docsDir: res.filePaths[0], actor: 'human' },
        { version: app.getVersion() }
      )
      broadcastDataChanged('project', getWindows)
      return updated
    })
  )

  ipcMain.handle('project:listDocs', (_e, { id }: { id: string }) =>
    safeHandle(() => projectRepo.listProjectDocs(id))
  )

  ipcMain.handle('project:readDoc', (_e, { id, file }: { id: string; file: string }) =>
    safeHandle(() => projectRepo.readProjectDoc(id, file))
  )

  ipcMain.handle('project:openDocExternal', (_e, { id, file }: { id: string; file?: string }) =>
    safeHandleAsync(async () => {
      const listRes = projectRepo.listProjectDocs(id)
      if (!listRes.docsDir || !listRes.available) {
        throw new Error('项目尚未关联有效的本地文档目录')
      }
      let targetPath = listRes.docsDir
      if (file) {
        const doc = projectRepo.readProjectDoc(id, file)
        const pathMod = await import('node:path')
        targetPath = pathMod.resolve(doc.docsDir, doc.file)
      }
      const errMsg = await shell.openPath(targetPath)
      if (errMsg) throw new Error(errMsg)
      return { opened: targetPath }
    })
  )

  // ── 版本（1.0.73：版本对象）──
  /**
   * 列版本：不传 projectId 全列（跨项目）；传 id 只看那一个项目的。
   *
   * （v33 前还有"传 null 看无归属"的第三种语义 —— 版本必挂项目后无归属不存在了。）
   */
  ipcMain.handle('release:list', (_e, input?: { projectId?: string }) =>
    safeHandle(() => {
      const pid = input?.projectId
      return pid === undefined ? releaseRepo.list() : releaseRepo.listByProject(pid)
    })
  )

  ipcMain.handle(
    'release:detail',
    (_e, { projectId, version }: { projectId: string; version: string }) =>
      safeHandle(() => releaseRepo.detail(projectId, version))
  )

  ipcMain.handle('release:create', (_e, input: CreateReleaseInput) =>
    safeHandle(() => {
      const release = releaseRepo.create(input)
      broadcastDataChanged('project', getWindows)
      return release
    })
  )

  ipcMain.handle('release:update', (_e, input: UpdateReleaseInput) =>
    safeHandle(() => {
      const release = releaseRepo.update(input)
      broadcastDataChanged('project', getWindows)
      return release
    })
  )

  ipcMain.handle(
    'release:delete',
    (_e, { projectId, version }: { projectId: string; version: string }) =>
      safeHandle(() => {
        const result = releaseRepo.delete(projectId, version)
        broadcastDataChanged('project', getWindows)
        return result
      })
  )

  // ── 备忘（memo）──
  ipcMain.handle('memo:list', () => safeHandle(() => memoRepo.list()))

  ipcMain.handle('memo:ack', (_e, { id }: { id: string }) =>
    safeHandle(() => {
      const memo = memoRepo.ack(id, 'human')
      if (memo) broadcastDataChanged('memo', getWindows)
      return memo
    })
  )

  ipcMain.handle('memo:unreadCount', () => safeHandle(() => memoRepo.unreadCount()))

  /**
   * 备忘转待办（R4-5）
   *
   * 备忘是"你留意下"，待办是"这是件事"。AI 投的备忘里，有些读完就知道该办 ——
   * 让人一键转成正式待办，而不是自己把标题重抄一遍。这是备忘这条链路的闭环缺口。
   *
   * 归属：转的人是用户，所以 createdBy 记 human；备忘原文进 description，
   * 并注明来自哪个 agent —— 保留"这条线索是谁发现的"，不因为转格式就丢掉来源。
   */
  ipcMain.handle('memo:toTodo', (_e, { id }: { id: string }) =>
    safeHandle(() => {
      const memo = memoRepo.get(id)
      if (!memo) throw new Error(`备忘不存在: ${id}`)

      // 标题取首行，过长截断；全文进描述
      const firstLine = (memo.text.split('\n')[0] || '').trim()
      const title = firstLine.length > 60 ? firstLine.slice(0, 60) + '…' : firstLine || '（来自备忘）'

      /**
       * ⚠️ 必须带 projectId（1.0.38 修）。
       *
       * v17 把项目定为必填，但只在 CLI 层强制（`--project` required），
       * repo 层刻意不拦。于是 GUI 这条路径造出了 `project_id IS NULL`
       * 的待办 —— 看板按项目筛选时它谁都不属于，正是 v17 想消灭的孤立事项。
       *
       * 取第一个未归档项目兜底：备忘转待办是"顺手一转"的动作，
       * 不该为了它再弹一次项目选择器。一个活跃项目都没有时明确报错，
       * 而不是悄悄写成 NULL。
       */
      const project = projectRepo.listActive()[0] ?? projectRepo.list()[0]
      if (!project) {
        throw new Error('还没有任何项目，请先新建一个项目再转待办')
      }

      const todo = todoRepo.create({
        title,
        description: `来自备忘（${memo.author}）：\n${memo.text}`,
        createdBy: 'human',
        projectId: project.id
      })

      // 转完顺手标已读：它已经从"纸条"变成"要做的事"了，不该继续占着未读数
      memoRepo.ack(id, 'human')

      broadcastDataChanged('memo', getWindows)
      broadcastDataChanged('todo', getWindows)

      return { id: todo.id, title: todo.title, memoId: id }
    })
  )

  /**
   * 备忘删除（1.0.48 给通知详情页）
   *
   * 此前删除只有 CLI（memo rm）—— 铃铛退役、备忘并入通知中心后，
   * 「不要这张纸条了」必须能在界面完成。repo 层会顺手撤掉收件箱索引。
   */
  ipcMain.handle('memo:delete', (_e, { id }: { id: string }) =>
    safeHandle(() => {
      const ok = memoRepo.remove(id)
      if (ok) broadcastDataChanged('memo', getWindows)
      return ok
    })
  )

  // ── 通知中心（1.0.48，schema v21：五类事件一个收件箱）──
  ipcMain.handle('notification:list', (_e, { limit }: { limit?: number } = {}) =>
    safeHandle(() => new NotificationRepository().list(limit ?? 200))
  )

  /**
   * 角标 = **主用户**还没看过的系统通知数（卡 `c13dbb16`）
   *
   * 界面一律带上 `reader`（`'human'`）；不带才是旧的全局口径 —— 留着只为不破坏旧调用点。
   */
  ipcMain.handle('notification:unreadCount', (_e, { reader }: { reader?: string } = {}) =>
    safeHandle(() => new NotificationRepository().unreadSystemCount(reader))
  )

  /**
   * 点开一条 = 让**这个人**读过它（卡 `c13dbb16`）
   *
   * 带 `reader` 时走 `markReadFor`：既写进 `read_by`（未读按主体算），
   * 也保留全局位（CLI 的 `unread` 字段、备忘 ack 那条链路的旧口径）。
   */
  ipcMain.handle('notification:markRead', (_e, { id, reader }: { id: string; reader?: string }) =>
    safeHandle(() =>
      reader === undefined
        ? new NotificationRepository().markRead(id)
        : new NotificationRepository().markReadFor(id, reader)
    )
  )

  ipcMain.handle('notification:markAllRead', (_e, { type, reader }: { type?: NotificationType | null; reader?: string } = {}) =>
    safeHandle(() => {
      const n = new NotificationRepository().markSystemAllRead(type ?? null, reader)
      broadcastDataChanged('notification', getWindows)
      return n
    })
  )

  /**
   * 收件箱一页（卡 `cba46119`，与 CLI 的 `notification list` 同一套读法）。
   *
   * ⚠️ 回执从"一个数组"变成"一页 + 三个计数"。只给数组的话，"还有 N 条"、
   * 页头的「未读 N」、分类 chip 的数字都只能在渲染侧对**已经取回的那一页**去数 ——
   * 那正是这次要治的病（角标 633、页头 484、列表只列得出 500）。
   *
   * 形状与语义都在 `NotificationRepository.inboxPage` 里：handler 只搬参数，
   * 这样"界面拿到的这一份"能被仓储层的用例钉住，而不是散在一个接不了线的 handler 里。
   */
  ipcMain.handle('notification:listWithProject', (
    _e,
    {
      limit,
      offset,
      projectId,
      type,
      reader
    }: {
      limit?: number
      offset?: number
      projectId?: string | null
      type?: NotificationType | null
      /** 这是**谁**的收件箱（卡 `c13dbb16`）：界面传 `'human'`，不传 = 旧的全局口径 */
      reader?: string
    } = {}
  ) =>
    safeHandle(() =>
      new NotificationRepository().inboxPage({
        projectId: projectId ?? null,
        type: type ?? null,
        offset,
        limit: limit ?? 500,
        ...(reader !== undefined ? { unreadFor: reader } : {})
      })
    )
  )
  ipcMain.handle('notification:markProjectRead', (_e, { projectId, type, reader }: { projectId: string; type?: NotificationType | null; reader?: string }) =>
    safeHandle(() => {
      const n = new NotificationRepository().markProjectRead(projectId, type ?? null, reader)
      broadcastDataChanged('notification', getWindows)
      return n
    })
  )
  ipcMain.handle('comment:waitingFor', (_e, { actor, repliedOnly }: { actor: string; repliedOnly?: boolean }) =>
    safeHandle(() => new CommentRepository().listWaitingFor(actor, { repliedOnly }))
  )

  // ── 设置 ──
  ipcMain.handle('settings:get', () =>
    safeHandle(() => settingsRepo.get())
  )

  ipcMain.handle('settings:update', (_e, partial: Partial<AppSettings>) =>
    safeHandle(() => {
      const settings = settingsRepo.update(partial)
      // 副作用：重新注册全局快捷键、应用开机自启、更新看板置顶等
      const warning = onSettingsChanged?.(settings, partial)
      // 副作用可能回滚了部分字段（如快捷键被占用），以数据库最终值为准
      const finalSettings = warning ? settingsRepo.get() : settings
      broadcastDataChanged('settings', getWindows)
      return { settings: finalSettings, warning }
    })
  )

  ipcMain.handle('settings:resetVisual', () =>
    safeHandle(() => {
      const settings = settingsRepo.resetVisual()
      broadcastDataChanged('settings', getWindows)
      return settings
    })
  )

  // ── 本地使用埋点 ──
  //
  // 数据只在本地，出口只有「导出」这一个，没有任何自动上传。
  // 是否记录由设置项 telemetryEnabled 控制，关闭后本服务直接不写库。
  ipcMain.handle(
    'telemetry:stats',
    (_e, filter: { since?: string; until?: string; category?: string } = {}) =>
      safeHandle(() => telemetryService?.stats(filter) ?? null)
  )

  ipcMain.handle(
    'telemetry:export',
    (
      _e,
      filter: { since?: string; until?: string; category?: string; limit?: number } = {}
    ) => safeHandle(() => telemetryService?.query(filter) ?? [])
  )

  ipcMain.handle('telemetry:clear', (_e, input: { before?: string } = {}) =>
    safeHandle(() => {
      const removed = telemetryService?.clear(input.before) ?? 0
      return { removed }
    })
  )

  /**
   * 已注册的 agent 身份（视角切换用）
   *
   * 视角里"每个已注册 agent 自动获得自己的视角" —— 选项不能写死，
   * 只能问数据：今天注册了Bob，界面上就该多出「Bob」这一档。
   */
  ipcMain.handle('agent:list', () => safeHandle(() => agentRepo.list()))

  /**
   * 批准 / 收回某个 agent 的写权限（1.0.35）
   *
   * **只能由界面发起** —— 这是刻意的：CLI 侧没有对应的命令，
   * 否则 agent 自己注册、自己批准，整套门禁就成了摆设。
   * 谁能往你的看板写东西，必须由人点头（Moltbook 的 Human-Agent Bond 同思路）。
   */
  ipcMain.handle(
    'agent:setApproved',
    (e, { id, approved }: { id: string; approved: boolean }) =>
      safeHandle(() => {
        assertFromSettings(e, 'agent:setApproved')
        const result = agentRepo.setApproved(id, approved)
        /**
         * 批准/取消批准之后要收回那条「已接入，等你批准写入」的横幅
         * （2026-10-01，主用户报的横幅内容对不上）。
         *
         * 这条横幅是"它刚到、等你点头"，人点头之后它就过期了 ——
         * 而横幅没有自动收起机制（见 hideReminderBanners 的注释），
         * 不收就永久钉在屏幕最上层，看起来像"批准了但没生效"。
         */
        hideReminderBanners()
        return result
      })
  )

  /**
   * 拒绝一个还没批准的身份（1.0.62，aa0b4610）
   *
   * 与批准同一道门（`assertFromSettings`、且 CLI 侧没有对应命令）：
   * agent 不能自己给自己"结案"，否则它注册完立刻调一次拒绝，
   * 就能把这个身份从人的视野里抹掉。
   */
  ipcMain.handle(
    'agent:setRejected',
    (e, { id, rejected }: { id: string; rejected: boolean }) =>
      safeHandle(() => {
        assertFromSettings(e, 'agent:setRejected')
        const result = agentRepo.setRejected(id, rejected)
        // 同上：拒绝了它，那条"等你批准写入"的横幅同样过期了，一起收掉
        hideReminderBanners()
        return result
      })
  )

  /**
   * 授权记录（1.0.36 撤销与审计）
   *
   * 界面要回答三个问题：它现在被允许干什么、什么时候被允许的、上一次动我的数据是什么时候。
   * 前两个在 agent_grants 里（谁申请、谁批、何时、用掉没有），
   * 第三个在 agents.last_write_* 上。合成一个"权限账本"给界面，
   * 而不是让它自己去拼两张表。
   */
  ipcMain.handle('agent:listGrants', (_e, filter?: ListGrantsFilter) =>
    safeHandle(() =>
      agentRepo.listGrants({ ...(filter ?? {}), limit: filter?.limit ?? 200 })
    )
  )
  ipcMain.handle('agent:listGrantHistory', (_e, filter: GrantHistoryFilter) =>
    safeHandle(() => agentRepo.listGrantHistory(filter))
  )
  ipcMain.handle('approval:listHistory', (_e, filter: ApprovalHistoryFilter) =>
    safeHandle(() => agentRepo.listApprovalHistory(filter))
  )

  /**
   * 人对一条授权申请表态（允许 / 拒绝）
   *
   * 与批准写入同理由：**只能由界面发起**。CLI 侧没有对应命令 ——
   * 有就等于 agent 能自己批自己，门禁成摆设。
   * `longTerm` 只由界面上的「长期允许」按钮传，默认是会话级。
   *
   * ⚠️ 1.0.45 起「允许」的语义变了：**不再只是发一张许可证，而是当场执行**。
   *
   * 主用户 2026-09-22 的架构判断（原话）：
   * 「所以才说删除审批应该直接服务端处理呀，要不然就要有发通知给 agent
   *   的机制，不然一定会出问题的。」
   *
   * 此前流程是「人批准 → 发一张一次性许可证 → agent 下次重试时用掉它」，
   * 而这个链条有三处必然出问题的地方（Bob实测 + 我自己撞到）：
   * - agent 看不到人何时点允许，只能 sleep 猜时间；
   * - 人点头时 agent 会话可能已结束 → 授权白批，攒到下次在线才消费；
   * - 一次性授权的粒度是「一次动作」，而人的意图粒度是「一件我要它做的事」——
   *   批准一次只能删掉一条，同一个意图要点两次头。
   *
   * 现在：允许 → 就地执行 → 回执写进 exec_status，界面直接显示「已删除 xx」。
   * 「agent 回来执行」这一步不存在了，上述三个问题一起消失。
   * `longTerm` 仍然只改授权有效期（不发许可证就没意义了，保留它是为了
   * 兼容界面上的「长期允许」按钮 —— 长期授权让 agent 后续同类调用免申请）。
   */
  ipcMain.handle(
    'agent:resolveGrant',
    async (
      e,
      {
        grantId,
        allow,
        longTerm,
        withForce
      }: { grantId: string; allow: boolean; longTerm?: boolean; withForce?: boolean }
    ) =>
      safeHandleAsync(async () => {
        assertFromSettings(e, 'agent:resolveGrant')
        const grant = agentRepo.resolveGrant(grantId, allow, { longTerm: longTerm === true })
        if (!grant) throw new Error(`授权申请不存在：${grantId}`)

        /**
         * 表态与横幅必须同步（2026-09-24，修主用户报的「审批通过后横幅常驻」）。
         *
         * 横幅上的按钮会自己收起横幅；但在**用户页**批准/拒绝时，
         * 此前没有任何代码去收起已经弹出的横幅 —— 那是 alwaysOnTop 的
         * screen-saver 层、skipTaskbar，不收就永远钉在屏幕顶上，
         * 看起来就像"批完了它还在"。
         *
         * 延迟 2.6s：横幅直批那条路要先让人看见「已通过并执行」的回执
         *（横幅组件自己也是 2.6s 后收，两处时序一致，重复 hide 无害）。
         *
         * 2026-10-01：抽成 hideReminderBanners()，因为**批准身份**那条路
         *（agent:setApproved / setRejected）也需要它却一直没有 —— 同一类
         * 出口散在两处、只有一处有收横幅，正是"横幅批完了还挂着"的第二个来源。
         *
         * 1.0.118（卡 `0dfff6df` 的续）：**需要人再点一次时不许收**。
         * 撞上"补个 --force 就能继续"的守卫时，横幅上会出现「确认删除」，
         * 而这里原先无条件排这个定时器 —— 按钮刚出现就随横幅一起消失。
         * 渲染侧那条"需要补一次点头就不自动收"因此等于白做，
         * 而且渲染测试看不出这一层：它只知道自己没排定时器，看不到主进程排了。
         */
        const scheduleBannerHide = (): void => {
          setTimeout(hideReminderBanners, 2600)
        }

        // 拒绝：到此为止，不执行任何东西（结论已出，横幅可以收）
        if (!allow) {
          scheduleBannerHide()
          broadcastDataChanged('grant', getWindows)
          return { grant, execution: null }
        }

        /**
         * 批准：替人把这件事做掉。
         *
         * 没有 argv 就执行不了 —— 那只可能是 v20 之前的历史申请
         * （那时还没记录命令行）。此时**不假装成功**：授权照旧生效，
         * 由 agent 自己重试，但要把这件事告诉人，否则他会以为已经执行过了。
         */
        if (!grant.requestArgv.length) {
          scheduleBannerHide()
          return {
            grant,
            execution: {
              ok: false,
              skipped: true,
              message: '已批准，请让 Agent 重新执行该操作。'
            }
          }
        }

        /**
         * ⚠️ 这里**不预先销账**，交给 executeOne 的成功路径去销。
         *
         * 曾经写成"执行前先 consume"，那是错的：`assertScopeAllowed`
         * 的批准路径要靠 `findUsableGrant(..., onlyPendingId)` 找出
         * **用户刚点的那一条**，而它只认 `status='granted'` ——
         * 先销账会让它查不到，于是"人明明批了"却收到 grant_required。
         *
         * 改成复用既有的"命令成功才销账"机制（executeOne 末尾那段），
         * 语义也更宽容：执行失败时授权留着，agent 重试同一个目标仍被允许；
         * 而成功之后授权即失效，不存在"批一次、动两次"。
         */
        // 执行前快照项目归属：批准动作可能删除/迁移事项，执行后再查会丢失项目上下文。
        /**
         * ⚠️ 1.0.119：这里的 argv 是**人怎么敲的**那条，id 常是 8 位前缀
         *（`todo rm c02a327c --yes`）。直接 `getById` 只认完整 uuid ——
         * 查不到目标，回执里就既没有"删的是哪条"、也没有"还有几条子任务"，
         * 只剩一句"再点一次就完成了"，读起来像在催人删。
         * 所以按命令自己的解析法走 `resolveId`（认前缀；解不开就当没有）。
         */
        const executionTodo = grant.requestArgv
          .map((arg) => {
            try {
              return todoRepo.getById(todoRepo.resolveId(arg))
            } catch {
              // 命令行里的其它词（`todo rm` / `--yes`）解不成 id，正常跳过
              return null
            }
          })
          .find((todo) => todo !== null)
        const executionProjectId = executionTodo?.projectId ?? null
        /**
         * 子任务数也要在执行**前**取（1.0.117）。
         * 删除成功后父卡已经不在，`childCount` 一律归零 —— 那正好把
         * 「它下面还有 3 条子任务，已解绑保留」这句话里唯一有用的数字抹掉。
         */
        const executionChildCount = executionTodo
          ? todoRepo.childCount(executionTodo.id)
          : 0

        /**
         * 用户点了「确认删除」：在**原申请**后面补一个 `--force`（`f9cd007e`）。
         *
         * 为什么不让她重新申请一遍：这次申请正是为了这件事，
         * 而"还有子任务要确认"是回放时才撞上的守卫 —— 让人把同一个决定做两遍，
         * 正是这张卡要治的病。
         *
         * ⚠️ 只补一次、只在原本没有时补：`--force` 不是万能通行证，
         * 其它参数一个都不许变（门禁的 `grantCoversArgv` 只认这一种放宽）。
         */
        const replayArgv =
          withForce === true && !grant.requestArgv.includes('--force')
            ? [...grant.requestArgv, '--force']
            : grant.requestArgv

        const outcome = await executeApproved(
          {
            deps: {
              todoRepo,
              categoryRepo,
              projectRepo,
              releaseRepo,
              memoRepo,
              settingsRepo,
              agentRepo,
              /**
               * 卡 `69788c32`：命令层要的仓储在这里一次给全 —— 批准回放走的是
               * 同一条 `executeApproved`，缺一个就会在回放到那条命令时炸。
               * 与 `index.ts` 两条通道同一份清单（闸门逐个字段核对）。
               */
              commentRepo: new CommentRepository(),
              notificationRepo: new NotificationRepository(),
              reminderReceiptRepo: new ReminderReceiptRepository(),
              rulesRepo: new RulesRepository(),
              protocolRepo: new ProtocolRepository(),
              profileRepo: new ProfileRepository(),
              events: {
                append: (type, actor, payload) => eventsRepo.append(type, actor, payload)
              },
              telemetry: {
                record: (input) => telemetryService?.record(input),
                query: (filter) => telemetryService?.query(filter) ?? [],
                stats: (filter) => telemetryService?.stats(filter) ?? null,
                clear: (before) => telemetryService?.clear(before) ?? 0
              }
            },
            meta: {
              version: app.getVersion(),
              dbPath: '',
              schemaVersion: DB_VERSION,
              busyTimeoutMs: 5000,
              channels: ['pipe'],
              via: 'pipe',
              startedAt: Date.now()
            }
          },
          replayArgv,
          // 身份与凭据都取自那条申请：动作归属仍是发起它的 agent，
          // 通行依据是"用户刚点了这条申请的头"（而不是 agent 出示凭据）
          { agentId: grant.agentId, grantId: grant.id }
        )

        /**
         * 成功回执也要有内容（1.0.62，收 10f0a5d6 最后一段）
         *
         * 失败侧一直存着原文（G4 守卫那一整段说明都在），成功侧除了一个 'ok'
         * 什么都没留 —— 于是流水里最空洞的恰恰是"做成了"的那些。
         * 摘要落库后才谈得上"事后能核对这次点头做出了什么"。
         */
        const execSummary = outcome.ok ? pickExecSummary(outcome) : null

        /**
         * 回执分两层（1.0.117，卡 `0dfff6df`）：
         * - `message`：给人看的那一句（`src/main/lib/exec-receipt.ts`）；
         * - `details`：命令行原文，只占审批页的"详情"位。
         *
         * 此前成功侧回的是「已执行：todo rm <uuid> --yes --force」——
         * 那是把内部实现又念一遍。人想知道的是删掉了什么、子任务怎么办。
         *
         * ⚠️ 三处出口（落库的 exec_summary / 通知中心 / 回给界面的回执）
         * 必须取**同一个** message：各写一遍就会出现"通知里是人话、流水里是命令原文"，
         * 而错位的那一侧恰好是唯一被留下来的那一侧。
         */
        const canForce =
          !outcome.ok &&
          !replayArgv.includes('--force') &&
          /--force/.test(outcome.message ?? '')
        const receipt = buildExecReceipt({
          ok: outcome.ok,
          summary: execSummary,
          argv: replayArgv,
          target: executionTodo
            ? { title: executionTodo.title, childCount: executionChildCount }
            : null,
          guardMessage: outcome.ok ? null : outcome.message,
          canForce
        })

        /**
         * 结论已出才收横幅；要人再点一次「确认删除」时**不收** ——
         * 那个按钮就在这条横幅上（1.0.118）。
         */
        if (!canForce) scheduleBannerHide()

        agentRepo.recordGrantExecution(
          grant.id,
          outcome.ok,
          outcome.ok ? null : outcome.message,
          receipt.message
        )

        /**
         * 执行回执进通知中心（1.0.48，五类之三）。
         * 批准是"点一下头"，回执是"到底发生了什么" —— 没有回执的批准
         * 是一个没有答案的动作（主用户）。成功绿 / 失败红，meta.ok 给页面取色。
         */
        try {
          new NotificationRepository().create({
            type: 'exec_result',
            title: outcome.ok
              ? `已通过并执行：${grant.summary || grant.command}`
              : `执行失败：${grant.summary || grant.command}`,
            // 三处回执（通知 / 回给界面 / 落库）取同一句话，避免"通知里是人话、流水里是命令原文"
            summary: receipt.message,
            refId: grant.id,
            actor: grant.agentId,
            meta: {
              ok: outcome.ok,
              ...(executionProjectId ? { projectId: executionProjectId } : {})
            }
          })
          broadcastDataChanged('notification', getWindows)
        } catch (err) {
          console.warn('[Notification] 执行回执写入失败:', err instanceof Error ? err.message : err)
        }

        // 真的动了数据 → 让所有窗口刷新（看板要立刻少掉那条；哪怕撞上守卫未执行，grant 状态也已变为 granted/execError，审批页需立即感知）
        if (outcome.ok) {
          broadcastDataChanged('todo', getWindows)
        }
        broadcastDataChanged('grant', getWindows)

        return {
          grant: agentRepo.getGrant(grant.id),
          execution: {
            ok: outcome.ok,
            skipped: false,
            /**
             * 失败时告诉界面"还能不能再试一次、怎么试"（`f9cd007e`）。
             *
             * 只在**守卫提示要补 flag** 时才给：其它失败（对象已不存在、权限不符）
             * 补什么都是白试，给了按钮只会让人白点第二次。
             */
            canForce,
            /** 给人看的回执（命令自己给了结论就用它，否则按动作补一句人话） */
            message: receipt.message,
            /** 命令行原文。审计用，界面上折在"详情"里，不占回执主位 */
            details: receipt.details
          }
        }
      })
  )

  /** 撤销：收回还没用掉的授权（pending / granted），已发生的不动 */
  ipcMain.handle(
    'agent:revokeGrants',
    (e, { id, scope }: { id: string; scope?: GrantScope }) =>
      safeHandle(() => {
        assertFromSettings(e, 'agent:revokeGrants')
        return agentRepo.revokeGrants(id, scope)
      })
  )

  // ── AI 助手接入说明 ──
  // 路径由主进程动态推导，界面不参与拼接 —— 打包后目录布局不同，写死必失效
  ipcMain.handle('cli:agentGuide', () => safeHandle(() => buildAgentGuideIndex(undefined, app.getVersion())))
  // 本机真实接入地址（1.0.132，卡 `25caac02`）：开场提示词要把入口写进正文，否则没接过 DeskPartner 的
  // agent 第一步就是 `dp: command not found`（产品刻意不写用户 PATH，见 `2cc71a13`）。
  ipcMain.handle(
    'cli:connectInfo',
    () =>
      safeHandle(() => ({
        cliPath: resolveLauncherPath(),
        cliEnvVar: 'DESKPARTNER_CLI',
        cliEnvAvailable: cliEnvVarAvailable(),
        mcpCommand: resolveMcpPath()
      }))
  )

  // ── 用户页协作协议：约定可编辑，代码硬关口只读 ──
  ipcMain.handle('protocol:get', (_e, input?: { projectId?: string }) =>
    safeHandle(() => ({
      scope: input?.projectId ? 'project' : 'global',
      blocks: protocolRepo.list(input?.projectId
        ? { scope: 'project', projectId: input.projectId }
        : { scope: 'global' }),
      gates: GATES
    }))
  )
  ipcMain.handle('protocol:set', (e, input: { projectId?: string; blockKey: string; body: string; confirmed?: boolean }) =>
    safeHandle(() => {
      assertFromSettings(e, 'protocol:set')
      const scope = input.projectId
        ? { scope: 'project' as const, projectId: input.projectId }
        : { scope: 'global' as const }
      const existing = protocolRepo.list(scope).find((block) => block.blockKey === input.blockKey)
      const confirmed = input.confirmed ?? existing?.confirmed ?? true
      return protocolRepo.save(scope, input.blockKey as import('./database/protocol.repository').ProtocolBlockKey, input.body, 'human', confirmed)
    })
  )
  ipcMain.handle('protocol:proposals', () => safeHandle(() => protocolRepo.listProposals()))
  ipcMain.handle('protocol:revisions', (_e, input?: { projectId?: string; blockKey?: string }) =>
    safeHandle(() => protocolRepo.listRevisions(
      input?.projectId ? { scope: 'project', projectId: input.projectId } : { scope: 'global' },
      input?.blockKey as import('./database/protocol.repository').ProtocolBlockKey | undefined
    ))
  )
  ipcMain.handle('protocol:rollback', (e, input: { id: string }) =>
    safeHandle(() => {
      assertFromSettings(e, 'protocol:rollback')
      return protocolRepo.rollbackRevision(input.id, 'human')
    })
  )
  ipcMain.handle('protocol:decide', (e, input: { id: string; decision: 'approved' | 'rejected'; body?: string }) =>
    safeHandle(() => {
      assertFromSettings(e, 'protocol:decide')
      return protocolRepo.decideProposal(input.id, input.decision, 'human', input.body)
    })
  )


  // ── 用户页主用户档案：全局默认，项目只覆盖授权边界与完成标准 ──
  ipcMain.handle('profile:get', (_e, input?: { projectId?: string }) =>
    safeHandle(() => ({
      scope: input?.projectId ? 'project' : 'global',
      blocks: profileRepo.list(input?.projectId
        ? { scope: 'project', projectId: input.projectId }
        : { scope: 'global' })
    }))
  )
  ipcMain.handle('profile:set', (e, input: { projectId?: string; blockKey: string; body: string }) =>
    safeHandle(() => {
      assertFromSettings(e, 'profile:set')
      const scope = input.projectId
        ? { scope: 'project' as const, projectId: input.projectId }
        : { scope: 'global' as const }
      return profileRepo.save(scope, input.blockKey as import('./database/profile.repository').ProfileBlockKey, input.body, 'human', true)
    })
  )
  ipcMain.handle('profile:proposals', () => safeHandle(() => profileRepo.listProposals()))
  ipcMain.handle('profile:revisions', (_e, input?: { projectId?: string; blockKey?: string }) =>
    safeHandle(() => profileRepo.listRevisions(
      input?.projectId ? { scope: 'project', projectId: input.projectId } : { scope: 'global' },
      input?.blockKey as import('./database/profile.repository').ProfileBlockKey | undefined
    ))
  )
  ipcMain.handle('profile:rollback', (e, input: { id: string }) =>
    safeHandle(() => {
      assertFromSettings(e, 'profile:rollback')
      return profileRepo.rollbackRevision(input.id, 'human')
    })
  )
  ipcMain.handle('profile:decide', (e, input: { id: string; decision: 'approved' | 'rejected'; body?: string }) =>
    safeHandle(() => {
      assertFromSettings(e, 'profile:decide')
      return profileRepo.decideProposal(input.id, input.decision, 'human', input.body)
    })
  )

  // ── 协作规则配置：流转规则 / 权限矩阵 / 提醒 ──
  // 权限矩阵仅 GUI 可改（安全底线）；规则提议走审批页。
  const rulesRepo = new RulesRepository()
  ipcMain.handle('rules:get', (_e, input?: { projectId?: string }) =>
    safeHandle(() => {
      const scope = input?.projectId
        ? { scope: 'project' as const, projectId: input.projectId }
        : { scope: 'global' as const }
      return {
        scope: scope.scope,
        projectId: input?.projectId ?? null,
        rules: rulesRepo.listRules(scope),
        permissions: rulesRepo.listPermissions(scope)
      }
    })
  )
  ipcMain.handle('rules:setRule', (e, input: { projectId?: string; ruleKey: string; enforcement: string }) =>
    safeHandle(() => {
      assertFromSettings(e, 'rules:setRule')
      const scope = input.projectId
        ? { scope: 'project' as const, projectId: input.projectId }
        : { scope: 'global' as const }
      return rulesRepo.saveRule(scope, input.ruleKey, input.enforcement as any, 'human')
    })
  )
  ipcMain.handle('rules:setPermission', (e, input: { projectId?: string; action: string; subject: string; decision: string }) =>
    safeHandle(() => {
      assertFromSettings(e, 'rules:setPermission')
      const scope = input.projectId
        ? { scope: 'project' as const, projectId: input.projectId }
        : { scope: 'global' as const }
      return rulesRepo.savePermission(scope, input.action, input.subject, input.decision as any, 'human')
    })
  )
  ipcMain.handle('rules:resetRule', (e, input: { projectId?: string; ruleKey: string }) =>
    safeHandle(() => {
      assertFromSettings(e, 'rules:resetRule')
      const scope = input.projectId
        ? { scope: 'project' as const, projectId: input.projectId }
        : { scope: 'global' as const }
      rulesRepo.resetRule(scope, input.ruleKey, 'human')
      return rulesRepo.listRules(scope).find((r: { key: string }) => r.key === input.ruleKey)
    })
  )
  ipcMain.handle('rules:revisions', (_e, input?: { projectId?: string; ruleKey?: string }) => {
    const scope = input?.projectId
      ? { scope: 'project' as const, projectId: input.projectId }
      : { scope: 'global' as const }
    return safeHandle(() => rulesRepo.listRevisions(scope, input?.ruleKey))
  })
  ipcMain.handle('rules:rollback', (e, input: { id: string }) =>
    safeHandle(() => {
      assertFromSettings(e, 'rules:rollback')
      return rulesRepo.rollbackRevision(input.id, 'human')
    })
  )
  ipcMain.handle('rules:proposals', () => safeHandle(() => rulesRepo.listProposals()))
  ipcMain.handle('rules:decide', (e, input: { id: string; decision: 'approved' | 'rejected'; enforcement?: string }) =>
    safeHandle(() => {
      assertFromSettings(e, 'rules:decide')
      return rulesRepo.decideProposal(input.id, input.decision, 'human', input.enforcement as any)
    })
  )

  /** 版本与数据位置（1.0.48：设置·系统组展示用；路径只有主进程知道，写死必失效） */
  ipcMain.handle('app:info', () =>
    safeHandle(() => ({ version: app.getVersion(), dataDir: getDataDirPath() }))
  )
  ipcMain.handle('app:getUpdateState', () => safeHandle(() => autoUpdateService.getState()))
  ipcMain.handle('app:checkForUpdates', () => safeHandleAsync(() => autoUpdateService.checkForUpdates()))
  ipcMain.handle('app:downloadUpdate', () => safeHandleAsync(() => autoUpdateService.downloadUpdate()))
  ipcMain.handle('app:quitAndInstallUpdate', () => safeHandle(() => autoUpdateService.quitAndInstall()))
  ipcMain.handle('app:openDataDir', () =>
    safeHandleAsync(async () => {
      const dir = getDataDirPath()
      const errMsg = await shell.openPath(dir)
      if (errMsg) throw new Error(errMsg)
      return { opened: true, dataDir: dir }
    })
  )
  ipcMain.handle('app:pickDataDir', (e) =>
    safeHandleAsync(async () => {
      assertFromSettings(e, 'app:pickDataDir')
      const ownerWin = BrowserWindow.fromWebContents(e.sender)
      const dialogOpts: Electron.OpenDialogOptions = {
        title: '选择新的数据存储目录',
        defaultPath: getDataDirPath(),
        properties: ['openDirectory', 'createDirectory']
      }
      const picked = ownerWin
        ? await dialog.showOpenDialog(ownerWin, dialogOpts)
        : await dialog.showOpenDialog(dialogOpts)
      if (picked.canceled || !picked.filePaths[0]) {
        return { canceled: true, targetDir: null }
      }
      return { canceled: false, targetDir: picked.filePaths[0] }
    })
  )
  ipcMain.handle('app:pickAppIcon', (e) =>
    safeHandleAsync(async () => {
      assertFromSettings(e, 'app:pickAppIcon')
      const ownerWin = BrowserWindow.fromWebContents(e.sender)
      const dialogOpts: Electron.OpenDialogOptions = {
        title: '选择应用图标',
        properties: ['openFile'],
        filters: [
          { name: '图片文件', extensions: ['png', 'ico', 'jpg', 'jpeg', 'webp', 'bmp'] }
        ]
      }
      const picked = ownerWin
        ? await dialog.showOpenDialog(ownerWin, dialogOpts)
        : await dialog.showOpenDialog(dialogOpts)
      if (picked.canceled || !picked.filePaths[0]) {
        return { canceled: true, dataUrl: null }
      }
      const img = nativeImage.createFromPath(picked.filePaths[0])
      if (img.isEmpty()) {
        throw new Error('无法读取该图片，请选择有效的 PNG / ICO / JPG 图片文件')
      }
      const { width, height } = img.getSize()
      const resized =
        width !== 128 || height !== 128
          ? img.resize({ width: 128, height: 128, quality: 'best' })
          : img
      // 若所选图片为透明底（四角 alpha < 250），自动在圆形区域内衬一层白底与浅灰描边，
      // 防止深色图形在 Windows 深色任务栏、系统托盘或深色界面下被背景吞没
      const bmp = Buffer.from(resized.toBitmap())
      if (bmp.length === 128 * 128 * 4 && bmp[3] < 250) {
        const cx = 63.5
        const cy = 63.5
        const discR = 62
        for (let y = 0; y < 128; y++) {
          for (let x = 0; x < 128; x++) {
            const idx = (y * 128 + x) * 4
            const dist = Math.hypot(x - cx, y - cy)
            if (dist > discR + 0.5) {
              bmp[idx] = 0
              bmp[idx + 1] = 0
              bmp[idx + 2] = 0
              bmp[idx + 3] = 0
              continue
            }
            const discAlpha = dist <= discR - 0.5 ? 1 : Math.max(0, Math.min(1, discR + 0.5 - dist))
            const isBorder = discR - dist < 1.5
            const bgB = isBorder ? 226 : 255
            const bgG = isBorder ? 218 : 255
            const bgR = isBorder ? 214 : 255
            const fgA = bmp[idx + 3] / 255
            bmp[idx] = Math.round(bmp[idx] * fgA + bgB * (1 - fgA))
            bmp[idx + 1] = Math.round(bmp[idx + 1] * fgA + bgG * (1 - fgA))
            bmp[idx + 2] = Math.round(bmp[idx + 2] * fgA + bgR * (1 - fgA))
            bmp[idx + 3] = Math.round(discAlpha * 255)
          }
        }
        const composited = nativeImage.createFromBitmap(bmp, { width: 128, height: 128 })
        return { canceled: false, dataUrl: composited.toDataURL() }
      }
      return { canceled: false, dataUrl: resized.toDataURL() }
    })
  )
  ipcMain.handle('app:changeDataDir', (e, input?: { targetDir?: string }) =>
    safeHandleAsync(async () => {
      assertFromSettings(e, 'app:changeDataDir')
      let targetDir = input?.targetDir?.trim()
      if (!targetDir) {
        const ownerWin = BrowserWindow.fromWebContents(e.sender)
        const dialogOpts: Electron.OpenDialogOptions = {
          title: '选择新的数据存储目录',
          defaultPath: getDataDirPath(),
          properties: ['openDirectory', 'createDirectory']
        }
        const picked = ownerWin
          ? await dialog.showOpenDialog(ownerWin, dialogOpts)
          : await dialog.showOpenDialog(dialogOpts)
        if (picked.canceled || !picked.filePaths[0]) {
          return { changed: false, dataDir: getDataDirPath() }
        }
        targetDir = picked.filePaths[0]
      }
      const res = await migrateDataDirectory(targetDir)
      if (res.changed) {
        broadcastDataChanged('todo', getWindows)
        broadcastDataChanged('project', getWindows)
        broadcastDataChanged('category', getWindows)
        broadcastDataChanged('settings', getWindows)
      }
      return res
    })
  )

  // ── 窗口控制（由 WindowManager 处理，此处仅转发） ──
  // 这些 handler 在 WindowManager 中通过回调注册
  // 占位确保类型一致，实际逻辑由 windows.ts 中的 setupWindowIPC 注册

  // ── 提醒 ──
  ipcMain.handle(
    'reminder:snooze',
    (_e, { todoId, minutes }: { todoId: string; minutes: number }) =>
      safeHandle(() => {
        timerService.snoozeReminder(todoId, minutes)
      })
  )

  ipcMain.handle('reminder:dismiss', (_e, { todoId }: { todoId: string }) =>
    safeHandle(() => {
      timerService.cancelReminder(todoId)
    })
  )

  // ── 数据备份 ──
  ipcMain.handle('backup:export', () =>
    safeHandle(() => backupService.exportData())
  )

  ipcMain.handle('backup:import', (e, { data }: { data: string }) =>
    safeHandle(() => {
      assertFromSettings(e, 'backup:import')
      const result = backupService.importData(data)
      broadcastDataChanged('todo', getWindows)
      return result
    })
  )

  console.log('[IPC] 所有处理器已注册')
}

/** 广播数据变更事件到所有渲染进程 */
/**
 * 本进程标识
 *
 * 写入 events 表时带上它：本进程自己产生的变更在写入时就已经广播过了，
 * 轮询遇到同标识的事件只需推进游标，不再重复广播。
 */
const LOCAL_ACTOR = LOCAL_ACTOR_ID
const eventsRepo = new EventsRepository()

function broadcastDataChanged(
  type: 'todo' | 'category' | 'project' | 'settings' | 'memo' | 'grant' | 'notification',
  getWindows: () => {
    floatBall?: BrowserWindow | null
    quickAdd?: BrowserWindow | null
    kanban?: BrowserWindow | null
    settings?: BrowserWindow | null
  }
): void {
  // 追加变更事件，让**其他进程**（如 CLI 调用）正在运行的 GUI 能察觉到
  try {
    eventsRepo.append(type, LOCAL_ACTOR)
  } catch (err) {
    console.error('[IPC] 追加变更事件失败:', err instanceof Error ? err.message : String(err))
  }

  const windows = getWindows()
  const payload = { type }
  for (const win of Object.values(windows)) {
    if (win && !win.isDestroyed()) {
      win.webContents.send('event:dataChanged', payload)
    }
  }
}
