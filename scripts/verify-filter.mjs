/**
 * 验证看板的归属筛选真的生效
 *
 * 为什么必须做这一步：上一个 bug 就是「筛选控件存在、但看板从没接过线」——
 * 用户点了下拉什么也不会发生。光看截图只能证明控件在，证明不了它有用。
 *
 * 做法：真实选中「只看 AI 的」，对比选中前后各列卡片总数。
 * 前置：开发实例已用隔离目录启动（见 preview-kanban.mjs 注释）。
 */
import fs from 'node:fs'
import path from 'node:path'

const CDP_PORT = Number(process.env.CDP_PORT || 9222)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function connect() {
  const pages = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()).filter(
    (t) => t.type === 'page'
  )
  const page = pages.find((p) => p.url.includes('kanban'))
  if (!page) throw new Error('看板窗口未打开（先跑 preview-kanban.mjs）')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = () => rej(new Error('WebSocket 失败'))
  })
  let id = 0
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const my = ++id
      const timer = setTimeout(() => rej(new Error(`超时: ${method}`)), 20000)
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
  return {
    ev: async (expr) => {
      const r = await send('Runtime.evaluate', {
        expression: expr,
        awaitPromise: true,
        returnByValue: true
      })
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
      return r.result.value
    },
    send,
    close: () => ws.close()
  }
}

/** 数一下看板上实际渲染了几张卡片（列头计数之和） */
const countCards = (s) =>
  s.ev(`
    [...document.querySelectorAll('.text-label.text-text-secondary.ml-auto')]
      .map(el => parseInt(el.textContent, 10))
      .filter(n => !Number.isNaN(n))
      .reduce((a, b) => a + b, 0)
  `)

async function main() {
  const s = await connect()

  const before = await countCards(s)
  console.log(`筛选前（全部归属）卡片总数: ${before}`)

  // 归属下拉的选项应该来自数据，能看到"具体是哪个 agent"
  const ownerOptions = await s.ev(`
    (() => {
      const sel = [...document.querySelectorAll('select')][1];
      return sel ? [...sel.options].map(o => o.textContent) : [];
    })()
  `)
  console.log('归属下拉选项:', JSON.stringify(ownerOptions))

  // 第二个 select 就是归属筛选（第一个是分类）
  const changed = await s.ev(`
    (() => {
      const selects = [...document.querySelectorAll('select')];
      const owner = selects[1];
      if (!owner) return '找不到归属下拉';
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
      // 选一个具体的 agent（不再是笼统的 'agent'）
      setter.call(owner, 'agent:alice');
      owner.dispatchEvent(new Event('change', { bubbles: true }));
      return 'ok';
    })()
  `)
  if (changed !== 'ok') throw new Error(changed)
  await sleep(600)

  const after = await countCards(s)
  console.log(`选「只看 AI 的」后卡片总数: ${after}`)

  if (after > 0 && after < before) {
    console.log(`✅ 筛选生效（${before} → ${after}）`)
  } else {
    console.log(`❌ 筛选未生效（${before} → ${after}）`)
    process.exitCode = 1
  }

  // 顺手截一张筛选后的图，肉眼确认
  const shot = await s.send('Page.captureScreenshot', { format: 'png' })
  const out = path.resolve(process.cwd(), '..', 'screenshots', 'kanban-filter-agent.png')
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'))
  console.log(`截图: ${out}`)

  s.close()
}

main().catch((e) => {
  console.error('失败:', e.message)
  process.exitCode = 1
})
