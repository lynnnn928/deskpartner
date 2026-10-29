/**
 * 一键回归：在**隔离实例**上按顺序执行所有 CDP 端到端检查，汇总结果
 *
 * 用法：npm run verify
 *
 * ── 它自己负责起实例（2026-09-29 决策 A 改造）──
 *
 * 原来这里要求"你先在另一个终端把 app 跑起来"，于是：
 * - 起的是**真实库**上的实例 → 所有脚本的探针都写进她的真实看板
 * - 跑完还要靠 `cleanup-test-todos.mjs` 逐条 `todo rm` 收拾
 *   → 每轮都要向她申请销毁授权（实测累计 68 条，其中 15 条过期未处理）
 *
 * 现在它调 `withIsolatedApp()`：副本库 + 屏幕外窗口 + 跑完整个临时目录一起删。
 * **清理动作归零，删除授权归零。**
 *
 * 仍然可以连一个已跑起来的实例（调试用）：设 `CDP_PORT` 并加 `--external`。
 * 但那样是真实库，探针会进去 —— 只在你自己清楚在干什么时用。
 *
 * ── 顺序有讲究 ──
 *
 * `verify-floatball-flows` 会真的调用 `app:quit` 终止应用，**必须放最后**，
 * 否则后面的检查全连不上。
 */
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { withIsolatedApp } from './lib/isolated-app.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const EXTERNAL = process.argv.includes('--external')
const PORT = Number(process.env.CDP_PORT || 9472)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const CHECKS = [
  { name: 'IPC 通道连通性', file: 'e2e-ipc-check.mjs' },
  { name: '跨窗口数据同步', file: 'e2e-cross-window.mjs' },
  { name: '看板滚动行为', file: 'verify-kanban-scroll.mjs' },
  { name: '窗口按钮与卡片布局', file: 'verify-ui-details.mjs' },
  { name: '详细字段（描述/优先级/截止）', file: 'verify-detail-fields.mjs' },
  { name: '跨进程变更广播（CLI 写入→界面自刷新）', file: 'verify-cross-process-refresh.mjs' },
  // 验证管道本身的脚本：它的 CLI 调用**必须允许走通道 A**，
  // 否则会静默降级成无头，于是"两条通道都验过"变成只验了一条
  { name: 'CLI 双通道（管道 A / 无头 B）', file: 'verify-cli-channels.mjs', noPipe: false },
  // 会终止应用，必须最后
  { name: '悬浮球主链路（含退出，会终止应用）', file: 'verify-floatball-flows.mjs' }
]

/** 已跑起来的实例：连上去，跑完不做清理（它是真实库，本来也不该有探针） */
async function external() {
  const alive = await fetch(`http://127.0.0.1:${PORT}/json/version`)
    .then((r) => r.ok)
    .catch(() => false)
  if (!alive) {
    console.error(`未检测到运行中的应用（CDP 端口 ${PORT} 无响应）`)
    console.error('去掉 --external 可以由本脚本自动起一个隔离实例。')
    return 1
  }
  console.warn('⚠️ --external 模式连的是**你正在跑的实例**（真实库），探针会写进去。')
  return runAll(async (file, opts) => {
    const r = spawnSync(process.execPath, [join(HERE, file)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120000,
      killSignal: 'SIGKILL',
      env: {
        ...process.env,
        CDP_PORT: String(PORT),
        ...(opts?.noPipe === false ? {} : { DESKPARTNER_NO_PIPE: '1' })
      }
    })
    if (r.stdout) process.stdout.write(r.stdout)
    if (r.stderr) process.stderr.write(r.stderr)
    return { code: r.status ?? 1, error: r.error, cdpAlive: () => cdpAlive() }
  }, { cleanup: false })
}

async function cdpAlive() {
  try {
    return (await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok
  } catch {
    return false
  }
}

/** 开头统一开一次看板窗口：部分脚本（如 verify-ui-details）假定它已存在 */
async function ensureKanban(evaluate) {
  const has = await evaluate(
    `window.api.invoke('window:showKanban').then(() => true)`,
    { urlPart: 'float-ball' }
  ).catch(() => false)
  if (has) await sleep(2500)
}

/**
 * 按序跑完，汇总。
 * @param {(file: string, opts?: object) => Promise<{code:number, error?:unknown, cdpAlive?:Function}>} runner
 */
async function runAll(runner, { cleanup = true } = {}) {
  let failed = 0
  const results = []

  for (const check of CHECKS) {
    console.log(`\n${'─'.repeat(60)}`)
    console.log(`▶ ${check.name}  (${check.file})`)
    console.log('─'.repeat(60))
    const r = await runner(check.file, { noPipe: check.noPipe })

    const timedOut = r.error && r.error.code === 'ETIMEDOUT'
    if (timedOut) console.log('  [!] 该检查超时未自行退出，已强制结束')
    const ok = r.code === 0
    if (!ok) failed++
    results.push({ name: check.name, ok })

    // 应用已被上一个脚本关掉，后续检查无意义
    if (!ok && cleanup && !(await cdpAlive())) {
      console.log('\n应用已退出，后续检查跳过。')
      break
    }
  }

  console.log(`\n${'═'.repeat(60)}`)
  console.log('回归结果汇总')
  console.log('═'.repeat(60))
  for (const r of results) console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`)
  console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项未通过`}`)
  return failed === 0 ? 0 : 1
}

async function main() {
  if (EXTERNAL) return external()

  let code = 1
  await withIsolatedApp(
    async ({ port, run, evaluate }) => {
      console.log('\n准备：确保看板窗口已打开')
      await ensureKanban(evaluate)

      const wrapper = async (file, opts) => {
        const r = await run(file, [], opts)
        return { code: r.code, error: r.error, cdpAlive: () => cdpAliveOn(port) }
      }
      code = await runAll(wrapper)
    },
    { port: PORT }
  )
  return code
}

async function cdpAliveOn(port) {
  try {
    return (await fetch(`http://127.0.0.1:${port}/json/version`)).ok
  } catch {
    return false
  }
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((e) => {
    console.error('回归执行失败:', e.message)
    process.exitCode = 1
  })
