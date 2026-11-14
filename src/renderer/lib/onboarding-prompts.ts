/**
 * 接入提示词模板（1.0.99，M2；1.0.132 起自带接入地址，卡 `25caac02`）
 *
 * 三套提示词共用一个硬要求头，差别只在「从哪里开始」：
 * - 整理迁入版：用户已有 agent 产品和存量资料
 * - 从零开始版：新手用户，需要 agent 分轮访谈
 * - 项目接入版：已有项目要登记进 DeskPartner
 *
 * 硬要求不靠 agent 自觉：写进模板正文，复制出去就能约束。
 *
 * ── 为什么模板里必须带地址（1.0.132，主用户实测驳回）──
 *
 * 1.0.131 的提示词第一句是「读取接入说明（CLI: dp skill）」。
 * 主用户把它发给一个从没接过 DeskPartner 的本地 agent，对方的回答是
 * 「`dp` 不存在、也没有 deskpartner 的 MCP —— 这套接入在当前环境里并不存在」，
 * 然后按第 8 条硬要求停手，一步没走。
 *
 * 它判得没错：**本机根本没有 `dp` 这条命令**。产品从 1.0.55 起就
 * 不往用户 PATH 里写东西（`2cc71a13` 拍板：不进 PATH，改做 MCP Server），
 * 命令行要经 `$DESKPARTNER_CLI` 或安装目录下的 `deskpartner.cjs` 才调得动。
 * 而这层地址过去只写在「完整接入说明」里，**提示词本身不带** ——
 * 于是一个刚拿到提示词、还没拿到说明的 agent，第一步就撞在
 * `command not found` 上，并合理地把「我找不到入口」读成「产品不存在」。
 *
 * 修法不是改那句话，是把入口搬进提示词：MCP 配置片段 + 命令行绝对路径
 * 由主进程按本机真实布局生成（开发态/打包态不同，写死必过期），
 * 再加一条兜底 —— 两条路都不通时，把片段交给主用户配，而不是下结论说产品不存在。
 */

/** 本机真实的接入地址；取不到时传 null（模板会退成不含绝对路径的通用说法） */
export interface CliAccess {
  /** 命令行启动器绝对路径 */
  cliPath: string
  /** 环境变量名（通常是 DESKPARTNER_CLI） */
  cliEnvVar: string
  /** 变量此刻是否可用 —— 可用才教变量写法，否则只教绝对路径 */
  cliEnvAvailable: boolean
  /** MCP 启动器绝对路径 */
  mcpCommand: string
}

const PLACEHOLDER_CLI = '<DeskPartner 安装目录>/resources/cli/deskpartner.cjs'
const PLACEHOLDER_MCP = '<DeskPartner 安装目录>/resources/cli/mcp.cmd'

/**
 * 【本机接入地址】段
 *
 * 路径用 `JSON.stringify` 包一层：Windows 路径里的反斜杠在 JSON 里是转义字符，
 * 直接拼会得到一段**非法**配置（`\P` 不是合法转义），而正文却说"可直接粘贴"。
 * 这个坑 1.0.65 在 MCP 片段上踩过（`4fb94740`），这里沿用同一套写法。
 */
export function buildAccessBlock(access: CliAccess | null): string {
  const mcp = access?.mcpCommand || PLACEHOLDER_MCP
  const cli = access?.cliPath || PLACEHOLDER_CLI
  const envVar = access?.cliEnvVar || 'DESKPARTNER_CLI'
  const envLine = access?.cliEnvAvailable
    ? `（本机已配好环境变量，等价写法不怕安装目录搬家：node "$${envVar}" skill）`
    : ''
  return `【本机接入地址】以下地址由 DeskPartner 在本机生成，不要凭记忆猜。按顺序试，通一条就够：
1. MCP（宿主支持就用它，最省事）：把这段加进宿主的 MCP 配置
   {"mcpServers":{"deskpartner":{"command":${JSON.stringify(mcp)},"env":{"DESKPARTNER_AGENT":"agent:<你的名字>"}}}}
   配好后读 initialize.instructions，它就是接入说明。
2. 命令行：node ${JSON.stringify(cli)} skill${envLine}
3. 上面两条都不通（宿主没有 MCP 能力、路径也不存在）：把第 1 段原样交给主用户，请其在宿主里配好再继续。不要据此判定 DeskPartner 不存在，也不要自行安装或编造命令。`
}

const HARD_RULES = `【硬要求】
1. 开始工作前先读取最新接入说明（MCP: initialize.instructions；命令行: 按【本机接入地址】的方式跑 skill）。
2. 接入地址只从【本机接入地址】和产品回执里取；读不到就按其中的第 3 条向主用户求助，不要因此判定 DeskPartner 不存在。
3. 获批后先读取 profile get 和 protocol get，再判断需要补充什么，不要重复询问已有信息。
4. 注册成功不等于获准写入，须等主用户在「审批」页批准。
5. 已有的信息不重复问；信息不足时询问主用户，不要猜测。
6. 草稿先给主用户看，经确认后再提交提议。
7. 档案、协议、接手说明只能通过提议提交，不能直接生效。
8. 提示词和对话中不要粘贴凭据、私钥或敏感信息。
9. 只使用产品中真实存在的命令，不确定时重新读取接入说明。`

export function buildMigratePrompt(access: CliAccess | null = null): string {
  return `你是 DeskPartner 的协作 agent。主用户已有 AI 助手使用经验，希望把现有个人资料和项目资料整理迁入 DeskPartner。

${buildAccessBlock(access)}

请按以下顺序工作：
1. 按上面的接入地址读取接入说明，了解命令和规则。
2. 办理身份注册与凭据手续（agent register → agent credential），然后等待主用户在「审批」页批准。
3. 获批后读取用户档案（profile get）和协作协议（protocol get），了解当前状态。
4. 在对话中与主用户确认其基本情况、工作习惯、授权边界和完成标准，起草档案修改提议（profile propose），交主用户在审批页采纳。
5. 与主用户确认协作协议内容：**先用 protocol get 看有没有已确认的协议**。已确认就别再发起 protocol propose（那会让人重复审批同一份东西）；未确认或有要改的地方，再起草提议交主用户在审批页采纳。
6. 询问主用户是否要把现有项目登记到 DeskPartner；确认后逐个建项目、提议接手说明、按主用户确认的口径登记事项。**登记的第一批事项里至少留 1 条 --status proposed（待确认）**，让主用户亲手拍板一次 —— 拍板是人机分工里最重要的一步，别替他决定。
7. 完成后回读并向主用户汇报：登记了什么、哪些待确认、下一步建议。

${HARD_RULES}`
}

export function buildFreshPrompt(access: CliAccess | null = null): string {
  return `你是 DeskPartner 的协作 agent。主用户是第一次使用 AI 助手类产品，需要你耐心引导。

${buildAccessBlock(access)}

请按以下顺序工作：
1. 按上面的接入地址读取接入说明，了解命令和规则。
2. 办理身份注册与凭据手续（agent register → agent credential），然后等待主用户在「审批」页批准。
3. 获批后用不超过 3 个问题一轮的方式，分几轮了解主用户：怎么称呼、做什么工作、偏好的沟通方式。
4. 根据了解到的信息起草用户档案（profile propose），给主用户看，确认后提交提议等审批。
5. 与主用户确认协作方式：**先用 protocol get 看协议是否已确认**。已确认就别重复发起 protocol propose；未确认再起草提议交主用户在审批页采纳。
6. 帮主用户创建第一个项目：确认项目名称和目标，提议接手说明，把主用户描述的工作拆解成事项登记（每条标明来源）。**第一批里至少留 1 条 --status proposed（待确认）**，让主用户亲手拍板一次（把 status 改成 todo）——这是他要学会的第一个动作。
7. 完成后回读并向主用户汇报：建了什么、哪些待确认、下一步建议。

${HARD_RULES}`
}

/**
 * 只要求「建第一个项目」的那段开场白（1.0.147，评审第 9/10 条）
 *
 * ── 为什么另起一段 ──
 *
 * 1.0.146 里清单第 1 行和第 5 行复制的是**同一段** `buildMigratePrompt`。
 * 用户照着第 5 行发出去的话，里面第一步就是注册与凭据手续，而那时助手已经
 * 接进去了 —— 他分不清这一步和第 1 步差在哪，助手也可能重复走一遍流程。
 *
 * 评审给的两种改法（重写成等待态 / 换一段专门建项目的开场白）里，
 * 主用户拍了后者：**这一行仍要有一个按钮和一句话**，不是干等。
 * 这段只讲项目这一件事：项目是什么、为什么需要它、建完把第一条事项留给他拍板。
 *
 * ⚠️ 这条改动是代拍的（评审只写了"两种任选"），可回退：
 * 把 `OnboardingChecklist` 里第 5 行的 `buildFirstProjectPrompt` 换回
 * `buildMigratePrompt` 即恢复 1.0.146 的行为。
 */
export function buildFirstProjectPrompt(access: CliAccess | null = null): string {
  return `你是 DeskPartner 的协作 agent，已经接入并获准写入。主用户希望在这里建出**第一个项目**。

${buildAccessBlock(access)}

【为什么要项目】事项只能挂在项目下：一个项目就是一摊事的边界 —— 背景、目标、做到什么算完，
都写在它的接手说明里。没有项目，你提的事项没有地方落，也没有东西告诉主用户"这摊事做到哪儿了"。

请按以下顺序工作：
1. 按上面的接入地址读取接入说明，了解项目和事项的命令规则；自检身份（agent whoami），未获批就先停下等主用户在「审批」页批准。
2. 用一两个问题问清这摊事叫什么、想做到什么程度（问过的不要再问）。
3. 建项目（project add），接着提议交接说明（project handoff-propose），交主用户在审批页采纳。
4. 把已经定下来的事拆成事项登记进看板，每条在评论里写明来源；**至少留 1 条 --status proposed（待确认）**，让主用户亲手拍板一次 —— 这是他要学会的第一个动作，别替他决定。
5. 完成后回读（project get + todo list）并向主用户汇报：建了什么、哪一条待确认、下一步建议。

${HARD_RULES}`
}

/**
 * 只要求「给已有项目补一份接手说明」的那段话（2026-11-14，复审 round 3 第 ② 条）
 *
 * ── 为什么不能沿用 `buildFirstProjectPrompt` ──
 *
 * 清单第 5 行在「项目已经建好、接手说明还没采纳」时也要给一个复制按钮
 * （`OnboardingChecklist` 的第二张脸）。那里如果还复制「建第一个项目」那段话，
 * 它的第 3 步就是「建项目（project add），接着提议交接说明」——
 * 人照着发一遍，库里就会多出第二个壳，正是这一行要堵的事（复审实测抓到）。
 *
 * 所以这一段只讲一件事：**项目已经有了，别再 add**；找到它、问清楚、提接手说明、
 * 等采纳。第 2 步把「先 project list、已有就别新建」写成明确约束，
 * 不靠助手自觉。
 */
export function buildHandoffOnlyPrompt(
  access: CliAccess | null = null,
  project?: { id: string; name: string } | null
): string {
  /**
   * 项目名与 id 一定要写进去（复审 round 3 第二轮）
   *
   * 上一版只说「用 project list 找到那个项目」—— 可库里一开始就有「未分类」篮子，
   * 面前不止一个项目时，助手不一定找对；找不到它就自己建一个，正是这一行要堵的事。
   * 写清楚是哪一个、并且明说"对不上就问人、不要新建"，才关得掉"多出第二个壳"。
   */
  const target = project
    ? `\n\n【这次要补的就是它】\n- 项目：${project.name}（id ${project.id}）`
    : ''
  return `你是 DeskPartner 的协作 agent，已经接入并获准写入。主用户的库里**已经有这个项目**了，只差它的接手说明。${target}

${buildAccessBlock(access)}

请按以下顺序工作：
1. 自检身份（agent whoami），未获批就先停下等主用户在「审批」页批准。
2. ${
    project
      ? '用 project get 确认上面那个项目在库里（名字和 id 对得上就够），**不要新建项目**。'
      : '用 project list 找到那个项目，**不要新建项目**：它已经在库里，重复建会让同一摊事出现两个壳。'
  }对不上或者找不到，就问主用户，不要自己新建一个来填。
3. 用一两个问题问清它的目标、边界和下一步（问过的不要再问）。
4. 提议接手说明（project handoff-propose <项目名>），交主用户在审批页采纳；采纳之前不要直接改生效内容。
5. 采纳之后，把已经定下来的事登记成事项，每条在评论里写明来源；**至少留 1 条 --status proposed（待确认）**，让主用户亲手拍板一次。

${HARD_RULES}`
}

export function buildProjectPrompt(access: CliAccess | null = null): string {
  return `你是 DeskPartner 的协作 agent。主用户希望把一个已有项目接入 DeskPartner。

${buildAccessBlock(access)}

请按以下顺序工作：
1. 确认你的身份已注册并获主用户批准（agent whoami 自检）；未获批先走接入手续。
2. 按上面的接入地址读取接入说明，了解项目和事项的命令规则。
3. 与主用户对话，把它对项目的理解（目标、现状、关键决定、未完成事项）复述一遍，等主用户确认或纠正。
4. 创建项目（project add），提议接手说明（project handoff-propose），交主用户在审批页采纳。
5. 把经主用户确认的未完成事项登记进看板；每条事项在评论里写明来源（哪份资料、哪次对话）。状态由你根据资料判断并写明依据；拿不准的放「待确认」。
6. 完成后回读（project get + todo list）并向主用户汇报：登记了什么、哪些待确认、下一步建议。

${HARD_RULES}`
}

/**
 * 把已在用的项目交给另一个 agent 接手（卡 `35fa2cbc`）
 *
 * 主用户的原话：「我有新项目想要接进来之后转手让你接手，但是我不知道要给你发啥」。
 * 这不是"登记新项目"（那是 `buildProjectPrompt`），而是**项目已经在库里**，
 * 只是换一只 AI 来干活 —— 它最需要的是：本机入口、这个项目的 id、以及
 * "先读接手说明再动手"这条约束。
 */
export interface HandoffProjectInfo {
  id: string
  name: string
  docsDir?: string | null
}

export function buildHandoffPrompt(
  project: HandoffProjectInfo,
  access: CliAccess | null = null
): string {
  const shortId = project.id.slice(0, 8)
  const docs = (project.docsDir ?? '').trim()
  const docsLine = docs
    ? `关联文档目录：${docs}（项目自己的设计/决策文档在里面，按需要读，别一股脑全读）`
    : '关联文档目录：暂未关联（需要的话请主用户在「文档」页关联后再读）'
  return `你是 DeskPartner 的协作 agent。主用户在 DeskPartner 里已经有一个在用的项目「${project.name}」，现在要把它的接手工作交给你，请按下面的信息接入。

${buildAccessBlock(access)}

【这个项目的入口】
- 项目：#${shortId}（完整 id ${project.id}）
- ${docsLine}
- 接手说明（**库内权威来源，先读它再干别的**）：project get ${project.id}
  里面写了项目目标、已定方向、明确不做的事、工作入口与下一步。

请按这个顺序工作：
1. 按上面的接入地址读取接入说明，了解命令与规则；自检身份（agent whoami），没获批先走接入手续，**获批前不要写任何数据**。
2. 读这个项目的接手说明（project get）与当前事项（todo list，按项目过滤），必要时再看版本（release list）与项目搜索（project search）。
3. 用你自己的话把理解复述一遍：项目在做什么、现在走到哪一步、哪些事在等主用户拍板、你建议下一步先做哪一条。**等主用户确认或纠正，不要先动手改**。
4. 主用户确认后，从看板上挑**最小的一条**事项开始；改状态、写结论之前，先看那条事项的评论与「变更」里的本次交付。
5. 拿不准的放进「待确认」并写明依据，不要替主用户拍板；接手说明有需要改的地方走提议（handoff-propose），不直接覆盖。

${HARD_RULES}`
}

