/**
 * 在隔离数据目录里造样例数据，并截图看板
 *
 * 用途：做界面改动时，能立刻看到真实渲染结果 —— 而不是只靠读代码猜。
 *
 * 为什么需要隔离数据目录：打包版常驻时会持有单实例锁，开发实例起不来。
 * 用 `--user-data-dir` 指向临时目录即可并存，且不会污染真实数据。
 *
 * 前置：
 *   npx electron-vite dev -- --remote-debugging-port=9222 --user-data-dir=".tmp-check/dp-dev"
 * 用法：
 *   node scripts/preview-kanban.mjs [输出文件名]
 */
import fs from 'node:fs'
import path from 'node:path'

const CDP_PORT = Number(process.env.CDP_PORT || 9222)
const OUT = process.argv[2] || 'kanban-ui.png'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const my = ++id
      const timer = setTimeout(() => rej(new Error(`CDP 超时: ${method}`)), 30000)
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

const days = (n) => {
  const d = new Date(Date.now() + n * 86400000)
  d.setHours(18, 0, 0, 0)
  return d.toISOString()
}

async function main() {
  const ball = await session('float-ball')
  if (!ball) throw new Error('未找到悬浮球窗口，应用未就绪')

  // 清掉上一次的样例，保证每次截图内容一致
  await ball.ev(`
    (async () => {
      const r = await window.api.invoke('todo:list', {});
      const rows = (r && r.ok ? r.data : []).filter(t => t.title.startsWith('样例·'));
      for (const t of rows) await window.api.invoke('todo:delete', { id: t.id });
      return rows.length;
    })()
  `)

  /**
   * 取真实的分类 id 列表
   *
   * 必须显式传：不传会被 repo 兜底到第一个分类，造不出一石多鸟的场景。
   * v9 起传的是数组（categoryIds）。
   */
  const cats = await ball.ev(`
    (async () => {
      const r = await window.api.invoke('category:list');
      return r.ok ? r.data.map(c => c.id) : [];
    })()
  `)
  if (!cats.length) throw new Error('库里没有分类，无法造样例数据')

  /**
   * 混入多个 agent 的归属 + 多标签，用来验证：
   * - 归属下拉是不是动态列出**具体是哪个 agent**（而不是笼统的"AI"）
   * - 卡片能不能显示多个标签
   */

  const samples = [
    { title: '样例·整理周五的汇报材料', status: 'todo', priority: 'high', dueAt: days(2) },
    {
      title: '样例·回复张总的邮件',
      status: 'todo',
      dueAt: days(-1),
      owner: 'agent:alice',
      // 两个标签：验证"一石多鸟"在卡片上的呈现
      categoryIds: cats.slice(0, 2)
    },
    {
      title: '样例·排查登录超时问题',
      status: 'in_progress',
      priority: 'urgent',
      owner: 'agent:qwen'
    },
    {
      title: '样例·等设计稿确认后再动',
      status: 'suspended',
      owner: 'agent:codex',
      categoryIds: cats.slice(0, 3)
    },
    { title: '样例·已完成的示例条目', status: 'done', owner: 'agent:alice' }
  ].map((s) => ({ categoryIds: s.categoryIds ?? [cats[0]], ...s }))

  // 逐条创建并**检查返回**：造数据失败却继续截图，会得到一张空看板，
  // 让人误以为"改动没生效"，比直接报错更难排查
  let created = 0
  for (const s of samples) {
    const r = await ball.ev(
      `(async () => {
        const res = await window.api.invoke('todo:create', ${JSON.stringify(s)});
        return res.ok ? 'ok' : ('FAIL: ' + JSON.stringify(res.error ?? res));
      })()`
    )
    if (r === 'ok') {
      created++
    } else {
      console.error(`  创建「${s.title}」失败 → ${r}`)
    }
  }
  console.log(`已造 ${created}/${samples.length} 条样例数据`)

  // 确认真的落库了，再去看界面
  const total = await ball.ev(`
    (async () => {
      const r = await window.api.invoke('todo:list', {});
      return r.ok ? r.data.length : -1;
    })()
  `)
  console.log(`库中待办总数: ${total}`)

  await ball.ev(`window.api.invoke('window:showKanban')`)
  await sleep(4500)

  const kanban = await session('kanban')
  if (!kanban) throw new Error('看板窗口未打开')
  await sleep(1500)

  const shot = await kanban.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true
  })
  const outPath = path.resolve(process.cwd(), '..', 'screenshots', OUT)
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, Buffer.from(shot.data, 'base64'))
  console.log(`截图已保存: ${outPath}`)

  kanban.close()
  ball.close()
}

main().catch((e) => {
  console.error('失败:', e.message)
  process.exitCode = 1
})
