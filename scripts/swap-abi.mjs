/**
 * 按 ABI 切换 better-sqlite3 原生模块（绕开 node-gyp / VS Build Tools）
 *
 * 为什么需要：`npm rebuild better-sqlite3` 在本机走 node-gyp 现场编译，
 * 而无 VS Build Tools → 必然失败。但预编译产物其实早就在 npm 缓存里
 * （node-v127 与 electron-v130 各一份），直接解包替换即可。
 *
 * 用法: node scripts/swap-abi.mjs node|electron
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  ABI,
  TARGET_MODULE,
  findPrebuild,
  extractSingleFile,
  currentAbi
} from './lib/prebuild-abi.mjs'

const want = process.argv[2]
if (want !== 'node' && want !== 'electron') {
  console.error('用法: node scripts/swap-abi.mjs node|electron')
  process.exit(1)
}

const abi = ABI[want]
let prebuild
try {
  prebuild = findPrebuild(want)
} catch (e) {
  console.error(`[swap-abi] ${e.message}`)
  process.exit(1)
}

if (!prebuild) {
  console.log(`[swap-abi] 本地缓存未找到 ${want} (v${abi}) 的预编译包，尝试通过 prebuild-install 拉取预编译产物...`)
  const sqliteDir = path.join(path.dirname(TARGET_MODULE), '../..')
  const prebuildBin = path.resolve(sqliteDir, '../prebuild-install/bin.js')
  const targetVer = want === 'electron' ? '33.2.1' : '22.0.0'
  const dl = spawnSync(
    process.execPath,
    [prebuildBin, `--runtime=${want}`, `--target=${targetVer}`],
    { cwd: sqliteDir, stdio: 'inherit' }
  )
  if (dl.status === 0 && fs.existsSync(TARGET_MODULE)) {
    console.log(`[swap-abi] 已通过 prebuild-install 拉取并切换为 ${want} (ABI v${abi})`)
    process.exit(0)
  }
  console.error(`[swap-abi] prebuild-install 未成功，回退到 npm rebuild`)
  const args =
    want === 'electron'
      ? ['rebuild', 'better-sqlite3', '--runtime=electron', '--target=33.2.1', '--dist-url=https://npmmirror.com/mirrors/electron/']
      : ['rebuild', 'better-sqlite3']
  const r = spawnSync('npm', args, { stdio: 'inherit', shell: true })
  process.exit(r.status ?? 1)
}

/** 已经是目标 ABI 就不用重写了 —— 省一次 io，也让日志更可信 */
const before = currentAbi()
if (before.abi === want) {
  console.log(`[swap-abi] 当前已是 ${want} (ABI v${abi})，无需切换`)
  process.exit(0)
}

console.log(`[swap-abi] 源: ${path.basename(prebuild)}`)

const bytes = extractSingleFile(prebuild)
if (!bytes) {
  console.error('[swap-abi] 归档里没找到 better_sqlite3.node')
  process.exit(1)
}

fs.mkdirSync(path.dirname(TARGET_MODULE), { recursive: true })
fs.writeFileSync(TARGET_MODULE, bytes)

const size = fs.statSync(TARGET_MODULE).size
console.log(`[swap-abi] 已切换为 ${want} (ABI v${abi})，${size} 字节`)

/**
 * 写完立刻**回读核对**：切换失败在这里被抓住，比在打出来的包里
 * 表现为"静默崩溃"便宜太多。
 */
const after = currentAbi()
if (after.abi !== want) {
  console.error(`[swap-abi] 切换后核对失败：期望 ${want}，实际 ${after.abi ?? '未知'}`)
  process.exit(1)
}
console.log('[swap-abi] 回读核对通过')
