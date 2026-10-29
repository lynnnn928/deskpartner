/**
 * 版本删除的界面文案（纯函数，配单测）。
 *
 * IPC 错误形如 `[IPC] release:delete: [ReleaseRepository] 版本 1.0.91 仍关联 3 条事项；…`，
 * 前缀是给开发者排查用的，用户看到只会困惑。这里只取"人话"那一段，
 * 并在识别出「仍有关联事项」时告诉用户下一步。
 */
/** 去掉 IPC 通道前缀，保留人话。 */
export function stripIpcPrefix(message: string): string {
  // 通道名自身含冒号（release:delete），故用「非空白串 + 冒号 + 空白」整体匹配
  return message.replace(/^\[IPC\]\s+\S+:\s+/, '').trim()
}

export function friendlyReleaseDeleteError(raw: unknown): string {
  const text = raw instanceof Error ? raw.message : typeof raw === 'string' ? raw : ''
  const stripped = stripIpcPrefix(text).replace(/^\[[A-Za-z]+\]\s*/, '').trim()
  if (!stripped) return '删除版本失败，请稍后重试。'
  if (/仍关联\s*\d+\s*条事项/.test(stripped)) {
    return '该版本仍有事项关联，暂时不能删除。请先解除这些事项的版本标记，再删除版本。'
  }
  return `删除版本失败：${stripped}`
}

export const RELEASE_DELETE_LIST_LIMIT = 8
