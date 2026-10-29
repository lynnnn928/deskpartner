import type { Agent, AgentGrant, GrantScope } from '../types/todo'

/**
 * 审计流水里的一条（1.0.60，主用户驳回 10f0a5d6 与 2ccc6fc6）
 *
 * 她的原话：「这块现在做的很混乱，应该作为审计留痕才对的，
 * 可能后端有做，但是前端不好，**只有最新一条的执行记录**。」
 *
 * 问题的实质是**信息被 pickGrant 压扁成了"当前状态"**：
 * 每一档只取 latest（最近一条），于是"上周谁申请过、批没批、做没做成"
 * 在看板上完全无迹可寻。而 grant 表本身就是**天然的审计日志**
 * （谁申请 / 想干什么 / 批了没 / 执行结果 / 什么时候），
 * 后端一行都没少写 —— 缺的是把它们完整摊开的那个读侧。
 *
 * 所以这里把它做成一条**与"当前权限"分开的独立数据流**：
 * 权限账本回答"它现在能不能干"，审计流水回答"过去发生过什么"。
 */
export interface AuditEntry {
  grant: AgentGrant
  /** 排序键：表过态用 resolvedAt，没表态的用 createdAt */
  at: string
}

/**
 * 一条授权申请是不是**还在等人表态**
 *
 * 为什么单独抽一个函数：这个判断在三个地方要用（悬浮球红点、设置页导航红点、
 * 「谁能写入」的待表态列表），各写一遍就会出现"改了一处、漏了另外两处"。
 * 而这里漏判的后果不是报错，是**红点永远亮着** —— 一个不再指向任何事的假信号，
 * 比没有红点更糟：人会学会忽略它。
 *
 * `expiresAt` 必须一起判：`requestGrant` 给 pending 也设了寿命
 * （见 agent.repository 的 PENDING_GRANT_TTL_MS，24 小时），
 * 本意是"无人理会的申请不该永远挂在界面上"。
 * 只判 status 会让这条寿命形同虚设 —— 申请早就凉了，
 * 红点还挂着，而人点进去发现什么都处理不了。
 */
export function isPendingGrant(g: AgentGrant): boolean {
  if (g.status !== 'pending') return false
  return !g.expiresAt || new Date(g.expiresAt).getTime() > Date.now()
}

/**
 * 有没有**人该去点头**的事，一共几件（1.0.47）
 *
 * 两类事都得算，缺一类红点就是瞎的：
 *
 * 1. **待批准的身份**（`approved === false`）：agent 自己注册完了，正等着人放行。
 *    1.0.47 起 agent 可以自己办手续（`agent register` / `credential`），
 *    它办完就不再卡在那条命令上、也没有"申请"记录 —— 若红点只数申请，
 *    人就**完全不知道**有个新身份在等他点头，助手会一直写不进来。
 *
 * 2. **待表态的授权申请**（`isPendingGrant`）：改界面 / 删除两档要逐次点头。
 *
 * ⚠️ 判据必须用 `approved === false` 而不是 `!hasCredential`：
 * 身份可以"注册了但还没领凭据"，那种情况同样在等人点头，
 * 而按凭据判会漏掉它。
 */
export function countAwaitingApproval(
  agents: Agent[],
  grants: AgentGrant[],
  profileProposals = 0,
  protocolProposals = 0,
  handoffProposals = 0,
  ruleProposals = 0
): number {
  const pendingAgents = agents.filter(isPendingAgent).length
  const pendingGrants = grants.filter((g) => isPendingGrant(g) || isForceConfirmableGrant(g)).length
  return pendingAgents + pendingGrants + profileProposals + protocolProposals + handoffProposals + ruleProposals
}

/**
 * 这个身份是不是还在等人点头（1.0.62，aa0b4610）
 *
 * 单独抽出来是因为同一个判断有四处要用（两处红点、用户页的待批准提示、
 * 审批页对被红点引来的人的解释）。各写一遍就会出现"红点算它、界面不显示它"
 * 的错位，而错位的那一侧恰恰是人看得见的 —— 点了红点进去找不到东西，
 * 人只会认为红点在乱报，然后学着忽略它。
 *
 * 被拒绝过的身份不算：那是已经结案的决定，不是"还在等你"。
 */
export function isPendingAgent(a: Agent): boolean {
  return !a.approved && !a.rejectedAt
}

/**
 * 这一档现在**还有效**吗（1.0.48）
 *
 * 与 `isPendingGrant` 一样，判据只写一遍：设置页的权限明细、`agent whoami`
 * 的档位状态都要回答"它现在能不能干这件事"，两处口径漂移的后果是
 * 「界面说已授权、CLI 说 grant_required」，而人无从判断该信哪个。
 *
 * ⚠️ 必须**排除执行失败**的授权（2026-09-23 实测）：
 * 真实库里有 5 条 `exec_status='error'` 却仍是 `status='granted'` 的记录 ——
 * 服务端替人执行失败了，一次性授权没被销账（销账只在命令成功时发生）。
 * 若这里照 `status` 判，界面会把它们显示成「已授权 · 一次性」，
 * 而人刚点过「允许并执行」、以为事情已经做掉 —— 这是最坏的一种错：
 * **界面替一个失败的动作报了成功**。
 *
 * 所以"有效"要同时满足：状态是 granted、没过期、且没有失败回执。
 */
export function isActiveGrant(g: AgentGrant, scope: GrantScope): boolean {
  if (g.scope !== scope) return false
  if (g.status !== 'granted') return false
  if (g.expiresAt && new Date(g.expiresAt).getTime() <= Date.now()) return false
  if (g.execStatus === 'error') return false
  return true
}

/**
 * 一次性授权「执行失败了，但**没被销账**」（1.0.48）
 *
 * 销账只在命令成功时发生（`executeOne` 末尾），所以失败的那条仍是
 * `status='granted'` 且未过期 —— `findUsableGrant` 照样认它可用，
 * agent 重试同一目标仍会被放行。
 *
 * 这件事必须与"未授权"分开呈现，否则界面会撒谎两次：
 * 说成"已授权"→ 人以为事情做掉了（其实失败）；
 * 说成"未授权"→ 人以为授权没了（其实还在，它随时能重试）。
 * 准确的说法是「上次没做成，授权还留着」。
 */
export function isRetryableGrant(g: AgentGrant): boolean {
  if (g.status !== 'granted') return false
  if (g.execStatus !== 'error') return false
  if (g.expiresAt && new Date(g.expiresAt).getTime() <= Date.now()) return false
  return true
}

/**
 * 已批准但回放时撞上「需二次确认（--force）」守卫、尚待用户在界面上完成二次确认或放弃的授权（卡 `fe05ce28`）。
 *
 * 用户在顶部横幅点「允许一次」撞上守卫后，若点「去审批」或关闭了横幅，
 * 该授权状态为 `status='granted'` + `execStatus='error'`，不再是 `pending`。
 * 审批页必须将它保留在待处理队列并提供「确认删除 / 放弃」入口，避免已批准的删除悬在半空。
 */
export function isForceConfirmableGrant(g: AgentGrant): boolean {
  if (!isRetryableGrant(g)) return false
  if ((g.requestArgv ?? []).includes('--force')) return false
  return /--force/.test(g.execError ?? '')
}

/**
 * 取该身份在某档上**当前有效**的授权，没有则给最近一条历史（1.0.48）
 *
 * 为什么要有"回退到历史"：原先界面只查"有没有有效授权"，查不到就一律显示
 * 「未授权（每次都要点头）」。于是**刚执行失败**的那一条会掉进这个兜底文案里 ——
 * 人明明点过允许、也看到了失败提示，回头再看权限明细却是"未授权"，
 * 失败原因（`execError`）在界面上彻底消失，只有 CLI `agent grants` 看得到。
 *
 * 而按主用户本轮定的判据 ——「agent 说出一句话，人能不能在界面上把它核实掉」——
 * 这正是要补的缺口：agent 说"我申请删 X 但被拒了"，人得能在界面上看到
 * 那条申请、那次失败、以及为什么。
 *
 * 返回 `{ active: false, latest }` 时调用方应当把 latest 当作**审计信息**呈现，
 * 而不是当成一张还能用的通行证。
 */
export function pickGrant(
  grants: AgentGrant[],
  agentId: string,
  scope: GrantScope
): { active: AgentGrant | null; latest: AgentGrant | null } {
  const mine = grants.filter((g) => g.agentId === agentId && g.scope === scope)
  if (!mine.length) return { active: null, latest: null }
  // listGrants 按 created_at DESC 返回，但别依赖调用方传进来的顺序
  const sorted = [...mine].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const active = sorted.find((g) => isActiveGrant(g, scope)) ?? null
  return { active, latest: sorted[0] }
}

/**
 * 把全部授权记录整理成一条**审计流水**（1.0.60）
 *
 * 与 `pickGrant` 的区别是"压扁"与"摊开"：
 * `pickGrant` 把同一档的多条压成一条（回答"现在能不能干"），
 * 这里把它们全留着（回答"过去发生过什么"）。
 *
 * 排序：表过态的用 `resolvedAt`，还没表态的（pending / 过期未处理）
 * 用 `createdAt` —— 否则那批没被处理的申请会全部堆到列表末尾，
 * 而"申请过但没人理"恰恰是审计最该让人看见的一类
 * （它意味着有个 agent 曾被晾在那里）。
 *
 * `limit` 默认 200：够覆盖近期的完整决策史，又不至于让一屏渲染上千行。
 * 传 0 = 不限（给统计类消费者）。
 */
export function buildAuditTrail(grants: AgentGrant[], limit = 200): AuditEntry[] {
  const entries: AuditEntry[] = grants.map((g) => ({
    grant: g,
    at: g.resolvedAt ?? g.createdAt
  }))
  entries.sort((a, b) => b.at.localeCompare(a.at))
  return limit > 0 ? entries.slice(0, limit) : entries
}

/**
 * 一条审计记录**有没有产生过实际后果**（1.0.60）
 *
 * 用途是给流水做视觉分级：真正改动过数据的（执行成功）要能被一眼挑出来，
 * 单纯被拒/过期的属于"没发生的事"，可以安静一些。
 * 与 `isRetryableGrant` 一样只做事实判断，不含任何措辞。
 */
export function hasEffect(g: AgentGrant): boolean {
  if (g.execStatus === 'ok') return true
  return g.status === 'consumed'
}
