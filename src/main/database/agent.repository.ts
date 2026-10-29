import { UsageError } from '../lib/domain-errors'
import { randomUUID } from 'node:crypto'
import { getDatabase } from './index'
import { generateToken, hashToken } from '../../cli/credentials'

/**
 * Agent 身份（R3-1）
 *
 * 为什么需要这一层：`created_by` 那样的文本是**标注不是身份** ——
 * 任何进程都能自称 `agent:xxx`。标注能回答"这条是谁记的"，
 * 但回答不了"这台机器上到底有哪些 agent"、
 * 也无从判断"这条写入是不是跨边界的"。
 *
 * 1.0.35 起身份从"自称"升级为"持证"（schema v15，credential_hash）：
 * 注册时签发凭据并落盘，之后每次调用由启动器自动带上、服务端校验哈希。
 * `approved` 同时在用：新注册的身份默认**未批准**（不能写），
 * 等人在界面上点头 —— 谁能在我的看板上写东西，由人决定。
 */
export interface Agent {
  /** 与 todos.created_by 同形，如 `agent:bob` —— 关联时不用再拼前缀 */
  id: string
  displayName: string
  color: string | null
  approved: boolean
  /**
   * 人明确不要这个身份的时刻（1.0.62，aa0b4610）
   *
   * NULL = 还没表态；有值 = 人按过「拒绝」。它与 approved 的区别
   * 不在"能不能写"（两种情况下它都不能写），而在**还在不在等人**：
   * 未表态的要计入红点催一下，被拒绝过的已结案，不该一直钉在那儿。
   *
   * 为什么不直接删掉这条身份记录：注册这件事**发生过**，而且它手上可能
   * 还握着凭据。删了之后它下次调用会重新注册一次，红点又亮起来 ——
   * 人清不掉它，界面上也看不出"我明明拒绝过这个东西"。
   */
  rejectedAt: string | null
  /** 是否已签发凭据（有凭据 = 调用时能自证身份，不再只是自称） */
  hasCredential: boolean
  createdAt: string
  lastSeenAt: string | null
  /** 审计：最近一次**写入**的时刻（读不算 —— 要回答的是"它动过我的数据吗"） */
  lastWriteAt: string | null
  /** 审计：最近一次写入用的是哪条命令 */
  lastWriteCmd: string | null
}

/**
 * 授权档位（1.0.36 起的四档里的两档高阶）
 *
 * 读写两档不进这张表：读免批，写由 `agents.approved` 一票长期有效。
 * 只有「改界面」和「删除」需要**逐次**点头，它们才有授权记录。
 */
export type GrantScope = 'config' | 'destructive'

/**
 * - pending：已申请、等人表态
 * - granted：已批准、可用
 * - consumed：一次性授权**已经用掉**（删除档用完即止，下次还得问）
 * - denied：人拒绝了
 * - revoked：批过之后又被收回
 */
export type GrantStatus = 'pending' | 'granted' | 'consumed' | 'denied' | 'revoked' | 'expired'

/**
 * 两个目标集合是否完全相同（v19）
 *
 * 用于回答"这次要动的东西，是不是当初批准的那一个"。做成集合语义而不是
 * 数组顺序比较：将来多目标动作（如删除父任务连带解绑子任务）的顺序
 * 不该影响判定 —— 她批准的是"这 N 条"，不是"按这个顺序这 N 条"。
 */
export function sameTargetSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const set = new Set(b)
  return a.every((x) => set.has(x))
}

/** 解析 target_ids 列：坏数据当空集合（宁可退回不校验，也不要让脏数据卡住流程） */
function parseTargetIds(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

export interface AgentGrant {
  id: string
  agentId: string
  scope: GrantScope
  /**
   * 绑定的会话（DESKPARTNER_SESSION）。
   * NULL = **不限会话**：长期授权，或调用方根本没带会话 id。
   */
  sessionId: string | null
  status: GrantStatus
  /** 触发这次申请的命令（如 `ui set` / `todo rm`）—— 审计时看得出它当时想干什么 */
  command: string | null
  /**
   * 申请目标的可读摘要（v18），如 `todo rm「某待办标题」`。
   *
   * 主用户 2026-09-22 指出：只给命令名，人没法判断这条该不该批 ——
   * "删一条测试残留"和"删掉看板上最重要的父需求"是两个完全不同的决定。
   * 与 command 分开存而不是拼进 command：command 是**结构化字段**
   * （撤销审计要按它归类），摘要是给人看的自由文本。
   */
  summary: string | null
  /**
   * 本次动作的**确切目标集合**（v19）。
   *
   * Bob 2026-09-22 实测的漏洞：授权不绑目标 → 「批准删 A」的授权
   * 被用来删掉了 B（退出码 0、deleted:true）。一次性授权的「一次」
   * 只在计数上成立、在目标上不成立。
   *
   * 空数组 = 这条授权没有目标概念（旧记录，或该命令解析不出目标）
   * → **不参与目标校验**，保证 `ui set` 这类命令行为不变。
   */
  targetIds: string[]
  /**
   * 申请时的**完整命令行**（v20），如 `["todo","rm","a1b2c3d4"]`。
   *
   * 1.0.45 起「批准」不再只是发一张许可证，而是**服务端当场把这件事做掉**
   * （主用户 2026-09-22 的架构判断）。执行发生在另一个进程、另一个时刻 ——
   * 用户点「允许」时发起申请的 agent 早已退出，所以动作必须能从这里重建。
   *
   * 原先只存 `command`（`todo rm`）是不够的：丢了参数就重建不出动作，
   * 而「删哪一条」全在参数里。
   */
  requestArgv: string[]
  /**
   * 批准后服务端执行的结果（v20）。
   *
   * - null：还没执行（含拒绝、还没表态）
   * - 'ok'：执行成功 —— 界面上要说清"删掉了什么"
   * - 'error'：执行失败 —— 界面上要说清"为什么没做成"
   *
   * 人在界面上点「允许」之后必须看得到**到底发生了什么**。没有这个字段，
   * 「批准」就成一个没有回执的动作，而人还以为自己完成了一次决策。
   */
  execStatus: 'ok' | 'error' | null
  /** 执行失败的原因（原样保留，便于人判断是不是重试就好） */
  execError: string | null
  /**
   * 执行成功的输出摘要（schema v25，收 10f0a5d6 最后一段）
   *
   * 与 exec_error 是同一件事的两面：**失败留原文、成功不该只留一个 'ok'**。
   * 取命令自带的那句人话 message（「评论已删除，连带清掉 2 条回复」这类），
   * 不是 stdout 原文、也不是被批准的命令 argv —— 审批流水要能一眼读出
   * "这次点头到底做成了什么"，而 argv 只能说明"批准了什么请求"。
   *
   * 存量数据没有这一列（v24 之前批准的动作），界面必须能降级显示。
   */
  execSummary: string | null
  executedAt: string | null
  createdAt: string
  resolvedAt: string | null
  /** 谁表的态。界面批准记 human —— 撤销与审计都要能追到"是人定的" */
  resolvedBy: string | null
  /** 会话级授权的到期时间；NULL = 不过期（长期） */
  expiresAt: string | null
}

export interface ListGrantsFilter {
  agentId?: string
  scope?: GrantScope
  status?: GrantStatus
  /** 只看还没失效的（pending/granted 且未过期） */
  activeOnly?: boolean
  limit?: number
}

/** 审批流水专用分页条件；offset/limit 在 SQLite 查询端应用。 */
export interface GrantHistoryFilter extends Omit<ListGrantsFilter, 'limit'> {
  offset: number
  execution?: 'ok' | 'error' | 'none'
  resolvedBy?: string
  createdFrom?: string
  createdUntil?: string
  agentQuery?: string
  limit: number
  from?: string
  until?: string
  query?: string
}

export interface GrantHistoryPage {
  rows: AgentGrant[]
  total: number
  offset: number
  limit: number
}

export type ApprovalHistoryType = 'agent' | 'grant' | 'profile' | 'protocol' | 'handoff' | 'rules'
export type ApprovalDecision = 'pending' | 'approved' | 'rejected' | 'expired' | 'revoked'
export type ApprovalExecution = 'success' | 'failure' | 'unknown' | 'not_required'

export interface ApprovalHistoryFilter {
  offset: number
  limit: number
  type?: ApprovalHistoryType
  decision?: ApprovalDecision
  execution?: ApprovalExecution
  agentQuery?: string
  projectId?: string
  from?: string
  until?: string
  query?: string
}

export interface ApprovalHistoryItem {
  id: string
  type: ApprovalHistoryType
  agentId: string
  agentName: string
  projectId: string | null
  createdAt: string
  activityAt: string
  decision: ApprovalDecision
  decidedBy: string | null
  decidedAt: string | null
  scope: string | null
  summary: string
  originalBody: string | null
  proposedBody: string | null
  decidedBody: string | null
  execution: ApprovalExecution
  execError: string | null
  execSummary: string | null
  requestArgv: string[]
}

export interface ApprovalHistoryPage {
  rows: ApprovalHistoryItem[]
  total: number
  offset: number
  limit: number
}

const APPROVAL_HISTORY_CTE = `
  WITH approval_events AS (
    SELECT g.id, 'grant' AS type, g.agent_id AS agent_id,
      COALESCE(a.display_name, g.agent_id) AS agent_name, NULL AS project_id,
      g.created_at AS created_at, COALESCE(g.resolved_at, g.executed_at, g.created_at) AS activity_at,
      CASE WHEN g.status = 'pending' AND g.expires_at IS NOT NULL AND g.expires_at <= @now THEN 'expired'
        WHEN g.status = 'pending' THEN 'pending' WHEN g.status IN ('granted','consumed') THEN 'approved'
        WHEN g.status = 'denied' THEN 'rejected' WHEN g.status = 'revoked' THEN 'revoked' ELSE 'expired' END AS decision,
      g.resolved_by AS decided_by, g.resolved_at AS decided_at, g.scope AS scope,
      COALESCE(g.summary, g.command, '操作授权') AS summary,
      NULL AS original_body, NULL AS proposed_body, NULL AS decided_body,
      CASE WHEN g.exec_status = 'ok' THEN 'success' WHEN g.exec_status = 'error' THEN 'failure'
        WHEN g.status IN ('granted','consumed') AND g.scope = 'destructive' THEN 'unknown' ELSE 'not_required' END AS execution,
      g.exec_error AS exec_error, g.exec_summary AS exec_summary, g.request_argv AS request_argv
    FROM agent_grants g LEFT JOIN agents a ON a.id = g.agent_id
    UNION ALL
    SELECT p.id, 'profile', p.proposer, p.proposer, p.project_id, p.created_at,
      COALESCE(p.decided_at, p.created_at), p.status, p.decided_by, p.decided_at, p.scope,
      '档案提议 · ' || p.block_key, p.original_body, p.body, p.decided_body,
      'not_required', NULL, NULL, NULL FROM profile_proposals p
    UNION ALL
    SELECT p.id, 'protocol', p.proposer, p.proposer, p.project_id, p.created_at,
      COALESCE(p.decided_at, p.created_at), p.status, p.decided_by, p.decided_at, p.scope,
      '协议提议 · ' || p.block_key, p.original_body, p.body, p.decided_body,
      'not_required', NULL, NULL, NULL FROM protocol_proposals p
    UNION ALL
    SELECT p.id, 'handoff', p.proposer, COALESCE(a.display_name, p.proposer), p.project_id, p.created_at,
      COALESCE(p.decided_at, p.created_at), p.status, p.decided_by, p.decided_at, 'project',
      '接手说明提议 · ' || pr.name, p.original_body, p.body, p.decided_body,
      'not_required', NULL, NULL, NULL
    FROM project_handoff_proposals p
    JOIN projects pr ON pr.id = p.project_id
    LEFT JOIN agents a ON a.id = p.proposer
    UNION ALL
    SELECT p.id, 'rules', p.proposer, COALESCE(a.display_name, p.proposer), p.project_id, p.created_at,
      COALESCE(p.decided_at, p.created_at), p.status, p.decided_by, p.decided_at, p.scope,
      '协作规则提议 · ' || p.rule_key,
      CAST(p.original_enforcement AS TEXT), CAST(p.proposed_enforcement AS TEXT), CAST(p.decided_enforcement AS TEXT),
      'not_required', NULL, NULL, NULL
    FROM rule_proposals p LEFT JOIN agents a ON a.id = p.proposer
    UNION ALL
    SELECT e.id, 'agent', e.agent_id, e.agent_name, NULL, e.created_at, e.created_at,
      CASE e.action WHEN 'registered' THEN 'pending' WHEN 'approved' THEN 'approved'
        WHEN 'rejected' THEN 'rejected' WHEN 'revoked' THEN 'revoked' ELSE 'pending' END,
      CASE WHEN e.action = 'registered' THEN NULL ELSE e.actor END,
      CASE WHEN e.action = 'registered' THEN NULL ELSE e.created_at END,
      NULL, 'Agent 接入 · ' || e.action,
      NULL, NULL, NULL, 'not_required', NULL, NULL, NULL
    FROM agent_approval_events e
  )
`

const mapApprovalHistoryRow = (row: Record<string, unknown>): ApprovalHistoryItem => ({
  id: String(row.id),
  type: row.type as ApprovalHistoryType,
  agentId: String(row.agent_id),
  agentName: String(row.agent_name ?? row.agent_id),
  projectId: (row.project_id as string | null) ?? null,
  createdAt: String(row.created_at),
  activityAt: String(row.activity_at),
  decision: row.decision as ApprovalDecision,
  decidedBy: (row.decided_by as string | null) ?? null,
  decidedAt: (row.decided_at as string | null) ?? null,
  scope: (row.scope as string | null) ?? null,
  summary: String(row.summary ?? ''),
  originalBody: (row.original_body as string | null) ?? null,
  proposedBody: (row.proposed_body as string | null) ?? null,
  decidedBody: (row.decided_body as string | null) ?? null,
  execution: row.execution as ApprovalExecution,
  execError: (row.exec_error as string | null) ?? null,
  execSummary: (row.exec_summary as string | null) ?? null,
  requestArgv: (() => { try { const parsed = JSON.parse(String(row.request_argv ?? '[]')); return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [] } catch { return [] } })()
})

/**
 * 会话级授权的有效期（8 小时）
 *
 * "仅本次会话有效"在无人值守的调用里没有可靠的"会话结束"信号
 * （agent 不报告自己退出了），所以用一个够长、但也有尽头的时间窗近似：
 * 覆盖一整个工作日，睡一觉起来授权就没了。
 */
export const SESSION_GRANT_TTL_MS = 8 * 60 * 60 * 1000

/**
 * 一次性（删除档）授权**批准之后**的可用窗口（30 分钟）
 *
 * "允许这一次"是**当下**的意思：人点了头、服务端当场执行、随即销账。
 * 这个窗口实际只在"执行失败、库里留一条可重试的授权"时才用得上 ——
 * 而那时 agent 就在跟前等结果，不需要搁一天。
 */
export const ONCE_GRANT_TTL_MS = 30 * 60 * 1000

/**
 * **待表态**申请的寿命（24 小时；2026-09-24 由 30 分钟放宽）
 *
 * 主用户实测痛点：她白天不在电脑前，agent 半夜发起的申请 30 分钟就过期，
 * 她早上醒来看到的是"又过期了"，于是 agent 只能反复重发 ——
 * 授权列表里堆了一串作废记录，两边都被这件事拖住。
 *
 * 为什么现在敢放宽：1.0.45 起「批准即执行」—— 人点允许时服务端**当场**执行，
 * 不存在"一条旧授权躺在库里等被用掉"。而短寿命原本要防的正是这个
 * （申请搁久了，人忘了自己批的是什么）。安全闸门始终是"人点那一下"，
 * 不是"申请过期得快"。所以窗口长度与安全性无关，只与人的作息有关。
 *
 * ⚠️ 与 ONCE_GRANT_TTL_MS 的分工别搞混：这个管"从申请到被表态"，
 * 那个管"从批准到被用掉"。两个窗口服务的是不同的等待者（人 / agent）。
 */
export const PENDING_GRANT_TTL_MS = 24 * 60 * 60 * 1000

export interface RegisterAgentInput {
  id: string
  displayName: string
  color?: string | null
  /**
   * 原始注册时间（**只给备份导入用**，1.0.46）
   *
   * 不传取当下 —— 普通注册就是"此刻它来了"。
   * 导入要还原的是"它当时注册的"，否则恢复环境后所有身份的
   * 注册时间都变成导入那一刻，`list()` 的先后顺序（谁先来谁在前）
   * 与界面上的"加入时间"一起失真。
   */
  createdAt?: string
}

export class AgentRepository {
  private get db() {
    return getDatabase()
  }

  /**
   * 注册（已存在则只更新展示信息，不动注册时间 —— 重复调用不该把"老用户"刷成"新注册"）
   *
   * ⚠️ 1.0.35 起**新注册默认未批准**（approved=0）：拿到身份不等于拿到写权限，
   * 得人在界面上点头。此前默认 1，等于"自称一下就能写"。
   */
  register(input: RegisterAgentInput): Agent {
    const id = input.id.trim()
    const displayName = input.displayName.trim()
    if (!id) throw new UsageError('agent id 不能为空')
    if (!displayName) throw new UsageError('agent displayName 不能为空')

    const now = new Date().toISOString()
    const existing = this.get(id)

    if (existing) {
      const color = input.color ?? existing.color
      this.db.prepare(`UPDATE agents SET display_name = ?, color = ? WHERE id = ?`).run(displayName, color, id)
      return { ...existing, displayName, color }
    }

    const color = input.color ?? null
    const createdAt = input.createdAt ?? now
    const insert = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO agents (id, display_name, color, approved, created_at, last_seen_at)
           VALUES (?, ?, ?, 0, ?, ?)`
        )
        .run(id, displayName, color, createdAt, now)
      this.recordApprovalEvent(id, displayName, 'registered', id)
    })
    insert()

    return {
      id,
      displayName,
      color,
      approved: false,
      rejectedAt: null,
      hasCredential: false,
      createdAt,
      lastSeenAt: now,
      lastWriteAt: null,
      lastWriteCmd: null
    }
  }

  /**
   * 签发（或重发）凭据
   *
   * 明文只在返回值里出现这一次 —— 仓库只存哈希。
   * 重发会让旧凭据立即失效：凭据泄露、换机器、想收回访问权限时用它。
   */
  issueCredential(id: string): { agentId: string; token: string } | null {
    if (!this.get(id)) return null
    const token = generateToken()
    this.db
      .prepare(`UPDATE agents SET credential_hash = ? WHERE id = ?`)
      .run(hashToken(token), id)
    return { agentId: id, token }
  }

  /**
   * 校验凭据：库里没有哈希、或带过来的对不上，都算不通过
   *
   * 不做"没凭据也给过"的宽容 —— 那等于把锁又拆了。
   */
  verifyCredential(id: string, token: string): boolean {
    const row = this.db
      .prepare(`SELECT credential_hash AS hash FROM agents WHERE id = ?`)
      .get(id) as { hash: string | null } | undefined
    if (!row?.hash) return false
    return row.hash === hashToken(token)
  }

  get(id: string): Agent | null {
    const row = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined
    return row ? AgentRepository.mapRow(row) : null
  }

  /**
   * 按注册时间正序：谁先来谁在前
   *
   * `id ASC` 是**兜底次序键**（1.0.109，修 `9536f9c3`）：同一毫秒注册的两个身份，
   * 只按 `created_at` 排时谁在前由 SQLite 的隐式顺序说了算 —— 这是给界面和
   * `agent list` 的清单，同一份库两次可能给出不同顺序。
   * 兜底键用 `id` 而不是 `rowid`：主键是 TEXT，`rowid` 只是隐藏列、`VACUUM`
   * 之后可以重编号（同文件 `listGrants` / `listGrantHistory` 是同一套做法）。
   */
  list(): Agent[] {
    const rows = this.db.prepare('SELECT * FROM agents ORDER BY created_at ASC, id ASC').all() as Record<
      string,
      unknown
    >[]
    return rows.map(AgentRepository.mapRow)
  }

  /**
   * 心跳：记下"最近一次见到它"。
   * 未注册的标识直接忽略 —— 它还没身份，不该在这里被凭空创建出来。
   */
  touch(id: string): void {
    if (!this.get(id)) return
    this.db.prepare(`UPDATE agents SET last_seen_at = ? WHERE id = ?`).run(new Date().toISOString(), id)
  }

  setApproved(id: string, approved: boolean): Agent | null {
    const current = this.get(id)
    if (!current) return null
    if (current.approved === approved) return current
    const action = approved ? 'approved' : 'revoked'
    const tx = this.db.transaction(() => {
      // 批准时同时清除拒绝状态；撤销写入不等于移除身份。
      if (approved) this.db.prepare(`UPDATE agents SET approved = 1, rejected_at = NULL WHERE id = ?`).run(id)
      else this.db.prepare(`UPDATE agents SET approved = 0 WHERE id = ?`).run(id)
      this.recordApprovalEvent(id, current.displayName, action, 'human')
    })
    tx()
    return this.get(id)
  }

  /**
   * 拒绝一个尚未批准的身份（1.0.62，aa0b4610）
   *
   * 此前"我不想批准它"这个最常见也最正当的决定，在界面上没有任何对应动作 ——
   * 唯一的按钮是「批准」。于是那个未批准的身份一直计进红点：
   * 只要它还在，角标就一直在，而人拿它一点办法都没有。
   * 一个只增不减的信号会很快被人学会忽略，那时候红点连"还能报警"都做不到了。
   *
   * 拒绝与批准的差别在**是否结案**：两者都不能写，差别是
   * 未批准 = 还在等你、拒绝 = 已经决定了不要。
   *
   * ⚠️ 不做物理删除：它的凭据可能还在外面，删掉只会被重新注册回来，
   * 到时候界面上连"我拒绝过"都看不出来（这也是 rejected_at 存在的理由）。
   */
  setRejected(id: string, rejected: boolean): Agent | null {
    const current = this.get(id)
    if (!current) return null
    if (Boolean(current.rejectedAt) === rejected) return current
    const action = rejected ? 'rejected' : 'reopened'
    const tx = this.db.transaction(() => {
      this.db
        .prepare(`UPDATE agents SET rejected_at = ?, approved = 0 WHERE id = ?`)
        .run(rejected ? new Date().toISOString() : null, id)
      this.recordApprovalEvent(id, current.displayName, action, 'human')
    })
    tx()
    return this.get(id)
  }

  private recordApprovalEvent(
    agentId: string,
    agentName: string,
    action: 'registered' | 'approved' | 'rejected' | 'revoked' | 'reopened',
    actor: string
  ): void {
    this.db.prepare(`
      INSERT INTO agent_approval_events (id, agent_id, agent_name, action, actor, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), agentId, agentName, action, actor, new Date().toISOString())
  }

  /**
   * 审计：记下"它刚刚写了一次"
   *
   * 只记写入、不记读取 —— 界面上那句"上次动你的数据是什么时候"要能一眼回答，
   * 掺进成百上千条查询就失去了意义。命令名一并记下：
   * "最近一次是 todo rm" 比 "最近活跃 10:03" 有用得多。
   */
  markWrite(id: string, cmd: string): void {
    if (!this.get(id)) return
    this.db
      .prepare(`UPDATE agents SET last_write_at = ?, last_write_cmd = ? WHERE id = ?`)
      .run(new Date().toISOString(), cmd, id)
  }

  // ── 授权记录（改界面 / 删除 两档高阶权限）──

  /**
   * 申请授权
   *
   * 同一 (身份, 档位, 会话) 已有待表态的申请时**复用它**，不再新建 ——
   * 否则一个循环里重试十次的 agent 会在界面上堆出十条一模一样的请求，
   * 人点掉一条、剩下九条还挂着，看着像"它申请了十次"。
   */
  requestGrant(input: {
    agentId: string
    scope: GrantScope
    command?: string | null
    /** 目标摘要（v18）：写进授权记录，让审批列表也能说清"申请的是什么" */
    summary?: string | null
    /** 目标集合（v19）：执行时据此校验"批的"和"做的"是不是同一件事 */
    targetIds?: string[]
    /** 完整命令行（v20）：批准即执行时靠它重建动作 */
    requestArgv?: string[]
    sessionId?: string | null
  }): AgentGrant {
    const now = new Date().toISOString()
    const incomingTargets = input.targetIds ?? []
    /**
     * 复用候选：**同身份 + 同档位 + 同会话 + 同命令**的待批申请。
     *
     * ⚠️ `command` 必须进筛选条件，不能留到后面再判"变了就不复用"。
     * 一旦允许"命令不同"也进入复用分支，同一会话里就可能同时存在多条
     * 待批申请（`ui set` 一条、`ui reset` 一条），而 `.find()` 只取**第一条**：
     * 于是第二次发 `ui reset` 时可能拿 `ui set` 那条去比、判定"命令变了"、
     * 又新建一条 —— 变成"重试一次多一条申请"，比原缺陷更难收拾。
     * 先按命令筛，候选就恒定唯一，重试永远落在自己那条上。
     */
    const existing = this.listGrants({
      agentId: input.agentId,
      scope: input.scope,
      status: 'pending',
      activeOnly: true
    }).find(
      (g) =>
        (g.sessionId ?? null) === (input.sessionId ?? null) &&
        (g.command ?? null) === (input.command ?? null)
    )

    if (existing) {
      /**
       * 🚨 **命令不同就不复用** —— 已落在上面的候选筛选里（1.0.65 修 `b951b6b0`）。
       *
       * 此前复用只按 (身份, 档位, 会话) 找待批那条，外加"目标没变"这一条；
       * **命令名压根没参与判断**。于是同一会话里先 `ui set` 再 `ui reset`，
       * 第二条被并进了第一条，而复用时只刷 `summary` 与 `request_argv`
       * —— `command` 那一列保持旧值。结果是一条**自相矛盾的授权记录**：
       * `command="ui set"` 而 `requestArgv=["ui reset", ...]`。
       *
       * 为什么这不只是"字段不整齐"，而是人点了空：
       * 批准即执行按 `requestArgv` 重建动作，回放时 `assertScopeAllowed`
       * 又拿 `command` 与实际命令比对 —— 两者对不上，那条授权当场判为
       * 「不能用于这次动作」，回放失败。**人点了一次「允许」，什么都没发生**，
       * 而申请本身还留着 granted 状态，看上去一切正常。
       *
       * 判据是"**一条申请 = 一次动作**"。复用只允许发生在"同一个动作被重复问"
       * 时（agent 重试），而"换了命令"就是另一件事，必须让她单独看见、单独点头。
       *
       * ⚠️ 别把它改成"复用时顺手把 command 也刷成新的"—— 那等于让一条
       * 已经生成、可能已经被她在审批区看过一眼的申请**中途换了内容**，
       * 她点头时想的还是原来那个命令。这里选择另落一条，代价是多一行待批。
       */

      /**
       * 目标变了就**不复用**，另落一条申请（v19）。
       *
       * 复用本意是"同一会话里重试十次别堆十条一样的申请"。但如果这次要动的
       * 东西和待批那条不是同一个（先申请删 A 被晾着、改去删 B），复用等于
       * 把她的决议对象**悄无声息地换掉** —— 她批的是 A，我们执行的是 B。
       * 所以目标不同就新建，老申请留着让她自己处理（撤销或忽略）。
       *
       * 任一方没有目标（旧记录 / 解析不出目标的命令）→ 按老规矩复用，
       * 保证 `ui set` 这类命令的行为完全不变。
       */
      const targetsChanged =
        existing.targetIds.length > 0 &&
        incomingTargets.length > 0 &&
        !sameTargetSet(existing.targetIds, incomingTargets)

      if (!targetsChanged) {
        /**
         * 复用已有申请时**补一次摘要**：同一会话里重试的命令可能换了目标
         * （先删 A 被拒、改删 B 再来），而旧记录里存的是 A 的标题。
         * 人看到的是最新那条，就该显示最新的目标 —— 只增不改会让审批列表
         * 说一个已经不作数的对象，比不显示更误导。
         *
         * v20 起**同时补 argv**：批准即执行靠 request_argv 重建动作，
         * 留着旧 argv 会执行上一轮那次（可能是已被否掉的目标）。
         * 摘要与 argv 必须一起更新，否则界面说的是 B、执行的是 A。
         */
        const newSummary = input.summary && input.summary !== existing.summary ? input.summary : null
        const newArgv =
          input.requestArgv?.length &&
          input.requestArgv.join('\u0000') !== existing.requestArgv.join('\u0000')
            ? input.requestArgv
            : null

        /**
         * 复用时**顺延待表态窗口**（1.0.49）
         *
         * 复用意味着"agent 还在等这一件事"，那它的有效期就该从**最后一次**
         * 发问算起，而不是从第一次。否则会出现最糟的组合：半夜发起、人在睡觉、
         * agent 隔一会儿重试一次（每次都复用同一条），窗口却始终按第一次算 ——
         * 人早上醒来看到的还是一条已过期的申请，重试多少次都救不回来。
         *
         * 与摘要/argv 的刷新同一个道理：复用要表达"最新一次的问法"。
         * 改这里别只动 expires_at 而漏掉那两列 —— 界面说的是 A、
         * 执行的是 B，那种错比对不上时间更难查。
         */
        this.db
          .prepare(
            `UPDATE agent_grants
                SET summary = COALESCE(?, summary),
                    request_argv = COALESCE(?, request_argv),
                    expires_at = ?
              WHERE id = ?`
          )
          .run(
            newSummary,
            newArgv ? JSON.stringify(newArgv) : null,
            new Date(Date.now() + PENDING_GRANT_TTL_MS).toISOString(),
            existing.id
          )
        return this.getGrant(existing.id)!
      }
    }

    const id = randomUUID()
    this.db
      .prepare(
        `INSERT INTO agent_grants
           (id, agent_id, scope, session_id, status, command, summary, target_ids,
            request_argv, created_at, expires_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.agentId,
        input.scope,
        input.sessionId ?? null,
        input.command ?? null,
        input.summary ?? null,
        JSON.stringify(incomingTargets),
        input.requestArgv?.length ? JSON.stringify(input.requestArgv) : null,
        now,
        // 待表态窗口 24 小时：人的作息是小时级，不该被 30 分钟的申请寿命支配
        new Date(Date.now() + PENDING_GRANT_TTL_MS).toISOString()
      )
    return this.getGrant(id)!
  }

  /**
   * 找一条**当前可用**的授权 —— 严格按「命令 + 目标」双绑定
   *
   * 有效期与会话绑定都在这里判，调用方不该各自拼这套条件 ——
   * 少判一条 expires_at 就等于"会话结束还放行"。
   *
   * @param command 本次要执行的命令名（如 `todo rm`）。
   *   🚨 **必传，且这是 2026-09-23 修掉的一个真实漏洞**（Bob d290ae7b 实测）：
   *   原先只按 `scope` 匹配，于是「批准删这条待办」放行了一次「删分类」——
   *   两条命令同在 destructive 档，授权就被跨命令复用了。
   *   用户批准的是**一件具体的事**，不是一个"删除额度"。
   *   实测佐证：库里 `category rm` / `project rm` 的授权 `target_ids` 全为空，
   *   加上「任一方为空即不校验」的旧规则，等于同档位内可以随便换命令用。
   *
   * @param targetIds 本次动作的目标集合（v19）。
   *
   *   传了它、且候选授权也记了目标时，**目标不一致的授权不算可用** ——
   *   这是堵Bob实测那个漏洞的关键：它申请删 A 并获批，随后用那条授权
   *   删掉了 B（退出码 0、deleted:true）。没有这一步校验，
   *   "批准删除这条"实际等于"30 分钟内允许删任意一条"。
   *
   *   ⚠️ 任一方为空即不校验（旧记录 / 解析不出目标的命令），保证 `ui set`
   *   这类命令的行为完全不变 —— 收紧只在"能确认目标"的前提下生效。
   *   **命令维度的校验（上面的 command）没有这个豁免**：命令名永远知道。
   *
   * `id DESC` 是**兜底次序键**（1.0.109，修 `9536f9c3`）：同刻两条都可用时，
   * 上面"取多条再循环挑第一条对得上的"实际是在**挑一条来用掉**（一次性授权用完即止），
   * 而只按 `created_at` 排时，同刻两条谁在前由 SQLite 的隐式顺序说了算 ——
   * "用掉哪条"就成了不可预测的。兜底键与同文件 `listGrants` / `listGrantHistory` 同一套。
   */
  findUsableGrant(
    agentId: string,
    scope: GrantScope,
    sessionId: string | null | undefined,
    command: string,
    targetIds?: string[]
  ): AgentGrant | null {
    /**
     * 取**多条**而不是 LIMIT 1：目标不符的那条要能被跳过，
     * 后面可能还躺着一条真正对得上的（比如她为 A 批过一次、又为 B 批过一次）。
     */
    const rows = this.db
      .prepare(
        `SELECT * FROM agent_grants
          WHERE agent_id = ? AND scope = ? AND status = 'granted'
            AND (session_id IS NULL OR session_id = ?)
            AND (expires_at IS NULL OR expires_at > ?)
          ORDER BY created_at DESC, id DESC`
      )
      .all(agentId, scope, sessionId ?? null, new Date().toISOString()) as Record<
      string,
      unknown
    >[]

    const wants = targetIds ?? []
    for (const row of rows) {
      const g = AgentRepository.mapGrant(row)
      /**
       * 命令必须一致。`command` 在库里可空（旧记录），此时**不豁免** ——
       * 认不出命令的授权不足以放行任何动作，让 agent 重新申请一次，
       * 代价是它多问一句；放错的代价是删错东西。
       */
      if ((g.command ?? '') !== command) continue
      const hasTargets = g.targetIds.length > 0 && wants.length > 0
      if (hasTargets && !sameTargetSet(g.targetIds, wants)) continue
      return g
    }
    return null
  }

  /**
   * 某一档位**是否还有未过期的授权**（粗粒度，只给 whoami 自报用）
   *
   * 为什么不复用 `findUsableGrant`：那个要求指明"要做什么"（命令 + 目标），
   * 而 `agent whoami` 的问题只是"我这一档还有没有牌"，它没有具体动作可指。
   * 两者语义不同就该是两个方法 —— 用一个带默认值的参数把两种语义塞进
   * 同一个函数，正是上面那个漏洞的成因。
   *
   * 返回命中的那条授权的 `sessionId`（而不是 boolean）：`whoami` 要能
   * 区分"长期授权"和"只在本会话有效"，两者在自报里说法不同。
   *
   * 🚨 **一并带出 `execStatus` / `execError`**（1.0.65 修 `b74d9fb3`）：
   * 只回 `session_id` 时，whoami 无从知道"这条授权上一次执行是失败的"，
   * 于是把"上次删项目失败了"也报成 `destructive=once`（= 我还能删）。
   * agent 据此往下走，直到真删时才撞墙。**字段齐了不等于结论对** ——
   * 判据得从"有没有记录"升级到"记录现在是什么下场"。
   *
   * `id DESC` 是**兜底次序键**（1.0.109，修 `9536f9c3`）：同刻两条仍有效时，
   * 取 `LIMIT 1` 自报的是哪一条（长期牌还是本会话牌、上次 `ok` 还是 `error`）
   * 会随 SQLite 的隐式顺序在两个结论之间跳 —— 而 whoami 自报的这句话正是
   * agent 用来决定"继续做"还是"先重试"的凭据。
   *
   * ⚠️ **门禁不得调用本方法**：它不看命令、不看目标，拿它放行等于
   * "有牌就能随便用"。
   */
  findAnyUsableGrant(
    agentId: string,
    scope: GrantScope,
    sessionId?: string | null
  ): { sessionId: string | null; execStatus: 'ok' | 'error' | null; execError: string | null } | null {
    const row = this.db
      .prepare(
        `SELECT session_id, exec_status, exec_error FROM agent_grants
          WHERE agent_id = ? AND scope = ? AND status = 'granted'
            AND (session_id IS NULL OR session_id = ?)
            AND (expires_at IS NULL OR expires_at > ?)
          ORDER BY created_at DESC, id DESC
          LIMIT 1`
      )
      .get(agentId, scope, sessionId ?? null, new Date().toISOString()) as
      | { session_id: string | null; exec_status: 'ok' | 'error' | null; exec_error: string | null }
      | undefined
    if (!row) return null
    return {
      sessionId: row.session_id ?? null,
      execStatus: row.exec_status ?? null,
      execError: row.exec_error ?? null
    }
  }

  /**
   * 某一档位**最近一条**授权（不论状态），给 whoami 说清"为什么没有可用牌"
   *
   * 🚨 为什么必须有它（1.0.65 修 `b74d9fb3`）：`findAnyUsableGrant` 只看
   * granted，于是"从没申请过"和"申请了但已被消费/撤销/过期/拒绝"
   * 返回的是同一个 null —— agent 看到 `destructive=no`，无法区分
   * "我还没申请过（去申请）"和"我的牌用掉了（必须重新申请）"。
   * 后者若被误当成前者，agent 会以为自己还有牌、或反过来反复重试已失效的东西。
   *
   * `id DESC` 是**兜底次序键**（1.0.109，修 `9536f9c3`）：同刻两条不同下场
   * （一条 `consumed`、一条 `denied`）时，取 `LIMIT 1` 给出的"为什么"会跳。
   *
   * 只给自检用，**门禁不得调用**（同 `findAnyUsableGrant`：它不判可用性）。
   */
  findLatestGrant(agentId: string, scope: GrantScope): AgentGrant | null {
    const row = this.db
      .prepare(
        `SELECT * FROM agent_grants
          WHERE agent_id = ? AND scope = ?
          ORDER BY created_at DESC, id DESC
          LIMIT 1`
      )
      .get(agentId, scope) as Record<string, unknown> | undefined
    return row ? AgentRepository.mapGrant(row) : null
  }

  /**
   * 记下「批准即执行」这次动作的结果（v20）
   *
   * 主用户 2026-09-22 的判断把审批从"发许可证"改成"当场做掉"，
   * 那么做完之后必须**留下回执** —— 人在界面上点了允许，
   * 得能看到到底删掉了什么、或者为什么没删成。
   * 没有这一步，「批准」是个没有回音的动作，而人以为决策已经落地。
   *
   * 状态不在这里改：一次性授权的销账由 executeOne 的成功路径负责
   * （命令真的成功才置 consumed），与 agent 路径同源，
   * 免得同一件事有两套"什么时候算用掉"的判定。
   */
  recordGrantExecution(
    id: string,
    ok: boolean,
    error?: string | null,
    summary?: string | null
  ): void {
    if (!this.getGrant(id)) return
    this.db
      .prepare(
        `UPDATE agent_grants
            SET exec_status = ?, exec_error = ?, exec_summary = ?, executed_at = ?
          WHERE id = ?`
      )
      .run(ok ? 'ok' : 'error', error ?? null, summary ?? null, new Date().toISOString(), id)
  }

  /**
   * 人表态：allow=false 记 denied，allow=true 记 granted
   *
   * `longTerm` 只由界面在"长期允许"按钮里传 —— 默认给的是会话级。
   * 长期授权同时解开会话绑定（session_id 置 NULL）：既然不限时间，
   * 再绑一个会话 id 只会造成"换个对话就突然不能用了"的困惑。
   */
  resolveGrant(
    id: string,
    allow: boolean,
    opts: { longTerm?: boolean } = {}
  ): AgentGrant | null {
    const g = this.getGrant(id)
    if (!g) return null
    const now = new Date().toISOString()

    if (!allow) {
      this.db
        .prepare(`UPDATE agent_grants SET status = 'denied', resolved_at = ?, resolved_by = 'human' WHERE id = ?`)
        .run(now, id)
      return this.getGrant(id)
    }

    const long = opts.longTerm === true
    const ttl = g.scope === 'config' ? SESSION_GRANT_TTL_MS : ONCE_GRANT_TTL_MS
    this.db
      .prepare(
        `UPDATE agent_grants
            SET status = 'granted', resolved_at = ?, resolved_by = 'human',
                session_id = ?, expires_at = ?
          WHERE id = ?`
      )
      .run(
        now,
        long ? null : g.sessionId,
        long ? null : new Date(Date.now() + ttl).toISOString(),
        id
      )
    return this.getGrant(id)
  }

  /** 一次性授权用掉即止（删除档）—— 下次还得重新问 */
  consumeGrant(id: string): void {
    this.db
      .prepare(`UPDATE agent_grants SET status = 'consumed', resolved_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), id)
  }

  /**
   * 撤销：把还没用掉的授权（pending / granted）一次性收回
   *
   * 已经发生的（consumed/denied）不动 —— 那是历史，撤回它等于改账本。
   */
  revokeGrants(agentId: string, scope?: GrantScope): number {
    const now = new Date().toISOString()
    const sql = scope
      ? `UPDATE agent_grants SET status = 'revoked', resolved_at = ?, resolved_by = 'human'
           WHERE agent_id = ? AND scope = ? AND status IN ('pending','granted')`
      : `UPDATE agent_grants SET status = 'revoked', resolved_at = ?, resolved_by = 'human'
           WHERE agent_id = ? AND status IN ('pending','granted')`
    const params = scope ? [now, agentId, scope] : [now, agentId]
    return this.db.prepare(sql).run(...params).changes
  }

  getGrant(id: string): AgentGrant | null {
    const row = this.db.prepare('SELECT * FROM agent_grants WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined
    return row ? AgentRepository.mapGrant(row) : null
  }

  listGrants(filter: ListGrantsFilter = {}): AgentGrant[] {
    const { where, params } = this.grantWhere(filter)
    /**
     * `id DESC` 是**兜底次序键**（1.0.109，修 `1486836d`）：同一毫秒建的两条
     * 只按 `created_at` 排时，谁在前由 SQLite 的隐式顺序说了算 ——
     * 同一份库、同样的调用，两次可能给出不同顺序。这是给 agent 读的回执，
     * 要"取最新那条"或逐条对照时会读错人。
     * 同文件 `listGrantHistory` 早就这么写（`ORDER BY … DESC, id DESC`）。
     */
    const sql = `SELECT * FROM agent_grants${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, id DESC${filter.limit ? ` LIMIT ${Math.max(1, Math.floor(filter.limit))}` : ''}`
    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[]
    return rows.map(AgentRepository.mapGrant)
  }

  /**
   * 符合条件的授权记录**总数**（1.0.107，修 `99be5ae7`）
   *
   * `listGrants` 只给一页，不告诉调用方"一共多少" —— 于是"默认有界"的命令
   * 没法在回执里自报 `matched`，调用方只能靠"数组长度小于 limit"反推还有没有下一页，
   * 而那在**恰好整除**时是错的（正好回满 limit 条时，其实还有下一页）。
   *
   * ⚠️ 与 `listGrants` 共用同一份 `grantWhere` —— 计数与取页不同源的话，
   * `truncated` 就成了两份筛选条件凑出来的猜测。
   */
  countGrants(filter: ListGrantsFilter = {}): number {
    const { where, params } = this.grantWhere(filter)
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM agent_grants${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`)
      .get(...params) as { n: number }
    return row.n
  }

  /** 审批流水的完整总数与一页数据由 SQLite 查询，绝不先取固定数量再前端分页。 */
  listGrantHistory(filter: GrantHistoryFilter): GrantHistoryPage {
    const boundedLimit = Math.max(1, Math.min(100, Math.floor(filter.limit) || 20))
    const boundedOffset = Math.max(0, Math.floor(filter.offset) || 0)
    const { where, params } = this.grantWhere(filter)
    if (filter.execution === 'ok') where.push(`exec_status = 'ok'`)
    if (filter.execution === 'error') where.push(`exec_status = 'error'`)
    if (filter.execution === 'none') where.push(`exec_status IS NULL`)
    if (filter.resolvedBy) { where.push('resolved_by = ?'); params.push(filter.resolvedBy) }
    if (filter.createdFrom) { where.push('created_at >= ?'); params.push(filter.createdFrom) }
    if (filter.createdUntil) { where.push('created_at <= ?'); params.push(filter.createdUntil) }
    if (filter.agentQuery?.trim()) {
      const q = `%${filter.agentQuery.trim()}%`
      where.push(`(agent_id LIKE ? OR summary LIKE ? OR command LIKE ?)`)
      params.push(q, q, q)
    }
    const clause = where.length ? ` WHERE ${where.join(' AND ')}` : ''
    const totalRow = this.db.prepare(`SELECT COUNT(*) AS total FROM agent_grants${clause}`).get(...params) as { total: number }
    const rows = this.db.prepare(
      `SELECT * FROM agent_grants${clause} ORDER BY COALESCE(resolved_at, executed_at, created_at) DESC, id DESC LIMIT ? OFFSET ?`
    ).all(...params, boundedLimit, boundedOffset) as Record<string, unknown>[]
    return { rows: rows.map(AgentRepository.mapGrant), total: totalRow.total, offset: boundedOffset, limit: boundedLimit }
  }

  /** 六类审批对象共用一份服务端分页历史；旧 agent 审批不会由当前状态伪造回填。 */
  listApprovalHistory(filter: ApprovalHistoryFilter): ApprovalHistoryPage {
    const boundedLimit = Math.max(1, Math.min(100, Math.floor(filter.limit) || 20))
    const boundedOffset = Math.max(0, Math.floor(filter.offset) || 0)
    const where: string[] = []
    const params: Record<string, unknown> = { now: new Date().toISOString() }
    if (filter.type) { where.push('type = @type'); params.type = filter.type }
    if (filter.decision) { where.push('decision = @decision'); params.decision = filter.decision }
    if (filter.execution) { where.push('execution = @execution'); params.execution = filter.execution }
    if (filter.agentQuery?.trim()) {
      where.push('(agent_id LIKE @agent OR agent_name LIKE @agent)')
      params.agent = `%${filter.agentQuery.trim()}%`
    }
    if (filter.projectId) {
      where.push('(project_id = @projectId OR (type = \'grant\' AND summary LIKE @projectQuery))')
      params.projectId = filter.projectId
      params.projectQuery = `%${filter.projectId}%`
    }
    if (filter.from) { where.push('activity_at >= @from'); params.from = filter.from }
    if (filter.until) { where.push('activity_at <= @until'); params.until = filter.until }
    if (filter.query?.trim()) {
      where.push('(id LIKE @query OR agent_id LIKE @query OR agent_name LIKE @query OR summary LIKE @query OR proposed_body LIKE @query OR original_body LIKE @query)')
      params.query = `%${filter.query.trim()}%`
    }
    const clause = where.length ? ` WHERE ${where.join(' AND ')}` : ''
    const total = this.db.prepare(`${APPROVAL_HISTORY_CTE} SELECT COUNT(*) AS total FROM approval_events${clause}`).get(params) as { total: number }
    const rows = this.db.prepare(`${APPROVAL_HISTORY_CTE} SELECT * FROM approval_events${clause} ORDER BY activity_at DESC, id DESC LIMIT @limit OFFSET @offset`)
      .all({ ...params, limit: boundedLimit, offset: boundedOffset }) as Record<string, unknown>[]
    return { rows: rows.map(mapApprovalHistoryRow), total: total.total, offset: boundedOffset, limit: boundedLimit }
  }

  private grantWhere(filter: ListGrantsFilter & { from?: string; until?: string; query?: string }): { where: string[]; params: unknown[] } {
    const where: string[] = []
    const params: unknown[] = []
    if (filter.agentId) { where.push('agent_id = ?'); params.push(filter.agentId) }
    if (filter.scope) { where.push('scope = ?'); params.push(filter.scope) }
    if (filter.status) {
      const nowIso = new Date().toISOString()
      if (filter.status === 'expired') {
        where.push(`status IN ('pending','granted') AND expires_at IS NOT NULL AND expires_at <= ?`)
        params.push(nowIso)
      } else if (filter.status === 'pending' || filter.status === 'granted') {
        where.push(`status = ? AND (expires_at IS NULL OR expires_at > ?)`)
        params.push(filter.status, nowIso)
      } else { where.push('status = ?'); params.push(filter.status) }
    }
    if (filter.activeOnly) {
      where.push(`status IN ('pending','granted') AND (expires_at IS NULL OR expires_at > ?)`)
      params.push(new Date().toISOString())
    }
    if (filter.from) { where.push(`created_at >= ?`); params.push(filter.from) }
    if (filter.until) { where.push(`created_at <= ?`); params.push(filter.until) }
    if (filter.query?.trim()) {
      const q = `%${filter.query.trim()}%`
      where.push(`(summary LIKE ? OR command LIKE ? OR request_argv LIKE ? OR agent_id LIKE ? OR id LIKE ?)`)
      params.push(q, q, q, q, q)
    }
    return { where, params }
  }

  remove(id: string): boolean {
    // 身份没了，它的授权记录也不该留着（否则换同名身份重新注册会继承旧授权）
    this.db.prepare('DELETE FROM agent_grants WHERE agent_id = ?').run(id)
    return this.db.prepare('DELETE FROM agents WHERE id = ?').run(id).changes > 0
  }

  private static mapGrant(row: Record<string, unknown>): AgentGrant {
    const rawStatus = row.status as GrantStatus
    const expiresAt = (row.expires_at as string) ?? null
    /**
     * 过期呈现为 `expired` 这个**虚拟状态**（1.0.40）。
     *
     * Bob复测报的：`agent grants` 照常列出 11 小时前就过期的申请，
     * status 还写着 pending —— 从输出上看不出它已经不作数了。
     * 同源问题在界面上更明显：红点和「等点头的申请」列表都把过期项
     * 算进去，于是人点进去发现"没什么可处理的"，红点却一直亮着。
     *
     * 为什么标成 expired 而不是直接过滤掉：**它是审计信息** ——
     * "它申请过、没人理、到期自己过期了"这件事本身值得留痕。
     * 静默丢弃会让人以为"从没申请过"。
     *
     * 库里仍存原始 status，这里只改呈现：所以 `findUsableGrant`
     * 那类按 status='granted' + expires_at 判定的路径完全不受影响。
     */
    const status: GrantStatus =
      (rawStatus === 'pending' || rawStatus === 'granted') &&
      expiresAt !== null &&
      expiresAt <= new Date().toISOString()
        ? 'expired'
        : rawStatus

    return {
      id: row.id as string,
      agentId: row.agent_id as string,
      scope: row.scope as GrantScope,
      sessionId: (row.session_id as string) ?? null,
      status,
      command: (row.command as string) ?? null,
      // v18 之前写入的历史行没有这一列的值，兜底 null（界面自行降级显示）
      summary: (row.summary as string) ?? null,
      targetIds: parseTargetIds(row.target_ids),
      requestArgv: parseTargetIds(row.request_argv),
      execStatus: (row.exec_status as AgentGrant['execStatus']) ?? null,
      execError: (row.exec_error as string) ?? null,
      // v25 之前批准的动作没有摘要列，兜底 null（界面按"只知成败"降级显示）
      execSummary: (row.exec_summary as string) ?? null,
      executedAt: (row.executed_at as string) ?? null,
      createdAt: row.created_at as string,
      resolvedAt: (row.resolved_at as string) ?? null,
      resolvedBy: (row.resolved_by as string) ?? null,
      expiresAt
    }
  }

  private static mapRow(row: Record<string, unknown>): Agent {
    return {
      id: row.id as string,
      displayName: row.display_name as string,
      color: (row.color as string) ?? null,
      approved: Boolean(row.approved),
      rejectedAt: (row.rejected_at as string) ?? null,
      // 老身份（v15 之前注册的）没有凭据：界面要能标出来，让人知道它还没"持证"
      hasCredential: Boolean(row.credential_hash),
      createdAt: row.created_at as string,
      lastSeenAt: (row.last_seen_at as string) ?? null,
      lastWriteAt: (row.last_write_at as string) ?? null,
      lastWriteCmd: (row.last_write_cmd as string) ?? null
    }
  }
}
