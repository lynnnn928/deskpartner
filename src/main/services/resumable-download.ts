/**
 * 断点续传下载（卡 `0ec0703b`）
 *
 * ── 为什么不用 electron-updater 自带的下载 ──
 * `electron-updater@6.8.11` 的全量下载是 `createWriteStream(destination)`：
 * 一开写就是截断，**没有任何 Range 续传**（`builder-util-runtime/out/httpExecutor.js`）。
 * 于是链接断在第 66% 时，用户再点一次「立即更新」还是从 0 重来 —— 在这类
 * 26–49 KB/s、每几十分钟静默断一次的链路上（2026-11-11 实测，见卡 `0ec0703b`），
 * 89MB 的安装包基本不可能自己下完。
 *
 * 这个模块把「下完这个文件」接管过来：单次尝试断流或卡住就断开重连，
 * 每次都从已下的字节接着下；半成品落在一个 **electron-updater 不会清** 的目录里，
 * 所以关掉应用、明天再点也照样接着下。校验（sha512）、改名、安装触发仍归
 * electron-updater —— 这里只保证那个临时文件最终是完整且正确的。
 *
 * 不引 `builder-util-runtime`（不是本仓库的直接依赖）：请求由调用方注入
 * （`createRequest`），于是本模块既不依赖 electron 也不依赖 electron-updater，
 * 可以直接用本地 HTTP 服务测。
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/** electron-updater 的 `download-progress` 事件形状：界面按 percent 显示 */
export interface DownloadProgressInfo {
  total: number
  delta: number
  transferred: number
  percent: number
  bytesPerSecond: number
}

export interface DownloadResponse {
  statusCode?: number
  statusMessage?: string
  headers: Record<string, string | string[] | undefined>
  on(event: string, listener: (...args: unknown[]) => void): void
  destroy?(error?: Error): void
  resume?(): void
  pause?(): void
}

export interface DownloadRequest {
  abort(): void
  end?(data?: unknown): void
  on(event: string, listener: (...args: unknown[]) => void): void
}

export type CreateDownloadRequest = (
  options: Record<string, unknown>,
  callback: (response: DownloadResponse) => void
) => DownloadRequest

export interface ResumableDownloadOptions {
  /** 资源地址（可以是 302 之前的地址，本模块自己跟跳转） */
  url: URL
  /** electron-updater 期望的临时文件路径：下完就搬到这儿 */
  destination: string
  /** 半成品目录：**必须是 electron-updater 不会清理的位置**（它失败时会清空 pending/） */
  resumeDir: string
  /** 请求头（electron-updater 给的，含它自己的 UA / 缓存策略） */
  headers?: Record<string, string | undefined> | null
  /** 期望的 sha512（base64）。对不上就先从 0 重下一次，仍对不上才报错 */
  sha512?: string | null
  createRequest: CreateDownloadRequest
  onProgress?: (progress: DownloadProgressInfo) => void
  /** 单次尝试里多久没收到数据就断开重连 */
  stallMs: number
  /** 最多尝试多少次（每次都是接着上次的字节下） */
  maxAttempts: number
  /** 取消：把中止回调交给调用方 */
  onCancel?: (abort: () => void) => void
  isCancelled?: () => boolean
  log?: (message: string) => void
}

export interface ResumableDownloadResult {
  filePath: string
  bytes: number
}

/** 半成品保留多久：够用户明天再点一次，也不会在临时目录里越积越多 */
const PARTIAL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const MAX_REDIRECTS = 5
/** 进度回调的最小间隔：每块都回调会把主进程刷爆 */
const PROGRESS_INTERVAL_MS = 200

/** 进度出口：一次下载共用一个，重连时用 setTransferred 校准 */
interface ProgressSink {
  setTotal(total: number | null): void
  setTransferred(transferred: number): void
  add(length: number): void
  flush(): void
}

class HttpStatusError extends Error {
  readonly statusCode: number

  constructor(statusCode: number, message: string) {
    super(message)
    this.name = 'HttpStatusError'
    this.statusCode = statusCode
  }
}

/** 半成品文件名带上 sha512 前 16 位：同名不同内容（重发同一版本号）不会互相串味 */
export function partialFilePathFor(resumeDir: string, url: URL, sha512?: string | null): string {
  // ⚠️ `decodeURIComponent` 遇到 `%zz` 这种残缺转义会抛错：名字只用于落盘，不能因为
  // 更新源给了一个怪地址就整个下载失败，所以解不开就用原样
  let pathname = url.pathname
  try {
    pathname = decodeURIComponent(pathname)
  } catch {
    /* 保持原样 */
  }
  const asset = path.basename(pathname) || 'update.bin'
  // ⚠️ 只留字母数字：sha512 是 base64，里头的 `/` 会把它变成子目录（不存在 → ENOENT）
  const tag = (sha512 ?? '').replace(/[^A-Za-z0-9]/g, '').slice(0, 16) || 'nosha'
  return path.join(resumeDir, `${asset}.${tag}.part`)
}

/** 进程还活着吗（用于判断半成品上的锁是不是遗留的） */
function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM = 进程在，只是没权限发信号
    return (error as { code?: string }).code === 'EPERM'
  }
}

/**
 * 半成品上的门锁
 *
 * 同一台机器上可能有**两个实例**同时更新（老版本还开着，或用户双击了两次）。
 * 两个进程往同一个 `.part` 里 append，会各自从自己的偏移写起 → 内容互相覆盖，
 * 谁都校验不过；更糟的是这个半成品会一直留着，后面每次续传都从烂文件接着写。
 * 所以：抢到锁的人用共享半成品（能续传），抢不到的人用带 pid 的私有半成品
 * （放弃这一次的续传，但不破坏别人的）。持锁进程已经不在了就接管 —— 崩溃不能
 * 让这个文件永远没人敢碰。
 */
function acquirePartialLock(partPath: string): { path: string; release: () => void } {
  const lockPath = `${partPath}.lock`
  const privatePath = `${partPath}.${process.pid}.part`

  const tryTake = (): boolean => {
    try {
      const fd = fs.openSync(lockPath, 'wx')
      try {
        fs.writeSync(fd, String(process.pid))
      } finally {
        fs.closeSync(fd)
      }
      return true
    } catch {
      return false
    }
  }

  const release = (): void => {
    try {
      fs.rmSync(lockPath, { force: true })
    } catch {
      /* 已经被清掉 */
    }
  }

  if (tryTake()) return { path: partPath, release }

  let owner: number | null = null
  try {
    owner = Number(fs.readFileSync(lockPath, 'utf8').trim())
  } catch {
    owner = null
  }
  if (owner != null && Number.isFinite(owner) && isProcessAlive(owner)) {
    return { path: privatePath, release: () => {} }
  }

  // 遗留锁：接管它
  fs.rmSync(lockPath, { force: true })
  if (tryTake()) return { path: partPath, release }
  return { path: privatePath, release: () => {} }
}

/** 清掉过期半成品（保留本次要用的那个） */
export function pruneStalePartials(resumeDir: string, keep: string, now = Date.now()): void {
  let names: string[]
  try {
    names = fs.readdirSync(resumeDir)
  } catch {
    return
  }
  for (const name of names) {
    if (!name.endsWith('.part')) continue
    const file = path.join(resumeDir, name)
    if (file === keep) continue
    try {
      if (now - fs.statSync(file).mtimeMs > PARTIAL_MAX_AGE_MS) fs.rmSync(file, { force: true })
    } catch {
      /* 正在被别的尝试写着：跳过 */
    }
  }
}

function fileSize(file: string): number {
  try {
    return fs.statSync(file).size
  } catch {
    return 0
  }
}

function headerValue(response: DownloadResponse, name: string): string | null {
  const value = response.headers[name] ?? response.headers[name.toLowerCase()]
  if (Array.isArray(value)) return value[0] ?? null
  return value ?? null
}

/** `bytes 100-999/1000` → { start: 100, total: 1000 }；416 的 `bytes *&#47;1000` → { start: null, total: 1000 } */
function parseContentRange(value: string | null): { start: number | null; total: number | null } | null {
  if (!value) return null
  const match = /^bytes\s+(\d+|\*)-(\d+|\*)\/(\d+|\*)$/.exec(value.trim())
  if (!match) return null
  return {
    start: match[1] === '*' ? null : Number(match[1]),
    total: match[3] === '*' ? null : Number(match[3])
  }
}

function isRetryable(error: Error): boolean {
  if (error instanceof HttpStatusError) {
    return error.statusCode >= 500 || error.statusCode === 408 || error.statusCode === 429
  }
  return (error as { code?: string }).code !== 'ERR_CHECKSUM_MISMATCH'
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${bytes} B`
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function createProgressSink(
  onProgress: ((progress: DownloadProgressInfo) => void) | undefined
): ProgressSink {
  let total: number | null = null
  let transferred = 0
  let reportedBytes = 0
  let reportedAt = 0
  const startedAt = Date.now()

  const emit = (force: boolean): void => {
    if (!onProgress) return
    const now = Date.now()
    if (!force && now - reportedAt < PROGRESS_INTERVAL_MS) return
    const elapsed = Math.max(1, now - startedAt)
    onProgress({
      total: total ?? transferred,
      delta: transferred - reportedBytes,
      transferred,
      percent: total != null && total > 0 ? Math.min(100, Math.round((transferred / total) * 100)) : 0,
      bytesPerSecond: Math.round((transferred / elapsed) * 1000)
    })
    reportedAt = now
    reportedBytes = transferred
  }

  return {
    setTotal: (value: number | null) => {
      total = value
    },
    setTransferred: (value: number) => {
      transferred = value
    },
    add: (length: number) => {
      transferred += length
      emit(false)
    },
    flush: () => emit(true)
  }
}

interface AttemptContext extends ResumableDownloadOptions {
  partPath: string
  attempt: number
  progress: ProgressSink
}

interface AttemptResult {
  completed: boolean
  transferred: number
  total: number | null
}

/** 发一次请求并等到响应头（未等到就 abort 重连） */
function requestOnce(
  options: ResumableDownloadOptions,
  requestOptions: Record<string, unknown>,
  onAbortable: (abort: () => void) => void
): Promise<DownloadResponse> {
  return new Promise<DownloadResponse>((resolve, reject) => {
    let settled = false
    let request: DownloadRequest | null = null

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        request?.abort()
      } catch {
        /* 已经结束 */
      }
      reject(new Error(`${Math.max(1, Math.round(options.stallMs / 1000))} 秒内没有等到响应`))
    }, options.stallMs)

    try {
      request = options.createRequest(requestOptions, (response) => {
        if (settled) {
          response.destroy?.()
          return
        }
        settled = true
        clearTimeout(timer)
        resolve(response)
      })
    } catch (error) {
      clearTimeout(timer)
      settled = true
      reject(error instanceof Error ? error : new Error(String(error)))
      return
    }

    onAbortable(() => {
      try {
        request?.abort()
      } catch {
        /* 已经结束 */
      }
    })
    request.on('error', (error: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error instanceof Error ? error : new Error(String(error)))
    })
    request.end?.()
  })
}

/**
 * 把响应体写进半成品；不抛错，把结局（写完了 / 断了 / 卡住了）交给调用方
 *
 * 两个容易踩的点：
 * ① 中止时要用 `end()` **把队列里的字节写完**再关，不能 `destroy()` —— 那会丢掉
 *    还没落盘的尾部字节，续传的偏移就比实际少（这次唯一"静默"的数据损失）；
 * ② 磁盘比网络慢时要暂停响应（backpressure），否则会把整包堆在内存里。
 */
function streamToFile(args: {
  response: DownloadResponse
  partPath: string
  append: boolean
  stallMs: number
  onChunk: (length: number) => void
  abortRequest: () => void
}): Promise<{ received: number; ended: boolean; error: Error | null }> {
  return new Promise((resolve) => {
    const { response, partPath, append, stallMs } = args
    const out = fs.createWriteStream(partPath, { flags: append ? 'a' : 'w' })
    let received = 0
    let done = false
    let ended = false
    let failure: Error | null = null
    let lastActivity = Date.now()

    const settle = (): void => {
      if (done) return
      done = true
      clearInterval(timer)
      resolve({ received, ended, error: failure })
    }

    const closeOutput = (): void => {
      try {
        out.end()
      } catch {
        out.destroy()
      }
    }

    const stop = (): void => {
      try {
        args.abortRequest()
      } catch {
        /* 已经结束 */
      }
      try {
        response.destroy?.()
      } catch {
        /* 已经结束 */
      }
      closeOutput()
    }

    const timer = setInterval(
      () => {
        if (done) return
        if (Date.now() - lastActivity >= stallMs) stop()
      },
      Math.max(200, Math.min(1000, Math.floor(stallMs / 2)))
    )

    out.on('close', settle)
    out.on('error', (error: unknown) => {
      failure = error instanceof Error ? error : new Error(String(error))
      stop()
    })
    out.on('drain', () => {
      try {
        response.resume?.()
      } catch {
        /* 流已经关了 */
      }
    })
    response.on('data', (chunk: unknown) => {
      if (done) return
      const buffer = chunk as Buffer
      lastActivity = Date.now()
      received += buffer.length
      args.onChunk(buffer.length)
      if (!out.write(buffer)) {
        try {
          response.pause?.()
        } catch {
          /* 流已经关了 */
        }
      }
    })
    response.on('end', () => {
      if (done) return
      ended = true
      closeOutput()
    })
    response.on('aborted', () => {
      if (done) return
      failure = new Error('连接被中断')
      stop()
    })
    response.on('error', (error: unknown) => {
      if (done) return
      failure = error instanceof Error ? error : new Error(String(error))
      stop()
    })
  })
}

/** 一次尝试：从半成品现有大小接着下，下到文件末尾算完成 */
async function attemptOnce(context: AttemptContext): Promise<AttemptResult> {
  const { partPath, log, progress } = context
  let offset = fileSize(partPath)
  progress.setTransferred(offset)
  let url = context.url
  let requestAbort: (() => void) | null = null

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const headers: Record<string, string | undefined> = { ...(context.headers ?? {}) }
    if (offset > 0) headers.Range = `bytes=${offset}-`
    const requestOptions: Record<string, unknown> = {
      protocol: url.protocol,
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'GET',
      headers
    }
    // 端口不显式写成 undefined：Electron net 对未预期的键更挑剔，缺省就是默认端口
    if (url.port) requestOptions.port = url.port

    const response = await requestOnce(context, requestOptions, (abort) => {
      requestAbort = abort
      context.onCancel?.(abort)
    })
    const abortThis = (): void => requestAbort?.()
    const status = response.statusCode ?? 0

    if (status >= 300 && status < 400) {
      const location = headerValue(response, 'location')
      response.resume?.()
      response.destroy?.()
      if (!location) throw new HttpStatusError(status, `下载跳转缺少目标地址（HTTP ${status}）`)
      url = new URL(location, url)
      continue
    }

    if (status === 416) {
      const range = parseContentRange(headerValue(response, 'content-range'))
      response.resume?.()
      response.destroy?.()
      if (range?.total != null && range.total === offset) {
        progress.setTotal(range.total)
        progress.setTransferred(offset)
        return { completed: true, transferred: offset, total: range.total }
      }
      fs.rmSync(partPath, { force: true })
      throw new Error('更新源拒绝了这个区间（HTTP 416），半成品已丢弃')
    }

    if (status >= 400) {
      response.resume?.()
      response.destroy?.()
      throw new HttpStatusError(
        status,
        `安装包下载失败：HTTP ${status}${response.statusMessage ? ` ${response.statusMessage}` : ''}`
      )
    }

    let total: number | null = null
    if (status === 206) {
      const range = parseContentRange(headerValue(response, 'content-range'))
      if (range?.start != null && range.start !== offset) {
        // 服务器给了另一个区间：不猜，丢掉半成品重来
        response.resume?.()
        response.destroy?.()
        throw new Error(`服务器返回的区间与请求不符（请求从 ${offset} 起，收到 ${range.start}）`)
      }
      total = range?.total ?? null
    } else {
      const length = Number(headerValue(response, 'content-length'))
      total = Number.isFinite(length) && length > 0 ? length : null
      if (offset > 0) {
        // 服务器不吃 Range（返回 200 全量）：从 0 重写，别把两段接错
        fs.rmSync(partPath, { force: true })
        offset = 0
        progress.setTransferred(0)
      }
    }
    progress.setTotal(total)

    const transferredBase = offset
    const streamed = await streamToFile({
      response,
      partPath,
      append: transferredBase > 0,
      stallMs: context.stallMs,
      onChunk: (length) => progress.add(length),
      abortRequest: () => abortThis()
    })
    /**
     * 完成与否看**盘上真实字节**，不看收到多少：写入失败或磁盘满时收到的比落盘的多，
     * 拿"收到"去比总量会得出"已完成"，然后卡在校验失败上绕远路。
     */
    const transferred = fileSize(partPath)
    progress.setTransferred(transferred)
    if (streamed.ended && (total == null || transferred >= total)) {
      return { completed: true, transferred, total }
    }
    // 写盘出错或连接报错：交给外层按"这次尝试失败"处理（半成品保留，下一次接着下）
    if (streamed.error) throw streamed.error
    log?.(
      `[updater] 第 ${context.attempt} 次尝试断流：已下 ${formatBytes(transferred)}` +
        `${total != null ? ` / ${formatBytes(total)}` : ''}`
    )
    return { completed: false, transferred, total }
  }

  throw new Error(`跳转次数超过 ${MAX_REDIRECTS} 次`)
}

function hashFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha512')
    hash.setEncoding('base64')
    fs.createReadStream(file, { highWaterMark: 1024 * 1024 })
      .on('error', reject)
      .on('end', () => {
        hash.end()
        resolve(hash.read() as string)
      })
      .pipe(hash, { end: false })
  })
}

/**
 * 把半成品搬到 electron-updater 期望的位置
 *
 * 不直接用 `renameSync` 一把梭：Windows 上杀毒软件正在扫这个新文件、或者别的进程
 * 短暂持有它，rename 会 EPERM/EBUSY —— 在这里失败，外层会当成"下载失败"把
 * 已经下完的 89MB 删掉（`removeFileIfAny`）。所以照 electron-updater 自己的做法
 * 重试几次，还不行就退化成"复制 + 删半成品"。
 */
async function moveIntoPlace(partPath: string, destination: string): Promise<void> {
  let lastError: unknown = null
  for (let i = 0; i < 10; i++) {
    try {
      fs.rmSync(destination, { force: true })
      fs.renameSync(partPath, destination)
      return
    } catch (error) {
      lastError = error
      const code = (error as { code?: string }).code
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') break
      await delay(200)
    }
  }
  try {
    fs.copyFileSync(partPath, destination)
    fs.rmSync(partPath, { force: true })
    return
  } catch (copyError) {
    throw lastError instanceof Error ? lastError : copyError
  }
}

/**
 * 下载安装包到 `destination`，中途断了就接着下。
 *
 * 成功返回时文件已完整、sha512（若给了）已校验通过、并已就位到 `destination`。
 * 失败抛错，但**半成品保留**：再调一次会从已下的字节继续。
 */
export async function downloadWithResume(options: ResumableDownloadOptions): Promise<ResumableDownloadResult> {
  const log = options.log ?? ((): void => {})
  const attempts = Math.max(1, options.maxAttempts)
  const basePath = partialFilePathFor(options.resumeDir, options.url, options.sha512)
  fs.mkdirSync(options.resumeDir, { recursive: true })
  pruneStalePartials(options.resumeDir, basePath)

  /**
   * 半成品上的门锁（见 acquirePartialLock 的说明）：抢不到就用自己的一份，
   * 不跟另一个实例往同一个文件里对写。整个下载过程都持锁，结束（成或败）才放。
   */
  const lock = acquirePartialLock(basePath)
  const partPath = lock.path

  try {
    return await runDownload(options, partPath, attempts, log)
  } finally {
    lock.release()
  }
}

async function runDownload(
  options: ResumableDownloadOptions,
  partPath: string,
  attempts: number,
  log: (message: string) => void
): Promise<ResumableDownloadResult> {
  const progress = createProgressSink(options.onProgress)
  let lastError: Error | null = null
  let checksumRetried = false
  let attemptsUsed = 0
  let barrenAttempts = 0

  /**
   * 一次都没下动（文件还是 0 字节）连着三次：多半是网络根本连不上，
   * 不是"传到一半断了"。这时候该早点说，而不是让用户对着「下载中 0%」
   * 干等十轮重连（每轮 30 秒静默期 + 退避）。
   */
  const giveUpEarly = (): boolean => {
    barrenAttempts = fileSize(partPath) === 0 ? barrenAttempts + 1 : 0
    if (fileSize(partPath) === 0 && barrenAttempts >= 3) {
      log('[updater] 连续 3 次一个字节都没收到，停止重连')
      return true
    }
    return false
  }

  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (options.isCancelled?.()) throw new Error('下载已取消')
    attemptsUsed = attempt
    try {
      // 每轮都补一次目录：%TEMP% 有可能被清理工具在下载途中扫掉
      fs.mkdirSync(options.resumeDir, { recursive: true })
      const result = await attemptOnce({ ...options, log, partPath, attempt, progress })
      progress.flush()

      if (!result.completed) {
        lastError = new Error('连接中断')
        if (giveUpEarly()) break
        if (attempt < attempts) await delay(Math.min(1000 * 2 ** (attempt - 1), 10_000))
        continue
      }

      if (options.sha512) {
        const actual = await hashFile(partPath)
        if (actual !== options.sha512) {
          fs.rmSync(partPath, { force: true })
          const mismatch = Object.assign(
            new Error(`安装包校验失败（sha512 不一致，已下 ${formatBytes(result.transferred)}）`),
            { code: 'ERR_CHECKSUM_MISMATCH' }
          )
          // 续传有可能把两段不同内容的字节接在一起（服务端中途换过包）：
          // 这种错一次就从 0 重来，再错才认定是清单与文件对不上
          if (!checksumRetried) {
            checksumRetried = true
            lastError = mismatch
            log('[updater] sha512 不一致，丢掉半成品从 0 重下一次')
            continue
          }
          throw mismatch
        }
      }

      await moveIntoPlace(partPath, options.destination)
      log(`[updater] 下载完成：${formatBytes(result.transferred)}，共尝试 ${attempt} 次`)
      return { filePath: options.destination, bytes: result.transferred }
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error))
      if (!isRetryable(failure)) throw failure
      lastError = failure
      log(`[updater] 第 ${attempt} 次尝试失败：${describe(failure)}`)
      if (giveUpEarly()) break
      if (attempt < attempts) await delay(Math.min(1000 * 2 ** (attempt - 1), 10_000))
    }
  }

  const partial = fileSize(partPath)
  const tail =
    partial > 0
      ? `，已下的 ${formatBytes(partial)} 会保留，再点一次会接着下`
      : '（一直没收到数据，先看看网络）'
  throw new Error(
    `连续 ${attemptsUsed} 次连接中断${lastError ? `（最后一次：${describe(lastError)}）` : ''}${tail}`
  )
}
