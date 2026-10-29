/**
 * 字段的展示元数据（1.0.73，主用户提单 `482e4b03`）
 *
 * ── 为什么放在 @shared 而不是 main 或 renderer 一侧 ──
 *
 * 「字段变更怎么翻译成人话」这件事**两端都要做**：
 * - 主进程：审计翻译层（`lib/audit-text.ts`）、「本次变更」聚合（`lib/review-diff.ts`）
 *   都要在人话里写出字段名；
 * - 渲染层：详情抽屉的「本次变更」块要直接渲染。
 *
 * 而两侧的模块边界是硬的 —— 渲染层 import 不到 `src/main/**`
 * （`tsconfig.web.json` 只 include `src/renderer/**`）。
 * 于是最省事的写法就是**各写一份映射**，而那正是本项目反复在治的病：
 * 一处改了另一处没改，界面上同一个字段两种叫法，**不报错、只是说错话**。
 *
 * `src/renderer/types/` 是既有的共享区（`@shared` 别名指向它，
 * 两端 tsconfig 都 include），`enums.ts` 已经在那里放了运行时常量。
 * 所以把这份映射放这里 —— **单源，而不是两份对齐**。
 *
 * ⚠️ 别把 `FieldChange` 的接口声明也搬过来：那个由 `types/todo.ts`（渲染层契约）
 * 与 `main/lib/field-changes.ts`（主进程）各声明各的，用测试锁不漂移 ——
 * 这是本项目 IPC 契约的既有做法（IPC 传的是 JSON，不是共享类型）。
 */

/** 字段名 → 中文标签 */
export const FIELD_LABELS: Record<string, string> = {
  title: '标题',
  priority: '优先级',
  type: '类型',
  projectId: '项目',
  parentId: '父需求',
  createdBy: '提出者',
  executedBy: '执行者',
  verifier: '验收者',
  dueAt: '截止时间',
  remindAt: '提醒时间',
  fixedInVersion: '解决于版本',
  isPinned: '置顶'
}

/**
 * 枚举字段的取值 → 中文
 *
 * ⚠️ 只覆盖**纯枚举**字段。`projectId` / `parentId` 这些是 id，
 * 要换成名字得查库 —— 那是调用方的事（它在 repo 里，手边有数据），
 * 翻译层不该在自己内部再开一次查询（同 `audit-text.ts` 顶部的判据）。
 */
export const ENUM_LABELS: Record<string, Record<string, string>> = {
  priority: { urgent: '紧急', high: '高', normal: '普通', low: '低' },
  type: { bug: 'Bug', feature: '需求', task: '普通事项' }
}

/** 一个字段的两端取值（结构由调用方各自声明，这里只吃最小形状） */
export interface FieldChangeLike {
  field: string
  before: string | null
  after: string | null
}

/**
 * 把一条字段变化翻成人话：`优先级：普通 → 高`
 *
 * @param change   一条字段变化
 * @param resolveRef 把 id 换成可读名（项目名 / 标题）的注入点。
 *   它是入参而不是内部查询 —— 调用方手边就有库，这样本函数保持纯函数、测得到。
 */
export function describeFieldChange(
  change: FieldChangeLike,
  resolveRef?: (field: string, id: string) => string | null
): string {
  const label = FIELD_LABELS[change.field] ?? change.field
  const enumMap = ENUM_LABELS[change.field]
  const show = (v: string | null): string => {
    if (v === null) return '（空）'
    if (change.field === 'isPinned') return v === 'true' ? '置顶' : '取消置顶'
    if (enumMap) return enumMap[v] ?? v
    if (resolveRef) {
      const named = resolveRef(change.field, v)
      if (named) return named
    }
    return v
  }
  return `${label}：${show(change.before)} → ${show(change.after)}`
}

/** 一组字段变化 → 一列人话（详情页「本次变更」用） */
export function describeFieldChanges(
  changes: readonly FieldChangeLike[],
  resolveRef?: (field: string, id: string) => string | null
): string[] {
  return changes.map((c) => describeFieldChange(c, resolveRef))
}
