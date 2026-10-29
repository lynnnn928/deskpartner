/**
 * CLI 命令的口径常量与回执文案（拆分卡 bbeb1b51，纯搬移）
 *
 * 从前这些都长在 commands.ts 里。这里放的是**只由文字与数字构成**的部分：
 * 状态/类型/优先级枚举、条数上限、`--limit 0` 的说法、以及纯文本 helper
 * （描述摘要、执行者筛选）。判据没变过 —— 同一个数字、同一句承诺只许有一处出处。
 */

import { UsageError } from '../lib/domain-errors'

export const PRIORITIES = ['urgent', 'high', 'normal', 'low'] as const

/** 事项类型：bug（缺陷）/ feature（需求）/ task（普通任务，默认） */
export const TYPES = ['bug', 'feature', 'task'] as const
/**
 * 全部合法状态（含候选池两列）。
 *
 * CLI 的 G3（软约束）只针对父需求转 awaiting_review：
 * agent 自评通过不能代替人的验收确认，但硬拦会把"改个描述"这种
 * 正当修改也挡住，所以这里只警告不拒绝 —— 硬约束（G1/G2）在 repo 层。
 */
export const STATUSES = [
  'proposed',
  'todo',
  'in_progress',
  'suspended',
  'awaiting_review',
  'done',
  /**
   * 废弃（1.0.68，`a6032512` 的 e 项）
   *
   * 「不做 / 重复 / 被替代 / 无效」是**正式结论**，不是删除、也不是"待做"。
   * 参照 Linear：Rejected / Duplicate → Canceled 并写原因。
   */
  'discarded'
] as const

/**
 * 读命令的**筛选值** —— 比 STATUSES 多三个关键字（1.0.63；1.0.74 补 `open`）。
 *
 * 为什么读比写多：写只能落在某个具体状态上，而读经常要问两个
 * **不是具体状态、却是具体状态集合**的问题：
 * - `open`：**还在推进的有哪些** —— OPEN_STATUSES 四列的并集，也是**默认值**。
 *   实测（1.0.62，全库 400 条）：done 占 73%，`--limit 300` 里 69% 是 done，
 *   于是"只看还需要我做的"在 agent 侧**做不到**，只能把整库拉回来自己分组（S2 场景）。
 * - `unfinished`：`open` 的旧名（1.0.63 起就在），为兼容保留，**与 open 同一个集合** ——
 *   不另立口径，免得又多出一个"看起来一样、数出来不同"的词（2e8dfa6d）。
 * - `any`：**真全量** —— 七列全含（含 done/suspended/discarded）。没有它，
 *   "默认收窄"就成了"拿不回全量"，试一次拉不回全量就会以为数据没了。
 *
 * `--status` 还支持逗号多值（待办 + 进行中这类组合此前表达不了）。
 *
 * ⚠️ 这三个额外的值**只在读命令有效**：写命令（update/done/batch）仍只认
 * STATUSES —— 把一个不是状态的关键字传给写命令必须报错，绝不静默。
 */
export const FILTER_STATUSES = [...STATUSES, 'open', 'unfinished', 'any'] as const

/**
 * **默认列**（open，1.0.74 修 `2e8dfa6d`）：还在推进的四列。
 *
 * 排除的三列各有各的理由：done 是做完了；suspended 是"还会回来做、但不是现在"；
 * discarded 是"已决定不做"（`a6032512` 的 e 项）—— 后两者都**不该被算成"等你做"**。
 *
 * ⚠️ `todo list` 默认、`--status open`/`unfinished`、以及 G9 回执里
 * 「有 N 条待办指派给你」的计数**共用这一套列**。此前三处口径各写各的：
 * 提醒侧把已废弃的卡也算成"等你做"，数量放大约六倍，与 list 的条数对不上，
 * 而两个数字都进了 agent 的判断（2e8dfa6d）。判据：**默认列只能有一个出处**。
 */
export const OPEN_STATUSES = ['proposed', 'todo', 'in_progress', 'awaiting_review'] as const

/**
 * `todo list` 的默认条数上限（1.0.63；1.0.107 收成一份，修 `2e948042`）
 *
 * 这个数字**要说三处**：命令行为、`--limit` 的参数说明、回执里那句默认口径。
 * 以前它写死在两处字符串里 —— 于是回执那句话在 MCP 那条路上成了假话：
 * `list_todos` 会替调用方兜上通道侧的默认 50 条（`mcp-server.ts` 的 `DEFAULT_LIMIT`），
 * 同一条回执里 `returned` 是 50，那句话还说"最多 20"。
 *
 * 判据：**同一个数字只有一个定义处；说出口的上限，就是这一次生效的上限。**
 *
 * ⚠️ 这与 MCP 通道侧的默认（`mcp-tools-from-schema.ts` 的 `DEFAULT_ROW_LIMIT`，50）
 * **不是同一个决定**：那是通道政策（MCP 一次往返的成本），这是 CLI 直连的默认。
 * 所以这里**不**去统一数字，而是让那条回执的话按实际生效值生成 —— 两条路都不许撒谎。
 */
export const TODO_LIST_DEFAULT_LIMIT = 20

/**
 * `agent grants` 的默认条数上限（1.0.107，修 `99be5ae7`）
 *
 * 这条命令此前**没有 `--limit`、默认也不设边界**：实测默认回 81 条 / 66,409 字节，
 * 而其中 **0 条**是活着的授权 —— 同族里默认值最重的一个，正落在产品自己批评过的模式里。
 *
 * ⚠️ 它与 `TODO_LIST_DEFAULT_LIMIT` 是**两个命令的两个决定**，不是同一个数字抄两遍：
 * 这里说的是"授权记录一页看几条"。别因为数值一样就把它们并成一个常量 ——
 * 那是把相近当相同（参见 `7e321f6d` 那条"通道侧默认只该有一个答案"的教训：
 * 该合的合，不该合的别硬合）。
 */
export const AGENT_GRANTS_DEFAULT_LIMIT = 20

/**
 * `--limit 0` 的**唯一定义**（1.0.107，修 `8d78af0d`）：不做条数收窄。
 *
 * 这张卡报的是同一个值在同一族命令上各有各的含义：`todo list --limit 0` = 全量
 * 112 条、`project get --limit 0` = 全量 553 条、`project search --limit 0` = **1 条**
 * （被 `searchPage` 的 `Math.max(1, …)` 静默夹住）、`notification list --limit 0` = 报错。
 * 调用方按说明书学会"要全量传 --limit 0"，落到 `project search` 上会**少拿 194 条**
 * 且没有任何提示 —— 正是同族 `9bf9f667` 刚修过的那类"文档这么教、实现那么做"。
 *
 * 判据：**同一个参数值只许有一种含义。** 真做不到"不收窄"的命令（列表本身有硬上限，
 * 如 `notification list` 底层的 `LIMIT 200`）必须**明确报错**并在参数说明里写明 ——
 * 静默换一个含义才是这里要治的病。
 */
export const LIMIT_ZERO_DOC = '0 = 全量（不做条数收窄）'

/**
 * 做不到「0 = 全量」的命令，用这句话在参数说明里写明（见 `parseLimit` 的 `zero: 'reject'`）。
 *
 * ⚠️ 截至 1.0.107（`329c7bab`）**已经没有命令在用它了** —— 唯一的 `notification list`
 * 随着窗口下推一并归队（它的 200 条硬上限没了，"0 = 不收窄"现在真的做得到）。
 *
 * 留着它，是因为"真做不到就必须明说"这个落点本身有价值：
 * 将来哪条命令确实拿不全，就用这句话写在参数说明与报错里，
 * 而不是悄悄回一个看着像全量、实则被底层截过的结果。
 */
export const LIMIT_ZERO_REJECT_DOC = '不接受 0'

/**
 * 解析一个可缺省的 `--limit` —— **族内唯一一处**。
 *
 * - 不传 → `undefined`（默认口径由各命令自己定：20 / 全部 / 不限）
 * - `0` → `0`，全族只有一种含义：**不做条数收窄**
 * - 其它非负整数 → 该值
 * - 负数 / 小数 / 非数 → `usage_error`
 *
 * 最后一条是**顺带收掉的同族静默**：`memo list` / `todo inbox` / `telemetry export` 上，
 * `--limit abc` / `-1` / `1.5` 在装着的 1.0.107 上都被悄悄当成"全量"（`Number('abc')` 是
 * NaN，而 `NaN > 0`、`-1 > 0` 都为假），回执里一个字都不说 —— 三条都对着装着的版本实测过。
 * （同族的 `project get` 早有自己那份非负校验，`abc` / `-1` 一直报 `usage_error`；
 * 它只是被收进这同一个 helper，行为没变。）
 * 判据同 `todo list` 那条（`2e948042`）：**参数写错了就说，别猜。**
 *
 * `zero: 'reject'` 给确实做不到不收窄的命令：报用法错误，而不是回一个看着像全量、
 * 实则被底层硬上限截过的结果。
 */
export function parseLimit(
  raw: unknown,
  where: string,
  opts: { zero?: 'allow' | 'reject'; why?: string } = {}
): number | undefined {
  if (raw === undefined) return undefined
  /**
   * 命令表里的 flag 值类型是 `string | boolean | string[]`（布尔与多值共用同一个袋子）。
   * `--limit` 只该接到一个标量：数组/布尔一律按"值写错了"报出来，
   * 而不是让 `Number(['5'])` 这种隐式转换把它悄悄变成 5。
   */
  if (typeof raw !== 'string' && typeof raw !== 'number') {
    throw new UsageError(`${where} 的 --limit 需要非负整数（${LIMIT_ZERO_DOC}），收到「${String(raw)}」`)
  }
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0) {
    throw new UsageError(`${where} 的 --limit 需要非负整数（${LIMIT_ZERO_DOC}），收到「${raw}」`)
  }
  if (n === 0 && opts.zero === 'reject') {
    throw new UsageError(
      `${where} 的 --limit ${LIMIT_ZERO_REJECT_DOC}：${opts.why ?? '这个列表一次拿不全'}`
    )
  }
  return n
}

/**
/**
 * 解析一个可缺省的 `--offset` —— 注意它与 `--limit` 的 `0` **不是一回事**。
 *
 * - 不传 → `0`（从头开始）
 * - 非负整数 → 该值（跳过前面几条）
 * - 负数 / 小数 / 非数 → `usage_error`（同 `parseLimit`：参数写错了就说，别猜）
 *
 * **族内唯一一处**（1.0.109，修 `7f21841f`）：声明了 `--offset` 的六条命令
 * （`notification list` / `todo list` / `project search` / `memo list` /
 * `todo inbox` / `telemetry export`）全走这里。
 *
 * 此前 `todo list` / `project search` / `project get` 各写了一份自己的解析
 * （都是先 `Number()` 再判"整数且非负"），
 * 而 `--offset` **裸着传**（不带值）时 `parseFlags` 落的是布尔 `true`，
 * `Number(true) === 1` —— 于是静默从第 2 条开始给，一个字都不说；
 * `memo list` / `todo inbox` / `telemetry export` 则根本没有这个参数，
 * 三条都声明了 `--limit`，"继续读取"却做不到（同 `3675f993`）。
 *
 * 判据与 `parseLimit` 同一条：**参数写错了就说，别猜**；
 * 且"能算出来的不要手写第二份"。
 */
export function parseOffset(raw: unknown, where: string): number {
  if (raw === undefined) return 0
  if (typeof raw !== 'string' && typeof raw !== 'number') {
    throw new UsageError(`${where} 的 --offset 需要非负整数，收到「${String(raw)}」`)
  }
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0) {
    throw new UsageError(`${where} 的 --offset 需要非负整数，收到「${raw}」`)
  }
  return n
}

/**
 * 按 `--limit` 收窄 —— **族内唯一一处切片**：`undefined` 与 `0` 都表示"不收窄"。
 *
 * 各命令不再各写一遍 `if (limit > 0) rows.slice(0, limit)`：那正是"同一个 0
 * 在几条命令里含义不同"的来源（`notification list` 那句无条件的 `slice(0, limit)`
 * 若不改，将来允许 0 时会直接回空数组）。
 */
export function takeLimit<T>(rows: T[], limit: number | undefined): T[] {
  return limit === undefined || limit === 0 ? rows : rows.slice(0, limit)
}

/** open 口径判据（2e8dfa6d）：状态过滤与 G9 指派计数共用同一份 */
export function isOpenStatus(status: string): boolean {
  return (OPEN_STATUSES as readonly string[]).includes(status)
}

/**
 * 「指派给谁」的取数判据（1.0.74 修 `2e8dfa6d`）—— **唯一一份**。
 *
 * `todo list --executed-by` 的过滤与 G9 回执里「有 N 条待办指派给你」的计数
 * 必须走这同一个函数：此前提醒侧自己手写了一套 `executedBy === actor`，
 * 与 list 的口径分头演化，"提醒数"与"查询数"各说各话。
 *
 * want 的取值与 `--executed-by` 相同：human / agent / agent:<id> / unset
 * （unset = 没有显式指派；executedBy 为 null 表示"提出即执行"，不算指派）。
 */
/**
 * 列表里的描述摘要长度（字符数）。
 *
 * `todo list` 是 agent 每轮的第一件事，默认输出不能把整段描述全文带上
 * （20 条 × 几百字会撑爆工具输出）。全文用 `todo get <id>` 取。
 */
export const LIST_DESC_PREVIEW_CHARS = 80

/** 摘要：超过上限截断并加省略号；未超过原样返回；空描述返回 null。 */
export function summarizeDescription(desc: string | null | undefined): string | null {
  if (desc === null || desc === undefined || desc === '') return null
  const chars = Array.from(desc)
  if (chars.length <= LIST_DESC_PREVIEW_CHARS) return desc
  return chars.slice(0, LIST_DESC_PREVIEW_CHARS).join('') + '…'
}

/** 描述是否被摘要截断了（调用方据此决定要不要 `todo get` 看全文）。 */
export function isDescriptionTruncated(desc: string | null | undefined): boolean {
  if (!desc) return false
  return Array.from(desc).length > LIST_DESC_PREVIEW_CHARS
}

export function todosForExecutor<T extends { createdBy: string; executedBy: string | null }>(
  todos: T[],
  want: string
): T[] {
  return todos.filter((t) => {
    // `null` means “提出即执行”，所以按具体执行者查询时必须使用有效执行者；
    // `unset` 才专门表示没有显式指派，不能与“由提出者执行”混为一谈。
    if (want === 'unset') return t.executedBy === null
    const effective = t.executedBy ?? t.createdBy
    return want === 'agent' ? effective.startsWith('agent:') : effective === want
  })
}
