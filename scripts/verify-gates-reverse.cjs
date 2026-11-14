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
 *
 * `原文片段` 可以是一段字符串（占大多数），也可以是**正则**；
 * `替换成` 可以是字符串，也可以是 `(matched) => string` 的函数。
 *
 * 为什么要这两种写法（2026-11-14，清单顺序那组）：那组用例要求"挪的是真实的一行"，
 * 而真实的一行很长、会随文案改。正则只钉住那一行的开头，函数按行取正文再重排 ——
 * 用例里没有一句是作者编的假文本，文案改了也不会变成「锚点失配」，
 * 除非真那一行没了（那时它本来就该失配）。
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
      ],
      [
        '③ 读内容那条悄悄变成要授权的写档（读一张截图也要人点头）',
        'src/main/cli/commands/todo.ts',
        "    name: 'todo attachment',\n    dataShape: 'object',\n    readOnly: true,",
        "    name: 'todo attachment',\n    dataShape: 'object',",
        'red'
      ],
      [
        '④ MCP 不再把图片读成内容块（模型只拿到路径，看不见图）',
        'src/cli/mcp-server.ts',
        'const image = inlineImageOf(result)',
        'const image = null',
        'red'
      ]
    ]
  },
  {
    /**
     * 清单顺序必须与开场提示词一致（2026-11-14，卡 `a19054a1`）
     *
     * 这是**源码闸门**：只读提示词与清单两个文件，不碰数据库，所以能挂在
     * `process.execPath` 起的 vitest 上（bare node 起 better-sqlite3 会红）。
     *
     * ── 为什么这一组全改成「挪真行」（2026-11-14，fable-5.2 复核）──
     *
     * 上一版的 ① 是**作者设想出来的违规**：往提示词里塞一句「先 project add」，
     * 而 `project add` 在两版全流程提示词里根本不存在（它只活在
     * `buildFirstProjectPrompt` / `buildProjectPrompt` 里）。这种用例只能证明
     * "闸门会读那串字"，不能证明"闸门认得出真挪了一步"。
     * 现在每条都拿提示词里**真实存在的那几行**做：挪、删、复制，正文一个字不编。
     */
    name: '清单顺序 = 开场提示词顺序（onboarding-order-matches-prompt.test.ts）',
    gate: 'tests/renderer/lib/onboarding-order-matches-prompt.test.ts',
    /** 这一组的每条红都要说出「为什么红」（见下面循环里的说明） */
    requireReason: true,
    cases: [
      [
        '① 把项目那一步剪到档案之前（真实三行重排，编号留在原地 —— 主用户否掉的顺序）',
        'src/renderer/lib/onboarding-prompts.ts',
        /^4\. 在对话中与主用户确认[\s\S]*?^6\. 询问主用户是否要把现有项目登记[^\n]*$/m,
        /** 取匹配到的三行正文本体，按 6 → 4 → 5 重排，编号照旧从 4 开始编 */
        (matched) =>
          [2, 0, 1]
            .map((from, i) => `${4 + i}. ${matched.split('\n')[from].replace(/^\d+\.\s+/, '')}`)
            .join('\n'),
        'red',
        '编号步骤的顺序与清单顺序不一致'
      ],
      [
        '② 把「接手说明」那一步整行删掉（编号跟着断 → 编号连续性判红）',
        'src/renderer/lib/onboarding-prompts.ts',
        /^6\. 询问主用户是否要把现有项目登记[^\n]*\n/m,
        '',
        'red',
        '编号必须从 1 开始连续'
      ],
      [
        '③ 把「协作约定」的正文又抄进下一步（同一件事写了两遍 → 锚点命中 2 个编号步骤）',
        'src/renderer/lib/onboarding-prompts.ts',
        /^(5\. 与主用户确认协作协议内容[^\n]*)\n(6\. 询问主用户是否要把现有项目登记[^\n]*)$/m,
        (matched) => {
          const [fifth, sixth] = matched.split('\n')
          return `${fifth}\n${sixth}${fifth.replace(/^5\.\s+/, '')}`
        },
        'red',
        '命中了 2 个编号步骤'
      ],
      [
        /**
         * 复审 round 3 第 2 节给的 P1：另插一步只讲"建项目"。
         *
         * 清单第 5 步的锚点是「接手说明」，这种插法命不中任何锚点，
         * 顺序看起来一点没变 —— 上一版闸门在这里是绿的。现在靠
         * 「讲建项目的步骤必须排在档案与约定之后」判红。
         */
        '④ 另插一步只讲建项目（排在档案之前 —— P1）',
        'src/renderer/lib/onboarding-prompts.ts',
        /^3\. 获批后读取用户档案[\s\S]*?^7\. 完成后回读[^\n]*$/m,
        (matched) => {
          const lines = matched.split('\n')
          const first = Number((lines[0].match(/^\d+/) ?? [0])[0])
          const bodies = ['逐个建项目。', ...lines.map((line) => line.replace(/^\d+\.\s+/, ''))]
          return bodies.map((body, i) => `${first + i}. ${body}`).join('\n')
        },
        'red',
        '在档案与约定之前就提到了项目/交接'
      ],
      [
        /** 复审第二轮 P3：在第 3 步末尾补一句"若还没有项目，先 project add" */
        '⑤ 第 3 步末尾补一句「若还没有项目，先 project add」（P3）',
        'src/renderer/lib/onboarding-prompts.ts',
        /^3\. 获批后读取用户档案[^\n]*$/m,
        (matched) => `${matched}若还没有项目，先 project add 建一个。`,
        'red',
        '在档案与约定之前就提到了项目/交接'
      ],
      [
        /**
         * 复审第二轮 P4：把「获批后先 project add」写进【硬要求】
         *
         * ⚠️ 锚点必须**把结尾那个反引号留在外面**（`[^\n`]*`）：HARD_RULES 的最后一行
         * 以 `。\`` 收尾，用 `[^\n]*$` 会把反引号一起吃进匹配，新加的第 10 条就落到
         * 模板字符串外面 —— 文件语法错误、vitest 一律红，于是这条用例**恒红**，
         * 什么都没验证（复审 round 3 第三轮逐条查过：把注入换成一句无害的话照样红）。
         */
        '⑥ 在【硬要求】里加一条「获批后先 project add 建第一个项目」（P4）',
        'src/renderer/lib/onboarding-prompts.ts',
        /^(9\. 只使用产品中真实存在的命令[^\n`]*)/m,
        (matched) => `${matched}\n10. 获批后先 project add 建第一个项目。`,
        'red',
        '与冻结原文不一致'
      ],
      [
        /** 复审第二轮 P5：编号重号（两个「4.」） */
        '⑦ 编号重号：把「协作约定」那一步的编号改成 4（P5）',
        'src/renderer/lib/onboarding-prompts.ts',
        /^5\. 与主用户确认协作协议内容/m,
        '4. 与主用户确认协作协议内容',
        'red',
        '编号必须从 1 开始连续'
      ],
      [
        /** 复审第二轮 Q3：在「请按以下顺序工作」**上面**加一段「先 project add」 */
        '⑧ 步骤段上方加一段「获批后第一件事：先 project add」（Q3）',
        'src/renderer/lib/onboarding-prompts.ts',
        '请按以下顺序工作：',
        '获批后第一件事：先 project add 把项目建出来。\n\n请按以下顺序工作：',
        'red',
        '与冻结原文不一致'
      ],
      [
        /** 复审第二轮 Q4：步骤段里插一条子弹行 */
        '⑨ 第 3 步下面插一条子弹行「- 获批后先 project add」（Q4）',
        'src/renderer/lib/onboarding-prompts.ts',
        /^3\. 获批后读取用户档案[^\n]*$/m,
        (matched) => `${matched}\n- 获批后先 project add`,
        'red',
        '不是编号步骤'
      ],
      [
        /** 复审第二轮 Q9：命令名里两个空格也照样算「先建项目」 */
        '⑩ 「project  add」（两个空格）写进第 3 步（Q9）',
        'src/renderer/lib/onboarding-prompts.ts',
        /^3\. 获批后读取用户档案[^\n]*$/m,
        (matched) => `${matched}随后 project  add 把项目建出来。`,
        'red',
        '在档案与约定之前就提到了项目/交接'
      ],
      [
        /** P2：只把第 6 行挪到第 4 行前面、编号不动 —— 助手读到的先后变了 */
        '⑪ 只把第 6 行挪到第 4 行前面、编号不动（P2）',
        'src/renderer/lib/onboarding-prompts.ts',
        /^4\. 在对话中与主用户确认[\s\S]*?^6\. 询问主用户是否要把现有项目登记[^\n]*$/m,
        (matched) => {
          const lines = matched.split('\n')
          return [lines[2], lines[0], lines[1]].join('\n')
        },
        'red',
        '编号必须从 1 开始连续'
      ],
      [
        /**
         * 纯搬家：把 `buildFirstProjectPrompt` 的**定义**整个提到
         * `buildMigratePrompt` 前面。提示词一个字没改，助手拿到的东西一模一样。
         *
         * 上一版闸门在这里**是红的**（它在文件里找首次出现位置，`project add`
         * 一旦提前，全文件顺序就变了），而它真正该守的东西一点没变。
         * 这一条就是那个假红的回归用例。
         */
        '⑫ 只把函数定义搬了位置（提示词一个字没改，不该变红）',
        'src/renderer/lib/onboarding-prompts.ts',
        /^export function buildMigratePrompt\([\s\S]*$/m,
        (matched) => {
          const chunks = matched.split(/(?=^export function )/m)
          const at = chunks.findIndex((c) => c.startsWith('export function buildFirstProjectPrompt'))
          const moved = chunks.splice(at, 1)[0]
          return [moved, ...chunks].join('')
        },
        'green'
      ],
      [
        '⑬ 注释里写反序命令（说明文字不该把闸门惹红）',
        'src/renderer/lib/onboarding-prompts.ts',
        'const HARD_RULES = `',
        '// 反例（只是注释）：project add 早于 profile propose 也不是产品顺序\nconst HARD_RULES = `',
        'green'
      ],
      /**
       * ── 第三轮补的四条：都是复审第三轮自己试出来的、上一版判绿的写法 ──
       *
       * 前三条打的是步骤段**以外**，第四条打的是 B 的 `project\s` —— MCP 里建项目的
       * 工具叫 `create_project`，下划线不是空白。
       *
       * ⚠️ 段外那几条（⑥⑧⑭⑮⑰⑱⑲⑳）红的原因现在统一是「与冻结原文不一致」：
       * 第四轮复审试了 20 种写法、18 种绕过了词表，于是那三块改成**冻结原文**
       * （`tests/renderer/fixtures/onboarding-prompt-outside.json`），不再判词。
       */
      [
        '⑭ 标题行里夹一句「（获批后先 project add 建第一个项目）」（标题行也是段外）',
        'src/renderer/lib/onboarding-prompts.ts',
        '请按以下顺序工作：',
        '请按以下顺序工作（获批后先 project add 建第一个项目）：',
        'red',
        '与冻结原文不一致'
      ],
      [
        '⑮ 开头一段写「获批后先 Project add」（大写 —— 上一版 C 没有 /i）',
        'src/renderer/lib/onboarding-prompts.ts',
        '你是 DeskPartner 的协作 agent。主用户已有 AI 助手使用经验',
        '获批后先 Project add 把项目建出来。\n\n你是 DeskPartner 的协作 agent。主用户已有 AI 助手使用经验',
        'red',
        '与冻结原文不一致'
      ],
      [
        '⑯ 第 3 步补一句「然后先调 create_project」（MCP 的工具名，下划线不是空白）',
        'src/renderer/lib/onboarding-prompts.ts',
        /^3\. 获批后读取用户档案[^\n]*$/m,
        (matched) => `${matched}然后先调 create_project。`,
        'red',
        '在档案与约定之前就提到了项目/交接'
      ],
      [
        '⑰ 【硬要求】加一条「获批后先开个项目，档案回头再补」',
        'src/renderer/lib/onboarding-prompts.ts',
        /^(9\. 只使用产品中真实存在的命令[^\n`]*)/m,
        (matched) => `${matched}\n10. 获批后先开个项目，档案回头再补。`,
        'red',
        '与冻结原文不一致'
      ],
      /**
       * ── 第四轮补的三条：复审第四轮自己试出来、白名单仍判绿的写法 ──
       *
       * 它们都不用禁词表里的词：一个是同义词（立项），一个是全角字母，
       * 一个是**借豁免短语**（「接手说明」是允许的，于是整句都被放过）。
       * 冻结原文之后这三种照样红 —— 不判词，就没有"换个说法"这条路。
       */
      [
        '⑱ 【硬要求】加一条「获批后先立项」（同义词，禁词表里没有"立项"）',
        'src/renderer/lib/onboarding-prompts.ts',
        /^(9\. 只使用产品中真实存在的命令[^\n`]*)/m,
        (matched) => `${matched}\n10. 获批后先立项。`,
        'red',
        '与冻结原文不一致'
      ],
      [
        '⑲ 【硬要求】写全角「ｐｒｏｊｅｃｔ ａｄｄ」（全角字母，禁词表匹配不到）',
        'src/renderer/lib/onboarding-prompts.ts',
        /^(9\. 只使用产品中真实存在的命令[^\n`]*)/m,
        (matched) => `${matched}\n10. 获批后先 ｐｒｏｊｅｃｔ ａｄｄ。`,
        'red',
        '与冻结原文不一致'
      ],
      [
        '⑳ 借豁免短语：【硬要求】第 7 条改成「接手说明先于档案提交」（"接手说明"本来是允许的）',
        'src/renderer/lib/onboarding-prompts.ts',
        /^7\. 档案、协议、接手说明只能通过提议提交[^\n]*$/m,
        '7. 接手说明先于档案提交，档案回头再补。',
        'red',
        '与冻结原文不一致'
      ],
      /**
       * ── 第五轮补的两条：冻结只覆盖了 null 那一份时的洞 ──
       *
       * `envLine` 只在 `cliEnvAvailable` 为真时出现，而界面复制给用户的正是
       * `buildMigratePrompt(access)`。这两条都只改"带本机地址"那一份，
       * 上一版快照只冻了 null 那一份，所以它们当时是绿的。
       */
      [
        '㉑ 往 envLine「本机已配好环境变量…」里塞一句「获批后先 project add」',
        'src/renderer/lib/onboarding-prompts.ts',
        '等价写法不怕安装目录搬家：node "$${envVar}" skill）',
        '等价写法不怕安装目录搬家：node "$${envVar}" skill；获批后先 project add）',
        'red',
        '与冻结原文不一致'
      ],
      [
        '㉒ 命令行那一步挂个条件：有本机地址时多说一句「获批后先 project add」',
        'src/renderer/lib/onboarding-prompts.ts',
        '2. 命令行：node ${JSON.stringify(cli)} skill${envLine}',
        "2. 命令行：node ${JSON.stringify(cli)} skill${envLine}${access ? '\\n获批后先 project add 建第一个项目' : ''}",
        'red',
        '与冻结原文不一致'
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
  /** 输出一起带回去：只看退出码的话，注入写坏了文件（语法错误）也会"红" */
  return { green: r.status === 0, output: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

const all = []

for (const g of GROUPS) {
  console.log(`\n── ${g.name} ──`)
  const baseline = runGate(g.gate)
  if (!baseline.green) {
    console.log('基线就是红的 —— 先修好再来做反向验证')
    process.exit(1)
  }
  console.log('基线：绿')

  for (const [name, rel, from, to, expect, reason] of g.cases) {
    /**
     * 这一组要求「变红 = 因为闸门自己的判据变红」（`requireReason: true`）
     *
     * 起因是复审 round 3 第三轮抓到的纸面用例：注入点落在模板字符串外面，
     * 文件语法错误，vitest 一律红 —— 那条用例便恒红，什么都没验证，
     * 而只看退出码分不出这两种红。其余几组暂时仍只看退出码（那是更早的卡），
     * 逐条补原因片段记成待办。
     */
    if (g.requireReason && expect === 'red' && !reason) {
      throw new Error(`[反向验证] 「${name}」期望变红却没写期望的报错片段 —— 语法错误会冒充闸门生效`)
    }
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
    /** 锚点可以是字符串（`includes`）或正则（只问"还在不在"） */
    const anchorFound =
      from instanceof RegExp ? from.test(normalized) : normalized.includes(from)
    if (!anchorFound) {
      console.log(`⚠️  [锚点失配] ${name}：在 ${rel} 中找不到要替换的锚点片段，跳过（用例锚点已失配，核对闸门与实现是否已同步）`)
      all.push([g.name, name, 'SKIP', expect])
      continue
    }
    // 注入 → 跑 → **无论如何都还原**（`to` 是函数时 `replace` 会把它当 replacer 调）
    const injected = normalized.replace(from, to)
    fs.writeFileSync(abs, crlf ? injected.replace(/\n/g, '\r\n') : injected)
    let green
    let output = ''
    try {
      const run = runGate(g.gate)
      green = run.green
      output = run.output
    } finally {
      fs.writeFileSync(abs, original)
    }
    // 期望：注入真违规 → 变红（**且因为闸门自己的判据变红**）；注入注释噪音 → 仍绿
    let ok = expect === 'red' ? !green : green
    let why = ''
    if (ok && expect === 'red' && reason) {
      const matched = reason instanceof RegExp ? reason.test(output) : output.includes(reason)
      if (!matched) {
        ok = false
        why = `，但红的原因不对：输出里找不到「${reason}」（语法错误冒充了闸门生效？）`
      }
    }
    const actual = green ? '绿' : '红'
    console.log(
      `${ok ? '✓' : '✗'} ${name}：闸门${actual}` +
        `（期望${expect === 'red' ? '红' : '绿'}${expect === 'red' && reason ? '，原因「' + reason + '」' : ''}${why}）`
    )
    all.push([g.name, name, ok ? 'PASS' : 'FAIL', expect])
  }

  // 还原后再跑一次，确认没把文件改坏
  const back = runGate(g.gate)
  console.log(`还原后复跑：${back.green ? '绿（文件完好）' : '红（还原失败，需检查）'}`)
  if (!back.green) all.push([g.name, '还原复跑', 'FAIL', 'green'])
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
