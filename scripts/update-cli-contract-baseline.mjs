/**
 * 刷新命令面契约基线（卡 `829ad776`）
 *
 * 契约（`dp schema` / `dp help` / MCP `tools/list`）变了的时候**显式**跑这个，
 * 把 `tests/main/cli/cli-contract-baseline.json` 刷成当前值，并把它的 diff 带进评审 ——
 * 普通测试运行不会改写那个文件（闸门里有断言盯着）。
 *
 * 为什么要一个脚本、而不是在用例里加个 `--update` 开关：
 * 更新动作得留痕在命令历史里，评审看 diff 才有得看。跑这个脚本 = 你承认"契约确实变了"。
 *
 * ⚠️ 与 `scripts/run-tests.mjs` 同一套讲究：better-sqlite3 的原生产物有两份
 * （Node 22 = ABI 127 / Electron 33 = ABI 130），共用同一个文件。所以这里
 * 切到 node → 跑 → **无论成败都切回 electron**，免得悄悄把开发环境弄坏。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const SPEC = 'tests/main/cli/cli-contract-baseline-829ad776.test.ts'

/** 与本机其它脚本一致的 Node 22 解析（动态找版本目录，不硬编码补丁号后缀） */
function resolveNode22() {
  if (process.env.DESKPARTNER_NODE22 && existsSync(process.env.DESKPARTNER_NODE22)) {
    return process.env.DESKPARTNER_NODE22
  }
  if (process.versions.modules === '127') {
    return process.execPath
  }
  const home = process.env.USERPROFILE || process.env.HOME || ''
  try {
    for (const d of readdirSync(home, { withFileTypes: true })) {
      if (!d.isDirectory() || !d.name.startsWith('.')) continue
      const versionsDir = join(home, d.name, 'binaries', 'node', 'versions')
      if (!existsSync(versionsDir)) continue
      const candidates = readdirSync(versionsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && /^22\./.test(e.name))
        .map((e) => join(versionsDir, e.name, 'node.exe'))
        .filter((p) => existsSync(p))
        .sort((a, b) => {
          const n = (p) => Number(p.match(/-(\d+)[/\\]node\.exe$/)?.[1] ?? 0)
          return n(a) - n(b)
        })
      if (candidates.length > 0) return candidates[candidates.length - 1]
    }
  } catch {
    /* fall through */
  }
  throw new Error('找不到 Node 22 运行时（ABI 127）—— 请使用 Node 22 或设置 DESKPARTNER_NODE22')
}

const swap = (target) => {
  console.log(`> 切换原生模块 ABI → ${target}`)
  const r = spawnSync(process.execPath, [join(HERE, 'swap-abi.mjs'), target], { stdio: 'inherit' })
  return r.status ?? 1
}

console.log('> 契约基线：按当前源码重算三份契约（schema / help / MCP tools/list）')
const swappedIn = swap('node')
if (swappedIn !== 0) {
  console.error('切到 node ABI 失败，中止 —— 没动任何文件')
  process.exit(swappedIn)
}

const r = spawnSync(resolveNode22(), [join(ROOT, 'node_modules/vitest/vitest.mjs'), 'run', SPEC], {
  cwd: ROOT,
  stdio: 'inherit',
  env: { ...process.env, UPDATE_CLI_CONTRACT: '1' }
})
const ran = r.status ?? 1
if (r.error) console.error(`vitest 没起来：${r.error.message}`)

const restored = swap('electron')
if (restored !== 0) {
  console.error('⚠️ 切回 electron ABI 失败 —— 下次 npm run dev 会报 ERR_DLOPEN_FAILED，先手工修复')
}

console.log(
  ran === 0
    ? '\n> 基线已刷新。下一步：`git diff tests/main/cli/cli-contract-baseline.json` —— 确认每一条差异都是你有意改的'
    : '\n> 刷新失败（见上面的 vitest 输出）'
)
process.exit(ran || restored)
