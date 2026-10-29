/**
 * 隔离验收用的探针脚本（常驻管道路线）—— **只读**
 *
 * 这条路线验的是最容易静默走错的那一环：
 *
 *   隔离实例里的 CLI 调用，若按"只由用户名决定"的规则算管道名，
 *   会连上**常驻的真实 GUI**，于是"跑在隔离库上"的调用写进了真实库。
 *
 * 所以本脚本**刻意不设** `DESKPARTNER_NO_PIPE`，让启动器正常尝试通道 A；
 * 然后问 `doctor` 它到底连到了哪个库。
 *
 * 为什么不做写入：这条路线在"真实 GUI 在跑 + 隔离实例也在跑"时，
 * 若管道名规则正确，启动器会**找不到管道 → 降级无头**（连自己那份副本）。
 * 若规则错了，它会连上真实 GUI —— 一个"可能写进她真实库"的探针
 * 不适合放在验收脚本里。只读的 `doctor` 已经能给出决定性结论：
 * **dbPath 是不是副本**。
 *
 * 用法：由 verify-isolation.mjs 调用（不带 NO_PIPE）。
 */
import { spawnSync } from 'node:child_process'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const LAUNCHER = join(ROOT, 'out', 'cli', 'deskpartner.cjs')
const expected = process.env.DESKPARTNER_DATA_DIR

function cli(args) {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const r = spawnSync(process.execPath, [LAUNCHER, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 90000,
    cwd: ROOT,
    env
  })
  try {
    return JSON.parse(r.stdout ?? '')
  } catch {
    return { ok: false, message: `输出不是 JSON: ${(r.stdout || '').slice(0, 200)}` }
  }
}

const started = Date.now()
const doc = cli(['doctor'])
const ms = Date.now() - started
const d = doc?.data
const dbPath = d?.dbPath
const via = d?.via

const onCopy =
  !!dbPath &&
  !!expected &&
  resolve(dbPath).toLowerCase() === resolve(join(expected, 'user.db')).toLowerCase()

console.log(`  本次走的通道: ${via || '未知'}（耗时 ${ms}ms）`)
console.log(`  ${onCopy ? 'PASS' : 'FAIL'}  管道路线打开的库也是副本（dbPath=${dbPath}）`)

/**
 * 若本机确实有真实 GUI 在跑，管道名规则错了的话这里会显示
 * `via=pipe` **且 dbPath 是真实库** —— 那正是要拦住的形状。
 * 规则正确时它要么 `via=pipe`（连上隔离实例自己的管道）且 dbPath 是副本，
 * 要么降级 `via=headless` 且 dbPath 仍是副本。
 */
if (!onCopy) {
  console.error(`  期望: ${join(expected || '?', 'user.db')}`)
  console.error('  → 管道名没有包含数据目录摘要，隔离实例与真实实例共用了管道！')
  process.exit(1)
}
console.log('管道路线探针：通过')
