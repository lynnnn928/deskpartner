/**
 * 协作规则配置（M4.5）—— 流转规则 / 权限矩阵 / 提醒
 *
 * ## 为什么要有这份配置
 *
 * 产品的守卫（G1–G10）原本全部写死在代码里，界面上没有配置页，
 * 只能由产品替用户决定管多严。PRD 6.14 把控制权交还用户：
 * 协议写约定，规则管产品实际执行哪些约束。
 *
 * ## 三层解析（项目覆盖 → 全局 → 出厂默认）
 *
 * 出厂默认 = 当前产品行为（GATES 清单里那套），升级后什么都不变。
 * 用户可在「用户与团队 › 协作规则配置」逐项调整。
 *
 * ## 两条不可配置的安全底线
 *
 * 1. **身份必须可验证**：注册、凭据、人批准接入，这些不能关。
 *    权限矩阵是按"谁"来分配权限的，如果身份能冒充，所有配置都不作数。
 * 2. **权限矩阵只能由主用户在界面上改**：CLI / MCP 都没有改它的入口。
 *    否则 agent 可以先把"改权限"设成允许，再给自己放开一切。
 */

// ── 流转规则（状态机条件）────────────────────────────────

export type RuleEnforcement = 'block' | 'authorize' | 'notice' | 'off'

export type RuleCategory = 'flow' | 'notice'

export interface RuleSpec {
  /** 规则编号，与 GATES 的 id 对应（G1/G2/G4-status/G4-delete/G6/G10） */
  key: string
  category: RuleCategory
  /** 一句话说清它守什么 */
  what: string
  /** 出厂默认强度 */
  defaultEnforcement: RuleEnforcement
  /** 该规则允许配置哪些强度 */
  allowedEnforcements: RuleEnforcement[]
}

/**
 * 流转规则 + 提醒的规格清单（单源）。
 *
 * ⚠️ 安全底线（identity / grant / ambiguous_identity / project_required）
 * **刻意不在这份清单里** —— 它们不可配置，继续由代码强制。
 */
export const RULE_SPECS: RuleSpec[] = [
  // ── 流转规则 ──
  {
    key: 'G1',
    category: 'flow',
    what: '父需求还在「待确认」时，不能围绕它建子任务',
    defaultEnforcement: 'block',
    allowedEnforcements: ['block', 'notice', 'off']
  },
  {
    key: 'G2',
    category: 'flow',
    what: '父需求转「待验收」时，子任务必须全部完成',
    defaultEnforcement: 'block',
    allowedEnforcements: ['block', 'notice', 'off']
  },
  {
    key: 'G4-status',
    category: 'flow',
    what: '把「待确认」的条目挪走（改成别的状态）',
    defaultEnforcement: 'block',
    allowedEnforcements: ['block', 'notice', 'off']
  },
  {
    key: 'G4-delete',
    category: 'flow',
    what: '把「待确认」的条目删掉',
    defaultEnforcement: 'authorize',
    allowedEnforcements: ['authorize', 'notice', 'off']
  },
  {
    key: 'G6',
    category: 'flow',
    what: '父需求直接置「已完成」时，子任务必须全部完成',
    defaultEnforcement: 'block',
    allowedEnforcements: ['block', 'notice', 'off']
  },
  {
    key: 'G10',
    category: 'flow',
    what: '执行者不能验收自己做的事',
    defaultEnforcement: 'block',
    allowedEnforcements: ['block', 'notice', 'off']
  },
  // ── 提醒 ──
  {
    key: 'G3',
    category: 'notice',
    what: '事项转「待验收」时没留收口结论',
    defaultEnforcement: 'notice',
    allowedEnforcements: ['notice', 'off']
  },
  {
    key: 'G5',
    category: 'notice',
    what: '事项标完成时没留收口结论',
    defaultEnforcement: 'notice',
    allowedEnforcements: ['notice', 'off']
  },
  {
    key: 'G7',
    category: 'notice',
    what: '「待确认」的事项描述缺要素',
    defaultEnforcement: 'notice',
    allowedEnforcements: ['notice', 'off']
  },
  {
    key: 'G8',
    category: 'notice',
    what: '你手上那份说明书版本落后于当前版本',
    defaultEnforcement: 'notice',
    allowedEnforcements: ['notice', 'off']
  },
  {
    key: 'G9',
    category: 'notice',
    what: '在「待验收」的事项上写了评论，但状态没动',
    defaultEnforcement: 'notice',
    allowedEnforcements: ['notice', 'off']
  }
]

export function ruleSpecByKey(key: string): RuleSpec | undefined {
  return RULE_SPECS.find((r) => r.key === key)
}

// ── 权限矩阵 ─────────────────────────────────────────

export type PermissionAction =
  | 'create_todo'
  | 'update_todo'
  | 'comment_todo'
  | 'change_todo_status'
  | 'batch_todo'
  | 'update_profile'
  | 'update_protocol'
  | 'update_handoff'
  | 'delete_todo'
  | 'delete_project'
  | 'delete_memo'
  | 'release_add'
  | 'release_update'
  | 'release_delete'
  | 'ui_config'
  | 'rules_propose'
  | 'move_out_of_proposed'
  | 'self_verify'

export type PermissionSubject = 'human' | 'all_agents' | `agent:${string}`

export type PermissionDecision = 'allow' | 'require_approval' | 'deny'

export interface PermissionActionSpec {
  action: PermissionAction
  what: string
  /** 出厂默认（对 all_agents） */
  defaultForAgents: PermissionDecision
}

export const PERMISSION_ACTIONS: PermissionActionSpec[] = [
  { action: 'create_todo', what: '新建事项', defaultForAgents: 'allow' },
  { action: 'update_todo', what: '修改事项内容', defaultForAgents: 'allow' },
  { action: 'comment_todo', what: '发表评论', defaultForAgents: 'allow' },
  { action: 'change_todo_status', what: '修改事项状态', defaultForAgents: 'allow' },
  { action: 'batch_todo', what: '批量处理事项', defaultForAgents: 'allow' },
  { action: 'update_profile', what: '修改用户档案', defaultForAgents: 'require_approval' },
  { action: 'update_protocol', what: '修改协作协议', defaultForAgents: 'require_approval' },
  { action: 'update_handoff', what: '修改项目接手说明', defaultForAgents: 'require_approval' },
  { action: 'delete_todo', what: '删除事项', defaultForAgents: 'require_approval' },
  { action: 'delete_project', what: '删除项目', defaultForAgents: 'require_approval' },
  { action: 'delete_memo', what: '删除备忘', defaultForAgents: 'require_approval' },
  { action: 'release_add', what: '登记版本', defaultForAgents: 'allow' },
  { action: 'release_update', what: '修改版本登记', defaultForAgents: 'allow' },
  { action: 'release_delete', what: '删除版本登记', defaultForAgents: 'require_approval' },
  { action: 'ui_config', what: '修改应用设置', defaultForAgents: 'require_approval' },
  { action: 'rules_propose', what: '提议修改协作规则', defaultForAgents: 'require_approval' },
  { action: 'move_out_of_proposed', what: '把事项移出「待确认」', defaultForAgents: 'deny' },
  { action: 'self_verify', what: '验收自己做的事', defaultForAgents: 'deny' }
]

export function permissionActionSpec(action: string): PermissionActionSpec | undefined {
  return PERMISSION_ACTIONS.find((p) => p.action === action)
}

/**
 * 出厂默认的权限决定。
 *
 * - human：全部 allow（主用户在界面上什么都能做）
 * - agent：按 PERMISSION_ACTIONS 的 defaultForAgents
 */
export function defaultPermission(action: string, subject: string): PermissionDecision {
  if (subject === 'human') return 'allow'
  const spec = permissionActionSpec(action)
  return spec?.defaultForAgents ?? 'require_approval'
}

// ── 解析后的规则配置 ─────────────────────────────────

export interface ResolvedRule {
  key: string
  category: RuleCategory
  what: string
  enforcement: RuleEnforcement
  /** 这个值来自哪一层 */
  source: 'default' | 'global' | 'project'
}

export interface ResolvedPermission {
  action: PermissionAction
  what: string
  subject: string
  decision: PermissionDecision
  source: 'default' | 'global' | 'project'
}
