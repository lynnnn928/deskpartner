export interface HandoffReferenceItem {
  id: string
  title: string
  status: string
}

export interface HandoffReferenceResult {
  reference: string
  item: HandoffReferenceItem | null
  ambiguous: boolean
}

/**
 * 从项目接手说明提取显式事项引用。只认 #短号（8 位十六进制）或 #完整 UUID，
 * 不对普通数字、标题或裸十六进制串做猜测，避免把正文误识别为事项。
 */
export function extractHandoffTodoReferences(markdown: string): string[] {
  const found = new Set<string>()
  const pattern = /(^|[^a-z0-9_])#([0-9a-f]{8}(?:-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?)(?![a-z0-9_-])/gi
  let match: RegExpExecArray | null
  while ((match = pattern.exec(markdown))) found.add(match[2].toLowerCase())
  return [...found]
}

/**
 * 将引用限定在当前项目的实时事项数据中解析。短号多重命中时明确报告歧义，绝不任选一项。
 */
export function resolveHandoffTodoReferences(
  markdown: string,
  items: readonly HandoffReferenceItem[]
): HandoffReferenceResult[] {
  return extractHandoffTodoReferences(markdown).map((reference) => {
    const matches = items.filter((item) => {
      const id = item.id.toLowerCase()
      return reference.includes('-') ? id === reference : id.startsWith(reference)
    })
    return {
      reference,
      item: matches.length === 1 ? matches[0] : null,
      ambiguous: matches.length > 1
    }
  })
}
