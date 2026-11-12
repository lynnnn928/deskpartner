/**
 * 断点续传下载（卡 `0ec0703b`）
 *
 * 判据是「链接断在第 N 字节之后再点一次会**接着下**」：
 * 这里用一个本地 HTTP 服务模拟真实故障——第一次响应发一半就掐断连接，
 * 第二次必须看到 `Range: bytes=<已下>-`，并且最终拿到的字节与源逐字节相同。
 *
 * 用本地服务而不是桩函数：`Range` / `206` / `Content-Range` / 半途断流这几样
 * 才是这件事的全部难点，桩掉它们等于没测。
 */
import { describe, it, expect } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import {
  downloadWithResume,
  partialFilePathFor,
  pruneStalePartials,
  formatBytes,
  type CreateDownloadRequest
} from '../../../src/main/services/resumable-download'

const sha512Of = (buffer: Buffer): string => crypto.createHash('sha512').update(buffer).digest('base64')

/** 测试里的请求器：真发 HTTP（下载执行器在生产里注入的是 Electron net / node http） */
const nodeRequest: CreateDownloadRequest = (options, callback) =>
  http.request(options as http.RequestOptions, callback as never) as never

/** 关服务：先把挂着的连接掐掉，否则 close() 的回调永远不回来 */
async function stopServer(server: http.Server): Promise<void> {
  server.closeAllConnections?.()
  await new Promise<void>((resolve) => {
    server.close(() => resolve())
  })
}

/**
 * 一个会按剧情出故障的更新源：
 * - `cutFirstAt`：**第一次**响应发到 N 字节就掐断连接（后续请求正常服务，认 Range）
 * - `hangAt`：先发 N 字节，然后**一直不结束也不发数据**（模拟静默断流）
 * - `ignoreRange`：不认 Range，一律回 200 全量（老式静态托管就这样）
 */
function serve(
  payload: Buffer,
  options: { cutFirstAt?: number; ignoreRange?: boolean; hangAt?: number } = {}
) {
  const ranges: Array<string | undefined> = []
  let seen = 0
  const listener: http.RequestListener = (req, res) => {
    seen++
    const range = req.headers.range
    ranges.push(range)
    const start = range && !options.ignoreRange ? Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0) : 0

    if (options.hangAt != null) {
      res.writeHead(start > 0 ? 206 : 200, {
        'Content-Length': String(payload.length - start),
        ...(start > 0 ? { 'Content-Range': `bytes ${start}-${payload.length - 1}/${payload.length}` } : {})
      })
      if (seen === 1) res.write(payload.subarray(0, options.hangAt))
      return // 不结束：连接还挂着，但不再有数据
    }

    if (options.cutFirstAt != null && seen === 1) {
      res.writeHead(200, { 'Content-Length': String(payload.length) })
      res.write(payload.subarray(0, options.cutFirstAt))
      setTimeout(() => res.destroy(), 20)
      return
    }

    if (start > 0) {
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${payload.length - 1}/${payload.length}`,
        'Content-Length': String(payload.length - start)
      })
      res.end(payload.subarray(start))
      return
    }

    res.writeHead(200, { 'Content-Length': String(payload.length) })
    res.end(payload)
  }
  return { listener, ranges }
}

describe('断点续传下载（0ec0703b）', () => {
  it('1. 一次成功：字节与源一致，sha512 校验通过，临时文件就位', async () => {
    const payload = crypto.randomBytes(96 * 1024)
    const { listener } = serve(payload)
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-resume-'))
    const resumeDir = path.join(tmpDir, 'partials')
    const destination = path.join(tmpDir, 'pending', 'installer.exe')
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    const server = http.createServer(listener)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address() as { port: number }

    try {
      const result = await downloadWithResume({
        url: new URL(`http://127.0.0.1:${address.port}/installer.exe`),
        destination,
        resumeDir,
        sha512: sha512Of(payload),
        createRequest: nodeRequest,
        stallMs: 1000,
        maxAttempts: 3
      })
      expect(result.filePath).toBe(destination)
      expect(result.bytes).toBe(payload.length)
      expect(fs.readFileSync(destination).equals(payload)).toBe(true)
      // 半成品用完即走，不留垃圾
      expect(fs.readdirSync(resumeDir).filter((n) => n.endsWith('.part'))).toHaveLength(0)
    } finally {
      await stopServer(server)
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('2. 下到一半断线：第二次带 Range 从断点接着下，最终字节正确', async () => {
    const payload = crypto.randomBytes(128 * 1024)
    const cutAfter = 64 * 1024
    const { listener, ranges } = serve(payload, { cutFirstAt: cutAfter })
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-resume-'))
    const resumeDir = path.join(tmpDir, 'partials')
    const destination = path.join(tmpDir, 'pending', 'installer.exe')
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    const server = http.createServer(listener)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address() as { port: number }

    try {
      const result = await downloadWithResume({
        url: new URL(`http://127.0.0.1:${address.port}/installer.exe`),
        destination,
        resumeDir,
        sha512: sha512Of(payload),
        createRequest: nodeRequest,
        stallMs: 2000,
        maxAttempts: 4
      })
      expect(result.bytes).toBe(payload.length)
      expect(fs.readFileSync(destination).equals(payload)).toBe(true)
      expect(ranges.length).toBeGreaterThanOrEqual(2)
      expect(ranges[0]).toBeUndefined()
      // 关键判据：第二次请求从那断点起，而不是从 0
      expect(ranges[1]).toMatch(/^bytes=\d+-$/)
      const resumedAt = Number(/^bytes=(\d+)-$/.exec(ranges[1] as string)?.[1])
      expect(resumedAt).toBeGreaterThanOrEqual(cutAfter)
      expect(resumedAt).toBeLessThan(payload.length)
    } finally {
      await stopServer(server)
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('3. 断流卡住：重连次数用尽后报错，但半成品留着——下次调用从那里接着下', async () => {
    const payload = crypto.randomBytes(96 * 1024)
    const hangAfter = 40 * 1024
    const hanging = serve(payload, { hangAt: hangAfter })
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-resume-'))
    const resumeDir = path.join(tmpDir, 'partials')
    const destination = path.join(tmpDir, 'pending', 'installer.exe')
    fs.mkdirSync(path.dirname(destination), { recursive: true })

    const hangServer = http.createServer(hanging.listener)
    await new Promise<void>((resolve) => hangServer.listen(0, '127.0.0.1', () => resolve()))
    const hangPort = (hangServer.address() as { port: number }).port
    const url = new URL(`http://127.0.0.1:${hangPort}/installer.exe`)

    try {
      await expect(
        downloadWithResume({
          url,
          destination,
          resumeDir,
          sha512: sha512Of(payload),
          createRequest: nodeRequest,
          stallMs: 200,
          maxAttempts: 2
        })
      ).rejects.toThrow(/连续 2 次连接中断/)
      expect(hanging.ranges.length).toBe(2)

      const partPath = partialFilePathFor(resumeDir, url, sha512Of(payload))
      expect(fs.existsSync(partPath)).toBe(true)
      expect(fs.statSync(partPath).size).toBe(hangAfter)

      // 换一个正常服务（同端口）：再点一次应当从 40KB 处接着下
      await stopServer(hangServer)
      const healthy = serve(payload)
      const goodServer = http.createServer(healthy.listener)
      await new Promise<void>((resolve) =>
        goodServer.listen(hangPort, '127.0.0.1', () => resolve())
      )
      try {
        const result = await downloadWithResume({
          url,
          destination,
          resumeDir,
          sha512: sha512Of(payload),
          createRequest: nodeRequest,
          stallMs: 1000,
          maxAttempts: 3
        })
        expect(result.bytes).toBe(payload.length)
        expect(fs.readFileSync(destination).equals(payload)).toBe(true)
        expect(healthy.ranges[0]).toBe(`bytes=${hangAfter}-`)
      } finally {
        await stopServer(goodServer)
      }
    } finally {
      await stopServer(hangServer)
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('4. 服务器不吃 Range（回 200 全量）：截断重写，不会把两段接错', async () => {
    const payload = crypto.randomBytes(96 * 1024)
    const { listener, ranges } = serve(payload, { cutFirstAt: 32 * 1024, ignoreRange: true })
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-resume-'))
    const resumeDir = path.join(tmpDir, 'partials')
    const destination = path.join(tmpDir, 'pending', 'installer.exe')
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    const server = http.createServer(listener)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address() as { port: number }

    try {
      const result = await downloadWithResume({
        url: new URL(`http://127.0.0.1:${address.port}/installer.exe`),
        destination,
        resumeDir,
        sha512: sha512Of(payload),
        createRequest: nodeRequest,
        stallMs: 2000,
        maxAttempts: 4
      })
      expect(result.bytes).toBe(payload.length)
      const written = fs.readFileSync(destination)
      expect(written.length).toBe(payload.length)
      expect(written.equals(payload)).toBe(true)
      expect(ranges.length).toBeGreaterThanOrEqual(2)
    } finally {
      await stopServer(server)
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('5. sha512 对不上：先从 0 重来一次，仍对不上才报 ERR_CHECKSUM_MISMATCH', async () => {
    const payload = crypto.randomBytes(64 * 1024)
    const { listener, ranges } = serve(payload)
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-resume-'))
    const resumeDir = path.join(tmpDir, 'partials')
    const destination = path.join(tmpDir, 'pending', 'installer.exe')
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    const server = http.createServer(listener)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address() as { port: number }

    try {
      const error = await downloadWithResume({
        url: new URL(`http://127.0.0.1:${address.port}/installer.exe`),
        destination,
        resumeDir,
        sha512: sha512Of(Buffer.from('另一份安装包')),
        createRequest: nodeRequest,
        stallMs: 2000,
        maxAttempts: 4
      }).catch((e: unknown) => e as Error & { code?: string })

      expect((error as Error).message).toMatch(/sha512/)
      expect((error as { code?: string }).code).toBe('ERR_CHECKSUM_MISMATCH')
      expect(ranges.length).toBe(2)
      expect(fs.existsSync(destination)).toBe(false)
    } finally {
      await stopServer(server)
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('6. 进度回调：percent 跟着字节往上走，最后到 100', async () => {
    const payload = crypto.randomBytes(256 * 1024)
    const { listener } = serve(payload)
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-resume-'))
    const resumeDir = path.join(tmpDir, 'partials')
    const destination = path.join(tmpDir, 'pending', 'installer.exe')
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    const server = http.createServer(listener)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address() as { port: number }
    const percents: number[] = []

    try {
      await downloadWithResume({
        url: new URL(`http://127.0.0.1:${address.port}/installer.exe`),
        destination,
        resumeDir,
        sha512: sha512Of(payload),
        createRequest: nodeRequest,
        stallMs: 2000,
        maxAttempts: 2,
        onProgress: (progress) => percents.push(progress.percent)
      })
      expect(percents.length).toBeGreaterThan(0)
      expect(Math.max(...percents)).toBe(100)
      expect(percents[percents.length - 1]).toBe(100)
    } finally {
      await stopServer(server)
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('7. 半成品目录：过期清掉，正在用的那个留着；文件名带 sha512 前缀避免串味', () => {
    const resumeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-resume-'))
    const url = new URL('https://example.com/DeskPartner.Setup.1.0.145.exe')
    const keep = partialFilePathFor(resumeDir, url, 'AAAABBBBCCCCDDDDxxxx')
    const stale = path.join(resumeDir, 'DeskPartner.Setup.1.0.144.exe.OLD.part')
    const fresh = path.join(resumeDir, 'DeskPartner.Setup.1.0.146.exe.OTHER.part')
    fs.writeFileSync(keep, 'x')
    fs.writeFileSync(stale, 'x')
    fs.writeFileSync(fresh, 'x')
    const old = Date.now() - 8 * 24 * 60 * 60 * 1000
    fs.utimesSync(stale, old / 1000, old / 1000)

    pruneStalePartials(resumeDir, keep)

    expect(fs.existsSync(keep)).toBe(true)
    expect(fs.existsSync(fresh)).toBe(true)
    expect(fs.existsSync(stale)).toBe(false)
    expect(path.basename(keep)).toBe('DeskPartner.Setup.1.0.145.exe.AAAABBBBCCCCDDDD.part')
    fs.rmSync(resumeDir, { recursive: true, force: true })
  })

  it('8. 格式化字节数：报错里说人话', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2 KB')
    expect(formatBytes(59_126_049)).toBe('56.4 MB')
  })

  it('9. 另一个实例正拿着半成品：改用自己的一份，不与它互写（同一台机器两个实例）', async () => {
    const payload = crypto.randomBytes(64 * 1024)
    const { listener, ranges } = serve(payload)
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-resume-'))
    const resumeDir = path.join(tmpDir, 'partials')
    const destination = path.join(tmpDir, 'pending', 'installer.exe')
    fs.mkdirSync(path.dirname(resumeDir), { recursive: true })
    fs.mkdirSync(resumeDir, { recursive: true })
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    const server = http.createServer(listener)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address() as { port: number }
    const url = new URL(`http://127.0.0.1:${address.port}/installer.exe`)
    const shared = partialFilePathFor(resumeDir, url, sha512Of(payload))
    // 让"另一个实例"占住半成品：锁里写着**还活着**的 pid（这里就是本进程）
    fs.writeFileSync(shared, Buffer.alloc(4096, 1))
    fs.writeFileSync(`${shared}.lock`, String(process.pid))

    try {
      const result = await downloadWithResume({
        url,
        destination,
        resumeDir,
        sha512: sha512Of(payload),
        createRequest: nodeRequest,
        stallMs: 2000,
        maxAttempts: 2
      })
      expect(fs.readFileSync(destination).equals(payload)).toBe(true)
      expect(result.bytes).toBe(payload.length)
      // 别人的半成品一个字节没动
      expect(fs.statSync(shared).size).toBe(4096)
      // 自己那份用完即走，不留垃圾
      expect(fs.readdirSync(resumeDir).filter((n) => n.includes(String(process.pid)))).toHaveLength(0)
      // 私有半成品从 0 开始，所以第一次请求不带 Range
      expect(ranges[0]).toBeUndefined()
    } finally {
      await stopServer(server)
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('10. 遗留锁（持有者早没了）：接管它并照常续传，用完释放', async () => {
    const payload = crypto.randomBytes(64 * 1024)
    const already = 32 * 1024
    const { listener, ranges } = serve(payload)
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-resume-'))
    const resumeDir = path.join(tmpDir, 'partials')
    const destination = path.join(tmpDir, 'pending', 'installer.exe')
    fs.mkdirSync(resumeDir, { recursive: true })
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    const server = http.createServer(listener)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address() as { port: number }
    const url = new URL(`http://127.0.0.1:${address.port}/installer.exe`)
    const shared = partialFilePathFor(resumeDir, url, sha512Of(payload))
    fs.writeFileSync(shared, payload.subarray(0, already))
    // 崩掉的进程留下的锁：pid 解析不出来 → 当成遗留
    fs.writeFileSync(`${shared}.lock`, 'not-a-pid')

    try {
      const result = await downloadWithResume({
        url,
        destination,
        resumeDir,
        sha512: sha512Of(payload),
        createRequest: nodeRequest,
        stallMs: 2000,
        maxAttempts: 2
      })
      expect(result.bytes).toBe(payload.length)
      expect(ranges[0]).toBe(`bytes=${already}-`)
      expect(fs.existsSync(`${shared}.lock`)).toBe(false)
    } finally {
      await stopServer(server)
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('11. 半成品已经是完整文件（服务器回 416）：不重下，直接校验通过', async () => {
    const payload = crypto.randomBytes(48 * 1024)
    const server = http.createServer((req, res) => {
      if (req.headers.range) {
        res.writeHead(416, { 'Content-Range': `bytes */${payload.length}` })
        res.end()
        return
      }
      res.writeHead(200, { 'Content-Length': String(payload.length) })
      res.end(payload)
    })
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-resume-'))
    const resumeDir = path.join(tmpDir, 'partials')
    const destination = path.join(tmpDir, 'pending', 'installer.exe')
    fs.mkdirSync(resumeDir, { recursive: true })
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address() as { port: number }
    const url = new URL(`http://127.0.0.1:${address.port}/installer.exe`)
    // 上次下完但没来得及搬走（断电/被杀）：内容已完整
    fs.writeFileSync(partialFilePathFor(resumeDir, url, sha512Of(payload)), payload)

    try {
      const result = await downloadWithResume({
        url,
        destination,
        resumeDir,
        sha512: sha512Of(payload),
        createRequest: nodeRequest,
        stallMs: 2000,
        maxAttempts: 2
      })
      expect(result.bytes).toBe(payload.length)
      expect(fs.readFileSync(destination).equals(payload)).toBe(true)
    } finally {
      await stopServer(server)
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('12. 地址里有畸形转义（%zz）：半成品文件名不会因此抛错', () => {
    const resumeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-resume-'))
    const partPath = partialFilePathFor(resumeDir, new URL('https://example.com/Desk%zzSetup.exe'), 'abcd')
    expect(partPath.endsWith('.part')).toBe(true)
    expect(path.basename(partPath)).toContain('Desk%zzSetup.exe')
    fs.rmSync(resumeDir, { recursive: true, force: true })
  })

  it('13. 网络根本连不上（一个字节都没下来）：三次就收手，不干等满十轮', async () => {
    const payload = crypto.randomBytes(32 * 1024)
    // 每次请求立刻掐断：模拟"连不上/秒断"，一个字节都收不到
    let hits = 0
    const server = http.createServer((_req, res) => {
      hits++
      res.destroy()
    })
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-resume-'))
    const resumeDir = path.join(tmpDir, 'partials')
    const destination = path.join(tmpDir, 'pending', 'installer.exe')
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address() as { port: number }

    try {
      const error = await downloadWithResume({
        url: new URL(`http://127.0.0.1:${address.port}/installer.exe`),
        destination,
        resumeDir,
        sha512: sha512Of(payload),
        createRequest: nodeRequest,
        stallMs: 500,
        maxAttempts: 10
      }).catch((e: unknown) => e as Error)

      expect((error as Error).message).toMatch(/连续 3 次连接中断/)
      expect((error as Error).message).toMatch(/一直没收到数据/)
      expect(hits).toBe(3)
    } finally {
      await stopServer(server)
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  }, 15_000)
})
