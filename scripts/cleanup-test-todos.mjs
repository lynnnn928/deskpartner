/**
 * 探针残留**扫描**（只读）—— 2026-09-29 决策 A 之后，它不再负责删除
 *
 * ── 为什么删掉了"清理"这个职责 ──
 *
 * 这个脚本原来靠标题正则去**生产库**里捞探针再逐条 `todo rm` 掉。后果实测：
 * - 探针从一开始就写进她的真实看板（要先弄脏再擦）
 * - 删除走 CLI 的 destructive 档 → 每轮都要向她申请"一次性删除授权"
 *   实测累计 **68 条销毁授权**（15 条过期未处理），而 events 里
 *   `todo_deleted` **只有 4 次**
 * - 根因不是审批太重，是**粒度错了**：删掉看板最重要的父需求，
 *   和删掉 5 分钟前刚造的探针，同档同待遇
 *
 * 现在验证流程整体跑在一次性副本上（`scripts/lib/isolated-app.mjs`），
 * 副本用完**连目录一起删** —— 那是一整个临时目录，不需要任何授权。
 * 于是"逐条清理"这件事**从流程里消失了**，本脚本也就没有删除可做。
 *
 * ── 它现在还留着干什么 ──
 *
 * `--audit`：只读扫一遍生产库，把**历史上积累下来的**残留列出来。
 * 那是决策 A 之前留下的痕迹，需要她/我知道有哪些、再由人决定怎么处理。
 *
 * 🚨 它**不接受任何"直接删生产库"的用法** —— 那是这条路走到现在的根因。
 */
import { existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP_DIR = resolve(HERE, '..')

/** 历史上用过的探针标题特征（含她自己标注的"本轮清"尾巴） */
const PATTERNS = [
  /^__/,
  /__CLI_TEST_/,
  /__CARD_RENDER_PROBE__/,
  /__DETAIL_TEST__/,
  /__SCHEMA_PROBE__/,
  /__SPIKE_/,
  /__VIS_/,
  /__BATCH_/,
  /__ISOLATED_PROBE__/,
  /__REFRESH_/,
  /^DBG_/,
  /^【e2e】/,
  /（本轮清）$/ // 标记为"本轮清理"的一次性探针
]

const PY =
  process.env.DESKPARTNER_PY ||
  const pyBin = existsSync(PY) ? PY : 'python'

const REAL = process.env.DESKPARTNER_REAL_DATA_DIR || join(process.env.APPDATA || '', 'desk-partner')
const DB = join(REAL, 'user.db')

function isProbe(title) {
  return PATTERNS.some((re) => re.test(title || ''))
}

function audit() {
  if (!existsSync(DB)) {
    console.error(`找不到生产库：${DB}`)
    process.exitCode = 1
    return
  }

  /**
   * ⚠️ 用 Python 而不是 `sqlite3` CLI / Node：本机的 better-sqlite3 是按
   * Electron ABI 编译的，纯 Node 打不开；而且 `-wal` 里可能还有未落盘的数据，
   * Python 的 sqlite3 能正常读到。全程 `mode=ro` 只读。
   */
  const py = `
import sqlite3, json
d = sqlite3.connect(r'file:${DB.replace(/\\/g, '/')}?mode=ro', uri=True)
rows = d.execute("select id, title, status, created_at from todos").fetchall()
print(json.dumps([{'id': r[0][:8], 'title': r[1], 'status': r[2], 'at': (r[3] or '')[:10]} for r in rows]))
`
  let all
  try {
    /**
     * 🚨 `stdio` 必须显式声明（2026-10-01 修复，本脚本从 1.0.61 起一直静默失效）。
     *
     * 不声明时 spawnSync 走默认管道，在受限环境下直接 **EBUSY**，`r.stdout` 是
     * `undefined` → JSON.parse 抛错 → 被下面的 catch 包成「读取生产库失败」。
     *
     * 这个失败态骗人的地方在于：**它看起来像"库读不了"，实际是"子进程根本没起来"**。
     * 而本脚本是只读审计、又包了异常处理，于是它一直安静地返回"读取失败"，
     * 没人会去追 —— 一条只读审计静默失效，等于观察标的永远拿不到数字。
     *
     * 本文件是第三处踩到同一个坑（前两处：scripts/lib/exe-version.mjs、
     * 以及 release.mjs 的 git 闸门）。判据已写进 MEMORY.md：**探测/闸门类脚本
     * 的 stdio 一律显式写死**。见 tests/main/lib/spawn-stdio-guard.test.ts。
     */
    const r = spawnSync(pyBin, ['-c', py], {
      encoding: 'utf8',
      timeout: 30000,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    if (r.error) throw new Error(`子进程未启动：${r.error.code || r.error.message}`)
    const out = (r.stdout || '').trim()
    if (!out) throw new Error(`子进程无输出（stderr: ${(r.stderr || '').trim().slice(0, 200)}）`)
    all = JSON.parse(out)
  } catch (e) {
    console.error(`读取生产库失败：${e.message}`)
    process.exitCode = 1
    return
  }

  const junk = all.filter((t) => isProbe(t.title))
  console.log(`生产库共 ${all.length} 条，其中匹配探针特征的 ${junk.length} 条：`)
  for (const j of junk) console.log(`   ${j.id}  [${j.status}]  ${j.at}  ${(j.title || '').slice(0, 46)}`)
  if (junk.length === 0) console.log('   （无）')

  console.log(
    '\n本模式**只读**，不做任何删除。\n' +
      '现在验证流程已跑在一次性副本上（副本用完整体删除），正常不会再有新增残留；\n' +
      '上面这些是历史积累的，可以在界面上自行处置。'
  )
}

if (process.argv.includes('--audit')) audit()
else {
  console.log(
    '本脚本已不再做删除（决策 A：可复现验证环境）。\n' +
      '验证现在跑在一次性副本上，副本用完整体删除 —— 逐条清理这件事已从流程里消失。\n\n' +
      '要看历史残留：node scripts/cleanup-test-todos.mjs --audit'
  )
}
