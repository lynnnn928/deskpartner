/**
 * 待办事项状态
 *
 * proposed / awaiting_review 是「候选池」缓冲列：
 * agent 提议的事项先进 proposed，人确认后拖回 todo 才算立项；
 * agent 做完父需求放进 awaiting_review，人验收后自行拖到 done。
 * 两个状态都不由 agent 自行转入 —— 确认与验收是人独有的决定权。
 */
export type TodoStatus =
  | 'proposed'
  | 'todo'
  | 'in_progress'
  | 'suspended'
  | 'awaiting_review'
  | 'done'
  /**
   * 废弃（1.0.68，`a6032512` 的 e 项）
   *
   * **「不做 / 重复 / 被替代 / 无效」是正式结论，不是删除，也不是"待做"。**
   *
   * ## 为什么要有这个独立终态（而不是继续用「挂起」）
   *
   * `suspended` 的语义是"**还会回来做**"，所以它要求被定期回看。
   * 而"已决定不做"是**有答案的** —— 它不该再出现在任何待办视角里，
   * 却需要一个地方落着，好让"我们当初为什么不做"这件事**可查**。
   *
   * 实测（1.0.68）：挂起列 34 张里混着
   * 「已拍板不做」「等基建」「等你点名」「别的项目的」四种 ——
   * **一个状态同时装着"已完成"和"在等人"，于是谁都扫不出来。**
   *
   * ## 与 `suspended` 的分工
   *
   * | | 语义 | 还要不要回顾 |
   * |---|---|---|
   * | `suspended` | 等条件满足再回来做 | 要，得记住在等什么 |
   * | `discarded` | **不做了，这是结论** | 不用，它已经有答案了 |
   *
   * 参照 Linear：Rejected / Duplicate → Canceled 并写原因，**不是删掉**。
   *
   * ⚠️ 它**不是 `done`** —— `done` 是"做完了"，`discarded` 是"不做了"。
   * 混用会让"完成率"这个数字失真。
   */
  | 'discarded'

/** 待办优先级 */
export type TodoPriority = 'urgent' | 'high' | 'normal' | 'low'

/**
 * 事项类型
 *
 * bug（缺陷）/ feature（需求）是「为什么会有这条事项」的性质，
 * task 是默认兜底 —— 大多数事项就是普通的任务，不该逼人每次都选。
 *
 * 展示上 task 不显示徽标（整屏都是徽标等于没有徽标，与优先级色点同一原则）；
 * bug / feature 各给一种颜色，扫一眼能分出"哪些是问题、哪些是想法"。
 */
export type TodoType = 'bug' | 'feature' | 'task'

/** 主题模式 */
export type ThemeMode = 'light' | 'dark'

/** 风格预设 */
export type StylePreset = 'frosted' | 'japanese'

/** 全局字号缩放 */
export type FontSizeScale = 'small' | 'normal' | 'large'

/** 内边距/间距档位 */
export type SpacingPreset = 'compact' | 'standard' | 'spacious'
