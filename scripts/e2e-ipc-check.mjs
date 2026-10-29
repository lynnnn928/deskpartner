/**
 * 端到端 IPC 冒烟测试
 *
 * 通过 Chrome DevTools Protocol 连接正在运行的应用渲染进程，
 * 真实调用 window.api.invoke，验证主进程 IPC handler 的收发约定。
 *
 * 运行前提：
 *   1. 应用以 --remote-debugging-port=9222 启动
 *   2. node >= 22（需要全局 fetch 与 WebSocket）
 *
 * 用法：node scripts/e2e-ipc-check.mjs
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
      res.exceptionDetails.exception?.description ||
      res.exceptionDetails.text ||
      'JS 执行异常'
    throw new Error(desc)
  }
  return res.result.value
}

const results = []
function check(name, pass, detail) {
  results.push({ name, pass, detail })
  console.log(`${pass ? '  PASS' : '  FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

async function main() {
  const targets = await listTargets()
  const pages = targets.filter((t) => t.type === 'page')
  if (pages.length === 0) throw new Error('未发现渲染进程页面')

  console.log('发现窗口:')
  for (const p of pages) console.log(`  - ${p.title || '(无标题)'}  ${p.url}`)

  const target = pages.find((p) => p.url.includes('float-ball')) || pages[0]
  const ws = await connect(target.webSocketDebuggerUrl)
  console.log(`\n已连接: ${target.url}\n`)

  // ── 1. 读设置 ──
  console.log('[1] 读取设置')
  const original = await evaluate(ws, `
    (async () => {
      const r = await window.api.invoke('settings:get')
      return r.ok ? r.data : null
    })()
  `)
  check('settings:get 返回数据', !!original, original ? `theme=${original.theme}` : '无数据')
  const originalTheme = original?.theme
  const originalShortcut = original?.globalShortcut

  // ── 2. 新约定：裸参数写设置 ──
  console.log('\n[2] 写设置（当前约定：直接传参数）')
  const writeNew = await evaluate(ws, `
    (async () => {
      const target = ${JSON.stringify(originalTheme)} === 'dark' ? 'light' : 'dark'
      const r = await window.api.invoke('settings:update', { theme: target })
      return {
        ok: r.ok,
        sent: target,
        stored: r.data && r.data.settings ? r.data.settings.theme : null,
        warning: r.data ? (r.data.warning ?? null) : null,
        error: r.error ?? null
      }
    })()
  `)
  check(
    '裸参数写入生效（回落值 === 发送值）',
    writeNew.stored === writeNew.sent,
    `发送 ${writeNew.sent} → 落库 ${writeNew.stored}`
  )

  // ── 3. 旧约定：{ input: ... } 包装（对照） ──
  console.log('\n[3] 对照组：旧约定 {input:...} 包装')
  const writeOld = await evaluate(ws, `
    (async () => {
      const before = (await window.api.invoke('settings:get')).data.theme
      const target = before === 'dark' ? 'light' : 'dark'
      const r = await window.api.invoke('settings:update', { input: { theme: target } })
      const stored = r.data && r.data.settings ? r.data.settings.theme : null
      return { before, sent: target, stored }
    })()
  `)
  check(
    '包装写法不生效（旧约定确实是坏的）',
    writeOld.stored === writeOld.before && writeOld.stored !== writeOld.sent,
    `当前=${writeOld.before} 发送=${writeOld.sent} 落库=${writeOld.stored}`
  )

  // ── 4. 待办写入 ──
  console.log('\n[4] 待办写入')
  const todo = await evaluate(ws, `
    (async () => {
      const cats = await window.api.invoke('category:list')
      const categoryId = cats.ok && cats.data.length ? cats.data[0].id : ''
      const created = await window.api.invoke('todo:create', {
        title: 'E2E 冒烟测试待办',
        categoryId
      })
      if (!created.ok) return { error: created.error }
      const t = created.data

      const listed = await window.api.invoke('todo:list', {})
      const found = listed.ok ? listed.data.find(x => x.id === t.id) : null

      await window.api.invoke('todo:delete', { id: t.id })
      const after = await window.api.invoke('todo:list', {})
      const stillThere = after.ok ? after.data.some(x => x.id === t.id) : true

      return { title: t.title, status: t.status, foundInList: !!found, deleted: !stillThere }
    })()
  `)
  check('todo:create 标题正确落库', todo.title === 'E2E 冒烟测试待办', `落库标题="${todo.title}"`)
  check('todo:list 能查到新建项', todo.foundInList === true)
  check('todo:delete 删除生效', todo.deleted === true)

  // ── 5. 分类查询 ──
  console.log('\n[5] 分类')
  const cats = await evaluate(ws, `
    (async () => {
      const r = await window.api.invoke('category:list')
      return { ok: r.ok, count: r.ok ? r.data.length : -1 }
    })()
  `)
  check('category:list 返回默认分类', cats.count >= 4, `共 ${cats.count} 个`)

  // ── 6. 快捷键副作用 ──
  console.log('\n[6] 全局快捷键副作用')
  const sc = await evaluate(ws, `
    (async () => {
      const r = await window.api.invoke('settings:update', { globalShortcut: 'Ctrl+Alt+F9' })
      return {
        ok: r.ok,
        stored: r.data && r.data.settings ? r.data.settings.globalShortcut : null,
        warning: r.data ? (r.data.warning ?? null) : null
      }
    })()
  `)
  check(
    '快捷键写入并落库',
    sc.stored === 'Ctrl+Alt+F9',
    `落库=${sc.stored}${sc.warning ? ` 告警=${sc.warning}` : ''}`
  )

  // ── 7. 自定义颜色 ──
  console.log('\n[7] 自定义颜色')
  const color = await evaluate(ws, `
    (async () => {
      const r1 = await window.api.invoke('settings:update', { customColors: { accent: '#FF0000' } })
      const set = r1.ok ? r1.data.settings.customColors.accent : null

      // 等待 React 副作用把颜色写入 CSS 变量
      await new Promise((r) => setTimeout(r, 400))
      const cssSet = getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim()

      const r2 = await window.api.invoke('settings:update', { customColors: { accent: undefined } })
      const cleared = r2.ok ? r2.data.settings.customColors.accent ?? null : 'ERR'
      return { set, cssSet, cleared }
    })()
  `)
  check('写自定义色生效', color.set === '#FF0000', `customColors.accent=${color.set}`)
  check('CSS 变量同步', color.cssSet === '#FF0000', `--color-accent=${color.cssSet}`)
  check('传 undefined 可清除该项', color.cleared === null, `清除后=${color.cleared}`)

  // ── 还原 ──
  console.log('\n[8] 还原原始设置')
  await evaluate(ws, `
    (async () => {
      await window.api.invoke('settings:update', { theme: ${JSON.stringify(originalTheme)} })
      await window.api.invoke('settings:update', { globalShortcut: ${JSON.stringify(originalShortcut)} })
      await window.api.invoke('settings:update', { customColors: { accent: undefined } })
      return true
    })()
  `)
  console.log('  已还原')

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

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    console.error('\n冒烟测试异常:', err.message)
    process.exit(1)
  })
