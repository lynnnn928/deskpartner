/**
 * 测试入口
 *
 * 直接 `vitest run` 是不够的：仓库测试要在纯 Node 下加载 better-sqlite3，
 * 而应用本身跑在 Electron 里。两者的原生二进制 ABI 不同
 * （Node 22.x = 127，Electron 33 = 130），共用同一份 build 产物，
 * 所以「跑一次测试」就会把 Electron 那份覆盖掉，下次 npm run dev 直接起不来，
 * 报 ERR_DLOPEN_FAILED。
 *
 * 因此这里补一步：测试跑完（无论成败）都还原成 Electron 版，
 * 让 npm test 不再是一个会悄悄破坏开发环境的命令。
 *
 * ⚠️ 切换 ABI 走 `scripts/swap-abi.mjs`，**不用 `npm rebuild`**（2026-09-22 改）。
 * `npm rebuild better-sqlite3` 在本机走 node-gyp 现场编译，而本机没有
 * VS Build Tools（"Could not find any Visual Studio installation"）→
 * 必然失败，于是 `npm test` 直接死在第一步，一条用例都跑不到。
 * 但预编译产物其实一直躺在 npm 缓存里（node-v127 与 electron-v130 各一份），
 * 解包替换即可 —— 更快，且不依赖编译器。
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))

function run(args) {
  console.log(`\n> npm ${args.join(' ')}\n`)
  const r = spawnSync('npm', args, { stdio: 'inherit', shell: true })
  return r.status ?? 1
}

/** 切 ABI：直接替换原生模块产物，绕开 node-gyp */
function swapAbi(target) {
  console.log(`\n> 切换原生模块 ABI → ${target}\n`)
  const r = spawnSync(process.execPath, [join(HERE, 'swap-abi.mjs'), target], { stdio: 'inherit' })
  return r.status ?? 1
}

/**
 * 用**固定版本**的 Node 跑 vitest（2026-09-22 修）
 *
 * ⚠️ 不能用 `npm exec vitest`：那个会走 npm 自己的 node，
 * 在本机是 Node 24（ABI **137**），而缓存里的预编译产物只有
 * node-v**127**（Node 22）与 electron-v130 —— 版本对不上，
 * 于是 11 个测试文件全在 `new Database()` 处挂掉，
 * 报"compiled against NODE_MODULE_VERSION 127, requires 137"。
 *
 * 用绝对路径调 Node 22 下的 vitest 入口，ABI 才与 swap-abi 提供的一致。
 *
 * ⚠️ 路径**动态解析**，不硬编码补丁号后缀（2026-10-09 腐过一次）：
 * 受管运行时的目录带后缀（22.22.2-**3** → 22.22.2-**6**），
 * 硬编码路径一变，spawnSync 拿到 ENOENT 会**静默失败**
 * （status null → 返回 1，vitest 段零输出就报"测试未通过"，
 * 看起来像测试挂了，其实是解释器没找到）。
 * 现在扫受管目录找 Node 22，找不到就大声报错，不许再静默。
 */
import { readdirSync, existsSync } from 'node:fs'

function resolveTestRunner() {
  if (process.env.DESKPARTNER_NODE22 && existsSync(process.env.DESKPARTNER_NODE22)) {
    return { bin: process.env.DESKPARTNER_NODE22, abi: 'node', extraArgs: [], env: process.env }
  }
  if (process.versions.modules === '127') {
    return { bin: process.execPath, abi: 'node', extraArgs: [], env: process.env }
  }
  const home = process.env.USERPROFILE || process.env.HOME || ''
  if (process.env.DESKPARTNER_NO_LOCAL_NODE22 !== '1') {
    try {
      for (const d of readdirSync(home, { withFileTypes: true })) {
        if (!d.isDirectory() || !d.name.startsWith('.')) continue
        const versionsDir = join(home, d.name, 'binaries', 'node', 'versions')
        if (!existsSync(versionsDir)) continue
        const candidates = readdirSync(versionsDir, { withFileTypes: true })
          .filter((e) => e.isDirectory() && /^22\./.test(e.name))
          .map((e) => join(versionsDir, e.name, 'node.exe'))
          .filter((p) => existsSync(p))
          .sort((a, b) => {
            const n = (p) => Number(p.match(/-(\d+)[/\\]node\.exe$/)?.[1] ?? 0)
            return n(a) - n(b)
          })
        if (candidates.length > 0) {
          return { bin: candidates[candidates.length - 1], abi: 'node', extraArgs: [], env: process.env }
        }
      }
    } catch {
      /* fall through */
    }
  }
  const electronBin = join(HERE, '..', 'node_modules/electron/dist/electron.exe')
  if (existsSync(electronBin)) {
    return {
      bin: electronBin,
      abi: 'electron',
      extraArgs: ['--experimental-require-module'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    }
  }
  throw new Error('找不到可用的测试运行时（Node 22 或 node_modules/electron）—— 请先执行 npm install')
}

const RUNNER = resolveTestRunner()
const VITEST = join(HERE, '..', 'node_modules/vitest/vitest.mjs')

function runVitest() {
  const label = RUNNER.abi === 'electron' ? 'Electron Node (ABI 130)' : 'Node 22 (ABI 127)'
  console.log(`\n> vitest run（${label}）\n`)
  const r = spawnSync(RUNNER.bin, [...RUNNER.extraArgs, VITEST, 'run'], {
    stdio: 'inherit',
    env: RUNNER.env
  })
  // spawn 没起来（ENOENT 等）时 r.error 有值、r.status 是 null ——
  // 必须上抛，否则零输出静默返回 1，看起来像"测试全挂"其实是解释器没找到
  if (r.error) throw r.error
  return r.status ?? 1
}

/**
 * 静态一致性检查
 *
 * 放在测试之前、rebuild 之前：它们是纯静态检查，不需要原生模块，
 * 而这两类问题都是**测试很难覆盖的静默失败**（本项目都吃过亏）：
 *
 *   check-ipc-channels    : 渲染层声明了通道、主进程没注册 handler
 *   check-pipe-forwarding : PipeRequest 声明了字段、启动器没转发（1.0.57 补）
 *   verify-gates-reverse   : 扫描型闸门到底认不认得出违规（注入 → 跑 → 还原）
 *
 * 越早拦住越省事。
 *
 * ⚠️ `verify-gates-reverse.cjs` 留在这一组的原因（卡 f917984f）
 *
 * 它验的是"**闸门本身**认不认得出违规"：逐条注入违规 → 跑该闸门的用例 → 还原。
 * 此前它只靠人记得手动跑，于是"闸门断言恒真 / 判据早就漂了"这条风险**没有防线**
 * （2026-10-09 实证过一次假闸门）。发版前忘跑，等于没有这道闸门。
 *
 * 代价约 18 秒（10 次单文件 vitest），比整轮测试便宜得多（实测 2026-10-22）。
 *
 * ⚠️ 它会**临时改源码再还原**（逐条 try/finally），所以：
 * ① 必须留在"串行、跑在 vitest 之前"的这一组里 —— 与测试并行时，
 *    别的进程可能正好读到被注入的那份源码；
 * ② 中途强杀（Ctrl-C / 断电）理论上会留下注入态（finally 跑不到）：
 *    看 `git status` 里那几个文件即可认出来，`git checkout --` 回去就行。
 */
const staticChecks = [
  'check-ipc-channels.mjs',
  'check-pipe-forwarding.mjs',
  'verify-gates-reverse.cjs'
]

console.log('\n> 静态一致性检查\n')
for (const script of staticChecks) {
  const r = spawnSync(process.execPath, [join(HERE, script)], { stdio: 'inherit' })
  if (r.status !== 0) {
    console.error(`\n[run-tests] ${script} 未通过，已中止`)
    process.exit(r.status ?? 1)
  }
}

const rebuildTarget = swapAbi(RUNNER.abi)
if (rebuildTarget !== 0) {
  console.error(`\n[run-tests] 切换到 ${RUNNER.abi} 版原生模块失败，未执行测试`)
  process.exit(rebuildTarget)
}

const vitestCode = runVitest()

// 成败都要还原
const restoreCode = swapAbi('electron')

if (vitestCode !== 0) {
  console.error('\n[run-tests] 测试未通过')
  process.exit(vitestCode)
}
if (restoreCode !== 0) {
  console.error('\n[run-tests] 测试通过，但还原 Electron 版原生模块失败，请手动执行 node scripts/swap-abi.mjs electron')
  process.exit(restoreCode)
}

console.log('\n[run-tests] 测试通过，且已还原 Electron 版原生模块')
