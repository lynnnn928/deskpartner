#!/usr/bin/env node
/**
 * 统一演示数据造数脚本 —— 官网、社媒、CHANGELOG 的截图**都从这一份数据出**
 *
 * ── 为什么要有它 ──
 * 以前的截图各自造数：官网一套（独立播客助手 / 文献知识库整理 / 个人主页改版）、
 * 小红书一套（山海 / 播客剪辑助手）、产品介绍卡片又是一套（青禾 / 移动端）。
 * 结果是同一个人看到的三组图，项目名、事项、助手名全不一样 —— 每次做任务都"换一套图"。
 * 现在固定成一份：三个项目、八条不同状态的事项、一条带图评论、一条待审批记录。
 *
 * ── 数据长什么样 ──
 * 主用户 Alex；两个助手 Claude 与 Codex；项目「独立播客助手」（有内容）、
 * 「文献知识库整理」「个人主页改版」（空项目，让侧栏像个真实工作区）。
 * 事项铺满 待确认 / 待办 / 进行中 / 待验收 / 已结束 五个状态，
 * 「独立播客助手」的接手说明写的是真实事项短号，审批页有一条待采纳的提议。
 *
 * ⚠️ 两个助手叫 Claude / Codex 而不是内部代号：公开仓库的脱敏闸门
 * （tests/main/cli/public-repo-sanitization-9aee52ce.test.ts）不允许内部代号
 * 以任何形式出现在受控文件里，而这个脚本是要入库的。
 *
 * ── 怎么用 ──
 *   node scripts/demo-seed.mjs --data-dir .tmp-check/demo-xxxx/data
 *
 *   参数：
 *     --data-dir <dir>   必填。演示实例的数据目录（会被清空重建，别指到真实数据目录）
 *     --cdp-port <n>     仅 --keep-open 时有用，调试端口，默认 9491
 *     --keep-open        造完不关实例，方便直接连 CDP 看现场（默认关掉）
 *
 * ── 它会做什么（顺序有讲究）──
 *   1. 先清后建：只清数据目录里**属于这个产品的**文件（user.db*、attachments、凭据）
 *   2. 起一次无头 CLI 把库建出来（迁移链跑完），再把窗口坐标预置到屏幕外
 *   3. 起隔离实例（窗口在屏幕外），走**界面 IPC** 造人侧数据：
 *      批准两个助手、设人名、建项目/标签/事项
 *   4. 走 **CLI（真实身份 + 真实凭据）** 造 agent 侧数据：交付说明、带图评论、接手说明提议
 *   5. 回界面写人侧的验收意见，落一份 demo-ids.json，收工
 *
 *   为什么人侧走 IPC、agent 侧走 CLI：产品里"人的写入"就是从界面来的，而
 *   非交互 CLI 对人身份是**拒写**的（identity_required）—— 想绕过只能伪装成
 *   终端交互，那等于把这个闸门关掉。agent 侧则相反：真实身份 + 凭据 + 人已批准，
 *   走 CLI 才是它平时干活的样子。
 *
 * 重复执行：每次都先清后建，所以跑几遍得到的都是同一份数据（id 会变，内容不变）。
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const LAUNCHER = join(ROOT, 'out', 'cli', 'deskpartner.cjs')

// ── 演示数据（改这里就是改所有截图） ──────────────────────────────────────────

const HUMAN = 'Alex'

/** 主执行/交付的助手与第二助手。颜色取产品的主色与成功色 */
const LEAD = 'agent:codex'
const PEER = 'agent:claude'
const AGENTS = [
  { id: LEAD, name: 'Codex', color: '#5388F6' },
  { id: PEER, name: 'Claude', color: '#10B981' }
]

const PROJECTS = [
  { name: '独立播客助手', color: '#5388F6', sortOrder: 1 },
  { name: '文献知识库整理', color: '#10B981', sortOrder: 2 },
  { name: '个人主页改版', color: '#F59E0B', sortOrder: 3 }
]

const CATEGORIES = [
  { name: '需求', color: '#5388F6' },
  { name: 'Bug', color: '#EF4444' },
  { name: '设计', color: '#8B5CF6' }
]

/**
 * 八条事项，key 用来在脚本里互相引用（接手说明引短号、评论挂在哪条上）。
 *
 * 状态分布是刻意的：待确认 2 / 待办 2 / 进行中 1 / 待验收 1 / 已结束 2 ——
 * 看板一屏四列都有卡，不会出现空列。
 */
const TODOS = [
  {
    key: 'summary-count',
    title: '方案选型：章节摘要默认生成 3 条还是 5 条？',
    status: 'proposed',
    category: '需求',
    type: 'feature',
    priority: 'normal',
    createdBy: LEAD,
    executedBy: LEAD,
    due: '18:00'
  },
  {
    key: 'chapter-cards',
    title: '提议：自动提取每期播客的时间轴章节与金句卡片',
    status: 'proposed',
    category: '需求',
    type: 'feature',
    priority: 'normal',
    createdBy: PEER,
    executedBy: PEER,
    due: '18:00'
  },
  {
    key: 'rss-offline',
    title: '补齐 RSS 订阅源离线缓存与断点续传',
    status: 'todo',
    category: '需求',
    type: 'feature',
    priority: 'high',
    createdBy: 'human',
    executedBy: LEAD,
    due: '18:00'
  },
  {
    key: 'glossary',
    title: '整理第 12 期访谈逐字稿的专有名词对照表',
    status: 'todo',
    category: '需求',
    type: 'task',
    priority: 'normal',
    createdBy: PEER,
    executedBy: PEER,
    due: '18:00'
  },
  {
    key: 'waveform',
    title: '实现音频波形预览组件与双倍速快捷键',
    status: 'in_progress',
    category: '需求',
    type: 'feature',
    priority: 'high',
    createdBy: 'human',
    executedBy: LEAD,
    due: '18:00'
  },
  {
    key: 'timestamp-offset',
    title: '修复长音频导出 Markdown 笔记时时间戳偏移 2 秒的问题',
    status: 'in_progress',
    category: 'Bug',
    type: 'bug',
    priority: 'urgent',
    createdBy: PEER,
    executedBy: LEAD,
    fixedInVersion: '0.4.2',
    description: '采样率转换时统一按毫秒对齐，避免整数秒截断带来的累计偏移。',
    /** 这条会被 LEAD 交付到「待验收」，再挂交付说明与验收截图 */
    deliver: true
  },
  {
    key: 'rss-skeleton',
    title: '接入 RSS 解析与本地缓存的骨架',
    status: 'done',
    category: '需求',
    type: 'feature',
    priority: 'normal',
    createdBy: 'human',
    executedBy: LEAD
  },
  {
    key: 'rich-text',
    title: '统一转写结果的富文本渲染',
    status: 'done',
    category: '设计',
    type: 'task',
    priority: 'normal',
    createdBy: 'human',
    executedBy: 'human'
  }
]

/** 交付说明（四段式，产品里验收就看这四段） */
const DELIVERY = `【做了什么】导出时不再按整秒截断，改成按采样点换算后统一取毫秒；顺带把章节时间轴与正文里的引用对齐到同一套时间基准。
【验证】拿第 12 期（42 分钟、48 kHz）反复导出 6 次，时间戳与播放器里的显示逐条比对；另外补了 3 条用例覆盖跨小时音频与变速播放后的导出。
【什么算通过】导出的 Markdown 里每条时间戳点开都能跳到对应的音频位置，误差在 1 秒以内；连续导出两次结果一致。
【取舍与遗留】变速播放下的时间戳按原始文件换算，不跟播放速度走 —— 需要"按倍速记笔记"的话这是下一件事。`

/** 附图评论：带一张验收截图（脚本自己渲染出来，不是示意图） */
const ATTACH_COMMENT = '验收截图贴在这儿：第 12 期导出的五段章节名与时间点都对上了，右下角是导出后的文件头。'

/** 人的验收意见（从界面写，作者是人） */
const HUMAN_COMMENT =
  '时间轴对上了，21:04 那段少了一个章节（访谈里换了个话题）。另外导出的文件名请带上期数，不然一堆 timestamp 分不清。'

/** 接手说明：会被 agent 提议改写，审批页那条记录就是它 */
const HANDOFF_CURRENT = (short) => `## 项目目标

做一款自动整理播客音频、提取章节时间轴并导出 Markdown 笔记的桌面小工具。

## 当前进展

- 待验收：#${short('timestamp-offset')}（修复长音频导出 Markdown 笔记时时间戳偏移 2 秒的问题）
- 进行中：#${short('waveform')}（实现音频波形预览组件与双倍速快捷键）
- 待确认：#${short('chapter-cards')}（提议：自动提取每期播客的时间轴章节与金句卡片）

## 下一步

新接手的助手请先看 #${short('waveform')} 的进度，补完空格键播放控制后推到「待验收」。`

const HANDOFF_PROPOSAL = (short) => `## 项目目标

做一款自动整理播客音频、提取章节时间轴并导出 Markdown 笔记的桌面小工具。

## 当前进展

- 已完成：#${short('timestamp-offset')}（长音频导出的时间戳已对齐到毫秒）
- 待验收：#${short('waveform')}（音频波形预览与双倍速快捷键已全部实现）
- 待办：#${short('rss-offline')}（补齐 RSS 订阅源离线缓存与断点续传）

## 下一步

下一个接手的助手可以直接开始做 #${short('rss-offline')} 的离线音频缓存模块。`

// ── 小工具 ────────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log('  ', ...a)
const pad2 = (n) => String(n).padStart(2, '0')

function die(msg) {
  console.error(`\n✗ ${msg}\n`)
  process.exit(1)
}

function parseArgs(argv) {
  const out = { dataDir: null, cdpPort: 9491, keepOpen: false }
  for (let i = 0; i < argv.length; i++) {
    const cur = argv[i]
    if (cur === '--data-dir') out.dataDir = argv[++i]
    else if (cur.startsWith('--data-dir=')) out.dataDir = cur.slice('--data-dir='.length)
    else if (cur === '--cdp-port') out.cdpPort = Number(argv[++i])
    else if (cur.startsWith('--cdp-port=')) out.cdpPort = Number(cur.slice('--cdp-port='.length))
    else if (cur === '--keep-open') out.keepOpen = true
    else if (cur === '--help' || cur === '-h') {
      console.log('用法：node scripts/demo-seed.mjs --data-dir <目录> [--cdp-port 9491] [--keep-open]')
      process.exit(0)
    } else die(`不认识的参数：${cur}`)
  }
  return out
}

/** 真实数据目录 —— 这个脚本永远不许写它 */
function realDataDir() {
  const appData = process.env.APPDATA || ''
  return appData ? resolve(appData, 'desk-partner') : ''
}

function assertSafeDataDir(dir) {
  const target = resolve(dir)
  const real = realDataDir()
  if (real && target.toLowerCase() === real.toLowerCase()) {
    die(`--data-dir 指向了真实数据目录（${target}）。造数只能落在隔离目录里。`)
  }
  if (target.toLowerCase() === ROOT.toLowerCase()) {
    die('--data-dir 不能是仓库根目录：这个脚本会清空目标目录里的库文件。')
  }
  return target
}

// ── 阶段 1：清空 + 建库 ──────────────────────────────────────────────────────

/** 只清属于这个产品的文件；目录里别的东西一概不碰 */
function cleanDataDir(dataDir) {
  mkdirSync(dataDir, { recursive: true })
  const removable = (name) =>
    name === 'user.db' ||
    name.startsWith('user.db-') ||
    name.startsWith('user.db.') ||
    name === 'attachments' ||
    name === 'credentials.json'
  let n = 0
  for (const name of readdirSync(dataDir)) {
    if (!removable(name)) continue
    rmSync(join(dataDir, name), { recursive: true, force: true })
    n++
  }
  log(`清空 ${dataDir}：移除 ${n} 个旧文件（user.db / attachments / credentials）`)
}

/** 一条命令跑完的 CLI（无头：不加载窗口，也不连管道路径） */
function runHeadlessCli(args, env) {
  const r = spawnSync(ELECTRON, ['.', '--cli', ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 180000,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const out = `${r.stdout ?? ''}`
  const at = out.indexOf('{')
  if (at < 0) {
    die(`CLI 没有回 JSON：${args.join(' ')}\n${out}\n${r.stderr ?? ''}`)
  }
  try {
    return JSON.parse(out.slice(at))
  } catch {
    die(`CLI 回执不是合法 JSON：${args.join(' ')}\n${out.slice(at, at + 400)}`)
  }
}

/** 把库建出来（跑一次只读命令，迁移链就落库了），再把窗口坐标预置到屏幕外 */
function bootstrapDatabase(dataDir) {
  const env = {
    DESKPARTNER_DATA_DIR: dataDir,
    DESKPARTNER_NO_PIPE: '1',
    DESKPARTNER_CREDENTIALS_FILE: join(dataDir, 'credentials.json')
  }
  const r = runHeadlessCli(['project', 'list'], env)
  if (!r.ok) die(`建库失败：${r.message ?? JSON.stringify(r)}`)
  log(`库已建立：${join(dataDir, 'user.db')}（项目 ${r.data.length} 个）`)

  /**
   * 窗口坐标预置到屏幕外。
   *
   * 不预置的话隔离实例会真的开窗、抢走她正在用的窗口焦点 —— 一个造数脚本
   * 把屏幕抢过去，比它失败还烦人。用 node 自带的 sqlite 直接改设置表：
   * 此时库刚建好、还没有实例占着它（better-sqlite3 那条路要过 ABI，这里不需要）。
   */
  const bounds = JSON.stringify({ x: -3200, y: -3200, width: 1280, height: 720 })
  const code = `
const { DatabaseSync } = require('node:sqlite')
const db = new DatabaseSync(${JSON.stringify(join(dataDir, 'user.db'))})
const up = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
for (const k of ['kanbanWindowBounds', 'floatBallPosition']) up.run(k, ${JSON.stringify(bounds)})
db.close()
console.log('ok')`
  try {
    execFileSync(process.execPath, ['-e', code], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30000
    })
    log('窗口坐标已预置到屏幕外')
  } catch (e) {
    log(`⚠️ 预置窗口坐标失败（实例可能弹到屏幕上）：${e.message}`)
  }
}

// ── 阶段 2：起隔离实例（CDP）─────────────────────────────────────────────────

function connect(wsUrl) {
  return new Promise((resolveP, reject) => {
    const ws = new WebSocket(wsUrl)
    ws.onopen = () => resolveP(ws)
    ws.onerror = () => reject(new Error(`WebSocket 连接失败：${wsUrl}`))
  })
}

let msgId = 0
function makeSend(ws) {
  return (method, params = {}, timeoutMs = 60000) =>
    new Promise((resolveP, reject) => {
      const id = ++msgId
      const timer = setTimeout(() => reject(new Error(`CDP 超时：${method}`)), timeoutMs)
      const onMessage = (ev) => {
        const msg = JSON.parse(ev.data)
        if (msg.id !== id) return
        clearTimeout(timer)
        ws.removeEventListener('message', onMessage)
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolveP(msg.result)
      }
      ws.addEventListener('message', onMessage)
      ws.send(JSON.stringify({ id, method, params }))
    })
}

async function targets(port) {
  const r = await fetch(`http://127.0.0.1:${port}/json`)
  return (await r.json()).filter((t) => t.type === 'page')
}

async function waitForCdp(port, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      if ((await targets(port)).length) return true
    } catch {
      /* 还没起来 */
    }
    await sleep(500)
  }
  return false
}

/** 连某个窗口（按 url 片段找），返回能 eval 的句柄 */
async function attach(port, urlPart, tries = 40) {
  for (let i = 0; i < tries; i++) {
    const hit = (await targets(port)).find((p) => p.url.includes(urlPart))
    if (hit) {
      const ws = await connect(hit.webSocketDebuggerUrl)
      const send = makeSend(ws)
      return {
        send,
        close: () => ws.close(),
        eval: async (expr) => {
          const r = await send('Runtime.evaluate', {
            expression: expr,
            awaitPromise: true,
            returnByValue: true
          })
          if (r.exceptionDetails) {
            throw new Error(
              r.exceptionDetails.exception?.description || r.exceptionDetails.text || '界面求值失败'
            )
          }
          return r.result?.value
        }
      }
    }
    await sleep(500)
  }
  throw new Error(`找不到窗口：${urlPart}`)
}

/** 起实例 → 打开主窗口 → 跑 fn → 无论成败都收干净 */
async function withGui(dataDir, port, fn) {
  const env = { ...process.env, DESKPARTNER_DATA_DIR: dataDir }
  env.DESKPARTNER_CREDENTIALS_FILE = join(dataDir, 'credentials.json')
  delete env.ELECTRON_RUN_AS_NODE
  delete env.DESKPARTNER_NO_PIPE
  delete env.DESKPARTNER_AGENT
  delete env.DESKPARTNER_CREDENTIAL

  const child = spawn(
    ELECTRON,
    ['.', `--remote-debugging-port=${port}`, '--disable-gpu', '--disable-software-rasterizer', '--no-sandbox'],
    { cwd: ROOT, env, stdio: 'ignore' }
  )
  try {
    if (!(await waitForCdp(port))) throw new Error('CDP 没起来：隔离实例启动失败')
    await sleep(3000)
    // 首启只有悬浮球；主窗口要点出来（隐藏窗口不合成画面，后面的截图也依赖它）
    const ball = await attach(port, 'float-ball')
    await ball.eval(`window.api.invoke('window:showKanban')`)
    ball.close()
    await sleep(3500)
    const page = await attach(port, 'kanban')
    return await fn(page)
  } finally {
    try {
      child.kill()
    } catch {
      /* 已经退出 */
    }
    await sleep(500)
    try {
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        timeout: 30000
      })
    } catch {
      /* 进程树已经没了 */
    }
  }
}

/** 界面上的 IPC 调用（人侧写入就走这条路） */
function ipc(page) {
  return async (channel, input) => {
    const expr =
      input === undefined
        ? `window.api.invoke(${JSON.stringify(channel)}).then(r => JSON.stringify(r))`
        : `window.api.invoke(${JSON.stringify(channel)}, ${JSON.stringify(input)}).then(r => JSON.stringify(r))`
    const res = JSON.parse(await page.eval(expr))
    if (!res.ok) throw new Error(`${channel} 失败：${res.error ?? JSON.stringify(res)}`)
    return res.data
  }
}

// ── 阶段 3：验收截图的素材（脚本自己渲染一张真实图片）────────────────────────

function findEdge() {
  const candidates = [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
  ]
  return candidates.find((p) => existsSync(p)) || null
}

/**
 * 造一张"第 12 期导出的波形与章节"截图，给评论附图用。
 *
 * 为什么不用现成的 png 入库：图是二进制，进了仓库就再也说不清它是怎么来的；
 * 用一段 HTML 渲染出来，改文案就是改几行字，谁都能重跑。
 */
function makeAttachmentShot(dataDir) {
  const edge = findEdge()
  if (!edge) die('找不到 Edge（无头渲染评论附图要用它）。装一下 Edge，或改 findEdge() 里的路径。')

  const dir = join(dataDir, 'demo-assets')
  mkdirSync(dir, { recursive: true })
  const html = join(dir, 'waveform.html')
  const out = join(dir, '第12期-导出校验.png')

  // 波形：固定种子的伪随机，保证每次跑出来的图一模一样
  let seed = 20261114
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648
  }
  const bars = []
  for (let i = 0; i < 260; i++) {
    const t = i / 260
    // 三段"说话"中间夹停顿，看起来才像访谈录音
    const envelope = 0.35 + 0.65 * Math.abs(Math.sin(t * Math.PI * 2.1)) * (t < 0.12 || t > 0.88 ? 0.5 : 1)
    const h = Math.max(4, Math.round((0.25 + rand() * 0.75) * envelope * 132))
    bars.push(`<span style="height:${h}px"></span>`)
  }
  const chapters = [
    ['00:00', '开场与本期话题'],
    ['10:32', '做播客三年踩过的坑'],
    ['21:04', '谈选题：先有听众还是先有内容'],
    ['31:36', '工具链与剪辑流程'],
    ['42:07', '收尾与下期预告']
  ]

  writeFileSync(
    html,
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
      * { box-sizing: border-box; margin: 0; padding: 0 }
      body { width: 1100px; height: 500px; background: #0F1520; color: #E5E9F0;
             font-family: -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif }
      .hd { display: flex; align-items: center; justify-content: space-between; padding: 20px 26px 14px }
      .name { font-size: 16px; font-weight: 600; letter-spacing: -.2px }
      .meta { font-size: 12.5px; color: #8A94A6 }
      .wave { display: flex; align-items: center; gap: 2px; height: 200px; padding: 0 26px }
      .wave span { flex: 1; background: #5388F6; border-radius: 1.5px; opacity: .92 }
      .ruler { height: 26px; margin: 0 26px; border-top: 1px solid rgba(255,255,255,.10);
               display: flex; justify-content: space-between; align-items: flex-start;
               padding-top: 6px; font-size: 11px; color: #6C7688 }
      .list { padding: 16px 26px 0; display: grid; grid-template-columns: 1fr 1fr; gap: 8px 26px }
      .ch { display: flex; gap: 12px; align-items: baseline; font-size: 13px; color: #C8D0DE;
            padding: 7px 10px; border-radius: 8px; background: rgba(255,255,255,.035) }
      .ch b { font-size: 12px; color: #5388F6; font-weight: 600; font-variant-numeric: tabular-nums }
      .ft { position: absolute; left: 26px; right: 26px; bottom: 16px; display: flex;
            justify-content: space-between; font-size: 11.5px; color: #6C7688 }
      .pill { color: #8FB6FF; background: rgba(83,136,246,.16); border: 1px solid rgba(83,136,246,.35);
              border-radius: 999px; padding: 2px 9px }
    </style></head><body>
      <div class="hd">
        <div class="name">第 12 期 · 访谈录音.wav</div>
        <div class="meta">48 kHz · 单声道 · 42:07 · 已识别 5 个章节</div>
      </div>
      <div class="wave">${bars.join('')}</div>
      <div class="ruler"><span>00:00</span><span>10:32</span><span>21:04</span><span>31:36</span><span>42:07</span></div>
      <div class="list">
        ${chapters
          .map(([t, name]) => `<div class="ch"><b>${t}</b><span>${name}</span></div>`)
          .join('')}
        <div class="ch"><b>导出</b><span>Markdown · 时间戳已对齐</span></div>
      </div>
      <div class="ft"><span>timestamp-export.md · 24.6 KB</span><span class="pill">校验通过</span></div>
    </body></html>`
  )

  execFileSync(
    edge,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--force-device-scale-factor=2',
      '--window-size=1100,500',
      '--virtual-time-budget=4000',
      `--user-data-dir=${join(dir, '.edge-profile')}`,
      `--screenshot=${out}`,
      `file:///${html.replace(/\\/g, '/')}`
    ],
    { stdio: ['ignore', 'ignore', 'pipe'], timeout: 120000 }
  )
  log(`评论附图素材：${out}`)
  return out
}

// ── 阶段 4：agent 侧的 CLI（真实身份 + 凭据，走管道路径）─────────────────────

function runCliAs(dataDir, agent, args) {
  const env = {
    ...process.env,
    DESKPARTNER_DATA_DIR: dataDir,
    DESKPARTNER_CREDENTIALS_FILE: join(dataDir, 'credentials.json'),
    DESKPARTNER_AGENT: agent
  }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.DESKPARTNER_NO_PIPE
  delete env.DESKPARTNER_CREDENTIAL
  const r = spawnSync(process.execPath, [LAUNCHER, ...args], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    timeout: 180000,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const out = `${r.stdout ?? ''}`
  const at = out.indexOf('{')
  if (at < 0) die(`CLI 没有回 JSON：${args.join(' ')}\n${out}\n${r.stderr ?? ''}`)
  return JSON.parse(out.slice(at))
}

function cliAs(dataDir, agent, args) {
  const r = runCliAs(dataDir, agent, args)
  if (!r.ok) die(`${agent} 的 CLI 失败：${args.join(' ')}\n${r.message ?? JSON.stringify(r)}`)
  return r.data
}

// ── 主流程 ────────────────────────────────────────────────────────────────────

const argv = parseArgs(process.argv.slice(2))
if (!argv.dataDir) die('缺少 --data-dir（例：--data-dir .tmp-check/demo-abc/data）')
const DATA = assertSafeDataDir(argv.dataDir)

if (!existsSync(ELECTRON)) die(`找不到 Electron：${ELECTRON}（先 npm install）`)
if (!existsSync(LAUNCHER)) die(`找不到 CLI 启动器：${LAUNCHER}（先 npm run build）`)
if (!existsSync(join(ROOT, 'out', 'main', 'index.js'))) die('找不到 out/main/index.js（先 npm run build）')

console.log(`\n=== 1. 清空并建库 ===`)
cleanDataDir(DATA)
bootstrapDatabase(DATA)

console.log(`\n=== 2. 身份 + 凭据（无头 CLI）===`)
const credEnv = {
  DESKPARTNER_DATA_DIR: DATA,
  DESKPARTNER_NO_PIPE: '1',
  DESKPARTNER_CREDENTIALS_FILE: join(DATA, 'credentials.json')
}
for (const a of AGENTS) {
  const reg = runHeadlessCli(
    ['agent', 'register', `--id=${a.id}`, `--name=${a.name}`, `--color=${a.color}`],
    credEnv
  )
  if (!reg.ok) die(`注册 ${a.id} 失败：${reg.message ?? JSON.stringify(reg)}`)
  const cred = runHeadlessCli(['agent', 'credential', `--id=${a.id}`], credEnv)
  if (!cred.ok) die(`签发 ${a.id} 的凭据失败：${cred.message ?? JSON.stringify(cred)}`)
  log(`${a.name}（${a.id}）已注册并领到凭据`)
}

const attachShot = makeAttachmentShot(DATA)

console.log(`\n=== 3. 界面侧造数（人侧写入）===`)
const ids = await withGui(DATA, argv.cdpPort, async (page) => {
  const call = ipc(page)

  // 批准两个助手：产品里这一步只能由人在桌面端做
  for (const a of AGENTS) {
    await call('agent:setApproved', { id: a.id, approved: true })
  }
  log(`已在界面批准 ${AGENTS.map((a) => a.name).join(' / ')}`)
  await call('settings:update', { humanName: HUMAN, theme: 'light' })
  log(`人名设为 ${HUMAN}，主题 light`)

  // 项目
  const projectId = {}
  for (const p of PROJECTS) {
    const made = await call('project:create', p)
    projectId[p.name] = made.id
  }
  log(`项目：${PROJECTS.map((p) => p.name).join(' / ')}`)

  // 标签
  const catId = {}
  for (const c of CATEGORIES) catId[c.name] = (await call('category:create', c)).id
  log(`标签：${CATEGORIES.map((c) => c.name).join(' / ')}`)

  // 事项
  /**
   * 截止时间统一落在**明天**同一时刻。
   *
   * 用"今天 18:00"的话，脚本在晚上跑就会变成逾期，卡片上的时间会变红 ——
   * 同一份数据拍出来的图，颜色居然取决于几点钟跑脚本。明天则恒为常态色。
   */
  const dueAt = (hhmm) => {
    if (!hhmm) return null
    const d = new Date()
    d.setDate(d.getDate() + 1)
    const [hh, mm] = hhmm.split(':')
    d.setHours(Number(hh), Number(mm), 0, 0)
    return d.toISOString()
  }
  const todoId = {}
  for (const t of TODOS) {
    const made = await call('todo:create', {
      title: t.title,
      description: t.description ?? null,
      projectId: projectId['独立播客助手'],
      categoryIds: [catId[t.category]],
      status: t.status,
      type: t.type,
      priority: t.priority,
      createdBy: t.createdBy,
      executedBy: t.executedBy,
      verifier: 'human',
      dueAt: dueAt(t.due),
      ...(t.fixedInVersion ? { fixedInVersion: t.fixedInVersion } : {})
    })
    todoId[t.key] = made.id
  }
  log(`事项 ${TODOS.length} 条：${TODOS.map((t) => t.status).join(' / ')}`)

  // 接手说明（人写的当前版本；下面 agent 会提一个待采纳的修订）
  const short = (key) => todoId[key].slice(0, 8)
  await call('project:update', {
    id: projectId['独立播客助手'],
    handoffMarkdown: HANDOFF_CURRENT(short)
  })
  log('接手说明已写入（含真实事项短号）')

  // ── agent 侧：交付说明 + 带图评论 + 接手说明提议（CLI，真实身份）──
  const bodyFile = (name, body) => {
    const f = join(DATA, `demo-assets/_${name}.md`)
    writeFileSync(f, body)
    return f
  }
  cliAs(DATA, LEAD, [
    'todo',
    'update',
    todoId['timestamp-offset'],
    '--status=awaiting_review',
    '--comment-file',
    bodyFile('delivery', DELIVERY)
  ])
  log(`${AGENTS[0].name} 把「时间戳偏移」交付到待验收（四段式说明）`)

  cliAs(DATA, LEAD, [
    'todo',
    'comment',
    todoId['timestamp-offset'],
    '--body',
    ATTACH_COMMENT,
    '--attach',
    attachShot
  ])
  log(`${AGENTS[0].name} 留了一条带图评论`)

  cliAs(DATA, PEER, [
    'todo',
    'comment',
    todoId['glossary'],
    '--body',
    '第 12 期里出现了 4 个同音不同写法的名字，先都记成「待确认」，等你听完再定。'
  ])
  log(`${AGENTS[1].name} 在「专有名词对照表」下留了进度`)

  const proposal = cliAs(DATA, LEAD, [
    'project',
    'handoff-propose',
    '独立播客助手',
    '--body-file',
    bodyFile('handoff', HANDOFF_PROPOSAL(short))
  ])
  log(`接手说明提议已提交（待你采纳）：${proposal.id ?? ''}`)

  // 人的验收意见：最后写，评论区顺序才是「交付 → 截图 → 人的意见」
  await call('todo:addComment', {
    todoId: todoId['timestamp-offset'],
    body: HUMAN_COMMENT,
    kind: 'comment'
  })
  log(`${HUMAN} 的验收意见已写入`)

  return { projectId, todoId }
})

const idsFile = join(DATA, '..', 'demo-ids.json')
writeFileSync(idsFile, JSON.stringify(ids, null, 2))

console.log(`\n=== 4. 完成 ===`)
log(`数据目录：${DATA}`)
log(`事项 id 清单：${resolve(idsFile)}`)
log(`重拍截图：node outputs/social-146/shoot.mjs --data-dir ${path.relative(process.cwd(), DATA)}`)

if (argv.keepOpen) {
  console.log(`\n--keep-open：再用同一数据目录起实例即可连 CDP ${argv.cdpPort}`)
}
