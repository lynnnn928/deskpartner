/**
 * CLI 命令表的**聚合处**与表级查询（1.0.112 域切，卡 d1b71d28）
 *
 * 命令本身按业务域拆进了 `./commands/<域>.ts`（每个文件自带参数声明与 `run`），
 * 本文件只做两件事：把各域的命令数组拼成一张表，以及表级查询。
 *
 * ⚠️ **顺序是外部契约**，所以这里是按原表次序一段一段展开、而不是按域分组：
 * `dp schema` 的命令清单、顶层 `dp help` 的排列、MCP `tools/list` 的工具顺序
 * 全都由这张表的顺序决定。原表里同一个域本来就不连续（todo 3 段，project /
 * protocol / notification 各 2 段，meta 3 段），所以那几个域在各自文件里也拆成
 * 多段导出。**动这张表的顺序之前，先跑契约快照**（`dp schema` / `dp help` /
 * MCP `tools/list` 三份逐字节对比，脚本与用法见卡 d1b71d28 的评论）。
 *
 * 依赖方向：`commands/*.ts` → 本文件的 `commands`；本文件的查询函数反过来被
 * `command-core` / `command-exec` / `command-schema` 引用。循环引用只在**函数体内**
 * 取值（谁都不在模块顶层读对方的 `const`），见 `commands.ts` 门面的说明。
 */

import { UsageError } from '../lib/domain-errors'
import { riskOf } from './command-core'
import type { CommandSpec } from './command-core'
import { schemaCommands, skillCommands, helpCommands } from './commands/meta'
import { notificationCommands, reminderCommands, memoCommands } from './commands/review'
import { todoInboxCommands, todoCommands, todoOwnerCommands } from './commands/todo'
import { doctorCommands, telemetryCommands } from './commands/ops'
import { protocolGetCommands, profileCommands, protocolProposalCommands, rulesCommands } from './commands/governance'
import { projectHandoffCommands, projectCommands } from './commands/project'
import { releaseCommands } from './commands/release'
import { categoryCommands } from './commands/category'
import { batchCommands } from './commands/batch'
import { uiCommands } from './commands/ui'
import { agentCommands } from './commands/agent'
import { docCommands } from './commands/doc'
import { workCommands } from './commands/work'

export const commands: CommandSpec[] = [
  ...schemaCommands, // 原表第 0 条 —— meta 域被别的域隔开，分成 3 段
  ...notificationCommands, // 原表第 1 条 —— review 域被别的域隔开，分成 3 段
  ...todoInboxCommands, // 原表第 2~6 条 —— todo 域被别的域隔开，分成 3 段
  ...reminderCommands, // 原表第 7 条 —— review 域被别的域隔开，分成 3 段
  ...doctorCommands, // 原表第 8 条 —— ops 域被别的域隔开，分成 2 段
  ...todoCommands, // 原表第 9~18 条 —— todo 域被别的域隔开，分成 3 段
  ...telemetryCommands, // 原表第 19~21 条 —— ops 域被别的域隔开，分成 2 段
  ...protocolGetCommands, // 原表第 22 条 —— governance 域被别的域隔开，分成 4 段
  ...profileCommands, // 原表第 23~25 条 —— governance 域被别的域隔开，分成 4 段
  ...protocolProposalCommands, // 原表第 26~27 条 —— governance 域被别的域隔开，分成 4 段
  ...rulesCommands, // 原表第 28~30 条 —— governance 域被别的域隔开，分成 4 段
  ...projectHandoffCommands, // 原表第 31~33 条 —— project 域被别的域隔开，分成 2 段
  ...skillCommands, // 原表第 34 条 —— meta 域被别的域隔开，分成 3 段
  ...todoOwnerCommands, // 原表第 35 条 —— todo 域被别的域隔开，分成 3 段
  ...projectCommands, // 原表第 36~45 条 —— project 域被别的域隔开，分成 2 段
  ...releaseCommands,
  ...memoCommands, // 原表第 51~54 条 —— review 域被别的域隔开，分成 3 段
  ...categoryCommands,
  ...batchCommands,
  ...uiCommands,
  ...helpCommands, // 原表第 60 条 —— meta 域被别的域隔开，分成 3 段
  ...agentCommands,
  ...docCommands, // 文档出口（卡 588d2d67）—— 追加在末尾，前面的次序一个字没动
  ...workCommands, // "我现在该动什么"（卡 ce43b4ba）—— 同样追加在末尾，不动既有次序
]

/**
 * 单条命令的用法说明 —— `help <命令>` 与 `<命令> --help` 共用同一份，
 * 免得两处各写一份、迟早长得不一样。
 */
export function commandUsage(cmd: CommandSpec) {
  return {
    name: cmd.name,
    desc: cmd.desc,
    /**
     * 只读标记（1.0.65 修 `1e525804`）—— **一律给 true/false，不留空**。
     *
     * 此前这里没有这个字段，而 MCP 侧那份只读清单是按"字段存在且为 true"
     * 挑工具的。于是写命令在 MCP 里显示为"非只读"（正确），
     * 而任何"按字段存在与否筛选"的调用方拿到的是**字段缺失** ——
     * 缺失和 false 不是一回事，前者只能被当成"不知道"。
     *
     * 判据取自 `riskOf(cmd) === 'read'` 而不是 `cmd.readOnly`：
     * `risk` 是门禁真正用的那一份（`riskOf` 会把"未标注"按 write 处理），
     * 从它派生才能保证"这里说只读"与"门禁放行只读"永远一致。
     * 直接读 `cmd.readOnly` 会出现第三种口径 —— 那正是本卡要消灭的东西。
     */
    readOnly: riskOf(cmd) === 'read',
    /** 风险档位一并给出，让调用方不用再猜 readOnly 是从哪推出来的 */
    risk: riskOf(cmd),
    /**
     * 回执 `data` 的形状（1.0.110，收 `07a244d9`）—— 与 `schema` 里那一份同源
     * （同一个字段直读，不另算一遍）。
     *
     * `help <命令>` 是"比 schema 轻得多"的那个出口，问的往往正是"这条命令怎么用、
     * 回什么"；只说参数不说形状，调用方还得再跑一次 schema —— 又一次转嫁成本。
     */
    ...(cmd.dataShape ? { dataShape: cmd.dataShape } : {}),
    positional: cmd.positional ?? null,
    args: cmd.args
  }
}

export function findCommand(args: string[]): { cmd: CommandSpec; rest: string[] } | null {
  // 优先匹配两词命令（如 'todo add'），再匹配单词
  if (args.length >= 2) {
    const two = commands.find((c) => c.name === `${args[0]} ${args[1]}`)
    if (two) return { cmd: two, rest: args.slice(2) }
  }
  const one = commands.find((c) => c.name === args[0])
  if (one) return { cmd: one, rest: args.slice(1) }
  return null
}

/**
 * 莱文斯坦距离（编辑距离）—— 纯函数，用于"猜错的命令名"找近似
 *
 * 自己实现而不是引依赖：这里只需要最朴素的一版（几十个短字符串两两比对），
 * 引一个包进来反而不划算。用滚动数组把空间压到 O(min(m,n))。
 */
function editDistance(a: string, b: string): number {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length
  // 让 b 是较短的那个，滚动数组只需它那么长
  if (a.length < b.length) [a, b] = [b, a]

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
    }
    prev = cur
  }
  return prev[b.length]
}

/**
 * 从"调用方敲错的命令名"里找近似命令（1.0.49，修 85740f50）
 *
 * 与同前缀兄弟提示互补：兄弟提示只在首词对得上时有用（`todo xxx`），
 * 而调用方也可能把形状搞错（`todos list`、`get todo`）。
 *
 * 阈值取"距离 ≤ 2 且 ≤ 命令名长度的 1/3"，两个条件都要满足：
 * - 只卡距离：短命令（如 `ui get`）会被长命令的微小差异命中，噪音大；
 * - 只卡比例：长命令（如 `telemetry export`）允许的绝对距离过大，
 *   会把毫不相干的命令也拉进来。
 *
 * 按距离升序返回，最多 3 个 —— 建议太多等于没建议。
 */
export function findNearCommands(typed: string, limit = 3): string[] {
  const q = typed.trim().toLowerCase()
  if (!q) return []
  return commands
    .map((c) => ({ name: c.name, d: editDistance(q, c.name.toLowerCase()) }))
    .filter(({ name, d }) => d <= 2 && d <= Math.floor(name.length / 3))
    .sort((a, b) => a.d - b.d)
    .slice(0, limit)
    .map((x) => x.name)
}

/**
 * 这条命令最多接受几个位置参数 —— **执行时的判据与结构闸门共用这一份**
 *
 * 规则只有三条，且都从 `CommandSpec.positional` 一处推出来：
 * 没声明 → 0 个；声明了没写 `arity` → 1 个；写了就按它（`category merge` / `help` 是 2）。
 *
 * 为什么要有这个函数而不是各处写 `cmd.positional ? 1 : 0`：
 * 那正是"执行怎么判"与"闸门怎么查"分叉的起点，而分叉只在
 * **某个命令的 arity 变了**的那天才发作 —— 平时两条判据都"看起来对"。
 * 1.0.107 修 `350f9631` 时立的规矩：一处判据，多个出口引用它。
 */
export function maxPositionalArgs(cmd: CommandSpec): number {
  return cmd.positional ? (cmd.positional.arity ?? 1) : 0
}


/**
 * 删除档命令的确认参数 —— 批准时由服务端补上，不要求调用方自带
 *
 * 🚨 **为什么必须补**（2026-09-23 修，主用户 814ad86d 实测）：
 *
 * 删除类命令的 `run()` 里都有一道 `if (!flags['--yes']) throw new UsageError(...)`。
 * 而门禁（`assertCallerAllowed`）跑在 `run()` **之前**，它落下的
 * `requestArgv` 是调用方原样敲的 argv —— agent 在"还没获批"的阶段**本来就不该**
 * 带 `--yes`（那是"我确认要删"的语义，属于批准方的话）。于是：
 *
 *   申请 → 人点「允许并执行」→ 重放 argv → 缺 `--yes` → 必然抛错。
 *
 * 实测佐证（真实库授权记录，规律干净）：
 *   argv 带 `--yes` 的 5 条 → 全部 consumed 成功；
 *   argv 不带 `--yes` 的 3 条（7a176dc1 / af321b15 / f711da47）→ 全部 exec_status=error。
 *
 * 修法是**在申请落库时就补**，而不是执行时临时注入 —— 理由：
 * 授权记录是审计凭据，它存的应该是**真正会被执行的东西**。
 * 若执行时才凭空多出一个参数，账面上的 argv 与执行的就对不上了。
 *
 * 语义自洽：用户在界面上点「允许并执行」，等价于在终端里敲下 `--yes`。
 */
export function canonicalGrantArgv(argv: string[]): string[] {
  const match = findCommand(argv)
  return normalizeGrantArgv(match ? [match.cmd.name, ...match.rest] : argv)
}

/**
 * 「批准即执行」要补 `--yes` 的命令 —— **从命令表推出来，不手写**（1.0.107，修 `b3fe692e`）
 *
 * ## 判据：静态删除档 + 声明了 `--yes`
 *
 * 补 `--yes` 这件事只在**静态删除档**上发生（调用链见 `normalizeGrantArgv`）：
 * 调用方在获批前不该带 `--yes`（那是"我确认要删"的语义，属于批准方的话），
 * 批准时由服务端补，账面上的 argv 才是真正会被执行的东西。
 *
 * 两个条件缺一不可，各有各的用处：
 * - `riskOf === 'destructive'`：动态档位（`category merge` / `todo delete-comment`）
 *   在这一跳**不该**被补 —— 它们走的是"已批准的执行放行 `--yes`"（`ctx.preApprovedGrantId`）。
 *   少了这个条件，名单里就会重新长出**走不到的登记**；
 * - `args 里有 --yes`：漏声明 `--yes` 的删除档命令会被推导漏掉（闸门盯住这一点）。
 *
 * ## 为什么以前那份是手写的，而这是个真缺陷
 *
 * 此前这里是一个手写的 8 条集合，套在一道 `riskOf !== 'destructive'` 的早返回后面，
 * 于是 `todo delete-comment` 与 `category merge` 两条**永远走不到** ——
 * 读代码的人会以为"这两条也会被补 `--yes`"，而它们其实靠另一条路（`preApprovedGrantId`）。
 * 实测 1.0.107：静态删除档恰好 6 条、且都声明了 `--yes`；声明了 `--yes` 的命令恰好 8 条
 * —— 与那份手写集合逐字相同。**手写的那份是在抄一个可以从命令表推出来的事实。**
 *
 * 判据落在推导上之后，"走不到的登记"这一类就不可能再出现：
 * 一个条目要么满足推导条件（于是有效），要么不满足（于是根本不在名单里）。
 * 闸门见 `tests/main/cli/grant-confirmation-list-b3fe692e.test.ts`。
 *
 * `list` 可注入：结构闸门要喂假数据做反向验证（证明它认得出"只看有没有 `--yes`"那种写法）。
 */
export function confirmationCommands(list: readonly CommandSpec[] = commands): string[] {
  return list
    .filter((c) => riskOf(c) === 'destructive' && c.args.some((a) => a.flag === '--yes'))
    .map((c) => c.name)
}

export function normalizeGrantArgv(argv: string[]): string[] {
  if (!argv.length) return argv
  const cmd = findCommand(argv)
  if (!cmd) return argv
  if (!confirmationCommands().includes(cmd.cmd.name)) return argv
  // 已有就不重复加（避免出现两个 --yes 让解析器犯迷糊）
  if (argv.includes('--yes')) return argv
  return [...argv, '--yes']
}

/**
 * 埋点的命令名：失败路径也要尽力归因。
 * 失败大多发生在参数校验阶段，此时命令名已经解析得出来；
 * 全记 "(unknown)" 的话，「agent 常在哪条命令上犯错」就看不到了。
 * 只有首词对不上任何已注册命令族时才真的无从归因。
 */
export function guessCmdName(argv: string[], ok: boolean): string {
  const first = argv[0] ?? ''
  const family = first.split(' ')[0]
  const known = commands.some((c) => c.name === first || c.name.split(' ')[0] === family)
  return known ? argv.slice(0, 2).join(' ') : '(unknown)'
}

