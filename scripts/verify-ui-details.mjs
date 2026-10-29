/**
 * 验证两项界面细节（走 CDP，不需要人眼看整个窗口）：
 *   1. 窗口右上角的最小化/最大化/关闭按钮是否存在且可点（有可见尺寸）
 *   2. 卡片底部「时间 ↔ 快捷操作」是否为互斥切换（悬停时替换，而非叠加）
 *
 * 用法：node scripts/verify-ui-details.mjs
 * 前置：electron-vite dev -- --remote-debugging-port=9222 已在跑
 */
const CDP_PORT = Number(process.env.CDP_PORT || 9222)
const OUT_DIR = process.env.OUT_DIR || '.tmp-check/screenshots'
let msgId = 0

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function targets() {
  return (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()).filter((t) => t.type === 'page')
}

async function connect(url) {
  const ws = new WebSocket(url)
  await new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = () => rej(new Error('WebSocket 连接失败'))
  })
  return ws
}

function makeSend(ws) {
  return (method, params, timeoutMs = 15000) =>
    new Promise((res, rej) => {
      const id = ++msgId
      const timer = setTimeout(() => {
        ws.removeEventListener('message', h)
        rej(new Error(`CDP 调用超时(${timeoutMs}ms): ${method}`))
      }, timeoutMs)
      const h = (ev) => {
        const d = JSON.parse(ev.data)
        if (d.id !== id) return
        clearTimeout(timer)
        ws.removeEventListener('message', h)
        d.error ? rej(new Error(JSON.stringify(d.error))) : res(d.result)
      }
      ws.addEventListener('message', h)
      ws.send(JSON.stringify({ id, method, params }))
    })
}

async function makeEval(send) {
  return async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'JS 异常')
    return r.result.value
  }
}

async function main() {
  const kan = (await targets()).find((p) => p.url.includes('kanban'))
  if (!kan) throw new Error('未找到看板窗口，请先打开看板')
  console.log('[1/3] 已连接看板窗口')
  const ws = await connect(kan.webSocketDebuggerUrl)
  const send = makeSend(ws)
  const ev = await makeEval(send)

  // ---------- 1. 窗口按钮 ----------
  const controls = await ev(`
    (() => {
      const wanted = ['最小化', '最大化', '关闭']
      return wanted.map((t) => {
        const b = [...document.querySelectorAll('button')].find((x) => x.title === t)
        if (!b) return { title: t, found: false }
        const r = b.getBoundingClientRect()
        return { title: t, found: true, w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y) }
      })
    })()
  `)
  console.log('【窗口按钮】')
  let controlsOk = true
  for (const c of controls) {
    const ok = c.found && c.w >= 20 && c.h >= 20
    if (!ok) controlsOk = false
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${c.title}  ${c.found ? `${c.w}x${c.h} @(${c.x},${c.y})` : '未找到'}`)
  }

  // 单独截一张顶栏右上角，便于人眼确认渲染效果
  // 注意：本机 Electron 33 / Chromium 130 下 Page.captureScreenshot 带 clip 参数会挂死（实测超时）。
  // 只能用 captureBeyondViewport 整窗截图，再由调用方裁切。
  try {
    const min = controls.find((c) => c.title === '最小化')
    if (min && min.found) {
      const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
      const { mkdirSync, writeFileSync } = await import('node:fs')
      mkdirSync(OUT_DIR, { recursive: true })
      const out = `${OUT_DIR}/window-full.png`
      writeFileSync(out, Buffer.from(shot.data, 'base64'))
      console.log(`  整窗截图已保存: ${out}`)
    }
  } catch (e) {
    console.log(`  截图失败(不影响结论): ${e.message}`)
  }

  // ---------- 2. 卡片时间/操作互斥 ----------
  // 造一条临时待办，读到卡片的底部行结构后立即删除
  const probe = await ev(`
    (async () => {
      const cats = await window.api.invoke('category:list')
      const cid = cats.ok && cats.data.length ? cats.data[0].id : ''
      const r = await window.api.invoke('todo:create', { title: '__UI_PROBE__', categoryId: cid })
      if (!r.ok) return { error: '创建失败' }
      const id = r.data.id
      await new Promise((s) => setTimeout(s, 400))

      const card = [...document.querySelectorAll('div')].find(
        (d) => d.className && typeof d.className === 'string' && d.className.includes('cursor-grab') &&
               d.textContent.includes('__UI_PROBE__')
      )
      if (!card) { await window.api.invoke('todo:delete', { id }); return { error: '未找到卡片节点' } }

      const row = card.lastElementChild
      const hasAbsoluteAction =
        !!card.querySelector('div.absolute button[title="删除"]')
      const idleText = row.textContent.trim()

      // 悬停
      card.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }))
      card.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
      await new Promise((s) => setTimeout(s, 350))
      const hoverText = row.textContent.trim()
      const hoverHasDelete = !!row.querySelector('button[title="删除"]')

      // 移出
      card.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false }))
      card.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }))
      await new Promise((s) => setTimeout(s, 350))
      const backText = row.textContent.trim()

      await window.api.invoke('todo:delete', { id })
      return { hasAbsoluteAction, idleText, hoverText, hoverHasDelete, backText }
    })()
  `)

  console.log('【卡片底部行：时间 / 操作 互斥】')
  if (probe.error) {
    console.log(`  FAIL  ${probe.error}`)
  } else {
    const noOverlap = !probe.hasAbsoluteAction
    const swapped = probe.idleText !== probe.hoverText && probe.hoverHasDelete
    const restored = probe.idleText === probe.backText
    console.log(`  ${noOverlap ? 'PASS' : 'FAIL'}  操作按钮不再绝对定位叠加 (hasAbsoluteAction=${probe.hasAbsoluteAction})`)
    console.log(`  ${swapped ? 'PASS' : 'FAIL'}  悬停切换到操作按钮 (idle="${probe.idleText}" → hover="${probe.hoverText}")`)
    console.log(`  ${restored ? 'PASS' : 'FAIL'}  移出后恢复显示时间 (back="${probe.backText}")`)
  }

  ws.close()
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((e) => {
    console.error('验证失败:', e.message)
    process.exit(1)
  })
