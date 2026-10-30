import { app, BrowserWindow, dialog, ipcMain, session } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  initializeDatabase,
  closeDatabase,
  captureInitialUserDataDir,
  readConfiguredDataDir,
  setActiveDataDir
} from './database/index'
import { TodoRepository } from './database/todo.repository'
import { CategoryRepository } from './database/category.repository'
import { ProjectRepository } from './database/project.repository'
import { ReleaseRepository } from './database/release.repository'
import { MemoRepository } from './database/memo.repository'
import { SettingsRepository } from './database/settings.repository'
import { AgentRepository } from './database/agent.repository'
import { CommentRepository } from './database/comment.repository'
import { NotificationRepository } from './database/notification.repository'
import { ReminderReceiptRepository } from './database/reminder-receipt.repository'
import { RulesRepository } from './database/rules.repository'
import { ProtocolRepository } from './database/protocol.repository'
import { ProfileRepository } from './database/profile.repository'
import { BackupService } from './services/backup.service'
import { REG_EXPAND_SZ, REG_SZ } from './lib/user-path'
import { TimerService } from './services/timer.service'
import { NotificationService } from './services/notification.service'
import { WindowManager } from './windows'
import { TrayService } from './tray'
import { ShortcutService } from './shortcuts'
import { AutoLaunchService } from './auto-launch'
import { autoUpdateService } from './services/auto-update.service'
import { TelemetryService } from './services/telemetry.service'
import { ChangeBroadcastService } from './services/change-broadcast.service'
import { CliServerService } from './services/cli-server.service'
import { EventsRepository } from './database/events.repository'
import { LOCAL_ACTOR_ID } from './ipc'
import { requestSingleInstanceLock, onSecondInstance } from './utils/single-instance'
import { registerIPC } from './ipc'
import { extractCliArgs, runCli } from './cli/run'
import { checkIsolation, isolationErrorMessage } from './utils/data-dir'
import { getDatabasePath } from './database/index'
import { DB_VERSION } from '../renderer/lib/constants'
import type { AppSettings } from '../renderer/types/settings'

/**
 * CLI 模式检测：DeskPartner.exe --cli <命令>
 *
 * 命令行复用程序本体运行（better-sqlite3 是按 Electron 运行时编译的，
 * 独立的 Node 程序加载不了），因此也就不该再受单实例锁约束 ——
 * 否则应用已经在跑的时候，命令行会直接被锁挡在门外。
 */
const cliArgs = extractCliArgs(process.argv)
const isCliMode = cliArgs !== null

if (isCliMode) {
  // CLI 的契约是 stdout 只承载数据（Agent 要按 JSON 解析）。
  // 主进程平时的 console.log 会走 stdout，一次数据库初始化日志
  // 就会把 JSON 顶掉，Agent 直接解析失败。这里统一改道 stderr。
  const writeErr = (...args: unknown[]) =>
    process.stderr.write(args.map((a) => String(a)).join(' ') + '\n')
  console.log = writeErr
  console.info = writeErr
}

/**
 * 数据目录可覆盖（1.0.46）：`DESKPARTNER_DATA_DIR`
 *
 * 为什么必须有这个入口（Bob 2026-09-22 演练事故）：
 * 此前数据目录由 `app.getPath('userData')` 唯一决定，没有任何覆盖手段 ——
 * 于是"导出 → 导入"这类**必然具有破坏性**的演练只能作用在真实库上，
 * 一次演练就把 199 条待办、2 个项目、2 个 agent 身份全改坏了。
 * 不是操作者不小心，是他没有别的选项。
 *
 * 这也是**验证导入修复本身的前提**：没有隔离环境，
 * "导入后字段是否完整"这件事只能在真实数据上验，等于每验一次毁一次。
 *
 * ⚠️ 必须在 `app.whenReady()` 之前调用 `app.setPath`，之后就无效了；
 * 也必须在数据库初始化之前 —— 见本文件里 `initializeDatabase()` 的位置。
 * 放在这里（模块顶层）是为了同时覆盖 GUI 与 CLI 两条通道：
 * 两者都会走到本文件。
 */
captureInitialUserDataDir()
const dataDirOverride = process.env.DESKPARTNER_DATA_DIR
if (dataDirOverride !== undefined) {
  try {
    const resolvedOverride = path.resolve(dataDirOverride)
    fs.mkdirSync(resolvedOverride, { recursive: true })
    app.setPath('userData', resolvedOverride)
    setActiveDataDir(resolvedOverride)
    // 静默不得：跑在隔离目录里必须让人看得见，否则会误以为动的是真实数据
    console.log(`[Data] 数据目录已被 DESKPARTNER_DATA_DIR 覆盖: ${resolvedOverride}`)
  } catch (err) {
    console.error(
      `[Data] DESKPARTNER_DATA_DIR 设置失败: ${err instanceof Error ? err.message : String(err)}`
    )
  }
} else {
  const configuredDir = readConfiguredDataDir()
  if (configuredDir) {
    try {
      fs.mkdirSync(configuredDir, { recursive: true })
      app.setPath('userData', configuredDir)
      setActiveDataDir(configuredDir)
      console.log(`[Data] 使用自定义数据存储目录: ${configuredDir}`)
    } catch (err) {
      console.error(
        `[Data] 自定义数据存储目录加载失败，回退默认目录: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }
}

/**
 * 防呆：**设了隔离开关却没生效 → 拒绝运行**（1.0.49，主用户拍板）
 *
 * 上面的 try/catch 只负责"尽力隔离"，而"尽力"这个措辞本身就是问题 ——
 * 隔离失败时退回真实库继续跑，等于把最贵的错误（改坏真实数据）
 * 静默执行掉。2026-09-22 演练事故正是这个形状：操作者以为在隔离环境里。
 *
 * 所以判据改成"要么真的隔离，要么别跑"。检查放在 `app.setPath` 之后
 * （拿得到实际 userData）、`initializeDatabase()` 之前（还没碰任何数据）。
 *
 * 注意 `DESKPARTNER_DATA_DIR=` 空值也算"设了"：没人会故意 export 一个
 * 空值来表达"就用真实库"，空值几乎必然是变量没展开。
 */
const isolation = checkIsolation(dataDirOverride, app.getPath('userData'))
if (!isolation.ok) {
  const msg = isolationErrorMessage(isolation)
  console.error(`[Data] ${msg}`)
  /**
   * CLI 模式：不弹窗（无人值守会挂死），直接退出并把话写在 stderr。
   * 退出码用 4（守卫拒绝）：语义是"重试无用，先修环境"，
   * 与门禁拒绝同一档，调用方一看就知道不该重试。
   *
   * 必须 `app.exit` 而不是 `process.exitCode = 4` —— 后者只是给最终退出
   * 留个标记，程序会继续往下走到 `initializeDatabase()`，
   * 那就又把真实库打开了，防呆等于没做。
   */
  if (isCliMode) {
    app.exit(4)
  } else {
    dialog.showErrorBox('DeskPartner 拒绝启动', msg)
    app.exit(4)
  }
}

// ── 单实例检查（CLI 模式跳过） ──
//
// 注意：如果已经装了一份打包版并在运行，它会持有这个锁，
// 这里启动的开发实例会直接退出 —— 表现为"应用一起来就没了"。
// 排查这类现象时先确认有没有另一个实例在跑。
const gotTheLock = isCliMode ? true : requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
}

// 服务实例
let todoRepo: TodoRepository
let categoryRepo: CategoryRepository
let projectRepo: ProjectRepository
let releaseRepo: ReleaseRepository
let memoRepo: MemoRepository
let settingsRepo: SettingsRepository
let agentRepo: AgentRepository
/**
 * 命令层用到的其余仓储（1.0.112，卡 `69788c32`）
 *
 * 它们此前是在命令体里各自 `new` 的（24 处）—— 那样"这条命令读写哪个实例"
 * 散在 24 个地方，而 `CliDeps` 里塞进去的实例根本收不到调用。现在**只有这里
 * 与 `ipc.ts` 的批准回放**构造它们，命令层一律读 `ctx.deps.*`。
 */
let commentRepo: CommentRepository
let notificationRepo: NotificationRepository
let reminderReceiptRepo: ReminderReceiptRepository
let rulesRepo: RulesRepository
let protocolRepo: ProtocolRepository
let profileRepo: ProfileRepository
let backupService: BackupService
let timerService: TimerService
let notificationService: NotificationService
let windowManager: WindowManager
let trayService: TrayService
let shortcutService: ShortcutService
let autoLaunchService: AutoLaunchService
let telemetryService: TelemetryService
let changeBroadcast: ChangeBroadcastService
let cliServer: CliServerService

/** 当前真正注册成功的全局快捷键；注册新值失败时用于回滚，避免界面与实际不一致 */
let activeShortcut: string | null = null

/**
 * 进程启动时刻
 *
 * 必须在模块加载时就取：一次 CLI 调用的耗时大头（Electron 启动、数据库初始化）
 * 都发生在后面 whenReady 之前，等到那时再计时就已经晚了。
 */
const APP_STARTED_AT = Date.now()

/**
 * 全局禁止窗口自己开新窗口（1.0.40）
 *
 * 挂在这一层而不是逐个 `new BrowserWindow` 去配：现在有 8 个窗口，
 * 将来还会加 —— 挂在 `web-contents-created` 上是一次覆盖全部（含未来新增），
 * 不会因为"新加窗口时忘了配"而漏掉一处。
 *
 * 为什么必须 deny：渲染层里任何一句 `window.open(...)` 或 `<a target="_blank">`
 * 都会凭空开出一个**没有 preload、也不受我们控制**的窗口；
 * 配合将来可能加入的外链能力，就是一条绕过窗口管理的路子。
 * 现在没有外链需求，一律拒绝即可 —— 真要开外链时，改由主进程
 * `shell.openExternal` 走系统浏览器白名单，而不是放开这里。
 *
 * 注：windows.ts 里那个 `shell` 死导入正是"外链能力没实现"的痕迹，
 * 已一并移除；将来实现时记得**同时**补白名单校验。
 */
/**
 * 把 CLI 的寻址方式写进用户环境变量（1.0.42，Bob 8bf64514「寻址三件套」第二件）
 *
 * 它实测的代价：**安装目录两周搬了两次家**（测试应用 → TestApps → 测试应用），
 * 它技能文件里硬写的绝对路径两次失效、全靠人提醒才重取。
 * 已接入的 agent 越多，「rule 行与技能里硬写绝对路径」的债越贵。
 *
 * ⚠️ 与它的原始建议有**两处刻意的调整**，理由都写在这里：
 *
 * 1. **不在 NSIS 安装器里写，改在 Electron 启动时写。**
 *    它建议"装的时候写入用户级环境变量"，那是安装器的活。而我在 1.0.39
 *    已经为「给 PATH 加目录」在 NSIS 上连撞 5 次错误（`Function` 不能定义在
 *    `Section` 里那条是死结），最后摘下来没用。同一件事改在应用层做：
 *    可测试、可回滚、不依赖安装器脚本能力，也不用再碰那堆坑。
 *
 * 2. **只设 DESKPARTNER_CLI，不碰 PATH。**
 *    给 PATH 追加目录要「读回来 → 拼接 → 写回去」，而 `HKCU\Environment` 的
 *    Path 是 REG_EXPAND_SZ，`reg query` 读回来会把 `%USERPROFILE%` 之类
 *    **展开**，再写回去就等于把用户自己的变量语义固化了 —— 那是在改别人的东西。
 *    而 DESKPARTNER_CLI 是**新变量、纯赋值**，没有读改写风险。
 *    更关键的是：环境变量已经解决了核心痛点（"每次都要拼绝对路径"），
 *    PATH 只是"少敲 `dp` 两个字符"的便利，为它冒改坏用户 PATH 的风险不划算。
 *
 * 写不进去**不阻断启动**：这是让 agent 寻址省事的便利，不是必需品。
 */
function ensureCliEnv(): void {
  // 开发环境没有稳定的 cli 目录（out/cli 会随构建变化），别往真实注册表里写
  if (!app.isPackaged) return
  try {
    const cliDir = path.join(process.resourcesPath, 'cli')
    const launcher = path.join(cliDir, 'deskpartner.cjs')
    if (!fs.existsSync(launcher)) return

    // 值没变就不写：避免每次启动都动环境变量
    const current = readUserEnvRaw('DESKPARTNER_CLI')
    if (current?.value !== launcher) {
      writeUserEnv('DESKPARTNER_CLI', launcher)
      console.log('[CLI env] DESKPARTNER_CLI =', launcher)
    }

    /**
     * ⚠️ **不再往用户 PATH 里写任何东西**（2026-09-28 主用户拍板 2cc71a13：
     * 不进 PATH，改做 MCP Server，见 bf736527）。
     *
     * 决定这一条的是一次日志式的实测事故：1.0.55 这里曾调
     * `ensurePathContains(cliDir)`，它按运行时 `existsSync` 判断该留哪些条目，
     * 把她 `HKCU\Environment\Path` 从 7 项削到 1 项，类型也从 `REG_EXPAND_SZ`
     * 退成 `REG_SZ`。修复（只删自己认领的条目 + 按原类型写回）虽然已经做完，
     * 但真正的问题是**收益与风险不成比例**：
     *
     * - 收益只是"少敲 `dp` 两个字符"；`DESKPARTNER_CLI` + `doctor.cli` 回显
     *   已经把"怎么找到 CLI"解决了，agent 全程用它跑得通。
     * - 风险却是**改别人的环境变量**，而且是全局的、跨进程的、坏了要很久才被发现。
     *
     * 所以这里彻底摘掉。agent 接入的正路改成 MCP Server（标准协议，不依赖
     * 终端 PATH 与 `dp` 是否可见），PATH 那块是非之地从此不碰。
     */
  } catch (err) {
    console.warn(
      '[CLI env] 写入 CLI 环境变量失败（不影响使用）：',
      err instanceof Error ? err.message : String(err)
    )
  }
}

/**
 * ⚠️ 这里曾有 `ensurePathContains()` —— 把 CLI 目录写进用户 PATH（1.0.55）。
 *
 * 已按 2cc71a13 的拍板整体摘除（不进 PATH，改做 MCP Server）。
 * 它触发过一次真实事故：按 `existsSync` 判断该留哪些条目，把用户自己的
 * `HKCU\Environment\Path` 从 7 项削到 1 项、类型从 REG_EXPAND_SZ 退成 REG_SZ。
 * 完整的选型理由见上面 `ensureCliEnv()` 里的注释。
 *
 * 事故复盘与"删除判据不能建立在会骗人的信号上"这条教训，保留在
 * `lib/user-path.ts` 的注释里 —— 那段逻辑虽已不再被调用，但它记下的
 * 是**碰别人环境变量时**的通用教训，不该随代码一起丢掉。
 */

/**
 * 用 PowerShell 读写用户级环境变量（**读原始值 + 按原类型写回**）。
 *
 * ⚠️ 三点都是踩出来的：
 *
 * 1. **用 PowerShell 的 .NET API，不用 `reg.exe`。**
 *    `[Environment]::SetEnvironmentVariable(..., 'User')` 会主动广播
 *    **WM_SETTINGCHANGE**，已开的资源管理器/终端能立刻刷新；`reg add` 只改
 *    注册表，得等对方自己重读（而资源管理器会一直拿着自己启动时的旧环境块，
 *    不广播的话**新开的终端也看不到新 PATH**）。另外实测本机安全策略把
 *    `reg.exe` 列进了黑名单，PowerShell 这条路才是普通 Windows 上可达的。
 *
 * 2. **必须用 `& { param(...) }` 或 `-EncodedCommand` 传参**，不能写成
 *    `-Command "脚本" 参数1 参数2`。1.0.42 那么写的结果是**一次都没写进去**
 *    （`-Command` 后面的额外参数不进 `$args`，被当成脚本文本的一部分）。
 *    失败又被 catch 吞成一句 console.warn，装完看起来"什么都没发生"。
 *    现在统一走 `-EncodedCommand`（base64 免转义）＋环境变量传值，彻底绕开引号地狱。
 *
 * 3. 🚨 **不能直接用 `[Environment]::SetEnvironmentVariable` 写 `Path`**（1.0.55 修）：
 *    它**先把 `REG_EXPAND_SZ` 读出来展开、再以 `REG_SZ` 写回** ——
 *    于是用户自己的 `%USERPROFILE%` 之类变量语义被固化成一串绝对路径，
 *    注册表类型也从 `ExpandString` 退化成 `String`。
 *    主用户本机实测到了这个退化。而 `Path` 恰恰是**别人的环境变量**，
 *    改它就得按它原来的样子写回。
 *
 * 因此这里：读用 `DoNotExpandEnvironmentNames`（拿原始值 + 原类型），
 * 写用 `RegistryKey.SetValue(name, value, kind)`（保持 ExpandString），
 * 写完自己广播 WM_SETTINGCHANGE。
 */
const PS_READ_USER_ENV = `
$ErrorActionPreference = 'Stop'
$name = $env:DP_ENV_NAME
$key = Get-Item 'HKCU:\\Environment'
$value = $key.GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
if ($null -eq $value) { exit 3 }
$kind = [int]$key.GetValueKind($name)
[Console]::Out.Write($kind.ToString() + "\`n" + [string]$value)
`

const PS_WRITE_USER_ENV = `
$ErrorActionPreference = 'Stop'
$name = $env:DP_ENV_NAME
$value = $env:DP_ENV_VALUE
$kind = [int]$env:DP_ENV_KIND
$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
if ($null -eq $key) { throw 'cannot open HKCU\\\\Environment for write' }
$key.SetValue($name, $value, [Microsoft.Win32.RegistryValueKind]$kind)
$sig = '[DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);'
$native = Add-Type -MemberDefinition $sig -Name NativeMethods -Namespace Win32 -PassThru
$result = [UIntPtr]::Zero
[void]$native::SendMessageTimeout([IntPtr]0xffff, 0x001A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result)
`

/** REG_SZ / REG_EXPAND_SZ 的数值语义见 `lib/user-path.ts` */

function runPowerShell(script: string, extraEnv: Record<string, string>): string {
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  return execFileSync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, ...extraEnv }
    }
  )
}

/**
 * 读用户环境变量的**原始值**（不展开 `%VAR%`）与它在注册表里的类型。
 *
 * 返回 null 表示"没这个变量"（而不是"读失败"—— 两者对调用方意义相同：
 * 都应当去写一遍）。
 */
function readUserEnvRaw(name: string): { value: string; kind: number } | null {
  try {
    const out = runPowerShell(PS_READ_USER_ENV, { DP_ENV_NAME: name })
    const nl = out.indexOf('\n')
    if (nl < 0) return null
    const kind = parseInt(out.slice(0, nl).trim(), 10)
    const value = out.slice(nl + 1).trim()
    if (!value) return null
    return { value, kind: Number.isNaN(kind) ? REG_SZ : kind }
  } catch {
    return null
  }
}

/**
 * 写用户环境变量，并**保持它原来的注册表类型**。
 *
 * 未显式给 kind 时按 `REG_SZ` 写 —— 对新变量（如 `DESKPARTNER_CLI`）是对的：
 * 纯赋值、没有需要展开的片段，不该无端声明成 ExpandString。
 */
function writeUserEnv(name: string, value: string, kind: number = REG_SZ): void {
  // 底线：绝不让 Path 掉成 REG_SZ（那会把用户的 %VAR% 固化）
  const safeKind = name.toLowerCase() === 'path' ? (kind === REG_SZ ? REG_EXPAND_SZ : kind) : kind
  runPowerShell(PS_WRITE_USER_ENV, {
    DP_ENV_NAME: name,
    DP_ENV_VALUE: value,
    DP_ENV_KIND: String(safeKind)
  })
}

app.on('web-contents-created', (_event, contents) => {
  /**
   * 外链一律拒绝在新窗口打开（本应用没有需要新窗口的页面）。
   * 与 CSP 是两层：这里挡住"开新窗"，CSP 挡住"页面里加载外部资源"。
   */
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))

  /**
   * 用 `on('will-navigate')` 而不是只靠 CSP：导航到外部地址属于
   * "整个页面被换掉"，CSP 管的是页面内的资源加载，管不住顶层导航。
   * 本应用所有页面都是 file:// 或 dev server，其余一律拦回。
   */
  contents.on('will-navigate', (event, url) => {
    const allowed = process.env.ELECTRON_RENDERER_URL
      ? url.startsWith(process.env.ELECTRON_RENDERER_URL)
      : url.startsWith('file://')
    if (!allowed) {
      event.preventDefault()
      console.warn('[Security] 已拦截导航到非应用地址:', url)
    }
  })
})

/**
 * ⚠️ CSP **不在主进程注入**，改由构建期写进 HTML 的 `<meta>` 标签
 * （见 electron.vite.config.ts 的 cspPlugin）。
 *
 * 为什么不用 `session.webRequest.onHeadersReceived`：
 * 打包后页面走 `file://`，而 Electron 的 webRequest **不拦截 file 协议**，
 * 那个监听器对生产页面根本不会触发 —— 装了等于没装，却会让人以为已经加固过。
 * 这种"看起来做了"比明确不做更危险，所以宁可换实现也不留这个假象。
 * `<meta http-equiv="Content-Security-Policy">` 是 file:// 下唯一可靠的载体。
 */


/**
 * 启动期致命失败：明确报错 + 硬停（`c5b30fb3`）
 *
 * 此前 `initializeDatabase()`（含迁移）抛错时只有一条未处理拒绝日志，
 * **进程带着不确定的库状态继续活着** —— "沉默的失败态"。
 * 现在：要么带着确定的库启动，要么明确报错退出，没有第三种。
 *
 * 退出码 1（一般错误）：这不是守卫拒绝（4），重试与修环境的指引都在消息里。
 */
function startupFatal(err: unknown): void {
  const detail = err instanceof Error ? err.message : String(err)
  const msg =
    `启动失败，已停止运行（不会带着不确定的数据库状态执行命令）：\n${detail}`
  console.error(`[Startup] ${msg}`)
  if (isCliMode) {
    // CLI 的 stdout 只承载数据（Agent 按 JSON 解析）—— 错误一律走 stderr
    process.stderr.write(`[DeskPartner] ${msg}\n`)
  } else {
    dialog.showErrorBox('DeskPartner 启动失败', msg)
  }
  app.exit(1)
}

app.whenReady().then(async () => {
  // ── 1. 初始化数据库 ──
  let dbHandle: ReturnType<typeof initializeDatabase>
  try {
    dbHandle = initializeDatabase()
  } catch (err) {
    // 迁移失败 / 库打不开 → 硬停，绝不带病往下走、绝不执行命令
    startupFatal(err)
    return
  }
  // 读出来给 doctor 用：并发参数必须是可观测的，不能靠猜
  const busyTimeoutMs = Number(dbHandle.pragma('busy_timeout', { simple: true }))

  // ── 2. 初始化 Repository ──
  todoRepo = new TodoRepository()
  categoryRepo = new CategoryRepository()
  projectRepo = new ProjectRepository()
  releaseRepo = new ReleaseRepository()
  memoRepo = new MemoRepository()
  settingsRepo = new SettingsRepository()
  agentRepo = new AgentRepository()
  commentRepo = new CommentRepository()
  notificationRepo = new NotificationRepository()
  reminderReceiptRepo = new ReminderReceiptRepository()
  rulesRepo = new RulesRepository()
  protocolRepo = new ProtocolRepository()
  profileRepo = new ProfileRepository()

  // 初始化默认分类
  categoryRepo.initializeDefaults()

  // ── 埋点：CLI 模式也要初始化，命令行调用同样是要统计的行为 ──
  telemetryService = new TelemetryService(settingsRepo.get().telemetryEnabled)
  telemetryService.prune()
  // 只在 GUI 模式记 app.start：CLI 每次调用都是独立进程，
  // 记进去会让"会话数"退化成"进程数"，语义就废了。
  // CLI 侧的调用量由每个命令的 cli.invoke 事件覆盖。
  if (!isCliMode) {
    telemetryService.record({
      actor: 'system',
      surface: 'system',
      category: 'app',
      event: 'start'
    })
  }

  // ── CLI 模式：到此为止，不建窗口、不建托盘、不注册快捷键 ──
  if (isCliMode) {
    await runCli(cliArgs as string[], {
      deps: {
        todoRepo,
        categoryRepo,
        projectRepo,
        releaseRepo,
        memoRepo,
        settingsRepo,
        agentRepo,
        commentRepo,
        notificationRepo,
        reminderReceiptRepo,
        rulesRepo,
        protocolRepo,
        profileRepo,
        telemetry: telemetryService,
        events: new EventsRepository()
      },
      meta: {
        version: app.getVersion(),
        dbPath: getDatabasePath(),
        schemaVersion: DB_VERSION,
        startedAt: APP_STARTED_AT,
        busyTimeoutMs,
        // 无头模式只能提供通道 B；它自己就是"被启动的那个进程"
        channels: ['headless'],
        via: 'headless'
      },
      // 调用方身份与凭据：由 launcher spawn 时注入（它读的是调用方 shell 与凭据文件）
      actor: process.env.DESKPARTNER_AGENT?.trim() || 'human',
      /**
       * 这个 actor 是**显式声明**的吗（1.0.46）。
       *
       * 启动器自动带上凭据时也会写 DESKPARTNER_AGENT，但那是"机器上碰巧有谁"，
       * 不是自称。`ambiguous_identity` 的判据必须看声明，否则本机落过凭据之后，
       * 调用方明明没声明身份，却会被报"你有两个身份我分不清"。
       */
      identityDeclared: process.env.DESKPARTNER_IDENTITY_DECLARED === '1',
      credential: process.env.DESKPARTNER_CREDENTIAL?.trim() || undefined,
      // 未标注按非交互处理，安全默认：漏传只会多卡一次，不会悄悄放行
      interactive: process.env.DESKPARTNER_INTERACTIVE === '1',
      // 会话 id：分级授权判"仅本次会话有效"要用（agent 侧 export DESKPARTNER_SESSION）
      session: process.env.DESKPARTNER_SESSION?.trim() || undefined,
      // 多份凭据未声明身份：启动器读凭据文件后发现的情况，经 env 带进来
      ...(process.env.DESKPARTNER_AMBIGUOUS_IDS?.trim()
        ? { ambiguousIds: process.env.DESKPARTNER_AMBIGUOUS_IDS.split(',').filter(Boolean) }
        : {}),
      /**
       * 说明书版本（G8 漂移提醒，1.0.57）。
       *
       * 无头路径下"服务端就是调用方的子进程"，env 天然传得过来 —— 这里读 env 是对的。
       * ⚠️ 但**管道路径读 env 是错的**（服务端是常驻 GUI 进程，看不到调用方环境），
       * 所以命令实现统一读 `ctx.skillVersion`，两条通道各自在这一层把值填好：
       * 无头读 env（此处），管道读请求体（cli-server.service.ts）。
       * **不要让命令实现自己读 env** —— 那正是这个 bug 的成因。
       */
      skillVersion: process.env.DESKPARTNER_SKILL_VERSION?.trim() || undefined,
      // 通道标识（1.0.63）：无头路径下服务端就是调用方子进程，读 env 是对的；
      // 管道读请求体（cli-server.service.ts）。与 skillVersion 同一规矩。
      surface: process.env.DESKPARTNER_SURFACE?.trim() || undefined,
      cliEnv: process.env.DESKPARTNER_CLI?.trim() || null
    })
    return
  }

  /**
   * CLI 寻址：把启动器路径写进用户环境变量（1.0.42，Bob 8bf64514）
   *
   * 放在 GUI 专属区（CLI 模式上面已 return）—— 环境变量写一次就够，
   * 没必要每次 CLI 调用都去动注册表。
   */
  ensureCliEnv()

  // ── 3. 初始化服务 ──
  windowManager = new WindowManager(settingsRepo)

  notificationService = new NotificationService({
    getWindows: () => windowManager.getWindows(),
    // 顶部横幅替代系统通知：位置（屏幕上方）与底色（红色警示）自己说了算
    showBanner: (payload) => windowManager.showReminderBanner(payload),
    onReminderAction: (action, todoId) => {
      if (action === 'click') {
        // 点击通知：打开看板
        windowManager.showKanban()
      }
    }
  })

  timerService = new TimerService(todoRepo, categoryRepo, notificationService)
  // 备份服务要 6 个 repo：导出/导入必须覆盖**用户看得见的全部东西**
  // （1.0.46 修：此前只传 3 个，导致导出缺 projects/agents/memos 三张表，
  //  导入回来的库"看着能开，其实少了一大半"——Bob演练事故的根因之一）。
  backupService = new BackupService(
    todoRepo,
    categoryRepo,
    settingsRepo,
    projectRepo,
    memoRepo,
    agentRepo,
    new CommentRepository()
  )

  // 跨进程变更广播：只在 GUI 模式启动。
  // CLI 进程执行完就退出，没必要轮询；但它写入时会 append 事件，
  // 由这里的 GUI 感知。
  const guiEventsRepo = new EventsRepository()
  guiEventsRepo.prune()

  /**
   * 清掉已退役的通知类型历史行（1.0.55，主用户驳回 2ccc6fc6）。
   *
   * 审批申请从收件箱迁到「审批」页后，1.0.55 之前产生的 type='grant'
   * 通知行就不再有任何入口能看到 —— 但它们会白占 `notification:list`
   * 的 limit 名额，把真正该看见的通知挤出首页。启动时清一次即可。
   */
  try {
    const pruned = new NotificationRepository().pruneRetired()
    if (pruned > 0) console.log(`[Notification] 已清理退役通知 ${pruned} 条（审批已迁入审批页）`)
  } catch (e) {
    console.warn('[Notification] 退役通知清理失败:', e instanceof Error ? e.message : e)
  }

  changeBroadcast = new ChangeBroadcastService(
    () => windowManager.getWindows(),
    LOCAL_ACTOR_ID,
    /**
     * agent 发起的授权申请 → 顶部横幅（1.0.37）
     *
     * 主用户的原话是"我在界面上没有看到任何审批提醒，或者是可以去审批的地方"。
     * 此前只有设置页里一个待表态列表 —— 那是"你去找它"，而 agent 正卡在那条
     * 命令上等人点头，人不知道就等于它一直卡着。所以补上"它来告诉你"这一半。
     *
     * 用 kind='grant' 复用待办提醒那条通道（位置在屏幕上方、红底白字），
     * 按「去审批」直达设置页的「谁能写入」那一屏 —— 设置页有十来个分区，
     * 只把窗口打开、落点不对，人还得自己找，多这一步就足够让人放弃。
     */
    ({ agentId, scope, command, summary }) => {
      const who = agentId.replace(/^agent:/, '')
      const what = scope === 'destructive' ? '删除数据' : '改界面'
      /**
       * 待表态总数（1.0.40）：横幅一次只放得下"谁想干什么"，
       * 多条时弹五条叠在一起等于没弹。但只说最新那条也不够 ——
       * 主用户实测撞到"横幅显示 A、设置页里躺着 B"，人会以为身份串了。
       * 所以显示最新的那条 + 说明还有几条，让她知道该去看完整列表。
       */
      let extra = 0
      try {
        const pending = agentRepo.listGrants({ status: 'pending', activeOnly: true }).length
        extra = Math.max(0, pending - 1)
      } catch {
        // 查不到数量不该连累横幅本身
        extra = 0
      }
      /**
       * 标题只留"谁想干什么，等你点头"（1.0.117，卡 `21f171f1`）。
       * 目标摘要另起一行（`detail`）：三样信息挤一行时，440 宽的横幅会把
       * 最后的**目标名**截掉 —— 而"删的到底是哪一条"正是人要点头的唯一依据。
       */
      const bannerTitle =
        `${who} 申请${what}` + (extra > 0 ? `（另有 ${extra} 条待审批）` : '')
      windowManager.showReminderBanner({
        todoId: `grant:${agentId}:${scope}`,
        title: bannerTitle,
        /**
         * 1.0.39：带上目标摘要 —— 主用户指出横幅"没说删除什么"：
         * "删除数据"配一条命令名，人没法判断这条该不该批（删一条测试残留
         * 和删看板上最重要的父需求，是两个完全不同的决定）。摘要由命令侧
         * 解析出（`todo rm` 会带上目标标题），取不到时退回命令名 ——
         * 两条都比"什么都没说"强，也比把 uuid 塞进标题强。
         *
         * 1.0.117（卡 `21f171f1`）：摘要从标题里搬到这里，单独一行 ——
         * 三样信息挤一行时被截掉的那一截恰好是目标名。
         */
        detail: summary || command || '',
        categoryName: '',
        kind: 'grant'
      })
      /**
       * 通知中心：审批申请**不再写入**（1.0.55，主用户驳回 2ccc6fc6）。
       *
       * 她的原话：「审批通知还在通知里，应该迁移到审批中」。
       *
       * 1.0.48 这里会把每条审批申请写成一条 type='grant' 的通知。但 1.0.52
       * 之后审批有了**一级入口**（待表态队列 + 审批日志），顶部横幅又负责当场
       * 提醒 —— 收件箱再存一份就成了"同一件事两个目的地"。
       * 更实际的问题是：审批面点完「允许」后没人去标那条通知已读，
       * 未读角标于是**永远消不掉**（`grant` 已列入 RETIRED_TYPES，见
       * NotificationRepository，历史行由启动时 pruneRetired() 清掉）。
       *
       * 留这段注释是为了让下一个人知道：这里**故意不写通知**，
       * 不是漏了 —— 审批的去处在「审批」页，不在收件箱。
       */
    },
    /**
     * 新 agent 接入 → 顶部横幅（1.0.63）
     *
     * 主用户 2026-09-30：「不久会有新的 agent 成员加入，既然通知机制要落地，
     * 新 agent 注册和教学的相关能力也一并考虑加上吧，agent friendly
     * 要从接入使用开始。」
     *
     * 此前注册只是往 agents 表写一行 —— agent 得靠人自己去用户页翻才会被放行。
     * 而 1.0.47 起注册是自助的，agent 办完就静默等着，**谁也不知道它来了**。
     *
     * 复用 kind='grant' 的通道（位置与红底白字一致，都是"需要你点一下头"），
     * 按「去审批」跳到审批页的「待批准身份」—— 它正是处理这件事的地方。
     * 文案与授权申请刻意不同：申请是"它卡着等你"，注册是"它刚到"，
     * 混成一句会让人以为有个动作正卡在半路。
     */
    ({ agentId, displayName }) => {
      const who = displayName || agentId.replace(/^agent:/, '')
      windowManager.showReminderBanner({
        todoId: `agent:${agentId}`,
        title: `${who} 申请接入`,
        /** 后半句是"为什么值得批"，属于说明，不该占标题（1.0.117） */
        detail: '批准后可读写事项与项目',
        categoryName: '',
        kind: 'grant'
      })
    }
  )
  changeBroadcast.start()

  /**
   * 通道 A：常驻命名管道服务端
   *
   * 只在 GUI 模式启动 —— 它接的活就是"替另一个进程执行命令"，
   * 而无头进程自己就是那个"另一个进程"，没有它存在的理由。
   *
   * 命令执行与无头通道、batch 共用 executeOne，所以两条通道的行为一致。
   */
  cliServer = new CliServerService({
    deps: {
      todoRepo,
      categoryRepo,
      projectRepo,
      releaseRepo,
      memoRepo,
      settingsRepo,
      agentRepo,
      commentRepo,
      notificationRepo,
      reminderReceiptRepo,
      rulesRepo,
      protocolRepo,
      profileRepo,
      telemetry: telemetryService,
      events: guiEventsRepo
    },
    meta: {
      version: app.getVersion(),
      dbPath: getDatabasePath(),
      schemaVersion: DB_VERSION,
      startedAt: APP_STARTED_AT,
      busyTimeoutMs,
      // GUI 进程同时具备两条通道：自己是被启动的目标，也监听管道
      channels: ['headless', 'pipe'],
      via: 'pipe'
    }
  })
  cliServer.start()

  shortcutService = new ShortcutService()
  autoLaunchService = new AutoLaunchService()

  // ── 4. 注册 IPC ──
  registerIPC(
    todoRepo,
    categoryRepo,
    projectRepo,
    releaseRepo,
    memoRepo,
    settingsRepo,
    agentRepo,
    backupService,
    timerService,
    notificationService,
    () => windowManager.getWindows(),
    applySettingsSideEffects,
    telemetryService
  )

  // 注册窗口控制 IPC
  windowManager.setupWindowIPC()

  /**
   * 真正的「退出应用」
   *
   * 悬浮球菜单里的退出此前走的是 window.close()，只关掉了悬浮球那一个窗口，
   * 托盘和定时器还在跑，看起来就像"只是隐藏了悬浮窗"。这里统一走 app.quit()，
   * 清理逻辑交给 before-quit，保证只有一条退出路径。
   */
  ipcMain.handle('app:quit', () => {
    app.quit()
  })

  // ── 5. 创建窗口 ──
  windowManager.createFloatBallWindow()

  // ── 6. 创建系统托盘 ──
  trayService = new TrayService({
    onShowKanban: () => windowManager.showKanban(),
    onShowSettings: () => windowManager.showSettings(),
    // 清理交给 before-quit，避免 cleanup() 被走两条路径重复调用
    onQuit: () => app.quit()
  })
  trayService.create()

  // ── 7. 注册全局快捷键 ──
  const settings = settingsRepo.get()
  if (settings.appName || settings.appIcon) {
    trayService.applyCustomBranding({ appName: settings.appName, appIcon: settings.appIcon })
    windowManager.applyAppBranding({ appName: settings.appName, appIcon: settings.appIcon })
  }
  const shortcutRegistered = shortcutService.register(settings.globalShortcut, () => {
    windowManager.showQuickAdd()
  })
  activeShortcut = shortcutRegistered ? settings.globalShortcut : null

  // ── 8. 开机自启 ──
  autoLaunchService.update(settings.autoStart)

  // ── 9. 启动定时提醒服务 ──
  timerService.start()

  /**
   * ── 10. 首次启动：先让主界面出场，再问名字 ──
   *
   * 老用户升级上来 humanNameAsked 也是 false，同样会问一次 —— 这是期望行为：
   * 名字是新增的维度，问一次比让人去设置里翻要好。
   * 跳过也写 true，绝不第二次打扰。
   *
   * 🚨 **首次启动必须把看板主窗口一起打开**（1.0.65 修 `abec1753`）。
   *
   * 1.0.64 的症状：新用户装完，第一眼是**空桌面上孤零零一个说明框**，
   * 产品本身完全没露脸。她的原话：「有点太生硬了，你至少要把界面唤起的同时，
   * 让它展示出来吧，你光秃秃的展示它也是有点奇怪」。
   *
   * 根因不是"少调了一个函数"这么简单：启动链第 5 步只建了悬浮球，
   * `showKanban()` **从来不在启动路径上**（只有托盘 / 悬浮球菜单 /
   * `window:showKanban` 这几条手动路径会调它）。于是"首次见面"这件事
   * 全部发生在两个 440×380 / 480×420 的置顶小窗里，而它们背后是空的。
   *
   * 判据：**回答"这东西是干嘛的"，最好的答案应该是产品本身。**
   * 说明书替代不了界面在场 —— 引导文案说得再好，也只是让人知道
   * "有个东西存在"，而不是看见它是样子。
   *
   * ⚠️ 为什么放在 `showOnboarding()` 之前而不是之后：
   * 引导窗是 `alwaysOnTop` 的，主窗口先开、引导窗后弹，才能保证
   * **引导窗盖在主界面上方**（人先看见产品，再被引导罩住）。
   * 反过来先弹引导再开主窗口，主窗口会把置顶的引导窗顶到后面去，
   * 而 `bringToFront` 抢焦点还可能把人正在打的字打断。
   *
   * ⚠️ 只在**首次**这么做：老用户启动仍然只出悬浮球（那是他自己配好的形态，
   * 每次开机都弹一个大窗是另一种打扰）。
   */
  const isFirstRun = !settings.humanNameAsked || !settings.welcomeShown
  if (isFirstRun) {
    windowManager.showKanban()
  }

  if (!settings.humanNameAsked) {
    windowManager.showOnboarding()
  } else if (!settings.welcomeShown) {
    /**
     * ── 11. 首次见面引导（1.0.64）──
     *
     * 只在**没弹名字窗**的时候直接唤起。弹了名字窗的那条路，
     * 由 showOnboarding 的 closed 回调接着弹（两个都是居中置顶弹窗，
     * 同时弹会叠在一起 —— 串行才是一次一个）。
     *
     * 这里再读一次 settings 而不是复用上面那个 const：同一段里已不可变，
     * 但保留"以库里实际值为准"的读法，避免以后有人在中间插一步写设置而漏掉同步。
     */
    if (!settingsRepo.get().welcomeShown) {
      windowManager.showWelcome()
    }
  }

  if (settings.autoCheckUpdate && (app.isPackaged || Boolean(process.env.DESKPARTNER_UPDATE_FEED_URL))) {
    setTimeout(() => {
      void autoUpdateService.checkForUpdates()
    }, 2000)
  }

  console.log('[App] 应用启动完成')
  /**
   * 启动链上任何未捕获的失败同样硬停（`c5b30fb3`）：
   * 此前它只会变成一条未处理拒绝日志，进程继续活着 —— 带病运行。
   */
}).catch(startupFatal)

/**
 * 设置变更后的副作用处理
 *
 * 此时设置已写入数据库，这里负责让改动真正作用到系统与窗口上。
 * 返回字符串表示副作用失败，该提示会回传给设置界面展示。
 */
function applySettingsSideEffects(
  settings: AppSettings,
  partial: Partial<AppSettings>
): string | undefined {
  // ── 全局快捷键：重新注册 ──
  if ('globalShortcut' in partial) {
    const ok = shortcutService.register(settings.globalShortcut, () => {
      windowManager.showQuickAdd()
    })

    if (!ok && settings.globalShortcut) {
      // 注册失败通常是该组合已被其它程序占用：回滚到上一个可用值并重新挂上
      if (activeShortcut !== settings.globalShortcut) {
        settingsRepo.update({ globalShortcut: activeShortcut })
        shortcutService.register(activeShortcut, () => {
          windowManager.showQuickAdd()
        })
      }
      return `「${settings.globalShortcut}」注册失败，可能已被其它程序占用`
    }

    activeShortcut = settings.globalShortcut
  }

  // ── 开机自启 ──
  if ('autoStart' in partial) {
    autoLaunchService.update(settings.autoStart)
  }

  // ── 看板窗口置顶 ──
  if ('kanbanAlwaysOnTop' in partial) {
    windowManager.applyKanbanAlwaysOnTop(settings.kanbanAlwaysOnTop)
  }

  // ── 埋点开关 ──
  if ('telemetryEnabled' in partial) {
    telemetryService?.setEnabled(settings.telemetryEnabled)
  }

  // ── 自定义应用名称与图标 ──
  if ('appName' in partial || 'appIcon' in partial) {
    trayService?.applyCustomBranding({ appName: settings.appName, appIcon: settings.appIcon })
    windowManager?.applyAppBranding({ appName: settings.appName, appIcon: settings.appIcon })
  }

  return undefined
}

// ── 第二个实例启动时激活已有实例 ──
onSecondInstance(() => {
  windowManager?.showKanban()
})

// ── macOS 激活 ──
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    windowManager?.createFloatBallWindow()
  }
})

// ── 所有窗口关闭 ──
app.on('window-all-closed', () => {
  // 不退出应用，保持托盘运行
  // macOS 下通常也不退出
})

// ── 应用退出前清理 ──
app.on('before-quit', () => {
  cleanup()
})

/** 清理所有服务 */
function cleanup(): void {
  // 先记退出事件，再关库 —— 顺序反了这条就永远记不下来
  telemetryService?.record({
    actor: 'system',
    surface: 'system',
    category: 'app',
    event: 'quit'
  })
  cliServer?.stop()
  changeBroadcast?.stop()
  timerService?.stop()
  shortcutService?.unregisterAll()
  trayService?.destroy()
  windowManager?.closeAll()
  closeDatabase()
  console.log('[App] 已清理所有服务')
}

// ── 未捕获异常处理 ──
// 埋点的用途之一就是问题诊断，所以异常也要记下来。
// 注意只记错误类型与消息，不记堆栈里的路径内容以外的业务数据。
process.on('uncaughtException', (err) => {
  console.error('[App] 未捕获异常:', err)
  telemetryService?.record({
    actor: 'system',
    surface: 'system',
    category: 'error',
    event: 'uncaught_exception',
    ok: false,
    props: { name: err?.name ?? 'Error', message: (err?.message ?? '').slice(0, 500) }
  })
  // CLI 模式硬停（c5b30fb3）：一次命令调用是短命进程，带着未知状态
  // 继续执行/挂着，比直接失败更糟 —— 调用方（agent）会以为命令跑成功了。
  if (isCliMode) app.exit(1)
})

process.on('unhandledRejection', (reason) => {
  console.error('[App] 未处理的 Promise 拒绝:', reason)
  telemetryService?.record({
    actor: 'system',
    surface: 'system',
    category: 'error',
    event: 'unhandled_rejection',
    ok: false,
    props: { message: String(reason ?? '').slice(0, 500) }
  })
  // 同上：迁移失败曾在 CLI 进程里以"未处理拒绝"形态出现，进程继续跑命令
  // （c5b30fb3 实测）。CLI 通道从此不再对未知失败"记一笔就放行"。
  // GUI 保持放行：常驻进程里杂散异步失败不该带走整个应用。
  if (isCliMode) app.exit(1)
})
