// @vitest-environment happy-dom
/**
 * 自动更新与设置开关验证（卡 `cc635070` 第 2 项；1.0.137 随卡 `99870984` 扩充）
 *
 * 1. 设置持久化：`SettingsRepository` 默认 `autoCheckUpdate = true`，属于 `SYSTEM_SETTING_KEYS`（备份导入不覆盖）；
 * 2. 界面渲染断言：`SystemSection` 渲染「自动检查更新」开关、`TelemetrySection` 注明「仅检查更新时访问 GitHub Releases，不上传任何数据」；
 *    发现新版时展示「立即更新 vX.Y.Z」，下载完成后展示「重启并安装 vX.Y.Z」；
 * 3. `electron-updater` 端到端实测：本地 HTTP 服务托管真实 `latest.yml` 与安装包字节，
 *    旧版（1.0.132）调用 `checkForUpdates()` 收到 `1.0.133` 升级提示，调用 `downloadUpdate()` 完成下载与 sha512 校验；
 * 4. 卡 `99870984` 追加：一键下载完自动重启安装（设置页与侧栏两条路）、侧栏主动弹新版提醒、
 *    下载失败与检查失败分开说、以及"清单里的资产名不带空格"这条防 404 的判据。
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, waitFor } from '@testing-library/react'
import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'

const invokeMock = vi.fn()
vi.mock('../../../../src/renderer/lib/ipc-client', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  on: () => () => {}
}))

const currentVersionRef = { value: '1.0.132' }
vi.mock('electron', () => ({
  app: {
    getVersion: () => currentVersionRef.value,
    isPackaged: true,
    getPath: () => os.tmpdir(),
    once: () => {},
    on: () => {}
  }
}))

const memDb = new Database(':memory:')
vi.mock('../../../../src/main/database/index', () => ({
  getDatabase: () => memDb
}))

import { SettingsRepository } from '../../../../src/main/database/settings.repository'
import { SystemSection } from '../../../../src/renderer/components/settings/sections/SystemSection'
import { TelemetrySection } from '../../../../src/renderer/components/settings/sections/TelemetrySection'
import { Sidebar } from '../../../../src/renderer/components/kanban/Sidebar'
import { useSettingsStore } from '../../../../src/renderer/stores/settings.store'
import { AutoUpdateService } from '../../../../src/main/services/auto-update.service'
import {
  installerName,
  releasesAssetName,
  rewriteLatestYml,
  verifyLatestYml
} from '../../../../scripts/lib/latest-yml.mjs'

/** 更新状态的最小构造：只写这条用例真正关心的字段 */
const updateStatus = (patch: Record<string, unknown>) => ({
  status: 'available',
  currentVersion: '1.0.132',
  availableVersion: null,
  releaseDate: '2026-10-29T09:52:54.270Z',
  progressPercent: null,
  errorMessage: null,
  checkedAt: '2026-10-29T10:00:00.000Z',
  ...patch
})

describe('自动更新：设置开关、界面交互与 electron-updater 升级链路（cc635070）', () => {
  beforeEach(() => {
    memDb.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    memDb.prepare('DELETE FROM settings').run()
    invokeMock.mockReset()
  })

  it('1. SettingsRepository 默认开启 autoCheckUpdate，支持切换持久化，且备份导入不覆盖系统级开关', () => {
    const repo = new SettingsRepository()
    expect(repo.get().autoCheckUpdate).toBe(true)

    repo.update({ autoCheckUpdate: false })
    expect(repo.get().autoCheckUpdate).toBe(false)

    const importRes = repo.importFrom({ autoCheckUpdate: true, theme: 'dark' })
    expect(importRes.rejected.some((r) => r.key === 'autoCheckUpdate')).toBe(true)
    expect(repo.get().autoCheckUpdate).toBe(false)
  })

  it('2. 渲染断言：SystemSection 显示「自动检查更新」开关与新版更新/重启安装按钮，TelemetrySection 显示更新隐私说明', async () => {
    const updateSettingsMock = vi.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({
      settings: {
        ...useSettingsStore.getState().settings,
        autoCheckUpdate: true,
        telemetryEnabled: true
      },
      updateSettings: updateSettingsMock
    })

    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === 'app:info') return { version: '1.0.132', dataDir: 'C:/Data/desk-partner' }
      if (channel === 'app:getUpdateState') {
        return updateStatus({ availableVersion: '1.0.133' })
      }
      if (channel === 'app:downloadUpdate') {
        return updateStatus({ status: 'downloaded', availableVersion: '1.0.133', progressPercent: 100 })
      }
      return {}
    })

    const { getByText, getByTestId } = render(
      <div>
        <SystemSection />
        <TelemetrySection />
      </div>
    )

    expect(getByText('自动检查更新')).toBeTruthy()
    expect(getByText(/仅检查更新时访问 GitHub Releases，不上传任何数据/)).toBeTruthy()

    await waitFor(() => {
      expect(getByTestId('download-update-btn').textContent).toContain('立即更新 v1.0.133')
    })

    fireEvent.click(getByTestId('download-update-btn'))

    await waitFor(() => {
      expect(getByTestId('install-update-btn').textContent).toContain('重启并安装 v1.0.133')
    })
  })

  it('3. 真实 electron-updater 链路：旧版 1.0.132 从更新源检测到 1.0.133 提示并完成包校验下载', async () => {
    const tmpFeedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-update-feed-'))
    const installerName = 'DeskPartner Setup 1.0.133.exe'
    const installerBytes = Buffer.from('MZ-DESKPARTNER-1.0.133-TEST-INSTALLER-PAYLOAD')
    const sha512 = crypto.createHash('sha512').update(installerBytes).digest('base64')
    const latestYml = [
      'version: 1.0.133',
      'files:',
      `  - url: ${installerName}`,
      `    sha512: ${sha512}`,
      `    size: ${installerBytes.length}`,
      `path: ${installerName}`,
      `sha512: ${sha512}`,
      `releaseDate: '2026-10-29T09:52:54.270Z'`,
      ''
    ].join('\n')

    fs.writeFileSync(path.join(tmpFeedDir, 'latest.yml'), latestYml, 'utf8')
    fs.writeFileSync(path.join(tmpFeedDir, installerName), installerBytes)

    const server = http.createServer((req, res) => {
      const reqPath = decodeURIComponent((req.url || '/').split('?')[0])
      const filePath = path.join(tmpFeedDir, path.basename(reqPath))
      if (fs.existsSync(filePath)) {
        const stat = fs.statSync(filePath)
        res.writeHead(200, { 'Content-Length': stat.size })
        fs.createReadStream(filePath).pipe(res)
      } else {
        res.writeHead(404)
        res.end('Not found')
      }
    })

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const addr = server.address() as { port: number }
    const feedUrl = `http://127.0.0.1:${addr.port}`
    const prevFeed = process.env.DESKPARTNER_UPDATE_FEED_URL
    process.env.DESKPARTNER_UPDATE_FEED_URL = feedUrl
    currentVersionRef.value = '1.0.132'

    try {
      const svc = new AutoUpdateService()
      const checkRes = await svc.checkForUpdates()
      expect(checkRes.status).toBe('available')
      expect(checkRes.currentVersion).toBe('1.0.132')
      expect(checkRes.availableVersion).toBe('1.0.133')

      const dlRes = await svc.downloadUpdate()
      expect(dlRes.status).toBe('downloaded')
      expect(dlRes.availableVersion).toBe('1.0.133')
      expect(dlRes.progressPercent).toBe(100)
    } finally {
      if (prevFeed === undefined) delete process.env.DESKPARTNER_UPDATE_FEED_URL
      else process.env.DESKPARTNER_UPDATE_FEED_URL = prevFeed
      await new Promise<void>((resolve) => server.close(() => resolve()))
      fs.rmSync(tmpFeedDir, { recursive: true, force: true })
    }
  })

  it('4. 开源工程件齐全：LICENSE、package.json 元信息、CI workflow、CONTRIBUTING、SECURITY 与中英 README', () => {
    const root = process.cwd()
    const license = fs.readFileSync(path.join(root, 'LICENSE'), 'utf8')
    expect(license).toContain('MIT License')
    expect(license).toContain('Copyright (c) 2026 LiLin (lynnnn928)')

    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
    expect(pkg.license).toBe('MIT')
    expect(pkg.author).toContain('LiLin')
    expect(pkg.repository?.url).toBe('git+https://github.com/lynnnn928/deskpartner.git')
    expect(pkg.homepage).toBe('https://lynnnn928.github.io/deskpartner/')
    expect(pkg.build?.publish?.[0]).toEqual({
      provider: 'github',
      owner: 'lynnnn928',
      repo: 'deskpartner'
    })

    for (const rel of [
      '.github/workflows/ci.yml',
      '.github/ISSUE_TEMPLATE/bug_report.md',
      '.github/ISSUE_TEMPLATE/feature_request.md',
      '.github/pull_request_template.md',
      'CONTRIBUTING.md',
      'SECURITY.md',
      'README.md',
      'README.en.md',
      'docs/assets/kanban-board.png',
      'docs/assets/approval-view.png',
      'docs/assets/quickstart-view.png',
      'docs/assets/smartscreen-guide.svg'
    ]) {
      expect(fs.existsSync(path.join(root, rel)), `缺少工程文件: ${rel}`).toBe(true)
    }
  })

  it('5. 后台自动检查更新期间打开设置页会自动轮询收口，且更新源连接挂起时按超时收口为 error（6dce84a6）', async () => {
    let pollCount = 0
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === 'app:info') return { version: '1.0.134', dataDir: 'C:/Data/desk-partner' }
      if (channel === 'app:getUpdateState') {
        pollCount += 1
        if (pollCount === 1) {
          return {
            status: 'checking',
            currentVersion: '1.0.134',
            availableVersion: null,
            releaseDate: null,
            progressPercent: null,
            errorMessage: null,
            checkedAt: null
          }
        }
        return {
          status: 'not-available',
          currentVersion: '1.0.134',
          availableVersion: '1.0.134',
          releaseDate: null,
          progressPercent: null,
          errorMessage: null,
          checkedAt: '2026-10-30T00:00:00.000Z'
        }
      }
      return {}
    })

    const { getByTestId, getByText } = render(<SystemSection />)

    await waitFor(() => {
      expect(getByTestId('check-update-btn').textContent).toContain('检查中…')
    })

    await waitFor(
      () => {
        expect(getByTestId('check-update-btn').textContent).toContain('检查更新')
        expect(getByText('已是最新')).toBeTruthy()
      },
      { timeout: 2500 }
    )

    // 模拟更新源挂起不响应，验证 checkForUpdates 超时保护
    const hangingServer = http.createServer((_req, _res) => {
      // 故意不返回响应
    })
    await new Promise<void>((resolve) => hangingServer.listen(0, '127.0.0.1', () => resolve()))
    const addr = hangingServer.address() as { port: number }
    const prevFeed = process.env.DESKPARTNER_UPDATE_FEED_URL
    process.env.DESKPARTNER_UPDATE_FEED_URL = `http://127.0.0.1:${addr.port}`

    try {
      const svc = new AutoUpdateService()
      const res = await svc.checkForUpdates(150)
      expect(res.status).toBe('error')
      expect(res.errorMessage).toContain('超时')
    } finally {
      if (prevFeed === undefined) delete process.env.DESKPARTNER_UPDATE_FEED_URL
      else process.env.DESKPARTNER_UPDATE_FEED_URL = prevFeed
      hangingServer.closeAllConnections?.()
      await new Promise<void>((resolve) => hangingServer.close(() => resolve()))
    }
  })

  /**
   * ── 以下为卡 `99870984`（1.0.137）追加 ──
   * 三条针对"点一次就装好"与"下载失败别说成检查失败"，一条守住防 404 的资产名。
   */
  it('6. 设置页点「立即更新 v1.0.133」后下载完成自动重启安装，且「重启并安装」按钮仍照常渲染（99870984）', async () => {
    useSettingsStore.setState({
      settings: { ...useSettingsStore.getState().settings, autoCheckUpdate: true },
      updateSettings: vi.fn().mockResolvedValue(undefined)
    })

    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === 'app:info') return { version: '1.0.132', dataDir: 'C:/Data/desk-partner' }
      if (channel === 'app:getUpdateState') return updateStatus({ availableVersion: '1.0.133' })
      if (channel === 'app:downloadUpdate') {
        return updateStatus({ status: 'downloaded', availableVersion: '1.0.133', progressPercent: 100 })
      }
      if (channel === 'app:quitAndInstallUpdate') return { quitting: true }
      return {}
    })

    const { getByTestId } = render(<SystemSection />)

    await waitFor(() => {
      expect(getByTestId('download-update-btn').textContent).toContain('立即更新 v1.0.133')
    })

    fireEvent.click(getByTestId('download-update-btn'))

    // 下载完成即自动重启安装：用户不用再点第二次
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('app:quitAndInstallUpdate')
    })
    // 手动那条路也还在：下载完但用户想晚点装时，按钮得点得到
    expect(getByTestId('install-update-btn').textContent).toContain('重启并安装 v1.0.133')
  })

  it('7. 主界面侧栏主动弹新版提醒：available 时渲染 sidebar-update-banner（在用户底栏正上方），点「立即更新」下载完自动重启安装（99870984）', async () => {
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === 'app:getUpdateState') return updateStatus({ availableVersion: '1.0.136' })
      if (channel === 'app:downloadUpdate') {
        return updateStatus({ status: 'downloaded', availableVersion: '1.0.136', progressPercent: 100 })
      }
      if (channel === 'app:quitAndInstallUpdate') return { quitting: true }
      return null
    })

    const { container, getByTestId, getByText } = render(<Sidebar />)

    // 不进设置页也能看见新版本：挂载即拉一次，不必等下一次轮询
    await waitFor(() => {
      expect(getByTestId('sidebar-update-banner')).toBeTruthy()
    })
    expect(getByText('发现新版本 v1.0.136')).toBeTruthy()
    expect(getByTestId('sidebar-update-btn').textContent).toContain('立即更新')

    // 位置判据：紧挨着底部用户栏那一条的上方（不是被塞进项目列表里）
    const banner = getByTestId('sidebar-update-banner')
    expect(banner.parentElement).toBe(container.querySelector('aside.sidebar-nav'))
    expect(banner.nextElementSibling?.className).toContain('border-t border-border px-2 py-2')

    fireEvent.click(getByTestId('sidebar-update-btn'))

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('app:downloadUpdate')
    })
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('app:quitAndInstallUpdate')
    })
  })

  it('8. 侧栏更新条：下载中显示进度、下载完显示「已就绪」并可手动重启安装（99870984）', async () => {
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === 'app:getUpdateState') {
        return updateStatus({ status: 'downloading', availableVersion: '1.0.136', progressPercent: 42 })
      }
      return null
    })

    const first = render(<Sidebar />)
    await waitFor(() => {
      expect(first.getByText('正在下载 v1.0.136（42%）…')).toBeTruthy()
    })
    expect(first.queryByTestId('sidebar-update-btn')).toBeNull()
    first.unmount()

    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === 'app:getUpdateState') {
        return updateStatus({ status: 'downloaded', availableVersion: '1.0.136', progressPercent: 100 })
      }
      if (channel === 'app:quitAndInstallUpdate') return { quitting: true }
      return null
    })

    const second = render(<Sidebar />)
    await waitFor(() => {
      expect(second.getByText('新版本 v1.0.136 已就绪')).toBeTruthy()
    })

    fireEvent.click(second.getByTestId('sidebar-install-btn'))

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('app:quitAndInstallUpdate')
    })
  })

  it('9. 下载失败说「下载失败」，检查失败才说「检查失败」；主进程给下载错误加「下载更新失败：」前缀（99870984）', async () => {
    useSettingsStore.setState({
      settings: { ...useSettingsStore.getState().settings, autoCheckUpdate: true },
      updateSettings: vi.fn().mockResolvedValue(undefined)
    })

    // ① 下载失败（errorMessage 带前缀）→ 文案必须是「下载失败」
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === 'app:info') return { version: '1.0.132', dataDir: 'C:/Data/desk-partner' }
      if (channel === 'app:getUpdateState') {
        return updateStatus({ status: 'error', errorMessage: '下载更新失败：404 Not Found' })
      }
      return {}
    })
    const downloadFail = render(<SystemSection />)
    await waitFor(() => {
      expect(downloadFail.getByText('下载失败')).toBeTruthy()
    })
    expect(downloadFail.queryByText('检查失败')).toBeNull()
    downloadFail.unmount()

    // ② 检查失败（没有前缀）→ 仍然说「检查失败」
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === 'app:info') return { version: '1.0.132', dataDir: 'C:/Data/desk-partner' }
      if (channel === 'app:getUpdateState') {
        return updateStatus({ status: 'error', errorMessage: '连接更新源超时，请稍后重试' })
      }
      return {}
    })
    const checkFail = render(<SystemSection />)
    await waitFor(() => {
      expect(checkFail.getByText('检查失败')).toBeTruthy()
    })

    // ③ 前缀真的由 AutoUpdateService 加上：没先检查就下载 → 报的也是「下载更新失败：…」
    const svc = new AutoUpdateService()
    const res = await svc.downloadUpdate()
    expect(res.status).toBe('error')
    expect(res.errorMessage?.startsWith('下载更新失败：')).toBe(true)
  })

  it('10. 防 404：latest.yml 写的资产名不含空格、且等于 GitHub 归一化后的名字（99870984）', () => {
    const version = '1.0.136'
    // 本地产物名带空格：GitHub 存成点号，electron-updater 却把空格换成连字符 —— 两头都不是它
    expect(installerName(version)).toBe('DeskPartner Setup 1.0.136.exe')

    const asset = releasesAssetName(version)
    expect(asset).toBe('DeskPartner.Setup.1.0.136.exe')
    expect(asset).not.toContain(' ')
    // 不含空格 ⇒ GitHubProvider 那次 `replace(/ /g, '-')` 在它身上是恒等变换
    expect(asset.replace(/ /g, '-')).toBe(asset)
    // 且就是 GitHub 归一化后的资产名（上传那份带空格的文件得到的就是它）
    expect(asset).toBe(installerName(version).replace(/ /g, '.'))

    // 真的写一遍清单（在临时目录里，用真实字节核 sha512/size），再回读核对
    const tmpDist = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-latest-yml-'))
    try {
      const bytes = Buffer.from('MZ-DESKPARTNER-1.0.136-INSTALLER-PAYLOAD')
      fs.writeFileSync(path.join(tmpDist, installerName(version)), bytes)

      const written = rewriteLatestYml(version, { distDir: tmpDist, log: () => {} })
      expect(written.url).toBe(asset)
      // 清单指向的那份文件必须真的在磁盘上（上传、回读都靠它）
      expect(fs.existsSync(path.join(tmpDist, asset))).toBe(true)
      expect(fs.existsSync(path.join(tmpDist, installerName(version)))).toBe(true)
      expect(fs.readFileSync(path.join(tmpDist, 'latest.yml'), 'utf8')).toContain(`url: ${asset}`)

      const check = verifyLatestYml({ distDir: tmpDist, log: () => {} })
      expect(check.problems).toEqual([])
      expect(check.ok).toBe(true)
      expect(check.url).toBe(asset)

      // 反证：把清单退回带空格的名字，闸门必须说话（否则这条判据是恒真的）
      fs.writeFileSync(
        path.join(tmpDist, 'latest.yml'),
        fs.readFileSync(path.join(tmpDist, 'latest.yml'), 'utf8').replace(asset, installerName(version))
      )
      const stale = verifyLatestYml({ distDir: tmpDist, log: () => {} })
      expect(stale.ok).toBe(false)
      expect(stale.problems.join('; ')).toContain('404') // 含空格即必然 404
    } finally {
      fs.rmSync(tmpDist, { recursive: true, force: true })
    }
  })
})
