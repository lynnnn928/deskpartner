/**
 * 更新日志解析（应用信息面板）
 *
 * 真源是仓库里的 `CHANGELOG.md`（随包发布），格式约定：
 *
 *     ## 1.0.145（2026-11-12）
 *
 *     一句话小结（可选）
 *
 *     - 要点一
 *     - 要点二
 *
 * 解析只做切分，不改写任何文案 —— 界面显示的就是 changelog 里写的原话。
 * 认不出的段落直接跳过：changelog 是人手写的，宁可少显示一条，也不要把
 * 正文里的 `##` 二级标题误当成一个版本号。
 */

export interface ChangelogEntry {
  /** 版本号，如 `1.0.145` */
  version: string
  /** 原始日期串（`2026-11-12`），认不出就空串 */
  date: string
  /** 标题下一段话（可空） */
  summary: string
  /** 该版本的要点列表 */
  bullets: string[]
}

/** `## 1.0.145（2026-11-12）` / `## 1.0.145 (2026-11-12)` / `## 1.0.145` */
const HEADING = /^##\s+v?(\d+\.\d+\.\d+)\s*(?:[（(]\s*([^）)]*?)\s*[）)])?\s*$/

export function parseChangelog(markdown: string): ChangelogEntry[] {
  const entries: ChangelogEntry[] = []
  let current: ChangelogEntry | null = null
  let sawParagraph = false

  for (const rawLine of markdown.replace(/\r\n/g, '\n').split('\n')) {
    const line = rawLine.trimEnd()
    const heading = HEADING.exec(line.trim())
    if (heading) {
      current = { version: heading[1], date: heading[2] ?? '', summary: '', bullets: [] }
      entries.push(current)
      sawParagraph = false
      continue
    }
    if (!current) continue
    if (!line.trim()) continue
    if (line.startsWith('#')) {
      // 更高级/同级的其它标题：这一版的内容到此为止
      current = null
      continue
    }
    if (line.startsWith('- ') || line.startsWith('* ')) {
      current.bullets.push(line.slice(2).trim())
      sawParagraph = true
      continue
    }
    if (!sawParagraph && !current.summary) {
      current.summary = line.trim()
      sawParagraph = true
    }
  }

  return entries
}

/** 把 `2026-11-12` 排成 `2026年11月12日`；认不出就原样返回 */
export function formatChangelogDate(raw: string): string {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(raw.trim())
  if (!m) return raw.trim()
  return `${m[1]}年${Number(m[2])}月${Number(m[3])}日`
}

/** 当前版本在日志里的那一版（找不到时返回 null） */
export function findVersion(markdown: string, version: string): ChangelogEntry | null {
  const target = version.replace(/^v/i, '')
  return parseChangelog(markdown).find((e) => e.version === target) ?? null
}
