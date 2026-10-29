import { readFileSync } from 'node:fs'
import { UsageError } from '../main/lib/domain-errors'

/**
 * MCP 工具表从 `dp schema` 自动生成（1.0.68，修 `69b9b651`）
 *
 * ## 为什么要有这个文件
 *
 * MCP 一直是**手工挑出来的 8 个工具**（`TOOLS` 常量），
 * 而 CLI 有 44 条命令。加了新命令就"记得同步" ——
 * **这正是本产品自己定的规矩要治的病**（「不用靠自觉」）。
 *
 * 实测后果（10-07 核代码）：
 * - 1.0.67 的 `todo close`（四段收口）**MCP 侧没有**
 *   ⇒ **从 MCP 接入的 agent 做不出收口**，而"待验收要有收口结论"是主用户定的验收纪律
 * - 1.0.68 的 5 件（收口 / 通知判据 / 去重 / 对账 / 废弃列）**MCP 侧一件都没有**
 *
 * ## 为什么"自动生成"是对的而不是"记得补"
 *
 * 判据：**产品能算出来的，不该让每个 agent 手工算一遍**
 * （与 `84efa995` 去重那条同源）。
 *
 * 而这条路本来就在脚下 ——
 * MCP 已经是"spawn 一次 CLI 拼 argv"了，
 * **把工具表也变成 CLI 的派生物，两边就同源了。**
 *
 * ## 边界（刻意收窄，别全暴露）
 *
 * 不是 44 条全给：自检类与人类界面类对 agent 无意义。
 * ⚠️ **宁可多给** —— `readOnlyHint` 已让宿主知道要不要弹确认。
 * 宁多给 = 不会"因为没暴露而以为做不到"；少给 = 会误以为产品没这个能力。
 */
export interface SchemaCommand {
  name: string
  desc: string
  risk?: string
  readOnly?: boolean
  /**
   * 输出形态（1.0.107，修 `f99178d7`）：`json`（默认信封）/ `ndjson`（每行一条）/ `text`（正文）。
   *
   * ⚠️ 是**命令自己声明的**（`CommandSpec.output`），不是这里猜的。
   * 缺省按 `json` —— 那是最常见的形态，也是"没声明"时最该当成的东西：
   * 把解析失败当正文吞掉，比报错难查得多。
   */
  output?: 'json' | 'ndjson' | 'text'
  /**
   * 这个命令从 stdin 读记录（1.0.107，修 `0a9f42f8`）。
   *
   * `CommandSpec.stdin` 投影过来的同一个事实：**能力由命令声明，通道按声明派生**。
   * 生成工具表时按它补 `RECORDS_PARAM` 入参，handler 按它把记录写进子进程 stdin。
   */
  stdin?: 'ndjson'
  positional?: { name: string; required?: boolean; desc?: string } | null
  args: Array<{
    flag: string
    type: string
    desc?: string
    enum?: readonly string[]
    required?: boolean
  }>
}

/**
 * 不适合暴露给 MCP 的命令（按"agent 拿到它能干什么"筛，不是按"我怕它出事"）
 *
 * ⚠️ **破坏性的不排除** —— `todo rm` / `memo rm` / `project rm` 都该给。
 * 授权由 `destructiveHint` 交给宿主，**不该由工具表替宿主做决定**：
 * 藏起来的后果是 agent 认为"产品没有删除能力"，于是它去写库。
 */
const EXCLUDE: readonly string[] = [
  // 自检类：agent 不需要判断"环境对不对"，那是人排障用的
  'doctor',
  'schema',
  'help',
  // 人类界面类：改的是**这个人的窗口**，不是看板数据
  'ui get',
  'ui set',
  'ui reset',
  // 埋点清空：不可逆，且 agent 没有需要它清的理由
  'telemetry clear'
]

/** 状态型 flag 的取值要原样带过去（`--status done` 这种不能丢） */
function zodForArg(arg: SchemaCommand['args'][number], z: typeof import('zod').z): unknown {
  /**
   * ⚠️ **必须用方法链，不能用 `+` 拼字符串**（我第一版写成
   * `z.string().optional() + '.describe(...)'` —— 那是在拼字符串，
   * 产物是 `"[object Object].describe(...)"`，SDK 读 `.def` 时直接抛
   * `Cannot read properties of undefined (reading 'def')`）。
   *
   * 判据：**凡是"给 zod 对象加东西"，一律用 `.describe()` 方法**，
   * 因为返回值仍是 ZodType；用 `+` 会静默退化成普通字符串。
   */
  const withDesc = <T extends { describe: (d: string) => unknown }>(t: T): T =>
    arg.desc ? (t.describe(arg.desc) as T) : t

  // enum 优先 —— 宿主能直接给下拉，而字符串的话只能靠模型猜
  if (arg.enum?.length) {
    return withDesc(z.enum(arg.enum as [string, ...string[]]).optional())
  }
  switch (arg.type) {
    case 'boolean':
      return withDesc(z.boolean().optional())
    case 'number':
      return withDesc(z.number().optional())
    default:
      /**
       * ⚠️ **`coerce` 不是可有可无的**（1.0.107，修 `f99178d7` 的附带项）。
       *
       * 命令表里 `--limit` 这类"条数"参数声明成 `string`（CLI 侧本来就是字符串），
       * 于是 MCP 的 inputSchema 是 `type: string`。而模型的自然写法是
       * `{"limit": 3}` —— 严格 `z.string()` 会以 JSON-RPC -32602 拒掉它，
       * 报的是 `expected string, received number`：**参数语义与类型打架**。
       *
       * `coerce` 让数字按十进制收下，`toArgv` 照旧 `String(v)` 拼 —— 与 CLI 一致。
       * 反向不成立：字符串不会被当成数字接受（那是另一件事，不做）。
       */
      return withDesc(z.coerce.string().optional())
  }
}

/**
 * 命令名 → MCP 工具名
 *
 * `todo close` → `close_todo`（动词在前、对象在后）——
 * 保持既有 8 个工具的风格（`add_todo` / `get_todo` / `list_todos`），
 * **这样宿主与模型看到的排序习惯一致**。
 *
 * ⚠️ 既有工具名**一字不能改**（已有接入方在用），
 * 所以有一张"保持原名"的表 —— 见 `LEGACY_NAMES`。
 *
 * ── 三个必须处理的形状（都是实测踩到的）──
 *
 * ① **多词命令**：`todo set-owner` / `todo delete-comment`
 *    直接反转会得到 `delete-comment_todo`（**连字符与下划线混用**），
 *    而模型看到这种名字会猜错。统一转下划线。
 * ② **动词顺序**：`agent register` 的自然名是 `register_agent`，
 *    但按"取最后一段"会得到 `agent_register` —— 与既有 `list_agents` 风格相反。
 * ③ **复数**：既有约定是 `list_todos`（复数），
 *    而 `list_memo` / `list_notification` 生成了单数 —— 风格不一致。
 *
 * 判据：**工具名是给人与模型读的，命名不一致本身就是缺陷**，
 * 而"凑合能用"正是本产品反复在治的那类将就。
 */
const LEGACY_NAMES: Readonly<Record<string, string>> = {
  'todo add': 'add_todo',
  'todo get': 'get_todo',
  'todo list': 'list_todos',
  'todo update': 'update_todo',
  'todo comment': 'comment_todo',
  'project add': 'create_project',
  'project list': 'list_projects',
  'project get': 'get_project',
  'project search': 'search_project',
  'project handoff-history': 'list_handoff_revisions',
  'project handoff-revision': 'get_handoff_revision',
  'project handoff-rollback': 'rollback_handoff',
  'project handoff-propose': 'propose_handoff',
  'project handoff-proposals': 'list_handoff_proposals',
  'project handoff-update': 'update_handoff',
  skill: 'get_guide',
  'protocol get': 'get_protocol',
  'protocol propose': 'propose_protocol',
  'protocol proposals': 'list_protocol_proposals',
  'profile proposals': 'list_profile_proposals',
  'rules get': 'get_rules',
  'rules propose': 'propose_rules',
  'rules proposals': 'list_rule_proposals',
  'agent list': 'list_agents'
}

/** 复数映射：让生成名与既有 `list_todos` 风格一致 */
const PLURAL: Readonly<Record<string, string>> = {
  todo: 'todos',
  memo: 'memos',
  category: 'categories',
  notification: 'notifications',
  project: 'projects',
  agent: 'agents',
  telemetry: 'telemetry'
}

/** 动名词（已经是"动作"而非"对象"的部分），保持原样 */
const NO_PLURALIZE = new Set(['telemetry', 'settings', 'ui'])

export function mcpToolName(cmd: string): string {
  const legacy = LEGACY_NAMES[cmd]
  if (legacy) return legacy
  const parts = cmd.split(' ')
  if (parts.length === 1) return parts[0].replace(/-/g, '_')
  const obj = parts[0]
  const verb = parts[parts.length - 1]
  // 动词里的连字符也转（`delete-comment` → `delete_comment`）
  const v = verb.replace(/-/g, '_')
  // 对象复数化，但 telemetry 这类已经是"动作名"的例外
  const o = NO_PLURALIZE.has(obj) ? obj.replace(/-/g, '_') : (PLURAL[obj] ?? obj)
  return `${v}_${o}`
}

/** 该暴露吗 */
export function shouldExpose(cmd: string): boolean {
  return !EXCLUDE.includes(cmd)
}

/**
 * 一个工具名还原出的东西：命令名 + 它的位置参数名（1.0.107，修 `251eb399`）
 *
 * 位置参数名必须**由命令自己声明**带过来 —— 见 `toArgv` 里那段写死集合的教训。
 */
export interface ToolRoute {
  /** CLI 命令名，如 `release show` */
  cmd: string
  /** 位置参数名；命令声明了才有（`release show` 是 `version`） */
  positional?: string
}

/**
 * 工具名 → 命令的**反向表**，由 `mcpToolName()` 这一次前向生成**派生**出来。
 *
 * ## 为什么不能手写第二张表（`251eb399` 的全部理由）
 *
 * 反向前是**手写的 `reverse` 表 + 一条正则**，前向是 `LEGACY_NAMES` + 命名规则。
 * 两张表必然漂 —— 实测后果（1.0.97 报到 1.0.107 仍在）：
 * 60 个暴露工具里 **9 个还原不出命令**，而其中 `get_rules` / `propose_rules` /
 * `list_rule_proposals` 三个的前向名**就写在 `LEGACY_NAMES` 里**：
 * 前向表认得它们，反向表不认得 —— 同一个仓库里两套判据打架。
 *
 * 判据：**能算出来的，不要手写第二份。** 前向生成已经是唯一真相，
 * 反向就该是它的函数（遍历一遍命令表即可，没有额外运行时成本）。
 *
 * ⚠️ 遍历的是**全部命令**（含 `EXCLUDE` 里那些）：`shouldExpose` 是"要不要给 MCP"
 * 的决定，与"这个名字能不能还原"无关。少遍历会让被过滤的命令在过滤规则调整后
 * 突然还原不出，而那正是本文件反复写过的"规则一改就掐掉能力"。
 */
export interface RoutableCommand {
  name: string
  positional?: { name: string } | null
}

export function buildToolRoutes(cmds: readonly RoutableCommand[]): Map<string, ToolRoute> {
  const routes = new Map<string, ToolRoute>()
  for (const c of cmds) {
    const name = mcpToolName(c.name)
    /**
     * 重名以**首个**为准。重名意味着 `tools/list` 里会出现两条同名工具、
     * 而两者只能还原到其中一条命令 —— 那是契约缺陷，交给派发覆盖闸门去红，
     * 这里不静默挑一个。
     */
    if (!routes.has(name)) routes.set(name, { cmd: c.name, positional: c.positional?.name })
  }
  return routes
}

/**
 * 从 `dp schema` 的输出生成 MCP 工具表
 *
 * @param schemaCommands `dp schema` 的 `data.commands`
 * @param z zod（传入而不 import，是为了测试能不依赖运行时就构造）
 */
/**
 * 输出形态：**由命令自己声明**（`schema.commands[].output`），MCP 侧据此决定怎么读 stdout。
 *
 * - `json`：默认。按 JSON 信封解析；解析失败就是真错误（`bad_output`）。
 * - `ndjson`：每行一条 JSON。**不能当单份信封解析** —— `f99178d7`：
 *   `telemetry export` 出多行即 `bad_output`，只有恰好一行时才"成功"。
 * - `text`：正文（`skill` 的 YAML + Markdown）。套信封是错，把它塞进错误信息更错
 *   —— `a18681ae`：整段说明书被当成报错回执发给调用方。
 *
 * ⚠️ 这份判断**不再手写第二遍**：这里曾有一份 `NON_JSON_STDOUT` 名单，
 * 而 `output` 在命令表里早就声明过了（`CommandSpec.output`），只是没进 schema。
 * 两份名单迟早漂 —— 正是本文件反复在治的那个病。
 */
export type OutputKind = 'json' | 'ndjson' | 'text'

/**
 * 把「从 stdin 读记录」的命令暴露成工具时，用来送记录的那个入参名（1.0.107，修 `0a9f42f8`）。
 *
 * 为什么叫 `records`：`export_telemetry` 回执里把 NDJSON 聚成 `data.records`，
 * 进出两个方向用同一个词，模型不必记两套。
 *
 * ⚠️ 这个名字**只在这里定义一份**，因为三处必须一致：
 * ① 生成 inputSchema 时声明它；② `toArgv` 跳过它（它不是 CLI flag，
 * 拼成 `--records=[object Object]` 会让命令收到一个不认识的 flag）；
 * ③ handler 取它、拼成 NDJSON 写进子进程 stdin。
 */
export const RECORDS_PARAM = 'records'

/**
 * 逐行输出（`ndjson`）的命令在 MCP 侧**默认回多少行**（1.0.107，修 `7e321f6d`）。
 *
 * ## 为什么通道侧必须有一个上界
 *
 * `telemetry export` 声明 `output: 'ndjson'`，MCP 侧会把 stdout 聚成 `records`
 * 数组、再套信封返回 —— 不带 limit 时实测 **459,331 字节 / 1110 条**（本机埋点全量）。
 * 一次工具调用的结果直接进宿主上下文，等于把宿主撑满；而它**不报错**：
 * 回执是 `ok`，调用方只看到"成功"。
 *
 * 这与 `9fde5666` 治过的是同一个病：当年一次无参 `list_todos` 回 **456,206 字符**，
 * 处置是**默认有界**（`mcp-server.ts` 的 `DEFAULT_LIMIT`）。两个数字几乎一样大 ——
 * 同一个失效模式在另一个工具上复现，所以这里用同一手法、同一个数值。
 *
 * ## 默认有界 ≠ 硬上限
 *
 * 调用方要全量，显式传一个更大的 limit 就是（这条命令的 `--limit` 本来就是可选参数）。
 * 判据：**没有一句能被读到的默认值，"回执多大"就由数据量决定**，
 * 而数据量恰恰是调用方看不见的东西。
 *
 * ## 为什么只挂 `ndjson`
 *
 * `json` 信封类命令的体量另有约束（分页、字段裁剪）；`text`（`get_guide` 的说明书）
 * 是**要整段读**的东西，替它截断才是缺陷。逐行输出是唯一"不给上界就什么都没有"的一类。
 */
export const DEFAULT_ROW_LIMIT = 50

/**
 * 「这条命令的默认条数上界怎么补」的**唯一定义**（1.0.108，修 `a7f94301`）。
 *
 * ## 为什么要有这个函数
 *
 * 上面那个默认值原先只挂在**一处**：MCP handler 在调用方没给条数时替它补 `--limit`。
 * 而 `7e321f6d` 要的性质是"逐行输出类命令**默认有界**" —— 那只在 MCP 直连这条路上成立：
 * 同一条 `telemetry export` 写成 `batch` 的一条记录，跑的是**命令本身**，
 * 而命令自己并不知道有这么一个默认（`--limit` 不传就是全量）。
 * 实测（1.0.108，bob）：MCP 直连 21,355 字节，同一条命令塞进 batch 的记录里 66,113 字节
 * —— 宿主只要把命令装进 batch，就推翻了整条"默认有界"。
 *
 * 判据：**一个默认口径，两处生效点，必须出自同一份推导。**
 * 于是把"哪条命令、补哪个参数、补多少"抽在这里：
 * `generateMcpTools` 用它写参数说明与 handler 的兜底，`batch` 用它给每条记录补齐
 * —— 两条路读的是同一行代码，不可能是两个数。
 *
 * ## 判据本身（与 1.0.107 相同）
 *
 * `output === 'ndjson'`（逐行吐、可能很长）**且**声明了 `--limit`（它自己能收窄）。
 * 少任何一处都不补：前者说明"不给上界就什么都没有"，后者说明"给了上界也收不窄"。
 * 逐行输出的命令都必须有 `--limit`，由 `mcp-dispatch-coverage.test.ts` 的闸门盯着。
 *
 * ⚠️ 调用方**显式**给的条数一律不动（含 `--limit=0` = 全量）：默认有界 ≠ 硬上限。
 * ⚠️ 这里的默认是**通道侧**的口径（MCP 直连 / batch），CLI 直连不传 `--limit` 仍是全量
 * —— 那是说明书里写明的用法（`dp telemetry export > 文件`）。
 */
export function rowLimitDefault(cmd: {
  output?: string
  args?: ReadonlyArray<{ flag: string }>
}): { flag: string; value: number } | null {
  if (cmd.output !== 'ndjson') return null
  const hasLimit = (cmd.args ?? []).some((a) => a.flag === '--limit')
  return hasLimit ? { flag: '--limit', value: DEFAULT_ROW_LIMIT } : null
}

export function generateMcpTools(
  schemaCommands: SchemaCommand[],
  z: typeof import('zod').z
): Array<{
  name: string
  description: string
  input: Record<string, unknown>
  annotations: Record<string, boolean>
  actor?: boolean
  outputKind?: OutputKind
  /** 记录要写进命令的 stdin（`0a9f42f8`）；`batch` 是唯一一个 */
  stdinKind?: 'ndjson'
  /** 逐行输出的命令要兜条数默认值的那个入参名（1.0.107，修 `7e321f6d`） */
  defaultLimitKey?: string
}> {
  const out: Array<{
    name: string
    description: string
    input: Record<string, unknown>
    annotations: Record<string, boolean>
    actor?: boolean
    outputKind?: OutputKind
    /** 记录要写进命令的 stdin（`0a9f42f8`）；`batch` 是唯一一个 */
    stdinKind?: 'ndjson'
    /** 逐行输出的命令要兜条数默认值的那个入参名（1.0.107，修 `7e321f6d`） */
    defaultLimitKey?: string
  }> = []

  for (const cmd of schemaCommands) {
    if (!shouldExpose(cmd.name)) continue

    /**
     * 逐行输出（`ndjson`）的命令在通道侧**默认兜一个条数上界**（1.0.107，修 `7e321f6d`）。
     *
     * 判据取自命令自己的两处声明（`output: 'ndjson'` 与 `--limit`），
     * 但推导只写一份 —— 在 `rowLimitDefault` 里：**batch 那条路读的是同一个函数**
     * （1.0.108，修 `a7f94301`），否则同一条命令 MCP 直连有界、塞进 batch 就全量。
     *
     * ⚠️ 这里只**记下**要用哪个入参，不在这里填值：`toArgv` 是"参数 → argv"的机械映射，
     * 而"这一次回执最多多大"是**接入层的政策**（与 actor 走环境变量、records 走 stdin 同理）。
     */
    const limitDefault = rowLimitDefault(cmd)
    const defaultLimitKey = limitDefault?.flag.replace(/^--/, '').replace(/-/g, '_')

    const input: Record<string, unknown> = {}
    for (const arg of cmd.args ?? []) {
      const key = arg.flag.replace(/^--/, '').replace(/-/g, '_')
      /**
       * 兜底的那个参数，默认值要**写进它自己的说明**：调用方得在调用之前就知道
       * "不传会拿到多少"。默认值没法从别处看到 —— 它不在 argv 里，也不在命令的
       * `--limit` 说明里（CLI 直连确实是全量），只有这里能说。
       *
       * ⚠️ 写的数字取自 `limitDefault.value`，也就是 batch 会给记录补上的那个值
       * （1.0.108，修 `a7f94301`）—— **说出口的上限，必须就是真正生效的上限**。
       */
      input[key] =
        limitDefault && key === defaultLimitKey
          ? zodForArg(
              {
                ...arg,
                desc: `${arg.desc ? `${arg.desc}；` : ''}不传时默认 ${limitDefault.value} 条（MCP 直连与 batch 都按这条；要全量就显式传更大或 0）`
              },
              z
            )
          : zodForArg(arg, z)
    }
    // 所有非只读命令都必须显式声明 actor；它不是 CLI flag，handler 会转成环境变量。
    const risk = cmd.risk ?? (cmd.readOnly ? 'read' : 'write')
    const isRead = risk === 'read'
    if (!isRead) {
      input.actor = z.string().optional().describe('这次调用以谁的身份（如 agent:alice）')
    }
    /**
     * 批量容器：给它一个"把记录送进去"的入口（1.0.107，修 `0a9f42f8`）。
     *
     * 命令声明了 `stdin`，但 MCP 侧没有管道给子进程 —— 不补这个入参的话，
     * 工具表里会挂着一个"批量工具"，而它一次都送不进内容（实测只能回「stdin 为空」
     * 或 `--doc` 的格式说明）。判据与 `output` 同源：**能力由命令声明，通道按声明派生**。
     *
     * 数组元素收两种形态：对象（按 batch 的记录结构写）或已经是 JSON 的字符串
     * （调用方自己拼好了）。**两者都原样交给命令去校验** —— 行的结构对不对，
     * 判据在命令层，这里再写一份就是第二套（本文件反复在治的那个病）。
     */
    if (cmd.stdin === 'ndjson') {
      input[RECORDS_PARAM] = z
        .array(z.union([z.string(), z.record(z.string(), z.unknown())]))
        .optional()
        .describe(
          '要执行的记录数组，每项一条 batch 记录：对象（如 {"cmd":"todo add","args":{"--title":"x"}}）' +
            '或已经是 JSON 的字符串。MCP 没有管道，这里替你拼成 NDJSON 写进命令的 stdin；' +
            '完整结构与例子见 `batch --doc`（dry_run 可先只校验不执行）。'
        )
    }
    // 位置参数单独给（MCP 侧把它变成一个必填字段）
    // 注意：risk/isRead 在下方注解派生处复用，避免出现第二套读写判据。
    if (cmd.positional?.name) {
      const positional = z.string().describe(cmd.positional.desc ?? cmd.positional.name)
      input[cmd.positional.name] = cmd.positional.required ? positional : positional.optional()
    }

    /**
     * 注解**从 risk 派生，不手写** ——
     * 手写就是第二套判据，迟早漂（同 `3c522bdb` 说的文档漂移）。
     *
     * - `read`：读，免确认、可安全重试
     * - `write`：改数据，重复调用不保证等价
     * - `config`：改用户界面配置 —— 对宿主是"改数据"（要确认）
     * - `destructive`：销毁或不可逆 —— **必须告诉宿主弹确认**
     */
    const isDestructive = risk === 'destructive'

    out.push({
      name: mcpToolName(cmd.name),
      description:
        cmd.desc +
        (cmd.stdin === 'ndjson'
          ? '（要执行的记录用 records 数组传入：MCP 没有管道，handler 会替你拼成 NDJSON 写进 stdin）'
          : '') +
        (cmd.positional?.name
          ? `（位置参数：${cmd.positional.name}${cmd.positional.required ? '，必填' : ''}）`
          : ''),
      input,
      annotations: {
        readOnlyHint: isRead,
        destructiveHint: isDestructive,
        idempotentHint: isRead
      },
      actor: !isRead,
      // 输出形态由命令自己声明，MCP 侧据此选解析方式；缺省按 json
      outputKind: cmd.output ?? 'json',
      // 逐行输出的命令：handler 在调用方没给条数时兜上 DEFAULT_ROW_LIMIT（修 7e321f6d）
      defaultLimitKey,
      // 有 stdin 的命令（batch）：handler 把 RECORDS_PARAM 拼成 NDJSON 喂给子进程
      stdinKind: cmd.stdin
    })
  }
  return out
}

/**
 * 生成 argv：与 CLI 的 flag 约定一致
 *
 * ⚠️ 沿用 `todo update` 那条的写法 —— **值用 `=` 拼**
 * （`--title=xxx` 而非 `--title xxx`）：
 * 值本身以 `-` 开头时（`--title="--help 未注册"`），
 * 分成两个 token 会被当成另一个 flag，而**它自己正是这么修的**。
 *
 * ## 命令名从哪来（1.0.107，修 `251eb399`）
 *
 * 优先用 `routes`（`buildToolRoutes` 从 schema 派生的反向表）。
 * 传了 `routes` 就**不再看**下面那张手写 `reverse` 表与正则 ——
 * 它们只服务"没拿到 schema 的旧调用方"，是兼容路径，不是并列的第二个真相。
 * 理由：两张手写表必然漂，实测 9 个工具还原不出命令（见 `buildToolRoutes` 注释）。
 */
export function toArgv(
  toolName: string,
  p: Record<string, unknown>,
  routes?: ReadonlyMap<string, ToolRoute>
): string[] {
  /**
   * 位置参数**只认命令自己声明的那个**（`route.positional`），
   * 不叠加下面那组写死的键名。写死集合的反例（1.0.107 实测）：
   *
   * - `agent grants` 没有位置参数、筛选靠 `--id`，而 `id` 在写死集合里
   *   ⇒ `grants_agents { id: "xxx" }` 把筛选**丢掉**、静默返回全部 81 条；
   * - `release show` 的位置参数叫 `version`，不在集合里 ⇒ 被拼成 `--version=`。
   *
   * 两处都不报错，而是**静默给错答案** —— 比报错难查得多。
   */
  const route = routes?.get(toolName)
  let cmd: string
  let positionalName: string | undefined
  if (route) {
    cmd = route.cmd
    positionalName = route.positional
  } else {
    // 工具名 → 命令名（旧路径：没有 schema 可用时的兜底表）
    const reverse: Record<string, string> = {
      add_todo: 'todo add',
      get_todo: 'todo get',
      list_todos: 'todo list',
      update_todo: 'todo update',
      comment_todo: 'todo comment',
      create_project: 'project add',
      list_projects: 'project list',
      list_handoff_revisions: 'project handoff-history',
      get_handoff_revision: 'project handoff-revision',
      rollback_handoff: 'project handoff-rollback',
      propose_handoff: 'project handoff-propose',
      list_handoff_proposals: 'project handoff-proposals',
      update_handoff: 'project handoff-update',
      list_agents: 'agent list',
      get_protocol: 'protocol get',
      propose_protocol: 'protocol propose',
      list_protocol_proposals: 'protocol proposals',
      get_profile: 'profile get',
      propose_profile: 'profile propose',
      list_profile_proposals: 'profile proposals',
      get_guide: 'skill'
    }
    cmd = reverse[toolName]
    if (!cmd) {
      /**
       * 还原生成的名字：`close_todo` → `todo close`、`list_memos` → `memo list`。
       *
       * ⚠️ 这里必须**同时认单数与复数**（`todo`/`todos`）——
       * 我第一版只认单数，于是 `list_todos` 这类**生成出来的工具调用时会抛
       * "无法把工具名还原成命令"**。而那条恰好是既有约定里的名字，
       * 一旦有人从 schema 生成版调它就炸。
       */
      const m = /^([a-z_]+)_(todos|todos?|memos|memo|projects|project|categories|category|agents|agent|notifications|notification|telemetry)$/.exec(
        toolName
      )
      /**
       * 还原不出来 = 调用方给了一个不存在的工具名 —— **用法错误**
       * （1.0.110，收 `7a6ac97e`）。MCP 侧接住它并归成 `usage_error`
       * （`mcp-server.ts` 里包 `toArgv` 的那个 try/catch），改成 UsageError
       * 是让"接住了"这件事**不依赖那个 catch 还在**：真漏出去时也带得上正确分类。
       */
      if (!m) throw new UsageError(`无法把工具名还原成命令：${toolName}`)
      /** 复数 → 单数（`categories` → `category`） */
      const obj = m[2].replace(/s$/, '').replace(/ie$/, 'y')
      cmd = `${obj === 'category' ? 'category' : obj} ${m[1].replace(/_/g, '-')}`
    }
  }

  const argv = cmd.split(' ')
  const positionalKeys =
    route !== undefined
      ? new Set(positionalName ? [positionalName] : [])
      : // 旧路径没有声明可用，只能沿用这份写死的键名集合
        new Set(['id', 'todoId', 'refId', 'topic'])
  for (const [k, v] of Object.entries(p)) {
    // actor 是调用上下文，由 MCP handler 转成 DESKPARTNER_AGENT；绝不能伪装成 CLI flag。
    if (k === 'actor') continue
    /**
     * `records` 也不是 CLI flag（1.0.107，修 `0a9f42f8`）：它是"要喂进 stdin 的记录"，
     * 由 handler 拼成 NDJSON 写进子进程。拼成 `--records=[object Object]` 会让命令
     * 收到一个不认识的 flag（而调用方以为自己传对了）。
     */
    if (k === RECORDS_PARAM) continue
    if (v === undefined || v === null) continue
    if (positionalKeys.has(k)) {
      argv.push(String(v))
      continue
    }
    const flag = `--${k.replace(/_/g, '-')}`
    // 布尔：true 才带 flag，false 不带（`--yes false` 会把 "false" 掉进位置参数）
    if (v === true) argv.push(flag)
    else argv.push(`${flag}=${String(v)}`)
  }
  return argv
}
