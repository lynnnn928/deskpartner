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
5. 与主用户确认协作协议内容，起草协议修改提议（protocol propose），交主用户在审批页采纳。
6. 询问主用户是否要把现有项目登记到 DeskPartner；确认后逐个建项目、提议接手说明、按主用户确认的口径登记事项。
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
5. 与主用户确认协作方式，起草协议修改提议（protocol propose），交主用户在审批页采纳。
6. 帮主用户创建第一个项目：确认项目名称和目标，提议接手说明，把主用户描述的工作拆解成事项登记（每条标明来源）。
7. 完成后回读并向主用户汇报：建了什么、哪些待确认、下一步建议。

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
 * 推荐给新手的 agent 产品清单（PRD v1.2 用户拍板）。
 * 官方链接、费用和能力标签在逐项核对前明确标为「待核对」，不凭印象写入。
 */
export const RECOMMENDED_AGENTS = [
  { name: '豆包', note: '字节跳动 AI 助手', link: '', cost: '待核对', install: '待核对', capabilities: '待核对', verification: '待核对' },
  { name: 'Alice', note: '桌面 AI 工作助手', link: '', cost: '待核对', install: '待核对', capabilities: '待核对', verification: '待核对' },
  { name: 'Bob', note: '阿里云 AI 办公助手', link: '', cost: '待核对', install: '待核对', capabilities: '待核对', verification: '待核对' },
  { name: 'zcode', note: '编程与通用 AI 助手', link: '', cost: '待核对', install: '待核对', capabilities: '待核对', verification: '待核对' },
  { name: 'NewMax AI', note: '中文 AI 工作助手', link: '', cost: '待核对', install: '待核对', capabilities: '待核对', verification: '待核对' }
] as const
