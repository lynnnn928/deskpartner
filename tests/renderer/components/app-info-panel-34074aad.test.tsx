// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import React from 'react'
import { AppInfoDialog } from '../../../src/renderer/components/appinfo/AppInfoDialog'
import { parseChangelog, formatChangelogDate } from '../../../src/renderer/lib/changelog'

/**
 * 应用信息面板（卡 `34074aad`）
 *
 * 面板分四段：身份 → 软件更新 → 更新日志 → 版权。
 * 这里钉住四件事：
 * ① 更新日志解析认「## 版本（日期）」与要点，不把别的二级标题当版本；
 * ② 当前版本排在最前并打「当前版本」标，其余收进折叠；
 * ③ 更新状态来自主进程，available 时给「新版本 vX 可用」+主按钮；
 * ④ 外链走主进程白名单通道，不在应用内跳转。
 */
const invokeMock = vi.fn()

vi.mock('../../../src/renderer/lib/ipc-client', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  on: () => () => {}
}))

const CHANGELOG = `# 更新日志（CHANGELOG）

本文档记录 DeskPartner 历次版本的演进。

## 1.0.146（2026-11-13）

应用信息面板上线（aaaaaaa）

- 侧栏底部新增应用信息入口（aaaaaaa）
- 更新日志读随包的 CHANGELOG.md（bbbbbbb）

## 1.0.145（2026-11-12）

附件与续传（ccccccc）

- 事项附件可以直接粘贴（ccccccc）
`

const updateOf = (status: string, availableVersion: string | null = null) => ({
  status,
  currentVersion: '1.0.146',
  availableVersion,
  releaseDate: null,
  progressPercent: null,
  errorMessage: null,
  checkedAt: null
})

beforeEach(() => {
  invokeMock.mockReset()
  invokeMock.mockImplementation(async (channel: string) => {
    switch (channel) {
      case 'app:info':
        return { version: process.env.TEST_APP_VERSION || '1.0.146', dataDir: 'C:/tmp/dp' }
      case 'settings:get':
        return { appName: 'DeskPartner', appIcon: null }
      case 'app:getUpdateState':
        return updateOf('idle')
      case 'app:changelog':
        return { markdown: CHANGELOG }
      default:
        return { ok: true }
    }
  })
})

afterEach(() => {
  cleanup()
  delete process.env.TEST_APP_VERSION
})

describe('更新日志解析', () => {
  it('切出版本、日期、小结与要点，别的二级标题不误判', () => {
    const entries = parseChangelog(CHANGELOG + '\n## 附：怎么读这份日志\n\n正文\n')
    expect(entries.map((e) => e.version)).toEqual(['1.0.146', '1.0.145'])
    expect(entries[0].date).toBe('2026-11-13')
    expect(entries[0].summary).toBe('应用信息面板上线（aaaaaaa）')
    expect(entries[0].bullets).toEqual([
      '侧栏底部新增应用信息入口（aaaaaaa）',
      '更新日志读随包的 CHANGELOG.md（bbbbbbb）'
    ])
  })

  it('日期是 `2026-11-13` 时排成中文，认不出就原样返回', () => {
    expect(formatChangelogDate('2026-11-13')).toBe('2026年11月13日')
    expect(formatChangelogDate('十月中旬')).toBe('十月中旬')
  })
})

describe('应用信息面板', () => {
  it('身份与更新日志：当前版本排最前并打标，其余进折叠', async () => {
    render(<AppInfoDialog open onClose={() => undefined} />)

    expect(screen.getByText('应用信息')).toBeTruthy()
    await waitFor(() => expect(screen.getByText('v1.0.146')).toBeTruthy())
    expect(screen.getByText('DeskPartner')).toBeTruthy()
    expect(screen.getByText('最近更新 2026年11月13日', { exact: false })).toBeTruthy()

    const current = screen.getByTestId('app-info-changelog-current')
    expect(current.textContent).toContain('当前版本')
    expect(current.textContent).toContain('侧栏底部新增应用信息入口')

    // 更早的版本收在折叠里：默认不展开，但条目已经渲染在 details 内
    expect(screen.getByText('更早的版本（1）')).toBeTruthy()
    expect(screen.getByText('v1.0.145')).toBeTruthy()
  })

  it('有新版本时给「新版本 vX 可用」与主按钮，并给更新说明外链', async () => {
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === 'app:info') return { version: '1.0.146', dataDir: 'C:/tmp/dp' }
      if (channel === 'settings:get') return { appName: 'DeskPartner', appIcon: null }
      if (channel === 'app:getUpdateState') return updateOf('available', '1.0.147')
      if (channel === 'app:changelog') return { markdown: CHANGELOG }
      return { ok: true }
    })

    render(<AppInfoDialog open onClose={() => undefined} />)
    await waitFor(() => expect(screen.getByText('新版本 v1.0.147 可用')).toBeTruthy())
    expect(screen.getByTestId('app-info-download-btn').textContent).toContain('下载并更新')

    fireEvent.click(screen.getByText('更新说明'))
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith('app:openExternal', {
        url: 'https://github.com/lynnnn928/deskpartner/releases/tag/v1.0.147'
      })
    )
  })

  it('没有新版本时给「已是最新版本」与手动检查，点检查走同一条 IPC', async () => {
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === 'app:info') return { version: '1.0.146', dataDir: 'C:/tmp/dp' }
      if (channel === 'settings:get') return { appName: 'DeskPartner', appIcon: null }
      if (channel === 'app:getUpdateState') return updateOf('not-available')
      if (channel === 'app:changelog') return { markdown: CHANGELOG }
      if (channel === 'app:checkForUpdates') return updateOf('not-available')
      return { ok: true }
    })

    render(<AppInfoDialog open onClose={() => undefined} />)
    await waitFor(() => expect(screen.getByText('已是最新版本')).toBeTruthy())
    fireEvent.click(screen.getByTestId('app-info-check-btn'))
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('app:checkForUpdates'))
  })

  it('官网与 GitHub 都交给主进程打开，不自己拼跳转', async () => {
    render(<AppInfoDialog open onClose={() => undefined} />)
    fireEvent.click(screen.getByText('DeskPartner 官网'))
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith('app:openExternal', {
        url: 'https://lynnnn928.github.io/deskpartner/'
      })
    )
    fireEvent.click(screen.getByText('github.com/lynnnn928/deskpartner'))
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith('app:openExternal', {
        url: 'https://github.com/lynnnn928/deskpartner'
      })
    )
  })
})
