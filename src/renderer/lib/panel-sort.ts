import dayjs from 'dayjs'
import type { Todo } from '../types/todo'

/**
 * 面板里的事项排序
 *
 * 规则只有一条：按记录时间正序，像一张手写清单，先记的在前。
 *
 * 早先这里还排了逾期、优先级、有无截止时间、已完成沉底，后来全砍了：
 * 面板上并不显示这些字段，一个**看不见依据的排序**只会让人觉得
 * "这列表怎么乱跳"。排序依据必须是界面上看得见的东西——
 * 界面上只有标题和时间，那就只按时间排。
 *
 * 也不按归属者排：AI 记的和人记的混在一起，谁先被看到由时间决定。
 * 刻意不把"我的"排在前面，否则人机共享就退化成"人的事优先"。
 */
export function compareForPanel(a: Todo, b: Todo): number {
  return dayjs(a.createdAt).valueOf() - dayjs(b.createdAt).valueOf()
}
