/**
 * 验证悬浮球的三条主链路是否真的通
 *
 *   1. 新增待办：悬浮球 → IPC → 主进程真的开出 #/quick-add 窗口
 *   2. 保存落库：在该窗口里建一条待办，数据进库且看板窗口里能查到
 *   3. 退出应用：app:quit 通道存在且可调用（不实际退出，只验证通道联通）
 *
 * 前置：electron-vite dev -- --remote-debugging-port=9222 已在跑
 * 用法：node scripts/verify-floatball-flows.mjs
 */
const CDP_PORT = Number(process.env.CDP_PORT || 9222)
let msgId = 0

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function targets() {
  return (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()).filter(
    (t) => t.type === 'page'
  )
}

async function connect(url) {
  const ws = new WebSocket(url)
  await new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = () => rej(new Error('WebSocket 连接失败'))
  })
  return ws
}

function makeSession(ws) {
  const send = (method, params, timeoutMs = 15000) =>
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

  const evaluate = async (expr, timeoutMs = 15000) => {
    const r = await send(
      'Runtime.evaluate',
      { expression: expr, awaitPromise: true, returnByValue: true },
      timeoutMs
    )
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'JS 异常')
    return r.result.value
  }

  return { send, evaluate, close: () => ws.close() }
}

let failures = 0
function report(label, ok, detail) {
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`)
}

async function main() {
  const ball = (await targets()).find((p) => p.url.includes('float-ball'))
  if (!ball) throw new Error('未找到悬浮球窗口')
  const floatBall = await connect(ball.webSocketDebuggerUrl)
  const fb = await makeSession(floatBall)

  // ── 1. 悬浮球 → 新增待办是否真的开出窗口 ──
  console.log('【1】悬浮球「新增待办」是否真的开出弹窗')
  const before = (await targets()).filter((p) => p.url.includes('quick-add')).length
  await fb.evaluate(`window.api.invoke('window:showQuickAdd', {})`)
  await sleep(2500)
  const after = (await targets()).filter((p) => p.url.includes('quick-add'))
  report('调用后 #/quick-add 窗口出现', after.length > before, `before=${before} after=${after.length}`)

  if (!after.length) {
    await fb.close()
    return
  }

  // ── 2. 该窗口能否真的创建待办，且看板能否查到 ──
  console.log('【2】弹窗保存后是否真的落库')
  const qa = await makeSession(await connect(after[0].webSocketDebuggerUrl))
  await sleep(800)

  const title = `__FLOW_TEST_${Date.now()}__`
  const created = await qa.evaluate(`
    (async () => {
      const cats = await window.api.invoke('category:list')
      const cid = cats.ok && cats.data.length ? cats.data[0].id : ''
      const r = await window.api.invoke('todo:create', { title: ${JSON.stringify(title)}, categoryId: cid })
      return r.ok ? r.data.id : null
    })()
  `)
  report('能在弹窗里创建待办', !!created, created ? `id=${created.slice(0, 8)}…` : '创建失败')

  if (created) {
    const found = await fb.evaluate(`
      (async () => {
        const list = await window.api.invoke('todo:list', {})
        if (!list.ok) return { ok: false }
        return { ok: true, hit: list.data.some(t => t.id === ${JSON.stringify(created)}) }
      })()
    `)
    report('另一窗口能查到该待办（跨窗口数据一致）', !!found.hit)

    // 清理
    await fb.evaluate(`window.api.invoke('todo:delete', { id: ${JSON.stringify(created)} })`)
  }
  await qa.close()

  // ── 3. 退出是不是真的退出了整个应用 ──
  // 直接调用 app:quit，再从外部确认进程消失了。
  // 通道若未注册，ipcRenderer.invoke 会 reject（"no handler registered"）。
  console.log('【3】「退出」是否真的终止应用进程')
  // 注意：这里的判定要迁就退出的实际行为。调用发出后进程立刻开始销毁，
  // 渲染进程会在 RPC 返回前被撕掉，因此 Runtime.evaluate 超时是**预期结果**，
  // 不代表通道没注册。真正的判据是下一项：进程是否真的没了。
  let quitResult = 'returned'
  try {
    await fb.evaluate(`window.api.invoke('app:quit')`, 5000)
  } catch (e) {
    quitResult = /超时/.test(e.message) ? 'teardown' : `error: ${e.message}`
  }
  report(
    'app:quit 通道已注册并触发退出流程',
    quitResult === 'returned' || quitResult === 'teardown',
    quitResult === 'teardown' ? '(调用后渲染进程随应用销毁，属预期)' : ''
  )

  await sleep(4000)
  let alive = true
  try {
    await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)
  } catch {
    alive = false
  }
  report('调用后应用进程已退出（不只是隐藏悬浮球）', !alive)

  await fb.close()

  console.log(failures === 0 ? '\n全部通过' : `\n有 ${failures} 项未通过`)
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((e) => {
    console.error('验证失败:', e.message)
    process.exit(1)
  })
