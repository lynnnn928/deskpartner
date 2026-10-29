/**
 * 验证「使用数据」独立页面
 *
 * 检查页面能打开、关键区块都渲染出来、条形图有实际元素。
 * 用法：node scripts/verify-stats-page.mjs
 */
const CDP_PORT = Number(process.env.CDP_PORT || 9222)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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
      const timer = setTimeout(() => rej(new Error(`CDP 超时: ${method}`)), 15000)
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

let failures = 0
function report(label, ok, detail) {
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`)
}

async function main() {
  const ball = await session('float-ball')
  if (!ball) throw new Error('未找到悬浮球窗口，请先启动应用')

  await ball.ev(`window.api.invoke('window:showStats')`)
  await sleep(4000)

  const stats = await session('stats')
  report('统计窗口已打开', !!stats)
  if (!stats) {
    ball.close()
    return
  }
  await sleep(1500)

  const txt = await stats.ev(`(document.body.innerText || '')`)
  const checks = [
    ['页面标题', '使用数据'],
    ['隐私说明', '不会联网上传'],
    ['时间范围切换', '近 7 天'],
    ['总览卡片', '事件总数'],
    ['入口分布区块', '使用入口分布'],
    ['操作类型分布区块', '操作类型分布'],
    ['高频事件区块', '高频事件'],
    ['导出按钮', '导出 NDJSON'],
    ['清空按钮', '清空已记录数据']
  ]
  for (const [name, needle] of checks) {
    report(name, txt.includes(needle))
  }

  // 有数据时应该画出条形图
  const bars = await stats.ev(
    `document.querySelectorAll('div[style*="width"]').length`
  )
  report('条形图已渲染', bars > 0, `${bars} 个元素`)

  // 从设置页也能进得来
  const settingsEntry = await ball.ev(`
    (async () => {
      await window.api.invoke('window:showSettings')
      return true
    })()
  `)
  await sleep(3500)
  const settings = await session('settings')
  if (settings) {
    const st = await settings.ev(`(document.body.innerText || '')`)
    report('设置页有「打开使用数据」入口', st.includes('打开使用数据'))
    report('设置页不再堆统计文字', !st.includes('已记录'))
    settings.close()
  }

  stats.close()
  ball.close()
  console.log(failures === 0 ? '\n全部通过' : `\n有 ${failures} 项未通过`)
  if (failures) process.exitCode = 1
}

main().catch((e) => {
  console.error('验证失败:', e.message)
  process.exitCode = 1
})
