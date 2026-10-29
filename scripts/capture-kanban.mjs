/**
 * 截取看板窗口
 * 用法：node scripts/capture-kanban.mjs [输出目录]
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const CDP_PORT = Number(process.env.CDP_PORT || 9222)
const OUT_DIR = process.argv[2] || join(process.cwd(), '..', 'screenshots')
let msgId = 0

const listTargets = async () => (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    ws.onopen = () => resolve(ws)
    ws.onerror = () => reject(new Error(`WebSocket 失败: ${wsUrl}`))
  })
}

function send(ws, method, params) {
  return new Promise((resolve, reject) => {
    const id = ++msgId
    const onMessage = (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id !== id) return
      ws.removeEventListener('message', onMessage)
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
    }
    ws.addEventListener('message', onMessage)
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function evaluate(ws, expression) {
  const res = await send(ws, 'Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.text || 'JS 异常')
  return res.result.value
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const ball = (await listTargets()).filter((t) => t.type === 'page').find((p) => p.url.includes('float-ball'))
  if (!ball) throw new Error('未找到悬浮球窗口')
  const bw = await connect(ball.webSocketDebuggerUrl)

  // 造几条示例数据，让看板有内容可看（截图后会自动清理）
  const created = await evaluate(bw, `
    (async () => {
      const cats = await window.api.invoke('category:list')
      const cid = cats.ok && cats.data.length ? cats.data[0].id : ''
      const ids = []
      const titles = ['评审 DeskPartner 新视觉与 D 字母 logo', '把图标全面替换为原生 SVG']
      for (const title of titles) {
        const r = await window.api.invoke('todo:create', { title, categoryId: cid })
        if (r.ok) ids.push(r.data.id)
      }
      const t3 = await window.api.invoke('todo:create', { title: '验证界面不透明度实时生效', categoryId: cid })
      if (t3.ok) {
        ids.push(t3.data.id)
        await window.api.invoke('todo:update', { id: t3.data.id, status: 'done' })
      }
      return ids
    })()
  `)

  await evaluate(bw, `window.api.invoke('window:showKanban')`)
  bw.close()
  await sleep(3000)

  const page = (await listTargets()).filter((t) => t.type === 'page').find((p) => p.url.includes('kanban'))
  if (!page) throw new Error('看板窗口未出现')
  const ws = await connect(page.webSocketDebuggerUrl)
  await sleep(600)

  const shot = await send(ws, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
  mkdirSync(OUT_DIR, { recursive: true })
  const out = join(OUT_DIR, 'kanban-panel.png')
  writeFileSync(out, Buffer.from(shot.data, 'base64'))
  console.log('已保存:', out)

  // 清理本次造的示例数据，避免污染用户数据库
  if (Array.isArray(created) && created.length) {
    await evaluate(
      ws,
      `(async () => {
        for (const id of ${JSON.stringify(created)}) {
          await window.api.invoke('todo:delete', { id })
        }
        return true
      })()`
    )
    console.log(`已清理 ${created.length} 条示例待办`)
  }

  ws.close()
}

main().catch((e) => { console.error('截图失败:', e.message); process.exitCode = 1 })
