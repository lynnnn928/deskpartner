import type { Outcome } from '../cli/commands'

/**
 * 从一次命令执行里挑出"一句人话"（1.0.62，收 10f0a5d6 最后一段）
 *
 * ── 为什么单独抽一个函数 ──
 *
 * 批准后人要在审批流水里看到"做成了什么"。但" Output 该取哪一段"这件事
 * 有三处会用（写库、写通知、回给界面的回执），各写一遍就会出现
 * "通知里是一句人话、流水里是命令原文"的错位 —— 而错位的那一侧恰好是
 * 唯一被留下来的那一侧（通知读完就没了）。
 *
 * 取值的优先级来自命令自己的产出习惯：绝大多数命令会把结果写成
 * `message`（"评论已删除，连带清掉 2 条回复"），少数把结构化结果放进
 * `data.message`。都不是的话，宁返回 null 也不拼一句假话 ——
 * 界面按"只知道成败"降级显示，好过显示一段像回执、实则什么都没说的文案。
 *
 * ⚠️ **不取 `notice` 兜底**（1.0.65 修 `10fcb47f` D3）：
 * `notice` 的语义是"这次命令成功了，但**另有一件事**要告诉你"，
 * 而那个"另一件事"往往是**跨命令的**：执行链路会在成功时附带未读摘要
 * （"你有 1 条事项被退回…[未读] 有 2 张未读纸条…"）。
 *
 * 把它当成执行回执写进 `exec_summary`，后果是授权流水里那条 `todo rm`
 * 的回执写着"你有 2 张未读纸条" —— 实测至少 6 条完全一样
 * （0a2db2d7 / 7a2a690c / 6c26b3be / 1e1ca300 / a3671756 / df934133），
 * 审批流水因此完全不可读：它回答的是"未读有几条"，不是"批准后删掉了什么"。
 *
 * 判据：**回执要回答"这次动作的结果"，凡是跨命令的旁支消息都不能进**。
 * 旁支消息有它自己的去处（通知通道的 notice 字段），不该占用回执字段。
 *
 * ⚠️ 也不取 `requestArgv` 兜底：那只能回答"批准了什么请求"，
 * 而这里要回答的是"请求跑完之后发生了什么"，两者不是一回事。
 */
export function pickExecSummary(outcome: Outcome): string | null {
  const own = outcome.message?.trim()
  if (own) return own

  const data = outcome.data as Record<string, unknown> | undefined | null
  const fromData = typeof data?.message === 'string' ? data.message.trim() : ''
  if (fromData) return fromData

  return null
}
