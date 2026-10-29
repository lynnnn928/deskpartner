/**
 * 「收口结论有没有结构性要素」—— 全仓唯一一处判据（1.0.110，收 `eec2e1e7`）。
 *
 * ## 判什么
 *
 * \`todo close\`（1.0.67）写出的四段标记：做了什么 / 验证 / 什么算通过 / 取舍与遗留。
 * 收口文本里出现**至少一个**就算"有结构性要素"。
 *
 * ## 为什么要有这一个模块
 *
 * 同一件事原来三处各判一遍：
 * ① G5 判"有没有评论"（\`commands.ts\`）；
 * ② \`closureByTodo\` 判 SQL \`LIKE '%【做了什么】%'\`（只认一段）；
 * ③ \`todo close\` 自己硬写四个标记字符串。
 * **写出去的字和判进来的字分家**，改一处另一处就成了永远判不过 ——
 * 所以三个用途共用这里的常量与函数（同 \`error-codes\` 那条"分类只有一个出处"）。
 *
 * ## 为什么只要求一个标记，不要求四段齐
 *
 * 判的是"有没有结构"，不是"写得好不好" —— 后者需要人判，做不了闸门。
 * 而要求四段全齐会**逼出为过校验写的空壳段落**：
 * 1.0.67 做 \`todo close\` 时正是为了绕开这一点，才把三段做成**必填**，
 * 让"写全"成为最短路径而不是额外的纪律。
 *
 * ## 为什么不看"有没有评论"
 *
 * Bob实测：一次批量关 30 张卡，G5 全部放行，而其中一半当初只有一行字。
 * "有评论"不等于"交代过了"。
 */
export const CLOSURE_SECTION = {
  did: '【做了什么】',
  verified: '【验证】',
  passCriteria: '【什么算通过】',
  leftover: '【取舍与遗留】'
} as const

/** 四段标记的数组形式：判据按它扫（顺序即 \`todo close\` 的书写顺序） */
export const CLOSURE_SECTION_MARKERS: readonly string[] = [
  CLOSURE_SECTION.did,
  CLOSURE_SECTION.verified,
  CLOSURE_SECTION.passCriteria,
  CLOSURE_SECTION.leftover
]

/**
 * 这些文本里有没有收口结论的结构性要素。
 *
 * 入参给**多段文本**（描述 + 各条非驳回评论）而不是拼好的一个串：
 * 拼串会把"哪一段有标记"这件事抹掉，而"判定不该依赖拼接顺序与分隔符"。
 * 空值一律当"没写"处理 —— 不抛错，因为调用方的默认值本来就是 null。
 */
export function hasClosureSections(parts: readonly (string | null | undefined)[]): boolean {
  return parts.some((text) => {
    if (!text) return false
    return CLOSURE_SECTION_MARKERS.some((marker) => text.includes(marker))
  })
}
