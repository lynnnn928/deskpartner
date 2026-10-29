/**
 * 一次更新里「哪些字段真的变了」（1.0.73，`482e4b03`）
 *
 * ── 为什么需要它 ──
 *
 * 主用户的提单：「验收阶段渲染本次变更 diff，替代纯文字结论」，明说三类：
 * **描述追加 / 状态 / 字段**。
 *
 * 摸底结果是三类各有各的待遇：
 * - **状态**：`todo_transitions` 一直在记（v14 起），动态/变更记录都读得到；
 * - **描述**：1.0.49 起因事故补了 events 留痕（before/after）；
 * - **其余字段**：**全仓零留痕**。`todo update <id> --priority high` 改完，
 *   库里只留下一个 `updated_at` 变了，没有第二个地方能回答"它把优先级从
 *   normal 改成了 high"。
 *
 * 于是"验收时看到本次改了什么"这件事，在字段这一路上**根本没有数据源** ——
 * 再怎么渲染也就渲染不出来。这正是本项目反复在治的那类缺陷：
 * **不是渲染没做，是压根没记。**
 *
 * ── 为什么在 repo 里算，而不是在 CLI/IPC 各算一次 ──
 *
 * `existing`（改之前）与 `updated`（改之后）两个对象**只在 repo 的 update
 * 里同时存在**。CLI 与 IPC 各拿不到完整的一对：CLI 手里有 patch，
 * 但 patch 是"要传什么"（含 `undefined = 未提及`），不是"最终变成了什么"；
 * 而且 patch 里没有 existing。放 repo 是**唯一一处两边都能覆盖到**的位置。
 *
 * ── 为什么不记进 `todo_transitions` ──
 *
 * 那张表的语义是「状态迁移」，`from_status` / `to_status` 是它的列。
 * 把字段变更塞进去要么加一堆恒为 null 的列，要么复用 `to_status` 装
 * "priority" 这种根本不是状态的值 —— 表会失去它自己那唯一的判据。
 * 字段变更是**审计**（会丢东西、需要对证），走 events 与描述变更同一路。
 */

/** 一个字段的一次变化 */
export interface FieldChange {
  /** 字段名（仓库里的 camelCase，与 Todo 结构一致） */
  field: string
  /** 改之前的值；null = 原先没有 */
  before: string | null
  /** 改之后的值；null = 清空 */
  after: string | null
}

/**
 * 哪些字段的变化值得记
 *
 * 不是"所有能改的字段"。取舍判据是**改动之后对人有没有信息量**：
 *
 * - 记：标题、优先级、截止、提醒、类型、项目、父需求、提出者/执行者/验收者、
 *   解决版本 —— 每一个都是"这条事项现在的样子"的组成部分，
 *   也是验收时真正会争议的东西（"我没让你改截止时间"）。
 * - **不记 `updatedAt`**：它是每次写入的副产物，记了等于每次都说
 *   "时间变了"，把真变化淹没掉。
 * - **不记 `status`**：它有专门的一张表（`todo_transitions`），
 *   记两遍就是两份真相。而且流转表还带 actor 与 isRejection 这些它独有的信息，
 *   events 里这份必然是残缺的 —— 残缺的第二份比没有更糟。
 * - **不记 `description`**：同理，1.0.49 起它有自己的 `description_changed`
 *   事件（带 append/replace 语义与完整正文）。这里再记一条，
 *   会让"改描述"在时间线上出现两次。
 * - **不记 `categoryIds`**：它是数组、且改标签本身有 category 相关的记录路径。
 *   本期不动它，宁缺勿滥 —— 先把"验收时看不到字段变化"这个真缺口堵上。
 */
const TRACKED_FIELDS: readonly string[] = [
  'title',
  'priority',
  'type',
  'projectId',
  'parentId',
  'createdBy',
  'executedBy',
  'verifier',
  'dueAt',
  'remindAt',
  'fixedInVersion',
  'isPinned'
]

/**
 * 追踪清单的对外别名（1.0.73）
 *
 * 导出**只为一件事**：让闸门能断言"清单里每个字段都有中文标签、
 * 且清单里不含 status/description" —— 那两条都是"错了不会报错、
 * 只会安静地说错话"的判据，必须能被测试读到。
 */
export const TRACKED_FIELDS_EXPORT = TRACKED_FIELDS

/**
 * 算出这次更新**真正**动了哪些字段
 *
 * @param before 改动前的完整事项
 * @param after  改动后的完整事项（repo 里那个 `{ ...existing, ...覆盖 }`）
 * @returns 只含真变化的条目；没变就是空数组
 *
 * ⚠️ 判据是**比较前后两个对象**，不是"input 里带了哪些键"：
 * `input` 里带 `priority: 'normal'` 而它本来就是 normal，那是**一次没有变化的写入**。
 * 按 input 的键算会把它记成"改了优先级：normal → normal" ——
 * 时间线上多一条什么都没发生的记录，比没有记录更误导。
 * （本文件顶部的注释说过同一件事：patch 是"要传什么"，不是"变成了什么"。）
 *
 * ⚠️ 比较用**归一化后的值**：`null` / `undefined` / `''` 在"字段有没有值"
 * 这件事上是同一态。不归一化的话，`executedBy: null`（回到提出者执行）
 * 会与 `undefined`（未提及）判成"变了"，而它们最终落库的结果是一样的。
 */
export function diffFields(
  before: Record<string, unknown> | object,
  after: Record<string, unknown> | object
): FieldChange[] {
  const b0 = before as Record<string, unknown>
  const a0 = after as Record<string, unknown>
  const out: FieldChange[] = []
  for (const field of TRACKED_FIELDS) {
    const b = normalize(b0[field])
    const a = normalize(a0[field])
    if (b === a) continue
    out.push({ field, before: b, after: a })
  }
  return out
}

/**
 * 把字段值归一成"有值就是字符串，没值就是 null"
 *
 * 布尔要显式转成 `'true'` / `'false'` 而不是 `String(v)` 后再比较 ——
 * `String(false)` 是 `'false'`（有值），但 `false` 在"有没有值"上是有意义的
 * （`isPinned` 从 false 变 true 是真变化，不能因为 falsy 就当没事发生）。
 * 所以这里只把 `null` / `undefined` / 空串归成 null，其余按原值转字符串。
 */
function normalize(v: unknown): string | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'string') return v.trim() === '' ? null : v
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'number') return String(v)
  // 数组 / 对象：本期不在 TRACKED_FIELDS 里，走到这里说明清单被扩过，
  // 用 JSON 稳定序列化兜底（不静默丢信息）
  return JSON.stringify(v)
}

/**
 * 字段名 / 枚举值的展示映射 —— **单源在 `@shared/field-meta`**
 *
 * ⚠️ 这里刻意**不再定义一遍**。理由：渲染层 import 不到 `src/main/**`
 * （`tsconfig.web.json` 只 include `src/renderer/**`），所以"两端各写一份
 * 字段标签"是最容易发生的写法 —— 而那正是本项目反复在治的病：
 * 一处改了另一处没改，同一个字段两个叫法，**不报错、只是说错话**。
 * 放在 `src/renderer/types/`（既有的共享区，两端都 include）只有一份。
 *
 * 这里 re-export 是为了让主进程内部的 import 路径保持稳定
 * （审计翻译层、聚合层都用 `./field-changes` 取，不必各自去记共享区的位置）。
 */
export { FIELD_LABELS, ENUM_LABELS, describeFieldChange, describeFieldChanges } from '../../renderer/types/field-meta'

/** 一组字段变化 → 一列人话（主进程侧入口，等价于 describeFieldChanges） */
export { describeFieldChanges as describeFields } from '../../renderer/types/field-meta'

