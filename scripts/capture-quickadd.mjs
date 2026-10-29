/**
 * 截取新增待办窗口，并检查窗口底色是否为半透明黑
 *
 * 用法：node scripts/capture-quickadd.mjs [输出目录]
 * 前置：electron-vite dev -- --remote-debugging-port=9222 已在跑
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const CDP_PORT = Number(process.env.CDP_PORT || 9222)
const OUT_DIR = process.argv[2] || join(process.cwd(), '..', 'screenshots')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function makeSession(ws) {
  let id = 0
  const send = (method, params, timeoutMs = 15000) =>
    new Promise((res, rej) => {
      const my = ++id
      const timer = setTimeout(() => {
        ws.removeEventListener('message', h)
        rej(new Error(`CDP 超时(${timeoutMs}ms): ${method}`))
      }, timeoutMs)
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

  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', {
      expression: expr,
      awaitPromise: true,
      returnByValue: true
    })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'JS 异常')
    return r.result.value
  }

  return { send, evaluate }
}

async function main() {
  const targets = async () =>
    (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()).filter(
      (t) => t.type === 'page'
    )
  const connect = async (url) => {
    const ws = new WebSocket(url)
    await new Promise((res, rej) => {
      ws.onopen = res
      ws.onerror = () => rej(new Error('WebSocket 失败'))
    })
    return ws
  }

  const ball = (await targets()).find((p) => p.url.includes('float-ball'))
  if (!ball) throw new Error('未找到悬浮球窗口')
  const fbWs = await connect(ball.webSocketDebuggerUrl)
  const fb = makeSession(fbWs)
  await fb.evaluate(`window.api.invoke('window:showQuickAdd', {})`)
  fbWs.close()
  await sleep(3000)

  const qa = (await targets()).find((p) => p.url.includes('quick-add'))
  if (!qa) throw new Error('新增待办窗口未出现')
  const ws = await connect(qa.webSocketDebuggerUrl)
  const s = makeSession(ws)
  await sleep(800)

  // 校验：窗口根容器不应有任何压暗遮罩
  const bg = await s.evaluate(`
    (() => {
      const root = document.getElementById('root')
      const layer = root && root.firstElementChild
      const chain = []
      let el = layer
      while (el && el !== document.documentElement) {
        chain.push({ tag: el.tagName.toLowerCase(), cls: el.className || '', bg: getComputedStyle(el).backgroundColor })
        el = el.parentElement
      }
      return {
        html: getComputedStyle(document.documentElement).backgroundColor,
        body: getComputedStyle(document.body).backgroundColor,
        chain
      }
    })()
  `)
  console.log('html 底色:', bg.html)
  console.log('body 底色:', bg.body)
  for (const c of bg.chain) {
    console.log(`  <${c.tag}> bg=${c.bg}  ${String(c.cls).slice(0, 60)}`)
  }

  const shot = await s.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true
  })
  mkdirSync(OUT_DIR, { recursive: true })
  const out = join(OUT_DIR, 'quickadd.png')
  writeFileSync(out, Buffer.from(shot.data, 'base64'))
  console.log('已保存:', out)
  ws.close()
}

main().catch((e) => {
  console.error('失败:', e.message)
  process.exitCode = 1
})
