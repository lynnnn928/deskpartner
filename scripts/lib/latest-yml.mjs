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
 * ── 1.0.137（卡 `99870984`）：空格这个坑还剩最后一截 ──
 *
 * 清单写对了名字还不够，**链路上有两处方向相反的重命名**：
 *   - `gh release create` 上传时，GitHub 把文件名里的空格换成**点号**
 *     （`DeskPartner Setup 1.0.136.exe` → Releases 资产 `DeskPartner.Setup.1.0.136.exe`）；
 *   - electron-updater 的 `GitHubProvider.resolveFiles` 把清单 url 里的空格换成**连字符**
 *     （`p => p.replace(/ /g, "-")`）—— 于是客户端请求 `DeskPartner-Setup-1.0.136.exe`
 *     （见 node_modules/electron-updater/out/providers/GitHubProvider.js:181）。
 * 两个名字在 Releases 上都不存在 → 点击下载 404，而界面把错误写死成"检查失败"。
 *
 * 修法：清单里写的名字**一个空格都不带**（连字符那次替换因此在它身上是恒等变换），
 * 并且就是 GitHub 归一化后的资产名（点号那份）。两个方向同时是恒等 → 地址必然对得上。
 *
 * 判据：写完之后**回读**，确认 `url` 指向的文件真的存在、不含空格、且 size/sha512
 * 与磁盘一致 —— 不靠"我算过了"。
 */
import { copyFileSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, join } from 'node:path'
import { ROOT } from './prebuild-abi.mjs'

export const DIST = join(ROOT, 'dist')

/** electron-builder 的默认产物名（productName + 空格 + Setup + 空格 + 版本） */
export function installerName(version) {
  return `DeskPartner Setup ${version}.exe`
}

/**
 * 这个安装包传到 GitHub Releases 之后**实际**叫什么。
 *
 * GitHub 存资产时会把空格换掉（`DeskPartner Setup 1.0.136.exe` →
 * `DeskPartner.Setup.1.0.136.exe`），所以清单要写这个形态 ——
 * 它同时满足"不含空格"（electron-updater 的连字符替换是恒等）与
 * "等于资产名"（客户端请求的地址就是它）。
 */
export function releasesAssetName(version) {
  return installerName(version).replace(/ /g, '.')
}

export function findInstaller(version, distDir = DIST) {
  const exact = join(distDir, installerName(version))
  if (existsSync(exact)) return exact
  /**
   * 上一次发版留下的那份"资产名副本"也是同一个包，认它：
   * 照着上面的提示手工改过名、或重跑 `--overwrite` 时，不该因为
   * "带空格的那份不在了"就报"找不到安装包"。
   */
  const asset = join(distDir, releasesAssetName(version))
  if (existsSync(asset)) return asset
  /**
   * 兜底：按版本号在 dist 里找。**刻意不做模糊匹配** ——
   * 找到别的版本会让整条发布链路发错包，宁可停下来报错。
   */
  if (!existsSync(distDir)) return null
  const hit = readdirSync(distDir).find(
    (f) => f.startsWith('DeskPartner') && f.endsWith(` ${version}.exe`)
  )
  return hit ? join(distDir, hit) : null
}

/** electron-builder 用的是「base64(sha512)」，不是 hex */
export function sha512Base64(file) {
  return createHash('sha512').update(readFileSync(file)).digest('base64')
}

/**
 * 重写 latest.yml。
 * @returns {{url:string,size:number,sha512:string,path:string}}
 */
export function rewriteLatestYml(version, { log = console.log, distDir = DIST } = {}) {
  const exe = findInstaller(version, distDir)
  if (!exe) {
    throw new Error(
      `dist/ 里找不到 ${version} 的安装包（期望 "${installerName(version)}"）。` +
        `先确认真的是这个版本打出来了：${DIST}`
    )
  }
  /**
   * 清单写的是"Releases 上的资产名"，所以磁盘上也得真有这么一份：
   * 不改名、不删原产物（verify-package 与发版提示都还按空格名找它），
   * 只**多复制一份**，让 ①清单自洽回读有文件可核 ②上传时随手就能传对名字。
   */
  const name = releasesAssetName(version)
  const assetPath = join(distDir, name)
  if (assetPath !== exe) copyFileSync(exe, assetPath)
  const size = statSync(assetPath).size
  const sha512 = sha512Base64(assetPath)
  const releaseDate = new Date().toISOString()
  log(`[latest] 已按 Releases 资产名另存一份: ${name}`)
  log(`[latest]   上传到 Releases 的就是它（GitHub 会把空格换成点号，这份不带空格，两边同名）`)
  log(`[latest]   原有的 "${basename(exe)}" 保留不动；两者内容完全相同，只需上传一份`)

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

  const out = join(distDir, 'latest.yml')
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
export function verifyLatestYml({ log = console.log, distDir = DIST } = {}) {
  const latest = join(distDir, 'latest.yml')
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
  /**
   * 带空格的 url 必然 404（1.0.137，卡 `99870984`）—— 客户端那边
   * `GitHubProvider.resolveFiles` 会把空格换成连字符，Releases 上却是点号。
   * 所以这一条不是"格式洁癖"，是"点击下载能不能成"。
   */
  if (url && /\s/.test(url)) {
    problems.push(
      `latest.yml 的 url 含空格（${url}）：客户端会把它换成连字符，Releases 上是点号 —— 必然 404`
    )
  }

  const file = url ? join(distDir, url) : null
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
