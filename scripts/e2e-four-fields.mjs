/**
 * 一次性跑完「起应用 → CDP 验证四字段 → 关应用」
 *
 * 为什么要把启动也包进来：本项目窗口是透明置顶层，且持有单实例锁。
 * 分开跑的话，上一轮起的实例会持有锁，下一轮直接 quit。
 * 放在同一个进程里能确保"验证完就带走"，不留残留实例。
 *
 * 用法：node scripts/e2e-four-fields.mjs
 */
import http from 'node:http'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const PORT = 9333
const ELECTRON = path.join(ROOT, 'node_modules/electron/dist/electron.exe')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function httpGet(p, port = PORT) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: p }, (res) => {
      let s = ''
      res.on('data', (d) => (s += d))
      res.on('end', () => {
        try {
          resolve(JSON.parse(s))
        } catch {
          reject(new Error('非 JSON: ' + s.slice(0, 150)))
        }
      })
    })
    req.on('error', reject)
    req.end()
  })
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    ws.onopen = () => resolve(ws)
    ws.onerror = () => reject(new Error('WebSocket 连接失败'))
  })
}

let msgId = 0
function send(ws, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId
    const onMessage = (e) => {
      const msg = JSON.parse(e.data)
      if (msg.id !== id) return
      ws.removeEventListener('message', onMessage)
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
    }
    ws.addEventListener('message', onMessage)
    ws.send(JSON.stringify({ id, method, params }))
    setTimeout(() => {
      ws.removeEventListener('message', onMessage)
      reject(new Error('CDP 超时: ' + method))
    }, 15000)
  })
}

async function evaluate(ws, expression) {
  const r = await send(ws, 'Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  })
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description || '求值异常')
  }
  return r.result.value
}

const results = []
const check = (name, pass, detail) => {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? '  --  ' + detail : ''}`)
}

async function waitForCDP(timeoutMs = 40000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try {
      await httpGet('/json/version')
      return true
    } catch {
      await sleep(500)
    }
  }
  return false
}

async function main() {
  console.log('启动应用（独立 CDP 端口 ' + PORT + '）...')

  const env = { ...process.env }
  // 这个环境注入的 ELECTRON_RUN_AS_NODE 会让 electron.exe 退化成纯 Node，
  // 报 "Cannot read properties of undefined (reading 'requestSingleInstanceLock')"
  delete env.ELECTRON_RUN_AS_NODE

  const app = spawn(
    ELECTRON,
    ['.', '--disable-gpu', '--disable-software-rasterizer', '--no-sandbox', '--remote-debugging-port=' + PORT],
    { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'pipe'] }
  )

  let appLog = ''
  app.stderr.on('data', (d) => (appLog += d.toString()))

  const kill = () => {
    try {
      app.kill('SIGKILL')
    } catch {
      /* 已退出 */
    }
  }

  const ready = await waitForCDP()
  if (!ready) {
    kill()
    throw new Error('CDP 未就绪。应用输出:\n' + appLog.slice(-800))
  }
  console.log('CDP 就绪\n')

  const targets = await httpGet('/json/list')
  const page =
    targets.find((t) => t.type === 'page' && (t.url || '').includes('localhost')) ||
    targets.find((t) => t.type === 'page')
  if (!page) {
    kill()
    throw new Error('没有可用的页面目标')
  }

  const ws = await connect(page.webSocketDebuggerUrl)
  await send(ws, 'Runtime.enable')

  check('渲染层 preload 已挂载', await evaluate(ws, '!!window.api'))

  const projList = await evaluate(ws, 'window.api.invoke("project:list")')
  check('project:list 通道可用', projList?.ok === true, `现有 ${projList?.data?.length ?? 0} 个项目`)

  const mk = await evaluate(
    ws,
    `(async () => {
      const PN = '__e2e项目__';
      let ps = await window.api.invoke('project:list');
      let p = (ps.data || []).find(x => x.name === PN);
      if (!p) p = (await window.api.invoke('project:create', { name: PN, color: '#5388F6' })).data;
      const cats = await window.api.invoke('category:list');
      const t = await window.api.invoke('todo:create', {
        title: '__e2e·带四字段__',
        description: 'agent 写的说明，人应能在卡片上看到摘要',
        projectId: p.id,
        categoryIds: [cats.data[0].id],
        owner: 'agent:e2ebot'
      });
      return { project: p, todo: t };
    })()`
  )

  const todo = mk?.todo?.data
  check('待办建成', !!todo, todo ? 'id=' + todo.id.slice(0, 8) : 'error=' + (mk?.todo?.error || ''))

  if (todo) {
    check('项目字段写入', todo.projectId === mk.project.id, todo.projectId?.slice(0, 8))
    check('处理人字段写入', todo.owner === 'agent:e2ebot', todo.owner)
    check('描述字段写入', !!todo.description, (todo.description || '').slice(0, 16) + '...')

    const child = await evaluate(
      ws,
      `window.api.invoke('todo:create', {
        title: '__e2e·子任务__',
        projectId: ${JSON.stringify(todo.projectId)},
        parentId: ${JSON.stringify(todo.id)},
        owner: 'human'
      })`
    )
    check('父需求字段写入', child?.data?.parentId === todo.id, child?.data?.parentId?.slice(0, 8))
    check('子任务继承项目', child?.data?.projectId === todo.projectId)

    const back = await evaluate(
      ws,
      `window.api.invoke('todo:getById', { id: ${JSON.stringify(todo.id)} })`
    )
    const b = back?.data
    check(
      '回读一致(真的落库)',
      !!b && b.projectId === todo.projectId && b.owner === 'agent:e2ebot' && !!b.description,
      `project=${!!b?.projectId} owner=${b?.owner} desc=${!!b?.description}`
    )

    const upd = await evaluate(
      ws,
      `window.api.invoke('todo:update', { id: ${JSON.stringify(todo.id)}, owner: 'human', projectId: null })`
    )
    check(
      '更新可改归属',
      upd?.data?.owner === 'human' && upd?.data?.projectId === null,
      `owner=${upd?.data?.owner} project=${upd?.data?.projectId}`
    )
  }

  const clean = await evaluate(
    ws,
    `(async () => {
      const all = await window.api.invoke('todo:list', {});
      const junk = (all.data || []).filter(t => t.title.startsWith('__e2e'));
      for (const t of junk) await window.api.invoke('todo:delete', { id: t.id });
      const ps = await window.api.invoke('project:list');
      const pj = (ps.data || []).find(x => x.name === '__e2e项目__');
      if (pj) await window.api.invoke('project:delete', { id: pj.id });
      return junk.length;
    })()`
  )
  check('测试数据已清理', clean >= 2, `删除 ${clean} 条`)

  ws.close()
  kill()

  const failed = results.filter((r) => !r.pass).length
  console.log(`\n${results.length - failed}/${results.length} 通过`)
  return failed
}

main()
  .then((failed) => process.exit(failed ? 1 : 0))
  .catch((e) => {
    console.error('异常:', e.message)
    process.exit(1)
  })
