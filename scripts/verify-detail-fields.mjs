/**
 * 验证详细版任务字段（描述 / 优先级 / 截止时间）的端到端链路
 *
 *   1. 数据库迁移执行到位，新列存在
 *   2. 带详细字段创建 → 落库 → 读回一致
 *   3. 更新（含清空）语义正确：undefined 保持原值，null 清空
 *   4. 非法优先级被主进程拒绝
 *   5. 看板卡片渲染优先级色点与截止时间
 *
 * 用法：node scripts/verify-detail-fields.mjs
 * 前置：electron-vite dev -- --remote-debugging-port=9222 已在跑
 */
const CDP_PORT = Number(process.env.CDP_PORT || 9222)
const OUT_DIR = process.env.OUT_DIR || '.tmp-check/screenshots'
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
    ws.onerror = () => rej(new Error('WebSocket 失败'))
  })
  return ws
}

function makeSession(ws) {
  const send = (method, params, timeoutMs = 15000) =>
    new Promise((res, rej) => {
      const id = ++msgId
      const timer = setTimeout(() => {
        ws.removeEventListener('message', h)
        rej(new Error(`CDP 超时(${timeoutMs}ms): ${method}`))
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
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', {
      expression: expr,
      awaitPromise: true,
      returnByValue: true
    })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'JS 异常')
    return r.result.value
  }
  return { send, evaluate }
}

let failures = 0
function report(label, ok, detail) {
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`)
}

async function main() {
  const { mkdirSync, writeFileSync } = await import('node:fs')

  const ball = (await targets()).find((p) => p.url.includes('float-ball'))
  if (!ball) throw new Error('未找到悬浮球窗口')
  const ws = await connect(ball.webSocketDebuggerUrl)
  const s = makeSession(ws)

  // ── 1. 迁移与新列 ──
  console.log('【1】数据库迁移')
  const schema = await s.evaluate(`
    (async () => {
      const cats = await window.api.invoke('category:list')
      const cid = cats.ok && cats.data.length ? cats.data[0].id : ''
      const probe = await window.api.invoke('todo:create', { title: '__SCHEMA_PROBE__', categoryId: cid })
      if (!probe.ok) return { error: probe.error }
      const got = await window.api.invoke('todo:getById', { id: probe.data.id })
      await window.api.invoke('todo:delete', { id: probe.data.id })
      if (!got.ok) return { error: got.error }
      const t = got.data
      return {
        hasDescription: 'description' in t,
        hasPriority: 'priority' in t,
        hasDueAt: 'dueAt' in t,
        defaultPriority: t.priority,
        defaultDescription: t.description,
        defaultDueAt: t.dueAt
      }
    })()
  `)
  if (schema.error) throw new Error(`迁移探测失败: ${schema.error}`)
  report('新字段 description 已暴露', schema.hasDescription)
  report('新字段 priority 已暴露', schema.hasPriority)
  report('新字段 dueAt 已暴露', schema.hasDueAt)
  report(
    '旧数据的默认值正确（normal / null / null）',
    schema.defaultPriority === 'normal' &&
      schema.defaultDescription === null &&
      schema.defaultDueAt === null,
    `priority=${schema.defaultPriority} desc=${schema.defaultDescription} due=${schema.defaultDueAt}`
  )

  // ── 2. 创建 → 落库 → 读回 ──
  console.log('【2】创建并读回详细字段')
  const due = new Date(Date.now() + 86400000).toISOString()
  const created = await s.evaluate(`
    (async () => {
      const cats = await window.api.invoke('category:list')
      const cid = cats.ok && cats.data.length ? cats.data[0].id : ''
      const r = await window.api.invoke('todo:create', {
        title: '__DETAIL_TEST__',
        description: '这是一段详细描述',
        priority: 'urgent',
        dueAt: ${JSON.stringify(due)},
        categoryId: cid
      })
      return r.ok ? r.data.id : null
    })()
  `)
  report('带详细字段创建成功', !!created)
  if (!created) {
    ws.close()
    return
  }

  const got = await s.evaluate(
    `(async () => {
      const r = await window.api.invoke('todo:getById', { id: ${JSON.stringify(created)} })
      return r.ok ? r.data : null
    })()`
  )
  report('描述读回一致', got?.description === '这是一段详细描述', `got=${JSON.stringify(got?.description)}`)
  report('优先级读回一致', got?.priority === 'urgent', `got=${got?.priority}`)
  report('截止时间读回一致', !!got?.dueAt, `got=${got?.dueAt}`)

  // ── 3. 更新语义 ──
  console.log('【3】更新语义（undefined 保持 / null 清空）')
  const afterKeep = await s.evaluate(
    `(async () => {
      // 不传 description/priority/dueAt → 应保持原值
      const r = await window.api.invoke('todo:update', { id: ${JSON.stringify(created)}, title: '__DETAIL_TEST__' })
      return r.ok ? r.data : null
    })()`
  )
  report(
    '未提及的字段保持原值',
    afterKeep?.description === '这是一段详细描述' && afterKeep?.priority === 'urgent',
    `desc=${JSON.stringify(afterKeep?.description)} pri=${afterKeep?.priority}`
  )

  const afterClear = await s.evaluate(
    `(async () => {
      // 显式传 null → 应清空
      const r = await window.api.invoke('todo:update', { id: ${JSON.stringify(created)}, description: null, dueAt: null })
      return r.ok ? r.data : null
    })()`
  )
  report(
    '显式 null 清空字段',
    afterClear?.description === null && afterClear?.dueAt === null,
    `desc=${JSON.stringify(afterClear?.description)} due=${JSON.stringify(afterClear?.dueAt)}`
  )

  // ── 4. 非法优先级 ──
  console.log('【4】非法输入防护')
  const bad = await s.evaluate(
    `(async () => {
      const r = await window.api.invoke('todo:update', { id: ${JSON.stringify(created)}, priority: 'p1' })
      return r.ok ? 'accepted' : (r.error || 'rejected')
    })()`
  )
  report('非法优先级被拒绝', bad !== 'accepted', `返回=${String(bad).slice(0, 60)}`)

  // ── 5. 卡片渲染 ──
  console.log('【5】卡片渲染')
  // 造一条 urgent + 明天截止的待办供看板展示，结束后删除
  const cardTodo = await s.evaluate(`
    (async () => {
      const cats = await window.api.invoke('category:list')
      const cid = cats.ok && cats.data.length ? cats.data[0].id : ''
      const r = await window.api.invoke('todo:create', {
        title: '__CARD_RENDER_PROBE__ 看板渲染探针',
        priority: 'urgent',
        dueAt: ${JSON.stringify(due)},
        categoryId: cid
      })
      return r.ok ? r.data.id : null
    })()
  `)
  await s.evaluate(`window.api.invoke('window:showKanban')`)
  await sleep(3000)
  const kan = (await targets()).find((p) => p.url.includes('kanban'))
  if (kan) {
    const kw = await connect(kan.webSocketDebuggerUrl)
    const ks = makeSession(kw)
    await sleep(800)
    const render = await ks.evaluate(`
      (() => {
        const cards = [...document.querySelectorAll('div')].filter(
          (d) => typeof d.className === 'string' && d.className.includes('cursor-grab') &&
                 d.textContent.includes('__CARD_RENDER_PROBE__')
        )
        if (!cards.length) return { found: false }
        const card = cards[0]
        const dot = card.querySelector('span[title*="优先级"]')
        const texts = card.textContent
        return {
          found: true,
          hasDot: !!dot,
          dotColor: dot ? getComputedStyle(dot).backgroundColor : null,
          hasDueText: /明天|M月D日/.test(texts)
        }
      })()
    `)
    report('卡片节点出现', render.found)
    report('urgent 优先级色点已渲染', render.hasDot, render.dotColor || '')
    report('截止时间文案已渲染', render.hasDueText)

    // 截图存档
    try {
      const shot = await ks.send('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: true
      })
      mkdirSync(OUT_DIR, { recursive: true })
      writeFileSync(`${OUT_DIR}/kanban-detail.png`, Buffer.from(shot.data, 'base64'))
      console.log(`  截图: ${OUT_DIR}/kanban-detail.png`)
    } catch (e) {
      console.log(`  截图失败(不影响结论): ${e.message}`)
    }
    kw.close()
  } else {
    report('看板窗口打开', false)
  }

  // ── 清理 ──
  for (const id of [created, cardTodo].filter(Boolean)) {
    await s.evaluate(`window.api.invoke('todo:delete', { id: ${JSON.stringify(id)} })`)
  }
  console.log('已清理测试数据')

  ws.close()
  console.log(failures === 0 ? '\n全部通过' : `\n有 ${failures} 项未通过`)
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((e) => {
    console.error('验证失败:', e.message)
    process.exit(1)
  })
