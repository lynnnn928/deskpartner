/**
 * 验证悬浮球：logo 是否加载成功，并截取球体区域
 * 用法：node scripts/verify-floatball.mjs
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const CDP_PORT = Number(process.env.CDP_PORT || 9222)
const OUT = '.tmp-check/screenshots'
let id = 0

const targets = async () => (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()

function connect(u) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(u)
    ws.onopen = () => res(ws)
    ws.onerror = () => rej(new Error('ws fail'))
  })
}

function send(ws, method, params = {}) {
  return new Promise((res, rej) => {
    const i = ++id
    const h = (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id !== i) return
      ws.removeEventListener('message', h)
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)
    }
    ws.addEventListener('message', h)
    ws.send(JSON.stringify({ id: i, method, params }))
  })
}

async function evaluate(ws, expression) {
  const r = await send(ws, 'Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'js err')
  return r.result.value
}

async function main() {
  const page = (await targets()).filter((t) => t.type === 'page').find((p) => p.url.includes('float-ball'))
  if (!page) throw new Error('未找到悬浮球窗口')
  const ws = await connect(page.webSocketDebuggerUrl)

  const info = await evaluate(
    ws,
    `(() => {
      const img = document.querySelector('img')
      const ball = document.querySelector('.rounded-full')
      const r = ball ? ball.getBoundingClientRect() : null
      return {
        hasImg: !!img,
        src: img ? img.getAttribute('src').slice(0, 60) : null,
        natural: img ? img.naturalWidth + 'x' + img.naturalHeight : null,
        loaded: img ? img.complete && img.naturalWidth > 0 : false,
        imgSize: img ? Math.round(img.getBoundingClientRect().width) : 0,
        ball: r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width) } : null,
        ballBg: ball ? getComputedStyle(ball).backgroundColor : null
      }
    })()`
  )
  console.log('悬浮球状态:', JSON.stringify(info, null, 2))

  if (info.ball) {
    const pad = 30
    const shot = await send(ws, 'Page.captureScreenshot', {
      format: 'png',
      clip: {
        x: Math.max(0, info.ball.x - pad),
        y: Math.max(0, info.ball.y - pad),
        width: info.ball.w + pad * 2,
        height: info.ball.w + pad * 2,
        scale: 3
      },
      captureBeyondViewport: true
    })
    const p = join(OUT, 'floatball-preview.png')
    writeFileSync(p, Buffer.from(shot.data, 'base64'))
    console.log('悬浮球截图:', p)
  }
  ws.close()
}

main().catch((e) => { console.error(e.message); process.exitCode = 1 })
