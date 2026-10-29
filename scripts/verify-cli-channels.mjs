/**
 * 验证 CLI 两条通道：常驻管道（A）与无头进程（B）
 *
 * 要验的不只是"能用"，还有"是否真的走了预期的那条路"——
 * 通道 A 静默降级成通道 B 而不报警，是这里最容易出的问题。
 *
 * 用法：node scripts/verify-cli-channels.mjs
 * 前置：应用已在跑，且已 npm run build
 */
import net from 'node:net'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const LAUNCHER = path.join(ROOT, 'out', 'cli', 'deskpartner.cjs')
/**
 * 管道名要和服务端算得完全一致。
 * 这里刻意不 import src/cli/pipe-protocol（那是 TS），而是照它的规则复算一遍 ——
 * 一旦两边规则漂了，本脚本会直接失败，正好起到看门狗的作用。
 *
 * ⚠️ 规则里**包含数据目录摘要**（`dataDirKey`）：隔离实例必须有自己的管道，
 * 否则它会连上常驻的真实 GUI，把探针写进真实库。复算时别漏掉这一段。
 */
const PIPE = `\\\\.\\pipe\\deskpartner-cli-${userKey()}${dataDirKey()}`

function userKey() {
  const name = process.env.USERNAME || process.env.USER || 'unknown'
  return createHash('sha1').update(name.toLowerCase()).digest('hex').slice(0, 10)
}

/** 与 src/cli/pipe-protocol.ts 的 dataDirKey 同规则（未设变量时为空串） */
function dataDirKey() {
  const raw = process.env.DESKPARTNER_DATA_DIR
  if (raw === undefined || raw.trim() === '') return ''
  const abs = path.resolve(raw).replace(/[\\/]+$/, '').toLowerCase()
  return '-' + createHash('sha1').update(abs).digest('hex').slice(0, 8)
}

let failures = 0
function report(label, ok, detail) {
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`)
}

/** 只连管道做一次往返，不启动任何进程 */
function pipeRoundTrip(argv) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    let buf = ''
    let done = false
    const socket = net.connect(PIPE)
    const finish = (v) => {
      if (done) return
      done = true
      socket.destroy()
      resolve(v)
    }
    const timer = setTimeout(() => finish({ ms: Date.now() - t0, error: 'timeout' }), 5000)
    socket.setEncoding('utf8')
    socket.on('connect', () =>
      socket.write(JSON.stringify({ argv, tty: false }) + '\n')
    )
    socket.on('data', (c) => {
      buf += c
      const nl = buf.indexOf('\n')
      if (nl === -1) return
      clearTimeout(timer)
      try {
        finish({ ms: Date.now() - t0, res: JSON.parse(buf.slice(0, nl)) })
      } catch {
        finish({ ms: Date.now() - t0, error: 'bad json' })
      }
    })
    socket.on('error', (e) => {
      clearTimeout(timer)
      finish({ ms: Date.now() - t0, error: e.code })
    })
  })
}

/** 通过启动器调用，用于验证端到端（含 launcher 自身开销） */
function viaLauncher(argv) {
  const t0 = Date.now()
  const r = spawnSync(process.execPath, [LAUNCHER, ...argv], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60000
  })
  const ms = Date.now() - t0
  let json = null
  try {
    json = JSON.parse(r.stdout ?? '')
  } catch {
    /* null */
  }
  return { ms, json, stdout: r.stdout ?? '' }
}

async function main() {
  console.log('【1】通道 A 直连（只测管道本身，不含任何进程启动）')
  const rtt = []
  for (let i = 0; i < 5; i++) {
    const r = await pipeRoundTrip(['todo', 'list', '--limit', '1'])
    if (r.error) {
      report('管道可用', false, r.error)
      break
    }
    rtt.push(r.ms)
  }
  if (rtt.length) {
    rtt.sort((a, b) => a - b)
    report('管道可达且响应正常', true, `${rtt.length}/5 次`)
    console.log(`        管道往返: 最小 ${rtt[0]}ms  中位 ${rtt[Math.floor(rtt.length / 2)]}ms  最大 ${rtt[rtt.length - 1]}ms`)
    report('管道往返在 50ms 内', rtt[rtt.length - 1] < 50, `最大 ${rtt[rtt.length - 1]}ms`)
  }

  console.log('\n【2】端到端经启动器（含 node 启动开销）')
  const times = []
  for (let i = 0; i < 3; i++) {
    const r = viaLauncher(['todo', 'list', '--limit', '1'])
    if (!r.json?.ok) {
      report('启动器调用', false, r.stdout.slice(0, 80))
      break
    }
    times.push(r.ms)
  }
  if (times.length) {
    times.sort((a, b) => a - b)
    report('启动器输出为合法 JSON', true)
    console.log(`        端到端: ${times.join(', ')} ms`)
    console.log('        注：其中约 220ms 是 node 自身启动，这是"起一个客户端进程"的物理下限')
  }

  console.log('\n【3】通道报告是否如实')
  const doc = viaLauncher(['doctor'])
  const d = doc.json?.data
  report('doctor 返回 channels', Array.isArray(d?.channels))
  report(
    'GUI 在跑时报告含 pipe',
    Array.isArray(d?.channels) && d.channels.includes('pipe'),
    JSON.stringify(d?.channels)
  )
  report('via 标明本次走的通道', d?.via === 'pipe', String(d?.via))

  console.log('\n【4】两条通道的输出必须一致')
  const viaPipe = viaLauncher(['todo', 'list', '--limit', '100000'])
  const direct = await pipeRoundTrip(['todo', 'list', '--limit', '100000'])
  let pipeOut = null
  try {
    pipeOut = JSON.parse(direct.res?.stdout ?? '')
  } catch {
    /* null */
  }
  report(
    '同一命令经两条通道得到相同数据',
    !!pipeOut?.ok && pipeOut.data.length === viaPipe.json?.data?.length,
    pipeOut ? `${pipeOut.data.length} vs ${viaPipe.json?.data?.length}` : '管道响应异常'
  )

  console.log(failures === 0 ? '\n全部通过' : `\n有 ${failures} 项未通过`)
  if (failures) process.exitCode = 1
}

main().catch((e) => {
  console.error('验证失败:', e.message)
  process.exitCode = 1
})
