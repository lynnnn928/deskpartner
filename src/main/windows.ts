import {
  BrowserWindow,
  ipcMain,
  screen,
  nativeImage
} from 'electron'
import path from 'path'
import type { AppSettings, WindowBounds, WindowPosition } from '../renderer/types/settings'
import { SettingsRepository } from './database/settings.repository'
import { getResourcesPath } from './utils/path'
import {
  REMINDER_BANNER_MIN_H,
  REMINDER_BANNER_W,
  clampReminderBannerHeight
} from './lib/banner-size'

/**
 * 应用图标路径
 * Windows 任务栏与窗口使用；打包后由 extraResources 复制到 resources/resources/
 */
function appIconPath(): string {
  return path.join(getResourcesPath(), 'icon.ico')
}

/**
 * 详情抽屉的默认宽度
 *
 * 取 480 而不是更宽：抽屉是"看着看板改这一条"，不是"占半个屏幕工作"。
 * 它的意义在于不遮挡上下文 —— 太宽就把这个初衷湮没了。
 */
const DRAWER_DEFAULT_WIDTH = 480

/** 抽屉宽度可调区间：下限保住表单能排开，上限不超过半屏多一点 */
const DRAWER_MIN_WIDTH = 360
const DRAWER_MAX_WIDTH = 1000

/**
 * 顶部提醒横幅的尺寸与夹法在 `lib/banner-size`（纯函数，可单测）。
 * 这里只负责"何时用它"：挂载时给下限，渲染层量完了按量到的高度改。
 */

/**
 * 窗口类 IPC 的统一成功包装（1.0.48）
 *
 * 渲染侧的 invoke 会把返回值当 `{ ok, data }` 解包，`ok` 不是 true 就抛错。
 * 这一文件的 handler 此前**直接返回裸值/不返回**，于是每次调用都被判成失败：
 * 副作用其实执行了（窗口确实最小化了），错误却被 catch 里一句 console.error
 * 吞掉 —— 界面上什么都不显示，只有控制台看得到。
 * 这类"做了但说失败"的错最伤排查，所以统一在出口包一层。
 */
function ipcOk<T>(data: T): { ok: true; data: T } {
  return { ok: true, data }
}

/** 窗口管理器：管理所有 BrowserWindow 实例 */
export class WindowManager {
  private floatBallWin: BrowserWindow | null = null
  private quickAddWin: BrowserWindow | null = null
  private panelWin: BrowserWindow | null = null
  private kanbanWin: BrowserWindow | null = null
  /** 首次启动引导窗口（只在没问过名字时出现一次） */
  private onboardingWin: BrowserWindow | null = null
  /** 首次见面引导窗口（1.0.64：只在没看过时出现一次，讲"怎么把 AI 接进来"） */
  private welcomeWin: BrowserWindow | null = null
  /** 顶部提醒横幅（1.0.34 起替代 Windows 系统通知：位置与底色要自己说了算） */
  private reminderWin: BrowserWindow | null = null

  /** 当前新增弹窗正在编辑的待办 ID；null 表示新增模式 */
  private quickAddTodoId: string | null = null

  /**
   * 窗口里**此刻加载着**的那条 QuickAdd 路由（hash 那一段）
   *
   * 用来判断"这次请求要不要重新加载"：路由没变就别动它 —— 见 showQuickAdd 里
   * 复用分支的说明（整页重载会把用户填了一半的内容清掉）。
   */
  private quickAddLoadedRoute: string | null = null

  /**
   * 详情抽屉的宽度（会话内记住用户拖的结果）
   *
   * 不进 settings：这是"我习惯把它拉多宽"，跟主题之类的是一类偏好，
   * 但它每次拖动都在变，写进数据库等于每拖一下写一次磁盘。
   * 会话级足够 —— 下次打开应用回到默认宽度是可接受的。
   */
  private quickAddDrawerWidth = DRAWER_DEFAULT_WIDTH

  /**
   * 面板最近一次「因失焦而自动收起」的时刻
   *
   * 只记自动收起，不记用户主动收起。点球时这一下本身会让面板 blur，
   * 若不区分，就会变成"点球 → blur 自动收 → toggle 又开"，永远关不掉。
   * 而用户主动点球收起后 300ms 内再点，应该正常打开 —— 那是有意的连击。
   */
  private panelAutoHiddenAt = 0

  constructor(private settingsRepo: SettingsRepository) {}

  private resolveWindowIcon(): string | Electron.NativeImage {
    const custom = this.settingsRepo.get().appIcon
    if (custom) {
      const img = nativeImage.createFromDataURL(custom)
      if (!img.isEmpty()) return img
    }
    return appIconPath()
  }

  /** 动态应用自定义应用名称与窗口/任务栏图标 */
  applyAppBranding(options: { appName?: string; appIcon?: string | null }): void {
    const displayName = options.appName?.trim() || 'DeskPartner'
    let icon: string | Electron.NativeImage = appIconPath()
    if (options.appIcon) {
      const img = nativeImage.createFromDataURL(options.appIcon)
      if (!img.isEmpty()) icon = img
    }
    const wins = [
      this.kanbanWin,
      this.floatBallWin,
      this.panelWin,
      this.quickAddWin,
      this.onboardingWin,
      this.welcomeWin,
      this.reminderWin
    ]
    for (const win of wins) {
      if (win && !win.isDestroyed()) {
        try {
          win.setIcon(icon as Electron.NativeImage)
          win.setTitle(displayName)
        } catch {
          /* ignore */
        }
      }
    }
  }

  /**
   * 把窗口提到最前
   *
   * 悬浮球是一个铺满整个工作区、且常驻置顶的透明窗口；再加上它设了
   * focusable: false，应用进程几乎不会成为系统前台进程。而 Windows 只在
   * 进程是前台进程时才响应 SetForegroundWindow，所以单纯调用 focus()
   * 会被系统静默忽略——窗口就停在底层，用户必须关掉其它窗口才能看到。
   *
   * 这里改用「临时置顶再还原」的方式：这条路径走的是 SetWindowPos，
   * 不受前台进程限制，能在不改动用户置顶偏好的前提下把窗口提上来。
   * 最后再补一次 focus() 以拿到键盘输入。
   */
  private bringToFront(win: BrowserWindow): void {
    if (!win || win.isDestroyed()) return

    if (win.isMinimized()) win.restore()
    if (!win.isVisible()) win.show()

    // 先临时置顶，再还原成用户设定的层级，借此强制刷新 z 序
    const keepOnTop = win.isAlwaysOnTop()
    win.setAlwaysOnTop(true)
    win.setAlwaysOnTop(keepOnTop)

    win.moveTop()
    win.focus()
  }

  /**
   * 同步看板的层级
   *
   * 悬浮球铺满全屏且常驻置顶，普通窗口按定义永远压在它下面。看板获得焦点时
   * 临时置顶，才能浮到悬浮球之上；一旦失焦立刻还原成普通窗口——否则就变成
   * 用户明确不想要的「永远置顶」。
   *
   * 用户自己勾了置顶（kanbanAlwaysOnTop）时不插手，尊重其选择。
   */
  private syncKanbanTop(): void {
    if (!this.kanbanWin || this.kanbanWin.isDestroyed()) return
    if (this.settingsRepo.get().kanbanAlwaysOnTop) return
    this.kanbanWin.setAlwaysOnTop(this.kanbanWin.isFocused())
  }

  /** 为窗口挂上焦点跟踪，用于维持看板的层级 */
  private trackKanbanFocus(win: BrowserWindow): void {
    win.on('focus', () => this.syncKanbanTop())
    win.on('blur', () => this.syncKanbanTop())
  }

  /** 创建悬浮球窗口 */
  createFloatBallWindow(): BrowserWindow {
    if (this.floatBallWin && !this.floatBallWin.isDestroyed()) {
      return this.floatBallWin
    }

    const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize

    this.floatBallWin = new BrowserWindow({
      width: screenWidth,
      height: screenHeight,
      x: 0,
      y: 0,
      frame: false,
      transparent: true,
      resizable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      hasShadow: false,
      focusable: false,
      icon: this.resolveWindowIcon(),
      webPreferences: {
        preload: path.join(__dirname, '../preload/index.js'),
        nodeIntegration: false,
        contextIsolation: true
      }
    })

    // 点击穿透：透明区域不拦截鼠标事件
    this.floatBallWin.setIgnoreMouseEvents(true, { forward: true })
    this.floatBallWin.setAlwaysOnTop(true, 'floating')

    if (process.env.ELECTRON_RENDERER_URL) {
      this.floatBallWin.loadURL(`${process.env.ELECTRON_RENDERER_URL}#/float-ball`)
    } else {
      this.floatBallWin.loadFile(path.join(__dirname, '../renderer/index.html'), {
        hash: '/float-ball'
      })
    }

    this.floatBallWin.on('closed', () => {
      this.floatBallWin = null
    })

    return this.floatBallWin
  }

  /**
   * 创建/显示悬浮面板（F2-P0-19：能看、能加、能勾）
   *
   * **为什么是独立窗口，而不是悬浮球内部展开的一块 DOM？**
   * 悬浮球窗口设了 `focusable: false`（见 createFloatBallWindow），它拿不到
   * 键盘焦点。在它里面画输入框，光标进不去、打字没反应 —— 这正是
   * "面板能加"这件事的物理前提，所以面板必须是自己能聚焦的窗口。
   *
   * 层级上球在 'floating' 级、面板在普通置顶级，球始终浮在面板之上，
   * 因此面板开着时球依然点得到，"再点一下收起"这个交互才成立。
   */
  showPanel(anchor?: { x: number; y: number }): void {
    // 窄一点才像"面板"：宽了人会往里塞东西，最后变成一个小看板。
    // 内容是"待办数 + 输入框 + 列表 + 完成数"四行，320×420 足够。
    const W = 320
    const H = 420

    if (this.panelWin && !this.panelWin.isDestroyed()) {
      this.positionPanel(this.panelWin, W, H, anchor)
      this.panelWin.show()
      this.bringToFront(this.panelWin)
      return
    }

    this.panelWin = new BrowserWindow({
      width: W,
      height: H,
      frame: false,
      transparent: true,
      resizable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      hasShadow: false,
      // 先隐藏：窗口默认落在屏幕左上角，show 之前会闪一下。
      // 定位完再显式 show()，与看板/设置窗口的做法一致。
      show: false,
      icon: this.resolveWindowIcon(),
      webPreferences: {
        preload: path.join(__dirname, '../preload/index.js'),
        nodeIntegration: false,
        contextIsolation: true
      }
    })

    this.positionPanel(this.panelWin, W, H, anchor)
    this.loadRoute(this.panelWin, '/panel')
    this.panelWin.show()

    /**
     * 失焦即收起
     *
     * 与新增弹窗同一套判断：收起是 hide() 不是 close()，内容原样留着，
     * 所以不存在"填了一半没了"。留着不收的后果更严重 —— 这是一个压在
     * 桌面上的置顶窗口，用户点不到它下面的东西。
     */
    this.panelWin.on('blur', () => {
      this.panelAutoHiddenAt = Date.now()
      this.hidePanel()
    })

    this.panelWin.on('closed', () => {
      this.panelWin = null
    })

    this.bringToFront(this.panelWin)
  }

  /** 隐藏悬浮面板 */
  hidePanel(): void {
    if (this.panelWin && !this.panelWin.isDestroyed() && this.panelWin.isVisible()) {
      this.panelWin.hide()
    }
  }

  /**
   * 开关悬浮面板
   *
   * 单独开一个方法而不是让渲染层自己判断"现在开着吗" —— 渲染层（悬浮球）
   * 是另一个窗口，它读不到面板的可见状态，靠自己记一份布尔值迟早会
   * 跟真实状态对不上（比如面板失焦自动收起了，球这边还以为开着）。
   * 可见性只有主进程说得准，那就让主进程来判。
   */
  togglePanel(anchor?: { x: number; y: number }): void {
    const visible = this.panelWin && !this.panelWin.isDestroyed() && this.panelWin.isVisible()

    if (visible) {
      this.hidePanel()
      return
    }

    // 点球这一下本身可能已经让面板失焦自动收起了（blur 先于 click 到达）。
    // 此时再"开"一次就变成永远关不掉，所以这段时间内不再重新打开。
    if (Date.now() - this.panelAutoHiddenAt < 300) return

    this.showPanel(anchor)
  }

  /** 把面板摆到悬浮球旁边；放不下就往屏幕内收 */
  private positionPanel(
    win: BrowserWindow,
    w: number,
    h: number,
    anchor?: { x: number; y: number }
  ): void {
    const area = screen.getPrimaryDisplay().workArea
    let x: number
    let y: number

    if (anchor) {
      // 球通常贴右缘，优先往左展开；左边放不下再往右
      x = anchor.x - w - 12
      if (x < area.x) x = anchor.x + 60 + 12
      y = anchor.y - 40
    } else {
      x = area.x + area.width - w - 16
      y = area.y + 80
    }

    win.setBounds({
      x: Math.min(Math.max(x, area.x), area.x + area.width - w),
      y: Math.min(Math.max(y, area.y), area.y + area.height - h),
      width: w,
      height: h
    })
  }

  /** 按 hash 路由加载窗口内容 */
  private loadRoute(win: BrowserWindow, route: string): void {
    if (process.env.ELECTRON_RENDERER_URL) {
      win.loadURL(`${process.env.ELECTRON_RENDERER_URL}#${route}`)
    } else {
      win.loadFile(path.join(__dirname, '../renderer/index.html'), { hash: route })
    }
  }

  /**
   * 这条请求对应的 QuickAdd 路由（新增 / 编辑由 hash 区分）
   *
   * 抽出来是因为"要加载的路由"和"窗口里已经加载的路由"必须出自同一份算法 ——
   * 两边各拼一遍，迟早出现"路由没变却判成变了"（每次都重载）或反过来（该换没换）。
   */
  private quickAddRouteOf(
    todoId: string | null,
    status?: string,
    projectId?: string,
    commentId?: string
  ): string {
    const params = new URLSearchParams()
    if (todoId) {
      params.set('todoId', todoId)
    } else {
      // 新增的项目由调用方明确传入，不能从另一个渲染窗口的 store 猜。
      if (status) params.set('status', status)
      if (projectId) params.set('projectId', projectId)
    }
    if (todoId && commentId) params.set('commentId', commentId)
    const qs = params.toString()
    return `/quick-add${qs ? `?${qs}` : ''}`
  }

  /** 加载快速新增窗口的内容（新增 / 编辑由 hash 区分） */
  private loadQuickAdd(
    win: BrowserWindow,
    todoId: string | null,
    status?: string,
    projectId?: string,
    commentId?: string
  ): void {
    const route = this.quickAddRouteOf(todoId, status, projectId, commentId)
    this.quickAddLoadedRoute = route
    this.loadRoute(win, route)
  }

  /**
   * 这个弹窗当前该长成什么样
   *
   * **两种形态刻意不一样，不是为了好看：**
   *
   * - 新增 → 居中的小卡片。速记发生在"脑子里刚冒出来"的那一刻，
   *   要的是最小的打扰，做完就消失。
   * - 编辑/详情 → 右侧抽屉（贴边、占满高度、可拖宽）。
   *   看详情时人往往还要对照着看板上的其它条目来判断这条是什么、该归到哪。
   *   居中弹窗一开就把上下文全盖住，等于逼人凭记忆操作。
   *
   * 抽屉也不做成中等大小的居中面板 —— 那样遮挡面积一样大，只是位置不同。
   * 贴边 + 全高的意义是"划出一块专属区域"，剩下的看板仍然是完整可见的。
   */
  private quickAddBounds(todoId: string | null): {
    x: number
    y: number
    width: number
    height: number
  } {
    const area = screen.getPrimaryDisplay().workArea

    if (!todoId) {
      return {
        width: 400,
        // 预留详细版（描述 + 优先级 + 截止时间）展开后的高度；
        // 窗口是透明的，多余区域不可见，弹窗始终垂直居中
        height: 380,
        x: Math.floor(area.x + area.width / 2 - 200),
        y: area.y + 100
      }
    }

    // 上限要受屏幕宽度约束：外接小屏时也按 1000 排会伸到屏幕外
    const max = Math.min(DRAWER_MAX_WIDTH, area.width - 120)
    const width = Math.min(Math.max(this.quickAddDrawerWidth, DRAWER_MIN_WIDTH), max)

    return {
      width,
      height: area.height - 32,
      // 从右边往左长：拖宽时窗口向右"吃掉"空间，内容原地不动，
      // 反过来（左边固定）会让表单每次都跟着往左挪
      x: area.x + area.width - width - 16,
      y: area.y + 16
    }
  }

  /** 按当前模式重摆一次窗口（复用窗口时形态可能已经变了） */
  private applyQuickAddShape(
    win: BrowserWindow,
    bounds: { x: number; y: number; width: number; height: number }
  ): void {
    const cur = win.getBounds()
    if (
      cur.x === bounds.x &&
      cur.y === bounds.y &&
      cur.width === bounds.width &&
      cur.height === bounds.height
    ) {
      return
    }
    win.setBounds(bounds)
  }

  /** 创建/显示快速新增窗口 */
  showQuickAdd(
    todoId?: string,
    status?: string,
    projectId?: string,
    commentId?: string
  ): void {
    const targetId = todoId ?? null

    // 已存在就复用：创建 BrowserWindow 并加载整个应用有明显开销，
    // 用户能感觉到"点开要等一下"。
    if (this.quickAddWin && !this.quickAddWin.isDestroyed()) {
      this.quickAddTodoId = targetId
      const win = this.quickAddWin
      /**
       * 同一条再打开：**不重新加载**（卡 6a595ad0）
       *
       * 这里原先是无条件 loadQuickAdd，注释写的是"顺带清掉上一次残留的表单状态"。
       * 但 2026-10-22 离屏实测（Electron 33.4.11）：
       * `loadFile`/`loadURL` 打到与当前**完全相同**的 URL 也会**整页重载** ——
       * 于是"在详情里写了一半、点到看板上、再点回这条"会把输入框里的内容整段清掉，
       * 而渲染层"隐藏不销毁、内容原样留着"的设计前提（QuickAddForm 里那条注释）
       * 根本不成立：页面每次都被重建了。
       *
       * 所以按路由判断：路由变了才加载 —— 那是真的换了另一条 / 换成新增，
       * 渲染层没有任何东西该留（换了目标还留着上一条的草稿才是 bug）；
       * 路由没变就把这份页面原样留着，用户填到哪儿就还在哪儿。
       *
       * 名字里的"清掉残留表单状态"改由渲染层负责：它自己知道用户改没改过
       * （见 QuickAddForm 的 baseline 与 unsaved-drafts）。
       */
      if (
        this.quickAddRouteOf(targetId, status, projectId, commentId) !== this.quickAddLoadedRoute
      ) {
        this.loadQuickAdd(win, targetId, status, projectId, commentId)
      }
      // 形态可能变了：上一轮是新增（居中卡片），这一轮可能双击了某张卡片要看详情（右侧抽屉）。
      // 复用同一个窗口不代表形态可以沿用，这里必须按当前模式重摆一次。
      this.applyQuickAddShape(win, this.quickAddBounds(targetId))
      win.show()
      this.bringToFront(win)
      return
    }

    this.quickAddTodoId = targetId

    this.quickAddWin = new BrowserWindow({
      ...this.quickAddBounds(targetId),
      frame: false,
      transparent: true,
      resizable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      hasShadow: false,
      icon: this.resolveWindowIcon(),
      webPreferences: {
        preload: path.join(__dirname, '../preload/index.js'),
        nodeIntegration: false,
        contextIsolation: true
      }
    })

    this.loadQuickAdd(this.quickAddWin, targetId, status, projectId, commentId)

    /**
     * 失焦是否自动关闭，交给渲染层决定
     *
     * 主进程只知道窗口失焦了，不知道用户填没填东西。而"填了一半点到别处
     * 就没了"是真正让人恼火的场景，所以由渲染层根据表单是否有内容来判断：
     * 空表单才自动关（保住速记的手感），有内容就不关。
     */
    this.quickAddWin.on('closed', () => {
      this.quickAddWin = null
      this.quickAddTodoId = null
      // 窗口没了，记的路由也要清：留着会让"下一个窗口的首屏"被误判成"同一条"
      this.quickAddLoadedRoute = null
    })

    this.bringToFront(this.quickAddWin)
  }

  /**
   * 隐藏快速新增窗口
   *
   * 用 hide() 而不是 close()：关闭即销毁，下次新增要重新创建一个
   * BrowserWindow 并重新加载整个应用，用户能明显感到慢。
   * 复用同一个窗口，后续打开只需重新 loadURL。
   */
  hideQuickAdd(): void {
    if (this.quickAddWin && !this.quickAddWin.isDestroyed()) {
      this.quickAddWin.hide()
    }
  }

  /**
   * 按内容实际高度调整快速新增窗口
   *
   * 为什么不能用一个"够大的固定高度"：
   * 这个窗口是**透明**的，但透明窗口的整个矩形区域照样接收鼠标事件，
   * 多出来的空白区会把底下的看板挡住（看不见却点不到，最恼人）。
   * 所以高度必须贴着内容走 —— 少一行就是少一行的遮挡。
   *
   * 内容由渲染层测量（它才知道展开/折叠后的真实高度），这里只负责
   * 夹到屏幕可用范围内并保持窗口不越界。
   */
  resizeQuickAdd(height: number, width?: number): void {
    const win = this.quickAddWin
    if (!win || win.isDestroyed()) return
    if (!Number.isFinite(height)) return

    /**
     * 抽屉模式：宽度由渲染层的拖动条给出，高度恒等于可用高度（不留空白）。
     * 宽度一变就要连带改 x（右边贴边），所以整块 bounds 一起算。
     */
    if (this.quickAddTodoId && Number.isFinite(width as number)) {
      this.quickAddDrawerWidth = Math.round(width as number)
      win.setBounds(this.quickAddBounds(this.quickAddTodoId))
      return
    }

    const { height: screenH } = screen.getPrimaryDisplay().workAreaSize
    // 上下各留 24px：留出圆角与阴影，同时避免贴死屏幕边缘
    const maxH = Math.max(200, screenH - 48)
    const next = Math.min(Math.max(Math.round(height) + 24, 160), maxH)

    const bounds = win.getBounds()
    if (bounds.height === next) return

    // 高度变了要重新校验下边界：否则展开详情后窗口底部会伸到屏幕外
    let y = bounds.y
    if (y + next > screenH) {
      y = Math.max(12, screenH - next - 12)
    }

    win.setBounds({ x: bounds.x, y, width: bounds.width, height: next })
  }

  /**
   * 创建/显示看板窗口
   *
   * @param view 1.0.48：主窗口成为多视图容器（看板/通知/统计/设置/用户），
   *   带 view 时落到对应内容区视图。窗口已存在时通过 hash 通知渲染层切换
   *   （同文档导航不重挂载，渲染层监听 hashchange，与设置深链同一个坑）。
   */
  showKanban(view?: string): void {
    if (this.kanbanWin && !this.kanbanWin.isDestroyed()) {
      if (view) {
        this.loadRoute(this.kanbanWin, `/kanban?view=${encodeURIComponent(view)}`)
      }
      this.kanbanWin.show()
      this.bringToFront(this.kanbanWin)
      this.syncKanbanTop()
      return
    }

    const settings = this.settingsRepo.get()
    const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize

    // 恢复保存的窗口边界
    const defaultBounds: WindowBounds = {
      x: Math.floor(screenWidth / 2 - 500),
      y: Math.floor(screenHeight / 2 - 350),
      width: 1000,
      height: 700
    }
    const bounds = settings.kanbanWindowBounds ?? defaultBounds

    this.kanbanWin = new BrowserWindow({
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y,
      frame: false,
      transparent: true,
      resizable: true,
      alwaysOnTop: settings.kanbanAlwaysOnTop,
      hasShadow: false,
      minWidth: 800,
      minHeight: 500,
      icon: this.resolveWindowIcon(),
      webPreferences: {
        preload: path.join(__dirname, '../preload/index.js'),
        nodeIntegration: false,
        contextIsolation: true
      }
    })

    this.loadRoute(this.kanbanWin, view ? `/kanban?view=${encodeURIComponent(view)}` : '/kanban')

    // 记录窗口位置变化
    this.kanbanWin.on('moved', () => this.saveKanbanBounds())
    this.kanbanWin.on('resized', () => this.saveKanbanBounds())

    // 焦点变化时同步层级：聚焦才浮到悬浮球之上，失焦立刻还原
    this.trackKanbanFocus(this.kanbanWin)

    /**
     * 最大化状态变化广播（1.0.48）
     *
     * 按钮图标此前只靠渲染层自己记的 useState 翻面 —— 而双击标题栏、
     * Win+↑ 这些路径根本不经过按钮，图标就停在相反的状态：
     * 窗口已经最大化了，按钮还显示"最大化"。
     * 所以状态由窗口自己说了算，变化即推送。
     */
    this.kanbanWin.on('maximize', () => {
      this.kanbanWin?.webContents.send('event:windowState', { maximized: true })
    })
    this.kanbanWin.on('unmaximize', () => {
      this.kanbanWin?.webContents.send('event:windowState', { maximized: false })
    })

    this.kanbanWin.on('closed', () => {
      this.kanbanWin = null
    })

    this.bringToFront(this.kanbanWin)
    this.syncKanbanTop()
  }

  /** 隐藏看板窗口 */
  hideKanban(): void {
    if (this.kanbanWin && !this.kanbanWin.isDestroyed()) {
      this.kanbanWin.hide()
    }
  }

  /** 应用看板置顶设置；窗口未打开时无需处理，下次创建会读取最新设置 */
  applyKanbanAlwaysOnTop(alwaysOnTop: boolean): void {
    if (!this.kanbanWin || this.kanbanWin.isDestroyed()) return
    this.kanbanWin.setAlwaysOnTop(alwaysOnTop)
    if (!alwaysOnTop) this.syncKanbanTop()
  }

  /**
   * 设置入口（1.0.48 起收编为主窗口内容区视图，不再开独立窗口）。
   *
   * @param section 历史深链：`agent-approval` 映射到用户页（审批语义已迁），
   *   其余落到设置视图。通道名保留（托盘/悬浮球/横幅都在调），
   *   实现从"开设置窗"改为"把主窗口带到对应视图"。
   */
  showSettings(section?: string): void {
    this.showKanban(section === 'agent-approval' ? 'user' : 'settings')
  }

  /** 使用数据入口（1.0.48 起收编为主窗口统计视图） */
  showStats(): void {
    this.showKanban('stats')
  }

  /**
   * 首次启动引导：问一次人的名字（v15：human 也要有身份名）
   *
   * 只在 settings.humanNameAsked === false 时由 index.ts 唤起一次。
   * 刻意做成**独立小窗口**而不是塞进设置页：名字这种东西没人会主动去找着改，
   * 而它决定了动态里所有记录的主语读起来对不对 —— 得在第一次见面时拦一下。
   * 不填也能过（视为"就叫我『我』"），所以它不是门槛，可以放心弹。
   */
  showOnboarding(): void {
    if (this.onboardingWin && !this.onboardingWin.isDestroyed()) {
      this.bringToFront(this.onboardingWin)
      return
    }

    const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize

    this.onboardingWin = new BrowserWindow({
      width: 440,
      height: 380,
      x: Math.floor(screenWidth / 2 - 220),
      y: Math.floor(screenHeight / 2 - 190),
      frame: false,
      transparent: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      alwaysOnTop: true,
      hasShadow: false,
      icon: this.resolveWindowIcon(),
      webPreferences: {
        preload: path.join(__dirname, '../preload/index.js'),
        nodeIntegration: false,
        contextIsolation: true
      }
    })

    this.loadRoute(this.onboardingWin, '/onboarding')

    this.onboardingWin.on('closed', () => {
      this.onboardingWin = null

      /**
       * 问完名字，紧接着接上「首次见面」引导（1.0.64）。
       *
       * 为什么挂在这里、而不是在 index.ts 里两个都直接 show：
       * 两个都是 alwaysOnTop 的居中弹窗，同时弹会**叠在一起**（用户只看得见上面那个，
       * 关掉一个又冒出一个，像是弹了两遍）。串行才是一次一个。
       *
       * 为什么判断放在这一刻再读一次 settings：
       * 用户可能在问名字那一步就顺手改了什么，也可能 humanNameAsked 本来就是 true
       * （没弹名字窗）—— 那时这条路根本不会走到，由 index.ts 直接唤起（见 index.ts 第 11 步）。
       */
      if (!this.settingsRepo.get().welcomeShown) {
        this.showWelcome()
      }
    })

    this.bringToFront(this.onboardingWin)
  }

  /**
   * 首次见面引导：装完之后我拿它干嘛？（1.0.64）
   *
   * 只在 settings.welcomeShown === false 时由 index.ts 或 showOnboarding 的 closed 回调唤起一次。
   * 它回答的是新用户的第一个问题：**下载装好之后，这东西怎么用、怎么把 AI 接进来。**
   *
   * 刻意做成独立小窗口而不是塞进设置页：接入说明这种东西没人会主动去找着看，
   * 而它恰好是产品最不一样的地方 —— 得在第一次见面时递到手上。
   * 但它**不是门槛**：不想看就点「知道了」，关掉即不再弹（入口常驻用户页）。
   */
  showWelcome(): void {
    if (this.welcomeWin && !this.welcomeWin.isDestroyed()) {
      this.bringToFront(this.welcomeWin)
      return
    }

    const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize

    this.welcomeWin = new BrowserWindow({
      width: 480,
      height: 420,
      x: Math.floor(screenWidth / 2 - 240),
      y: Math.floor(screenHeight / 2 - 210),
      frame: false,
      transparent: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      alwaysOnTop: true,
      hasShadow: false,
      icon: this.resolveWindowIcon(),
      webPreferences: {
        preload: path.join(__dirname, '../preload/index.js'),
        nodeIntegration: false,
        contextIsolation: true
      }
    })

    this.loadRoute(this.welcomeWin, '/welcome')

    this.welcomeWin.on('closed', () => {
      this.welcomeWin = null
    })

    this.bringToFront(this.welcomeWin)
  }

  /**
   * 顶部提醒横幅（替代系统通知）
   *
   * 为什么自绘：Windows 系统通知固定从右下角弹出、底色是系统主题色，
   * 代码改不了；主用户要求提醒从**屏幕上方**弹出、底色用**红色**（警示感）。
   *
   * focusable: false —— 提醒是"扫一眼"不是"抢输入"，弹出时不能把
   * 用户正在打的字打断（焦点被夺走是最恼人的打扰）。
   * 层级用 'screen-saver'：比悬浮球的 'floating' 更高，保证盖得住。
   */
  showReminderBanner(payload: {
    todoId: string
    title: string
    categoryName: string
    /**
     * 提醒类型（1.0.37）：
     * - 'reminder'（默认）待办到点提醒 → 「去处理」打开看板
     * - 'grant' agent 的授权申请在等人点头 → 「去审批」直达设置页那一屏
     *
     * 两种都是"需要你行动"的事，共用一条通道：位置（屏幕上方）与
     * 警示配色（红底白字）本就该一致，差别只在按下去之后去哪。
     */
    kind?: 'reminder' | 'grant'
    /**
     * 第二行说明（1.0.117）：授权横幅把"对谁动手"从标题里分出来。
     * 标题只留"谁想干什么、等你点头"，目标摘要（`已删除/修改 哪一条`）放这一行 ——
     * 标题被挤短时，人还能从头部的发起方 + 这一行的目标名对上号。
     */
    detail?: string
  }): void {
    const W = REMINDER_BANNER_W
    const H = REMINDER_BANNER_MIN_H
    const area = screen.getPrimaryDisplay().workArea

    const params = new URLSearchParams({
      todoId: payload.todoId,
      title: payload.title,
      ...(payload.categoryName ? { category: payload.categoryName } : {}),
      ...(payload.detail ? { detail: payload.detail } : {}),
      ...(payload.kind === 'grant' ? { type: 'grant' } : {})
    })

    if (this.reminderWin && !this.reminderWin.isDestroyed()) {
      this.loadRoute(this.reminderWin, `/reminder-banner?${params.toString()}`)
      /**
       * 高度先还回下限再等渲染层量（1.0.117）。
       * 上一条横幅是五按钮的授权申请、这一条是两行的到点提醒时，
       * 留着上一次的高度就会挂一条空白在半空里 —— 透明窗口的空白也吃鼠标，
       * 底下那个窗口就点不到了（与快速新增同一个坑，见 resizeQuickAdd）。
       */
      this.fitReminderBannerTo(REMINDER_BANNER_MIN_H, area)
      this.reminderWin.setPosition(Math.floor(area.x + area.width / 2 - W / 2), area.y + 12)
      this.reminderWin.show()
      return
    }

    this.reminderWin = new BrowserWindow({
      width: W,
      height: H,
      x: Math.floor(area.x + area.width / 2 - W / 2),
      y: area.y + 12,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      hasShadow: false,
      focusable: false,
      show: false,
      icon: this.resolveWindowIcon(),
      webPreferences: {
        preload: path.join(__dirname, '../preload/index.js'),
        nodeIntegration: false,
        contextIsolation: true
      }
    })
    this.reminderWin.setAlwaysOnTop(true, 'screen-saver')

    this.loadRoute(this.reminderWin, `/reminder-banner?${params.toString()}`)

    this.reminderWin.on('closed', () => {
      this.reminderWin = null
    })

    this.reminderWin.showInactive()
  }

  /**
   * 按渲染层量出的内容高度调整横幅窗口（1.0.117，卡 `21f171f1`）
   *
   * 只动这条横幅自己（`BrowserWindow.fromWebContents`），宽度、x、y 都不动 ——
   * 横幅贴着屏幕上方居中，长高要往下长，往上长会顶出屏幕。
   * 高度夹到 [104, 360]：下限防"缩成一条缝"，上限防"一条横幅占半屏"。
   */
  fitReminderBanner(height: number): void {
    this.fitReminderBannerTo(height, screen.getPrimaryDisplay().workArea)
  }

  private fitReminderBannerTo(height: number, area: Electron.Rectangle): void {
    const win = this.reminderWin
    if (!win || win.isDestroyed()) return
    if (!Number.isFinite(height)) return
    // 上下限与边距都在 lib/banner-size 里（那里能单测，这里摸 electron 不好测）
    const next = clampReminderBannerHeight(height, area.height)
    const bounds = win.getBounds()
    if (bounds.height === next) return
    win.setBounds({ x: bounds.x, y: bounds.y, width: bounds.width, height: next })
  }

  /** 隐藏提醒横幅（用户点了「去处理」/「知道了」之后） */
  hideReminderBanner(): void {
    if (this.reminderWin && !this.reminderWin.isDestroyed() && this.reminderWin.isVisible()) {
      this.reminderWin.hide()
    }
  }

  /** 保存窗口位置/边界到设置 */
  saveWindowPosition(windowName: string, bounds: WindowBounds | WindowPosition): void {
    if (windowName === 'floatBall') {
      this.settingsRepo.update({
        floatBallPosition: bounds as WindowPosition
      })
    } else if (windowName === 'kanban') {
      this.settingsRepo.update({
        kanbanWindowBounds: bounds as WindowBounds
      })
    }
  }

  /** 保存看板窗口边界 */
  private saveKanbanBounds(): void {
    if (!this.kanbanWin || this.kanbanWin.isDestroyed()) return
    const bounds = this.kanbanWin.getBounds()
    this.settingsRepo.update({
      kanbanWindowBounds: bounds as WindowBounds
    })
  }

  /** 获取所有窗口实例 */
  getWindows() {
    return {
      floatBall: this.floatBallWin,
      quickAdd: this.quickAddWin,
      panel: this.panelWin,
      kanban: this.kanbanWin
    }
  }

  /** 注册窗口控制相关的 IPC handler */
  setupWindowIPC(): void {
    // 渲染层可能不带参数调用（如悬浮球单击新增），这里必须容错，
    // 否则解构 undefined 会抛错，IPC 变成一次静默失败
    ipcMain.handle(
      'window:showQuickAdd',
      (
        _e,
        payload?: { todoId?: string; status?: string; projectId?: string; commentId?: string }
      ) => {
        this.showQuickAdd(
          payload?.todoId,
          payload?.status,
          payload?.projectId,
          payload?.commentId
        )
        return ipcOk(undefined)
      }
    )

    ipcMain.handle('window:hideQuickAdd', () => {
      this.hideQuickAdd()
      return ipcOk(undefined)
    })

    ipcMain.handle(
      'window:resizeQuickAdd',
      (_e, payload: { height: number; width?: number }) => {
        this.resizeQuickAdd(payload?.height, payload?.width)
        return ipcOk(undefined)
      }
    )

    ipcMain.handle('window:hideKanban', () => {
      this.hideKanban()
      return ipcOk(undefined)
    })

    ipcMain.handle(
      'window:togglePanel',
      (_e, payload?: { anchor?: { x: number; y: number } }) => {
        this.togglePanel(payload?.anchor)
        return ipcOk(undefined)
      }
    )

    ipcMain.handle('window:showPanel', (_e, payload?: { anchor?: { x: number; y: number } }) => {
      this.showPanel(payload?.anchor)
      return ipcOk(undefined)
    })

    ipcMain.handle('window:hidePanel', () => {
      this.hidePanel()
      return ipcOk(undefined)
    })

    ipcMain.handle('window:showKanban', (_e, input?: { view?: string }) => {
      this.showKanban(input?.view)
      return ipcOk(undefined)
    })

    ipcMain.handle('window:showSettings', (_e, input?: { section?: string }) => {
      this.showSettings(input?.section)
      return ipcOk(undefined)
    })

    ipcMain.handle('window:showStats', () => {
      this.showStats()
      return ipcOk(undefined)
    })

    ipcMain.handle('window:hideReminderBanner', () => {
      this.hideReminderBanner()
      return ipcOk(undefined)
    })

    /**
     * 横幅自己量出来汇报高度（1.0.117，卡 `21f171f1`）。
     * 不接受"猜一个够大的固定高度"：透明窗口的空白区照样吃鼠标，
     * 多出来的那一条会在没人察觉的情况下挡住下面的窗口。
     */
    ipcMain.handle('window:fitReminderBanner', (_e, { height }: { height: number }) => {
      this.fitReminderBanner(height)
      return ipcOk(undefined)
    })

    ipcMain.handle(
      'window:savePosition',
      (
        _e,
        { window: windowName, bounds }: { window: string; bounds: WindowBounds | WindowPosition }
      ) => {
        this.saveWindowPosition(windowName, bounds)
        return ipcOk(undefined)
      }
    )

    ipcMain.handle('window:setIgnoreMouseEvents', (_e, { ignore }: { ignore: boolean }) => {
      const win = BrowserWindow.fromWebContents(_e.sender)
      if (win) {
        win.setIgnoreMouseEvents(ignore, { forward: true })
      }
      return ipcOk(undefined)
    })

    // 无边框窗口的自定义控制按钮，作用于发起调用的窗口自身。
    // 回传最新的最大化状态：让按钮以窗口为准，而不是自己记的那一份
    ipcMain.handle(
      'window:control',
      (_e, { action }: { action: 'minimize' | 'toggleMaximize' | 'close' }) => {
        const win = BrowserWindow.fromWebContents(_e.sender)
        if (!win || win.isDestroyed()) return ipcOk({ maximized: false })

        switch (action) {
          case 'minimize':
            win.minimize()
            break
          case 'toggleMaximize':
            if (win.isMaximized()) {
              win.unmaximize()
            } else {
              win.maximize()
            }
            break
          case 'close':
            win.close()
            break
        }
        return ipcOk({ maximized: win.isMaximized() })
      }
    )

    /** 当前窗口是否最大化（按钮挂载时同步一次） */
    ipcMain.handle('window:state', (_e) => {
      const win = BrowserWindow.fromWebContents(_e.sender)
      return ipcOk({ maximized: !!win && !win.isDestroyed() && win.isMaximized() })
    })
  }

  /** 关闭所有窗口 */
  closeAll(): void {
    const windows = [
      this.kanbanWin,
      this.panelWin,
      this.quickAddWin,
      this.reminderWin,
      this.floatBallWin
    ]
    for (const win of windows) {
      if (win && !win.isDestroyed()) {
        win.close()
      }
    }
    this.floatBallWin = null
    this.quickAddWin = null
    this.kanbanWin = null
    this.reminderWin = null
  }
}
