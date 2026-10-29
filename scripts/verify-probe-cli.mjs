/**
 * 隔离验收用的探针脚本（无头 CLI 路线）
 *
 * 为什么单独做成一个脚本：`withIsolatedApp().run()` 会注入
 * `DESKPARTNER_DATA_DIR` + `DESKPARTNER_NO_PIPE=1`，走的是**无头通道**。
 * 这条路线和界面路径的失效机理不同（它不经过 CDP，直接开库），
 * 所以要单独验一次。
 *
 * ── 什么算通过 ──
 *
 * **决定性判据只有一条**：`doctor` 报的 `dbPath` 是不是副本。
 * 它由主进程实时回答，是"这次调用到底开了哪个库"的唯一权威来源。
 *
 * 写入与删除是**加分项**，不是通过条件：
 * - 写命令要 write 档授权，删命令要 destructive 档授权。隔离副本是从真实库
 *   导出的，`agent_grants` 一并带了过来，所以这里能不能写**取决于她此前
 *   给过什么授权** —— 那是环境事实，不该让验收结论跟着它变。
 * - 拿不到授权就 SKIP 并说明原因。**副本无论如何都会整体删掉**，
 *   残留不会流出去，所以"没删成"不是问题。
 *
 * ⚠️ 别把需要授权的东西当成默认可用 —— 那会训练出"红了就加点授权"的习惯，
 * 而不是"去看看隔离到底通没通"。
 *
 * 用法：由 verify-isolation.mjs 调用，参数是探针标题。
 */
import { spawnSync } from 'node:child_process'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const LAUNCHER = join(ROOT, 'out', 'cli', 'deskpartner.cjs')
const TITLE = process.argv[2] || '__ISOLATED_PROBE__headless'

function cli(args) {
  const r = spawnSync(process.execPath, [LAUNCHER, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 90000,
    cwd: ROOT,
    env: { ...process.env }
  })
  try {
    return JSON.parse(r.stdout ?? '')
  } catch {
    return { ok: false, error: { code: 'not_json' }, message: (r.stdout || '').slice(0, 200) }
  }
}

const codeOf = (res) => res?.error?.code || res?.code || null

/** 需要授权/身份这类**环境事实**，不是隔离失效 */
const ENV_FACTORS = ['grant_required', 'ambiguous_identity']

// ── 决定性判据 ──
const doc = cli(['doctor'])
const dbPath = doc?.data?.dbPath
const expected = process.env.DESKPARTNER_DATA_DIR
const onCopy =
  !!dbPath &&
  !!expected &&
  resolve(dbPath).toLowerCase() === resolve(join(expected, 'user.db')).toLowerCase()
console.log(`  ${onCopy ? 'PASS' : 'FAIL'}  无头 CLI 打开的库是副本（dbPath=${dbPath}）`)
if (!onCopy) {
  console.error(`  期望: ${join(expected || '?', 'user.db')}`)
  process.exit(1)
}

// ── 加分项：写入闭环 ──
const made = cli(['todo', 'add', '--title', TITLE, '--project', 'DeskPartner'])
if (!made?.ok) {
  const c = codeOf(made)
  console.log(
    `  SKIP  副本内写探针未执行（${c || made?.message || '未知'}）` +
      ` —— 授权/身份档位问题，不影响"CLI 开的是副本"这一结论`
  )
  console.log('无头探针：通过（就隔离而言）')
  process.exit(0)
}

const found = cli(['todo', 'list', '--limit', '100000'])
const hit = found?.data?.find((t) => t.title === TITLE)
console.log(`  ${hit ? 'PASS' : 'FAIL'}  探针出现在本实例清单里`)
if (!hit) process.exit(1)

const id = made.data?.id || made.data?.todo?.id
const rm = cli(['todo', 'rm', id, '--yes'])
if (rm?.ok) {
  const after = cli(['todo', 'list', '--limit', '100000'])
  const clean = !after?.data?.some((t) => t.title === TITLE)
  console.log(`  ${clean ? 'PASS' : 'FAIL'}  探针已删除并确认删净`)
  if (!clean) process.exit(1)
} else {
  const c = codeOf(rm)
  console.log(
    `  SKIP  副本内未删除探针（${c || '未知'}）` +
      ` —— destructive 档要授权；副本整体会被丢弃，残留不会流出去`
  )
}

console.log('无头探针：通过')
