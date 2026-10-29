/**
 * 验证看板横向滚动是否生效
 * 用法：node scripts/verify-kanban-scroll.mjs
 */
const CDP_PORT = Number(process.env.CDP_PORT || 9222)
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const ball = (await targets()).filter((t) => t.type === 'page').find((p) => p.url.includes('float-ball'))
  if (!ball) throw new Error('未找到悬浮球窗口')
  const bw = await connect(ball.webSocketDebuggerUrl)
  await evaluate(bw, `window.api.invoke('window:showKanban')`)
  bw.close()
  await sleep(2600)

  const page = (await targets()).filter((t) => t.type === 'page').find((p) => p.url.includes('kanban'))
  if (!page) throw new Error('看板窗口未出现')
  const ws = await connect(page.webSocketDebuggerUrl)

  const info = await evaluate(
    ws,
    `(() => {
      // 列容器：搜索栏之后的那个 flex 容器
      const board = document.querySelector('.flex-1.flex.gap-3.p-3')
      if (!board) return { found: false }
      const cs = getComputedStyle(board)
      const cols = board.querySelectorAll(':scope > div')
      const first = cols[0]
      return {
        found: true,
        overflowX: cs.overflowX,
        overflowY: cs.overflowY,
        clientWidth: board.clientWidth,
        scrollWidth: board.scrollWidth,
        canScrollX: board.scrollWidth > board.clientWidth,
        colCount: cols.length,
        colWidth: first ? Math.round(first.getBoundingClientRect().width) : 0,
        colMinWidth: first ? getComputedStyle(first).minWidth : null
      }
    })()`
  )

  console.log('看板滚动状态:', JSON.stringify(info, null, 2))
  if (info.found) {
    console.log(
      info.canScrollX
        ? `✅ 内容宽 ${info.scrollWidth} > 可视宽 ${info.clientWidth}，横向可滚动`
        : `ℹ️  内容未超出可视区（${info.scrollWidth} <= ${info.clientWidth}），列自动撑满`
    )
  }
  ws.close()
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((e) => {
    console.error(e.message)
    process.exit(1)
  })
