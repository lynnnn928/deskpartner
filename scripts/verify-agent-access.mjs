/**
 * 验证「AI 助手接入」入口 与 卡片双击看详情
 *
 * 两件事都不容易靠读代码确认：
 * - 接入说明的文本是主进程动态生成的，前端拿不到就没有意义
 * - 双击是否被拖拽吞掉，只有在真实 DOM 上派发事件才知道
 *
 * 用法：node scripts/verify-agent-access.mjs
 * 前置：应用已在跑，且已 npm run build
 */
const CDP_PORT = Number(process.env.CDP_PORT || 9222)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let failures = 0
function report(label, ok, detail) {
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`)
}

let msgId = 0
async function session(match) {
  const pages = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()).filter(
    (t) => t.type === 'page'
  )
  const page = match ? pages.find((p) => p.url.includes(match)) : pages[0]
  if (!page) return null
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
  return { ev, send, close: () => ws.close() }
}

async function main() {
  const ball = await session('float-ball')
  if (!ball) throw new Error('应用未就绪')

  console.log('【1】AI 助手接入入口')
  await ball.ev(`window.api.invoke('window:showSettings')`)
  await sleep(4000)
  const settings = await session('settings')
  report('设置窗口已打开', !!settings)
  if (settings) {
    await sleep(1200)
    const txt = await settings.ev(`(document.body.innerText || '')`)
    report('存在「AI 助手接入」区块', txt.includes('AI 助手接入'))
    report('有复制按钮', txt.includes('复制'))
    report('有导出按钮', txt.includes('导出 .md'))
    report('说明了用途', txt.includes('Bob') || txt.includes('读写你的待办'))

    // 直接验 IPC：说明文本必须含本机真实路径
    const guide = await settings.ev(
      `(async () => { const r = await window.api.invoke('cli:agentGuide'); return r.ok ? r.data : ('ERR:'+r.error) })()`
    )
    const isText = typeof guide === 'string'
    report('IPC 能取到说明文本', isText, isText ? `${guide.length} 字符` : String(guide).slice(0, 80))
    if (isText) {
      report('含 frontmatter（可直接当 skill 用）', guide.startsWith('---\nname: desk-partner-todos'))
      report('路径为本机绝对路径', /node "[A-Za-z]:\//.test(guide))
      report('含「什么时候不要用」边界', guide.includes('什么时候不要用'))
    }
    settings.close()
  }

  console.log('\n【2】卡片双击查看详情')
  await ball.ev(`window.api.invoke('window:showKanban')`)
  await sleep(4000)

  // 确保有卡片
  await ball.ev(
    `(async () => { await window.api.invoke('todo:create', { title: '__DBLCLICK__探针' }); return true })()`
  )
  await sleep(1500)

  const kanban = await session('kanban')
  report('看板窗口已打开', !!kanban)
  if (kanban) {
    const box = await kanban.ev(`(() => {
      const cards = [...document.querySelectorAll('[title="双击查看详情"]')];
      if (!cards.length) return null;
      const r = cards[cards.length - 1].getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + 20) };
    })()`)
    report('卡片带双击提示', !!box, box ? `坐标 ${box.x},${box.y}` : '未找到 title 标记')

    if (box) {
      // 真实派发双击，而不是直接调 onEdit —— 这样才能验证没被拖拽吞掉
      for (const type of ['mousePressed', 'mouseReleased']) {
        await kanban.send('Input.dispatchMouseEvent', {
          type,
          x: box.x,
          y: box.y,
          button: 'left',
          clickCount: 1
        })
      }
      await kanban.send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: box.x,
        y: box.y,
        button: 'left',
        clickCount: 2
      })
      await kanban.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: box.x,
        y: box.y,
        button: 'left',
        clickCount: 2
      })
      await sleep(2500)

      const pages = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()).filter(
        (t) => t.type === 'page'
      )
      const qa = pages.find((p) => p.url.includes('todoId='))
      report('双击后弹窗打开（且带 todoId，说明是编辑模式）', !!qa, qa ? qa.url.split('#')[1] : '未出现')
    }
    kanban.close()
  }

  // 清理探针
  const list = await ball.ev(
    `(async () => { const r = await window.api.invoke('todo:list', { search: '__DBLCLICK__' }); return r.ok ? r.data.map(t => t.id) : [] })()`
  )
  if (Array.isArray(list) && list.length) {
    await ball.ev(
      `(async () => { for (const id of ${JSON.stringify(list)}) { await window.api.invoke('todo:delete', { id }) } return true })()`
    )
  }

  ball.close()
  console.log(failures === 0 ? '\n全部通过' : `\n有 ${failures} 项未通过`)
  if (failures) process.exitCode = 1
}

main().catch((e) => {
  console.error('验证失败:', e.message)
  process.exitCode = 1
})
