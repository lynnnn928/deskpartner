/**
 * 行级差异（接手说明修订历史用，36b44adb）
 *
 * 纯函数：把「上一版」与「这一版」按行比对，产出 same / add / del 序列。
 * 基于最长公共子序列（LCS），先剥掉公共前后缀再做 DP —— 修订之间通常只改几行，
 * 这样 DP 表只覆盖真正变动的中段。
 *
 * 约定：
 * - 按 `\n` 切行（`\r\n` 的 `\r` 先归一掉，避免 Windows 换行让每一行都显示成改动）；
 * - 空串视为 0 行（而不是 1 个空行），所以「从无到有」全是新增、「清空」全是删除；
 * - 行内顺序稳定：同一处改动里先 del 后 add，阅读习惯与常见 diff 一致。
 */
export type DiffLineType = 'same' | 'add' | 'del'

export interface DiffLine {
  type: DiffLineType
  text: string
}

export interface DiffStats {
  added: number
  removed: number
}

function splitLines(text: string): string[] {
  if (text === '') return []
  return text.replace(/\r\n/g, '\n').split('\n')
}

/**
 * 二维 LCS 只适合短文档。接手说明上限是 50,000 字符，但极端情况下行数
 * 会让 DP 表达到 GB 级；宁可明确降级为整段删除/新增，也不能卡死渲染进程。
 */
export const MAX_DIFF_CELLS = 8_000_000

export function diffLines(before: string, after: string): DiffLine[] {
  const a = splitLines(before)
  const b = splitLines(after)

  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }

  const head: DiffLine[] = a.slice(0, start).map((text) => ({ type: 'same', text }))
  const tail: DiffLine[] = a.slice(endA).map((text) => ({ type: 'same', text }))

  const midA = a.slice(start, endA)
  const midB = b.slice(start, endB)
  const n = midA.length
  const m = midB.length

  if ((n + 1) * (m + 1) > MAX_DIFF_CELLS) {
    return [
      ...head,
      ...midA.map((text) => ({ type: 'del' as const, text })),
      ...midB.map((text) => ({ type: 'add' as const, text })),
      ...tail
    ]
  }

  // lcs[i][j] = midA[i..] 与 midB[j..] 的最长公共子序列长度
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] =
        midA[i] === midB[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }

  const mid: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (midA[i] === midB[j]) {
      mid.push({ type: 'same', text: midA[i] })
      i++
      j++
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      mid.push({ type: 'del', text: midA[i] })
      i++
    } else {
      mid.push({ type: 'add', text: midB[j] })
      j++
    }
  }
  while (i < n) mid.push({ type: 'del', text: midA[i++] })
  while (j < m) mid.push({ type: 'add', text: midB[j++] })

  return [...head, ...mid, ...tail]
}

export function diffStats(lines: DiffLine[]): DiffStats {
  let added = 0
  let removed = 0
  for (const l of lines) {
    if (l.type === 'add') added++
    else if (l.type === 'del') removed++
  }
  return { added, removed }
}
