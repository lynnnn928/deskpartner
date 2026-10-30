import path from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { GATES, renderGatesTable } from './gates'
import { renderErrorCodesTable, renderExitCodesLine } from './error-codes'
import { mcpToolName, shouldExpose, DEFAULT_ROW_LIMIT } from '../../cli/mcp-tools-from-schema'
import { UsageError } from '../lib/domain-errors'
import { GUIDE_TOPICS, guideTopicNames } from './guide-topics'
/**
 * ⚠️ 与 `./command-table`、`./commands/meta`、`./commands/ops` 是**循环引用**：
 * 后两者 import 本文件的 `buildAgentGuideIndex` / `buildAgentGuideTopic` /
 * `resolveLauncherPath`，而本文件 import 门面 `./commands` 的
 * `commands` / `riskOf` / 两个口径常量。能成立的前提：
 * **从对方取的东西只在构建函数体内用**，谁都不在模块顶层求值 ——
 * 顶层求值会踩 TDZ 或拿到半初始化的模块。别把它们提到模块顶层算常量。
 *
 * 2026-10-22 又踩了一次（卡 `d3cc69a6`）：把主题清单放进本文件、
 * 再让 `command-table.ts`（当时还是 commands.ts）在命令表字面量里读它，加载期就报
 * `Cannot access 'GUIDE_TOPICS' before initialization`。
 * 结论是**凡双方都要在加载期读的数据，都得是零依赖的独立模块**
 * （现有的落点：主题清单 `./guide-topics`、关口 `./gates`、错误码 `./error-codes`）。
 */
import { commands, riskOf, TODO_LIST_DEFAULT_LIMIT, LIST_DESC_PREVIEW_CHARS } from './commands'

/**
 * 生成给 AI agent 的接入说明
 *
 * 为什么要在代码里生成而不是维护一份静态文件：
 * **调用路径必须动态推导**。开发态、打包态的目录布局不同，
 * 写死的路径一定会过期，而过期之后对方 agent 拿到的是一份照着做会失败的说明 ——
 * 比没有说明更糟，因为它会反复重试。
 *
 * ⚠️ 同理，**这份内容本身就是唯一真相**。曾经出现过代码生成的说明（145 行）
 * 与手工维护的另一份 SKILL.md（228 行）漂移成两份，对方 agent 拿到哪份取决于走哪条路。
 * 此后所有补充都改这里，不要另存一份。
 */

/**
 * CLI 启动器的绝对路径（开发态与打包态都从主进程产物向上推导）
 *
 * ⚠️ 打包态必须指向 asar **之外**的副本（`resources/cli/`）。
 *
 * 原因：本文件生成的 SKILL.md 让 AI 用 `node <路径>` 直接调启动器，
 * 而 **Node 不认 asar 虚拟文件系统** —— 打进 app.asar 的启动器
 * 对外部 node 进程来说等于不存在，报 `Cannot find module`。
 * （实测：`node app.asar/out/cli/deskpartner.cjs doctor` 必然失败。）
 *
 * 所以构建时用 extraResources 把 `out/cli` 拷到 `resources/cli`。
 * 位置同时决定了降级能否找到程序本体：launcher 在 `<app>/resources/cli/`，
 * 它内部按 `../..` 回退正好落在 `<app>/`，那里就是 `DeskPartner.exe`。
 */
export function resolveLauncherPath(): string {
  if (__dirname.includes('app.asar')) {
    return path.join(process.resourcesPath, 'cli', 'deskpartner.cjs')
  }
  return path.resolve(__dirname, '..', 'cli', 'deskpartner.cjs')
}

/** 转成命令里可直接使用的形式（统一正斜杠，Windows 下两种都能用） */
function toCliPath(p: string): string {
  return p.replace(/\\/g, '/')
}

/**
 * MCP 启动器（`mcp.cmd`）的绝对路径 —— 写死会把开发态/打包态搞反
 *
 * 与 `resolveLauncherPath` 同一套推导，只是换文件名：
 * 开发态 `out/cli/mcp.cmd`、打包态 `<app>/resources/cli/mcp.cmd`。
 *
 * ⚠️ **这里只生成字符串给人看，不写任何文件**（1.0.65，主用户定的产品边界：
 * 「不要直接写入别人的配置文件，这种注入是高风险操作，产品只给指引规范和方法」）。
 * 这条边界与 `2cc71a13`「产品不写用户 PATH」同源 ——
 * 上次是不往用户环境变量里塞东西，这次是不往第三方应用配置里塞东西。
 */
export function resolveMcpPath(): string {
  /**
   * ⚠️ **只替换文件名，不要再调 `toCliPath`**。
   *
   * `resolveLauncherPath()` 返回的是**未转斜杠**的原始路径（`toCliPath` 只在
   * 拼说明书文本时才调）。我第一版在这里又套了一次 `toCliPath`，
   * 而替换在 `toCliPath` **之外**先执行 —— 于是 `mcp.cmd` **前面那个分隔符**
   * 仍是反斜杠、其余是正斜杠，拼出来的路径在 Windows 上照样能跑，
   * 但字符串对不上（`tests/main/cli/no-third-party-config-write.test.ts` 抓到）。
   *
   * 判据：**同一段路径只能有一个分隔符风格**。混用在 Windows 上是"能跑但对不上"，
   * 那是最难查的一类。
   */
  return resolveLauncherPath().replace(/deskpartner\.cjs$/i, 'mcp.cmd')
}

/**
 * 本机是否已经写好 `DESKPARTNER_CLI` 用户环境变量（1.0.49）
 *
 * Bob `8bf64514` 实测的代价：**安装目录两周搬了两次家**
 * （测试应用 → TestApps → 测试应用），它技能文件里硬写的绝对路径
 * 两次失效、全靠人提醒才重取。已接入的 agent 越多，硬路径的债越贵。
 *
 * 变量由 GUI 启动时写入（见 `index.ts` 的 `ensureCliEnv`）。
 * 说明书据此**优先教变量寻址**，把绝对路径降级成兜底 ——
 * 但只有当变量**确实存在**时才这样写：
 * 否则 agent 拿着一句 `$DESKPARTNER_CLI` 去跑，环境里根本没有这个变量，
 * 会得到"命令找不到"，比给一条能用的绝对路径更糟。
 *
 * ⚠️ 读的是**进程环境**，不是注册表。若 GUI 刚写过变量、而本进程在
 * WM_SETTINGCHANGE 广播之前就启动了，读到的仍是旧值（可能是空）。
 * 这是可接受的：说明书是给人/agent 长期持有的文档，不是一次性快照；
 * 而 doctor 会把"变量在不在"如实报出来，可当场核实。
 */
export function cliEnvVarAvailable(): boolean {
  return Boolean(process.env.DESKPARTNER_CLI?.trim())
}

/**
 * 读取当前工作项目的协作约定。
 *
 * COLLABORATION.md 是项目级、可编辑的约定，不应复制进代码或 agent 的长期记忆。
 * `dp skill` 是 agent 唯一稳定出口：从当前工作目录或显式项目根读取它，
 * 让约定变化无需发版，也避免把某个仓库的约定硬编码进所有项目的指南。
 */
export function resolveCollaborationPath(): string | null {
  const roots = [process.env.DESKPARTNER_PROJECT_ROOT, process.cwd()]
    .filter((root): root is string => Boolean(root?.trim()))
    .map((root) => path.resolve(root))
  for (const root of roots) {
    const candidate = path.join(root, 'COLLABORATION.md')
    if (existsSync(candidate)) return candidate
  }
  return null
}

export function readCollaborationAgreement(): { path: string; body: string } | null {
  const agreementPath = resolveCollaborationPath()
  if (!agreementPath) return null
  try {
    // 约定是给 agent 读的项目文档，限制大小避免意外把巨大文件塞进每次握手。
    const body = readFileSync(agreementPath, 'utf8')
    if (Buffer.byteLength(body, 'utf8') > 128 * 1024) return null
    return { path: agreementPath, body }
  } catch {
    return null
  }
}

/**
 * 输出完整的 SKILL.md 文本（含 frontmatter）
 *
 * 带 frontmatter 是刻意的：对方 agent 可以直接把它存成 skill 文件用，
 * 不需要再加工一次。
 */
/**
 * @param version CLI 版本 —— 写进生成物的 frontmatter 与末行
 *
 * 为什么说明书必须自带版本（Bob 3f90eab6 实测）：
 * 生成物散落在各 agent 的 skill 目录里，CLI 升级后旧副本不会自动失效。
 * agent 拿着旧说明干活并且自我感觉正确，而规则一旦改动，旧文档就是**错误指令来源**
 * —— 它据此报的缺陷会变成误报，污染试点反馈的可信度。
 * 有版本号，agent 才能自问一句"我手上这份还新吗"。
 */
export function buildAgentGuide(launcherPath = resolveLauncherPath(), version = 'unknown'): string {
  const cli = toCliPath(launcherPath)
  const generatedAt = new Date().toISOString()
  /**
   * 说明书里给哪种寻址方式，取决于**本机此刻**有没有那个环境变量。
   *
   * 有变量 → 教变量写法（安装目录搬家也不失效，这是正路）；
   * 没变量 → 老实给绝对路径。此时若仍教 `$DESKPARTNER_CLI`，
   * agent 会照着写一句取不到值的命令，报"找不到文件" —— 那是**文档制造的故障**。
   *
   * 生成时刻的判断不保证永久成立（用户可能换机器、清环境变量），
   * 所以无论走哪条路，下文都附了 `doctor` 的自证方法。
   */
  const useEnvVar = cliEnvVarAvailable()
  const collaboration = readCollaborationAgreement()
  const collaborationSection = collaboration
    ? `

## 当前项目协作约定（来自 \`COLLABORATION.md\`）

> 这是当前工作项目的可编辑约定。它不是代码硬关口；若与 \`schema.gates\` 或命令实际行为冲突，以代码强制的规则为准。修改约定不需要发版，但应在看板上留下变更记录。
> 来源：\`${toCliPath(collaboration.path)}\`

${collaboration.body}
`
    : `

## 接入后的读取顺序

先认识主用户和协作规则，再建立项目上下文：

1. 用 \`dp profile get\` 读取用户档案；不要猜测未填写的身份、习惯或授权边界；
2. 用 \`dp protocol get\` 读取全局协作协议；进入项目后加 \`--project <项目名>\` 读取项目覆盖；
3. 若当前工作目录有 \`COLLABORATION.md\`，阅读其项目补充约定；它不能覆盖代码硬关口；
4. 用 \`dp project get <项目名>\` 读取接手说明和状态计数（默认不给事项清单）；要事项入口时加 \`--limit 20\`，下一页用 \`--offset\`；
5. 用 \`dp project search <项目名> --query <关键词> --limit 20\` 找历史决定、评论和已完成事项；回执顶层 \`meta\` 里的 \`matched\`/\`nextOffset\` 决定是否继续读取；
6. 最后用 \`dp todo list --project <项目名> --status any --limit 20 --brief\` 查看有界事项范围，需要更多时显式增加 \`--limit\`。

MCP 客户端使用 \`get_profile\`、\`get_protocol\`、\`get_project\`、\`search_project\` 和 \`list_todos\` 对应工具。代码硬关口和命令参数以 \`dp schema\` 与实际工具返回为准；不要把项目约定当作绕过硬关口的授权。
`

  /**
   * 可直接粘贴的 MCP 配置片段（1.0.65）
   *
   * 只**生成字符串给人看**，不写任何文件 —— 见 resolveMcpPath 的注释。
   * 路径由主进程推导（开发态/打包态布局不同，写死必错）。
   *
   * 用 JSON 而非 TOML：Claude Desktop / Cursor / Claude Code 都用这个 `mcpServers` 形状。
   * 刻意**不逐个宿主给路径** —— 那是它们各自的约定，我们猜了就会过期，
   * 而猜错的后果是用户照着改了一个不存在的文件。宁可让用户查官方文档。
   */
  const mcpConfigBlock = [
    '```json',
    '{',
    '  "mcpServers": {',
    '    "deskpartner": {',
    // ⚠️ **路径必须转义反斜杠**（qwen 实测驳回，`4fb94740`）：
    // Windows 下 `resolveMcpPath()` 给的是 `<安装目录>\...`，
    // 直接塞进 JSON 是**非法**的（`\P` 不是合法转义）——
    // 而正文却写着"可直接粘贴"。**那句话本身就是假的。**
    // 用 `JSON.stringify` 生成路径字符串：**它会自己转义**，比手写替换可靠。
    `      "command": ${JSON.stringify(resolveMcpPath())},`,
    // ⚠️ **必须给 env**（同一处驳回）：正文让人"把 DESKPARTNER_AGENT 换成你的名字"，
    // 而片段里没有 env 键 —— 照抄的人得到一个**没有身份**的服务器，
    // 每条写操作都撞 `ambiguous_identity`。
    // 而这恰恰是"接入路径最容易死在第一步"的地方。
    '      "env": {',
    '        "DESKPARTNER_AGENT": "agent:<你的名字>"',
    '      }',
    '    }',
    '  }',
    '}',
    '```'
  ].join('\n')

  const howToCall = useEnvVar
    ? `**先取启动器路径，再调它 —— 不要把这个路径硬写进你自己的技能文件。**

安装目录会变（实测两周搬过两次家：\`测试应用\` → \`TestApps\` → \`测试应用\`），
硬写的绝对路径会**静默失效**：命令报"找不到文件"，而你以为是 CLI 坏了。
本机已配好环境变量，所以用取值方式而不是写死路径：

\`\`\`bash
CLI="$DESKPARTNER_CLI"          # 本机已配好，GUI 每次启动都会刷新它
node "$CLI" <命令> [参数]
\`\`\`

**兜底**（变量意外丢失时）：\`${cli}\`

**怎么确认变量在不在、指得对不对**：\`dp doctor\` 的 \`cli\` 块会如实报出
变量值、该文件是否存在、以及当前用的是变量还是兜底路径。
若报 \`source: "env-missing-file"\`，说明 DeskPartner 被挪走或卸载了 ——
让用户重新安装，或启动一次界面让它重写变量。`
    : `**用 \`node\` 直接调启动器**（本机尚未配环境变量，所以这里给绝对路径）。

\`\`\`bash
node "${cli}" <命令> [参数]
\`\`\`

[!] **这个路径会随安装目录变化而失效**（实测两周搬过两次家）。
若某天命令报"找不到文件"，先跑 \`dp doctor\` 看 \`cli\` 块 ——
它会告诉你变量配没配、当前该用哪个路径。
启动过一次界面之后，本机就会配上 \`DESKPARTNER_CLI\`，
那时重跑 \`dp skill\` 取一份新说明，里面会改成变量写法。`

  /**
   * 工具面从命令表派生（9d0df867）—— 不手写第二遍。
   *
   * 手写版枚举了 8 个工具，而真实工具面是命令表扣掉 `EXCLUDE` 之后的
   * 42 个。筛选与命名用 `mcp-tools-from-schema.ts` 的同一套规则
   * （`shouldExpose` / `mcpToolName`），读/写分组与 MCP 的 `readOnlyHint`
   * 同源（`riskOf(c) === 'read'`）—— 说明书列的必须是 MCP 真正暴露的那些名字，
   * 多一个少一个都是假情报。
   */
  const exposedTools = commands.filter((c) => shouldExpose(c.name))
  const readToolNames = exposedTools.filter((c) => riskOf(c) === 'read').map((c) => mcpToolName(c.name))
  const writeToolNames = exposedTools.filter((c) => riskOf(c) !== 'read').map((c) => mcpToolName(c.name))
  const toolList = (names: string[]): string => names.map((n) => `\`${n}\``).join(' / ')

  return `---
name: desk-partner-todos
description: 读写本机 DeskPartner 待办（共享工作台）。当用户要求记录、添加、查看、完成、修改或删除待办，或说"帮我记一下…""加个待办""我还有什么没做""这个做完了"时使用；**也在每轮对话结束前主动登记本轮做过的事**。
agent_created: true
version: "${version}"
generated_at: "${generatedAt}"
---

# DeskPartner 待办（共享工作台）

> **这一册是"真源"，不是交付物。** agent 拿到的只有入口页（\`dp skill\`）与主题切片
> （\`dp skill <主题>\`），两处都由本册 + 下方的 \`GUIDE_TOPICS\` 表供出来。
> 加一节或改一节之前先问"**这一节进哪份出口**"：一份出口都没进的节 = 没写。
${collaborationSection}
## 怎么调用

${howToCall}

**不要用 \`.cmd\` 包装脚本**：从程序里调它需要同时满足反斜杠路径、shell 解析、
以及 \`node\` 在 PATH 里三个条件，缺一个就会失败。上面这种形式绕开了全部不确定性。
（\`dp.cmd\` 是给人手敲的，agent 不要用。）

> 下文出现的 \`dp <命令>\` 都是**本启动器的简写**。本机没有 \`dp\` 这条命令
> （产品不往用户 PATH 里写东西），执行时换成上面「怎么调用」里的完整写法；
> MCP 客户端改用同名工具。

---

## 核心纪律：每轮对话结束前主动登记

**不用等用户说"记一下"。** 在给出最终回复之前，把这一轮的事登记进去。

**登记时不必再手动带 \`--created-by\`**（1.0.73 起）：你持 agent 身份调用，
提出者默认就取你的身份，不会再被记成 \`human\`。
（\`--owner\` 仍是它的兼容别名。）要**代录**别人的事项（如代用户记一条）才显式传它；**声明了身份时不能填别的 agent**
（那会报 usage_error —— 冒名会把动作人、动态、提出人整条链一起记错），
要把活派出去请改用 --executed-by。

> 1.0.73 之前这里有一步必须自己记得做：不传 \`--created-by\` 就落成 \`human\`，
> 于是在看板上与"用户自己提的待办"分不开，事后只能逐条补。
> 现在改成**按机制兜底**——你持证调用，归属就不会错。
> 不带身份调用（人自己在终端敲）仍然是 \`human\`，那是正确的。

三步里前两步你可以自己办、第三步必须由人点头**（1.0.47 起注册与领凭据是自助命令；
唯独"批准"不能自己办 —— 自己批准自己等于没有门禁）：

\`\`\`bash
# 1) 注册（你可以自己跑；重复跑只更新展示名）
dp agent register --id agent:<你的名字> --name "展示名"

# 2) 领凭据（你也可以自己跑）→ 落到 ~/.deskpartner/credentials.json
dp agent credential --id agent:<你的名字>

# 3) 用户在「主窗口 → 审批页 → 待批准身份」里点「批准」
#    —— 这一步只能人做，你等即可
\`\`\`

**注册那一刻界面就会提醒人**（1.0.63 起：顶部横幅「XX 已接入，等你批准写入」），
所以你**不需要**去催、也不用重复注册 —— 回执里的 \`nextSteps\` 会告诉你卡在哪一步。

办完之后**你不用再记着任何事**：启动器每次调用自动带上身份与凭据，
写命令才放行，流转历史和埋点记的都是你。

> [!] 走完 1、2 之后**在批准之前**调用写命令，会得到退出码 4 +
> \`identity_pending\`（已注册、等人批准）—— 这不是出错，是在等你的人点头。
> 查当前卡在哪一步：\`dp agent whoami\`（不带 id = 自检，
> 它会逐档告诉你缺哪一级：\`identity_unregistered\` → \`identity_pending\` →
> \`credential_missing\` / \`credential_invalid\`）。

> [!] **1.0.37 起：本机有多份凭据、这次又没声明身份时，不再替你猜。**
> 此前会回退到 \`default\`（先领凭据的那一个），于是同一台机器上两个 agent 混用时，
> 后者的调用与授权申请会**全记到前者名下**（Bob实测踩到过）。
> 现在这种情况报退出码 4 + \`ambiguous_identity\`，并列出候选身份 —— 请明确声明：
> \`\`\`bash
> export DESKPARTNER_AGENT=agent:<你的名字>
> \`\`\`
> 只读命令不受影响（查询不需要身份）。本机只有你一份凭据时照旧零摩擦。
> \`dp agent whoami\` 会把这个情况直接报出来（\`ambiguousIdentity\`），不用撞墙才知道。

为什么这么设计：靠"记得 export 环境变量"守不住 —— 实测 1147 条 CLI 调用里
1142 条被记成了 human（挂在用户名下）。权限必须由机制强制，不由调用方自觉。

### 如果你是通过 MCP 接入的（1.0.59 起支持）

DeskPartner 同时是个 **MCP server**（\`mcp.cjs\` 随包发布，stdio transport）。
宿主支持 MCP 时，这是**最省事的一条路** —— 工具自带参数说明，
握手时 initialize 还会带回一份规矩（关口、身份、读默认口径），
不必先读这份长文档。

- **寻址**：\`<安装目录>/resources/cli/mcp.cmd\`（Windows；
  它借 \`ELECTRON_RUN_AS_NODE=1\` 用 DeskPartner.exe 当 node 跑 \`mcp.cjs\`）。
  开发态对应 \`out/cli/mcp.cjs\`。宿主配置里把它填成 command。
- **身份**：在 MCP 配置的 \`env\` 里设 \`DESKPARTNER_AGENT=agent:<你的名字>\`，
  启动器会自动带凭据（注册+批准之后零配置）。
  不想改配置也行：**写工具都收一个 \`actor\` 入参**，传了就以该身份这次调用。
- **注册与领凭据不在工具面里**（它们要落凭据文件，属于"接入动作"不是"干活动作"）：
  用同一个启动器的命令行跑一次 \`agent register\` / \`agent credential\` 即可，
  之后 MCP 这边就自动带上了。**注册完界面会主动提醒用户**，你等批准就行。
- **工具面**：${toolList(readToolNames)}（读），
  ${toolList(writeToolNames)}（写）。
  读工具标了 \`readOnlyHint\`，写工具没有 —— 宿主据此决定要不要弹确认。
- **读默认有界**：\`list_todos\` 默认只回未完成、默认 \`brief\`、默认最多 ${DEFAULT_ROW_LIMIT} 条。
  要全量传 \`status:"any"\`，要更多传 \`limit\`，要翻页传 \`offset\`（回执给 \`nextOffset\`，读完了是 null）。
  非 json 输出也默认有界：逐行导出类（\`export_telemetry\`）不传 \`limit\` 时默认最多 ${DEFAULT_ROW_LIMIT} 条，
  \`batch\` 里的同一条命令也按这个默认跑（行结果的 \`appliedDefaults\` 会标出来），整批另有总量上界
  （超了回执带 \`truncated\`、\`skipped\`，剩下的记录**没有执行**，拆成新的一批再发）。
  （**CLI 直连不受这条限制**，重定向成文件仍是全量）；要看更多就显式传 \`limit\`。
- 两条路的**门禁、守卫、审计完全一致**（MCP 工具就是拼 argv 交给同一个启动器），
  所以本文件里关于关口/授权/描述与评论分工的规矩，对 MCP 同样适用。

- **可直接粘贴的配置片段**（1.0.65）：宿主配置里要加的是这一段 ——
  \`command\` 填本机真实路径，\`env\` 里的 \`DESKPARTNER_AGENT\` 换成你自己的名字。
  ${mcpConfigBlock}
  - [!] **DeskPartner 不会替你写这个文件**（写第三方应用配置属于高风险注入，
    见下方"产品边界"）。要么用上面那段，要么在宿主自己的 MCP 设置界面里填。
  - 各宿主把 \`mcpServers\` 这一层放在哪个文件里不一样，
    **本产品不猜** —— 请查你所用宿主的官方文档，然后照它的位置放。

### 四档权限：读 / 写 / 改界面 / 删除（1.0.36）

**"批准"只覆盖写待办这一档。** 另外两档要额外点头，且**点头有期限**：

| 档位 | 覆盖的命令 | 有效期 |
| --- | --- | --- |
| 读 | \`todo list\` / \`todo history\` / \`schema\` / \`doctor\` … | 免批，不需要身份 |
| 写 | \`todo add/update/done/pin/unpin/set-owner\`、\`memo add\`、\`category add\` … | 批准一次，长期有效 |
| 改界面 | \`ui set\` / \`ui reset\` | **仅本次会话**（也可由人给长期） |
| 删除 | \`todo rm\` / \`memo rm\` / \`project rm\` / \`category rm\` / \`telemetry clear\` | **一次性**，用掉即止，下次还得问 |

还有两条**按目标升级**到删除档：\`todo delete-comment\` 删别人写的评论、\`category merge\` 的源分类下还有待办。
后者在源分类是空的时候按写档直接执行（那只是标签整理，不该为此打扰人）。

撞到改界面/删除这一档时，会被退出码 4 + \`grant_required\` 拦下，
**同时自动生成一条授权申请**。做法：

1. 告诉用户「我需要改界面 / 删除的权限，请在 主窗口 → 审批页 → 等你点头 里点允许」；
2. 用户点完允许，**服务端会当场把这件事做掉 —— 你不需要重试这条命令**
   （重试只会撞上"授权已被消费"）。想知道结果，看界面上的执行回执，或查 \`dp todo history\`。

**1.0.37 起申请会主动通知用户**：被拦的那一刻会往事件表落一条记录，
正在运行的界面会弹**顶部红底横幅**（标题「AI 在等你批准」，按一下直达那一屏），
悬浮球上也会挂红点。所以同一会话里你**重复被拦不会重复打扰** ——
申请会合并成一条，通知也只发一次。**你的动作就是等**：用户一点允许，
服务端当场执行，不必回来重跑（回跑会撞上"授权已被消费"）。

开工前想知道自己有没有这一档：\`dp agent whoami\`（不带 id = 自检，
\`scopes\` 里逐档给结论）。查账/撤销记录：\`dp agent grants\`（默认只列还有效的，看历史传 \`--status any\`）。

跨身份协作沟通三分法：**有具体事项 → 事项评论（\`todo comment\`）；需主用户拍板决策 → 待确认事项（\`todo add --status proposed\`）；无具体事项、跨身份留口信 → 备忘（\`memo add --to <身份>\`，对方可用 \`memo add --reply-to <id>\` 在同一线程回复，别把口信塞进评论或待确认队列）**。

### 新 agent 接手项目的开场路径（1.0.93）

不要一上来只跑 \`todo list\`：它默认只回未完成事项，查不到评论里的历史决定。
进入一个已有项目后，按下面顺序建立最小上下文：

1. \`dp project get \"<项目名>\"\`：先读项目接手说明和状态计数（默认不给事项清单）；要事项入口时加 \`--limit 20\`，更多用 \`--offset\` 分页；
2. \`dp project search \"<项目名>\" --query \"<关键词>\" --limit 20\`：查接手说明、事项标题/描述、全部状态事项和评论正文；按回执顶层 \`meta\` 里的 \`matched\`/\`nextOffset\` 继续读取；
3. \`dp todo list --project \"<项目名>\" --status any --limit 20 --brief\`：再看当前与历史事项分布，避免一次读取全库；
4. 从结果中选择一条真正未完成的事项，先读详情和最近评论，再开始写入。

接手说明负责背景、入口、当前决定和下一步；仅当项目目标/方向、关键决定（做与不做）、工作入口或当前主线变更时才更新接手说明，禁止手抄发版日志与实时计数（事项状态与进度从数据库实时读取，不要手抄发版日志或状态计数）。历史评论和流转属于交接材料，备份导出也必须一并保留。

Agent 更新接手说明时，不得直接调用 \`project handoff-update\`；应提交提议并等待主用户在「审批」页处理：

\`\`\`bash
dp project handoff-propose "<项目名>" --body-file "handoff.md"
dp project handoff-proposals
dp project handoff-proposals --all
\`\`\`

提议采纳后才会成为当前接手说明，并新增修订记录；可用 \`project get\` 回读（若刚提交的 pending 提议有误，发起人可用 \`--withdraw <id>\` 自行撤回）。主用户在 GUI 概览中可直接编辑，CLI 的 \`project handoff-update\` 仅供主用户直接保存。

跨身份协作沟通三分法：**有具体事项 → 事项评论（\`todo comment\`）；需主用户拍板决策 → 待确认事项（\`todo add --status proposed\`）；无具体事项、跨身份留口信 → 备忘（\`memo add --to <身份>\`，对方可用 \`memo add --reply-to <id>\` 在同一线程回复，别把口信塞进评论或待确认队列）**。

### 项目是必填项（1.0.37）

\`todo add\` **必须带 \`--project\`**。这不是麻烦，是看板能用的前提：
项目是"这件事围绕什么在做"的维度，留空的话一条条待办就退化成看不出归属的孤立动作，
用户从看板上看不出任何人在忙什么。

\`\`\`bash
dp todo add --title "..." --project "DeskPartner" --created-by agent:<你的名字>
\`\`\`

- 项目**不存在会直接报错**（退出码 3，\`not_found\`，并列出本机已有项目）——
  确要新建加 \`--create-project\`，或先 \`project add\`（1.0.40 起，防错字分叉出垃圾项目）。
- 忘了传：报错里会**直接列出本机已有项目**，照抄一个即可，不用先跑 \`project list\`。
- **不能清空**：\`todo update <id> --project clear\` 或空串会被拒。要换归属就传新项目名。
- 登记前先看看这个项目里已有什么：\`dp todo list --project "<项目名>" --brief\`。
- **列表看摘要，单条看全文**：\`todo list\` 每条的 \`description\` 默认只回前 ${LIST_DESC_PREVIEW_CHARS} 字（超出时 \`descriptionTruncated: true\`）；要某一条的全文、评论与流转，用 \`dp todo get <id>\`。
  回执的 \`meta.fields\` 会**自报这一次的描述口径**（\`preview\` / \`omitted\`）—— 走 MCP 时默认是 \`omitted\`，同一份库两次字节数差一大截，原因在这里（1.0.110，\`516a74d4\`）。
- **看全貌要显式要**：\`todo list\` **默认只回未完成的前 ${TODO_LIST_DEFAULT_LIMIT} 条**（open 四列：proposed/todo/in_progress/awaiting_review，排除 done 与 suspended/discarded）；继续读取配 \`--offset\` —— 回执里的 \`meta.nextOffset\` 就是下一段的起点（与 \`project search\` 同一套）；明确要全量才传 \`--limit 0\`（**全族同一个含义**：0 = 不做条数收窄，\`project search\` / \`project get\` / \`memo list\` / \`todo inbox\` / \`todo history\` / \`project handoff-history\` / \`telemetry export\` / \`agent grants\` / \`work next\` 同款；\`notification list\` 也支持 \`--offset\`）。
- **先项目、后状态**（顺序有讲究）：\`todo list --project "<项目名>" --status <状态>\` 是常规读法 ——
  没有项目维度时，状态这一维会把好几个项目的事项混在一页里。不传 \`--project\` 就是**全机（跨项目）查询**：
  跨项目盘点（全机待验收多少张、谁被塞了多少张、有没有卡指派给我）确实需要它，所以这条路**保留**；
  但回执会**明说**这件事 —— \`meta.projectScope\` 给 \`kind\`（\`all-projects\` / \`project\`）、本页涉及的项目名与个数。
  要按项目看，把 \`--project\` 补上即可。
- **声明了上限的命令都能翻页**（1.0.109 起）：\`todo list\` / \`project search\` / \`notification list\` 之外，
  \`memo list\` 与 \`todo inbox\` 也收 \`--offset\`（回执给 \`returned\` 与 \`nextOffset\`，读完是 null；\`memo list\` 不截断时**仍然回数组**）。
  \`telemetry export\` 是逐行输出、没有信封放 \`nextOffset\` —— 它的终点判据是**回空页**，别用"本页少于 --limit 就到底"反推（恰好整除时那是错的）。
  要连已完成、挂起、已废弃一起看（真全量，七列全含），传 \`--status any\`；只看某几列传 \`--status todo,in_progress\`。
- **回执自带计数**：list 回执的 JSON **顶层**有 \`meta\` —— \`matched\`（命中多少）、
  \`returned\`（这次回了多少）、\`truncated\`（这一页之后还有没有）、\`nextOffset\`（下一段的起点，读完了是 null）、\`byStatus\`（各状态各多少）。
  要"看板各列各多少"直接读 \`meta.byStatus\`，别把整批拉回来自己 for 一遍。
  计数在 \`meta\` 里而不是 \`data\` 里，是为了让**这几条 list 命令**的 \`data\` 始终是数组（老脚本按数组解析不受影响）。\`project search\` 同款（1.0.107 起，修 \`9bf9f667\`）：命中在 \`data\` 数组里，\`matched\`/\`returned\`/\`truncated\`/\`nextOffset\` 在同一处顶层 \`meta\`。
- **\`data\` 是数组还是对象，看 schema，别按键试错**（1.0.110，修 \`07a244d9\`）：一批的回**数组**（多数 \`list\` / \`search\` / \`proposals\` 类命令），一条或一份汇总的回**对象**（\`todo get\` / \`todo children\` / \`project get\` / \`notification list\` …）。每条命令的答案都写在 \`dp schema\` 的 \`commands[].dataShape\`（\`array\` / \`object\`）里 —— 有它就不必先跑一遍看是 \`[]\` 还是 \`{}\`；\`skill\`（原文）与 \`telemetry export\`（逐行）没有信封 \`data\`，形状由 \`output\` 回答。

### 记什么

**这一轮做过的事**（\`--status done\`）—— 这是重点，**做完的也要记**。
只看未完成项，就丢掉了"一件事是怎么被完成的"这个全貌。

**还没做完的事**（\`--status todo\` 或 \`in_progress\`）—— 留给下一轮接手。

### 更要紧的：把已登记的同类事项勾掉

登记之前**先 list 一遍**，看有没有已经存在的同一条。

\`\`\`bash
dp todo list --status any --limit 100 --brief   # 有界看全貌（裸 list 默认只回 open 前 ${TODO_LIST_DEFAULT_LIMIT} 条；要真全量传 --limit 0）
dp todo list --status any --limit 100 --offset <上一条回执里的 meta.nextOffset> --brief   # 翻页：接着往下读，不必一次拉全量
dp todo update <id> --status done        # 勾掉状态
dp todo comment <id> --body "结论…"       # 收口结论（别写进描述）
\`\`\`

三个理由，缺一个都会让看板失真：

1. **同一件事不要登记两次。** 上一轮已经记成"待做"的，这一轮做完了就应该
   在原条目上标完成，而不是再建一条"完成了 X"。否则看板里同一件事出现两次，
   一次还挂着"待做"，用户根本分不清到底做没做。
2. **完成时补结论最划算。** 做的时候才知道坑在哪。**收口结论也用评论写**
   ——\`todo comment <id> --body "完成了什么 / 结论 / 有什么坑"\`（G3/G5 会提醒）。
   卡片上不显示，但点开详情页能看到，这正是共享工作台相对文件记忆的价值。
   [!] **描述与评论分工只有一条线**：\`description\` 只放**原始规格**（当初要做什么），
   此外一切——进度、问答、收口结论——都走评论 \`todo comment <id> --body "..."\`。
   别把往来追加进描述，那会把规格冲乱（1.0.54；主用户 2026-09-28 拍板：
   结论也进评论，不做"什么算结论"的二次判断）。
3. **状态错了比没记更糟。** 一条永远挂着"待做"的已完成事项，会让用户
   误判还剩多少工作量。

**判定方法**：拿这一轮做的事，去 list 结果里搜关键词。命中就更新，没命中才新建。

### 项目工作空间与版本边界（1.0.84）

项目是工作的上下文，不是可以随意清空的普通筛选项：

- GUI 进入项目后，概览、事项、动态、版本四个页签都属于同一个项目；动态里的项目通知也只看当前项目。
- CLI / MCP **不能依赖 GUI 当前选中的项目**。每次事项写入仍显式传 \`--project\`；换 agent 或换窗口不会改变命令的归属。
- 项目记录检索与事项筛选不是一回事：项目页签里的「全局搜索」（工作台顶栏也有同名入口）跨项目检索，进入项目页签时默认预选当前项目、可改选多个项目；覆盖接手说明、事项标题/描述、评论和历史状态；事项页的「搜索与筛选」只筛当前项目的当前列表，它与「新增」「批量」一起放在事项页内，不在顶层。找旧决定时不要因为当前看板没有命中就断言“没有记录”。从事项筛选无结果进入项目搜索时，会带入原关键词。
- 项目动态页把“项目动态”和“项目通知”做成显式切换；时间线回答发生过什么，项目通知回答需要你知道或处理什么，不要把两者混称。系统通知只收系统级消息；历史上缺少项目归属的业务通知不会被猜测归类，会在系统通知中明确标为“未归属业务通知”，后续应人工确认来源。新建项目会生成接手说明基础模板，GUI、CLI、MCP 走同一套模板语义。历史检索使用「全局搜索」，不要把事项页的搜索与筛选当成历史检索。删除版本时若仍有事项关联会被拒绝，界面会列出这些事项并提供「解除标记」，需先解除再删。指南跟随产品行为变化，取 \`dp skill\` 获取最新版本。
- 版本是项目下的二级概念：同一个版本号可以在不同项目各自存在；查询、详情和事项关联都要带项目语境。
- 删除版本前先查关联事项。只要仍有事项的 \`fixed_in_version\` 指向它，删除会被拒绝；先逐条解除关联（例如 \`todo update <id> --fixed-in clear\`），确认没有关联后再删。删除版本不会删除事项。

**验收交接**：开发完成后不要停在 \`todo\`。写结论评论、标记已发布版本、再把事项推进 \`awaiting_review\`；用户验收通过后才由验收方推进 \`done\`，不通过用 \`todo reject\` 退回 \`in_progress\`。

### 修一张卡，配一条以卡 id 命名的回归用例（1.0.75 立约，1.0.110 写进说明书）

**改完一张卡，把守它的那条用例一起留下 —— 用例名（或文件名）里带上这张卡的 8 位 id。**
这条纪律 1.0.75 就立了，但它当时只活在评审的口头约定和执行者的记忆里，
于是**换一个执行 agent 就归零**：2026-10-15 审计实测，全仓用例里带 8 位卡 id 的只有
**12 条**（约占 0.8%）—— 谁修过哪张卡、当时坏在哪，事后翻不出来。
**判据写在这一节里，不要抄进你的长期记忆**（理由同下一节：两份真相必然对不上）。

- **名字里带 id**：\`tests/main/cli/g5-closure-structure-eec2e1e7.test.ts\` 这样，
  与 CLI 的 id 前缀同一口径（8 位十六进制短号）；
- **断言打在行为上**：真跑一条命令 / 真读一次存储，看回执与状态 ——
  只比字符串常量或注释的用例守不住任何东西；
- **顺手反向验证一次**：把修复改回去，这条用例应该变红；没红，说明它没守在那件事上。

**自检与评审抽查是同一条**：\`find tests -name '*.test.ts' | grep -E '[0-9a-f]{8}'\`
列出的是用例名里带 8 位卡 id 的那些；刚修的那张 id 不在里面，就是漏了。

### 任务同步闭环（每轮结束前的固定动作）

**查 → 更 → 登**，三步，理由就在上一节（不重复）：

1. **查**：\`dp todo list --status any --limit 100 --brief\`（可加 \`--created-by agent\`），搜与本轮工作相关的关键词；
2. **更**：命中的原条目用 \`dp todo update\` 推进状态、补结论 —— 不要新建重复条目；
3. **登**：没命中的新工作才 \`dp todo add\` 登记（带 \`--created-by agent:<你的名字>\`）。

**这条闭环不必你抄进任何地方** —— 它就在这份说明书里，你每次 \`dp skill\` 取到的都是最新的。

[!] **反过来说：不要把它抄进你自己的长期记忆或 agent.md。**
两份真相必然对不上 —— 说明书改了而你那份没改，
于是你会按过期的规则干活，且**没有任何迹象提示你它过期了**。
**判据的出处只能是说明书。** 你需要记住的只有一句：
**每轮收尾前跑一遍上面那三步。**

#### 收口：优先用 \`dp todo close\`（1.0.67 起）

**写完一件事要收口时，优先用这一条**，它把四段一次写全：

\`\`\`bash
dp todo close <id> \\
  --did "把 X 改成了 Y" \\
  --verified "跑了 Z，看到 W" \\
  --pass-criteria "目标是 T，达成到 T 即算过" \\
  --leftover "没做 U；V 留给谁"
\`\`\`

- **前三个必填**（缺一个就拒），\`--leftover\` 可留空但会提醒。
- 它写的评论**天然是四段**，不用你自己组织语言 ——
  这正是它存在的意义：Bob实测**一次批量关 30 张卡全部放行，而其中一半当初只有一行字**。
  而要求评论必须含四个标记词又会**逼出为过校验写的空壳段落**。
- **G5 的判据（1.0.110 起）**：收口文本（描述 + 非驳回评论）里要出现这四段标记里的**至少一个**，
  否则标完成时回执顶层带一句提醒。**一句话的评论（"做完了"）不算收口结论** ——
  判据落在内容上，不看评论条数。仍只提醒、不拦，退出码不变。
- **它不绕过任何守卫**：执行者验收自己做的活照样被拒（1.0.67 起按角色定权）。
- **收口是原子操作**：四段结论评论与状态变更在同一事务中提交。守卫拒绝或存储失败时，不会残留本次的收口评论、流转或通知；已有评论不受影响。
- **已废弃不能由 agent 自行重开**：可以继续补充资料，但改变终态必须由用户在界面上确认；不能用 \`todo close\` 将“不做了”改成“做完了”。

| 想做的事 | 用哪条 |
| --- | --- |
| 收口自己的活（四段写全） | \`dp todo close <id> --did … --verified … --pass-criteria …\` |
| 验收别人的活 | 同上，但你**不能是执行者** |
| 只想留一句话 | \`dp todo comment <id> --body "…"\`（一句话不算收口结论，G5 会提醒） |
| 记一笔从没进过待验收的流水 | \`dp todo add --status done\`（不受 G10 管） |

#### 做完了怎么交（收口的第三件事，最容易漏）

上面三步做完，**活还没交到人手里**。还差一步：

\`dp todo update <id> --status awaiting_review\`

**为什么这一步不能省**：卡停在「待办」或「进行中」时，
人看到的是"还没做"；只有推进「待验收」列，他才会看到"这件事做完了，来看看"。
实测过一次：7 张卡标了版本、提交了代码、结论评论也写了，
**状态全停在「待办」** —— 于是人看板上「待验收」是空的，
"他这两天做的事一件都看不到"。代码交付和交付给他，是两件事。

**完整顺序**（三步，别调换）：

1. \`dp todo comment <id> --body "…"\` —— 写清做了什么、结论、遗留
2. \`dp todo update <id> --fixed-in <版本>\` —— 标它在哪一版修的
3. \`dp todo update <id> --status awaiting_review\` —— **推进待验收，人才能看见**
4. \`dp project handoff-propose "<项目名>" --body-file handoff.md\` —— **仅当项目目标、关键决定（做与不做）、工作入口或当前主线变化时才更新接手说明，禁止手抄发版日志与实时计数**（审批页采纳后生效；不要把发版日志或实时状态计数手抄进说明）

**自检**：\`dp todo list --status awaiting_review\` 里应该有你刚做完的卡。
**空，就是漏了第 3 步。**

#### 版本归属：\`--fixed-in\` 什么时候能标

\`--fixed-in\` 回答"**哪一版修的**"，而 \`--status awaiting_review\` 回答
"**你要不要看**"。两个都要，缺一不可。

[!] **\`--fixed-in\` 是承诺，不是事实。** 标它之前必须已经：

| 检查 | 命令 | 不满足会怎样 |
| --- | --- | --- |
| 版本号已升 | \`node -p "require('./package.json').version"\` | 指向一个不存在的版本 |
| 产物已出 | \`ls dist/ | grep <版本>\` | 同上 |

**只做到"代码写完 + 测试绿"就标，等于把一条未兑现的承诺写进了唯一的账。**
而**指向不存在版本的卡无法验收** —— 人打开发现没有那个版本，这一轮就白等。

标错了能改：\`dp todo update <id> --fixed-in unset\`。

### 状态关口：候选池（什么能自己动，什么必须等人）

看板七列：**待确认 → 待办 → 进行中 →（挂起）→ 待验收 → 已完成**，外加一列
**已废弃**（1.0.68 起，见下）。首尾两列是人机之间的确认关口，agent 不得自行跨越。

**「挂起」与「已废弃」的区别（别混用）**：

| | 语义 | 还要不要回顾 |
|---|---|---|
| \`suspended\` 挂起 | **等条件满足再回来做** | 要 —— 得记住在等什么 |
| \`discarded\` 已废弃 | **不做了，这是结论** | 不用 —— 它已经有答案了 |

**为什么要有「已废弃」**：一个状态同时装着"已完成"和"在等人"，
于是谁都扫不出来（实测挂起列一度 34 张，混着「已拍板不做」「等基建」
「等你点名」「别的项目的」四种）。**而"决定不做"是值得留档的结论，不是垃圾。**

**什么时候用哪个**：
- 这件事**还会做**，但现在做不了 → \`suspended\`，**并在评论里写清在等什么**
- 这件事**决定不做了**（不做/重复/被替代/无效）→ \`discarded\`，并写清为什么不做了

[!] \`discarded\` **不是 \`done\`**（那是"做完了"），
混用会让"完成率"这个数字失真 —— 它也不该被算进「未完成」。

**${GATES.length} 道关口强度不同，别把提醒读成拦截：**

| 关口 | 强度 | 触发信号 | 该怎么做 |
| --- | --- | --- | --- |
${renderGatesTable({ escapeBackticks: true })}

[!] 软提醒**不拦执行、不改退出码**，只出现在成功响应的**顶层 \`notice\` 键**里
（不在 \`data\` 里，也不在 stderr）。只解析 \`data\` 的 agent 会永远看不见它们 ——
而这两道恰好是唯一管住"随意宣布完成"的机制。

- **提议（你建议、用户还没点头）→ \`--status proposed\`**。
  它会落在「待确认」列等人拍板。**agent 侧任何 \`todo update <id> --status todo/...\`
  都会被硬拦（G4，退出码 4）**，这是故意的 —— 等用户，不要代转。
  **用户明确要求记录的不用提议**，直接建。
- **删除「待确认」列：可以发起，但要人点头**（2026-09-28 修正口径）。
  \`todo rm\` 不会被硬拒，而是转成一条**授权申请**等你批准（退出码 4、\`grant_required\`），
  你在横幅或审批页点「允许」后当场删掉 —— 等价于"人自己删"。
  **别想着"删掉再另建一条"来绕开关口**：授权是**绑目标**的（v19），
  批的是 A 就只能删 A，先把 B 混进来等于自己撞墙。
  （此前这里写"会被 G4 拦下"，与实现相反，qwen 实测抓到。）
- **父需求做完 → \`todo update <父需求id> --status awaiting_review\`**，
  落进「待验收」列请人验收。**要留收口结论**：\`todo comment <id> --body "做了什么 / 结论 / 坑"\`
  —— 没留会被提醒（G3）。**别再写 \`--desc\`**：描述只放原始规格（1.0.54）。
- **子任务约束**：父需求还在「待确认」时不能建子任务（G1）；
  父需求转「待验收」要求所有子任务已完成（G2，未过会报错）；
  **父需求直接置 done 也要过同一道检查**（G6，2026-09-19 起）——绕开「待验收」
  直接归档并不能把没做完的子任务埋掉。先把子任务完成 / 删掉 / 改派，再来归档。
  子任务挂 \`--parent <父需求id>\`（支持 id 前缀，与其它命令一致）。
  删父任务时若它还挂着子任务，CLI 会**先拦下**并告知会解绑几条（上加 \`--force\` 才继续删），
  想先看是哪几条用 \`todo children <父需求id>\`。
- ### 规格与往来分开：描述是规格，往来走评论（2026-09-28 立规矩，1.0.54）
  **描述（\`description\`）只放原始需求规格**，不要拿它当"往来记录箱"。
  追加进度、结论、往来会让描述越来越长、分不清哪句才是原始需求。往来一律走评论：
  - 发评论：\`todo comment <id> --body "..."\`（回复某条评论加 \`--reply-to <评论id>\`）；
    **长文本 / 多行 / 含反引号 $ < 的正文走 \`--body-file <文件路径>\`**（与 \`--desc-file\` 同一机制，避开 shell 吞字符）；
  - 改状态时留理由：\`todo update <id> --status x --comment "..."\`（长理由走 \`--comment-file <文件路径>\`）；
  - 看评论线程：\`todo get <id>\` 的返回里带 \`comments\`（每条含 id/作者/种类/正文/时间）；
  - 删评论：\`todo delete-comment <评论id>\`（支持短号；连带它的回复一起删）。别用新评论掩盖写错的那条，删掉重发。

> **互指**：「待验收 → 已完成」谁能签（G10 运动员不当裁判）、验收不通过怎么退回（\`todo reject\`）见下一节「验收与退回（谁说了算）」。

### 验收与退回（谁说了算）

> **互指**：候选池关口（G4）、子任务关口（G1/G2/G6）与 ${GATES.length} 道关口总表见上一节「状态关口：候选池（什么能自己动，什么必须等人）」。

- **送进 done：先分清「验收」还是「记一笔」，两者动作完全不同（2026-09-25 补）。**
  - **验收**（条目已经在「待验收」列等你）：**由「验收者」收口，而验收者不能是执行者**
    （1.0.67 起按**角色**定权，\`a6032512\`）。三个角色：**提出者**（记下的）
    / **执行者**（干的）/ **验收者**（判它做完了），默认验收者 = 提出者。
    - **你验收别人的活**（你 ≠ 执行者）：\`todo update <id> --status done\`（或 \`todo close\`）直接放行。
      先写清验收结论（测了什么、过没过、遗留什么）。
    - **你验收自己做的**（你 = 执行者）：**会被拒**（退出码 4，守卫 G10）。
      运动员不当裁判 —— 1.0.116 起不论起点在哪一列，执行者把自己的卡置 \`done\` 一律拦。
      为什么不再一律"等人点"：人能验的只有界面/体验类，CLI 与内部机制类由提出方 agent 互验即可。
      **不要新建一条已完成事项来"汇报验收"** —— 那样原条目永远挂在待验收没人收口，已完成列表还多出空降条目。
  - **记一笔**（这件事本来就没有对应条目，纯粹登记做过的工作）：
    直接 \`todo add --status done\` 没问题 —— 但它天生没有过程记录，标题要让人看出"这是什么工作的收尾"。
  两种都**要写清为什么**：没写说明会被提醒（G5）。
- **别人（其他 agent 或人）提出/报告的事项**：建议先推 \`awaiting_review\`
  请提出者验收（\`todo comment\` 写清修复内容 + 给提出者的复测步骤）—— 这是协作礼仪，不是硬约束。
- ### 验收三态：通过就归档，不通过就退回（2026-09-28 立规矩）
  验收不是一个"写句评论"的动作，**必须落到状态上**。只往描述里追加结论、
  状态还留在「待验收」，看板就会把"其实没做完的事"说成"等你验收"—— 执行方根本不知道自己被驳回了。
  | 结论 | 该做什么 | 别做什么 |
  | --- | --- | --- |
  | **通过** | 你**不是执行者**时：\`todo close <id> --did … --verified … --pass-criteria …\`（或 \`todo update --status done\` + 结论评论）；\`--leftover\` 非空时系统会自动通知并投递备忘给执行方 | **别验收自己做的活**（执行者 = 你 时被 G10 拒，退出码 4）；也别新建一条"验收汇报" |
  | **不通过 / 有条件通过** | \`todo reject <id> --reason "缺什么、要补什么"\`（**一步到位**：写驳回评论 + 退回「进行中」） | 别只追加描述、状态不动；\`reject\` 的 \`--reason\` 是**必填**的 |
  | 验收方暂时没法判 | 保持 \`awaiting_review\`，但要写明卡在哪 | 别无限期挂着不说话 |
  **为什么是退回 in_progress 而不是留在 awaiting_review**：
  待验收 = "我做完了，等你点头"；进行中 = "这事还有人得继续干"。
  守卫只守「待确认」列（G4），**待验收 → 进行中是允许的自由流转**。

  执行方怎么知道自己被驳回了（2026-09-28）：
  - \`notification list --type review\` —— 通知中心**agent 也能查**，驳回记录带 \`meta.rejected\`；
  - 每次写命令的回执里也会提醒"你有 N 条被退回"。
  - [!] **驳回理由是一条 \`kind=reject\` 的评论，不在描述里** ——
    要读它用 \`todo get <id>\` 看 \`comments\`（find \`kind === 'reject'\`），别去翻 \`description\`。
  - [!] **"被退回"的判据也是那条 reject 评论，不是状态流转**（1.0.65 修）：
    \`awaiting_review → in_progress\` 执行方自己重开观察期也会推，那不算驳回。收到提醒时先 \`todo get\` 找 \`kind=reject\` 评论。

### id 前缀与错误码

- 所有带 id 的参数都支持**前缀**（\`todo rm 21bd6f34\`），不必粘全 uuid。
- 报错本身是可执行的信息，同一个 id 写错和被规则拦下是不同的码：

${renderErrorCodesTable()}

身份未注册的报错里会带上该怎么注册的命令，照抄即可 —— 不要自己发明写法。

### 先归到 story 里

**分类（category）就是 story 层**：一个方向 / 一个议题。
一轮对话里常常发散出好几个方向，**每个方向建一个分类**，别堆在同一层。

\`\`\`bash
dp category list                 # 先看有没有现成的方向
dp category add --name "竞争调研"  # 没有就建一个
dp todo add --title "..." --created-by agent:<你的名字> --status done --category "竞争调研"
\`\`\`

### 类型与执行者（v1.0.27 新增）

- **\`--type\`**：报缺陷传 \`bug\`，提需求/想法传 \`feature\`，普通任务不传（默认 task）。
  bug / feature 会在卡片上显示彩色徽标，task 不显示（降噪）。
- **\`--executed-by\`**：执行者，默认**执行者即提出者**（提出即执行，不用传）。
  只有"谁提出、别人去干"才传，典型场景：你报 bug 给用户修。
  要收回指派（回到提出者自己执行）：\`todo update <id> --executed-by clear\`。
  未显式指派时，非提出者实际推进到待办、进行中或待验收，会记录该调用者为执行者；
  改标题、描述、版本标记、验收或驳回不算接手，不改变执行归属。
  \`todo list --mine\` 按当前调用身份查询；\`--executed-by <身份>\` 包含自提自做与显式指派，
  \`--executed-by unset\` 则只表示没有显式指派。两种参数不能同时使用。
- **会话提醒**：声明 \`DESKPARTNER_SESSION\` 后，相同工作摘要在同一会话只展开一次；
  摘要变化或清空后再次出现时重新提醒。不同主体、不同会话互不压制；未声明会话时不猜测。
  \`notification list --ack-mine --limit N\` 只知晓给自己的、本次返回的通知，
  不会把未返回的消息或其他主体的消息记为已读，也不修改 GUI 的全局已读位。
- **动态口径**："验收通过"= **执行者≠提出者的跨主体交付**。
  你自己登记、自己做完的流水是"完成了"，不会再被显示成"验收通过"。

**边界**：这是归属标注，不是身份认证。本机任何进程都能自称某个 agent。
它解决"这条是谁提的、该谁干"，不解决"防冒充"。

### 产品边界：DeskPartner 不会替你改别人的东西

**这一节是给你的判断依据，不是待办。** 遇到"要不要顺手帮用户做 X"时回来读。

**1. 不写入用户的第三方应用配置。** 上面那段 MCP 配置要用户自己粘 ——
DeskPartner **只生成内容，不落盘**。原因不是"怕写坏"：那个文件属于**另一个应用**，
格式是**它的**约定，我们改了它，出问题时那个应用的作者与用户都查不到是谁改的；
而配置文件通常没有 undo。

**2. 不写用户环境变量。** 不往 PATH 里塞 \`dp\`（1.0.55 起已整体摘除），
不设 \`DESKPARTNER_*\` 之外的东西。需要某个环境变量时，让它**由自己设**。

**3. 不在用户的真实看板里造数据。** 探针与验证走一次性副本，
见上面「探针与验证」那节。

**判据：产品可以生成内容让用户自己决定用不用，不能替用户落到别人的盘上。**
这不是保守 —— 是**改别人东西这件事，代价由别人承担，而知情权在他手上。**

### 不记什么

**过程性动作不记。** 读了文件、搜了资料、跑了测试 —— 这些是手段，不是事情。
判断标准：**这件事如果单独说给别人听，有意义吗？**

- [反例] "读取了 tailwind.config.ts"
- [正例] "列头从整行色带改成小圆点"

### 标题与描述

**标题**：说清「哪里 + 什么现象 + 什么后果」，一行写完，≤30 字。
侧栏与卡片会截断，前 12 字必须已经能辨认。

- [正例] \`详情页能改文字却改不了状态：改到一半必须回看板\`
- [反例] \`指派合并\`（名词短语，没有现象也没有后果）
- 禁用：过程词（\`此前未登记\` / \`我的判断\`）、状态词（\`待拍板\` —— 状态由看板列表达）、
  空词（\`问题\` / \`优化\` / \`相关\`）

**描述**：唯一目的是**让读到它的人能行动**。按阶段写，三套要求不同：

**① 提出事项时** —— 先说清两件事，再给六个要素

1. **目前的问题是什么**（现在哪里不对、什么时候会疼）
2. **要你定的是什么**（一句话讲明白要他做的决定，不是"看看这个"）

然后给：**现状 / 证据 / 选项 / 代价 / 你的建议 / 不选会怎样**。

- **证据**要落到具体位置：\`QuickAddForm.tsx:477\`、实测数字、界面路径 —— 不许写"某处"
- **选项至少两个**；只有一个选项不叫选项，叫通知
- **每个选项都要写代价**（它牺牲了什么）—— 只写好处等于推销，对方反而无法判
- **必须表态**选哪个 + 一句话理由；不表态等于把判断推回给对方
- **不选会怎样**最重要：它把"维持现状"也变成一个要承担代价的选项

**判据：对方读完能直接回一句「选①」。**

**② 决策完成后** —— 记录决策结果，别只把卡片挪个位置

- 决策是什么（选①／做／不做），带日期
- **对方的理由要照录** —— 它通常比你的建议准，也是下次不再重复讨论的依据
- 被否的项写明"不做"，以及将来什么条件下才值得重提

[!] **别把"追问/澄清/反问"当成决策**。
「你这个问题需要细化一下：是哪一个？」是要澄清范围，**不是拍板** —— 判错了会把未定的事写成已定。

**③ 完成后** —— 给出完成说明与验收内容

- **做了什么**：改了哪些文件 / 哪些行为变了
- **验证**：跑过的命令 + 结果，写出命令与数字，不写"测试通过"四个字
- **什么算通过**：验收判据 —— 对方照着看/跑一遍能自己判断过没过
- **取舍与遗留**：放弃的方案、已知的坑、没做的事

**三条通用禁忌**：不写过程只写结论（过程留给你的本地记忆）；
不写"我"（换成事实陈述）；引用必须落到具体位置。
完整版见仓库 \`ISSUE_STYLE.md\`。

> 建成「待确认」时若描述缺要素，回执里会给一条软提醒（不拦执行）。
> 改描述正文注意：\`--desc\` 默认**追加**，整体替换要加 \`--overwrite-desc\`。

### 一次记多条用 batch

用 \`batch\`（NDJSON 走 stdin）一次写完，比循环调用快很多，也不会把命令行刷屏。
记录格式不确定就先跑 \`batch --doc\`，有完整结构说明和例子。
从 MCP 接入时不用自己拼 NDJSON：\`batch\` 工具有一个 \`records\` 数组入参，
每项一条记录（对象或已经是 JSON 的字符串），工具会替你写进命令的 stdin。

> [!] \`batch\` 属于**写档**（它能执行写命令），要"已批准 + 有效凭据" —— 与单条写命令同一条规矩。
> 别把它当查询使：里面放的全是只读行，也一样要身份。

---

## 常用操作

\`\`\`bash
# 记一条（--due 支持 today / tomorrow / +3d / 09-20 18:00）
dp todo add --title "给张总回邮件" --priority high --due tomorrow

# 提议一件事（进「待确认」列，等人拍板）
dp todo add --title "调研 TAPD 迁移方案" --created-by agent:<你的名字> --status proposed

# 报一个缺陷给用户修（提出者=你，执行者=用户，类型=bug）
dp todo add --title "导出按钮无响应" --created-by agent:<你的名字> --executed-by human --type bug --status proposed

# 记一条已完成的工作
dp todo add --title "列头降噪：色带改小圆点" --status done --desc "四列整行色带视觉重量过重，抢了卡片的注意力"

# 看还没做的（默认就是未完成的；也可 --status todo,in_progress 精确到某几列）
dp todo list --limit 20

# 按项目看全貌（登记前先跑这个，避免重复建）
dp todo list --project "DeskPartner" --limit 100 --brief

# 看这一轮之后哪些被动过（省得逐条比 updatedAt）
dp todo list --updated-since 2026-09-30 --sort updated

# 别人分派给我的活（执行者不等于提出者的那些）
dp todo list --executed-by agent:<你的名字>

# 标记完成（先 list 拿 id，支持前缀）
dp todo done <id>

# 父需求做完，转「待验收」请人验收（结论走评论，描述只放规格）
dp todo update <父需求id> --status awaiting_review
dp todo comment <父需求id> --body "完成 X；结论 Y；坑 Z"

# 改字段（改标题/描述/优先级/截止/状态/标签/项目）
dp todo update <id> --priority high --due 09-20
dp todo update <id> --due clear          # 清空截止时间

# 置顶
dp todo pin <id>

# 查一条事项的流转历史（谁在什么时候把它从哪个状态推到哪个）
dp todo history <id>

# 改界面（1.0.28 起，只开放白名单内的纯视觉参数）
dp ui get                              # 看哪些能改、当前值是多少
dp ui set --key theme --value dark
dp ui reset                            # 视觉参数恢复默认

# 删除（必须带 --yes；「待确认」列的条目会转成授权申请等人批准）
dp todo rm <id> --yes
\`\`\`

## 输出格式

stdout 是 JSON（非 TTY 环境）：

- 成功：\`{"ok": true, "data": ...}\`
- 成功但有话要说：\`{"ok": true, "data": ..., "notice": "提醒：…（G3/G5）"}\`
  —— \`notice\` 在**顶层**，不在 \`data\` 里；收到就回显给用户，别丢
- 失败：\`{"ok": false, "code": "...", "message": "..."}\`

${renderExitCodesLine()}

日志走 stderr，stdout 保持纯净，可以直接解析。

## 注意

- **版本陷阱（重要）**：GUI 在跑时命令走常驻管道，管道那头是**正在运行的那个版本的代码**。
  分不清是写错还是版本旧：把命令去掉 \`--\` 前缀跑一次 \`schema\` 自省，
  **能列出该命令 = 写错了；列不出来 = 跑的是旧版** ——
  可设 \`DESKPARTNER_NO_PIPE=1\` 强制走无头通道（用磁盘上最新的那份），
  或提醒用户重启桌面端。
- **改界面只开放白名单**：\`ui set\` 只接受纯视觉参数。
  \`telemetryEnabled\`（隐私开关）、\`autoStart\`/\`globalShortcut\`（系统级）、
  窗口坐标（人的地盘）都会被拒绝。
- \`--title\` 只放事情本身，不要把整段对话粘进去
- 删除、批量修改这类破坏性操作，**先跟用户确认再做**
- 调用可能耗时 0.3~1.5 秒，给足超时

## 什么时候不要用

- 用户只是**随口提到**某件事，不等于要记。判断标准是"这算不算一件要做/做过的事"
- 不确定要不要记，就问一句
- **但不要因为怕记错就干脆不记** —— 宁可多记几条被用户纠正，
  也比该记的没记、下轮接手时抓瞎要好

---

*本说明由 DeskPartner 生成（CLI ${version}，${generatedAt}），路径已按本机实际安装位置填好。*
*版本低于 \`doctor\` 报的 \`skillVersion\` 时请重跑 \`dp skill\`。*
`
}

/**
 * 渐进式阅读的 L0 入口：默认只给 agent 接入和项目接手的最短路径。
 *
 * ⚠️ **「场景路由」表住在这里，不在 `buildAgentGuide` 里**（卡 `d3cc69a6`，2026-10-22）。
 * 它原先写在正文那一册，而正文**没有任何生产调用方** —— 于是"按场景直达"这件事
 * 对 agent 从来没生效过，正是 1.0.67 立这张表要解决的那个问题本身。
 * 现在表里的目标一律写成**可执行的出口命令**（`dp skill <主题>`）：
 * 指向正文里的小节名就是死链接 —— 那一节根本送不到。
 */
export function buildAgentGuideIndex(launcherPath = resolveLauncherPath(), version = 'unknown'): string {
  const cli = toCliPath(launcherPath)
  const generatedAt = new Date().toISOString()
  /** 「按需阅读」由 `GUIDE_TOPICS` 渲染 —— 主题清单只有那一处定义（卡 `d3cc69a6`） */
  const topicLines = guideTopicNames()
    .map((name) => `- \`dp skill ${name}\`：${GUIDE_TOPICS[name].summary}`)
    .join('\n')
  return `---
name: desk-partner-todos
description: 记录和接手本机 DeskPartner 工作；需要读写事项、项目或协作资料时使用。
agent_created: true
version: "${version}"
---

# DeskPartner：接入入口

> **自检**：本页对应 CLI **${version}**（生成于 ${generatedAt}）。把 frontmatter 的 \`version\`
> 写进环境变量 \`DESKPARTNER_SKILL_VERSION\`（**每取一份新的就更新一次** —— 它记的是
> "你手上这份"的版本：产品**无从核对**磁盘上那个文件，只信你声明的值，写旧了就会一直提醒你落后，
> 那是账实不符）。之后每次调用都会自动比对，落后了回执里主动提醒 —— G8，不拦你执行；
> 也可以跑 \`dp doctor\` 比 \`skillVersion\`。
> **过期说明里的"没有这个命令""不支持这个参数"都是假情报** —— 先重跑 \`dp skill\` 取一份新的。
> 本页示例一律用 \`dp\` 代替完整调用：\`dp\` = \`node <启动器路径>\`（CLI 在 schema 里就把它列为别名），路径取法见下文「调用入口」。

## 接入后先读什么

1. 先阅读本页，了解 CLI/MCP 的调用边界；MCP 客户端同时阅读握手 instructions。
2. 读取主用户档案：CLI 用 \`dp profile get\`；MCP 用 \`get_profile\`。不要猜测未填写的身份、习惯或边界。
3. 读取协作约定：CLI 用 \`dp protocol get\`；MCP 用 \`get_protocol\`。进入项目后带项目参数读取覆盖；代码硬关口不受约定文本覆盖。
4. 如工作目录有 \`COLLABORATION.md\`，将其视为项目补充约定。进入项目后按 \`dp project get <项目名> → dp project search <项目名> --query <关键词> --limit 20 → dp todo list --project <项目名> --status any --limit 20 --brief\` 建立有界上下文，需要更多时按回执继续读取。
5. **开工前先跑 \`dp work next\`**：它按你的身份把「等你验收 / 你进行中 / 指派给你 / 可领 / 等人拍板 / 挂起」排好，回执自带体量上界与下一步 —— 不要自己把三个项目全拉一遍再判。

## 场景路由：你在做什么 → 读哪一份

> **别从头读。** 这张表就是索引：按场景挑一份主题读，读完就够；
> 要找的东西不在表里，用 \`dp skill list\` 看有哪些主题。
>
> **为什么路由指向主题、不指向小节名**（卡 \`d3cc69a6\`，2026-10-22）：这张表原先
> 住在正文那一册里，而那一册**没有任何出口** —— 指向小节名的路由，agent 一行都读不到。
> 现在每一行的目标都是一条**能直接跑的命令**。

| 你此刻在做什么 | 读哪一份 |
| --- | --- |
| 不知道命令叫什么、参数是什么 | \`dp help\` → \`dp help <命令>\` → \`dp schema\`（**别每次拉全量**） |
| 想知道**哪些命令能随便调、哪些要授权** | \`dp skill access\`（四档权限）+ \`dp schema\` 的 \`risk\` 字段 |
| 第一次用，不知道怎么调起来 / 要**登记一件事** | \`dp skill core\`（怎么调用、登记纪律）+ \`dp skill writing\`（怎么写） |
| 登记前想**避免建重复卡** | \`dp skill writing\`（把已登记的同类事项勾掉） |
| 提议一件要**等人拍板**的事 | \`dp skill core\`（状态关口：候选池） |
| 要**判断能不能自己动**某张卡 | \`dp skill core\`（状态关口）—— **不确定就留在原地等，不要猜** |
| 要**验收**别人的卡 / 被要求验收 | \`dp skill core\`（验收与退回：**转 done 只能由验收方做**） |
| 自己的活做完了要**收口** | \`dp skill core\`（任务同步闭环 —— **三步缺一不可**，别漏第 3 步推「待验收」） |
| 要发版 / 标注"哪一版修了什么" | \`dp skill core\`（版本归属：\`--fixed-in\` 怎么用、什么时候能标） |
| 修好一张卡，准备收尾 | \`dp skill core\`（修一张卡，配一条以卡 id 命名的回归用例 —— **代码和用例一起交**） |
| 通过 MCP 接入（不是命令行） | \`dp skill access\`（MCP 接入） |
| 一次要登记多条 | \`dp skill writing\`（batch，含 \`--dry-run\` 与 notice 聚合） |
| 命令报错、想知道退出码什么意思 | \`dp skill troubleshooting\`（id 前缀与错误码） |
| 输出被截断 / 版本对不上 / 管道怪怪的 | \`dp skill troubleshooting\`（输出格式、注意） |
| 接手一个项目 | \`dp skill project\`（开头路径、版本边界） |

**两条最容易踩的**（顺序错了等于没做）：

1. **标了 \`--fixed-in\` 不等于交付。** 还要 \`--status awaiting_review\` 把卡推进「待验收」，
   否则人根本看不到你做完的事。**顺序：写结论评论 → 标版本 → 推待验收。**
2. **\`--fixed-in\` 是承诺不是事实**：标它之前必须已经**升过版本号、且产物已出**。
   指向一个不存在的版本，那张卡无法验收。

## 最小纪律

- 先用 \`dp help <命令>\` 查参数，需要全量枚举时才用 \`dp schema\`。**参数写错会得到明确的 \`usage_error\`**（未知 flag、多写位置参数都是），报错里列出它真正接受的参数 —— 照着改一次重试，不是静默降级。
- 事项必须带项目；不要把进度和结论追加到 description，往来写 comment。
- 完成一轮工作后：写结论评论 → 标记 fixed-in → 推进 awaiting_review；若项目方向、关键决定、工作入口或当前主线发生变更时才更新接手说明，再用 \`dp project handoff-propose <项目名> --body-file ...\` 提交接手说明更新提议（禁止手抄发版日志与实时计数 / 不要手抄发版日志或状态计数）。
- 修一张卡：**用例名里带上这张卡的 8 位 id**（如 \`...g5-closure-structure-eec2e1e7.test.ts\`）——
  没有它，"哪张卡当初坏在哪"只活在当时的对话里（2026-10-15 审计：全仓仅 12 条带卡 id，占 0.8%）。
  自检 \`find tests -name '*.test.ts' | grep -E '[0-9a-f]{8}'\`；改完反向验证一次（改回去该变红）。
- 不确定的提议留在 proposed，不代替主用户跨过确认关口。
- 写入失败时以结构化 code 为准，不按错误文案猜测。

## 按需阅读

本页只给最短路径；详细规则按主题读（\`dp skill list\` 列出全部主题）：

${topicLines}

## 调用入口

优先使用环境变量：\`node "$DESKPARTNER_CLI" <命令>\`；若当前终端环境变量未生效或指向旧路径，可直接运行本机实测路径（打包态与开发态均可用）：\`node "${cli}" <命令>\`。
运行 \`dp doctor\` 可确认当前 CLI、版本和 skill 是否匹配。

> 详细规则只在需要时按主题读取；不要把本页全文复制进自己的长期记忆。
`
}

/** 按主题读取 L1 文档，主题内容复用完整 Guide 的真实章节。 */
export function buildAgentGuideTopic(topic: string, launcherPath = resolveLauncherPath(), version = 'unknown'): string {
  const full = buildAgentGuide(launcherPath, version)
  const headings = GUIDE_TOPICS[topic]?.headings
  /**
   * 主题写错 = **用法错误**，不是"环境坏了"（1.0.110，收 `7a6ac97e`）。
   * 此前是裸 Error：就算经 `executeOne` 归类，也只能落到 `error` / exit 1 ——
   * 与"CLI 起不来"同一个形状，而一个该改命令、一个该看环境。
   */
  if (!headings)
    throw new UsageError(`未知 skill 主题：${topic}。可用主题：${guideTopicNames().join(', ')}`)
  const chunks: string[] = []
  for (const heading of headings) {
    const start = full.indexOf(heading)
    if (start < 0) continue
    const boundaries = ['\n## ', '\n### ']
      .map((marker) => full.indexOf(marker, start + heading.length))
      .filter((n) => n >= 0)
    const end = boundaries.length ? Math.min(...boundaries) : full.length
    chunks.push(full.slice(start, end).trim())
  }
  return `---
name: desk-partner-todos-${topic}
description: DeskPartner ${topic} 主题指南
version: "${version}"
---

${chunks.join('\n\n')}
`
}
