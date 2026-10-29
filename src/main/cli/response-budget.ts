/**
 * 回执体量的**唯一判据**（卡 `ce43b4ba` / `caa0d1c1`）
 *
 * ## 为什么要有这个模块
 *
 * "首读不超过 20KB"是验收方案里的硬门槛，但全仓此前**只有零散的条数上界**：
 * `todo list` 默认 20 条、`project get` 默认不给事项清单、`batch` 有 64KB/256KB 两道上界。
 * 条数不等于体量 —— 20 条长描述就可能 30KB，而"按条数收"看着像已经管住了。
 *
 * 两张卡（work next 与 project get 的体量闸门）都要求同一件事：
 * **回执自己声明上界、实际不超过它、超了要说清方向**。判据只写这一份，
 * 两边都吃它 —— 否则下一次就是"两个 20KB、各自算各自的"。
 *
 * ## 为什么是"从尾部丢"而不是"砍字段"
 *
 * 砍字段会让回执**静默变形**（同一份 payload 有的项有 due、有的没有），
 * 调用方按"都有 due"写解析就会漏。丢条目是可见的：`truncated` + `dropped`，
 * 而且丢的都是排序上的尾部 —— 最该看的留在前面。
 *
 * ## 边界
 *
 * - 只量 `JSON.stringify` 之后的 UTF-8 字节数（与真实传输口径一致，中文是 3 字节）；
 * - **不做压缩、不做分页**：分页是命令自己的事，这里只回答"放不放得下"；
 * - 兜底：全部丢完还超预算时如实回 `overBudget: true`，不假装放得下。
 */

/** 首读预算：20 KB（验收方案 §4 的硬门槛；kb 按 1024 算，报字节数） */
export const FIRST_READ_BUDGET_BYTES = 20 * 1024

/** 量一份回执的字节数（UTF-8，与 stdout 的传输口径一致） */
export function measureJsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8')
}

export interface BudgetFit {
  /** 最终回执的字节数 */
  bytes: number
  /** 为了放进预算丢掉的条目数 */
  dropped: number
  /** 是否发生了截断（调用方要据此提示"还有更多"） */
  truncated: boolean
  /** 全丢完仍超预算 —— 调用方必须如实告诉调用者，而不是声称"都在里面" */
  overBudget: boolean
}

/**
 * 把回执压进预算。
 *
 * @param limitBytes 预算（通常 `FIRST_READ_BUDGET_BYTES`）
 * @param totalDroppable 最多能丢多少条（各列表可丢条目之和）
 * @param build 给定"丢几条"重新组装回执 —— 组装规则由命令自己定，
 *              本函数只管"放不放得下"，不猜哪一类该先丢
 *
 * 判据：**先量再丢，直到放得下**。丢的次序由 `build` 决定（work next 是
 * 可领 → 等人 → 挂起 → 该动，从最不紧急的一类开始），本函数不掺和。
 */
export function fitToBudget(
  limitBytes: number,
  totalDroppable: number,
  build: (dropped: number) => unknown
): BudgetFit {
  let bytes = measureJsonBytes(build(0))
  if (bytes <= limitBytes) return { bytes, dropped: 0, truncated: false, overBudget: false }
  for (let dropped = 1; dropped <= totalDroppable; dropped++) {
    bytes = measureJsonBytes(build(dropped))
    if (bytes <= limitBytes) return { bytes, dropped, truncated: true, overBudget: false }
  }
  return { bytes, dropped: totalDroppable, truncated: true, overBudget: bytes > limitBytes }
}
