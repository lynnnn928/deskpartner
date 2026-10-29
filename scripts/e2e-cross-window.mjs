/**
 * 跨窗口设置同步冒烟测试
 *
 * 验证「在设置窗口改设置 → 其它窗口实时生效」这条链路。
 * 多窗口下各渲染进程状态不共享，全靠主进程广播 event:dataChanged，
 * 因此这是最容易出问题的一环。
 *
 * 运行前提：应用以 --remote-debugging-port=9222 启动
 * 用法：node scripts/e2e-cross-window.mjs
 */

const CDP_PORT = Number(process.env.CDP_PORT || 9222)
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
  if (res.exceptionDetails) {
    throw new Error(
      res.exceptionDetails.exception?.description || res.exceptionDetails.text || 'JS 异常'
    )
  }
  return res.result.value
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 按 URL 片段找到页面并连接 */
async function open(match) {
  const pages = (await listTargets()).filter((t) => t.type === 'page')
  const page = pages.find((p) => p.url.includes(match))
  if (!page) throw new Error(`未找到窗口: ${match}（现有: ${pages.map((p) => p.url).join(', ')}）`)
  return { ws: await connect(page.webSocketDebuggerUrl), page }
}

const results = []
function check(name, pass, detail) {
  results.push({ name, pass })
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

async function main() {
  // ── 打开待测窗口 ──
  const ball = await open('float-ball')
  await evaluate(ball.ws, `window.api.invoke('window:showKanban')`)
  await evaluate(ball.ws, `window.api.invoke('window:showSettings')`)
  await sleep(2800)

  const settings = await open('settings')
  const kanban = await open('kanban')
  console.log('三个窗口就绪\n')

  // 记录原始值以便还原
  const original = await evaluate(
    settings.ws,
    `window.api.invoke('settings:get').then(r => r.data)`
  )

  // ── 1. 悬浮球尺寸：设置窗口改 → 悬浮球窗口变 ──
  console.log('[1] 悬浮球尺寸跨窗口同步')
  await evaluate(settings.ws, `
    window.api.invoke('settings:update', { floatBallSize: 64 })
  `)
  await sleep(700)
  const ballSize = await evaluate(ball.ws, `
    (() => {
      const el = document.querySelector('.rounded-full')
      if (!el) return null
      const r = el.getBoundingClientRect()
      return Math.round(r.width)
    })()
  `)
  check('设置窗口改 64 → 悬浮球实际 64px', ballSize === 64, `实测 ${ballSize}px`)

  // ── 2. 自定义颜色跨窗口同步 ──
  console.log('\n[2] 自定义颜色跨窗口同步')
  await evaluate(settings.ws, `
    window.api.invoke('settings:update', { customColors: { accent: '#FF0000' } })
  `)
  await sleep(700)
  const ballAccent = await evaluate(ball.ws, `
    getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim()
  `)
  check('设置窗口改强调色 → 悬浮球窗口 CSS 变量同步', ballAccent === '#FF0000', `悬浮球窗口 --color-accent=${ballAccent || '(空)'}`)

  const kanbanAccent = await evaluate(kanban.ws, `
    getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim()
  `)
  check('看板窗口 CSS 变量同步', kanbanAccent === '#FF0000', `看板窗口 --color-accent=${kanbanAccent || '(空)'}`)

  // ── 3. 主题跨窗口同步 ──
  console.log('\n[3] 主题跨窗口同步')
  const targetTheme = original.theme === 'dark' ? 'light' : 'dark'
  await evaluate(settings.ws, `
    window.api.invoke('settings:update', { theme: ${JSON.stringify(targetTheme)} })
  `)
  await sleep(700)
  const ballTheme = await evaluate(ball.ws, `document.documentElement.getAttribute('data-theme')`)
  const kanbanTheme = await evaluate(kanban.ws, `document.documentElement.getAttribute('data-theme')`)
  check(`设置窗口切 ${targetTheme} → 悬浮球窗口同步`, ballTheme === targetTheme, `实测 ${ballTheme}`)
  check(`设置窗口切 ${targetTheme} → 看板窗口同步`, kanbanTheme === targetTheme, `实测 ${kanbanTheme}`)

  // ── 4. 看板圆角跨窗口同步 ──
  console.log('\n[4] 看板圆角跨窗口同步')
  await evaluate(settings.ws, `
    window.api.invoke('settings:update', { kanbanBorderRadius: 26 })
  `)
  await sleep(700)
  const radius = await evaluate(kanban.ws, `
    (() => {
      const el = Array.from(document.querySelectorAll('div'))
        .find(d => d.style && d.style.borderRadius)
      return el ? el.style.borderRadius : null
    })()
  `)
  check('设置窗口改圆角 26 → 看板窗口应用', radius === '26px', `实测 ${radius ?? '(未找到)'}`)

  // ── 5. 悬浮球透明度（用户反馈：默认太透） ──
  console.log('\n[5] 悬浮球透明度表现')
  const opacityInfo = await evaluate(ball.ws, `
    (() => {
      const el = document.querySelector('.rounded-full')
      if (!el) return null
      const cs = getComputedStyle(el)
      return { cssOpacity: cs.opacity, inline: el.style.opacity, bg: cs.backgroundColor }
    })()
  `)
  console.log(`  当前样式: opacity=${opacityInfo?.cssOpacity} inline=${opacityInfo?.inline} bg=${opacityInfo?.bg}`)
  check(
    '悬浮球实际不透明度 ≥ 0.9（默认应近乎不透明）',
    parseFloat(opacityInfo?.cssOpacity ?? '0') >= 0.9,
    `实际 ${opacityInfo?.cssOpacity}`
  )

  // ── 6. 设置窗口是否具备窗口控制按钮 ──
  console.log('\n[6] 窗口控制按钮')
  const winControls = await evaluate(settings.ws, `
    (() => {
      const text = document.body.innerText
      const btns = Array.from(document.querySelectorAll('button'))
        .map(b => (b.getAttribute('aria-label') || b.textContent || '').trim())
        .filter(Boolean)
      return {
        hasMin: btns.some(t => /最小化|minimi/i.test(t)),
        hasMax: btns.some(t => /最大化|maximi/i.test(t)),
        hasClose: btns.some(t => /关闭|close/i.test(t)),
        buttons: btns.slice(0, 12)
      }
    })()
  `)
  check('设置窗口有最小化按钮', winControls.hasMin, winControls.buttons.join(' | '))
  check('设置窗口有最大化按钮', winControls.hasMax)
  check('设置窗口有关闭按钮', winControls.hasClose)

  // ── 还原 ──
  console.log('\n[7] 还原原始设置')
  await evaluate(settings.ws, `
    (async () => {
      await window.api.invoke('settings:update', {
        floatBallSize: ${original.floatBallSize},
        kanbanBorderRadius: ${original.kanbanBorderRadius},
        theme: ${JSON.stringify(original.theme)}
      })
      await window.api.invoke('settings:update', { customColors: { accent: undefined } })
      return true
    })()
  `)
  console.log('  已还原')

  // 收尾关闭必须从悬浮球窗口发起，不能让设置窗口自己调 window:hideSettings：
  // 那个 IPC 会把调用方窗口关掉，渲染进程在收到响应之前就被销毁，
  // invoke 的 promise 永不 settle，await 会永久挂住（本脚本曾因此卡死十分钟，
  // 而且所有检查其实都已经 PASS，只是最后一步下不来）。
  // 额外再套一层超时兜底。
  const withTimeout = (p, ms = 3000) =>
    Promise.race([p, new Promise((r) => setTimeout(r, ms))])

  await withTimeout(evaluate(ball.ws, `window.api.invoke('window:hideSettings')`))
  await withTimeout(evaluate(ball.ws, `window.api.invoke('window:hideKanban')`))
  ball.ws.close()
  settings.ws.close()
  kanban.ws.close()

  const failed = results.filter((r) => !r.pass)
  console.log(`\n${'─'.repeat(56)}`)
  console.log(`结果: ${results.length - failed.length}/${results.length} 通过`)
  if (failed.length) {
    console.log('失败项:')
    for (const f of failed) console.log(`  - ${f.name}`)
    process.exitCode = 1
  }
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    console.error('\n跨窗口同步测试异常:', err.message)
    process.exit(1)
  })
