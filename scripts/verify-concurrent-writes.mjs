/**
 * 验证多进程并发写入（V2 核心场景：多个 Agent 同时调 CLI）
 *
 * 每个 CLI 调用都是一个独立进程，所以"N 个 Agent 并发"= N 个进程同时写同一个 SQLite。
 * 要回答三件事：
 *   1. 会不会报 SQLITE_BUSY / 丢数据（PRD 的 NF2-P-05 要求 20 进程并发）
 *   2. 实际耗时
 *   3. 资源开销 —— 每个进程都是一个 Electron 实例，这是无头通道的隐性成本
 *
 * 用法：node scripts/verify-concurrent-writes.mjs [并发数]
 * 前置：先 npm run build
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const ELECTRON = join(
  ROOT,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'electron.cmd' : 'electron'
)
const N = Number(process.argv[2] || 10)
const TAG = `__SPIKE_${Date.now()}__`

function cliJson(args) {
  return new Promise((resolve) => {
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const t0 = Date.now()
    const child = spawn(ELECTRON, ['.', '--cli', ...args], {
      cwd: ROOT,
      shell: process.platform === 'win32',
      env
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('close', (code) => {
      let json = null
      try {
        json = JSON.parse(out)
      } catch {
        /* 保持 null */
      }
      resolve({ code, json, out, err, ms: Date.now() - t0 })
    })
  })
}

function runSerial(args) {
  return cliJson(args)
}

async function main() {
  console.log(`并发写入验证：${N} 个进程同时 todo add`)

  // 先记下基线条数
  const before = await runSerial(['todo', 'list', '--limit', '100000'])
  const beforeCount = before.json?.ok ? before.json.data.length : -1
  console.log(`  基线待办数: ${beforeCount}`)

  // ── 并发写入 ──
  const t0 = Date.now()
  const tasks = []
  for (let i = 0; i < N; i++) {
    tasks.push(
      runSerial(['todo', 'add', '--title', `${TAG}_${i}`, '--priority', 'normal'])
    )
  }
  const results = await Promise.all(tasks)
  const wall = Date.now() - t0

  const okResults = results.filter((r) => r.code === 0 && r.json?.ok)
  const failResults = results.filter((r) => !(r.code === 0 && r.json?.ok))
  const busyLike = results.filter((r) => /busy|locked/i.test(r.err + (r.json?.message || '')))

  console.log(`\n  并发完成，墙钟耗时 ${wall}ms`)
  console.log(`  成功 ${okResults.length} / ${N}   失败 ${failResults.length}`)

  // 失败原因必须打出来，否则只能看到"少了一条"却不知道为什么
  if (failResults.length) {
    console.log('\n  失败明细:')
    for (const f of failResults) {
      console.log(`    exit=${f.code}  message=${f.json?.message ?? '(无 JSON)'}`)
      const tail = (f.err || '').trim().split('\n').slice(-3).join(' | ')
      if (tail) console.log(`    stderr 末尾: ${tail.slice(0, 300)}`)
      if (!f.err) console.log(`    stdout: ${(f.out || '(空)').slice(0, 200)}`)
    }
  }
  if (busyLike.length) {
    console.log(`\n  ⚠ 出现 SQLITE_BUSY / locked 类错误: ${busyLike.length} 个`)
  }

  const latencies = results.map((r) => r.ms).sort((a, b) => a - b)
  console.log(
    `  单次调用耗时: P50=${latencies[Math.floor(N / 2)]}ms  P95=${latencies[Math.min(N - 1, Math.floor(N * 0.95))]}ms  最大=${latencies[N - 1]}ms`
  )

  // ── 校验数据正确性 ──
  const after = await runSerial(['todo', 'list', '--limit', '100000'])
  const afterCount = after.json?.ok ? after.json.data.length : -1
  const created = after.json?.ok
    ? after.json.data.filter((t) => String(t.title).startsWith(TAG)).length
    : -1
  console.log(`\n  库中本次写入的条目: ${created} / ${N}`)
  console.log(`  待办总数: ${beforeCount} → ${afterCount}`)

  const dataOk = created === N
  console.log(`\n  ${dataOk ? 'PASS' : 'FAIL'}  并发写入无丢失（期望 ${N} 条，实际 ${created} 条）`)
  console.log(`  ${busyLike.length === 0 ? 'PASS' : 'FAIL'}  无 SQLITE_BUSY`)

  // ── 清理 ──
  // CLI 暂无删除命令，这里只提示，实际清理由 cleanup-test-todos.mjs 负责
  console.log(`\n  注意：本次留下 ${created} 条标题带 ${TAG} 的测试数据`)
  console.log(`  清理命令：node scripts/cleanup-test-todos.mjs（已包含 __SPIKE_ 模式）`)
}

main().catch((e) => {
  console.error('验证失败:', e.message)
  process.exitCode = 1
})
