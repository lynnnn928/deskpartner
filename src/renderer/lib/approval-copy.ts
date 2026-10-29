/**
 * 审批动作的**唯一措辞来源**（卡 `66be78f4`）
 *
 * ## 为什么要有这个文件
 *
 * 同一个"我同意让它跑"的动作，此前有三套叫法、两个入口：
 * 审批页「允许并执行」/ 横幅「允许一次」，二次确认那步叫「确认删除」，
 * 而 1.0.116 → 1.0.119 → 1.0.120 那个按钮还改过三次名（允许并强制 → 仍然执行 → 确认删除）。
 * 按钮文字是这条链上**唯一的状态信号** —— 队列里"待表态"和"已批准待补确认"两种卡片
 * 长得几乎一样，人全靠主按钮的字判断自己按下的是哪一步。
 *
 * 判据（卡面）：**首次同意统一「允许」+ 范围后缀（一次 / 本次会话 / 始终）；覆盖警告的那一步
 * 统一「仍然 + 动词」；撤销统一「放弃」，拒绝保持「拒绝」；两个入口同一状态同一词。**
 *
 * ## 边界
 *
 * - **副作用不写进按钮名**：「允许并执行」把"执行"塞进按钮，而批准本来就是这个意思；
 *   "允许后会发生什么"交给旁边的说明（`title` / 明细行）承担，按钮只回答"我在同意哪一步"。
 * - **范围是三个真实档位**，不是两种：`destructive` 一次性、`config` 仅本次会话、
 *   `write` 长期。所以后缀是「一次 / 本次会话 / 始终」，而不是硬凑成「一次 / 始终」。
 * - 本文件只放**字**，不放判断之外的东西：哪个按钮出现由组件决定，叫什么由这里决定。
 *   两个入口（横幅 / 审批页）+ 团队卡的授权状态都引用它，改一处即全站一致。
 */

export const APPROVAL_ACTION = {
  /** 首次同意 · 写档：批准一次长期有效 */
  allow: '允许',
  /** 首次同意 · 删除档：一次性授权 */
  allowOnce: '允许一次',
  /** 首次同意 · 界面档：仅本次会话有效 */
  allowSession: '允许本次会话',
  /** 界面档的长期授权 */
  allowAlways: '始终允许',
  /** 已批准但还差一次确认时，撤销这个决定 */
  withdraw: '放弃',
  /** 拒绝（与"放弃"分开：拒绝是从未同意，放弃是收回已给过的同意） */
  reject: '拒绝',
  /** 待审批卡片的类型徽标 */
  badgeForceConfirm: '需二次确认',
  badgeConfig: '界面授权',
  badgeOperation: '操作授权'
} as const

/**
 * 覆盖警告的一步：**仍然 + 动词**。
 *
 * 1.0.119 换成「仍然执行」就是为了把"我知道会解绑子任务，仍然要删"这层意思留在字面上，
 * 1.0.120 又改回「确认删除」—— 而「确认删除」读起来像第一步（"请确认你要删"），
 * 恰好把那层意思丢了。默认动词是删除：目前 `--force` 只在"父事项下还有子任务"时出现。
 */
export function forceConfirmLabel(verb = '删除'): string {
  return `仍然${verb}`
}

/**
 * 首次同意的按钮文字，按授权档位取后缀。
 *
 * 档位来自授权记录自己的 `scope`（`write` / `config` / `destructive`）——
 * 组件不自己猜"这个按钮该叫什么"。
 */
export function allowLabel(scope: string | null | undefined): string {
  if (scope === 'config') return APPROVAL_ACTION.allowSession
  if (scope === 'destructive') return APPROVAL_ACTION.allowOnce
  return APPROVAL_ACTION.allow
}

/** 待审批卡片左侧的类型徽标：这一条是"待表态"、"界面授权"还是"已批准待补确认" */
export function grantBadgeLabel(scope: string | null | undefined, needsForceConfirm: boolean): string {
  if (needsForceConfirm) return APPROVAL_ACTION.badgeForceConfirm
  if (scope === 'config') return APPROVAL_ACTION.badgeConfig
  return APPROVAL_ACTION.badgeOperation
}
