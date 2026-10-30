/**
 * CLI 通道 A（常驻命名管道）的协议约定
 *
 * 这个文件会被**两侧同时引用**：
 * - 服务端：Electron 主进程（GUI 常驻时监听）
 * - 客户端：纯 Node 启动器（不加载 Electron）
 *
 * 所以这里**只允许依赖 node: 内置模块**，一旦引入 Electron API，
 * 客户端就再也用不了了 —— 而客户端的全部意义就是"不启动 Electron"。
 * 两边算出的管道名必须完全一致，因此约定只能有这一份，不能各写一套。
 */
import { createHash } from 'node:crypto'
import { userInfo } from 'node:os'
import { resolve } from 'node:path'

/** 连接超时：GUI 在跑时连接应在几毫秒内完成，超一点就说明它不在 */
export const CONNECT_TIMEOUT_MS = 300

/** 单条命令的响应超时（客户端侧：等不到响应就放弃） */
export const RESPONSE_TIMEOUT_MS = 30000

/**
 * 服务端执行期超时 —— **必须大于 `RESPONSE_TIMEOUT_MS`**。
 *
 * 为什么要有这个常量、以及为什么两者必须有固定的大小关系：
 *
 * 命令执行超时这件事，两侧看到的"失败"含义完全不同：
 * - 客户端超时 = **它不知道服务端做到哪了**，只能提示"可能已执行，别急着重试"；
 * - 服务端超时 = 它知道命令卡住了，但此时客户端多半已经放弃、收不到响应。
 *
 * 如果服务端先超时（或像 1.0.42 那样干脆不超时），就会出现
 * **客户端已报错、服务端还在写库**的窗口 —— 调用方去重试就重复写入。
 * 所以让客户端总是先放弃，服务端多留一段时间把当前命令跑完，
 * 结果落在库里而不是被中途掐断成半截状态。
 *
 * 这里写成 `RESPONSE_TIMEOUT_MS + 15000` 而不是硬编码 45000：
 * 一旦有人调整客户端超时，这个关系会自动跟着走，不会被改反。
 */
export const EXEC_TIMEOUT_MS = RESPONSE_TIMEOUT_MS + 15000

/**
 * 当前用户标识（用于区分同一台机器上的不同用户）
 *
 * 注意：这不是安全边界，用户名是可预测的。真正的隔离来自
 * Windows 命名管道的默认 ACL —— Node 建管道时安全描述符传 NULL，
 * 系统会用创建者的默认描述符，即"创建者用户 + SYSTEM + Administrators"，
 * 其他标准用户根本连不上。
 *
 * 它的作用是避免同机多用户时抢占同一个管道名。
 */
export function currentUserKey(): string {
  const name =
    process.env.USERNAME || process.env.USER || safeUsername() || 'unknown'
  return createHash('sha1').update(name.toLowerCase()).digest('hex').slice(0, 10)
}

function safeUsername(): string {
  try {
    return userInfo().username
  } catch {
    return ''
  }
}

/**
 * 数据目录标识（**隔离实例与真实实例不能共用管道**）
 *
 * ── 为什么必须有这一节 ──
 *
 * 管道名原来只由用户名决定，于是**同一台机器上只有一个管道**。
 * 一旦按 `DESKPARTNER_DATA_DIR` 起了隔离实例，那个实例监听的仍然是
 * 真实 GUI 的那个管道名 —— 两个实例抢同一个名字，
 * 而"谁先监听谁赢"，后到的那个**静默失去通道 A**（不报错）。
 *
 * 更贵的是反向的：隔离实例里的 CLI 调用**不会**连接到自己这个实例，
 * 而是连到常驻的真实 GUI —— 于是"跑在隔离库上"的验证脚本，
 * 写着写着就写进了她的真实看板。这正是本文件顶部那条
 * "服务端看不到调用方的环境"之外的一种同源错误：
 * **环境不同、管道名相同**。
 *
 * 所以：**只要声明了数据目录覆盖，就把它的摘要并进管道名**。
 * 没声明时保持原样（与已安装的旧版兼容）。
 *
 * ⚠️ 两侧必须算出同一个值，这里同样只允许依赖 `node:` 内置模块。
 * 服务端（Electron 主进程）与客户端（纯 Node 启动器）都从**环境变量**读，
 * 而不是从 `app.getPath('userData')` —— 因为客户端根本拿不到 Electron API。
 * 两者的关系由 `checkIsolation` 兜底：声明了隔离却没能生效时，
 * 应用会直接拒绝启动，不会出现"env 说隔离、实际动真实库"的错位。
 */
export function dataDirKey(raw: string | undefined = process.env.DESKPARTNER_DATA_DIR): string {
  // 没声明 / 空值（空值在 checkIsolation 里会被判为"设了却没生效"并拒绝启动，
  // 这里只需保证不生成一个诡异的管道名）→ 沿用旧名，保持兼容
  if (raw === undefined || raw.trim() === '') return ''
  // 归一化：去尾部斜杠、统一小写，使 `D:\a\` 与 `d:/a` 得到同一个键
  const abs = resolve(raw).replace(/[\\/]+$/, '').toLowerCase()
  return '-' + createHash('sha1').update(abs).digest('hex').slice(0, 8)
}

/** 管道完整路径；两侧必须得到相同结果 */
export function pipeName(): string {
  return `\\\\.\\pipe\\deskpartner-cli-${currentUserKey()}${dataDirKey()}`
}

/** 请求：一条命令的 argv */
export interface PipeRequest {
  argv: string[]
  /**
   * 调用方是不是人在终端里直接敲的。
   * 必须由客户端传：服务端跑在常驻进程里，它看自己的 stdout 永远是非 TTY，
   * 无法判断该给人读文本还是给程序读 JSON。
   */
  tty: boolean
  /**
   * 调用方 stdin 的内容（被重定向/管道传入时才有）
   *
   * 必须由客户端读好带过来：batch 命令要从 stdin 取 NDJSON，
   * 而无头路径靠 stdio:'inherit' 天然传得过去、管道路径传不过去 ——
   * 不补这一项就会出现"无头能用 batch、GUI 一开着就报 stdin 为空"。
   */
  stdin?: string
  /**
   * 调用方身份（如 agent:bob）
   *
   * 必须由客户端传：服务端跑在 GUI 进程里，它自己的环境变量是 GUI 的，
   * 看不到调用方 shell 里的 DESKPARTNER_AGENT。不传按 human 处理。
   * 这是"流转历史/埋点里记的是谁在操作"的唯一可靠来源 ——
   * 此前 agent 用 CLI 干的活全被记成 human（或干脆没记），归不了因。
   */
  actor?: string
  /**
   * 上面的 `actor` 是调用方**显式声明**的吗（1.0.46）
   *
   * 与 `actor` 分开传的原因见 commands.ts 的 `CliContext.identityDeclared`：
   * actor 可能来自"本机只有一份凭据时自动带上"，那不是声明。
   * `ambiguous_identity` 判据依赖这个区分，缺了它就会把"没声明身份的调用"
   * 误判成声明过，报出牛头不对马嘴的"你有两个身份我分不清"。
   */
  identityDeclared?: boolean
  /**
   * 注册时签发的凭据明文（可选）
   *
   * 写命令要出示它：光报名字是"自称"，凭据才说明这次调用确实来自它。
   * 由客户端从 ~/.deskpartner/credentials.json 自动带上，不用调用方操心。
   */
  credential?: string
  /**
   * 调用方是不是人在终端里敲的（TTY）
   *
   * 与 tty 同值，但语义不同：tty 决定输出格式（人读/机读），
   * interactive 决定**要不要卡身份**。分开传，免得将来其中一项的判定变了
   * 另一个跟着改错。
   */
  interactive?: boolean
  /**
   * 对话 id（可选）：agent 侧 export DESKPARTNER_SESSION 声明。
   * 只落进埋点 props，用于把多次 CLI 调用串成同一对话 ——
   * 否则 session_id 每次进程都是新的，跨调用的行为曲线画不出来。
   */
  session?: string
  /**
   * 本机存在多份 agent 凭据、但调用方没声明身份时，这里是可选身份列表。
   *
   * 由客户端发现并带过来（服务端进程看不到调用方的主目录与凭据文件）。
   * 门禁据此在**写命令**上拒绝并指路；读命令不受影响。
   * 不在这里拒绝的原因：读命令不需要身份，一刀切会把 `todo list` 也堵死。
   */
  ambiguousIds?: string[]
  /**
   * 调用方手上那份说明书的版本（可选）：agent 侧 export
   * DESKPARTNER_SKILL_VERSION 声明，由客户端带过来。
   *
   * 为什么必须走管道（1.0.57，Bob 52b6b726 驳回）：
   * G8 漂移提醒原先在服务端直接读 `process.env.DESKPARTNER_SKILL_VERSION`，
   * 但服务端跑在**常驻 GUI 进程**里，它的环境变量是 GUI 的 ——
   * 调用方 shell 里声明的那个根本传不进来。于是 GUI 一开着，
   * 漂移提醒就**静默失效**（无头通道反而正常，因为那时服务端就是调用方自己的子进程）。
   *
   * 这与 `actor` / `credential` / `session` / `ambiguousIds` 是同一类问题：
   * **服务端看不到调用方的环境，凡它要读的环境变量都得由客户端带过来。**
   * Bob实测：GUI 在跑时声明 1.0.50，回执 notice 为空；加 NO_PIPE=1 才有提醒。
   */
  skillVersion?: string
  /**
   * 调用方走的哪张皮（1.0.63）：`cli`（人/脚本直接敲）或 `mcp`（经 MCP 工具调用）。
   *
   * 由客户端从 `DESKPARTNER_SURFACE` 读并带过来 —— 与 actor / skillVersion 同类，
   * **服务端看不到调用方的环境**。此前埋点把 surface 硬编码成 'cli'，
   * 于是 MCP 的调用全混进 CLI 统计，`telemetry stats` 里根本分不出
   * "这条通道到底有没有人用"。
   */
  surface?: string
  /**
   * 调用方 shell 进程看到的 DESKPARTNER_CLI 环境变量值（卡 `9b3db53b`）。
   * 传 null 表示调用方进程环境中未设置该变量。
   */
  cliEnv?: string | null
}

/**
 * 响应：直接给"要写进 stdout 的内容 + 退出码"
 *
 * 刻意不让服务端返回结构化数据再让客户端自己排版 ——
 * 那样输出格式就有了两份实现，迟早会出现"管道与命令行输出不一致"。
 * 格式化只在服务端（formatOutcome）做一次。
 */
export interface PipeResponse {
  stdout: string
  exitCode: number
}

/** 协议走 NDJSON：一行一条消息，实现简单且便于以后流式扩展 */
export function encodeMessage(msg: unknown): string {
  return JSON.stringify(msg) + '\n'
}
