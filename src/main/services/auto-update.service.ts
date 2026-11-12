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
import { downloadWithResume } from './resumable-download'

const { NsisUpdater } = electronUpdater

type UpdaterDownloadOptions = Parameters<ElectronHttpExecutor['download']>[2]

/** 单次尝试里多久没收到数据就断开重连（卡 `0ec0703b`） */
function stallMsFromEnv(): number {
  return Number(process.env.DESKPARTNER_UPDATE_STALL_MS) || 30_000
}

/** 最多重连多少次（每次接着上次的字节下）。10 次 ≈ 慢网络上最多耐心 5–10 分钟 */
function maxAttemptsFromEnv(): number {
  return Math.max(1, Number(process.env.DESKPARTNER_UPDATE_MAX_ATTEMPTS) || 10)
}

function safeAppVersion(): string {
  try {
    return app?.getVersion?.() || '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/**
 * 断点续传版的下载执行器（卡 `0ec0703b`）
 *
 * 只换掉 `download()` 一件事：electron-updater 自己的全量下载是
 * `createWriteStream(destination)`（截断写，无 Range），断一次就从 0 重来。
 * 取清单、sha512 校验、缓存改名与安装触发仍然走它的流程 —— 我们只保证
 * 交给它的那个临时文件是完整且正确的。
 *
 * 请求仍走 `ElectronHttpExecutor.createRequest`，所以打包版还是 Electron net
 * （带系统代理与证书），开发/自建源那条路才换成 node http（见 ensureUpdater）。
 */
class ResumableHttpExecutor extends ElectronHttpExecutor {
  stallMs = 30_000
  maxAttempts = 10
  /** 半成品目录：必须落在 electron-updater 不会清理的位置（它失败时会清空 pending/） */
  resumeDir = ''
  log: (message: string) => void = () => {}

  override async download(
    url: URL,
    destination: string,
    options: UpdaterDownloadOptions
  ): Promise<string> {
    const token = options.cancellationToken as unknown as {
      cancelled?: boolean
      createPromise?: <T>(
        callback: (resolve: (value: T) => void, reject: (error: unknown) => void, onCancel: (cb: () => void) => void) => void
      ) => Promise<T>
    }

    const run = async (onCancel: (cb: () => void) => void): Promise<string> => {
      const result = await downloadWithResume({
        url,
        destination,
        resumeDir: this.resumeDir,
        headers: options.headers as Record<string, string | undefined> | null,
        sha512: options.sha512 ?? null,
        createRequest: (requestOptions, callback) =>
          this.createRequest(requestOptions as never, callback as never) as never,
        onProgress: options.onProgress,
        stallMs: this.stallMs,
        maxAttempts: this.maxAttempts,
        onCancel,
        isCancelled: () => Boolean(token?.cancelled),
        log: this.log
      })
      return result.filePath
    }

    if (typeof token?.createPromise !== 'function') return await run(() => {})
    return await token.createPromise<string>((resolve, reject, onCancel) => {
      void run(onCancel).then(resolve, reject)
    })
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
  private checkInFlight: Promise<UpdateStatus> | null = null

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
    const httpExec = new ResumableHttpExecutor()
    httpExec.stallMs = stallMsFromEnv()
    httpExec.maxAttempts = maxAttemptsFromEnv()
    /**
     * 半成品放 `partials/`，**不放 electron-updater 的 `pending/`**：
     * 它 `downloadedUpdateHelper.clear()` 时会 `emptyDir(pending)`，
     * 半成品要放在那里面，"这次没下完、下次接着下"就永远不成立（卡 `0ec0703b`）。
     */
    httpExec.resumeDir = path.join(cacheDir, 'partials')
    httpExec.log = (message: string) => console.warn(message)
    /**
     * 这个替换只装在**开发/自建更新源**那条路上（见下面的条件）。
     *
     * ── 安装包文件名那次 404 为什么不在这里修（卡 `99870984`）──
     * Releases 资产名与客户端请求名对不上（GitHub 把空格存成点号，
     * electron-updater 又把 url 里的空格换成连字符，见
     * `GitHubProvider.resolveFiles` 的 `p.replace(/ /g, "-")`），
     * 但**发布出去的正式版不该走这个分支**：`app.isPackaged` 为真且没设
     * `DESKPARTNER_UPDATE_FEED_URL` 时要走 Electron net（带证书与系统代理），
     * 换成 node http 会把代理和证书一起丢掉。在这里改写路径只会"本地测试过、
     * 正式版照旧 404"。
     *
     * 真正的修法在源头：`scripts/lib/latest-yml.mjs` 让清单里的 url 就是
     * GitHub 上那个**不带空格**的资产名（`DeskPartner.Setup.x.y.z.exe`）——
     * 两个方向的替换在它身上都是恒等变换，新老客户端的地址都对得上。
     *
     * ⚠️ 续传那层（`ResumableHttpExecutor`，卡 `0ec0703b`）不受这个条件影响：
     * 它替换的是 `download()`，两种传输都走它，也照旧用 `createRequest`。
     */
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

  /**
   * 检查更新（卡 `abb86b06`）
   *
   * 30 秒而不是 10 秒：github provider 是两跳（先从 api.github.com 取 release，
   * 再从 github.com 下 latest.yml），第二跳在走代理的机器上实测 6–8 秒、偶尔破 10 秒。
   * 10 秒的上限会让"第一次点必然失败、第二次才好"，看着像更新通道坏了。
   * 真断网时多等 20 秒也不算什么：按钮上写着「检查中…」，不是卡死。
   */
  async checkForUpdates(timeoutMs = 30_000): Promise<UpdateStatus> {
    if (this.checkInFlight) {
      return this.checkInFlight
    }

    const run = async (): Promise<UpdateStatus> => {
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
      this.state = {
        ...this.state,
        currentVersion: safeAppVersion(),
        status: 'checking',
        errorMessage: null
      }

      let timer: ReturnType<typeof setTimeout> | null = null
      try {
        await Promise.race([
          updater.checkForUpdates(),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              reject(new Error('连接更新源超时，请稍后重试'))
            }, timeoutMs)
          })
        ])
      } catch (err) {
        this.state = {
          ...this.state,
          status: 'error',
          errorMessage: err instanceof Error ? err.message : String(err),
          checkedAt: new Date().toISOString()
        }
      } finally {
        if (timer) clearTimeout(timer)
      }
      return this.getState()
    }

    this.checkInFlight = run().finally(() => {
      this.checkInFlight = null
    })
    return this.checkInFlight
  }

  /**
   * 下载安装包（卡 `0ec0703b`：断线要能接着下）
   *
   * 判"卡住"与"重连"都搬进了执行器（`ResumableHttpExecutor` → `downloadWithResume`），
   * 这里只做两件事：把状态摆成「下载中」，以及把最终结局说成人话。
   *
   * 为什么不再在服务层放一个"多久没数据就判失败"的看门狗：那个判据会把
   * **正在自动重连**的下载判成失败（卡 `a3b196c7` 当时的做法，只报错不打捞）。
   * 现在单次尝试的静默期由 `DESKPARTNER_UPDATE_STALL_MS` 管、重连次数由
   * `DESKPARTNER_UPDATE_MAX_ATTEMPTS` 管，两者都封顶，所以不会出现"永远下载中"。
   * 半成品留在 `partials/`：这一次没下完，下一次点「立即更新」是接着下，不是从头下。
   */
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
      // update-downloaded 事件通常已经把状态写好了；没到就自己兜一句，
      // 免得调用方拿到一个还写着 downloading 的回执
      if (this.state.status === 'downloading') {
        this.state = { ...this.state, status: 'downloaded', progressPercent: 100 }
      }
    } catch (err) {
      /**
       * 前缀是给界面看的（卡 `99870984`）：以前失败一律写「检查失败」，
       * 于是"点了下载却下不下来"被说成"检查更新失败" —— 与刚做完的检查矛盾。
       * 界面按这个前缀分「下载失败 / 检查失败」（SystemSection）。
       */
      const message = err instanceof Error ? err.message : String(err)
      this.state = {
        ...this.state,
        status: 'error',
        progressPercent: null,
        errorMessage: `下载更新失败：${message}`
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
