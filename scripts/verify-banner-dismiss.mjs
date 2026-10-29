/**
 * 验证「事情处理完了，顶部横幅就得收」（1.0.65）
 *
 * 用法：node scripts/verify-banner-dismiss.mjs
 *
 * ── 为什么必须真机验，不能只靠闸门测试 ──
 *
 * 闸门（tests/main/windows/banner-dismiss-wiring.test.ts）只能证明
 * **代码里接了线**；它证明不了"线接通之后横幅真的会消失"。
 * 而这条缺陷的形态恰恰是"看起来接了线、实际没生效"：
 *
 *   ①`agent:setApproved` 的 `hideReminderBanners()` 被调用了吗 → 闸门管得着
 *   ②`w.hide()` 之后那个窗口真的不显示了 → 只有真机能答
 *   ③`showReused` 分支（窗口复用）换内容后，人**看见的**是新内容吗 → 只有真机能答
 *
 * 主用户报的缺陷同时踩了②③：横幅写着「Carol 已接入，等你批准写入」、
 * 而审批页里等着的是另一条申请，且批完了横幅还挂在屏幕最上层。
 *
 * ── 怎么验"真的收起来了" ──
 *
 * 用 **page visibility**：Electron 的 `BrowserWindow.hide()` 会让渲染进程
 * 收到 `visibilitychange`、`document.visibilityState` 变成 'hidden'。
 * 这是"窗口还在、但没显示"的**唯一可远程读到的信号**
 *（CDP 的 target 列表在 hide 之后依然列着这个 page，看不出可见性）。
 *
 * 但单一信号可能是"恒为 hidden"的假信号 —— 那样"批准后是 hidden"就等于白验。
 * 所以做**往返对照**：
 *   弹横幅 → 必须 visible（证信号不是死的）
 *   批准   → 必须 hidden（这才是要验的）
 *   再弹一条 → 必须又 visible（证 hidden 不是一次性状态）
 * 三个点连起来，才能说"我看的这个信号真的跟着显示/隐藏走"。
 *
 * ── 为什么跑在副本上 ──
 *
 * 要走完"注册身份 → 弹横幅 → 批准"整条链，必须**真的注册一个身份**
 * 并**真的改它的 approved**。在真实库上做这件事就是在改她的成员名册，
 * 所以整个流程跑在 `withIsolatedApp` 的一次性副本上（副本不删，下轮覆盖）。
 *
 * ⚠️ 横幅窗口的坐标来自 `screen.getPrimaryDisplay()`，**没有可覆盖的入口**，
 * 所以这一轮验证期间屏幕上**真的会闪一下那条红色横幅**（约十几秒、不抢焦点）。
 * 这是这条验证的已知代价 —— 也因此**不放进 `npm run verify` 的常规清单**，
 * 需要验横幅时单独跑。
 */
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { withIsolatedApp } from './lib/isolated-app.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP_DIR = join(HERE, '..')
const LAUNCHER = join(APP_DIR, 'out', 'cli', 'deskpartner.cjs')
const PORT = Number(process.env.CDP_PORT || 9476)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let failures = 0
function report(label, ok, detail) {
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`)
}
// ── CDP 小工具（只看一个 page target，用完关连接） ──

const pagesOf = async (port) =>
  (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).filter((t) => t.type === 'page')

const findPage = async (port, needle) =>
  (await pagesOf(port)).find((p) => p.url.includes(needle)) ?? null

async function evalOn(port, needle, expr) {
  const page = await findPage(port, needle)
  if (!page) throw new Error(`未找到窗口: ${needle}`)
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = () => rej(new Error('WebSocket 连接失败'))
  })
  try {
    const result = await new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error('CDP 求值超时')), 20000)
      const h = (ev) => {
        const d = JSON.parse(ev.data)
        if (d.id !== 1) return
        clearTimeout(timer)
        ws.removeEventListener('message', h)
        d.error ? rej(new Error(JSON.stringify(d.error))) : res(d.result)
      }
      ws.addEventListener('message', h)
      ws.send(
        JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: { expression: expr, awaitPromise: true, returnByValue: true }
        })
      )
    })
    if (result?.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || '页面内异常')
    }
    return result?.result?.value
  } finally {
    ws.close()
  }
}

/** 读横幅当前状态：在不在、显示没显示、写的是什么 */
async function bannerState(port) {
  const page = await findPage(port, 'reminder-banner')
  if (!page) return { exists: false }
  try {
    const v = await evalOn(port, 'reminder-banner', `(() => ({
      state: document.visibilityState,
      text: (document.body.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 200)
    }))()`)
    return { exists: true, ...v }
  } catch (e) {
    return { exists: true, state: 'error', text: String(e.message) }
  }
}

/** 等横幅出现（窗口建起来 + 内容渲染完），超时返回 null */
async function waitBanner(port, timeoutMs = 12000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const s = await bannerState(port)
    if (s.exists && s.text) return s
    await sleep(500)
  }
  return null
}

/** 等横幅变成 hidden（hide() 是同步的，渲染侧落地要一小会儿） */
async function waitHidden(port, timeoutMs = 8000) {
  const t0 = Date.now()
  let last = null
  while (Date.now() - t0 < timeoutMs) {
    last = await bannerState(port)
    if (last.exists && last.state === 'hidden') return last
    await sleep(400)
  }
  return last
}

/**
 * 用 CLI 注册一个身份 —— 走无头通道写进**副本**。
 *
 * 无头（DESKPARTNER_NO_PIPE=1）是刻意的：带管道时它会去抢常驻真实 GUI 的管道，
 * 注册就落进她的真实库了。副本 + 无头 = 事件写进副本，副本里的 GUI 轮询到，
 * 于是横幅弹起来 —— 这正是要复现的链路。
 */
function cliRegister(dataDir, id, name) {
  const env = { ...process.env, DESKPARTNER_DATA_DIR: dataDir, DESKPARTNER_NO_PIPE: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  const r = spawnSync(process.execPath, [LAUNCHER, 'agent', 'register', '--id', id, '--name', name], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 90000,
    cwd: APP_DIR,
    env
  })
  let json = null
  try {
    json = JSON.parse(r.stdout ?? '')
  } catch {
    /* 下面按 ok=false 报 */
  }
  return { ok: Boolean(json?.ok), detail: json?.message ?? (r.stdout || '').slice(0, 120) }
}

await withIsolatedApp(
  async ({ port, dataDir }) => {
    await sleep(2500)

    const ID_A = 'agent:__banner_probe_a__'
    const ID_B = 'agent:__banner_probe_b__'
    const ID_C = 'agent:__banner_probe_c__'
    const NAME_A = '横幅探针甲'
    const NAME_B = '横幅探针乙'
    const NAME_C = '横幅探针丙'

    // 看板窗口：`agent:setApproved` 只允许 /settings、/kanban、/reminder-banner 调
    await evalOn(port, 'float-ball', `window.api.invoke('window:showKanban')`)
    await sleep(3000)
    report('看板窗口已就绪（批准动作要由它发起）', Boolean(await findPage(port, 'kanban')))

    // ── 第一次弹横幅 ──
    console.log('\n【1】注册身份 → 横幅弹出')
    const ra = cliRegister(dataDir, ID_A, NAME_A)
    report('CLI 注册甲成功（事件写进副本）', ra.ok, ra.detail)

    const s1 = await waitBanner(port)
    report('顶部横幅已弹出', Boolean(s1))
    if (!s1) {
      console.log('\n横幅没弹出来，后续无从验起。先确认：副本里的 GUI 在跑、事件轮询没停。')
      process.exitCode = 1
      return
    }
    report('横幅写的是刚注册的甲', s1.text.includes(NAME_A), s1.text)
    report('横幅处于显示状态（这个信号是活的）', s1.state === 'visible', `visibilityState=${s1.state}`)

    // ── 复用的那条路：再注册一个，横幅必须换内容 ──
    console.log('\n【2】横幅复用窗口 → 内容必须换成新的')
    const rb = cliRegister(dataDir, ID_B, NAME_B)
    report('CLI 注册乙成功', rb.ok, rb.detail)

    let s2 = null
    {
      const t0 = Date.now()
      while (Date.now() - t0 < 12000) {
        s2 = await bannerState(port)
        if (s2.exists && s2.text.includes(NAME_B)) break
        await sleep(500)
      }
    }
    report('横幅内容跟着换成了乙', Boolean(s2?.text?.includes(NAME_B)), s2?.text)
    report('没有停在旧内容（甲）上', !String(s2?.text ?? '').includes(NAME_A), s2?.text)

    // ── 这条才是本次要验的：批准身份之后横幅必须收 ──
    console.log('\n【3】批准身份 → 横幅必须收起来')
    const approved = await evalOn(
      port,
      'kanban',
      `(async () => {
        const r = await window.api.invoke('agent:setApproved', { id: ${JSON.stringify(ID_B)}, approved: true })
        return r.ok ? { ok: true, approved: r.data?.approved } : { ok: false, err: r.error || r.message }
      })()`
    )
    report('批准动作执行成功', Boolean(approved?.ok), JSON.stringify(approved))

    const s3 = await waitHidden(port)
    report(
      '横幅已收起（visibilityState=hidden）',
      s3?.state === 'hidden',
      `visibilityState=${s3?.state}｜文字：${String(s3?.text ?? '').slice(0, 60)}`
    )

    // ── 对照：再弹一条，证 hidden 不是死状态 ──
    console.log('\n【4】对照 —— 再注册一个，横幅应当能再次弹出来')
    const rc = cliRegister(dataDir, ID_C, NAME_C)
    report('CLI 注册丙成功', rc.ok, rc.detail)

    let s4 = null
    {
      const t0 = Date.now()
      while (Date.now() - t0 < 12000) {
        const cur = await bannerState(port)
        if (cur.exists && cur.state === 'visible' && cur.text.includes(NAME_C)) {
          s4 = cur
          break
        }
        s4 = cur
        await sleep(500)
      }
    }
    report('横幅重新显示且是丙', s4?.state === 'visible' && Boolean(s4?.text?.includes(NAME_C)), `${s4?.state}｜${String(s4?.text ?? '').slice(0, 60)}`)

    // 收尾：别把横幅留在屏幕最上层
    await evalOn(port, 'reminder-banner', `window.api.invoke('window:hideReminderBanner')`).catch(() => {})

    console.log(failures === 0 ? '\n全部通过' : `\n有 ${failures} 项未通过`)
  },
  { port: PORT }
).catch((e) => {
  console.error('验证失败:', e.message)
  process.exitCode = 1
  failures++
})

if (failures) process.exitCode = 1
