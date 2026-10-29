/**
 * 决策 A 的验收脚本：证明验证流程**完全不碰生产库**。
 *
 * 判据（见 cb659bce 的验收方式）：
 *   跑之前记生产库指纹 → 在**副本**里造探针再删掉 → 再记指纹
 *   → 三者（mtime / size / 关键表行数）必须完全一致。
 *
 * 要证的是**三条路都走副本**，它们的失效机理各自独立：
 *   1. 界面路径（`todo:create` / `todo:delete` IPC）—— 常规验证脚本用的就是这条
 *   2. 无头 CLI（`DESKPARTNER_NO_PIPE=1`）—— 验证脚本里的 CLI 调用
 *   3. **常驻管道 CLI（不设 NO_PIPE）** —— 最容易静默走错的一条：
 *      管道名若只由用户名决定，隔离实例里的 CLI 会连上**真实 GUI**，
 *      于是"跑在隔离库上"的调用写进了真实库。已由 `pipe-protocol.ts`
 *      的 `dataDirKey()` 修掉，这里把它钉住。
 *
 * 若隔离失效，任一动作会落到生产库上，指纹立刻变化 → FAIL。
 *
 * ── 用法（1.0.111 起带前置自检，卡 `2a54cac1`）──
 *
 *     node scripts/verify-isolation.mjs                    # 开发态默认：没有降级通道就直说缺什么
 *     node scripts/verify-isolation.mjs --packaged-main    # 显式用 dist/win-unpacked 里那份打包产物
 *     DESKPARTNER_MAIN=<exe> node scripts/verify-isolation.mjs
 *
 * 退出码：0 = PASS；1 = 隔离失效（探针碰到生产库）；2 = **前置条件不满足，什么都没验**。
 */
import { withIsolatedApp } from './lib/isolated-app.mjs'
import { statSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync, spawnSync } from 'node:child_process'

const REAL = process.env.DESKPARTNER_REAL_DATA_DIR || join(process.env.APPDATA || '', 'desk-partner')
const DB = join(REAL, 'user.db')

const PY =
  process.env.DESKPARTNER_PY ||
  const pyBin = existsSync(PY) ? PY : 'python'

/** 生产库指纹：主库 mtime + size + 三张关键表行数 */
function fingerprint() {
  const st = statSync(DB)
  const py = `
import sqlite3
d = sqlite3.connect(r'file:${DB.replace(/\\/g, '/')}?mode=ro', uri=True)
def n(t):
    try: return d.execute('select count(*) from ' + t).fetchone()[0]
    except Exception: return -1
print(f"{n('todos')},{n('events')},{n('agent_grants')}")
`
  return {
    mtimeMs: st.mtimeMs,
    size: st.size,
    counts: execFileSync(pyBin, ['-c', py], {
      encoding: 'utf8',
      timeout: 20000,
      // 缺 stdio 在受限环境会 EBUSY，失败态看着像"库读不了"（见 tests/main/lib/spawn-stdio-guard.test.ts）
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim()
  }
}

/** 直接数**某个库**里的探针条数（用于证明它落到了哪一边） */
function countProbes(dbFile) {
  const py = `
import sqlite3
d = sqlite3.connect(r'file:${dbFile.replace(/\\/g, '/')}?mode=ro', uri=True)
print(d.execute("select count(*) from todos where title like '__ISOLATED_PROBE__%'").fetchone()[0])
`
  try {
    return Number(
      execFileSync(pyBin, ['-c', py], {
        encoding: 'utf8',
        timeout: 20000,
        // 同上：缺 stdio 会 EBUSY
        stdio: ['ignore', 'pipe', 'pipe']
      }).trim()
    )
  } catch {
    return -1
  }
}

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const PACKAGED_MAIN = join(ROOT, 'dist', 'win-unpacked', 'DeskPartner.exe')
const ARGS = process.argv.slice(2)

/**
 * 前置自检：**这条闸门在开发态会必然变红，而红十字向的是错的方向**（卡 `2a54cac1`）
 *
 * 无头那条路线（`DESKPARTNER_NO_PIPE=1`，见 `verify-probe-cli.mjs`）要一份
 * "能当 node 跑"的程序本体。开发态只有 `node_modules/electron/dist/electron.exe`，
 * 而它是 Electron 运行时 —— 缺 `ELECTRON_RUN_AS_NODE` 时会去开 GUI 窗口并崩，
 * 于是 `launcher.ts` 的 `preflightHeadless()` 直接拒绝降级，`doctor` 拿不到回执，
 * 探针打印出 `FAIL 无头 CLI 打开的库是副本（dbPath=undefined）`。
 *
 * 2026-10-21 实测的现场：我第一反应是"是不是我刚改的备份代码把它搞红了"，
 * 手工复现后才确认是**缺一条通道**，与那次改动无关（探针跑的是 out/ 里的旧构建）。
 * 与 `5cc4669` / `5cc426b9` 同族：**闸门在"正确用法"下才绿，而用法没写**。
 *
 * 判据：**前置条件不满足时什么都不跑**，并把"未验证"与"隔离失效"分开说 ——
 * 半路变红最坏的地方不是红，是它长得像"隔离坏了"（那是产品事故级结论）。
 *
 * ⚠️ 这里**不做**"检测到打包产物就悄悄用"：那会把这道闸门验的东西换掉
 * （从"开发态代码的隔离"换成"上一份打包产物的隔离"）而输出不变。
 * 要换可以，但得是命令行上明写的一步（`--packaged-main`）。
 */
function headlessChannelPreflight() {
  const declared = process.env.DESKPARTNER_MAIN
  if (declared) {
    if (!existsSync(declared)) {
      console.error(`[前置] DESKPARTNER_MAIN 指向的文件不存在：${declared}`)
      console.error('       换成存在的可执行文件，或去掉这个环境变量。')
      process.exit(2)
    }
    console.log(`[前置] 无头 CLI 路线走 DESKPARTNER_MAIN=${declared}`)
    return
  }

  if (ARGS.includes('--packaged-main')) {
    if (!existsSync(PACKAGED_MAIN)) {
      console.error(`[前置] --packaged-main：没找到打包产物 ${PACKAGED_MAIN}`)
      console.error('       先 `npm run pack`（= electron-builder --dir）再跑。')
      process.exit(2)
    }
    process.env.DESKPARTNER_MAIN = PACKAGED_MAIN
    console.log(
      `[前置] --packaged-main：无头探针走的是**打包产物**\n` +
        `       ${PACKAGED_MAIN}\n` +
        `       而不是 out/ 里的开发态代码 —— 本轮的结论只覆盖前者。`
    )
    return
  }

  console.error(
    [
      '[前置] 无头 CLI 路线在**开发态**没有可用的降级通道，本轮不会开跑。',
      '',
      '  为什么：那条路线要一份"能当 node 跑"的程序本体，而开发态只有',
      '  node_modules/electron/dist/electron.exe —— Electron 运行时缺',
      '  ELECTRON_RUN_AS_NODE 时会去开 GUI 窗口并崩，launcher 于是拒绝降级，',
      '  探针会打印 `FAIL …（dbPath=undefined）`，**看起来像隔离失效，其实不是**。',
      '',
      '  两条做法（任选）：',
      '    ① 用一份打包产物跑（结论覆盖的是它，不是工作区代码）：',
      '         npm run pack',
      '         node scripts/verify-isolation.mjs --packaged-main',
      '    ② 自己指定程序本体：',
      '         DESKPARTNER_MAIN=<DeskPartner.exe 的路径> node scripts/verify-isolation.mjs',
      '',
      '  本轮**没有任何路线被验证**：结论是"未验证"（退出码 2），不是"隔离失效"（退出码 1）。'
    ].join('\n')
  )
  process.exit(2)
}

headlessChannelPreflight()

const before = fingerprint()
console.log('生产库（跑之前）:', JSON.stringify(before))
const realProbesBefore = countProbes(DB)

await withIsolatedApp(
  async ({ port, dataDir, run, evaluate }) => {
    // 实例起来后会自己跳转一次（视图初始化），等它稳住再求值 —— 否则会撞
    // "Execution context was destroyed"（makeCdp 已带重试，这里再稳一手）
    await new Promise((r) => setTimeout(r, 2500))

    // ── 路线 1：界面路径（此前验证脚本的常规动作）──
    const probe = await evaluate(`
      (async () => {
        const made = await window.api.invoke('todo:create', {
          title: '__ISOLATED_PROBE__gui', description: '隔离验证探针'
        })
        if (!made.ok) return { err: made.message || made.error, step: 'create' }
        const del = await window.api.invoke('todo:delete', { id: made.data.id })
        return { step: 'done', deleted: !!del.ok }
      })()
    `)
    console.log('副本内（界面路径）造+删 探针:', JSON.stringify(probe))
    if (!probe || probe.step !== 'done' || !probe.deleted) {
      throw new Error(`隔离实例内探针闭环未完成: ${JSON.stringify(probe)}`)
    }

    // ── 路线 2：无头 CLI（验证脚本主要用的形式）──
    const headless = await run('verify-probe-cli.mjs', ['__ISOLATED_PROBE__headless'])
    if (headless.code !== 0) throw new Error('无头 CLI 探针未通过')

    // ── 路线 3：常驻管道 CLI（**不设 NO_PIPE**）──
    // 只有真实 GUI 在跑时这条才有意义（否则会降级成无头，等于没测）
    const pipeRes = spawnSync(
      process.execPath,
      [join(process.cwd(), 'scripts', 'probe-cli-nopipe.mjs'), '__ISOLATED_PROBE__pipe'],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 90000,
        cwd: process.cwd(),
        env: {
          ...process.env,
          CDP_PORT: String(port),
          DESKPARTNER_DATA_DIR: dataDir
          // 刻意不带 DESKPARTNER_NO_PIPE
        }
      }
    )
    if (pipeRes.stdout) process.stdout.write(pipeRes.stdout)
    if (pipeRes.status !== 0) throw new Error('管道路线检查未通过')

    // ── 最直接的证据：探针在**副本**里出现过，在**生产库**里从来没出现 ──
    const inCopy = countProbes(join(dataDir, 'user.db'))
    console.log(
      `副本库里的探针残留: ${inCopy}（副本整体会被丢弃，残留不会流出去）`
    )
  },
  { port: 9477 }
)

const after = fingerprint()
console.log('生产库（跑之后）:', JSON.stringify(after))

const realProbesAfter = countProbes(DB)
console.log(`生产库里的探针记录数: 跑前 ${realProbesBefore} → 跑后 ${realProbesAfter}`)

const same =
  before.mtimeMs === after.mtimeMs && before.size === after.size && before.counts === after.counts

console.log('─'.repeat(58))
if (same && realProbesAfter === realProbesBefore) {
  console.log('PASS  生产库完全未被触碰（mtime / size / 行数 三者一致）')
  console.log('      → 三条路线（界面 / 无头 CLI / 管道 CLI）的写入都只落在副本上')
  console.log('      → 清理不再需要任何销毁授权')
  process.exit(0)
}
console.log('FAIL  生产库被动过 —— 隔离失效！')
console.log('      before:', JSON.stringify(before))
console.log('      after :', JSON.stringify(after))
console.log(`      探针数: ${realProbesBefore} → ${realProbesAfter}`)
process.exit(1)
