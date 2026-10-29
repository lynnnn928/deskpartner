/**
 * 截取设置面板全貌
 *
 * 打开设置窗口 → 覆盖视口尺寸以容纳全部内容 → 整页截图
 * 用法：node scripts/capture-settings.mjs [输出目录]
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const CDP_PORT = Number(process.env.CDP_PORT || 9222)
const OUT_DIR = process.argv[2] || join(process.cwd(), '..', 'screenshots')

let msgId = 0

async function listTargets() {
  const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json`)
  return res.json()
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    ws.onopen = () => resolve(ws)
    ws.onerror = () => reject(new Error(`WebSocket 连接失败: ${wsUrl}`))
  })
}

function send(ws, method, params) {
  return new Promise((resolve, reject) => {
    const id = ++msgId
    const onMessage = (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id !== id) return
      ws.removeEventListener('message', onMessage)
      if (msg.error) reject(new Error(JSON.stringify(msg.error)))
      else resolve(msg.result)
    }
    ws.addEventListener('message', onMessage)
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function evaluate(ws, expression) {
  const res = await send(ws, 'Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  })
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.text || 'JS 异常')
  return res.result.value
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const targets = await listTargets()
  const ball = targets.filter((t) => t.type === 'page').find((p) => p.url.includes('float-ball'))
  if (!ball) throw new Error('未找到悬浮球窗口')

  const ballWs = await connect(ball.webSocketDebuggerUrl)
  await evaluate(ballWs, `window.api.invoke('window:showSettings')`)
  ballWs.close()
  await sleep(2500)

  const page = (await listTargets())
    .filter((t) => t.type === 'page')
    .find((p) => p.url.includes('settings'))
  if (!page) throw new Error('设置窗口未出现')

  const ws = await connect(page.webSocketDebuggerUrl)

  // 量出内容实际高度
  const { width, height } = await evaluate(
    ws,
    `(() => {
      const scroller = document.querySelector('.overflow-y-auto')
      return { width: Math.ceil(window.innerWidth), height: Math.ceil(scroller.scrollHeight + 52) }
    })()`
  )

  // 覆盖视口以容纳全部内容
  await send(ws, 'Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 2,
    mobile: false
  })
  await sleep(900)

  const shot = await send(ws, 'Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true
  })

  mkdirSync(OUT_DIR, { recursive: true })
  const out = join(OUT_DIR, 'settings-panel.png')
  writeFileSync(out, Buffer.from(shot.data, 'base64'))
  console.log(`已保存: ${out}  (${width}x${height} @2x)`)

  await send(ws, 'Emulation.clearDeviceMetricsOverride')
  await evaluate(ws, `window.api.invoke('window:hideSettings')`)
  ws.close()
}

main().catch((err) => {
  console.error('截图失败:', err.message)
  process.exitCode = 1
})
