import { describe, expect, it } from 'vitest'
import { friendlyReleaseDeleteError, stripIpcPrefix } from '../../../src/renderer/lib/release-delete'

describe('版本删除文案', () => {
  it('去掉 IPC/仓储前缀，并在关联事项时给出下一步', () => {
    const raw = new Error('[IPC] release:delete: [ReleaseRepository] 版本 1.0.91 仍关联 3 条事项；请先逐条解除事项的 fixed_in_version，再删除版本')
    const msg = friendlyReleaseDeleteError(raw)
    expect(msg).not.toContain('[IPC]')
    expect(msg).not.toContain('ReleaseRepository')
    expect(msg).toContain('解除')
  })

  it('其他错误保留原因但不带前缀', () => {
    expect(friendlyReleaseDeleteError(new Error('[IPC] release:delete: [ReleaseRepository] 版本不存在'))).toBe('删除版本失败：版本不存在')
  })

  it('空错误给出兜底文案', () => {
    expect(friendlyReleaseDeleteError(undefined)).toContain('删除版本失败')
  })

  it('stripIpcPrefix 只剥通道前缀', () => {
    expect(stripIpcPrefix('[IPC] todo:update: 失败：x')).toBe('失败：x')
    expect(stripIpcPrefix('普通文本')).toBe('普通文本')
  })
})
