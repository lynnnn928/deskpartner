/**
 * 验证最小 CLI 探针，并实测无头通道的调用延迟（回答 v2 PRD 的 Q-06）
 *
 * 用法：node scripts/verify-cli.mjs [延迟采样次数]
 * 前置：先 npm run build（脚本直接跑 out/ 产物，避免 dev 模式 vite 启动干扰计时）
 */
import { spawnSync } from 'node:child_process'
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
const SAMPLES = Number(process.argv[2] || 8)

let failures = 0
function report(label, ok, detail) {
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`)
}

/**
 * 调用 CLI
 *
 * 两个坑已在这里处理掉：
 * - ELECTRON_RUN_AS_NODE 必须 delete，设成空字符串照样进入 run-as-node 模式
 * - Windows 下 electron.cmd 是批处理，必须经 shell
 */
function cli(args, stdin) {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE

  const r = spawnSync(ELECTRON, ['.', '--cli', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 90000,
    shell: process.platform === 'win32',
    env,
    ...(stdin !== undefined ? { input: stdin } : {})
  })
  const stdout = r.stdout ?? ''
  let json = null
  try {
    json = JSON.parse(stdout)
  } catch {
    /* null */
  }
  return { status: r.status, stdout, stderr: r.stderr ?? '', json }
}

const TITLE = `__CLI_TEST_${Date.now()}__`

console.log('【1】基础命令')
const doctor = cli(['doctor'])
report(
  'doctor 返回合法 JSON',
  !!doctor.json?.ok,
  doctor.json ? `schemaVersion=${doctor.json.data?.schemaVersion}` : doctor.stdout.slice(0, 80)
)
report('doctor 退出码 0', doctor.status === 0, `status=${doctor.status}`)
report('doctor 声明了可用通道', !!doctor.json?.data?.channels, JSON.stringify(doctor.json?.data?.channels))

console.log('\n【2】写入与查询')
const added = cli(['todo', 'add', '--title', TITLE, '--priority', 'high', '--desc', 'CLI 探针写入'])
report('todo add 成功', !!added.json?.ok, added.json?.data ? `id=${String(added.json.data.id).slice(0, 8)}…` : added.stdout.slice(0, 80))
const newId = added.json?.data?.id

if (newId) {
  const listed = cli(['todo', 'list', '--search', '__CLI_TEST_'])
  const hit = listed.json?.data?.find((t) => t.id === newId)
  report('todo list 能查到刚建的条目', !!hit, hit ? `priority=${hit.priority}` : '')
  report('详细字段（优先级）正确落库', hit?.priority === 'high', `实际 ${hit?.priority}`)
}

console.log('\n【3】删除与确认保护')
if (newId) {
  const rmNoConfirm = cli(['todo', 'rm', newId])
  report('不带 --yes 时拒绝删除', rmNoConfirm.json?.ok === false, rmNoConfirm.json?.message || '')
  report('拒绝时退出码为 2', rmNoConfirm.status === 2, `status=${rmNoConfirm.status}`)

  const stillThere = !!cli(['todo', 'list', '--search', '__CLI_TEST_']).json?.data?.find(
    (t) => t.id === newId
  )
  report('被拒绝后条目仍在（没有误删）', stillThere)

  const rm = cli(['todo', 'rm', newId, '--yes'])
  report('带 --yes 删除成功', !!rm.json?.ok, rm.json?.data ? `deleted=${rm.json.data.deleted}` : '')
  const gone = !cli(['todo', 'list', '--search', '__CLI_TEST_']).json?.data?.find(
    (t) => t.id === newId
  )
  report('删除后查不到了', gone)
}
const rmMissing = cli(['todo', 'rm', 'no-such-id', '--yes'])
report('删除不存在的 id 退出码为 3', rmMissing.status === 3, `status=${rmMissing.status}`)

console.log('\n【4】batch 批量执行')
const BATCH_TAG = `__BATCH_${Date.now()}__`
const ndjson = [
  JSON.stringify({ cmd: 'todo add', args: { '--title': `${BATCH_TAG}_a` } }),
  JSON.stringify({ cmd: 'todo add', args: { '--title': `${BATCH_TAG}_b`, '--priority': 'low' } }),
  JSON.stringify({ cmd: 'todo add', args: { '--priority': 'p1' } }), // 故意非法
  JSON.stringify({ cmd: 'todo list', args: { '--limit': '1' } })
].join('\n')

const batch = cli(['batch'], ndjson)
report(
  'batch 返回合法 JSON',
  !!batch.json?.ok,
  batch.json ? `total=${batch.json.data?.total} failed=${batch.json.data?.failed}` : batch.stdout.slice(0, 100)
)
report('batch 统计到 4 条命令', batch.json?.data?.total === 4, `实际 ${batch.json?.data?.total}`)
report('batch 正确识别 1 条失败（非法优先级）', batch.json?.data?.failed === 1, `实际 ${batch.json?.data?.failed}`)

const created = cli(['todo', 'list', '--search', BATCH_TAG])
const batchCount = created.json?.data?.length ?? -1
report('batch 成功写入的 2 条都在库里', batchCount === 2, `实际 ${batchCount}`)

// 用 batch 自清理，顺便验证它能删东西
if (created.json?.data?.length) {
  const delNd = created.json.data
    .map((t) => JSON.stringify({ cmd: 'todo rm', args: { '--yes': true }, positional: [t.id] }))
    .join('\n')
  const cleaned = cli(['batch'], delNd)
  report('batch 可批量清理（自清理能力）', cleaned.json?.data?.failed === 0, `failed=${cleaned.json?.data?.failed}`)
}

console.log('\n【5】错误处理与退出码')
const badPriority = cli(['todo', 'add', '--title', 'x', '--priority', 'p1'])
report('非法优先级被拒', badPriority.json?.ok === false, badPriority.json?.message || '')
report('非法优先级退出码为 2', badPriority.status === 2, `status=${badPriority.status}`)
const missingTitle = cli(['todo', 'add'])
report('缺必填参数退出码为 2', missingTitle.status === 2, `status=${missingTitle.status}`)
const notFound = cli(['todo', 'done', 'no-such-id'])
report('不存在的 id 退出码为 3', notFound.status === 3, `status=${notFound.status}`)
const unknown = cli(['nope'])
report('未知命令退出码为 2', unknown.status === 2, `status=${unknown.status}`)

console.log(`\n【6】无头通道延迟实测（${SAMPLES} 次 todo list）`)
const times = []
for (let i = 0; i < SAMPLES; i++) {
  const t0 = Date.now()
  const r = cli(['todo', 'list', '--limit', '5'])
  const dt = Date.now() - t0
  if (r.json?.ok) times.push(dt)
}
times.sort((a, b) => a - b)
if (times.length) {
  const p50 = times[Math.floor(times.length * 0.5)]
  const p95 = times[Math.min(times.length - 1, Math.floor(times.length * 0.95))]
  console.log(`  样本: ${times.join(', ')} ms`)
  console.log(`  P50 = ${p50}ms   P95 = ${p95}ms   最小 ${times[0]}ms  最大 ${times[times.length - 1]}ms`)
  console.log(`\n  Q-06 判定：无头通道实测 P95 ≈ ${p95}ms（PRD 目标 ≤ 2s）`)
  report('冷调用 P95 在 2s 目标内', p95 <= 2000, `P95=${p95}ms`)
} else {
  report('延迟采样', false, '无有效样本')
}

console.log(failures === 0 ? '\n全部通过' : `\n有 ${failures} 项未通过`)
if (failures) process.exitCode = 1
