import { app } from 'electron'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import electronUpdater from 'electron-updater'
import { ElectronHttpExecutor } from 'electron-updater/out/electronHttpExecutor'
import type { AppUpdater } from 'electron-updater'
import type { UpdateStatus } from '../../renderer/types/ipc'

const { NsisUpdater } = electronUpdater

function safeAppVersion(): string {
  try {
    return app?.getVersion?.() || '0.0.0'
  } catch {
    return '0.0.0'
  }
}

export class AutoUpdateService {
  private state: UpdateStatus = {
    status: 'idle',
    currentVersion: safeAppVersion(),
    availableVersion: null,
    releaseDate: null,
    progressPercent: null,
    errorMessage: null,
    checkedAt: null
  }

  private updater: AppUpdater | null = null

  private ensureUpdater(): AppUpdater {
    if (this.updater) return this.updater

    const feedOverride = process.env.DESKPARTNER_UPDATE_FEED_URL?.trim()
    const options = feedOverride
      ? { provider: 'generic' as const, url: feedOverride }
      : { provider: 'github' as const, owner: 'lynnnn928', repo: 'deskpartner' }

    const cacheDir = path.join(os.tmpdir(), 'desk-partner-updater-cache')
    const defaultCfg = path.join(process.resourcesPath || process.cwd(), 'app-update.yml')
    let cfgPath = defaultCfg
    if (!fs.existsSync(cfgPath)) {
      fs.mkdirSync(cacheDir, { recursive: true })
      cfgPath = path.join(cacheDir, 'app-update.yml')
      fs.writeFileSync(
        cfgPath,
        'provider: github\nowner: lynnnn928\nrepo: deskpartner\nupdaterCacheDirName: desk-partner-updater\n',
        'utf8'
      )
    }

    const appAdapter = {
      version: safeAppVersion(),
      name: 'desk-partner',
      isPackaged: Boolean(app?.isPackaged || feedOverride),
      appUpdateConfigPath: cfgPath,
      userDataPath: (() => {
        try {
          return app?.getPath?.('userData') || path.join(os.tmpdir(), 'desk-partner-updater')
        } catch {
          return path.join(os.tmpdir(), 'desk-partner-updater')
        }
      })(),
      baseCachePath: cacheDir,
      whenReady: () => (app?.whenReady ? app.whenReady() : Promise.resolve()),
      quit: () => app?.quit?.(),
      relaunch: () => app?.relaunch?.(),
      onQuit: (handler: (exitCode: number) => void) => {
        app?.once?.('quit', (_e: unknown, code: number) => handler(code))
      }
    }

    const nsisUpdater = new NsisUpdater(null, appAdapter as never)
    const httpExec = new ElectronHttpExecutor()
    if (feedOverride || !app?.isPackaged) {
      httpExec.createRequest = (reqOpts: Record<string, unknown>, cb: (res: unknown) => void) => {
        const mod = reqOpts.protocol === 'https:' ? https : http
        return mod.request(reqOpts as http.RequestOptions, cb as (res: http.IncomingMessage) => void) as never
      }
    }
    ;(nsisUpdater as unknown as { httpExecutor: unknown }).httpExecutor = httpExec
    // 开源版不买商业代码签名证书，跳过 Authenticode 签名阻塞校验（保留 sha512 完整性校验）
    nsisUpdater.verifyUpdateCodeSignature = async () => null
    nsisUpdater.autoDownload = false
    nsisUpdater.autoInstallOnAppQuit = true
    nsisUpdater.disableWebInstaller = true
    nsisUpdater.disableDifferentialDownload = true

    if (feedOverride) {
      nsisUpdater.forceDevUpdateConfig = true
    }
    nsisUpdater.setFeedURL(options)

    nsisUpdater.on('checking-for-update', () => {
      this.state = {
        ...this.state,
        currentVersion: safeAppVersion(),
        status: 'checking',
        errorMessage: null
      }
    })

    nsisUpdater.on('update-available', (info) => {
      this.state = {
        ...this.state,
        currentVersion: safeAppVersion(),
        status: 'available',
        availableVersion: info?.version ?? null,
        releaseDate: typeof info?.releaseDate === 'string' ? info.releaseDate : null,
        progressPercent: null,
        errorMessage: null,
        checkedAt: new Date().toISOString()
      }
    })

    nsisUpdater.on('update-not-available', (info) => {
      this.state = {
        ...this.state,
        currentVersion: safeAppVersion(),
        status: 'not-available',
        availableVersion: info?.version ?? null,
        progressPercent: null,
        errorMessage: null,
        checkedAt: new Date().toISOString()
      }
    })

    nsisUpdater.on('download-progress', (progress) => {
      this.state = {
        ...this.state,
        status: 'downloading',
        progressPercent: Math.round(progress?.percent ?? 0),
        errorMessage: null
      }
    })

    nsisUpdater.on('update-downloaded', (info) => {
      this.state = {
        ...this.state,
        status: 'downloaded',
        availableVersion: info?.version ?? this.state.availableVersion,
        progressPercent: 100,
        errorMessage: null
      }
    })

    nsisUpdater.on('error', (err) => {
      this.state = {
        ...this.state,
        status: 'error',
        errorMessage: err instanceof Error ? err.message : String(err),
        checkedAt: new Date().toISOString()
      }
    })

    this.updater = nsisUpdater
    return nsisUpdater
  }

  getState(): UpdateStatus {
    return {
      ...this.state,
      currentVersion: safeAppVersion()
    }
  }

  async checkForUpdates(): Promise<UpdateStatus> {
    const feedOverride = process.env.DESKPARTNER_UPDATE_FEED_URL?.trim()
    if (!app?.isPackaged && !feedOverride) {
      this.state = {
        ...this.state,
        currentVersion: safeAppVersion(),
        status: 'not-available',
        availableVersion: safeAppVersion(),
        errorMessage: null,
        checkedAt: new Date().toISOString()
      }
      return this.getState()
    }

    const updater = this.ensureUpdater()
    try {
      await updater.checkForUpdates()
    } catch (err) {
      this.state = {
        ...this.state,
        status: 'error',
        errorMessage: err instanceof Error ? err.message : String(err),
        checkedAt: new Date().toISOString()
      }
    }
    return this.getState()
  }

  async downloadUpdate(): Promise<UpdateStatus> {
    const updater = this.ensureUpdater()
    try {
      this.state = {
        ...this.state,
        status: 'downloading',
        progressPercent: 0,
        errorMessage: null
      }
      await updater.downloadUpdate()
    } catch (err) {
      this.state = {
        ...this.state,
        status: 'error',
        errorMessage: err instanceof Error ? err.message : String(err)
      }
    }
    return this.getState()
  }

  quitAndInstall(): { quitting: boolean } {
    const updater = this.ensureUpdater()
    setImmediate(() => {
      updater.quitAndInstall(false, true)
    })
    return { quitting: true }
  }
}

export const autoUpdateService = new AutoUpdateService()
