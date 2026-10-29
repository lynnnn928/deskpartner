/**
 * 剥离单行预览文本中的 Markdown 语法符号（#、**、`、>、<!-- --> 等），
 * 避免通知列表、项目动态、全局搜索等单行摘要直接裸露 Markdown 源码。
 */
export function stripMarkdown(raw: string | null | undefined): string {
  if (!raw) return ''
  return raw
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*---+$/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\n{2,}/g, ' · ')
    .replace(/\n/g, ' ')
    .trim()
}
