/**
 * 验证跨进程变更广播：CLI 进程写入后，正在运行的看板界面会不会自动刷新
 *
 * 这是"通知层"的验收。数据层（能不能读到）单独由
 * verify-cross-process-visibility.mjs 验证；这里只关心：
 * **界面在没人主动查库的情况下，会不会自己变**。
 *
 * 判据是看板 DOM 里是否出现新条目标题 —— 出现即说明
 * 主进程轮询 events 表后广播了 event:dataChanged，界面重新拉了数据。
 *
 * 用法：node scripts/verify-cross-process-refresh.mjs
 * 前置：应用已在跑（--remote-debugging-port=9222），且已 npm run build
 */
import { spawnSync } from 'node:child_process'
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
const TAG = `__REFRESH_${Date.now()}__`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function cli(args) {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const r = spawnSync(ELECTRON, ['.', '--cli', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 90000,
    shell: process.platform === 'win32',
    env
  })
  let json = null
  try {
    json = JSON.parse(r.stdout ?? '')
  } catch {
    /* null */
  }
  return json
}

async function session(match) {
  const pages = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()).filter(
    (t) => t.type === 'page'
  )
  const page = pages.find((p) => p.url.includes(match))
  if (!page) throw new Error(`未找到窗口: ${match}`)
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = () => rej(new Error('WebSocket 失败'))
  })
  let id = 0
  const send = (method, params) =>
    new Promise((res, rej) => {
      const my = ++id
      const timer = setTimeout(() => rej(new Error(`CDP 超时: ${method}`)), 20000)
      const h = (ev) => {
        const d = JSON.parse(ev.data)
        if (d.id !== my) return
        clearTimeout(timer)
        ws.removeEventListener('message', h)
        d.error ? rej(new Error(JSON.stringify(d.error))) : res(d.result)
      }
      ws.addEventListener('message', h)
      ws.send(JSON.stringify({ id: my, method, params }))
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
  return { ev, close: () => ws.close() }
}

async function main() {
  const ball = await session('float-ball')
  await ball.ev(`window.api.invoke('window:showKanban')`)
  await sleep(4000)

  const kanban = await session('kanban')
  const seenBefore = (await kanban.ev(`(document.body.innerText || '')`)).includes(TAG)
  console.log(`写入前看板已含标记: ${seenBefore}（应为 false）`)

  console.log('\n用另一个进程（CLI）写入一条待办…')
  const created = cli(['todo', 'add', '--title', TAG])
  console.log(`  CLI 写入: ${created?.ok ? '成功' : '失败'}`)

  // 轮询间隔 800ms，等 3 秒足够
  await sleep(3000)
  const seenAfter = (await kanban.ev(`(document.body.innerText || '')`)).includes(TAG)
  console.log(`\n写入后看板自动出现该条目: ${seenAfter ? 'PASS' : 'FAIL'}`)
  console.log('  （全程未主动重新查库，纯粹靠界面自动刷新）')

  // 清理
  const list = cli(['todo', 'list', '--limit', '100000'])
  const target = list?.data?.find((t) => t.title === TAG)
  if (target) {
    cli(['todo', 'rm', target.id, '--yes'])
    console.log('\n已清理测试条目')
  }

  kanban.close()
  ball.close()

  if (!seenAfter) process.exitCode = 1
}

main().catch((e) => {
  console.error('验证失败:', e.message)
  process.exitCode = 1
})
