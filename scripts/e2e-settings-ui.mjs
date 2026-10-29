/**
 * 设置面板 UI 冒烟测试
 *
 * 通过 CDP 打开设置窗口，检查各分区是否正常渲染、
 * 新控件（取色器 / 快捷键录制）是否存在，并捕获渲染进程报错。
 *
 * 运行前提：应用以 --remote-debugging-port=9222 启动
 * 用法：node scripts/e2e-settings-ui.mjs
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
    const desc =
      res.exceptionDetails.exception?.description || res.exceptionDetails.text || 'JS 异常'
    throw new Error(desc)
  }
  return res.result.value
}

const results = []
function check(name, pass, detail) {
  results.push({ name, pass })
  console.log(`${pass ? '  PASS' : '  FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  // ── 从悬浮球窗口触发打开设置 ──
  const targets = await listTargets()
  const pages = targets.filter((t) => t.type === 'page')
  const ball = pages.find((p) => p.url.includes('float-ball'))
  if (!ball) throw new Error('未找到悬浮球窗口')

  const ballWs = await connect(ball.webSocketDebuggerUrl)
  await evaluate(ballWs, `window.api.invoke('window:showSettings')`)
  ballWs.close()
  console.log('已触发打开设置窗口，等待渲染…\n')
  await sleep(2500)

  // ── 连接设置窗口 ──
  const after = await listTargets()
  const settingsPage = after
    .filter((t) => t.type === 'page')
    .find((p) => p.url.includes('settings'))
  if (!settingsPage) throw new Error('设置窗口未出现')
  console.log(`已连接设置窗口: ${settingsPage.url}\n`)

  const ws = await connect(settingsPage.webSocketDebuggerUrl)

  // 收集运行时报错
  const consoleErrors = []
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(
        msg.params?.exceptionDetails?.exception?.description ??
          msg.params?.exceptionDetails?.text ??
          '未知异常'
      )
    }
  })
  await send(ws, 'Runtime.enable')
  await sleep(600)

  // ── DOM 检查 ──
  const report = await evaluate(
    ws,
    `(() => {
      const text = document.body.innerText
      const sections = Array.from(document.querySelectorAll('h3')).map(h => h.textContent.trim())
      const colorInputs = document.querySelectorAll('input[type=color]').length
      const colorHexInputs = document.querySelectorAll('input[type=text]').length
      const switches = document.querySelectorAll('button[role=switch]').length
      const recordBtn = Array.from(document.querySelectorAll('button'))
        .find(b => /未设置|按下组合键|Ctrl|Alt|Shift/.test(b.textContent))
      const resetBtn = Array.from(document.querySelectorAll('button'))
        .find(b => b.textContent.includes('一键还原'))
      return {
        sections,
        colorInputs,
        colorHexInputs,
        switches,
        hasRecordBtn: !!recordBtn,
        recordLabel: recordBtn ? recordBtn.textContent.trim() : null,
        hasResetBtn: !!resetBtn,
        scrollH: document.querySelector('.overflow-y-auto')?.scrollHeight ?? 0,
        textLen: text.length
      }
    })()`
  )

  const expectSections = [
    '基础预设',
    '悬浮球',
    '看板与卡片',
    '速记弹窗',
    '品牌色',
    '文字',
    '看板列底色',
    '分隔线',
    '字号与动画',
    '系统'
  ]

  console.log('渲染出的分区:')
  for (const s of report.sections) console.log(`  - ${s}`)

  const missing = expectSections.filter((s) => !report.sections.includes(s))
  check('10 个设置分区全部渲染', missing.length === 0, missing.length ? `缺失: ${missing.join('、')}` : `共 ${report.sections.length} 个`)
  check('取色器数量正确（悬浮球 1 + 自定义颜色 11）', report.colorInputs === 12, `实际 ${report.colorInputs} 个`)
  check('Hex 输入框存在', report.colorHexInputs >= 11, `${report.colorHexInputs} 个`)
  check('开关控件渲染', report.switches >= 6, `${report.switches} 个`)
  check('快捷键录制按钮存在', report.hasRecordBtn, report.recordLabel ?? '')
  check('一键还原按钮存在', report.hasResetBtn)
  check('内容可滚动（设置项未被截断）', report.scrollH > 900, `scrollHeight=${report.scrollH}`)
  check('无渲染进程异常', consoleErrors.length === 0, consoleErrors[0] ?? '')

  await evaluate(ws, `window.api.invoke('window:hideSettings')`)
  ws.close()

  const failed = results.filter((r) => !r.pass)
  console.log(`\n${'─'.repeat(56)}`)
  console.log(`结果: ${results.length - failed.length}/${results.length} 通过`)
  if (failed.length) {
    console.log('失败项:')
    for (const f of failed) console.log(`  - ${f.name}`)
    process.exitCode = 1
  }
}

main().catch((err) => {
  console.error('\nUI 冒烟测试异常:', err.message)
  process.exitCode = 1
})
