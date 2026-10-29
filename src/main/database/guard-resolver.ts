/**
 * 守卫判定单一入口（M4.5）
 *
 * ## 为什么要有这个文件
 *
 * 此前守卫判断散在 `gates.ts`（清单）、`proposed-guards.ts`（G4）、
 * `todo.repository.ts`（G1/G2/G6/G10）和 `commands.ts`（G3/G7/G8/G9），
 * 每处各写一份。M4.5 把它们收到一个入口，按 **项目覆盖 → 全局 → 出厂默认**
 * 解析配置后决定行为。
 *
 * ## 两条安全底线（不可配置）
 *
 * 1. 身份必须可验证（identity / credential / ambiguous_identity）
 * 2. 权限矩阵仅 GUI 可改
 *
 * 这两条不经过配置解析，永远按代码强制执行。
 */

import { GuardError } from '../lib/domain-errors'
import {
  ruleSpecByKey,
  type RuleEnforcement,
  type PermissionDecision
} from './rules'
import { RulesRepository, type RulesScope } from './rules.repository'

/** 守卫判定结果 */
export interface GuardCheckResult {
  /** 'pass' = 放行；'notice' = 软提醒（附 notice 文本）；'block' = 硬拦；'authorize' = 转授权 */
  action: 'pass' | 'notice' | 'block' | 'authorize'
  notice?: string
  errorCode?: string
  exitCode?: number
}

export class GuardResolver {
  /**
   * ⚠️ 只用 `listRules` / `listPermissions` 两个方法 —— 所以类型收成 Pick
   * （1.0.112，卡 `69788c32`）：命令层注入的 `ctx.deps.rulesRepo` 正是这个形状。
   * 宽成整个 `RulesRepository` 的话，注入的就不是"它要的"，而是"实现碰巧有的"。
   */
  private readonly rulesRepo: Pick<RulesRepository, 'listRules' | 'listPermissions'>

  constructor(rulesRepo?: Pick<RulesRepository, 'listRules' | 'listPermissions'>) {
    this.rulesRepo = rulesRepo ?? new RulesRepository()
  }

  /**
   * 解析某条规则的有效强度。
   * 项目覆盖 → 全局 → 出厂默认。
   */
  resolveEnforcement(ruleKey: string, scope: RulesScope): RuleEnforcement {
    const spec = ruleSpecByKey(ruleKey)
    if (!spec) throw new Error(`未知守卫规则：${ruleKey}`)
    const resolved = this.rulesRepo.listRules(scope).find((r) => r.key === ruleKey)
    return resolved?.enforcement ?? spec.defaultEnforcement
  }

  /**
   * 守卫判定：根据配置决定拦截、提醒还是放行。
   *
   * @param ruleKey 规则编号（G1/G2/G4-status/G4-delete/G6/G10 或 G3/G5/G7/G8/G9）
   * @param scope 作用域（全局或项目）
   * @param context 上下文（用于生成提醒文本）
   */
  check(
    ruleKey: string,
    scope: RulesScope,
    context: { message?: string } = {}
  ): GuardCheckResult {
    const spec = ruleSpecByKey(ruleKey)
    if (!spec) throw new Error(`未知守卫规则：${ruleKey}`)

    const enforcement = this.resolveEnforcement(ruleKey, scope)

    switch (enforcement) {
      case 'off':
        return { action: 'pass' }
      case 'notice':
        return {
          action: 'notice',
          notice: context.message ?? `[${ruleKey}] ${spec.what}`
        }
      case 'authorize':
        return {
          action: 'authorize',
          errorCode: 'grant_required',
          exitCode: 4,
          notice: context.message ?? `[${ruleKey}] ${spec.what} — 需要授权`
        }
      case 'block':
      default:
        return {
          action: 'block',
          errorCode: 'guard_blocked',
          exitCode: 4
        }
    }
  }

  /**
   * 断言式调用：配置为 block 时抛 GuardError，notice 时返回提醒文本，off 时静默通过。
   *
   * 现有调用点（todo.repository.ts 等）改为调用这个方法，
   * 逐步替换原来的硬编码 throw。
   */
  assert(
    ruleKey: string,
    scope: RulesScope,
    errorMessage: string,
    noticeMessage?: string
  ): string | null {
    const result = this.check(ruleKey, scope, {
      message: noticeMessage ?? errorMessage
    })
    switch (result.action) {
      case 'block':
        throw new GuardError(errorMessage)
      case 'authorize':
        throw new GuardError(errorMessage)
      case 'notice':
        return result.notice ?? null
      case 'pass':
      default:
        return null
    }
  }

  /**
   * 检查权限矩阵决定。
   * ⚠️ 权限矩阵**仅 GUI 可改** —— 这里只读，没有写入口。
   */
  checkPermission(
    action: string,
    subject: string,
    scope: RulesScope
  ): PermissionDecision {
    const permissions = this.rulesRepo.listPermissions(scope, [subject])
    // 具体 agent 覆盖优先，其次继承 all_agents；不能因只查 exact subject
    // 而静默忽略用户在配置页设置的全体 agent 规则。
    const exact = permissions.find((p) => p.action === action && p.subject === subject)
    const allAgents = permissions.find((p) => p.action === action && p.subject === 'all_agents')
    // 具体 agent 只有在显式配置过时才覆盖 all_agents；默认行不是覆盖。
    if (exact && exact.source !== 'default') return exact.decision
    if (allAgents && allAgents.source !== 'default') return allAgents.decision
    return exact?.decision ?? allAgents?.decision ?? 'require_approval'
  }
}
