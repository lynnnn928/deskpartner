/**
 * 预编译原生模块（better-sqlite3）的取出与 ABI 核对
 *
 * ── 为什么单独抽出来 ──
 *
 * 这件事现在有**两个消费方**，而它们的判据必须是同一份：
 * - `swap-abi.mjs`：把 node_modules 里的 `.node` 换成目标 ABI（改）
 * - `verify-abi.mjs` / `release.mjs`：核对**当前**是哪个 ABI（读）
 *
 * 打包这条路上最贵的一个坑正是 ABI 错位：
 * `-c.npmRebuild=false` 只是"不重编译"，它**照抄 node_modules 现状** ——
 * 所以打包前 node_modules 必须已经在 Electron ABI(130)，
 * 否则打出来的包里装的是 Node ABI(127) 的原生模块，
 * 安装后表现为**完全静默的进程崩溃**（没有任何报错，最贵的那种）。
 *
 * 判据不能靠"我记得跑过 swap"，只能靠**比对字节**：当前 `.node` 的 sha256
 * 是否等于 npm 缓存里 electron-v130 那份解出来的 sha256。
 *
 * ⚠️ 这里只依赖 `node:` 内置模块，不做任何写操作（写只在 swap-abi 里）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

export const ROOT = path.resolve(HERE, '..', '..')

/** node 22.x = 127；Electron 33 = 130 */
export const ABI = { node: 127, electron: 130 }

/** node_modules 里那个会被换掉的文件 */
export const TARGET_MODULE = path.join(
  ROOT,
  'node_modules/better-sqlite3/build/Release/better_sqlite3.node'
)

export const PREBUILD_CACHE = path.join(os.homedir(), 'AppData/Local/npm-cache/_prebuilds')

function getPrebuildCacheDirs() {
  if (process.env.DESKPARTNER_PREBUILD_CACHE) {
    return [process.env.DESKPARTNER_PREBUILD_CACHE]
  }
  const home = os.homedir()
  const candidates = [
    process.env.npm_config_cache ? path.join(process.env.npm_config_cache, '_prebuilds') : '',
    PREBUILD_CACHE,
    path.join(home, 'AppData/Roaming/npm-cache/_prebuilds'),
    path.join(home, '.npm/_prebuilds')
  ].filter(Boolean)
  return [...new Set(candidates)]
}

function installedSqliteVersion() {
  try {
    const pkgPath = path.join(ROOT, 'node_modules/better-sqlite3/package.json')
    if (fs.existsSync(pkgPath)) {
      return JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version || ''
    }
  } catch {
    /* ignore */
  }
  return ''
}

/** 在 npm 缓存里找某个运行时/ABI 的预编译包 */
export function findPrebuild(want) {
  const abi = ABI[want]
  if (!abi) throw new Error(`未知目标: ${want}（应为 node | electron）`)
  const ver = installedSqliteVersion()
  const dirs = getPrebuildCacheDirs()

  // 优先匹配当前安装的 better-sqlite3 版本号
  if (ver) {
    for (const dir of dirs) {
      if (!fs.existsSync(dir)) continue
      const exact = fs
        .readdirSync(dir)
        .find(
          (f) =>
            f.includes(`better-sqlite3-v${ver}-${want}-v${abi}-`) && f.endsWith('.tar.gz')
        )
      if (exact) return path.join(dir, exact)
    }
  }

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue
    const hit = fs
      .readdirSync(dir)
      .find(
        (f) =>
          f.includes('better-sqlite3') && f.includes(`-${want}-v${abi}-`) && f.endsWith('.tar.gz')
      )
    if (hit) return path.join(dir, hit)
  }
  return null
}

/**
 * 从 .tar.gz 里取出 `better_sqlite3.node` 的字节
 *
 * 刻意不用系统 tar：Windows 上 `C:\...` 会被当成 `host:path` 去连远程主机
 * （实测报 "Cannot connect to C: resolve failed"），加 `--force-local` 又
 * 不是所有平台都支持。这里的包只有一个成员，手写解析反而更可靠。
 */
export function extractSingleFile(tarball) {
  const raw = zlib.gunzipSync(fs.readFileSync(tarball))

  let offset = 0
  while (offset + 512 <= raw.length) {
    const header = raw.subarray(offset, offset + 512)
    // 全零块 = 归档结束
    if (header.every((b) => b === 0)) break

    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
    const sizeField = header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim()
    const size = parseInt(sizeField, 8) || 0
    const typeFlag = String.fromCharCode(header[156])
    const body = raw.subarray(offset + 512, offset + 512 + size)

    if (typeFlag === '0' || typeFlag === '\0' || typeFlag === '') {
      if (name.endsWith('better_sqlite3.node')) return body
    }

    // 512 对齐
    offset += 512 + Math.ceil(size / 512) * 512
  }
  return null
}

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

/**
 * 核对**任意一个** `better_sqlite3.node` 文件是哪个 ABI。
 *
 * 为什么不只服务 node_modules —— 打包产物里那份才是真正会被 Electron 加载的：
 * `dist/win-unpacked/resources/app.asar.unpacked/node_modules/better-sqlite3/...`
 * 它错了就是"装上后静默崩溃"。所以要能直接指着它问"你是哪个 ABI"。
 *
 * 返回 `{ abi: 'node'|'electron'|null, actual, reason }` ——
 * `abi === null` 表示两份预编译都对不上（缓存被清过，或手工编译过），
 * 那时不能断言"是 Electron 版"，应当停下来问人。
 */
export function abiOfFile(file) {
  if (!file || !fs.existsSync(file)) {
    return { abi: null, actual: null, reason: 'missing' }
  }
  const actual = sha256(fs.readFileSync(file))

  for (const want of ['electron', 'node']) {
    let prebuild
    try {
      prebuild = findPrebuild(want)
    } catch {
      continue
    }
    if (!prebuild) continue
    const member = extractSingleFile(prebuild)
    if (member && sha256(member) === actual) {
      return { abi: want, actual, reason: 'matched' }
    }
  }
  return { abi: null, actual, reason: 'unknown' }
}

/** 核对 node_modules 当前装的是哪个 ABI（`abiOfFile` 的便捷包装） */
export function currentAbi() {
  return abiOfFile(TARGET_MODULE)
}
