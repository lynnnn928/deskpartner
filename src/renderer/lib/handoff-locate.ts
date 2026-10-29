/**
 * 接手说明的搜索落点（卡 c9dfbc87）
 *
 * 全局搜索对一份接手说明**只给一条结果**（`ProjectRepository.search` 每个项目至多一条
 * `handoff_markdown` 命中），点它此前只会 `onOpenProject` —— 落到项目概览上，
 * 关键词在第几段、甚至还在不在，界面上没有任何交代，人得自己在整篇说明里再找一遍。
 *
 * 这里只放三件与界面无关的事，好让这套定位能被真跑着验证，而不是只能靠人去点：
 * - 找出关键词的全部位置（**与仓储层 `instr(lower(handoff_markdown), lower(?))` 同口径**：
 *   大小写不敏感、按字面匹配，不把关键词当正则）；
 * - 把位置换算成行号，好让提示条说清"命中的是第几行"；
 * - 把命中那一段选中并滚进视野 —— textarea 里没有第二种"高亮"可用，原生选区就是它。
 */

/** 关键词在说明里的全部起始位置；不重叠（`aa` 在 `aaa` 里算 1 处，与逐处前进的 instr 同口径） */
export function findHandoffMatches(text: string, query: string): number[] {
  // 空关键词不能进 indexOf：空串在**每一个**位置都命中，会当场返回一堆假位置
  if (!query) return []
  const haystack = text.toLowerCase()
  const needle = query.toLowerCase()
  const offsets: number[] = []
  let from = 0
  for (;;) {
    const found = haystack.indexOf(needle, from)
    if (found < 0) return offsets
    offsets.push(found)
    from = found + needle.length
  }
}

/**
 * 1 起算的行号。
 * `\r\n` / 单独的 `\r` / `\n` 都只算一次换行：说明是纯文本列，
 * 存进去的可能是 Windows 编辑过的 CRLF，也可能是 LF，混着也有过。
 */
export function handoffMatchLine(text: string, offset: number): number {
  return text.slice(0, Math.max(0, offset)).split(/\r\n|\r|\n/).length
}

/**
 * 选中命中那一段，并让整块输入框出现在视口中部。
 *
 * 两件事都得做：选区回答"命中的是哪几个字"，滚动回答"它在哪儿" —— 说明往往
 * 比那个 12 行的输入框长得多，只选不滚的话人还是看不到它。
 * 选区是**瞬态**的（点一下别处就没了），所以页面上还有一条常驻提示条写明
 * "第几处 / 共几处 / 第几行"，见 `ProjectOverviewView`。
 */
export function revealHandoffMatch(textarea: HTMLTextAreaElement, start: number, end: number): void {
  // 不聚焦就没有可见的选区（未聚焦的 textarea 选区是灰的、几乎看不出来）
  textarea.focus()
  textarea.setSelectionRange(start, end)
  textarea.scrollIntoView({ block: 'center' })
}
