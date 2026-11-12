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
        // 1.0.142：时间线的渲染从 QuickAddForm 搬进 ChangeStream（卡 35fa2cbc），
        // 闸门跟着搬了，注入目标没跟上 —— 于是这一项"恒绿"（发版实测抓到）。
        'src/renderer/components/quick-add/ChangeStream.tsx',
        '  const diffByAt = useMemo(() => {',
        '  const _injected = STATUS_META[t.fromStatus].label\n  const diffByAt = useMemo(() => {',
        'red'
      ],
      [
        '② 注释里提到那个词（不该被判违规 —— 剥注释后应仍绿）',
        'src/renderer/components/quick-add/ChangeStream.tsx',
        '  const diffByAt = useMemo(() => {',
        '  /* 这段注释里写了「怎么走过来的」，是说明不是代码 */\n  const diffByAt = useMemo(() => {',
        'green'
      ]
    ]
  },
  {
    name: '详情两块外壳（quick-add-detail-shell-1d3d7006.test.tsx）',
    gate: 'tests/renderer/windows/quick-add-detail-shell-1d3d7006.test.tsx',
    cases: [
      [
        '① 抽屉又自己画一枚关闭纽（两枚 ✕ 叠回去，卡 35fa2cbc 的老毛病）',
        'src/renderer/windows/QuickAdd.tsx',
        '        <TodoDetailShell',
        '        <div data-testid="todo-detail-close" />\n        <TodoDetailShell',
        'red'
      ],
      [
        '② 外壳忘了告诉表单"外层有标题条"（表单那枚 ✕ 又叠回来）',
        'src/renderer/components/quick-add/TodoDetailShell.tsx',
        '            hostChrome',
        '',
        'red'
      ],
      [
        '③「放弃修改」不再让表单重挂（独立窗口里那段字下次打开还在）',
        'src/renderer/components/quick-add/TodoDetailShell.tsx',
        '                setResetSeq((n) => n + 1)',
        '',
        'red'
      ],
      [
        '④ 注释里提到关闭纽的 testid（不该被判违规 —— 剥注释后应仍绿）',
        'src/renderer/windows/QuickAdd.tsx',
        '        <TodoDetailShell',
        '        {/* 关闭纽的 testid 是 todo-detail-close，画在共用外壳里 */}\n        <TodoDetailShell',
        'green'
      ]
    ]
  }
,
  {
    name: '新建事项的待挂附件（new-todo-attachments-fc11793f.test.tsx）',
    gate: 'tests/renderer/components/new-todo-attachments-fc11793f.test.tsx',
    cases: [
      [
        '① 选文件那条通道偷偷改成"挑完就挂"（新建时没有 id 可挂）',
        'src/main/ipc.ts',
        "ipcMain.handle('todo:pickFiles'",
        "ipcMain.handle('todo:pickFiles', () => addAttachments('x', [])) || ipcMain.handle('todo:pickFiles'",
        'red'
      ],
      [
        '② 附件没挂上也照关卡片（"哪一份没挂上"随窗口一起没了）',
        'src/renderer/components/quick-add/QuickAddForm.tsx',
        'if (!failed.length) closeDetail()',
        'closeDetail()',
        'red'
      ],
      [
        '③ 提交顺序反过来（先挂附件再建事项）',
        'src/renderer/components/quick-add/QuickAddForm.tsx',
        'const created = await createTodo(',
        'await attachPending(createdId!, pendingAttachments); const created = await createTodo(',
        'red'
      ],
      [
        '④ 新建时又把附件区收起来（要人先点一下才看得见）',
        'src/renderer/components/quick-add/QuickAddForm.tsx',
        '        {!editingTodoId && (\n          <PendingAttachments',
        '        {!editingTodoId && false && (\n          <PendingAttachments',
        'red'
      ],
      [
        '⑤ 收东西时不带已用体积（总量上限那半边判据失效）',
        'src/renderer/components/quick-add/QuickAddForm.tsx',
        'intakeFiles(files, { usedBytes: attachedBytes })',
        'intakeFiles(files)',
        'red'
      ],
      [
        '⑥ 挑了没挂的那条路不按余量筛（对话框选的一批能直接撑破上限）',
        'src/renderer/components/quick-add/QuickAddForm.tsx',
        'fitPickedFiles(picked, attachedBytes)',
        'fitPickedFiles(picked)',
        'red'
      ],
      [
        /**
         * ⑦⑧ 打的是主进程那半边（总量上限的权威判据）。
         *
         * 这两条**挂在渲染层的闸门上**跑，而不是新开一个跑 `attachment.repository.test.ts`
         * 的条目：那个文件要加载 better-sqlite3，只有 Node 22（ABI 127）跑得起来，
         * 而这个脚本用 `process.execPath` 起 vitest —— 本机裸 `node` 是 24，
         * 一挂上去基线就是红的（2026-11-12 实测）。行为层那两条真跑用例在
         * `run-tests` 里（那边按 Node 22 起 vitest），这里管的是"闸门认不认得出"。
         */
        '⑦ 仓储不把已用体积累加下去（同一批里前几份就能撑破上限）',
        'src/main/database/attachment.repository.ts',
        'usedBytes += meta.bytes',
        'usedBytes += 0',
        'red'
      ],
      [
        '⑧ 文件层不判总量（单份之外再没有上限）',
        'src/main/lib/attachments.ts',
        'attachmentTotalTooLargeReason(opts.usedBytes, stat.size, path.basename(srcPath))',
        'attachmentTooLargeReason(stat.size, path.basename(srcPath))',
        'red'
      ]
    ]
  },
  {
    name: '悬浮球面板：项目即视图 / 最新在前 / 完整登记（panel-project-view-4ad4f68d.test.tsx）',
    gate: 'tests/renderer/components/panel-project-view-4ad4f68d.test.tsx',
    cases: [
      [
        '① 排序又翻回正序（最新记的沉到底）',
        'src/renderer/lib/panel-sort.ts',
        'return dayjs(b.createdAt).valueOf() - dayjs(a.createdAt).valueOf()',
        'return dayjs(a.createdAt).valueOf() - dayjs(b.createdAt).valueOf()',
        'red'
      ],
      [
        '② 项目切换只管新增归属、不过滤清单（按钮写着 A、列表里全是 B）',
        'src/renderer/components/panel/PanelContent.tsx',
        '.filter((t) =>\n        currentView.unassigned ? !t.projectId : t.projectId === currentView.id\n      )',
        '.filter((t) => !!t)',
        'red'
      ],
      [
        '③ 面板不把那一句交接出去（点了「完整登记」，字没了）',
        'src/renderer/components/panel/PanelContent.tsx',
        'stageQuickAddTitle(draft)',
        'void draft',
        'red'
      ],
      [
        '④ 完整卡片不取交接来的那一句（卡片开着、标题是空的）',
        'src/renderer/components/quick-add/QuickAddForm.tsx',
        'const stagedTitle = takeStagedQuickAddTitle()',
        "const stagedTitle = ''",
        'red'
      ]
    ]
  },
  {
    /**
     * ⚠️ 这一组打的是**源码闸门**（`attach-command-surface-…`），不是那份行为用例：
     * 行为用例 import 了 better-sqlite3，而本脚本用 `process.execPath` 起 vitest
     * （本机裸 `node` 是 24、ABI 137）—— 挂上去基线就是红的。
     */
    name: 'agent 用附件的命令面（attach-command-surface-89f3b3bc.test.ts）',
    gate: 'tests/main/cli/attach-command-surface-89f3b3bc.test.ts',
    cases: [
      [
        '① 把挂附件的授权档悄悄升成删除档（每次都要人点头）',
        'src/main/cli/commands/todo.ts',
        "    name: 'todo attach',\n    dataShape: 'object',\n    risk: 'write',",
        "    name: 'todo attach',\n    dataShape: 'object',\n    risk: 'destructive',",
        'red'
      ],
      [
        '② 读元数据那条假装没挂东西（空数组）',
        'src/main/cli/commands/todo.ts',
        'const items = ctx.deps.attachmentRepo.list(id)',
        'const items: never[] = []',
        'red'
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
    /**
     * 锚点按 **LF** 比对，写完再还原成这份文件本来的换行
     *
     * 同一份源码在本机是 LF、在 CI 的检出里是 CRLF（2026-11-12 实测：多行锚点在
     * runner 上"锚点失配"→ 这一项判 SKIP → 整轮反向验证以退出码 1 收场）。
     * 单行锚点一直没暴露这个问题，多行锚点一出现就现形了。
     */
    const crlf = original.includes('\r\n')
    const normalized = crlf ? original.replace(/\r\n/g, '\n') : original
    if (!normalized.includes(from)) {
      console.log(`⚠️  [锚点失配] ${name}：在 ${rel} 中找不到要替换的锚点片段，跳过（用例锚点已失配，核对闸门与实现是否已同步）`)
      all.push([g.name, name, 'SKIP', expect])
      continue
    }
    // 注入 → 跑 → **无论如何都还原**
    const injected = normalized.replace(from, to)
    fs.writeFileSync(abs, crlf ? injected.replace(/\n/g, '\r\n') : injected)
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
