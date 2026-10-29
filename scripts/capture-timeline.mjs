/**
 * 变更记录（详情抽屉）的视觉验证（1.0.62）
 *
 * 用法：node scripts/capture-timeline.mjs [输出目录]
 *
 * ── 为什么不能只看断言 ──
 *
 * 断言能证明"界面读得出这条数据"，但证明不了**它长得对不对** ——
 * 主用户这轮选 ② 的理由原话是「我并不急着用，重要的还是体验的完整性」。
 * 数据接通了但排版散、时间戳把行挤破，断言全绿也是白搭。
 *
 * 所以这里做两件事：
 *   ① 造一条有真实因果链的事项（改规格 → 动手 → 删评论 → 转验收），截下抽屉
 *   ② 量一遍渲染后的**实际几何**（行数、横向溢出、行高、时间列是否稳定），
 *      补上"长得对不对"这一层
 *
 * ── 它怎么造出 agent 动作 ──
 *
 * 界面路径的 `todo:update` 在主进程侧硬写 `actor: 'human'`（防伪造），
 * 界面上**造不出** agent actor。所以脚本额外用 CLI（`out/cli/deskpartner.cjs`，
 * 带 `DESKPARTNER_AGENT`）给同一条事项推一次状态 —— 这样"变更记录里 agent
 * 显示成「Alice」还是 `agent:alice`"才真的被截图验到。
 *
 * 顺带说明：本探针"全 PASS"不等于 display 层全对 —— 截图暴露过两个
 * 断言抓不到的问题（同分钟时刻重复、主体两种叫法），那才是它的价值所在。
 *
 * 跑在一次性副本上（withIsolatedApp），生产库不受影响。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { withIsolatedApp } from './lib/isolated-app.mjs'

const OUT_DIR = process.argv[2] || join(process.cwd(), '..', 'screenshots')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const APP_DIR = process.cwd()

const DESC_OLD = '第一版规格：只做 A 这一类，B 先不做'
const DESC_NEW = '第二版规格：改成以 B 为主，A 降级为兼容'
const COMMENT = '我承诺把 A 的兼容层在下一版删掉，如果删不掉这条就作废'

/** 自带 CDP 会话：求值 + 截图（withIsolatedApp 只给 evaluate，不给截图能力） */
function makeSession(ws) {
  let id = 0
  const send = (method, params, timeoutMs = 15000) =>
    new Promise((res, rej) => {
      const my = ++id
      const timer = setTimeout(() => {
        ws.removeEventListener('message', h)
        rej(new Error(`CDP 超时(${timeoutMs}ms): ${method}`))
      }, timeoutMs)
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

  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', {
      expression: expr,
      awaitPromise: true,
      returnByValue: true
    })
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'JS 异常')
    }
    return r.result.value
  }

  return { send, evaluate }
}

const listPages = async (port) =>
  (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).filter((t) => t.type === 'page')

const connect = async (url) => {
  const ws = new WebSocket(url)
  await new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = () => rej(new Error('WebSocket 失败'))
  })
  return ws
}

await withIsolatedApp(
  async ({ port, evaluate, dataDir }) => {
    await sleep(2500)

    // 造一条有真实因果链的事项。
    // 项目走界面口径（界面创建必须挂项目，1.0.38 修）—— 用已存在的第一个项目，
    // 没有就临时建一个，避免把"造数据失败"和"项目必填"混在一起报错。
    const made = await evaluate(`
      (async () => {
        let pid = null
        const ps = await window.api.invoke('project:list')
        if (ps.ok && ps.data.length) pid = ps.data[0].id
        else {
          const p = await window.api.invoke('project:create', { name: '__TIMELINE_DEMO__' })
          if (!p.ok) return { step: 'project', err: p.message || 'unknown' }
          pid = p.data.id
        }

        const t = await window.api.invoke('todo:create', {
          title: '变更记录演示：这条被改过两次、推过两步',
          description: ${JSON.stringify(DESC_OLD)},
          projectId: pid
        })
        if (!t.ok) return { step: 'create', err: t.message || 'unknown' }
        const id = t.data.id

        await window.api.invoke('todo:update', { id, description: ${JSON.stringify(DESC_NEW)} })
        await window.api.invoke('todo:update', { id, status: 'in_progress' })

        const c = await window.api.invoke('todo:addComment', {
          todoId: id, body: ${JSON.stringify(COMMENT)}
        })
        if (c.ok) await window.api.invoke('todo:deleteComment', { id: c.data.id })

        await window.api.invoke('todo:update', { id, status: 'awaiting_review' })
        return { step: 'done', id }
      })()
    `)

    if (!made || made.step !== 'done') throw new Error(`造数据失败: ${JSON.stringify(made)}`)
    console.log(`已造事项 ${made.id.slice(0, 8)}（改规格 → 动手 → 删评论 → 转验收）`)

    /**
     * 再用 **CLI** 给这条推一次状态 —— 只为造出一笔 agent 动作。
     *
     * 界面路径造不出 agent actor（主进程 `todo:update` 硬写 `actor:'human'`），
     * 所以"变更记录里 agent 叫 Alice 还是 agent:alice"只能从这里验。
     * 这正是截图该管的层：它验的是**同一 agent 在界面上是否只有一种叫法**。
     *
     * 走 `out/cli/deskpartner.cjs`（CLI 真实产物），身份与数据目录都靠环境变量
     * （`DESKPARTNER_AGENT` / `DESKPARTNER_DATA_DIR`）—— 它们没有对应的命令行参数。
     */
    const cli = spawnSync(
      process.execPath,
      [join(APP_DIR, 'out', 'cli', 'deskpartner.cjs'), 'todo', 'update', made.id, '--status', 'done'],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60000,
        cwd: APP_DIR,
        env: {
          ...process.env,
          DESKPARTNER_DATA_DIR: dataDir,
          DESKPARTNER_AGENT: 'agent:alice',
          // 走无头通道，别去抢常驻 GUI 的管道
          DESKPARTNER_NO_PIPE: '1'
        }
      }
    )
    const cliOut = `${cli.stdout || ''}${cli.stderr || ''}`.trim()
    const agentRowExpected = cli.status === 0
    console.log(`CLI 造 agent 动作：rc=${cli.status} ${cliOut.split('\n').slice(-2).join(' | ')}`)
    if (!agentRowExpected) {
      console.log('  [!] CLI 未成功，agent 换名这条本轮验不到（不做假）')
    }

    // 从界面的真实入口打开详情抽屉
    await evaluate(
      `window.api.invoke('window:showQuickAdd', { todoId: ${JSON.stringify(made.id)} })`,
      { urlPart: 'kanban' }
    )
    await sleep(2200)

    const qa = (await listPages(port)).find((p) => p.url.includes('quick-add'))
    if (!qa) throw new Error('详情抽屉窗口没出现')
    const ws = await connect(qa.webSocketDebuggerUrl)
    const s = makeSession(ws)
    await sleep(900)

    const geo = await s.evaluate(`
      (() => {
        const all = (document.body.innerText || '')
        // 标签 span 里还嵌着「N 步」那个子 span，所以外层 textContent 是
        // 「变更记录3 步」而不是「变更记录」—— 用精确相等会永远找不到（踩过）
        const candidates = [...document.querySelectorAll('span')]
          .filter(el => (el.textContent || '').includes('变更记录'))
        const label = candidates.find(el =>
          ![...el.querySelectorAll('span')].some(c => (c.textContent || '').includes('变更记录'))
        )
        if (!label) {
          return { found: false, hasLabel: all.includes('变更记录'), text: all.slice(0, 1500) }
        }
        const wrap = label.parentElement
        const rows = [...wrap.children].filter(el => el.tagName === 'DIV')
        const rect = wrap.getBoundingClientRect()
        return {
          found: true,
          rowCount: rows.length,
          wrapWidth: Math.round(rect.width),
          overflowX: wrap.scrollWidth > wrap.clientWidth + 1,
          rows: rows.map(r => {
            const rr = r.getBoundingClientRect()
            return {
              h: Math.round(rr.height),
              spans: [...r.querySelectorAll('span')].map(sp => ({
                w: Math.round(sp.getBoundingClientRect().width),
                text: (sp.textContent || '').slice(0, 30)
              }))
            }
          })
        }
      })()
    `)

    if (!geo.found) {
      console.log('抽屉正文（诊断）：')
      console.log(geo.text || '(空)')
      throw new Error(
        `详情抽屉里没有「变更记录」这一块（页面上是否出现该字样：${geo.hasLabel}）`
      )
    }

    console.log(`变更记录：${geo.rowCount} 行，块宽 ${geo.wrapWidth}px，横向溢出=${geo.overflowX}`)
    for (const [i, r] of geo.rows.entries()) {
      const timeW = r.spans[0]?.w ?? 0
      console.log(`  行${i} 高${r.h}px  首列${timeW}px  「${r.spans.map((x) => x.text).join(' | ')}」`)
    }

    const shot = await s.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true
    })
    mkdirSync(OUT_DIR, { recursive: true })
    const out = join(OUT_DIR, 'timeline-quickadd.png')
    writeFileSync(out, Buffer.from(shot.data, 'base64'))
    console.log('已保存:', out)
    ws.close()

    // 几何断言：这一层验的是"长得对不对"，不是"数据有没有"
    const problems = []
    if (geo.rowCount < 3) problems.push(`只有 ${geo.rowCount} 行，因果链没完整展示`)
    if (geo.overflowX) problems.push('块内横向溢出（长文本没换行）')
    for (const [i, r] of geo.rows.entries()) {
      if (r.h < 14) problems.push(`行${i} 高度只有 ${r.h}px，文字可能被裁`)
    }

    /**
     * 同一主体只能有一种叫法 —— 截图这层唯一能抓的形态。
     *
     * 这是本轮反复了三回的病：先是「我」vs「Alex」、再是
     * `agent:alice` vs「Alice」。断言抓不到"叫法难看"，
     * 但**抓得到"同一屏里两种叫法并存"**。
     */
    const allText = geo.rows.flatMap((r) => r.spans.map((s) => s.text)).join(' ')
    if (allText.includes('agent:')) {
      problems.push(`变更记录里出现了原始身份 token（应显示为显示名）：${allText.match(/agent:\w+/)?.[0]}`)
    }
    if (agentRowExpected && !allText.includes('Alice')) {
      problems.push('造了 agent 动作，但变更记录里没有出现「Alice」')
    }

    if (problems.length) {
      console.log('\n视觉问题：')
      for (const p of problems) console.log(`  · ${p}`)
      process.exitCode = 1
    } else {
      console.log('\nPASS 变更记录渲染正常：行数够、无横向溢出、行高不塌、主体叫法唯一')
    }
  },
  { port: 9483 }
)
