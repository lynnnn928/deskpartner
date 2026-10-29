/**
 * 留痕闭环的端到端验收（1.0.62）
 *
 * 验收的判据来自主用户驳回 68c7ccc1 的原话：
 * 「留痕写进去了，但**没有任何地方读得出**，实际效果仍是无痕。」
 *
 * 所以这里不验证"事件有没有写进 events"，而是验证**从界面上做的动作，
 * 能不能被读回来**。三条路径刻意交叉：
 *
 *   界面：新建事项 → 写规格 → 发一条评论 → 删掉它 → 覆写规格
 *   ① 命令行 `todo history` 必须答得出"谁删了哪句""旧规格是什么"
 *   ② 界面 `todo:timeline` 必须答得出同一批事（1.0.62 补的读入口）
 *
 * ⚠️ ② 是本轮新加的一半 —— 上一版只验了 ①，于是"CLI 读得出、界面看不到"
 * 被当成了闭环。判据：**同一个事实，两个人群各自的入口都要读得出。**
 * 只验一个入口=只证明了一半（详见 audit-trail-wiring-check skill）。
 *
 * 交叉的意义在于，同等的动作此前只有 CLI 侧留有痕迹，
 * 界面做的那些一句痕迹都没有 —— 而界面是不看命令行的人在用的入口。
 * 若两侧不对称，这个脚本就会 FAIL。
 *
 * 跑在一次性副本上（withIsolatedApp），生产库不受任何影响。
 *
 * 用法：node scripts/verify-audit-trail.mjs
 */
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { withIsolatedApp } from './lib/isolated-app.mjs'

const TITLE = '__AUDIT_PROBE__ 留痕闭环验证'
const DESC_OLD = '第一版规格：只做 A，不做 B'
const DESC_NEW = '第二版规格：改成 B，放弃 A'
const COMMENT = '这句是被删掉的承诺原文：我承诺把 A 改成 B，代价是 C'

const APP = process.cwd()

function cli(dataDir, args) {
  const r = spawnSync(process.execPath, [join(APP, 'out', 'cli', 'deskpartner.cjs'), ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: APP,
    timeout: 30000,
    env: { ...process.env, DESKPARTNER_DATA_DIR: dataDir, DESKPARTNER_NO_PIPE: '1' }
  })
  return { code: r.status ?? 1, stdout: r.stdout || '', stderr: r.stderr || '' }
}

const failures = []
function expectFound(label, lines, kind, needle) {
  const hit = lines.find((l) => l.kind === kind && l.what.includes(needle))
  if (hit) {
    console.log(`  PASS  ${label}：${hit.what}`)
  } else {
    failures.push(`${label}：流水里找不到包含「${needle}」的「${kind}」记录`)
  }
}

await withIsolatedApp(
  async ({ dataDir, evaluate }) => {
    // 实例起来后会自己跳一次视图，等它稳住再求值
    await new Promise((r) => setTimeout(r, 2500))

    const made = await evaluate(`
      (async () => {
        const t = await window.api.invoke('todo:create', {
          title: ${JSON.stringify(TITLE)},
          description: ${JSON.stringify(DESC_OLD)}
        })
        if (!t.ok) return { step: 'create', err: t.message || 'unknown' }
        const id = t.data.id
        const c = await window.api.invoke('todo:addComment', {
          todoId: id, body: ${JSON.stringify(COMMENT)}
        })
        if (!c.ok) return { step: 'addComment', err: c.message || 'unknown' }
        const d = await window.api.invoke('todo:deleteComment', { id: c.data.id })
        if (!d.ok) return { step: 'deleteComment', err: d.message || 'unknown' }
        const u = await window.api.invoke('todo:update', {
          id, description: ${JSON.stringify(DESC_NEW)}
        })
        if (!u.ok) return { step: 'update', err: u.message || 'unknown' }
        return { step: 'done', id }
      })()
    `)

    if (!made || made.step !== 'done') {
      throw new Error(`界面动作闭环未完成: ${JSON.stringify(made)}`)
    }
    console.log(`界面账本动作已完成（事项 ${made.id.slice(0, 8)}）`)

    // ① 命令行读得回（CLI 人群的入口）
    const res = cli(dataDir, ['todo', 'history', made.id])
    if (res.code !== 0) throw new Error(`todo history 失败: ${res.stdout || res.stderr}`)

    const parsed = JSON.parse(res.stdout)
    const lines = parsed?.data?.audit ?? []
    if (!lines.length) throw new Error('流水为空 —— 读侧没有任何东西')

    console.log('命令行读回来的流水：')
    expectFound('界面删评论留痕', lines, '删评论', '我承诺把 A 改成 B')
    expectFound('界面改规格留痕', lines, '改描述', '第一版规格：只做 A')

    // ② 界面自己也要读得回（人这个人群的入口）—— 上一版漏掉的这一半
    const uiRes = await evaluate(`
      (async () => {
        const r = await window.api.invoke('todo:timeline', { todoId: ${JSON.stringify(made.id)} })
        return r.ok
          ? { ok: true, lines: r.data.map(x => ({ kind: x.kind, what: x.what, seq: x.timelineSeq })) }
          : { ok: false, err: r.message || 'unknown' }
      })()
    `)

    if (!uiRes?.ok) throw new Error(`界面 todo:timeline 失败: ${JSON.stringify(uiRes)}`)
    const uiLines = uiRes.lines ?? []
    if (!uiLines.length) throw new Error('界面的变更记录为空 —— 人这个入口仍然读不出')

    console.log('界面自己读回来的变更记录：')
    expectFound('界面删评论留痕', uiLines, '删评论', '我承诺把 A 改成 B')
    expectFound('界面改规格留痕', uiLines, '改描述', '第一版规格：只做 A')

    // timelineSeq 必须是从 0 起的连续序号（展示层照它排，不按时间戳重排）
    const seqs = uiLines.map((l) => l.seq)
    const expected = seqs.map((_, i) => i)
    if (JSON.stringify(seqs) !== JSON.stringify(expected)) {
      failures.push(`timelineSeq 不连续：得到 ${JSON.stringify(seqs)}`)
    } else {
      console.log(`  PASS  序号连续：${JSON.stringify(seqs)}`)
    }
  },
  { port: 9481 }
)

console.log('─'.repeat(58))
if (failures.length) {
  console.log('FAIL  界面上做的改动，读不回来：')
  for (const f of failures) console.log(`      · ${f}`)
  process.exit(1)
}
console.log('PASS  界面路径的删评论与改规格，命令行与界面都能读回原始内容')
console.log('      → 两个人群各自的入口同一种待遇，不再只修一半')
process.exit(0)
