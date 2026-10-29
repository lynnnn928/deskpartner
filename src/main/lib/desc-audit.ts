/**
 * 一次「描述变更」该留下怎样的审计内容（1.0.62）
 *
 * ── 为什么抽出来 ──
 *
 * 这条判据原先只写在 CLI 的 `todo update` 里。于是同一个动作走了两条路，
 * 待遇却不同：命令行改规格留痕，**界面改规格零痕迹** ——
 * 而界面恰恰是那个不看命令行的人在用的入口（68c7ccc1 的场景同理：
 * 删评论也是 CLI 有痕、界面无痕）。
 *
 * 抽出来的目的不是复用代码，而是让"什么叫一次值得记录的描述变更"
 * 只有一处答案。三处调用方（CLI 更新、界面更新、将来的批量动作）
 * 各自写一遍，早晚会出现某一侧悄悄少记一条的情况。
 */

export interface DescChangeEvent {
  action: 'description_changed'
  /**
   * 被改掉的那份原文。
   * 追加场景下为 null —— 追加的结果里本来就含着原文，
   * 再存一份只会让 events 表被同一段长文本撑大两倍。
   */
  before: string | null
  /** 改完之后的新全文（清空时为 null） */
  after: string | null
  mode: 'append' | 'replace'
  /**
   * 追加时「新内容从第几个字开始」（1.0.73，`482e4b03`）
   *
   * ── 为什么必须单独记一个数字 ──
   *
   * 追加场景**刻意不存 `before`**（上面那条注释：避免同一段长文本在 events
   * 里存两份）。代价是读侧拿不到原文，于是**算不出"这次到底加了哪几行"** ——
   * 它只知道"追加了、结果是这一整篇"，而人验收时要看的恰恰是
   * **那几行新东西**，不是重读一遍全文。
   *
   * 一个整数就把这件事闭合了：`after.slice(appendedFrom)` 就是新增部分，
   * 而它的成本与"再存一份全文"相差三个数量级。
   *
   * ⚠️ 它**不是**"追加标记"（`mode` 才是），而是**切片下标**。
   * 读侧不要用 `mode === 'append'` 去推它一定存在：老数据（1.0.73 之前
   * 写的）没有这个字段，那时渲染层要退回"显示全文"这条退路，
   * 而不是假设它有值然后 slice 出个 undefined。
   */
  appendedFrom?: number
}

/**
 * @param before 改动前的描述（null = 原先没有）
 * @param next   这次要写进去的值；**undefined = 这次压根没动描述**
 * @returns null = 不该记录
 */
export function buildDescChangeEvent(
  before: string | null,
  next: string | null | undefined
): DescChangeEvent | null {
  // 没提到描述：这不是一次描述变更
  if (next === undefined) return null
  // 原本没有描述：从无到有谈不上"冲掉了什么"，没有可被找回的旧文
  if (before === null) return null
  // 一字未改 —— 记下来只会淹没真正需要看的那些
  if (before === next) return null

  // 判定依据不是"用了哪个 flag"，而是事实：追加之后新值一定以旧值开头。
  // 这样哪怕将来又加了一种写法（或有人在别处直接改了 repo）也不会误判。
  const appended = next !== null && next.startsWith(before)

  return {
    action: 'description_changed',
    before: appended ? null : before,
    after: next,
    mode: appended ? 'append' : 'replace',
    /**
     * 追加起点 = 旧文长度。`after.slice(appendedFrom)` 即本次新增部分。
     *
     * ⚠️ 用 `before.length` 而不是 `after.indexOf(before) + before.length`：
     * 两者在"确实以 before 开头"时相等，但后者在重复文本上会取到**首个**
     * 匹配位置（`"ab" + "ab"` 时 indexOf 给 0），切出来的"新增部分"是错的。
     * 而 `appended` 这个判据本身成立，就意味着前缀恰好是 before ——
     * 直接量长度才是它真正的语义。
     *
     * 只有追加时才有意义；替换场景不写（`replace` 的 before 已存全文，
     * 读侧不缺信息，多一个字段就是多一处要对齐的东西）。
     */
    ...(appended ? { appendedFrom: before.length } : {})
  }
}
