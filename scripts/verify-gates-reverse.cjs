/**
 * 接线闸门的反向验证（1.0.73）
 *
 * 判据：**闸门全绿不算修好，必须证明它认得出违规。**
 * 本项目已经出现过"闸门断言恒真"的假闸门（schema 参数那条），
 * 所以凡是新写的扫描型闸门，都要逐条注入违规、看它变红，
 * 再把文件原样还原。
 *
 * ── 为什么要一个脚本串起来，而不是手工改文件 ──
 *
 * 手工做这件事有三个坑，每一个都会让结论失真：
 *  ① 忘了还原 —— 下次跑闸门直接红，而没人知道是谁改的；
 *  ② 改错位置（尤其同一片段在文件里出现多次时 `replace` 只换第一处）；
 *  ③ 中途打断 —— 文件停在"注入态"，看起来像代码坏了。
 * 脚本把"注入 → 跑 → 还原 → 复跑"焊成一步，任何一步失败都保证还原。
 *
 * ── 两种用例，缺一不可 ──
 *
 * `BREAKS`：注入**真违规** → 闸门**必须变红**（否则闸门是假的）；
 * `NOISE` ：注入**注释里的噪音** → 闸门**必须仍绿**（否则闸门守的是文字不是行为）。
 * 第二种是 2026-10-07 实际踩到的：给组件写说明注释时提到「怎么走过来的」，
 * 一个扫源码的闸门当场变红，而代码一行没动。这种假红会逼人改措辞哄闸门。
 */
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

// 本文件在 scripts/ 下，仓库根是它的上一级
// （原先在 .alice/tmp/ 时是 '../..' —— 挪位置必须同步改，否则全跑空）
const ROOT = path.resolve(__dirname, '..')

/**
 * 一个"闸门 × 用例"组
 *
 * - `gate`：被测闸门文件
 * - `cases`：`[名字, 相对路径, 原文片段, 替换成, 期望]`
 *   期望 Δ = 'red'（违规，闸门应当变红）/ 'green'（噪音，闸门应当仍绿）
 */
const GROUPS = [
  {
    name: '本次变更链路（review-diff-wiring.test.ts）',
    gate: 'tests/main/lib/review-diff-wiring.test.ts',
    cases: [
      [
        '① 写入侧摘掉（repo 不再算字段变更）',
        'src/main/database/todo.repository.ts',
        'const fieldChanges = diffFields(existing, updated)',
        'const fieldChanges = [] as never[]',
        'red'
      ],
      [
        '③ 聚合层摘掉 field 分支',
        'src/main/lib/review-diff.ts',
        "if (e.type === 'todo' && p.action === 'fields_changed') {",
        'if (false as boolean) {',
        'red'
      ],
      [
        '④ 变更记录摘掉 fields_changed（重犯"写了却读不出"）',
        'src/main/lib/audit-text.ts',
        "if (todoPayload.action === 'fields_changed') {",
        'if (false as boolean) {',
        'red'
      ],
      [
        '⑤ IPC 通道摘掉',
        'src/main/ipc.ts',
        "ipcMain.handle('todo:reviewDiff'",
        "ipcMain.handle('todo:reviewDiffX'",
        'red'
      ]
    ]
  },
  {
    name: '时序留痕闸门（audit-timeline.test.ts）',
    gate: 'tests/main/lib/audit-timeline.test.ts',
    cases: [
      [
        '① 真的把翻译搬回渲染层（代码里拼状态标签）',
        'src/renderer/components/quick-add/QuickAddForm.tsx',
        'const handleCancel = () => {',
        'const _injected = STATUS_META[t.fromStatus].label\n  const handleCancel = () => {',
        'red'
      ],
      [
        '② 注释里提到那个词（不该被判违规 —— 剥注释后应仍绿）',
        'src/renderer/components/quick-add/QuickAddForm.tsx',
        'const handleCancel = () => {',
        '/* 这段注释里写了「怎么走过来的」，是说明不是代码 */\n  const handleCancel = () => {',
        'green'
      ]
    ]
  }
]

function runGate(gate) {
  const r = spawnSync(
    process.execPath,
    [
      'node_modules/vitest/vitest.mjs',
      'run',
      gate,
      // ⚠️ 别用 --reporter=basic：vitest 4 已移除它，会以退出码 1 收场，
      //    于是"基线红"是假的、每次注入都"变红"也是假的 —— 整个反向验证恒真。
      //    （2026-10-07 实测踩到，用的 vitest 4.1.5）
      '--reporter=dot'
    ],
    { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  )
  return r.status === 0
}

const all = []

for (const g of GROUPS) {
  console.log(`\n── ${g.name} ──`)
  if (!runGate(g.gate)) {
    console.log('基线就是红的 —— 先修好再来做反向验证')
    process.exit(1)
  }
  console.log('基线：绿')

  for (const [name, rel, from, to, expect] of g.cases) {
    const abs = path.join(ROOT, rel)
    const original = fs.readFileSync(abs, 'utf8')
    if (!original.includes(from)) {
      console.log(`⚠️  [锚点失配] ${name}：在 ${rel} 中找不到要替换的锚点片段，跳过（用例锚点已失配，核对闸门与实现是否已同步）`)
      all.push([g.name, name, 'SKIP', expect])
      continue
    }
    // 注入 → 跑 → **无论如何都还原**
    fs.writeFileSync(abs, original.replace(from, to))
    let green
    try {
      green = runGate(g.gate)
    } finally {
      fs.writeFileSync(abs, original)
    }
    // 期望：注入真违规 → 变红；注入注释噪音 → 仍绿
    const ok = expect === 'red' ? !green : green
    const actual = green ? '绿' : '红'
    console.log(
      `${ok ? '✓' : '✗'} ${name}：闸门${actual}` +
        `（期望${expect === 'red' ? '红' : '绿'}）`
    )
    all.push([g.name, name, ok ? 'PASS' : 'FAIL', expect])
  }

  // 还原后再跑一次，确认没把文件改坏
  const back = runGate(g.gate)
  console.log(`还原后复跑：${back ? '绿（文件完好）' : '红（还原失败，需检查）'}`)
  if (!back) all.push([g.name, '还原复跑', 'FAIL', 'green'])
}

const passed = all.filter(([, , r]) => r === 'PASS')
const skipped = all.filter(([, , r]) => r === 'SKIP')
const failed = all.filter(([, , r]) => r === 'FAIL')
console.log(
  `\n结论：${passed.length}/${all.length} 项反向验证通过` +
    (skipped.length ? `，${skipped.length} 项锚点失配（用例锚点需同步，非闸门失效）` : '') +
    (failed.length ? `，${failed.length} 项闸门失效` : '')
)
process.exit(failed.length || skipped.length ? 1 : 0)
