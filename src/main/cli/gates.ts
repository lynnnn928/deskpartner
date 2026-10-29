/**
 * 守卫清单 —— 关口唯一真相（1.0.72 修 `917390e0` 的 #5 / #6，qwen 驳回）
 *
 * ## 为什么要有这个文件
 *
 * qwen 实测的驳回理由成立：关口这件事有**三份各说各话的真相** ——
 *   1. 说明书（`agent-guide.ts`）里一张 Markdown 表格，**给人读**；
 *   2. MCP 工具的 instructions 里另写一份；
 *   3. `schema` 里**根本没有**（qwen 搜 G10，全文 0 次 —— 本版实测复现）。
 *
 * 后果不是"文档不好看"，而是**agent 无法自查**：它拿不到关口清单，
 * 只能撞一次错一次；而撞错的那次会以"usage_error / guard_blocked"这种
 * 不带解释的形状回来，于是它学不会"下次该怎么做"。
 *
 * 1.0.67 改按角色定权时还多了一处**内容与实现相反**的（见下方 G10 的备注）。
 * qwen 与Carol各驳回一次、两次都没修好，根因都在这里：
 * **口径是复制出去的，每一份都会各自过期。**
 *
 * ## 修法：一份结构化定义，两个出口渲染
 *
 * 本文件是唯一定义处。`schema.gates` 渲染它（机器读），
 * 说明书那节也从它生成（人读）。**不再手写第二遍** ——
 * 复制出去的那份一定会漂，而漂了没有任何机制会报错。
 *
 * ## 判据（写这份清单时逐条核过代码，不是抄注释）
 *
 * - `enforcement` 必须是 `block` / `authorize` / `notice` 三者之一：
 *   **软提醒不许写成硬拦，反之亦然** —— 那是 agent 会不会重试的关键。
 * - `exitCode` 必须是真实退出码（0/2/4），不是"大概是 4"。
 * - `implemented` 标 false 的必须写清为什么（否则它会变成一条假承诺）。
 */

/** 关口强度：硬拦 / 转授权 / 软提醒 —— 三者对调用方的行动含义完全不同 */
export type GateEnforcement = 'block' | 'authorize' | 'notice'

export interface GateSpec {
  /** 关口编号，如 `G1`；无编号的门禁用 `identity` / `grant` 之类语义名 */
  id: string
  /** 一句话说清它守什么 */
  what: string
  enforcement: GateEnforcement
  /** 触发时给调用方的可编程信号（退出码 + errorCode） */
  exitCode: number
  errorCode: string | null
  /** 调用方该怎么办（"重试无用" 与 "改了再来" 必须分清） */
  doThis: string
  /** 实装在哪个文件（便于核查；`null` = 尚未实装） */
  implementedAt: string | null
  /**
   * 边界与例外。
   *
   * 刻意留字段而不是塞进 `doThis`：关口最容易出的错不是"拦错了"，
   * 而是"在某个例外路径上不拦"，而调用方只有知道那条路径才知道能不能重试。
   */
  notes?: string
}

/**
 * 全部候选池守卫 + 调用方门禁。
 *
 * ⚠️ 编号只到 G10。代码注释里出现过 "G11/G12"（`commands.ts` 6220 行
 * 提到"将来自动生效"），但**它们不存在** —— 写进清单就成了假承诺。
 * 新增关口时先在这份清单落一条，再去写实装。
 */
export const GATES: GateSpec[] = [
  {
    id: 'G1',
    what: '父需求还在「待确认」时，不能围绕它建子任务',
    enforcement: 'block',
    exitCode: 4,
    errorCode: 'guard_blocked',
    doThis: '换合法路径，重试无用 —— 先让人拍板父需求',
    implementedAt: 'src/main/database/todo.repository.ts',
    notes:
      '理由：父需求没点头之前就把子任务铺开，等于在人确认之前把工作量定死了。' +
      '在候选池机制之前建的需求（本库 v17 以前）不受此限。'
  },
  {
    id: 'G2',
    what: '父需求转「待验收」时，它下面所有子任务必须已全部完成',
    enforcement: 'block',
    exitCode: 4,
    errorCode: 'guard_blocked',
    doThis: '先把子任务收尾，重试无用',
    implementedAt: 'src/main/database/todo.repository.ts',
    notes: '验收的人只看最终结果，不该替 agent 检查子任务收没收尾。'
  },
  {
    id: 'G4-status',
    what: '把「待确认」的条目挪走（改成别的状态）',
    enforcement: 'block',
    exitCode: 4,
    errorCode: 'guard_blocked',
    doThis: '等人拍板，不要代转 —— 这道是候选池的核心关口',
    implementedAt: 'src/main/database/todo.repository.ts',
    notes:
      'Bob实测证实过它此前可被一条 update 绕过，所以实装放在数据层而不是 CLI/IPC 各写一份。' +
      '**只拦 proposed → 其他状态**；「待验收 → 进行中」是允许的自由流转。'
  },
  {
    id: 'G4-delete',
    what: '把「待确认」的条目**删掉**',
    enforcement: 'authorize',
    exitCode: 4,
    errorCode: 'grant_required',
    doThis:
      '可以发起申请，但必须逐条经人点头；人批准后当场执行，**不要重试**（重试会撞"授权已被消费"）',
    implementedAt: 'src/main/database/todo.repository.ts',
    notes:
      '与 G4-status 的区别是"删掉"不可逆、且提案人可能就是自己 —— 所以给授权而不是直接拒绝。' +
      '这条是「候选池首尾两列」里唯一允许 agent 主动发起的动作。'
  },
  {
    id: 'G6',
    what: '父需求**直接**置「已完成」时，子任务必须全部完成',
    enforcement: 'block',
    exitCode: 4,
    errorCode: 'guard_blocked',
    doThis: '先收尾子任务；或走 G2 那条路（先转待验收）',
    implementedAt: 'src/main/database/todo.repository.ts',
    notes:
      '为什么与 G2 并存：G2 只守 awaiting_review 那条路，' +
      '绕开它直接归档就能把没做完的子任务埋掉。'
  },
  {
    id: 'G3',
    what: '事项转「待验收」时没留收口结论',
    enforcement: 'notice',
    exitCode: 0,
    errorCode: null,
    doThis: '用 `todo comment <id> --body "…"` 补一条评论；把回执顶层的 `notice` 回显给用户',
    implementedAt: 'src/main/cli/commands/todo.ts',
    notes: '软提醒：**不拦执行、不改退出码**，只在成功响应的顶层 `notice` 键里出现。'
  },
  {
    id: 'G5',
    what: '事项标完成时没留**带结构性要素的**收口结论',
    enforcement: 'notice',
    exitCode: 0,
    errorCode: null,
    doThis:
      '补一条带结构性要素的收口结论：`todo close <id> --did … --verified … --pass-criteria …`（最省事），' +
      '或手写一条含四段标记（如 `【做了什么】…`）的评论',
    implementedAt: 'src/main/database/closure-structure.ts',
    notes:
      'Bob实测：**一次批量关 30 张卡全部放行**（当初只看"有没有评论"，不看内容）。' +
      '**1.0.110 判据升级**（收 `eec2e1e7`）：收口文本（描述 ∪ 非驳回评论）里要出现 ' +
      '`todo close` 四段标记里的至少一个 —— 判据单一出处 ' +
      '`src/main/database/closure-structure.ts`（`hasClosureSections`），' +
      '`todo update --status done` 与 `todo done` 两处共用，' +
      '`todo list --fixed-in` 的 `hasClosure` 也照它。' +
      '仍**只提醒、不改退出码**：它查"有没有结构"，不查"写得好不好"（那需要判断，做不了闸门）。'
  },
  {
    id: 'G7',
    what: '「待确认」的事项描述缺要素（背景 / 目标 / 判据）',
    enforcement: 'notice',
    exitCode: 0,
    errorCode: null,
    doThis: '补 `--desc`；缺得离谱时才吱一声，不拦',
    implementedAt: 'src/main/cli/commands/todo.ts',
    notes: '描述改动后若该事项在「待确认」列会重新自检。'
  },
  {
    id: 'G8',
    what: '你手上那份说明书版本落后于当前版本',
    enforcement: 'notice',
    exitCode: 0,
    errorCode: null,
    doThis: '重跑 `dp skill` 取新的',
    implementedAt: 'src/main/cli/command-exec.ts',
    notes:
      'Bob实测踩过：拿着 1.0.39 的副本连跑五版，一直按旧规格里点名禁止的写法干活，自己不知道。' +
      '1.0.57 修过一个坑：原先直接读 `process.env`，管道路径下恒为空 → 提醒静默失效。'
  },
  {
    id: 'G9',
    what: '在「待验收」的事项上写了评论，但**状态没动**',
    enforcement: 'notice',
    exitCode: 0,
    errorCode: null,
    doThis: '把结论落到状态上：验收者用 `todo update <id> --status done`，不通过用 `todo reject`',
    implementedAt: 'src/main/cli/commands/todo.ts',
    notes:
      '软提醒而不是硬拦：写评论本身是正当动作，不该被拦；' +
      '但"结论只落在评论里、状态不动"会让验收卡住，所以必须吱一声。'
  },
  {
    id: 'G10',
    what: '**执行者**不能验收自己做的事（运动员不当裁判）',
    enforcement: 'block',
    exitCode: 4,
    errorCode: 'guard_blocked',
    doThis:
      '让执行者以外的验收者收口（`--verifier` 指定验收者）—— 这张卡不能由执行者自己送进「已完成」，重试无用，换人',
    implementedAt: 'src/main/database/todo.repository.ts',
    notes:
      '注意：1.0.67 语义变更（`a6032512`）：原来按"身份"定权（一律只能人点），' +
      '现在按"角色"定权（验收者 ≠ 执行者即可）。' +
      '**保留的那道是运动员不当裁判** —— "人一律得当裁判"不如"运动员不当裁判"。' +
      '判据是**身份**而不是路径（1.0.116，`a7ad343f`）：只要这次调用的结果是「已完成」、' +
      '执行者又正是你自己，就拦 —— 起点在待办 / 进行中 / 挂起 / 待验收哪一列都一样，' +
      '`todo close`、`todo done`、`todo update --status done` 都算。' +
      '`todo add --status done`（一步建到完成，记自己的流水）合法；' +
      '但拿它去顶替一件已有事项，就是绕过。'
  },
  {
    id: 'identity',
    what: '非交互调用却没持证 / 注册未获批准',
    enforcement: 'block',
    exitCode: 4,
    errorCode: 'identity_required / identity_pending / credential_missing / credential_invalid',
    doThis: '走完注册 → 领凭据 → 人批准三步；只读命令不受影响',
    implementedAt: 'src/main/cli/command-core.ts'
  },
  {
    id: 'grant',
    what: '改界面参数 / 删除类破坏操作，没拿到单次授权',
    enforcement: 'block',
    exitCode: 4,
    errorCode: 'grant_required',
    doThis:
      '申请已自动生成 → 请用户在「审批页 → 等你点头」允许 → **批准即执行，不要重试**',
    implementedAt: 'src/main/cli/command-core.ts',
    notes:
      '同 G4-delete：重试会撞"授权已被消费"。' +
      '一次授权 = 一份冻结的命令与目标集，**禁止合并两条申请**。'
  },
  {
    id: 'ambiguous_identity',
    what: '本机有多份凭据，而这次调用没声明身份',
    enforcement: 'block',
    exitCode: 4,
    errorCode: 'ambiguous_identity',
    doThis: '`export DESKPARTNER_AGENT=agent:<你的名字>` 后重试；只读命令不受影响',
    implementedAt: 'src/main/cli/command-core.ts'
  },
  {
    id: 'project_required',
    what: '`todo add` 没带 `--project`',
    enforcement: 'block',
    exitCode: 2,
    errorCode: 'usage_error',
    doThis: '报错里已列出本机项目，抄一个；不存在会报错，`--create-project` 才新建',
    implementedAt: 'src/main/cli/command-core.ts',
    notes:
      '1.0.40 从"找不到就建"改成默认报错：错字会静默分叉出新项目，' +
      '待办也进去、全程无提示，而项目是看板的主聚合维度。'
  }
]

/** 按 id 取一道关口（给测试与文案引用用，避免各处硬写字符串） */
export function gateById(id: string): GateSpec | undefined {
  return GATES.find((g) => g.id === id)
}

/**
 * 渲染成说明书里那张表（人读）。
 *
 * 存在的意义：**让说明书不再手写这张表**。
 * 手写的那份已经与实装相反过一次（G10），而 markdown 表格不会报错。
 *
 * ⚠️ `escapeBackticks` 不是洁癖 —— 说明书本体是一个**模板字符串**，
 * 插进去的裸反引号会被当成"结束模板"，生成的 SKILL.md 直接语法错误。
 * 这类"渲染进另一段代码"的坑只在真跑一次时才暴露，所以钉在函数里。
 */
export function renderGatesTable(options: { escapeBackticks?: boolean } = {}): string {
  const esc = (s: string): string =>
    options.escapeBackticks ? s.replace(/`/g, '\\`') : s
  const order: GateEnforcement[] = ['block', 'authorize', 'notice']
  const label: Record<GateEnforcement, string> = {
    block: '**硬拦**',
    authorize: '**转授权**',
    notice: '软提醒'
  }
  const lines: string[] = [
    '| 关口 | 强度 | 触发信号 | 该怎么做 |',
    '| --- | --- | --- | --- |'
  ]
  for (const kind of order) {
    for (const g of GATES.filter((x) => x.enforcement === kind)) {
      const signal =
        g.enforcement === 'notice'
          ? '退出码 **0**，响应顶层多一个 `notice` 键'
          : `退出码 ${g.exitCode}${g.errorCode ? `，\`errorCode: ${g.errorCode}\`` : ''}`
      lines.push(
        `| ${g.id} ${g.what} | ${label[kind]} | ${signal} | ${g.doThis} |`
      )
    }
  }
  return esc(lines.join('\n'))
}
