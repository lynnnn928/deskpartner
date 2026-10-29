/**
 * 批准之后那句回执 —— 说人话的那一层（1.0.117，卡 `0dfff6df`）
 *
 * ── 要治的是什么 ──
 *
 * 人点了「允许」，横幅和审批页给出的回执是**命令原文**：
 * 「已执行：todo rm 3f2a… --yes --force」。那不是回执，那是把内部实现
 * 又念了一遍 —— 人要知道的是"删掉了什么、孩子怎么办"，不是 uuid。
 *
 * 同一段文案会走三个出口（落库的 `exec_summary`、通知中心、回给界面的回执，
 * 刻意同源，见 ipc.ts 的注释），所以这层必须是**纯函数**：
 * 同一份输入只能产出一句话，三处才不会各说各的。
 *
 * ── 为什么不在这里读仓储、不在这里判断守卫 ──
 *
 * 判据都来自调用方：`ok` / `summary` 来自命令回执，`canForce` 来自守卫
 * （它明说了要 `--force`），`target` 是命令行覆盖到的那条事项。
 * 这里只做"翻译"，不做"判断" —— 否则同一件事会有两处判据。
 *
 * ── 为什么还要 `details` ──
 *
 * 回执要人话，但**审计要原文**：命令行是唯一能复核"这次到底跑了什么"的东西。
 * 所以两者分开给：`message` 给人看，`details` 折叠成小字放在回执下面。
 * 只留其中一个都不对 —— 只留人话，事后无从复核；只留原文，就是这张卡要治的病。
 */

export interface ExecReceiptInput {
  ok: boolean
  /** 命令自己给出的结论（`pickExecSummary` 的结果）。成功侧可能为 null */
  summary: string | null
  /** 回放用的命令行。补过 `--force` 时就是补过的那条 */
  argv: string[]
  /** 命令行覆盖到的第一条被认出来的事项 —— 拿得到才给 */
  target?: { title: string; childCount: number } | null
  /** 失败时守卫的原文，只在"没有更具体的人话"时用来拼第一句 */
  guardMessage?: string | null
  /** 补一个 `--force` 就能继续（守卫明说了要它） */
  canForce: boolean
}

export interface ExecReceipt {
  /** 给人看的那一句（落库 / 通知 / 界面三处同源） */
  message: string
  /** 命令行原文 —— 只给"详情"，不占回执的主位 */
  details: string
}

/** 去掉守卫前缀（`[TodoRepository]` 这类给开发者看的标签）与首尾空白 */
function stripTag(text: string): string {
  return text.trim().replace(/^\[[^\]]{1,40}\]\s*/, '')
}

/** 取第一句：守卫原文常常是"原因。确认要删请加 --force；想先看…"，后半截是给 agent 的 */
function firstSentence(text: string): string {
  const clean = stripTag(text)
  if (!clean) return ''
  const cut = clean.split(/[。\n]/)[0]?.trim() ?? ''
  return cut.length >= 8 ? cut : clean.split('\n')[0].trim()
}

/**
 * 一次批准 → 一句人话 + 一行原文
 *
 * 取值优先级刻意如此：
 *  1. 命令自己给了结论（`summary`）就用它 —— 那是**最具体的真相**，
 *     拼在它前面的话只会稀释它；
 *  2. 删除类命令没有结论时，按目标标题 + 子任务数补一句（人能对上号）；
 *  3. 其余成功：只说"按你的允许执行完毕" —— 不编造细节；
 *  4. 失败且能补 `--force`：按"系统对话框"写两句 —— 这条现在什么情况、删了会怎样
 *     （不写守卫、不写 `--force`、不写"再点一次"）；
 */
export function buildExecReceipt(input: ExecReceiptInput): ExecReceipt {
  const { ok, summary, argv, target, guardMessage, canForce } = input
  const details = argv.join(' ')
  const title = target?.title?.trim() ?? ''
  const children = target?.childCount ?? 0
  const isRm = argv[0] === 'todo' && argv[1] === 'rm'

  if (ok) {
    const own = summary?.trim()
    if (own) return { message: own, details }
    if (isRm) {
      if (title && children > 0) {
        return {
          message: `已删除「${title}」（${children} 个子任务已保留）`,
          details
        }
      }
      return { message: title ? `已删除「${title}」` : '已删除这条事项', details }
    }
    return { message: '已执行', details }
  }

  if (canForce) {
    /**
     * 主用户 2026-10-27 的两轮反馈，都记在这里，免得下一个人改回去：
     *
     * 一审：「提示语是在诱导删除，不是正常提示的感觉」—— 原句
     * 「还差一步：再点一次…就按你的允许执行完毕」在**没执行**的情况下说"执行完毕"。
     * 二审（1.0.119 的「没有执行：<原因>。要继续就点…；不想动它…」）：
     * 「完全就只是在说明背后的逻辑，并不是面向用户的文案」—— 说的是守卫、解绑、
     * 两条出路怎么走，那是机制，不是她要看的一屏字。
     *
     * 定稿是她选的方案 A：只说**删哪条**和**删了之后子任务怎样**；
     * 不提守卫、不提 `--force`、不劝也不拦。
     * 按钮在界面上是 [确认删除] / [取消]（见 ReminderBanner / ApprovalView）。
     */
    const what = title ? `「${title}」` : '这条事项'
    const message =
      children > 0
        ? `删除${what}？其下 ${children} 个子任务将保留为独立事项。`
        : `${what}还需要你确认一次。`
    return { message, details }
  }

  const reason = firstSentence(guardMessage ?? '')
  return {
    message: reason ? `执行失败：${reason}` : '执行失败',
    details
  }
}
