/**
 * `latest.yml` 的重算与写回
 *
 * ── 为什么必须自己重算 ──
 *
 * `dist/latest.yml` 是 auto-update 的清单：它告诉客户端"新版本叫什么、
 * 多大、sha512 是多少"。electron-builder 生成的这份**文件名历来是错的** ——
 * 它把安装包写成连字符形式（`DeskPartner-Setup-1.0.60.exe`），
 * 而磁盘上实际是**带空格**的 `DeskPartner Setup 1.0.60.exe`。
 * 名字对不上 → 客户端下载 404 → 更新静默失败。
 *
 * 这是长期坑，每次发版都得手工 `openssl dgst -sha512 -binary | base64 -A`
 * 再 `stat -c%s` 重写一遍。所以这里把它固化成一步。
 *
 * 判据：写完之后**回读**，确认 `url` 指向的文件真的存在、且 size/sha512
 * 与磁盘一致 —— 不靠"我算过了"。
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './prebuild-abi.mjs'

export const DIST = join(ROOT, 'dist')

/** electron-builder 的默认产物名（productName + 空格 + Setup + 空格 + 版本） */
export function installerName(version) {
  return `DeskPartner Setup ${version}.exe`
}

export function findInstaller(version) {
  const exact = join(DIST, installerName(version))
  if (existsSync(exact)) return exact
  /**
   * 兜底：按版本号在 dist 里找。**刻意不做模糊匹配** ——
   * 找到别的版本会让整条发布链路发错包，宁可停下来报错。
   */
  if (!existsSync(DIST)) return null
  const hit = readdirSync(DIST).find(
    (f) => f.startsWith('DeskPartner') && f.endsWith(` ${version}.exe`)
  )
  return hit ? join(DIST, hit) : null
}

/** electron-builder 用的是「base64(sha512)」，不是 hex */
export function sha512Base64(file) {
  return createHash('sha512').update(readFileSync(file)).digest('base64')
}

/**
 * 重写 latest.yml。
 * @returns {{url:string,size:number,sha512:string,path:string}}
 */
export function rewriteLatestYml(version, { log = console.log } = {}) {
  const exe = findInstaller(version)
  if (!exe) {
    throw new Error(
      `dist/ 里找不到 ${version} 的安装包（期望 "${installerName(version)}"）。` +
        `先确认真的是这个版本打出来了：${DIST}`
    )
  }
  const name = exe.slice(DIST.length + 1)
  const size = statSync(exe).size
  const sha512 = sha512Base64(exe)
  const releaseDate = new Date().toISOString()

  const yml = [
    `version: ${version}`,
    'files:',
    `  - url: ${name}`,
    `    sha512: ${sha512}`,
    `    size: ${size}`,
    `path: ${name}`,
    `sha512: ${sha512}`,
    `releaseDate: '${releaseDate}'`,
    ''
  ].join('\n')

  const out = join(DIST, 'latest.yml')
  writeFileSync(out, yml, 'utf8')
  log(`[latest] 已重算 ${out}`)
  log(`[latest]   url=${name}`)
  log(`[latest]   size=${size}`)
  log(`[latest]   sha512=${sha512.slice(0, 24)}…`)
  return { url: name, size, sha512, path: out }
}

/**
 * 回读核对：`latest.yml` 里声称的文件存在、且 size/sha512 与磁盘一致。
 * 这是唯一能证明"更新真的能下到包"的检查。
 */
export function verifyLatestYml({ log = console.log } = {}) {
  const latest = join(DIST, 'latest.yml')
  if (!existsSync(latest)) return { ok: false, problems: ['dist/latest.yml 不存在'] }

  const text = readFileSync(latest, 'utf8')
  const pick = (re) => (text.match(re) || [])[1]
  const url = pick(/^\s*-?\s*url:\s*(.+)$/m)?.trim()
  const size = Number(pick(/^\s*size:\s*(\d+)$/m))
  const sha512 = pick(/^\s*sha512:\s*(.+)$/m)?.trim()
  const version = pick(/^version:\s*(.+)$/m)?.trim()

  const problems = []
  if (!url) problems.push('latest.yml 缺 url')
  if (!size) problems.push('latest.yml 缺 size')
  if (!sha512) problems.push('latest.yml 缺 sha512')

  const file = url ? join(DIST, url) : null
  if (file && !existsSync(file)) {
    problems.push(`latest.yml 指向的文件不存在: ${url}（文件名写错就会这样）`)
  } else if (file) {
    const realSize = statSync(file).size
    if (realSize !== size) problems.push(`size 不符: 声明 ${size} / 实际 ${realSize}`)
    const realSha = sha512Base64(file)
    if (realSha !== sha512) problems.push('sha512 不符（清单与磁盘不是同一个文件）')
  }

  const ok = problems.length === 0
  log(`[latest] 回读核对: ${ok ? 'PASS' : 'FAIL'}${ok ? '' : '  ' + problems.join('; ')}`)
  return { ok, problems, version, url, size, sha512 }
}
