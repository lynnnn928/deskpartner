import { dayKey, formatDayHeading, formatTimeOnly } from './date'
import { ownerLabel } from './todo-filter'

/**
 * 变更记录的展示层判据（1.0.62）
 *
 * 这两个判据都来自**实测截图**，不是设计稿 —— 数据接通、断言全绿之后，
 * 界面上的问题才显出来：
 *
 * 1. **时间列每行都印「10:54」**：同一批改动常发生在同一分钟里（agent 连着
 *    跑几步），五行的时刻一模一样，看完等于没给时间，还把行挤碎。
 *    这是"层次缺失"而不是"精度不够" —— 加秒或加 padding 只是让噪音更精确。
 *    解法是按天分组、同一分钟只标一次。
 * 2. **主进程一律写原始身份**（`human` / `agent:xxx`）：同一个主体在界面上
 *    只能有一个叫法。实测抓到过两次：先是「提出者」写「我」而变更记录写「Alex」，
 *    修完又发现 agent 那头同样裂开 —— 动态页叫「Alice」、变更记录写
 *    `agent:alice`。两次都是同一个病：**显示名有第二个来源**。
 *    正解统一为走全站那份 `ownerLabel`。
 *
 * 放在 lib 而不是组件里：这两件事都是**纯函数**，抽出来才测得到。
 * 埋在 900 行组件的内联逻辑只能靠截图肉眼看，回归时无人发现。
 */

/** 一条流水行的时间该显示成什么样 */
export interface StampPlan {
  /** 是否要新起一个日期小标题（跨天时） */
  newDay: boolean
  /** 日期小标题文案（newDay 为 true 时才有意义） */
  dayLabel: string
  /** 这一行是否要印时刻（同一分钟只印第一次） */
  showTime: boolean
}

/**
 * 算出这一行的时间显示方案
 *
 * @param at      这一行的时间
 * @param prevAt  上一行的时间；第一行传 null
 */
export function planStamp(at: string, prevAt: string | null): StampPlan {
  const newDay = prevAt === null || dayKey(prevAt) !== dayKey(at)
  const stamp = formatTimeOnly(at)
  return {
    newDay,
    dayLabel: formatDayHeading(at),
    // 跨天时第一行必印（新的一天从几点开始，是有信息量的）
    showTime: newDay || formatTimeOnly(prevAt!) !== stamp
  }
}

/**
 * 把流水里写死的原始身份换成界面上该显示的称呼
 *
 * 主进程翻译流水时不知道任何显示名（人类的名字是**界面设置**、agent 的名字在
 * `agents` 表里），所以它一律写原始身份（`human` / `agent:xxx`），
 * 由渲染层按全站既有口径（`ownerLabel`）换成名字。
 *
 * ⚠️ 只替换两个**结构位置**，不做全文替换：`what` 里带着被删评论的原文，
 * 全文替换会把引号里的身份 token 也改掉（那就不再是原文了）。
 *   位置一：句首的动作人 —— 所有模板都是 `${动作人} 做了什么…`；
 *   位置二：「删掉了 X 的一条评论」里的那个 X。
 *
 * ── 为什么第 4 处截图后才扩到 agent（1.0.62）──
 *
 * 原实现只换 `human`（`if (actor !== 'human') return what`），于是同一个
 * agent 在两个入口两种叫法：动态页走 `ownerLabel` 显示「Alice」、
 * 变更记录显示 `agent:alice`。这正是本轮在修的"同一主体两种叫法"，
 * 只是主体从人换成了 agent —— 修法相同：**都走 `ownerLabel`**。
 */
export function humanizeActor(what: string, actor: string, humanName?: string | null): string {
  const shown = ownerLabel(actor, humanName)
  // 显示名与原始身份一致（认不出的 agent、`未记录`）就没得换，原样返回
  if (!actor || shown === actor) return what
  // 转义后再拼正则：身份可能含 `:` 等元字符（agent:alice）
  const token = actor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return what
    .replace(new RegExp(`^${token}(?=\\s)`), shown)
    .replace(new RegExp(`(?<=删掉了 )${token}(?=\\s)`), shown)
}
