/**
 * agent 凭据的落盘与读取
 *
 * 这个文件会被**两侧同时引用**（与 pipe-protocol 同一约束）：
 * - 客户端：纯 Node 启动器（不加载 Electron）
 * - 服务端：Electron 主进程（签发与校验）
 *
 * 所以这里只允许依赖 node: 内置模块。
 *
 * **为什么是落盘，而不是每次 export 环境变量：**
 * 让调用方"记得声明身份"是最不可靠的一环 —— 忘了就静默记成 human，
 * 等于 agent 干的活挂在人名下（实测 1147 条 CLI 调用里 1142 条如此）。
 * 参照 Moltbook（注册发 key、key 落 ~/.config、之后每次请求自动带）
 * 与 MCP（clientInfo 是协议必填而非可选提示）：
 * **注册一次 → 凭据落盘 → 之后每次调用由启动器自动带上**，
 * 这一步不需要 agent 记住任何东西。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash, randomBytes } from 'node:crypto'

/**
 * 凭据文件：用户主目录下，与数据库分开（数据库会被备份/迁移，凭据不该跟着走）
 *
 * DESKPARTNER_CREDENTIALS_FILE 可覆盖路径 —— 只为单测准备，
 * 免得测试往真实主目录里写东西。
 */
export function credentialsPath(): string {
  const override = process.env.DESKPARTNER_CREDENTIALS_FILE?.trim()
  if (override) return override
  return path.join(os.homedir(), '.deskpartner', 'credentials.json')
}

export interface CredentialProfile {
  token: string
  /** 签发时间，便于用户判断"这份凭据多久了" */
  issuedAt: string
}

export interface CredentialFile {
  version: 1
  /** 不指定身份时默认用哪个 */
  default?: string
  profiles: Record<string, CredentialProfile>
}

/** 生成一个足够长、不可猜测的凭据明文（只在签发时返回一次） */
export function generateToken(): string {
  return randomBytes(24).toString('base64url')
}

/** 只存哈希，不存明文 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function readCredentials(): CredentialFile {
  try {
    const raw = fs.readFileSync(credentialsPath(), 'utf8')
    const parsed = JSON.parse(raw) as CredentialFile
    if (!parsed || typeof parsed !== 'object' || !parsed.profiles) {
      return { version: 1, profiles: {} }
    }
    return { version: 1, default: parsed.default, profiles: parsed.profiles }
  } catch {
    // 文件不存在 / 损坏都要当作"没有凭据"，不能让启动器崩在这里
    return { version: 1, profiles: {} }
  }
}

/**
 * 写入（或覆盖）某个身份的凭据
 *
 * ⚠️ 只在文件里还没有 default 时才把它设为默认 —— 否则后领凭据的 agent
 * 会把先领的顶掉，不指定身份的调用就串到了别人名下（多 agent 并存时的静默错记）。
 * 多 agent 各自跑的场景请显式 `export DESKPARTNER_AGENT=agent:<id>`。
 */
export function writeCredential(agentId: string, token: string): void {
  const file = readCredentials()
  file.profiles[agentId] = { token, issuedAt: new Date().toISOString() }
  if (!file.default || !file.profiles[file.default]) file.default = agentId
  const dir = path.dirname(credentialsPath())
  fs.mkdirSync(dir, { recursive: true })
  // 私钥级别的权限：同机其他用户不该读得到（Windows 上此选项无效果）
  fs.writeFileSync(credentialsPath(), JSON.stringify(file, null, 2), { mode: 0o600 })
}

/**
 * 删掉某个身份的本地凭据（卡 `5074766a` 的孤儿清理）
 *
 * ## 为什么这件事必须有个入口
 *
 * 凭据文件与数据库是两份账：身份在库里被移除之后，凭据文件里那一份**留着**，
 * 于是"凭据数 > 身份数"。而启动器的规矩是"多份又没声明身份就不猜"——
 * 死凭据会让每一次调用都被要求显式声明身份，那层摩擦里有一部分纯属白付。
 * 而此前文件里七个导出函数（`credentialsPath` / `generateToken` / `hashToken` /
 * `readCredentials` / `writeCredential` / `pickCredential` / `listCredentialIds`）
 * **一个删除入口都没有** —— 人只能手改 JSON，普通用户做不了，还容易删错。
 *
 * ## 边界
 *
 * - 只动**这一份文件**，不碰库里的身份（删身份是另一件事，而且不可逆）；
 * - 默认身份被删时**跟着换人**（换到剩下排序第一的），没剩下就清掉 `default` ——
 *   不能留一个指向不存在的身份的 `default`（那种脏数据比没有更难查）；
 * - 文件不存在 / 没有这个身份 → `removed: false`，**不写文件**（不制造空文件）。
 *
 * 安全语义由命令层守（已注册的身份不受理），这里只负责把文件改对。
 */
export interface RemoveCredentialResult {
  /** 真的删掉了一条（不存在时是 false —— 调用方据此区分"删了"与"本来就没有"） */
  removed: boolean
  /** 删掉的正好是文件里的默认身份 */
  wasDefault: boolean
  /** 删完之后文件里的默认身份（可能没有） */
  defaultAfter: string | null
  /** 删完之后文件里还剩几份 */
  remaining: number
}

export function removeCredential(agentId: string): RemoveCredentialResult {
  const file = readCredentials()
  const id = agentId.trim()
  const remainingIds = Object.keys(file.profiles).sort()
  const existed = Boolean(id) && Object.prototype.hasOwnProperty.call(file.profiles, id)
  if (!existed) {
    return {
      removed: false,
      wasDefault: false,
      defaultAfter: file.default ?? null,
      remaining: remainingIds.length
    }
  }

  const wasDefault = file.default === id
  const profiles: Record<string, CredentialProfile> = {}
  for (const key of remainingIds) {
    if (key === id) continue
    profiles[key] = file.profiles[key]
  }
  const rest = Object.keys(profiles).sort()

  /**
   * 默认身份的去处：**换到剩下排序第一的那份**，没有就整个去掉。
   *
   * 为什么不"保持原值不动"：`pickCredential` 已经不靠 `default` 猜身份了，
   * 可界面与 `doctor` 还会读它 —— 指向一个不存在的身份，报出来的就是假话。
   */
  const defaultAfter = wasDefault ? (rest[0] ?? null) : (file.default ?? null)

  const next: CredentialFile = { version: 1, profiles }
  if (defaultAfter) next.default = defaultAfter

  const dir = path.dirname(credentialsPath())
  fs.mkdirSync(dir, { recursive: true })
  // 与 `writeCredential` 同一个权限口径：私钥级别，同机其他用户不该读得到
  fs.writeFileSync(credentialsPath(), JSON.stringify(next, null, 2), { mode: 0o600 })

  return { removed: true, wasDefault, defaultAfter, remaining: rest.length }
}

/**
 * 挑一份凭据：显式指定优先；**没指定时只在"本机恰好只有一份"才用它**
 *
 * 返回 null 表示"这次调用拿不到可用凭据" —— 调用方据此决定
 * 是按 human 放行（人在终端敲）还是拒绝（agent 在无人值守地调）。
 *
 * ⚠️ 1.0.37 收紧（Bob 32f0bf89 实测报的）：
 *
 * 此前没指定身份时会退回文件里的 `default`（写第一份凭据的那个身份）。
 * 单人单 agent 时没问题，**同机跑两个 agent 时就成了静默错记**：
 * Bob的调用被自动带上 alice 的凭据，于是
 * （一）telemetry 里它的所有调用 actor 全记成 agent:alice；
 * （二）它触发 `todo rm` 的授权申请 agentId 也是 alice ——
 * 人批准后，审计上分不清是谁在删；
 * （三）分级授权的信任模型被削弱：授权本该给"某个 agent 身份"，
 * 实际授给了"这台机器上碰巧持证的那个"。
 *
 * 现在：多份凭据 + 未声明身份 → 不猜，返回 null，由调用方提示声明。
 * `default` 字段保留（文件格式不变、向后兼容），但不再用来猜身份 ——
 * "不指定时随便挑一个"正是要禁掉的那个行为。
 */
export function pickCredential(preferredId?: string): {
  agentId: string
  token: string
} | null {
  const file = readCredentials()
  const ids = Object.keys(file.profiles)
  if (!ids.length) return null

  const want = preferredId?.trim()
  if (want) {
    // 声明了身份就必须用它自己的凭据，**绝不**借别人的
    const profile = file.profiles[want]
    return profile ? { agentId: want, token: profile.token } : null
  }

  if (ids.length === 1) {
    // 本机只有一份：用它。这条不能省 —— 1.0.35 的价值就是
    // "注册一次、之后每次调用自动带身份"，单人场景不该被迫声明。
    const only = ids[0]
    return { agentId: only, token: file.profiles[only].token }
  }

  // 多份且没声明：无从判断这次是谁在调，宁可不带也不冒充
  return null
}

/**
 * 本机已落盘凭据的身份列表（按身份名排序）
 *
 * 给启动器用：多份凭据又没声明身份时，要靠它拼出"请你声明身份"的提示 ——
 * 光说"没凭据"没用，得告诉它本机有哪些身份可选。
 */
export function listCredentialIds(): string[] {
  return Object.keys(readCredentials().profiles).sort()
}
