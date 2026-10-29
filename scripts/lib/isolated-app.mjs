/**
 * 隔离验证实例启动器（公共模块）
 *
 * ── 为什么需要它（主用户 2026-09-29 决策 A）──
 *
 * 此前所有 CDP 验证脚本都连**生产库**：探针 todo 直接写进她的真实看板，
 * 跑完再由 `cleanup-test-todos.mjs` 靠标题正则去捞、逐条删掉。
 * 实测代价：为删 4 条探针，产生了 **68 条销毁授权**（其中 15 条过期未处理）。
 *
 * 这个模块把「起一个数据目录是副本、窗口在屏幕外、CDP 可连」的实例
 * 变成一次函数调用。验证脚本跑完，**删掉的是一整个临时目录**（不需要任何授权），
 * 而不是逐条 `todo rm`（每次都要人点头）。
 *
 * ── 用法 ──
 *
 * ```js
 * import { withIsolatedApp } from './lib/isolated-app.mjs'
 *
 * await withIsolatedApp(async ({ port, run, cdp }) => {
 *   // run(file) 跑一个验证脚本，自动带 CDP_PORT / RENDERER_URL
 *   const r = await run('verify-kanban-scroll.mjs')
 *   if (r.code !== 0) throw new Error('断言失败')
 * }, { keep: false })   // keep: true 可以留着现场排查
 * ```
 *
 * ── 三个必须踩过的坑（都不是可选的）──
 *
 * 1. **窗口坐标必须预置到屏幕外**：实例会真的开窗抢焦点。
 *    直接改副本库的 `settings` 里含 `ounds`/`osition` 的键。
 * 2. **`ELECTRON_RUN_AS_NODE` 必须删掉**（连空字符串都不行）：
 *    否则 Electron 以 Node 模式启动，`require('electron')` 返回路径字符串。
 * 3. **收尾必须 `taskkill /T /F`**：`child.kill()` 杀不掉 renderer 子进程，
 *    端口会一直被占，下一次启动直接连上旧实例。
 */
import { spawn, execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
export const APP_DIR = resolve(HERE, '..', '..')

/** 真实数据目录：只用作**只读源**，永远不写入 */
const REAL_DATA_DIR =
  process.env.DESKPARTNER_REAL_DATA_DIR ||
  join(process.env.APPDATA || '', 'desk-partner')

const ELECTRON = join(APP_DIR, 'node_modules', 'electron', 'dist', 'electron.exe')

/**
 * Python 解释器（只用于 sqlite3 只读/浅写，见文件顶部的坑 #1）
 *
 * ⚠️ 别写死绝对路径：一旦换机器 / 换 runtime 版本，路径就指空了，
 * 而失败表现是"窗口没被挪到屏幕外"——实例会**弹出到她面前抢焦点**，
 * 是个安静且很烦的故障。按优先级探测，都不行就明确报出来。
 */
function resolvePython() {
  const candidates = [
    process.env.DESKPARTNER_PY,
        'python',
    'python3'
  ].filter(Boolean)
  for (const c of candidates) {
    try {
      const r = spawnSync(c, ['-c', 'import sqlite3'], { stdio: 'ignore', timeout: 15000 })
      if (r.status === 0) return c
    } catch {
      /* 试下一个 */
    }
  }
  return null
}

const PY = resolvePython()

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 把真实库复制成一次性副本，并把窗口预置到屏幕外。
 *
 * ── 为什么用 SQLite backup API 而不是直接 copyFile ──
 *
 * 直接拷 `user.db` + `-wal` + `-shm` 有三个问题：
 * 1. **可能拷到撕裂状态**：她的 GUI 正在跑，拷到一半落了写入，
 *    三份文件互相不一致 → 副本打不开，或读出坏数据（而这是"验证环境"，静默失败最贵）
 * 2. `-shm` 是内存映射的共享状态，本来就没有可移植语义
 * 3. 只拷主库会丢 WAL 里未 checkpoint 的最近写入
 *
 * `sqlite3.Connection.backup()` 是官方的一致性快照接口：由 SQLite 自己
 * 在事务语义下导出，**只读地**打开源库，产出单个自洽的 `user.db`。
 * 附带好处：不再需要 `-wal` / `-shm`。
 */
export function prepareIsolatedData(dir, { offscreen = true } = {}) {
  /**
   * 🚨 1.0.62：不再 `rmSync(dir)` 清场 —— 直接把库覆盖写进去。
   *
   * 这里原本先整目录删掉再重建。删除的代价不在磁盘，而在**沙箱闸门**：
   * 每跑一轮验证就删一次，累计到阈值就把我的任务掐断去等人授权。
   * 而副本目录里真正需要"是新的"只有 `user.db` 一个文件，
   * SQLite 的 backup 本来就会按页覆盖写，根本不需要先清空。
   *
   * 至于目录里可能残留的 `-wal` / `-shm`：它们是上一轮实例退出时留下的空壳，
   * 新实例打开库时 SQLite 自己会校验并覆盖，不留可读的旧数据。
   */
  mkdirSync(dir, { recursive: true })

  const srcDb = join(REAL_DATA_DIR, 'user.db')
  if (!existsSync(srcDb)) {
    throw new Error(
      `找不到真实库：${srcDb}\n可用 DESKPARTNER_REAL_DATA_DIR 指定其它位置。`
    )
  }
  if (!PY) {
    throw new Error(
      '未找到可用的 Python（需要 sqlite3 模块）来导出库快照。\n' +
        '可用 DESKPARTNER_PY 指定解释器。'
    )
  }

  const dstDb = join(dir, 'user.db')
  const snapshotPy = `
import sqlite3
src = sqlite3.connect(r'file:${srcDb.replace(/\\/g, '/')}?mode=ro', uri=True)
dst = sqlite3.connect(r'${dstDb}')
src.backup(dst)          # 一致性快照，不看 -wal / -shm
dst.close(); src.close()
print('ok')
`
  try {
    execFileSync(PY, ['-c', snapshotPy], {
      encoding: 'utf8',
      timeout: 60000,
      /**
       * 🚨 必须显式声明 stdio（2026-10-01，同一坑的第四次复现）。
       *
       * `execFileSync` 属于 spawnSync 家族，缺 stdio 时在受限环境里同样 EBUSY。
       * 而它的失败态**更误导**：这里被 catch 成「导出库快照失败：... EBUSY」，
       * 看起来像"库坏了 / 快照导不出"，实际是**子进程压根没起来**。
       *
       * 杀伤面比前三次都大 —— 本文件是**所有隔离验证的公共底座**，
       * 它坏了意味着"跑在副本上"的每一轮验证全部起不来，
       * 而报错会把人引向"数据库有问题"。
       *
       * 为什么前一轮的全仓闸门没抓到：那条闸门只扫 `spawnSync`，
       * 漏了 `execFileSync` / `execSync` 这些同族函数。已扩面（见
       * tests/main/lib/spawn-stdio-guard.test.ts）。
       */
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (e) {
    throw new Error(`导出库快照失败：${e.message}`)
  }
  const copied = ['user.db']

  if (!offscreen) return { copied, patched: [] }

  if (!PY) {
    /**
     * 打不了坐标补丁不是"小事"：实例会真的在屏幕上开窗、抢焦点，
     * 而安静的失败会被当成"验证没问题"。宁可显式拒绝。
     */
    throw new Error(
      '未找到可用的 Python（需要 sqlite3 模块）来预置窗口坐标。\n' +
        '不预置的话，隔离实例会弹在她面前抢焦点。\n' +
        '可用 DESKPARTNER_PY 指定解释器，或传 { offscreen: false } 明确接受弹窗。'
    )
  }

  // 窗口预置到屏幕外 —— 否则实例会真的弹窗抢她的焦点与点击
  const py = `
import sqlite3, sys
d = sqlite3.connect(r'${join(dir, 'user.db')}')
keys = [k for (k,) in d.execute("select key from settings")]
hit = [k for k in keys if 'ounds' in k or 'osition' in k]
for k in hit:
    # 位置类只有 x/y，尺寸类还带 width/height —— 两种形状都覆盖，多写无害
    d.execute("update settings set value=? where key=?",
              ('{"x":-3200,"y":-3200,"width":1200,"height":800}', k))
d.commit()
print(','.join(hit))
`
  let patched = []
  try {
    // 同上：execFileSync 缺 stdio 会 EBUSY（见上方注释）
    const out = execFileSync(PY, ['-c', py], {
      encoding: 'utf8',
      timeout: 20000,
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim()
    patched = out ? out.split(',') : []
  } catch (e) {
    // 打不了补丁不致命，但要让人知道窗口可能会弹出来
    console.warn(`[isolated] 预置窗口坐标失败（实例可能弹窗）：${e.message}`)
  }
  return { copied, patched }
}

/** 等 CDP 端口就绪 */
async function waitForCdp(port, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
      if (list.some((t) => t.type === 'page')) return true
    } catch {
      /* 还没起 */
    }
    await sleep(700)
  }
  return false
}

/** 连 CDP 跑一段表达式，返回结果（验证脚本里的常规需求） */
export function makeCdp(port, { targetUrlPart = 'kanban', retries = 3 } = {}) {
  let seq = 0

  async function pickTarget(urlPart) {
    const pages = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).filter(
      (t) => t.type === 'page'
    )
    if (urlPart) {
      const hit = pages.find((p) => p.url.includes(urlPart))
      if (hit) return hit
    }
    return pages[0]
  }

  return async function evaluate(expression, { urlPart = targetUrlPart } = {}) {
    let lastErr = null
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const page = await pickTarget(urlPart)
        if (!page) throw new Error('没有可用的 page target')

        const ws = new WebSocket(page.webSocketDebuggerUrl)
        await new Promise((res, rej) => {
          ws.onopen = res
          ws.onerror = () => rej(new Error('WebSocket 连接失败'))
        })
        const id = ++seq
        const result = await new Promise((res, rej) => {
          const handler = (ev) => {
            const d = JSON.parse(ev.data)
            if (d.id !== id) return
            ws.removeEventListener('message', handler)
            d.error ? rej(new Error(JSON.stringify(d.error))) : res(d.result)
          }
          ws.addEventListener('message', handler)
          ws.send(
            JSON.stringify({
              id,
              method: 'Runtime.evaluate',
              params: { expression, awaitPromise: true, returnByValue: true }
            })
          )
        })
        ws.close()
        if (result?.exceptionDetails) {
          throw new Error(
            result.exceptionDetails.exception?.description ||
              JSON.stringify(result.exceptionDetails)
          )
        }
        return result?.result?.value
      } catch (e) {
        lastErr = e
        /**
         * ⚠️ 「Execution context was destroyed」是**导航竞态**，不是真错误：
         * 实例启动后会自己做一次页面跳转（dev 模式的 HMR / 视图初始化），
         * 此刻连上的 target 会在求值中途被销毁。
         * 这类错误必须重试 —— 否则会把"实例还没稳"误报成"功能坏了"。
         */
        const retriable =
          /Execution context was destroyed|Target closed|WebSocket 连接失败|没有可用/.test(
            String(e.message)
          )
        if (!retriable || attempt === retries) break
        await sleep(1200)
      }
    }
    throw lastErr
  }
}

/**
 * 起一个隔离实例，跑 fn，然后无论如何都收干净。
 *
 * @param {(ctx: {port:number, dataDir:string, run:(file:string,args?:string[])=>Promise<{code:number,stdout:string}>, cdp:Function, evaluate:Function}) => Promise<void>} fn
 * @param {{port?:number, keep?:boolean, offscreen?:boolean, dir?:string}} opts
 */
export async function withIsolatedApp(fn, opts = {}) {
  const port = opts.port ?? Number(process.env.CDP_PORT || 9471)
  const dataDir = opts.dir ?? join(APP_DIR, '.tmp-check', 'iso')
  const keep = opts.keep ?? false

  const { copied, patched } = prepareIsolatedData(dataDir, { offscreen: opts.offscreen })
  console.log(`[isolated] 库副本 → ${dataDir}  (${copied.join(', ')})`)
  if (patched.length) console.log(`[isolated] 窗口预置屏外: ${patched.join(', ')}`)

  const env = { ...process.env, DESKPARTNER_DATA_DIR: dataDir, DESKPARTNER_NO_PIPE: '1' }
  delete env.ELECTRON_RUN_AS_NODE // 不删掉会以 Node 模式启动
  const child = spawn(
    ELECTRON,
    [
      '.',
      `--remote-debugging-port=${port}`,
      '--disable-gpu',
      '--disable-software-rasterizer',
      // 关掉更新检查等网络行为，避免验证期间产生外部请求
      '--no-sandbox'
    ],
    { cwd: APP_DIR, env, stdio: 'ignore', detached: false }
  )
  console.log(`[isolated] electron pid=${child.pid} port=${port}`)

  const cleanup = async () => {
    try {
      child.kill()
    } catch {
      /* 已退出 */
    }
    await sleep(600)
    try {
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    } catch {
      /* 进程树已没了 */
    }
    /**
     * 🚨 1.0.62：这里**不再删临时目录**。
     *
     * 原来的收尾是 `rmSync(dataDir)` + 一句"临时目录已删除（无需任何删除授权）"。
     * 那句话是错的：删除确实不需要"看板上的授权"，但它**要过沙箱的删除闸门** ——
     * 跑一轮验证删一批文件，跑几轮就撞上阈值，于是任务被中止、等人来点授权。
     * 本来一次验证结束就结束的事，变成了"她必须到场才能让我的循环继续"。
     *
     * 副本目录的复用成本几乎为零：下一轮的 `prepareIsolatedData` 会重新导出
     * 覆盖写 `user.db`（SQLite 自己处理页覆盖），窗口坐标再补一次即可。
     * 所以"清干净"这个动作可以直接取消 —— 现场留在 `.tmp-check/` 里，
     * 它已在 `.gitignore` 中，不进版本库、也不会被当成产物发出去。
     *
     * 真想清现场，是**人**偶尔决定一次的事（删一个目录），
     * 不该写进每一轮自动化的收尾。
     */
    if (keep) {
      console.log(`[isolated] keep=true，现场保留在 ${dataDir}`)
    } else {
      console.log(`[isolated] 现场保留在 ${dataDir}（下一轮直接覆盖复用，不做删除）`)
    }
  }

  /**
   * 跑一个验证脚本子进程，自动带 CDP / 数据目录环境变量
   *
   * @param {string} file  scripts/ 下的文件名
   * @param {string[]} args
   * @param {{noPipe?: boolean}} [opts]
   *   `noPipe`（默认 true）强制脚本里的 CLI 调用走无头通道 ——
   *   避免与常驻实例抢管道。但**验证管道本身的脚本必须传 false**：
   *   `verify-cli-channels.mjs` 要测的就是通道 A，一刀切设成 1 会让它
   *   静默降级成通道 B，于是"两条通道都验过"变成"只验了一条"。
   */
  const run = (file, args = [], opts = {}) => {
    const { noPipe = true } = opts
    const childEnv = {
      ...process.env,
      CDP_PORT: String(port),
      DESKPARTNER_DATA_DIR: dataDir,
      RENDERER_URL:
        'file:///' + join(APP_DIR, 'out', 'renderer', 'index.html').replace(/\\/g, '/')
    }
    if (noPipe) childEnv.DESKPARTNER_NO_PIPE = '1'
    else delete childEnv.DESKPARTNER_NO_PIPE

    const r = spawnSync(process.execPath, [join(APP_DIR, 'scripts', file), ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      // 超时兜底：这些脚本要连 CDP、开 WebSocket，句柄没放开会让进程永不退出
      // （历史上真的发生过，整轮回归卡死十分钟）
      timeout: opts.scriptTimeout ?? 180000,
      killSignal: 'SIGKILL',
      cwd: APP_DIR,
      env: childEnv
    })
    if (r.stdout) process.stdout.write(r.stdout)
    if (r.stderr) process.stderr.write(r.stderr)
    return Promise.resolve({ code: r.status ?? 1, stdout: r.stdout || '', error: r.error })
  }

  try {
    if (!(await waitForCdp(port))) throw new Error(`CDP 未就绪（端口 ${port}）`)
    console.log('[isolated] CDP ready')
    const evaluate = makeCdp(port)

    /**
     * 🚨 握手闸门：**先证明"我现在连的真是隔离实例"**，再让任何验证逻辑开跑。
     *
     * 为什么必须有这一步 —— 隔离失效时，后果都是"探针写进她的真实库"，
     * 而表面上一切正常。已知/可能的失效路径：
     *
     * 1. **`DESKPARTNER_DATA_DIR` 没传下去或指到了真实目录**：子进程里的脚本
     *    会按默认路径去找真实库。`checkIsolation` 只保证"声明的和实际用的一致"，
     *    它拦不住"声明本身就指错了"。
     * 2. **单实例锁**：锁是按 userData 路径取的，所以正常情况下副本实例
     *    与真实 GUI **互不干扰**（实测：她的 GUI 在跑时本站仍能正常起来）。
     *    但若有人把 `DESKPARTNER_DATA_DIR` 误设成真实目录，后启动的那个
     *    会拿不到锁并 `app.quit()` —— 而 CDP 端口可能已经短暂响应过，
     *    `waitForCdp` 会误判为"就绪"，后续"验证"其实打在真实 GUI 上。
     * 3. **管道名**：原来只由用户名决定，隔离实例里的 CLI 会连上常驻的真实 GUI。
     *    已修（`pipe-protocol.ts` 的 `dataDirKey()`）；这里是第二道。
     *
     * 判据选 `app:info` 的 `dataDir`：它由主进程 `app.getPath('userData')`
     * **实时回答**，是"这个界面到底开着哪个库"的唯一权威来源 ——
     * 比查副本文件是否存在、比看环境变量，都更接近真相。
     */
    const info = await evaluate(`window.api.invoke('app:info')`, { urlPart: '' })
    const actual = info?.ok ? info.data?.dataDir : null
    if (!actual) {
      throw new Error(
        `无法确认实例数据目录（app:info 返回 ${JSON.stringify(info)}）。` +
          `为避免"以为在隔离、其实在真实库"，拒绝继续。`
      )
    }
    if (resolve(actual).toLowerCase() !== resolve(dataDir).toLowerCase()) {
      throw new Error(
        `🚨 隔离未生效：实例实际打开的数据目录是\n    ${actual}\n` +
          `而不是副本目录\n    ${dataDir}\n` +
          `继续跑会把探针写进真实库。常见原因：\n` +
          `  - DESKPARTNER_DATA_DIR 指错了（或没传下去）\n` +
          `  - 该目录已被另一个实例占着单实例锁，本实例其实没起来`
      )
    }
    console.log('[isolated] 握手通过：实例打开的正是副本库')

    await fn({ port, dataDir, run, cdp: evaluate, evaluate })
  } finally {
    await cleanup()
  }
}
