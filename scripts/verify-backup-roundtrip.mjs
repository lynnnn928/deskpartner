/**
 * 备份「导出 → 清空 → 导入」往返验收（1.0.49，Bob 65e5ebc7）
 *
 * ── 它补的是什么 ──
 *
 * `tests/main/services/backup.drill.test.ts` 用的是**合成 fixture**
 * （形状按真实统计复刻，内容全造的）。它保证了"形状不退化"，
 * 但答不了Bob提的那个问题：**真库导出的那份 JSON，导回去还一样吗。**
 *
 * 两者缺一不可：fixture 任何机器都跑得住（所以进 npm test）；
 * 真数据往返依赖本机真库（所以不进 npm test，做成独立命令）。
 *
 * ── 用法 ──
 *
 *   node scripts/verify-backup-roundtrip.mjs
 *
 * 全程只读真库：
 * 1. 用 sqlite backup API 取一份**一致性副本**（不是 copyFile —— 那会丢 -wal 里的事务）
 * 2. 在副本上跑往返，真库一个字节都不动
 * 3. 输出差异报告；差异为 0 才算通过
 *
 * ⚠️ 为什么不直接 copyFile 真库：
 * WAL 模式下最新事务可能还在 `-wal` 里没 checkpoint，只拷主文件会
 * 拿到一份**旧的**数据 —— 那样比出来的"一致"是假的。
 *
 * ⚠️ 为什么不只看 vitest 退出码：
 * "整组被 skip"时 vitest 退出码是 0。所以脚本还要数一遍真正跑过的
 * 用例条数（要求 >= 4 且 skipped == 0），否则就是 8e238221 那种
 * "静默跳过还全绿"换个地方重演。
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

/** 真库位置（可用 DESKPARTNER_DRILL_SRC 覆盖） */
const SRC_DB =
  process.env.DESKPARTNER_DRILL_SRC ||
  path.join(os.homedir(), 'AppData', 'Roaming', 'desk-partner', 'user.db')

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-roundtrip-'))
const COPY_DB = path.join(WORK, 'live-copy.db')

function die(msg) {
  console.error(`\n[往返验收] ${msg}\n`)
  // 1.0.62：不再删工作目录（现场留给人偶尔清一次），见文件末尾的说明
  process.exit(1)
}

if (!fs.existsSync(SRC_DB)) {
  die(`找不到真库：${SRC_DB}\n  若已换机或改了数据目录，用 DESKPARTNER_DRILL_SRC 指过去。`)
}

/**
 * 用 Python 的 sqlite3 backup API 取一致性副本。
 *
 * 为什么借 Python 而不是在 Node 里做：本仓库的 better-sqlite3 是按
 * Electron ABI 编的，纯 Node 加载会报版本不符；而 Python 自带 sqlite3，
 * 与 ABI 无关。这里只是复制，不涉及任何业务逻辑。
 */
const py = spawnSync(
  'python',
  [
    '-c',
    `
import sqlite3, sys
src, dst = sys.argv[1], sys.argv[2]
s = sqlite3.connect('file:%s?mode=ro' % src.replace('\\\\', '/'), uri=True)
d = sqlite3.connect(dst)
s.backup(d)
d.close(); s.close()
print('ok')
`,
    SRC_DB,
    COPY_DB
  ],
  {
    encoding: 'utf8',
    // 🚨 必须显式声明 stdio：默认管道在受限环境下 EBUSY，py.stdout 会是 undefined，
    // 而下面判的是 py.status —— 两个都拿不到时，"复制失败"和"进程没起来"分不清。
    stdio: ['ignore', 'pipe', 'pipe'],
    // 卡 3766c307：这条也被发版链调，挂住同样是"永远不结束"（复制的库约 5 MB，
    // 卡住只可能是真库被别的进程锁着）
    timeout: 120_000
  }
)
if (py.error?.code === 'ETIMEDOUT') {
  die('取真库一致性副本超时（120s）—— python 那边卡住了，真库多半被别的进程锁着')
}
if (py.status !== 0 || !fs.existsSync(COPY_DB)) {
  die(`复制真库失败：${(py.stderr || '').trim().slice(0, 400)}`)
}

const sizeMB = (fs.statSync(COPY_DB).size / 1024 / 1024).toFixed(1)
console.log(`\n[往返验收] 真库一致性副本已取：${COPY_DB}（${sizeMB} MB）`)
console.log('[往返验收] 真库全程只读，一个字节都不会动。\n')

// ── 切到 Node 版 ABI → 跑 vitest → 无论成败还原 ──
// 受管 Node 目录会随着运行时更新改变后缀，不能硬编码某一份补丁目录。
function resolveNode22() {
  if (process.env.DESKPARTNER_NODE22 && fs.existsSync(process.env.DESKPARTNER_NODE22)) {
    return process.env.DESKPARTNER_NODE22
  }
  if (process.versions.modules === '127') {
    return process.execPath
  }
  const home = process.env.USERPROFILE || process.env.HOME || ''
  try {
    for (const d of fs.readdirSync(home, { withFileTypes: true })) {
      if (!d.isDirectory() || !d.name.startsWith('.')) continue
      const versionsDir = path.join(home, d.name, 'binaries', 'node', 'versions')
      if (!fs.existsSync(versionsDir)) continue
      const candidates = fs.readdirSync(versionsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && /^22\./.test(e.name))
        .map((e) => path.join(versionsDir, e.name, 'node.exe'))
        .filter((p) => fs.existsSync(p))
        .sort((a, b) => {
          const n = (p) => Number(p.match(/-(\d+)[/\\]node\.exe$/)?.[1] ?? 0)
          return n(a) - n(b)
        })
      if (candidates.length > 0) return candidates[candidates.length - 1]
    }
  } catch {
    /* fall through */
  }
  throw new Error('找不到 Node 22 运行时（ABI 127）—— 请使用 Node 22 或设置 DESKPARTNER_NODE22')
}
const NODE22 = resolveNode22()
const VITEST = path.join(ROOT, 'node_modules/vitest/vitest.mjs')
const SPEC = path.join(ROOT, 'tests/main/services/backup.roundtrip.test.ts')

function swap(target) {
  const r = spawnSync(process.execPath, [path.join(HERE, 'swap-abi.mjs'), target], {
    stdio: 'inherit',
    timeout: 120_000 // 卡 3766c307：解开压缩包不该超过两分钟
  })
  return r.status ?? 1
}

console.log('> 切换原生模块 ABI → node')
if (swap('node') !== 0) die('切换到 Node 版原生模块失败，未执行验收')

console.log('> 用真库副本跑往返\n')
/**
 * ⚠️ 这里刻意**不**用 stdio:'inherit'，而是把输出接回来自己看。
 *
 * 原因：vitest 在"整组被 skip"时退出码是 **0**。
 * 若环境变量名漂了、或测试文件的 `describe.skip` 判据失效，
 * 就会 0 条用例 + 退出 0 → 脚本报"通过"，而实际什么都没验。
 * 这正是 8e238221 的同构风险（静默跳过还全绿），不能在新命令里重演。
 * 所以下面除了看退出码，还要数一遍**真正跑过的用例条数**。
 */
const run = spawnSync(NODE22, [VITEST, 'run', SPEC], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
  stdio: ['ignore', 'pipe', 'pipe'],
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, DESKPARTNER_DRILL_DB: COPY_DB },
  cwd: ROOT,
  // 卡 3766c307：这条整组实测约 4 秒，给 15 分钟是"绝不无限等"的上界
  timeout: 900_000
})
if (run.stdout) process.stdout.write(run.stdout)
if (run.stderr) process.stderr.write(run.stderr)

console.log('\n> 还原原生模块 ABI → electron')
const restored = swap('electron')

/**
 * 1.0.62：不再清理 WORK。
 *
 * 原先这里（以及 die 分支里）会 `rmSync(WORK)` —— 每跑一次往返验收就删一次
 * 临时目录。这件事的代价不在磁盘，而在沙箱闸门：累计删除量到阈值就会
 * 把开发任务掐断、去等人授权，而授权这件事本身要花人的时间。
 *
 * 临时目录落在系统 tmp 下，由操作系统按自己的节奏回收即可；
 * 留在那里既不影响验收结论，也不会被误当成产物。
 * 想立刻清就手动删一次 —— 那是一次性的决定，不该焊进每轮自动化的收尾。
 */
console.log(`\n[往返验收] 工作目录保留在 ${WORK}（不再自动清理）`)

// ⚠️ 超时要报成"它没回来"，不要报成"用例失败" —— status 是 null 时两句都真，
// 但只有前一句指向真实原因（卡 3766c307 的判据：拿没拿到输出比干等有用）
if (run.error?.code === 'ETIMEDOUT') {
  die('往返用例超过 900s 没跑完（已掐断）—— 不是用例失败，是它没回来')
}
if (run.status !== 0) die('往返验收未通过（详见上方差异报告）')
if (restored !== 0) {
  die('验收通过，但还原 Electron 版原生模块失败，请手动跑 node scripts/swap-abi.mjs electron')
}

/**
 * 「闸门的闸门」：确认真的跑了用例，而不是整组被跳过。
 *
 * 判据取 `Tests  N passed` 里的 N，要求 N >= 4（本文件现有 4 条）。
 * 少于 4 条 = 有用例没执行（跳过 / 判据失效 / 文件被改），一律视为失败。
 * 与测试文件里"副本必须非空"那条断言合起来，堵住"0 vs 0 空转全绿"。
 *
 * ⚠️ 必须先把 ANSI 色码剥掉再匹配：vitest 给 `Tests` 与数字分别上了色，
 * 色码夹在中间会让 `Tests\s+\d+` 直接匹配不上（实测踩过一次，
 * 结果正常通过的那次反被判成"0 条用例"）。
 */
const clean = `${run.stdout ?? ''}\n${run.stderr ?? ''}`.replace(/\x1b\[[0-9;]*m/g, '')
const passed = Number((clean.match(/Tests\s+(\d+)\s+passed/) ?? [])[1] ?? 0)
const skipped = Number((clean.match(/Tests\s+(\d+)\s+skipped/) ?? [])[1] ?? 0)

const EXPECTED_MIN = 4
if (passed < EXPECTED_MIN) {
  die(
    `只跑了 ${passed} 条用例（期望 >= ${EXPECTED_MIN}），` +
      `skipped=${skipped} —— 整组可能被跳过了，这次验收不算数。\n` +
      `  多半是 DESKPARTNER_DRILL_DB 没传进去，或测试文件的 skip 判据失效。`
  )
}
if (skipped > 0) {
  die(`有 ${skipped} 条用例被跳过 —— 往返验收必须是全量执行，不允许跳过。`)
}

console.log(`\n[往返验收] 通过：真库数据导出后原样导入，逐字段无差异（实跑 ${passed} 条用例）。\n`)
