// @vitest-environment happy-dom
/**
 * 自动更新与设置开关验证（卡 `cc635070` 第 2 项）
 *
 * 1. 设置持久化：`SettingsRepository` 默认 `autoCheckUpdate = true`，属于 `SYSTEM_SETTING_KEYS`（备份导入不覆盖）；
 * 2. 界面渲染断言：`SystemSection` 渲染「自动检查更新」开关、`TelemetrySection` 注明「仅检查更新时访问 GitHub Releases，不上传任何数据」；
 *    发现新版时展示「下载 vX.Y.Z」，下载完成后展示「重启并安装 vX.Y.Z」；
 * 3. `electron-updater` 端到端实测：本地 HTTP 服务托管真实 `latest.yml` 与安装包字节，
 *    旧版（1.0.132）调用 `checkForUpdates()` 收到 `1.0.133` 升级提示，调用 `downloadUpdate()` 完成下载与 sha512 校验。
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
import { useSettingsStore } from '../../../../src/renderer/stores/settings.store'
import { AutoUpdateService } from '../../../../src/main/services/auto-update.service'

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

  it('2. 渲染断言：SystemSection 显示「自动检查更新」开关与新版下载/重启安装按钮，TelemetrySection 显示更新隐私说明', async () => {
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
        return {
          status: 'available',
          currentVersion: '1.0.132',
          availableVersion: '1.0.133',
          releaseDate: '2026-10-29T09:52:54.270Z',
          progressPercent: null,
          errorMessage: null,
          checkedAt: '2026-10-29T10:00:00.000Z'
        }
      }
      if (channel === 'app:downloadUpdate') {
        return {
          status: 'downloaded',
          currentVersion: '1.0.132',
          availableVersion: '1.0.133',
          releaseDate: '2026-10-29T09:52:54.270Z',
          progressPercent: 100,
          errorMessage: null,
          checkedAt: '2026-10-29T10:00:00.000Z'
        }
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
      expect(getByTestId('download-update-btn').textContent).toContain('下载 v1.0.133')
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
})
