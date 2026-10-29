/**
 * 验证跨进程变更可见性（变更广播的底座）
 *
 * 要回答两件事，它们分别是"数据层"和"通知层"：
 *   1. 数据层：CLI 进程写入后，已运行的 GUI 进程能否读到（WAL 跨进程可见性）
 *   2. 通知层：GUI 的界面会不会自己刷新（当前尚未实现 events 表轮询，预期不会）
 *
 * 把这两层分开测很重要：如果第 1 层就不通，那改广播机制也没用；
 * 如果第 1 层通、只有第 2 层不通，说明缺的只是一条通知，架构底座是稳的。
 *
 * 用法：node scripts/verify-cross-process-visibility.mjs
 * 前置：应用已在跑（--remote-debugging-port=9222），且已 npm run build
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const CDP_PORT = Number(process.env.CDP_PORT || 9222)
const ELECTRON = join(
  ROOT,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'electron.cmd' : 'electron'
)
const TAG = `__VIS_${Date.now()}__`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let msgId = 0

async function guiSession() {
  const pages = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()).filter(
    (t) => t.type === 'page'
  )
  const ball = pages.find((p) => p.url.includes('float-ball'))
  if (!ball) throw new Error('未找到悬浮球窗口，请先启动应用')
  const ws = new WebSocket(ball.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = () => rej(new Error('WebSocket 失败'))
  })

  const send = (method, params) =>
    new Promise((res, rej) => {
      const id = ++msgId
      const timer = setTimeout(() => rej(new Error(`CDP 超时: ${method}`)), 15000)
      const h = (ev) => {
        const d = JSON.parse(ev.data)
        if (d.id !== id) return
        clearTimeout(timer)
        ws.removeEventListener('message', h)
        d.error ? rej(new Error(JSON.stringify(d.error))) : res(d.result)
      }
      ws.addEventListener('message', h)
      ws.send(JSON.stringify({ id, method, params }))
    })

  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', {
      expression: expr,
      awaitPromise: true,
      returnByValue: true
    })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
    return r.result.value
  }

  return {
    ev,
    close: () => ws.close()
  }
}

function cliJson(args) {
  return new Promise((resolve) => {
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(ELECTRON, ['.', '--cli', ...args], {
      cwd: ROOT,
      shell: process.platform === 'win32',
      env
    })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.on('close', (code) => {
      let json = null
      try {
        json = JSON.parse(out)
      } catch {
        /* null */
      }
      resolve({ code, json })
    })
  })
}

async function main() {
  const gui = await guiSession()

  const countInGui = () =>
    gui.ev(
      `(async () => {
        const r = await window.api.invoke('todo:list', {})
        return r.ok ? r.data.length : -1
      })()`
    )

  const before = await countInGui()
  console.log(`GUI 进程当前可见待办数: ${before}`)

  // ── CLI 进程写入 ──
  console.log(`\n用 CLI 进程写入一条: ${TAG}`)
  const t0 = Date.now()
  const created = await cliJson(['todo', 'add', '--title', TAG])
  const writeMs = Date.now() - t0
  console.log(`  写入结果: ${created.json?.ok ? '成功' : '失败'}  耗时 ${writeMs}ms`)

  // ── 立刻再查 GUI（不重启、不做任何刷新） ──
  const t1 = Date.now()
  const after = await countInGui()
  const readMs = Date.now() - t1
  console.log(`\n写入后立刻在 GUI 里再查一次（${readMs}ms）: ${after}`)

  const visibleImmediately = after === before + 1
  console.log(
    `\n[数据层] ${visibleImmediately ? 'PASS' : 'FAIL'}  CLI 写入后 GUI 立即可见（${before} → ${after}）`
  )

  // ── 通知层：界面自己会不会刷新 ──
  // 看渲染层 store 里的数据，而不是重新查库
  const storeCount = await gui.ev(
    `(() => {
      // 读 zustand store 的当前快照（不再调 IPC，即不再主动查库）
      const el = document.querySelector('#root')
      const text = el ? el.textContent || '' : ''
      return { hasTag: ${JSON.stringify(TAG)} ? text.includes(${JSON.stringify(TAG)}) : false }
    })()`
  )
  console.log(
    `[通知层] ${storeCount.hasTag ? 'PASS' : 'FAIL(预期)'}  GUI 界面内容里已出现该待办`
  )
  console.log(
    `         ${storeCount.hasTag ? '界面已自动刷新' : '界面未自动刷新 —— 因为 events 表轮询尚未实现，缺的是"通知"这一层，不是数据层'}`
  )

  // 清理
  const listed = await cliJson(['todo', 'list', '--limit', '100000'])
  const target = listed.json?.data?.find((t) => String(t.title) === TAG)
  console.log(`\n清理：${target ? '找到待删条目，需走 cleanup-test-todos.mjs' : '未找到'}`)
  console.log(`（本次标记: ${TAG}）`)

  gui.close()
}

main().catch((e) => {
  console.error('验证失败:', e.message)
  process.exitCode = 1
})
