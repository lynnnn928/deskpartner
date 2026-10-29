/**
 * 发版验收：证明**打出来的这个包**真的能用
 *
 * ── 它检查什么 ──
 *
 * 三条，每条都对应一个"已经吃过亏、且不报错"的失败：
 *
 * 1. **包里的原生模块是 Electron ABI(130)** —— 最贵的一条。
 *    `-c.npmRebuild=false` 只是"不重编译"，它照抄 `node_modules` 现状；
 *    若打包时 `node_modules` 停在 Node ABI(127)（跑过 `npm test` 就会），
 *    装出来的应用**完全静默地崩溃**：没有报错、没有日志。
 *    判据只能比对字节（产物里的 `.node` sha256 是否等于 electron-v130 那份）。
 *
 * 2. **exe 版本元数据 == package.json** —— 因为**退出码会骗人**：
 *    safe-delete 闸门拦删中间产物时，electron-builder 退出码是 1，
 *    但安装包其实已经完整生成。反过来也可能"退出码 0 而产物是旧的"。
 *
 * 3. **latest.yml 自洽** —— 它的文件名历来被写错（连字符 vs 磁盘上的空格），
 *    客户端下载 404 → 更新静默失败。size/sha512 必须与磁盘一致。
 *
 * 另外读 asar 搜本轮修复涉及的关键字符串，确认改动进了包。
 *
 * 用法：node scripts/verify-package.mjs [关键字符串...]
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, abiOfFile } from './lib/prebuild-abi.mjs'
import { checkExeVersion, artifactPaths, packageVersion } from './lib/exe-version.mjs'
import { verifyLatestYml } from './lib/latest-yml.mjs'

const DIST = join(ROOT, 'dist')
const UNPACKED = join(DIST, 'win-unpacked')
const ASAR = join(UNPACKED, 'resources', 'app.asar')
const PKG_MODULE = join(
  UNPACKED,
  'resources',
  'app.asar.unpacked',
  'node_modules',
  'better-sqlite3',
  'build',
  'Release',
  'better_sqlite3.node'
)
const MCP = join(UNPACKED, 'resources', 'cli', 'mcp.cjs')
/**
 * 启动器（1.0.67 补）
 *
 * ⚠️ 此前只扫三处（main / renderer / mcp），**独缺 launcher** ——
 * 而降级自检（`cfbf8a7a`）、管道连接、预检全在 launcher 里。
 * 于是"只在 launcher 改了代码"的版本，用关键字符串验会**假通过**。
 * 与 2026-09-30 那次（漏扫 renderer）是同一个形状：**每加一个 bundle 就要补一处**。
 */
const LAUNCHER = join(UNPACKED, 'resources', 'cli', 'deskpartner.cjs')

const version = packageVersion()
let fail = 0
const ok = (cond, label, extra = '') => {
  if (!cond) fail++
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`)
}

console.log(`\n【1】包内原生模块 ABI（必须 electron v130）`)
if (!existsSync(PKG_MODULE)) {
  ok(false, `找不到包内原生模块`, PKG_MODULE)
} else {
  const r = abiOfFile(PKG_MODULE)
  if (r.abi === 'electron') {
    ok(true, '包内 better_sqlite3.node 是 Electron ABI')
  } else if (r.abi === 'node') {
    ok(
      false,
      '包内原生模块是 **Node ABI(127)** —— 装上会静默崩溃',
      '打包前先 node scripts/swap-abi.mjs electron'
    )
  } else {
    ok(false, `包内原生模块 ABI 无法判定（${r.reason}）`, '可能是手工编译或缓存缺失，需人工确认')
  }
}

console.log(`\n【2】产物版本元数据（判据是 exe，不是退出码）`)
const paths = artifactPaths(version)
console.log(`  期望版本: ${version}（来自 package.json）`)
for (const [label, p] of [
  ['win-unpacked 程序本体', paths.unpackedExe],
  ['安装包', paths.installer]
]) {
  const r = checkExeVersion(p, { label, log: () => {} })
  ok(r.ok, `${label} 版本 = ${version}`, r.got ? `实际 ${r.got}` : '读不到')
}

console.log(`\n【3】latest.yml 自洽（url / size / sha512 对得上磁盘）`)
const latest = verifyLatestYml({ log: () => {} })
ok(latest.ok, 'latest.yml 与磁盘一致', latest.ok ? '' : latest.problems.join('; '))
if (latest.version) ok(latest.version === version, `latest.yml 版本 = ${version}`, `实际 ${latest.version}`)

console.log(`\n【4】包内关键字符串（改动真的进包了吗）`)
const keys = process.argv.slice(2)
if (!keys.length) {
  console.log('  （未指定关键字符串，跳过）')
} else {
  if (!existsSync(ASAR)) {
    ok(false, '找不到 app.asar')
  } else {
    let src = ''
    try {
      const asar = (await import('@electron/asar')).default
      const norm = asar
        .listPackage(ASAR)
        .filter((e) => /out[\\/]main[\\/]index\.js$/.test(e))[0]
        ?.replace(/^[\\/]+/, '')
      src = norm ? asar.extractFile(ASAR, norm).toString('utf8') : ''
    } catch (e) {
      ok(false, `读 app.asar 失败`, e.message)
    }
    // MCP 是独立 bundle，在 asar 外
    const mcpSrc = existsSync(MCP) ? readFileSync(MCP, 'utf8') : ''
    const launcherSrc = existsSync(LAUNCHER) ? readFileSync(LAUNCHER, 'utf8') : ''
    /**
     * 🚨 界面代码也要扫（2026-09-30 补，1.0.64 发现盲区）。
     *
     * 原来只扫 `out/main/index.js`。但界面改动（组件、文案）打进的是
     * `out/renderer/assets/*.js` —— 于是"只改了界面"的版本，用关键字符串
     * 验会**假通过**：主进程里当然找不到那些中文字符串，而校验却说 bom。
     * 判据必须是三处都查：主进程 / 界面 / MCP。
     */
    let rendererSrc = ''
    try {
      const asar = (await import('@electron/asar')).default
      const entries = asar
        .listPackage(ASAR)
        .filter((e) => /out[\\/]renderer[\\/]assets[\\/].+\.js$/.test(e))
      rendererSrc = entries
        .map((e) => {
          const n = e.replace(/^[\\/]+/, '')
          try {
            return asar.extractFile(ASAR, n).toString('utf8')
          } catch {
            return ''
          }
        })
        .join('\n')
    } catch (e) {
      ok(false, `读界面 bundle 失败`, e.message)
    }
    for (const k of keys) {
      const inAsar = src.includes(k)
      const inMcp = mcpSrc.includes(k)
      const inRenderer = rendererSrc.includes(k)
      const inLauncher = launcherSrc.includes(k)
      const where = [
        inAsar ? 'main' : '',
        inRenderer ? 'renderer' : '',
        inMcp ? 'mcp' : '',
        inLauncher ? 'launcher' : ''
      ].filter(Boolean).join('+')
      ok(
        inAsar || inMcp || inRenderer || inLauncher,
        `含 ${k}`,
        where ? `(${where})` : ''
      )
    }
    /**
     * ⚠️ **特征串要挑 ASCII 的**（1.0.67 实测踩到）：
     * 产物里的中文被转义成 `\uXXXX`，直接搜中文**必然搜不到** ——
     * 我据此一度误判"降级自检没进包"，实际它在 `resources/cli/deskpartner.cjs` 里。
     * 判据：**验证包里有没有，用标识符（函数名/常量名）而不用人话。**
     */
    if (!launcherSrc) {
      console.log('  [!] 找不到 resources/cli/deskpartner.cjs（launcher 未打进包，特征串验不到它）')
    }
  }
}

console.log(`\n${fail === 0 ? '发版验收全部通过' : `${fail} 项未通过`}`)
process.exit(fail ? 1 : 0)
