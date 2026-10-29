import { v4 as uuidv4 } from 'uuid'
import { randomUUID } from 'node:crypto'
import { getDatabase } from './index'
import { NotificationRepository } from './notification.repository'
import { CommentRepository } from './comment.repository'
import type { TodoComment } from './comment.repository'
import { EventsRepository } from './events.repository'
import type {
  Todo,
  TodoOwner,
  TodoRestoreConflict,
  TodoRestoreResult,
  CreateTodoInput,
  UpdateTodoInput
} from '../../renderer/types/todo'
import type { TodoStatus, TodoPriority, TodoType } from '../../renderer/types/enums'
import { withWriteRetry } from './write-retry'
import { assertConfirmedBeforeLeavingProposed } from './proposed-guards'
import { GuardResolver } from './guard-resolver'
import { nowVersion } from '../lib/version-stamp'
import { diffFields } from '../lib/field-changes'
import { GuardError, NotFoundError, UsageError, ConflictError } from '../lib/domain-errors'
export { ConflictError } from '../lib/domain-errors'

/**
 * 一次状态迁移：谁、把哪条事项、从哪挪到了哪、什么时候
 *
 * 这是动态"流转过程"的数据来源（v14）。
 * 与 events 表的区别：events 是变更广播（会被 prune 清掉），
 * 迁移是历史（要长期回看"这件事是怎么一步步走完的"）。
 */
export interface TodoTransition {
  id: string
  todoId: string
  /** null = 新建（此前没有状态） */
  fromStatus: TodoStatus | null
  toStatus: TodoStatus
  /** 动作人 —— **不是**提出者/执行者；null = 未记录，不猜 */
  actor: string | null
  createdAt: string
  /**
   * 这次「待验收 → 进行中」是不是**驳回**（1.0.72，迁移 30）
   *
   * 三态而不是布尔：
   * - `true`  = 驳回（验收不通过）
   * - `false` = 这次退回是执行方自己收回重开观察期，**不是**裁决
   * - `null`  = **未记录**（迁移前的老数据）—— 动态里如实显示"未记录"，不猜
   *
   * ⚠️ 刻意与"这张卡有没有 reject 评论"分开：那是**当前状态**，
   * 拿它反推历史会把"先被驳回、后来自己收回"误标成驳回。
   */
  isRejection: boolean | null
}

/** 合法优先级；主进程不能盲信渲染层传来的枚举值 */
const VALID_PRIORITIES: readonly TodoPriority[] = ['urgent', 'high', 'normal', 'low']

/**
 * 乐观锁冲突（1.0.73，`9947bf5a`）
 *
 * ## 为什么要有独立的错误类型，而不是普通 Error
 *
 * 它必须能让 CLI 归到**独立的退出码与错误码**（`conflict` / 退出码 5）——
 * 因为调用方对它的正确反应与其余错误**完全不同**：
 *
 * - 用法错误（2）、目标不存在（3）→ 改了参数再来
 * - 守卫拒绝（4）→ 重试无用，等人或换路
 * - **冲突（5）→ 重读、再决定** —— 不是"重试同一条命令"
 *
 * 之前蹭 `EXIT_CODES.error`（1）的话，agent 收到的是笼统的"出错了"，
 * 合理反应是盲重试 —— 而盲重试每次都会撞同一个冲突，还会把
 * "别人改的内容"再盖一遍（那正是本机制要防的事）。
 *
 * ⚠️ `withWriteRetry` 不会误重试它：那个函数只对
 * SQLITE_BUSY / LOCKED / READONLY 重试，其余一律直接抛（见 write-retry.ts）。
 */


/** 合法事项类型 */
const VALID_TYPES: readonly TodoType[] = ['bug', 'feature', 'task']

/** 合法状态，同样需要校验 */
const VALID_STATUSES: readonly TodoStatus[] = [
  'proposed',
  'todo',
  'in_progress',
  'suspended',
  'awaiting_review',
  'done',
  /**
   * 已废弃（1.0.68，`a6032512` 的 e 项）
   *
   * 「不做 / 重复 / 被替代 / 无效」是**正式结论** —— 不是删除，也不是"待做"。
   * 参照 Linear：Rejected / Duplicate → Canceled 并写原因。
   */
  'discarded'
]

/**
 * 候选池守卫说明（G1/G2/G4/G6/G10，实现在 TodoRepository 私有方法里）
 *
 * 候选池机制的硬约束放在 repo 层而不是 CLI/IPC 各写一份：
 * 两边共用同一个 repo，漏一边就等于没有约束 —— 守卫必须在唯一的写入口上。
 *
 * - G1：子任务只能挂在**已确认**的父需求下。父需求还躺在待确认列时，
 *   围绕它铺子任务等于在人点头之前就把工作量定死了。
 * - G2：父需求转「待验收」时，所有子任务必须已全部完成 ——
 *   验收的人只看最终结果，不该替 agent 检查子任务收没收尾。
 * - G4：「离开待确认」这道最关键的闸（Bob实测证实此前可被一条
 *   update 绕过）。proposed → 任何其他状态的迁移都被数据层硬拦。
 * - G6：父需求**直接**置 done 同样要求子任务全部完成（2026-09-19 主用户拍板）。
 *   G2 只守 awaiting_review 那条路，绕开它直接归档就能把没做完的子任务埋掉。
 * - G10：从「待验收」转「已完成」必须有人点头（1.0.65 补）。入口三道硬拦、
 *   末列却是软的，等于整个候选池唯一能"自己宣布完成"的位置恰好是不可逆那列。
 *   ⚠️ 只拦这一条路：agent 记自己的工作流水（`todo add --status done`）照旧。
 *
 * done 语义（文档层约束，数据层不拦的部分）：agent 把**自己登记的工作记录**
 * 置 done 是合法的（`todo add --status done` 是推荐用法，记流水）；
 * 把**别人创建的执行事项**自行置 done 越权 —— 无身份系统时分不清
 * "自己的事"和"别人的事"，该约束写在 SKILL/schema 的文档层。
 */

/**
 * 「子任务还没收尾」的判据 —— G2 / G6 共用一处（`96e4fd0d`）
 *
 * ## 为什么 `discarded` 必须排掉
 *
 * 废弃是**正式结论**（不做 / 重复 / 被替代 / 无效），不是"还没做完"。
 * 原先的 `status != 'done'` 把它算成未完成，于是一张被废弃的子卡
 * **永久锁住父卡** —— 实测撞上的是 `96e4fd0d`：它唯一的子卡 `9f34769d`
 * （Attempts 模型）早就废弃了，而父卡既转不了待验收、也归不了档。
 *
 * 更糟的是报错文案：「先把子任务完成，或**删掉** / 改派给它人后再归档」——
 * 唯一被点出来的出口是**删除**。为了一件已经决定不做的事去删数据，
 * 那正是这条守卫该避免的事。
 *
 * ⚠️ 别顺手把 `suspended` 也排掉：挂起是"以后可能做"，它确实还欠收尾。
 */
const CHILD_UNFINISHED_SQL = "status NOT IN ('done', 'discarded')"

function assertPriority(priority: TodoPriority | undefined): void {
  if (priority !== undefined && !VALID_PRIORITIES.includes(priority)) {
    throw new UsageError(`[TodoRepository] 非法的优先级: ${String(priority)}`)
  }
}

/**
 * 截断到 n 个字（用于通知摘要）
 *
 * ⚠️ 换行与连续空白要压成单空格：描述是自由文本，直接截断会把
 * "【背景】\n\n根因是…" 这种排版带进收件箱，而收件箱是**一行的位置**，
 * 塞进一段带换行的规格会把列表撑开、也读不下去。
 */
function clip(text: string | null | undefined, n: number): string {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > n ? `${flat.slice(0, n)}…` : flat
}

function assertType(type: TodoType | undefined): void {
  if (type !== undefined && !VALID_TYPES.includes(type)) {
    throw new UsageError(`[TodoRepository] 非法的事项类型: ${String(type)}`)
  }
}

function assertStatus(status: TodoStatus | undefined): void {
  if (status !== undefined && !VALID_STATUSES.includes(status)) {
    throw new UsageError(`[TodoRepository] 非法的状态: ${String(status)}`)
  }
}

/** 待办事项数据仓库 */
export class TodoRepository {
  /** 延迟创建：模块顶层 new 会在测试 mock getDatabase() 之前就触发 db 访问 */
  private _guardResolver: GuardResolver | null = null
  private get guardResolver(): GuardResolver {
    if (!this._guardResolver) this._guardResolver = new GuardResolver()
    return this._guardResolver
  }

  private get db() {
    return getDatabase()
  }

  /**
   * 解析落库用的标签 id 列表
   *
   * 不指定时回退到默认分类，而不是留空 —— 没标签的待办在看板上没有归属，
   * 而且会撞外键约束。
   *
   * 默认分类的选取规则（Bob反馈：此前 `LIMIT 1` 无 ORDER BY，取哪个看
   * SQLite 心情，agent 记的工作项可能落进"生活"）：
   * 优先取 is_default 且名"其他"的兜底分类，退而求其次取任一 is_default，
   * 都没有才取第一行。对 agent 记的工作项，"其他"比"生活"稳得多。
   */
  private resolveCategoryIds(explicit?: string[]): string[] {
    const wanted = (explicit ?? []).map((s) => s.trim()).filter(Boolean)
    if (wanted.length) return Array.from(new Set(wanted))

    const fallback =
      (this.db
        .prepare("SELECT id FROM categories WHERE is_default = 1 AND name = '其他' LIMIT 1")
        .get() as { id?: string } | undefined) ??
      (this.db
        .prepare('SELECT id FROM categories WHERE is_default = 1 LIMIT 1')
        .get() as { id?: string } | undefined) ??
      (this.db.prepare('SELECT id FROM categories LIMIT 1').get() as
        | { id?: string }
        | undefined)
    if (!fallback?.id) {
      throw new GuardError('[TodoRepository] 还没有任何分类，无法创建待办')
    }
    return [fallback.id]
  }

  /** 覆盖式写入某条待办的标签（先清后插） */
  private setCategoryIds(todoId: string, ids: string[]): void {
    this.db.prepare('DELETE FROM todo_categories WHERE todo_id = ?').run(todoId)
    const ins = this.db.prepare(
      'INSERT OR IGNORE INTO todo_categories (todo_id, category_id) VALUES (?, ?)'
    )
    for (const id of ids) ins.run(todoId, id)
  }

  /** 读出某条待办的标签 id */
  private getCategoryIds(todoId: string): string[] {
    const rows = this.db
      .prepare('SELECT category_id FROM todo_categories WHERE todo_id = ?')
      .all(todoId) as Array<{ category_id: string }>
    return rows.map((r) => r.category_id)
  }

  /**
   * G1：子任务只能挂在**已确认**的父需求下。
   *
   * 父需求自己还在「待确认」列（proposed）时，围绕它铺子任务
   * 等于在人点头之前就把工作量定死了 —— 拒绝，并说清原因，
   * 让 agent 知道该等确认而不是换个姿势重试。
   *
   * M4.5 起通过 GuardResolver 按配置决定行为（block/notice/off）。
   */
  private assertParentApproved(parentId: string): void {
    const parent = this.db
      .prepare('SELECT status, project_id FROM todos WHERE id = ?')
      .get(parentId) as { status: string; project_id: string | null } | undefined
    if (parent && parent.status === 'proposed') {
      const scope = parent.project_id
        ? { scope: 'project' as const, projectId: parent.project_id }
        : { scope: 'global' as const }
      this.guardResolver.assert(
        'G1',
        scope,
        '[TodoRepository] 父需求尚在「待确认」列，通过前不能创建子任务（G1）',
        '[G1] 父需求尚在「待确认」列，建议等确认后再建子任务'
      )
    }
  }

  /**
   * G2：对将以 nextStatus 落库的这条待办做子任务收尾检查。
   *
   * 必须在**写入前**调用：先查后写，守卫拒绝时不留任何部分改动 ——
   * 抛出的普通 Error 没有 SQLITE_* code，也不会被 write-retry 误重试。
   *
   * M4.5 起通过 GuardResolver 按配置决定行为（block/notice/off）。
   */
  private assertReadyForReview(id: string | null, nextStatus: TodoStatus): void {
    if (nextStatus !== 'awaiting_review' || !id) return
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n, MIN(project_id) AS project_id FROM todos WHERE parent_id = ? AND ${CHILD_UNFINISHED_SQL}`
      )
      .get(id) as { n: number; project_id: string | null }
    if (row.n > 0) {
      const scope = row.project_id
        ? { scope: 'project' as const, projectId: row.project_id }
        : { scope: 'global' as const }
      this.guardResolver.assert(
        'G2',
        scope,
        `[TodoRepository] 还有 ${row.n} 个子任务未完成，父需求不能转入「待验收」（G2）`,
        `[G2] 还有 ${row.n} 个子任务未完成，建议先收尾再转「待验收」`
      )
    }
  }

  /**
   * G6：直接归档（置 done）也要过子任务收尾检查。
   *
   * G2 只守「待验收」那条路 —— 父需求绕开它直接 `--status done`
   * 就能把一堆没做完的子任务一起埋进「完成」，看板上再也看不出还有活。
   *
   * 与 G2 的区别只在触发条件（done 而不是 awaiting_review），
   * 校验的是同一件事：**存在未完成子任务**。
   * ⚠️ 别堵死合法路径：先把子任务删掉 / 改派 / 自己完成 / **确认不做就标废弃**，再来归档，仍然放行。
   *
   * M4.5 起通过 GuardResolver 按配置决定行为（block/notice/off）。
   *
   * `, id ASC` 是兜底次序键（卡 07015c7e）：这条回执带着 `LIMIT 10`，
   * 平局时"列哪 10 条"由 SQLite 的隐式顺序定 —— 下一次调用可能给出另外 10 条，
   * 而它是"先做完这些再归档"的凭据。
   */
  private assertReadyForArchive(id: string | null, nextStatus: TodoStatus): void {
    if (nextStatus !== 'done' || !id) return
    const rows = this.db
      .prepare(
        `SELECT id, title, status, project_id FROM todos
         WHERE parent_id = ? AND ${CHILD_UNFINISHED_SQL}
         ORDER BY created_at ASC, id ASC LIMIT 10`
      )
      .all(id) as { id: string; title: string; status: string; project_id: string | null }[]
    if (rows.length > 0) {
      const total = (
        this.db
          .prepare(`SELECT COUNT(*) AS n FROM todos WHERE parent_id = ? AND ${CHILD_UNFINISHED_SQL}`)
          .get(id) as { n: number }
      ).n
      const list = rows
        .map((r) => `  ${r.id.slice(0, 8)} [${r.status}] ${r.title}`)
        .join('\n')
      const more = total > rows.length ? `\n  …另有 ${total - rows.length} 条，用 todo children 看全` : ''
      const projectId = rows[0]?.project_id
      const scope = projectId
        ? { scope: 'project' as const, projectId }
        : { scope: 'global' as const }
      this.guardResolver.assert(
        'G6',
        scope,
        `[TodoRepository] 还有 ${total} 个子任务未完成，父需求不能直接归档「完成」（G6）— ` +
          `先把子任务完成，或删掉 / 改派给它人 / 确认不做就标废弃后再归档：\n${list}${more}`,
        `[G6] 还有 ${total} 个子任务未完成，建议先收尾再归档`
      )
    }
  }

  /**
   * G4 守卫已提共用层（6720e1b9）：实现与放行判据见 `./proposed-guards.ts`。
   * update / delete 两处调用点都经由那一个函数 —— 别在这里再养第二份。
   */


  /**
   * G10：末列 done 也要有关口 —— 「验收通过」不能由 agent 自己宣布
   *
   * 🚨 **为什么补这道**（1.0.65 修 `fca59bda`，Carol体验 02 实测）：
   * 入口方向有三道硬拦（proposed → todo、直接跳 awaiting_review、
   * 直接跳 done 全被拒，退出码 4），唯独**末列**是软的 ——
   * `awaiting_review → done` 一路走通、退出码 0。
   *
   * 也就是说：整个候选池里唯一能"自己宣布完成"的位置，恰好是**不可逆的那一列**。
   * 入口拦住了"没被批准就开工"，末列却放行了"没被验收就结案"——
   * 一头严一头松，而松的那头正是**结论**。agent 能给自己签发完成证明。
   *
   * ⚠️ **判据不是"谁点的"，是"这条有没有被验收过"**：
   * 从「待验收」进「已完成」意味着"有人看过并认可了"，那一步只能由人做
   * （GUI 勾选 / GUI 拖拽），与 G4 同一套 `source` 标注。
   *
   * 🚨 **不能把"agent 自己建、自己做完、自己 done"也拦掉** ——
   * 那是记工作流水，本产品的核心用法之一（`todo add --status done`
   * 一步建到完成，见 agentGuide 的 done 口径）。拦掉它等于砍掉一半功能。
   * 本方法只管**从 awaiting_review 过来**的那一步 —— 数据层这一段。
   * 命令行那条主路比这里宽：`command-core.ts` 的 `self_verify`（1.0.116，
   * `a7ad343f`）按**身份**判，只要这次调用的结果是 done 就拦，
   * 起点在待办 / 进行中 / 挂起 / 待验收哪一列都一样。
   * 所以靠"不推进待验收"绕开本守卫这条路**不存在** —— 别在本文件里把它写回去。
   *
   * 这样两条语义都保住：「记录我做完了」照旧，「宣布验收通过了」必须有人点头。
   */
  private assertReviewSettledBeforeDone(
    existing: Todo,
    /** null = 删除：没有目标状态，不适用本守卫 */
    nextStatus: TodoStatus | null,
    source?: 'gui' | 'cli',
    /** 动作人：1.0.67 起按角色定权，要判断"你是不是执行者" */
    actor?: string | null,
    preApprovedGrantId?: string
  ): void {
    const currentStatus = existing.status
    if (nextStatus !== 'done') return
    // 只有"从待验收走过来"这一条路需要关口
    if (currentStatus !== 'awaiting_review') return
    if (source === 'gui' || preApprovedGrantId) return
    /**
     * 🚨 **1.0.67 语义变更（`a6032512`，Carol 10-05 提，10-06 拍板不拆版一起做）**
     *
     * 原来：按「身份」定权 —— `awaiting_review → done` 一律只能由人在界面上点。
     * 改成：按「角色」定权 —— **运动员不当裁判**：验收者 ≠ 执行者，通过则放行。
     *
     * **为什么要改**（Carol给的实测，不是推演）：
     * 2026-10-05 复验的 7 张里**5 张卡在"等人点完成"** ——
     * 而产品负责人**只能验界面/体验类问题，CLI 与内部机制类缺陷无法验证**。
     * 也就是说"等人点"这条规则在多数场景下**不可执行**，于是 G10 从一道闸门
     * 退化成"什么都得等我" —— 而我等不了。
     *
     * **"人一律得当裁判"不如"运动员不当裁判"**：
     * 前者假设有一个人能验所有东西（不成立），后者只要求验的人不是做的那个
     *
     * ⚠️ 保留的那道：运动员不当裁判。**自己做的东西自己签验收，那道门仍然关着** ——
     * 只是"人"不再是唯一有权点头的身份。
     *
     * ⚠️ **1.0.111 再改一次判据（卡 `8bf6a932`）**：执行者不再是
     * `executedBy ?? createdBy`，而是 `attributedExecutor()`（显式指派 →
     * 谁推进到待验收 → 提出者）。原因见那个方法的注释：旧判据把"没记录执行者"
     * 读成"提出者干的"，和"verifier 默认取提出者"合起来会产出自己验自己的死卡。
     */
    const executor = this.attributedExecutor(existing)
    if (actor === executor) {
      const scope = existing.projectId
        ? { scope: 'project' as const, projectId: existing.projectId }
        : { scope: 'global' as const }
      this.guardResolver.assert(
        'G10',
        scope,
        `[TodoRepository] 执行者不能验收自己做的事（G10）— ` +
          `这条的执行者是 ${executor}（显式指派 / 推进到「待验收」的人 / 提出者三选一，` +
          `按证据取，见 attributedExecutor），而你也是 ${actor}。\n` +
          `  出路：让 ${executor} 以外的验收者收口（--verifier 指定验收者）。` +
          `执行者不能把自己送进「已完成」—— 这道门按身份判，` +
          `从待办 / 进行中 / 挂起 / 待验收走过来都一样拦。`,
        `[G10] 执行者不能验收自己做的事，建议让其他验收者收口`
      )
    }
  }

  /**
   * 「谁不能签这条」—— `self_verify` / G10 的执行者判定（1.0.111，卡 `8bf6a932`）—— **单一出处**
   *
   * ## 为什么不用 `executedBy ?? createdBy`
   *
   * 旧判据把"没记录执行者"直接读成"提出者就是执行者"。两条各自合理的设计
   * （`verifier` 不传时默认取提出者 + 执行者字段靠回落推定）合起来会产出
   * **自己验自己**的卡：`executedBy` 为 NULL、实际由别人干的活，提出者（默认验收者）
   * 被自己拦在门外，卡只能等人或不相干第三方点。Bob 1.0.81 实测过两次
   * （原文："提出者既当默认执行者又当验收者，谁都收不了口"）。
   *
   * ## 新判据：按证据取，顺序固定
   *
   * ① 显式 `executedBy`（有人被点名）；
   * ② **谁把这条推进到「待验收」**（流转记录的 `actor`）—— 推进即认领，
   *    所以"别人推的 = 别人干的，提出者可以收口"；
   * ③ 都没有（直接建成待验收、或老数据没有流转）→ 回落提出者。
   *    这一格**必须回落**：否则"提出者直接建成待验收、再自己签"会变成一条自由通道。
   *
   * ⚠️ 它**只回答"谁不能签"**，不回答"这活归谁" —— 后者是 `todosForExecutor()`
   * 的 `executedBy ?? createdBy`（"提出即执行"也算归它）。两个问题不同，**别合并**：
   * 合并会让"提醒该推给谁""列表按执行者筛"跟着收口关系一起漂。
   */
  attributedExecutor(todo: Pick<Todo, 'id' | 'executedBy' | 'createdBy'>): TodoOwner {
    if (todo.executedBy) return todo.executedBy
    const rows = this.listTransitions(todo.id)
    for (let i = rows.length - 1; i >= 0; i--) {
      const step = rows[i]
      if (step.toStatus === 'awaiting_review' && step.actor) return step.actor as TodoOwner
    }
    return todo.createdBy
  }

  /** 创建待办事项 */
  create(input: CreateTodoInput): Todo {
    assertPriority(input.priority)
    assertStatus(input.status)
    assertType(input.type)

    /**
     * `nowVersion()` 而不是 `new Date().toISOString()`（1.0.73）
     *
     * ⚠️ **新建这里最容易漏**：它写下的 `updated_at` 就是这条事项的
     * **初始版本号**，而乐观锁的比对基准正是它。
     *
     * 实测踩过（`optimistic-lock.test.ts` 的"A 读过之后 B 改了"一条）：
     * create 用毫秒时间戳、update 用 `nowVersion()`，两者若落在**同一毫秒**，
     * B 写出的版本号会与 create 时**一模一样** ——
     * 于是 A 拿着"读到的旧值"来改竟然匹配通过，**乐观锁在第一次写入就漏判**。
     *
     * 判据：**版本号的单调性必须覆盖全生命周期，不能只有 update 那段是单调的。**
     * 一个不单调的起点，会让紧随其后的第一次写入直接失去保护。
     */
    const now = nowVersion()
    /**
     * id 可由调用方指定（备份导入），否则自己生成。
     *
     * ⚠️ 这里曾经硬编码 `uuidv4()`，忽略传入的 id。后果不是"id 不好看"，
     * 而是导入**每跑一次就把所有 id 换一遍**：`existingTodoIds` 的冲突检测
     * 永远命中不了（导入 204 条 → 再导入变 408 条），
     * 且任何引用旧 id 的东西（parentId、授权目标、人记下的编号）全部断掉。
     */
    const id = input.id?.trim() || uuidv4()
    const status = input.status ?? 'todo'
    const categoryIds = this.resolveCategoryIds(input.categoryIds)
    const parentId = input.parentId ?? null
    // v12 起提出者/执行者分离；显式指派 executedBy 才分离，否则执行者即提出者（落 NULL）
    const createdBy = input.createdBy ?? 'human'
    const executedBy = input.executedBy === undefined ? null : input.executedBy

    // G1：候选池未确认的父需求下不许建子任务
    //
    // 导入时跳过：恢复的是**已经存在过的数据**，不是"现在提出一件事"。
    // 拿 G1 去审一遍历史数据，会出现"父需求停在 proposed，于是它的子任务
    // 导不进来"这种荒谬结果 —— 而这些数据本来就该原样回来。
    if (parentId && !input.skipGuards) this.assertParentApproved(parentId)
    // G2：直接建成「待验收」的父需求同样要过子任务收尾检查（新建时子任务为 0，恒过）

    const todo: Todo = {
      id,
      title: input.title,
      description: input.description?.trim() ? input.description : null,
      categoryIds,
      categoryId: categoryIds[0] ?? '',
      projectId: input.projectId ?? null,
      parentId,
      /**
       * 曾经这里写死 'todo'，导致 CreateTodoInput.status 声明了却完全没生效 ——
       * 表现是"从某列新增的任务仍落在待办列"。类型上有、实现里没有，
       * 这类脱节编译器不会报错，只能靠实测发现。
       */
      status,
      priority: input.priority ?? 'normal',
      // 事项类型默认 task（普通任务），bug / feature 需显式指定
      type: input.type ?? 'task',
      // 提出者：谁记的这条（v12 起拆自 owner）
      createdBy,
      // 执行者：null = 执行者即提出者；显式指派给别人才落值
      executedBy,
      /**
       * 验收者：默认取提出者（`a6032512`）
       *
       * ⚠️ 默认给"提出者"而不是留空 —— 留空的话 `verifier ≠ executor`
       * 这条守卫会因为"没有验收者"而无法判断，等于闸门失效。
       * 而多数卡是 agent 提、人执行，默认验收者就是 agent，
       * 于是"运动员不当裁判"天然成立。
       */
      verifier: input.verifier ?? createdBy,
      dueAt: input.dueAt ?? null,
      remindAt: input.remindAt ?? null,
      isPinned: input.isPinned ?? false,
      // 解决于哪个版本（v24）：普通新建一般不传（null），导入时沿用备份值
      fixedInVersion: input.fixedInVersion?.trim() ? input.fixedInVersion.trim() : null,
      // 导入时沿用原始时间戳，否则整批数据的"创建时间"都会变成导入那一刻
      createdAt: input.createdAt ?? now,
      updatedAt: input.updatedAt ?? input.createdAt ?? now,
      /**
       * 直接建成"已完成"时要同时落完成时间，否则逾期判断等逻辑会读到不一致的状态。
       *
       * 导入时优先用备份里的值：`completedAt` 为 null 的 done 条目在真实数据里
       * 是可能存在的（早期版本留下的），导入时按 status 推断反而会凭空造出时间。
       */
      completedAt:
        input.completedAt !== undefined
          ? input.completedAt
          : status === 'done'
            ? now
            : null
    }

    withWriteRetry('todo.create', () =>
      this.db.transaction(() => {
        this.db
          .prepare(
            // v9 起 todos 表不再有 category_id 列，标签走关联表
            // v10 起多了 project_id / parent_id
            // v12 起多了 type / created_by / executed_by；owner 列退役（保留不读写）
            `INSERT INTO todos (id, title, description, project_id, parent_id, status, priority, type, created_by, executed_by, verifier, due_at, remind_at, is_pinned, fixed_in_version, created_at, updated_at, completed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            todo.id,
            todo.title,
            todo.description,
            todo.projectId,
            todo.parentId,
            todo.status,
            todo.priority,
            todo.type,
            todo.createdBy,
            todo.executedBy,
            todo.verifier,
            todo.dueAt,
            todo.remindAt,
            todo.isPinned ? 1 : 0,
            todo.fixedInVersion,
            todo.createdAt,
            todo.updatedAt,
            todo.completedAt
          )
        this.setCategoryIds(todo.id, categoryIds)
      })()
    )

    // 新建同样记一次迁移（从无到有），动态里显示为"新建了"。
    // 动作人优先取显式传入的 actor（CLI 的调用身份），没传才回退到提出者 ——
    // 提出者默认 human，agent 不带 --created-by 登记时若没有 actor 就会记错人。
    this.recordTransition(todo.id, null, status, input.actor ?? createdBy)

    return todo
  }

  /** 更新待办事项 */
  update(input: UpdateTodoInput): Todo {
    // 在读取、守卫检查之前取得写锁，避免另一进程在校验后改变状态或执行者。
    // close 等已有事务中的调用使用 savepoint，不破坏外层原子提交。
    return withWriteRetry('todo.update', () =>
      this.db.transaction(() => this.updateWithinTransaction(input)).immediate()
    )
  }

  private updateWithinTransaction(input: UpdateTodoInput): Todo {
    assertPriority(input.priority)
    assertType(input.type)

    const existing = this.getById(input.id)
    if (!existing) {
      throw new NotFoundError(`[TodoRepository] 待办事项不存在: ${input.id}`)
    }

    /**
     * 乐观锁（1.0.73，`9947bf5a`）—— **必须排在所有守卫之前**
     *
     * ## 位置为什么是"最前面"
     *
     * 它与守卫是**两类不同的事**，而错误码决定调用方的下一步：
     *
     * - 守卫拒绝（4）→ 「重试无用，等人操作或换合法路径」
     * - 冲突（5）   → 「**重读看别人改了什么，再决定**」
     *
     * 若排在守卫之后，`todo update --status done --if-updated-at <过期值>`
     * 这种"既撞守卫、又版本过期"的调用会报 **guard_blocked** ——
     * 于是调用方去等人操作，而它真正该做的是重读。**报错指错路比不报更贵。**
     *
     * ⚠️ 这条不是我推理出来的，是测试当场抓的：
     * 第一版写在守卫之后，`optimistic-lock.test.ts` 里
     * "冲突与守卫同时成立时该报冲突"一条直接红。
     * 判据：**前提条件（版本还在不在）先于业务规则（这么改合不合法）判定。**
     *
     * 这里只做**读比对**，事务里还会用 `WHERE updated_at = ?` 再锁一次 ——
     * 两处都要，因为读与写之间仍可能被另一个进程插进来（见下面事务内的注释）。
     *
     * 精确字符串比对（不解析成时间）：库里 `updated_at` 混着
     * `...587818`（6 位无 Z）和 `...750Z`（3 位带 Z）两种写法，
     * 解析后比较会让微秒被截断、把两个不同版本判成同一个。
     */
    if (input.ifUpdatedAt !== undefined && input.ifUpdatedAt !== existing.updatedAt) {
      throw new ConflictError(
        `[TodoRepository] 这条事项在你读到它之后被别人改过，本次修改已放弃（没有写入任何字段）。` +
          `你读到的是 ${input.ifUpdatedAt}，现在库里是 ${existing.updatedAt}。` +
          `重新 \`todo get ${existing.id}\` 看一遍改动，再决定要不要带上新的 updatedAt 重做。`
      )
    }

    // 候选池守卫：统一在写入前检查，拒绝时不留部分改动
    // source 由调用方声明（IPC handler 标 'gui'，CLI 不标）—— G4 只放行界面路径
    const nextStatus = input.status ?? existing.status
    // 已废弃是人的正式决定；agent 可以补资料，但不能自行重开或改成已完成。
    if (existing.status === 'discarded' && nextStatus !== 'discarded' && input.source !== 'gui') {
      throw new GuardError('事项已废弃，不能通过 agent 写入重新推进。请用户在界面上确认重开后再继续。')
    }
    const nextParentId = input.parentId !== undefined ? input.parentId : existing.parentId
    assertConfirmedBeforeLeavingProposed(
      existing,
      nextStatus,
      input.source,
      input.actor,
      input.preApprovedGrantId
    )
    this.assertReviewSettledBeforeDone(
      existing,
      nextStatus,
      input.source,
      input.actor,
      input.preApprovedGrantId
    )
    if (nextParentId) this.assertParentApproved(nextParentId)
    this.assertReadyForReview(existing.id, nextStatus)
    // G6：直接置 done 同样要过子任务收尾（G2 只管 awaiting_review 那条路）
    this.assertReadyForArchive(existing.id, nextStatus)

    /**
     * `nowVersion()` 而不是 `new Date().toISOString()`（1.0.73）
     *
     * 它要同时充当两件事：**这次的时刻** 与 **乐观锁的版本号**。
     * 用毫秒精度时间戳做版本号时，同毫秒内两次写入会取到**完全相同**的值
     * （实测 20000 次连续取样中 19974 次撞值），乐观锁于是静默失效 ——
     * 详见 `src/main/lib/version-stamp.ts` 的推导。
     *
     * ⚠️ 下面事务里那个 `WHERE updated_at = ?` 的比对依赖同一件事：
     * 用了它，才能保证"两次不同的写入 ⇒ 两个不同的版本号"。
     */
    const now = nowVersion()
    const updated: Todo = {
      ...existing,
      title: input.title ?? existing.title,
      // undefined = 未提及（保持原值），null / 空串 = 明确清空
      description:
        input.description !== undefined
          ? input.description?.trim()
            ? input.description
            : null
          : existing.description,
      categoryIds: input.categoryIds ?? existing.categoryIds,
      categoryId: (input.categoryIds ?? existing.categoryIds)[0] ?? '',
      // undefined = 未提及（保持原值），null = 明确清空
      projectId: input.projectId !== undefined ? input.projectId : existing.projectId,
      parentId: input.parentId !== undefined ? input.parentId : existing.parentId,
      status: input.status ?? existing.status,
      priority: input.priority ?? existing.priority,
      type: input.type ?? existing.type,
      // undefined = 未提及（保持原值）；显式传入才改提出者
      createdBy: input.createdBy ?? existing.createdBy,
      // executedBy 三态：undefined 保持 / null 清空指派（回到提出者执行）/ 值 = 指派
      // 发生推进类写入且尚未显式指派时，记录实际 actor，避免交付长期显示为“无人执行”。
      executedBy:
        input.executedBy !== undefined
          ? input.executedBy
          : existing.executedBy === null &&
              input.actor &&
              input.actor !== existing.createdBy &&
              input.status !== undefined &&
              input.status !== existing.status &&
              ['todo', 'in_progress', 'awaiting_review'].includes(input.status) &&
              !(existing.status === 'awaiting_review' && input.status === 'in_progress')
            ? (input.actor as TodoOwner)
            : existing.executedBy,
      // verifier 同样三态：undefined 保持 / 值 = 改验收者
      verifier: input.verifier !== undefined ? input.verifier : existing.verifier,
      dueAt: input.dueAt !== undefined ? input.dueAt : existing.dueAt,
      remindAt: input.remindAt !== undefined ? input.remindAt : existing.remindAt,
      isPinned: input.isPinned !== undefined ? input.isPinned : existing.isPinned,
      /**
       * 解决于版本（v24）三态：undefined 保持原值 / null 清空标注 /
       * 字符串 = 标到某版。trim 后为空串视为清空 —— 空白版本号没有意义，
       * 留着只会在按版本筛选时冒出一个名字是空白的选项。
       */
      fixedInVersion:
        input.fixedInVersion === undefined
          ? existing.fixedInVersion
          : input.fixedInVersion?.trim()
            ? input.fixedInVersion.trim()
            : null,
      updatedAt: now,
      completedAt: input.status
        ? input.status === 'done'
          ? now
          : null
        : existing.completedAt
    }

    /**
     * 乐观锁的**第二道**（1.0.73，`9947bf5a`）—— 上面那次比对是"读比对"，
     * 它到真正写入之间仍有一个窗口：另一个进程可以正好挤进去。
     * 所以把版本条件写进 `UPDATE` 的 `WHERE` 里，让**比较与写入变成同一条语句**，
     * 由 SQLite 保证原子性 —— 这才是真正锁住的那一道。
     *
     * `AND updated_at = ?` 只在调用方声明了 `ifUpdatedAt` 时才加：
     * 未声明的调用方保持原行为（不引入新的失败路径，向后兼容）。
     * 语义见 `UpdateTodoInput.ifUpdatedAt` 的注释。
     *
     * `info.changes === 0` 有两种可能（被改 / 被删），所以回读一次给出准确原因 ——
     * 报错必须说清"现在到底是什么状态"，否则调用方只能瞎猜该重读还是该死心。
     */
    const lockClause = input.ifUpdatedAt !== undefined ? ' AND updated_at = ?' : ''
    // SQL 只修改调用者明确提交的字段；未提及的字段不从读快照整行写回。
    const columns: string[] = ['updated_at']
    const values: (string | number | null)[] = [updated.updatedAt]
    const add = (provided: boolean, column: string, value: string | number | null) => {
      if (provided) { columns.push(column); values.push(value) }
    }
    add(input.title !== undefined, 'title', updated.title)
    add(input.description !== undefined, 'description', updated.description)
    add(input.projectId !== undefined, 'project_id', updated.projectId)
    add(input.parentId !== undefined, 'parent_id', updated.parentId)
    add(input.status !== undefined, 'status', updated.status)
    add(input.priority !== undefined, 'priority', updated.priority)
    add(input.type !== undefined, 'type', updated.type)
    add(input.createdBy !== undefined, 'created_by', updated.createdBy)
    add(input.executedBy !== undefined || updated.executedBy !== existing.executedBy, 'executed_by', updated.executedBy)
    add(input.verifier !== undefined, 'verifier', updated.verifier)
    add(input.dueAt !== undefined, 'due_at', updated.dueAt)
    add(input.remindAt !== undefined, 'remind_at', updated.remindAt)
    add(input.isPinned !== undefined, 'is_pinned', updated.isPinned ? 1 : 0)
    add(input.fixedInVersion !== undefined, 'fixed_in_version', updated.fixedInVersion)
    add(input.status !== undefined, 'completed_at', updated.completedAt)
    const updateSql = `UPDATE todos SET ${columns.map((column) => `${column} = ?`).join(', ')} WHERE id = ?` + lockClause

    withWriteRetry('todo.update', () =>
      this.db.transaction(() => {
        const params: (string | number | null)[] = [...values, updated.id]
        if (input.ifUpdatedAt !== undefined) params.push(input.ifUpdatedAt)

        const info = this.db.prepare(updateSql).run(...params)

        if (input.ifUpdatedAt !== undefined && info.changes === 0) {
          /**
           * 事务还没提交，此刻读到的是**当前**状态，可以据此说清是哪一种。
           * 抛出去会让 better-sqlite3 回滚整个事务 ——
           * 也就是"冲突时不留任何部分改动"，与 CLI 回执的措辞一致。
           */
          const fresh = this.getById(updated.id)
          throw new ConflictError(
            fresh
              ? `[TodoRepository] 这条事项在你读到它之后被别人改过，本次修改已放弃（没有写入任何字段）。` +
                `你读到的是 ${input.ifUpdatedAt}，现在库里是 ${fresh.updatedAt}。` +
                `重新 \`todo get ${updated.id}\` 看一遍改动，再决定要不要带上新的 updatedAt 重做。`
              : `[TodoRepository] 这条事项已被删除（${updated.id}），本次修改未写入。` +
                `它可能是被别人删的 —— 别按原样重试，先确认这条还该不该存在。`
          )
        }
        // 只有真的传了才动标签，避免"更新别处"时把标签顺手清掉
        if (input.categoryIds) {
          this.setCategoryIds(updated.id, updated.categoryIds)
        }
        /**
         * 状态变了才记迁移 —— 改标题、改优先级不是流转，不该污染动态。
         * 放在事务内：写库成功但迁移没记录，动态就会漏一段过程。
         */
        if (nextStatus !== existing.status) {
          /**
           * 传 `now` 下去（1.0.72）：**同一时间源**。
           *
           * 判据是"这条流转之前有没有 reject 评论"，而流转时间戳若在这里
           * 另算一次，与评论的先后关系就靠毫秒差决定 —— 实测那次
           * 评论 `.142` / 流转 `.143`，`<=` 直接不成立，真驳回被判成自收回。
           *
           * 判据：**"顺序即判据"的地方只有一个时间源。**
           * 差一毫秒不报错、tsc 也过，只是让真驳回消失。
           */
          this.recordTransition(updated.id, existing.status, nextStatus, input.actor, now)
        }
      })()
    )

    /**
     * 字段变更留痕（1.0.73，`482e4b03`）
     *
     * 主用户的提单要在验收时看到「本次变更 diff」，明说三类：描述追加 / 状态 / 字段。
     * 摸底发现字段这一路**全仓零留痕**：`todo update --priority high` 改完，
     * 库里只有一个 `updated_at` 变了，再没有任何地方能回答"它把优先级从
     * normal 改成了 high"。**渲染层再怎么写也渲染不出没记下来的东西。**
     *
     * ── 为什么写在这里 ──
     *
     * `existing` 与 `updated` 两个对象**只在这个方法里同时存在**，
     * 而 CLI 与 IPC 两条写路径**都经过它** —— 一处接线覆盖两边，
     * 与 `buildDescChangeEvent` 抽出来的判据同源（那边治的是"界面改规格零痕迹"）。
     *
     * ── 为什么放在事务外 ──
     *
     * 审计不该能让业务写入失败。放在事务内的话，events 写失败会回滚整次
     * 字段更新 —— 那是把"留痕"这个附属品的失败，升级成用户改不动数据。
     * 与 CLI 里 `descEvent` 的处理同构（`try/catch` + 不抛）。
     *
     * ── 为什么不复用 `description_changed` ──
     *
     * 描述有自己的事件（1.0.49 起，带 append/replace 与完整正文），
     * `diffFields` 的清单里**刻意不含 description 与 status**：
     * 它们各有专门的记录路径，这里再记一条就是两份真相，而且是残缺的那份。
     */
    const fieldChanges = diffFields(existing, updated)
    if (fieldChanges.length) {
      try {
        new EventsRepository().append('todo', input.actor ?? existing.createdBy, {
          cmd: 'todo update',
          id: updated.id,
          action: 'fields_changed',
          changes: fieldChanges
        })
      } catch (e) {
        // 审计写不进去不能让业务写入失败 —— 但也不静默（与 CLI 侧同构）
        console.warn(
          '[TodoRepository] 字段变更审计写入失败:',
          e instanceof Error ? e.message : e
        )
      }
    }

    return updated
  }

  /**
   * 记一次状态迁移 —— 动态里"流转过程"的数据来源
   *
   * `from` 为 null 表示新建（此前没有状态）。
   * `actor` 为 null 表示动作人未记录；**不猜**，动态里如实显示"未记录"。
   *
   * `is_rejection`（1.0.72，迁移 30）：`awaiting_review → in_progress`
   * 这一次**是不是驳回**，在写入这一刻定死。
   *
   * ## 为什么必须在写入时定，而不是查询时反推
   *
   * 判据只能来自"此刻有没有那条 `kind=reject` 评论"，而那是**当前状态**：
   * 卡被驳回过、后来执行方自己收回重开 → 反推会误标成驳回。
   * 事实要在发生的那一刻定死 —— 事后无法还原。
   *
   * 两条写入路径都满足"先落评论再流转"（1.0.72 核过）：
   * - `todo reject`（commands.ts：先 `commentRepo.add({kind:'reject'})` 再 `update`）
   * - 界面拖拽退回（KanbanBoard `confirmReject`：先 `addComment(kind:'reject')` 再 `updateTodo`）
   *
   * ⚠️ 只有这一条流转需要判别，其余流转一律 0：
   * 动态里"驳回"是一个独立节点，而"待办→进行中""进行中→待验收"仍是普通推进。
   */
  private recordTransition(
    todoId: string,
    from: TodoStatus | null,
    to: TodoStatus,
    actor?: string | null,
    /** 调用方已有的时间戳；不给才自己取（1.0.72，见调用处"同一时间源"那条） */
    at?: string
  ): void {
    const when = at ?? new Date().toISOString()
    const isRejection =
      from === 'awaiting_review' && to === 'in_progress' ? this.isRejection(todoId, when) : false

    this.db
      .prepare(
        `INSERT INTO todo_transitions (id, todo_id, from_status, to_status, actor, created_at, is_rejection)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      // 用 node:crypto 而不是被测试 mock 的 uuid —— 迁移表是 append-only，
      // id 撞了整条历史就写不进去（实测在单测里全量炸过一次）
      .run(randomUUID(), todoId, from, to, actor ?? null, when, isRejection ? 1 : 0)

    /**
     * 通知中心（1.0.48）：agent 把事项推进「待验收」= 一次交付，
     * 人该在收件箱里看到它（五类之一）。人自己拖过去的不发 ——
     * 自己交付给自己的事不需要被通知。
     */
    if (to === 'awaiting_review' && actor?.startsWith('agent:')) {
      try {
        const todo = this.getById(todoId)
        new NotificationRepository().create({
          type: 'review',
          title: `交付待验收：${todo?.title ?? '一条事项'}`,
          /**
           * F2（`68b9102a`）：此前 summary 一律留空、meta 一律 null，
           * 于是收件箱里 115 条 review 长得一模一样，只能靠 refId 辨认。
           * 判据：**通知是索引**，索引要能回答"谁、哪张卡、为什么"，
           * 否则它只是"又发生了一件事"，不构成可用的信息。
           * 描述是这条事项的原始规格，正是"为什么"最好的出处。
           */
          summary: clip(todo?.description ?? '', 120),
          refId: todoId,
          actor,
          meta: { from: from ?? null, to }
        })
      } catch (e) {
        console.warn('[Notification] 待验收索引写入失败:', e instanceof Error ? e.message : e)
      }
    }

    /**
     * 待你拍板（1.0.65，`68b9102a`）：事项进「待确认」= 等人表态。
     *
     * 🚨 此前**这一类一个通知都不发**：五类通知里最该主动推的那一类缺席，
     * 于是 proposed 只会安静地堆积（实测 4 条待确认，收件箱零条相关）。
     * 而"待确认"三个字顾名思义就是在等人 —— 没人通知就等于没人知道。
     *
     * 为什么与 review 分开而不是合并：两者要的人动作不同 ——
     * review 是"你验收一下做完了没有"，decision 是"这件事该不该做"。
     * 合并成一条，收件箱就没法回答"我现在该干什么"。
     *
     * 只在 agent 提议时发：人自己拖进去的，是她自己的决定，不需要通知自己。
     */
    if (to === 'proposed' && actor?.startsWith('agent:')) {
      try {
        const todo = this.getById(todoId)
        new NotificationRepository().create({
          type: 'decision',
          title: `待你拍板：${todo?.title ?? '一条事项'}`,
          summary: clip(todo?.description ?? '', 120),
          refId: todoId,
          actor,
          meta: { from: from ?? null, to }
        })
      } catch (e) {
        console.warn('[Notification] 待拍板索引写入失败:', e instanceof Error ? e.message : e)
      }
    }

    /**
     * 驳回通知（2026-09-28，C 方案）：**待验收 → 进行中** = 验收没通过，退回重做。
     *
     * 此前这个动作不留任何痕迹：验收方把结论写进描述、状态却不动，
     * 或者退回了也没有通知 —— 执行方只能靠逐条翻描述才发现自己被驳回了
     * （主用户实测提出的就是这个口子）。
     * 现在退回即留一条通知，`meta.rejected` 让界面能把它和"交付待验收"区分开。
     *
     * 谁退的都记（人退回也算）—— 驳回这件事本身值得被看见，与"自己交付给自己不通知"不同。
     *
     * ⚠️ 判据是 `isRejection()`（2026-10-01 修正），不能只看流转本身：
     * 执行方按人指示把卡从「等你验收」收回「进行中」重开观察期，走的也是这条流转，
     * 但那不是驳回 —— 早先只看流转，于是 09-29 一次性刷出 4 条假的
     * "验收未通过，已退回"通知，人打开卡却找不到驳回理由。
     */
    if (from === 'awaiting_review' && to === 'in_progress' && this.isRejection(todoId)) {
      try {
        const todo = this.getById(todoId)
        new NotificationRepository().create({
          type: 'review',
          title: `验收未通过，已退回：${todo?.title ?? '一条事项'}`,
          refId: todoId,
          actor: actor ?? null,
          meta: { rejected: true, from: 'awaiting_review', to: 'in_progress' }
        })
      } catch (e) {
        console.warn('[Notification] 驳回通知写入失败:', e instanceof Error ? e.message : e)
      }
    }
  }

  /**
   * 一次「待验收 → 进行中」到底算不算驳回？
   *
   * 这条流转有**两个来源**：
   *   1. 验收不通过 = `todo reject`（CLI）或界面拖拽退回
   *      —— 两条路都**先落一条 `kind=reject` 评论再流转**（见 commands.ts 的 todo reject、
   *      KanbanBoard 的 confirmReject）；
   *   2. 执行方**自己把卡从「等你验收」收回「进行中」**（按人指示重开观察期）
   *      —— 只改状态，不会写任何评论。
   *
   * 所以**那条 `kind=reject` 评论就是权威判据**：有它就是驳回，没有就是自收回。
   * 用这一个字段把两种情形分开，比看 actor 靠谱 —— 执行方也可能驳自己的卡，
   * 验收方也可能就是执行方本人。
   *
   * ## ⚠️ `before` 这个参数是 1.0.72 补的，缺了它会误标
   *
   * 原实现只问"这张卡**有没有** reject 评论"。但那是**当前状态**：
   * 卡被驳回过一次、之后执行方自己又收回重开时，那条老评论还在 ——
   * 于是第二次真实动作（自己收回）会被记成"又被驳回了"。
   *
   * 症状：动态里两次退回都写「驳回了」，而其中一次根本没人在裁决。
   * 判据：**"这次是不是驳回"要问"这一刻之前有没有驳回评论"**，
   * 而不是"这张卡历史上有没有过"。
   *
   * 迁移 30 的 `is_rejection` 列在写入时调本方法并传 `before = 该流转的时刻`，
   * 正是为了让这个区分成立。`before` 为空时退化为旧行为（通知那条路仍这么用，
   * 它要回答的是"这条卡被退回过没有"，不是"这次是不是驳回"）。
   */
  private isRejection(todoId: string, before?: string): boolean {
    try {
      /**
       * 判据（1.0.72 改过两次，这里是最终版）：**这次退回之前、
       * 最近一次「进入待验收」之后，有没有 reject 评论。**
       *
       * ## 为什么不用时间戳比较
       *
       * 先试过 `created_at <= 流转时刻`，**实测不成立**：
       * `todo reject` 是「先落评论、再调 update」，而 `update` 在函数**开头**
       * 就把 `now` 算好了 —— 于是流转时间戳比评论**早 1 毫秒**（探针实测：
       * 评论 `.508` / 流转 `.507`），`<=` 直接不成立，真驳回被判成"自己收回"。
       *
       * 改成"取更小的时间戳"也不可靠：毫秒精度内同刻写入的顺序不可分。
       * 判据靠时间戳排序 = 判据靠运气。
       *
       * ## 为什么用"上一次进入待验收"当分界
       *
       * 驳回永远发生在某一次交付之后 ——「待验收 → 进行中」之前，
       * 必然先有一次「进入待验收」。用那一次的 rowid 当分界：
       *   - **rowid 是插入顺序，单调、不依赖时钟**（同毫秒也不会错）；
       *   - 语义上正好是"这一次交付"与"上一次次交付"的边界。
       *
       * 于是"卡曾被驳回过、后来执行方自己收回重开"不会被误标：
       * 第二次收回之前的那次 reject 评论，落在**上一次交付**之前，被排除。
       *
       * 判据：**"顺序即判据"的地方用插入顺序，不要用时钟。**
       */
      if (before) {
        const boundary = this.db
          .prepare(
            `SELECT rowid FROM todo_transitions
              WHERE todo_id = ? AND to_status = 'awaiting_review' AND rowid < (
                SELECT rowid FROM todo_transitions
                 WHERE todo_id = ? AND from_status = 'awaiting_review' AND to_status = 'in_progress'
                 ORDER BY rowid DESC LIMIT 1
              )
              ORDER BY rowid DESC LIMIT 1`
          )
          .get(todoId, todoId) as { rowid: number } | undefined
        if (boundary) {
          const row = this.db
            .prepare(
              `SELECT 1 FROM todo_comments
                WHERE todo_id = ? AND kind = 'reject' AND rowid > ?
                LIMIT 1`
            )
            .get(todoId, boundary.rowid)
          return !!row
        }
      }
      const row = this.db
        .prepare(`SELECT 1 FROM todo_comments WHERE todo_id = ? AND kind = 'reject' LIMIT 1`)
        .get(todoId)
      return !!row
    } catch {
      // 查不出来时按"不是驳回"处理：宁可少发一条通知，也不要再制造假驳回
      return false
    }
  }

  /**
   * 被退回、且**仍归某个身份收口**的事项（2026-09-28，B 方案用）
   *
   * ⚠️ 判据不能只看流转（2026-10-01 实测修正）。
   *
   * `awaiting_review → in_progress` 这条流转有**两个来源**：
   *   1. 验收不通过 = `todo reject`（或界面拖拽退回）—— 会先落一条 `kind=reject` 评论；
   *   2. 执行方**自己把卡从「等你验收」收回「进行中」**（按人指示重开观察期）——
   *      只改状态，没有评论。
   *
   * 早先只看流转，于是第 2 种被当成"被验收方退回"，每次写命令都在回执里
   * 报"你有 1 条事项被验收方退回"，而那条卡的评论线程里根本没有驳回理由
   * —— 执行方按提示去翻，翻不到，白费一轮（`cb659bce` 实测踩到）。
   *
   * 权威判据是**那条 `kind=reject` 评论**：`todo reject` 先落评论再流转，
   * 有驳回就一定有它；自己收回则一定没有。两者用这一个字段就能分开。
   *
   * 与 `isRejection()`、`recordTransition` 里的驳回通知**共用同一个判据**
   * （那两处用单条查询，这里图省事用 SQL 的 EXISTS 子查询避开 N+1）——
   * 改判据时三处必须一起改，别让它们分叉。
   */
  listRejectedFor(owner: string | null): { id: string; title: string; updatedAt: string }[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT tr.todo_id AS todo_id
           FROM todo_transitions tr
           JOIN todos t ON t.id = tr.todo_id
          WHERE tr.from_status = 'awaiting_review'
            AND tr.to_status = 'in_progress'
            AND t.status = 'in_progress'
            AND EXISTS (
              SELECT 1 FROM todo_comments c
               WHERE c.todo_id = tr.todo_id AND c.kind = 'reject'
            )
          ORDER BY tr.created_at DESC, tr.id DESC LIMIT 50`
      )
      .all() as { todo_id: string }[]

    const out: { id: string; title: string; updatedAt: string }[] = []
    for (const r of rows) {
      const t = this.getById(r.todo_id)
      if (!t || t.status !== 'in_progress') continue
      if (owner && (t.executedBy ?? t.createdBy) !== owner) continue
      out.push({ id: t.id, title: t.title, updatedAt: t.updatedAt })
    }
    return out
  }

  /**
   * 把 WAL 内容并回主文件（备份前必做）
   *
   * 只拷 `user.db` 会丢掉还在 `-wal` 里、尚未 checkpoint 的事务 ——
   * 这是实测踩过的坑：备份出来的文件比真实状态旧。
   * 迁移前的备份也走同一个处理（见 migrations.ts 的 backupBeforeMigrate）。
   */
  checkpointWal(): void {
    try {
      this.db.pragma('wal_checkpoint(TRUNCATE)')
    } catch (err) {
      // 拿不到独占锁（比如另一个进程正在写）时不阻断 —— 备份仍可继续，
      // 只是可能少最后几个事务；静默失败比中断导入更糟，所以打出来
      console.warn(
        '[TodoRepository] WAL checkpoint 失败，备份可能不含最后若干事务:',
        err instanceof Error ? err.message : String(err)
      )
    }
  }

  /** 某条事项的迁移历史（旧→新，用于详情页"这件事怎么走过来的"） */  listTransitions(todoId: string): TodoTransition[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM todo_transitions WHERE todo_id = ? ORDER BY created_at ASC, rowid ASC'
      )
      .all(todoId) as Record<string, unknown>[]
    return rows.map(TodoRepository.mapTransition)
  }

  /** 全部迁移（动态视图用，旧→新） */
  listAllTransitions(limit = 300): TodoTransition[] {
    const rows = this.db
      .prepare('SELECT * FROM todo_transitions ORDER BY created_at DESC, rowid DESC LIMIT ?')
      .all(limit) as Record<string, unknown>[]
    return rows.map(TodoRepository.mapTransition).reverse()
  }

  private static mapTransition(row: Record<string, unknown>): TodoTransition {
    return {
      id: row.id as string,
      todoId: row.todo_id as string,
      fromStatus: (row.from_status as TodoStatus) ?? null,
      toStatus: row.to_status as TodoStatus,
      actor: (row.actor as string) ?? null,
      createdAt: row.created_at as string,
      /**
       * 三态映射：`0` / `1` → 布尔；`null`（老库那批）保持 null。
       *
       * ⚠️ 不能写成 `Boolean(row.is_rejection)` —— 那会把老数据全标成
       * "不是驳回"，于是动态里一片"推进了"，看上去与修之前没区别，
       * 而实际上是我们把"不知道"说成了"不是"。**缺失与否定不是一回事。**
       */
      isRejection: row.is_rejection === null || row.is_rejection === undefined
        ? null
        : row.is_rejection === 1
    }
  }

  /**
   * 子任务数量
   *
   * 删父任务前要用它提醒一句：删除后子任务**不会跟着消失**
   * （parent_id 外键是 ON DELETE SET NULL），它们会变成孤儿散在看板上，
   * 看不出原本属于谁。这个后果对人来说是意外，所以必须提前说，而不是删完才解释。
   */
  childCount(id: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM todos WHERE parent_id = ?')
      .get(id) as { n: number }
    return row.n
  }

  /**
   * 列出直接子任务
   *
   * 卡片上只显示"有几条子任务"，看不到是哪几条 ——
   * 详情页和 CLI 都要能把它展开。
   */
  listChildren(id: string): Todo[] {
    // `, id ASC` 是兜底次序键（卡 07015c7e）：同刻创建的子任务，顺序不能交给 SQLite 的隐式行为
    const rows = this.db
      .prepare('SELECT * FROM todos WHERE parent_id = ? ORDER BY created_at ASC, id ASC')
      .all(id) as Record<string, unknown>[]
    return this.mapRows(rows)
  }

  /**
   * 删除待办事项
   *
   * 删除同样是「离开待确认列」。只拦状态迁移却不拦删除的话，
   * agent 可以 rm 掉人还没拍板的条目、再另建一条，关口就形同虚设——
   * Bob 2026-09-18 实测：`todo update` 被 exit 4 硬拦，
   * `todo rm` 同一个 id 却直接返回 deleted:true。
   *
   * 与 update 同源处理：界面路径（渲染进程只被人操作）放行，CLI 两通道恒拦。
   */
  delete(id: string, source?: 'gui' | 'cli', actor?: string, preApprovedGrantId?: string): void {
    const existing = this.getById(id)
    if (existing) {
      assertConfirmedBeforeLeavingProposed(existing, null, source, actor, preApprovedGrantId)
    }

    /**
     * 删除留痕 ①（2026-09-28，主用户拍板 b3ac3d32 = 选 ①+③）
     *
     * 删除是这个应用里**最不可逆**的动作，而此前删掉之后
     * `todo history <id>` 只会回一句"待办不存在" ——
     * "谁删的、删之前是什么状态、挂了哪些子任务"事后一个都答不上来。
     * 误删、争议、审计三件事全靠这一条。
     *
     * 做法：删之前把**完整快照 + 流转链**写进 events（表不动、最轻）。
     * 配合 `findDeletedSnapshot`，history 就能对已删 id 给出 tombstone（第 ③ 档）。
     */
    if (existing) {
      const transitions = this.listTransitions(id)
      /**
       * 卡 `df06e4d7`：墓碑里必须连**上下文**一起写下 —— 评论与子事项关联。
       *
       * 故障是这么发生的：`todo_comments.todo_id` 是 `ON DELETE CASCADE`，
       * 评论在下面那条 `DELETE FROM todos` 里被**物理删掉**；
       * `todos.parent_id` 是 `ON DELETE SET NULL`，子事项被解绑成孤儿。
       * 也就是：删除一执行，这两样东西的原始值在这个世界上就不存在了 ——
       * 只存快照 + 流转链的那版墓碑因此只回得来主体，撤销后人拿到的是一张
       * "名字对得上、内容少一半"的卡（评论空着、子任务散在看板上）。
       *
       * 所以要在删除**之前**把评论（含作者、时间、楼中楼关系）与子事项 id
       * 写进同一条墓碑 —— 这是唯一拿得到它们的时刻。
       */
      const comments = new CommentRepository().listByTodo(id)
      const childIds = this.listChildren(id).map((child) => child.id)
      this.db
        .prepare(
          `INSERT INTO events (type, actor, payload, created_at) VALUES (?, ?, ?, ?)`
        )
        .run(
          'todo_deleted',
          actor ?? 'unknown',
          JSON.stringify({ snapshot: existing, transitions, comments, childIds }),
          new Date().toISOString()
        )
    }

    withWriteRetry('todo.delete', () =>
      this.db.prepare('DELETE FROM todos WHERE id = ?').run(id)
    )
  }

  /**
   * 删除留痕 ③：已删条目的"墓碑"。
   *
   * 返回谁删的、什么时候删的、删的时候它是什么状态 ——
   * 不是完整档案（那要软删/回收站，代价大得多），
   * 但足以回答"这条为什么没了"，也足以支撑误删后的恢复判断。
   */
  findDeletedSnapshot(
    id: string
  ): {
    deletedAt: string
    actor: string
    snapshot: Record<string, unknown>
    transitions: unknown[]
    /** 删除当时的评论（含作者、时间、楼中楼关系）—— 卡 `df06e4d7`；老墓碑没有这一段 → [] */
    comments: TodoComment[]
    /** 删除时挂在这条下面的子事项 id —— 卡 `df06e4d7`；老墓碑没有这一段 → [] */
    childIds: string[]
  } | null {
    /**
     * 直接按 payload 里的 `snapshot.id` 精确匹配，**不先拉 200 条再在 JS 里挑**。
     *
     * 旧写法是 `ORDER BY id DESC LIMIT 200` 再遍历 —— 那是个静默天花板：
     * 删除事件超过 200 条之后，更早的墓碑就永远查不到了，而且**不报错**，
     * 只回"待办不存在"。既然 events.payload 每次写入都是一整段 JSON
     * （`{"snapshot":{"id":"…"}, …}`），用 `json_extract` 在 SQL 里定位
     * 既准确又没有上限。
     *
     * ⚠️ 不能用 `LIKE '%"id":"x"%'` 代替：那会被别的字段里的同名字符串假命中。
     */
    const row = this.db
      .prepare(
        `SELECT actor, payload, created_at FROM events
          WHERE type = 'todo_deleted'
            AND json_extract(payload, '$.snapshot.id') = ?
          ORDER BY id DESC LIMIT 1`
      )
      .get(id) as { actor: string; payload: string | null; created_at: string } | undefined

    if (!row || !row.payload) return null
    try {
      const parsed = JSON.parse(row.payload) as {
        snapshot?: Record<string, unknown>
        transitions?: unknown[]
        /** 卡 `df06e4d7` 起才有；存量墓碑里没有 → 下面按空数组处理 */
        comments?: unknown[]
        childIds?: unknown[]
      }
      if (!parsed.snapshot) return null
      return {
        deletedAt: row.created_at,
        actor: row.actor,
        snapshot: parsed.snapshot,
        transitions: parsed.transitions ?? [],
        /**
         * ⚠️ 存量墓碑里**没有**这两段（它们从这张卡起才写）——
         * 缺字段按空处理：撤销照旧跑完（只恢复主体），
         * 不因为"老数据里没这项"报错，也不假装上下文恢复了。
         */
        comments: Array.isArray(parsed.comments) ? (parsed.comments as TodoComment[]) : [],
        childIds: Array.isArray(parsed.childIds) ? (parsed.childIds as string[]) : []
      }
    } catch {
      // 坏 payload 当作没有墓碑，不让一条脏数据挡住整个查询
      return null
    }
  }

  /**
   * 列出全部墓碑（1.0.60）。
   *
   * 给 `resolveId(allowDeleted)` 做前缀匹配用 —— 前缀解析需要"候选全集"，
   * 单条查询做不到。同样走 `json_extract`，不再有 200 条天花板。
   */
  listDeletedSnapshots(): Array<{
    deletedAt: string
    actor: string
    snapshot: Record<string, unknown>
    transitions: unknown[]
  }> {
    const rows = this.db
      .prepare(
        `SELECT actor, payload, created_at FROM events
          WHERE type = 'todo_deleted'
            AND json_extract(payload, '$.snapshot.id') IS NOT NULL
          ORDER BY id DESC`
      )
      .all() as { actor: string; payload: string | null; created_at: string }[]

    const out: Array<{
      deletedAt: string
      actor: string
      snapshot: Record<string, unknown>
      transitions: unknown[]
    }> = []
    /**
     * ⚠️ 同一条待办可以有**多个**墓碑：删掉 → 撤销放回 → 再删掉。
     * 实测 b28c7053 就有两条 `todo_deleted`（events 3130 / 3135）。
     * 不去重的话前缀匹配会报"匹配到 2 条已删待办，请写更长一些"——
     * 用户写满整个 id 也还是 2 条，这是个死胡同。
     *
     * `ORDER BY id DESC` 保证**先见到的是最新的那次删除**，
     * 所以按 id 取首次出现即可（与 `findDeletedSnapshot` 的 LIMIT 1 同口径）。
     */
    const seen = new Set<string>()
    for (const r of rows) {
      if (!r.payload) continue
      try {
        const parsed = JSON.parse(r.payload) as {
          snapshot?: Record<string, unknown>
          transitions?: unknown[]
        }
        if (!parsed.snapshot) continue
        const id = String(parsed.snapshot.id)
        if (seen.has(id)) continue
        seen.add(id)
        out.push({
          deletedAt: r.created_at,
          actor: r.actor,
          snapshot: parsed.snapshot,
          transitions: parsed.transitions ?? []
        })
      } catch {
        // 坏 payload 跳过
      }
    }
    return out
  }

  /**
   * 撤销：把一条刚被删掉的事项**原样**放回去（1.0.48）
   *
   * 撤销不是"新建一条一样的"—— id、提出者、创建时间、完成时间必须原样回来，
   * 否则它的子任务（parent_id 指向旧 id）会全部断掉，动态里的历史也接不上。
   * 所以走 create 的导入通道（指定 id + 原始时间戳 + skipGuards）。
   *
   * 为什么不走"软删"（加 deleted_at 列再过滤）：那要给所有查询补条件、
   * 导出/统计/CLI 全部跟着改，一处漏写就是"删掉的东西又冒出来"。
   * 而"删掉后 4 秒内可以后悔"这个需求，代价最小的正解是**快照 + 原样回插**。
   *
   * 父需求若在删除后已经不存在（比如父先被删），降级为顶层事项：
   * 挂回一个不存在的父会撞外键，宁可让它成为顶层，也不要恢复失败。
   */
  restore(snapshot: Todo): Todo {
    return this.restoreWithReport(snapshot).todo
  }

  /**
   * 撤销删除（含上下文）：主体 + 评论 + 父子关系一起放回（1.0.111，卡 `df06e4d7`）
   *
   * ## 修的是什么
   *
   * 撤销此前只回得来**主体**，而这条事项的上下文在删除那一刻就已经真的没了：
   * - `todo_comments.todo_id` 是 `ON DELETE CASCADE` → 评论被物理删除；
   * - `todos.parent_id` 是 `ON DELETE SET NULL` → 子事项被解绑成孤儿。
   *
   * 于是按下「撤销」拿到的是"看着一样、其实少了一半"的事项：讨论记录空了、
   * 子任务散在看板上再也认不出原本属于谁 —— 这比"恢复不了"更坏，
   * 因为界面上没有任何痕迹说明丢了什么。
   *
   * ## 怎么放回来
   *
   * 唯一拿得到这两样东西的时刻是**删除之前**，所以它们在 `delete()` 里就写进了
   * 同一条墓碑（`todo_deleted` 事件的 payload）；这里读回来原样回插：评论连
   * id、作者、时间、楼中楼关系一起（`CommentRepository.restoreAll`），
   * 子事项把 `parent_id` 拨回旧父级。三件事在**同一个事务**里做完 ——
   * "卡回来了、评论没回来"这种半个恢复态比不恢复更难解释。
   *
   * ## 为什么是"保留新关系 + 报冲突"，而不是静默挪回、也不是拒绝整次撤销
   *
   * 窗口期内子事项可能已经被改派给别人（拖拽、`todo update --parent`）——
   * 那是个**新决定**。拨回旧父级 = 用旧关系覆盖人的新决定；静默不动又不吭声 =
   * 人以为关联都回来了。所以：**保留新关系，并如实报告**（`conflicts`，界面据此
   * 明说哪几条没挪）。主体照常恢复 —— "有个子事项的归属有冲突"并不构成
   * "这条事项不能回来"。
   *
   * ## 幂等
   *
   * 重复撤销（界面连点、撤销完又点一次）不报错、不翻倍：
   * - 主体已在库里 → 走下面的 update 分支，评论一条都不会再插；
   * - 子事项已经挂在旧父级下 → 视作已恢复，不算冲突。
   *
   * ## 老墓碑
   *
   * `comments` / `childIds` 是本卡才加进墓碑的字段，存量墓碑里没有它们。
   * 缺字段按空处理：只恢复主体、不报错、也不假装上下文恢复了 ——
   * 那正是老版本的行为（见 `findDeletedSnapshot`）。
   */
  restoreWithReport(snapshot: Todo): TodoRestoreResult {
    const parentId =
      snapshot.parentId && this.getById(snapshot.parentId) ? snapshot.parentId : null

    // 这条还在库里（撤销"拖错列"：记录没删，只是状态被改了）——
    // 按快照覆盖，直接 INSERT 会撞主键。
    if (this.getById(snapshot.id)) {
      /**
       * ⚠️ 这条路上**不碰**评论与父子关系：记录从没被删过，评论没被级联删、
       * 子事项也没被解绑 —— 照着墓碑再插一遍只会撞主键。幂等就落在这里，
       * 也落在下面那条"子事项已经挂在旧父级 → 不算冲突"上。
       */
      const todo = this.update({
        id: snapshot.id,
        title: snapshot.title,
        description: snapshot.description,
        projectId: snapshot.projectId,
        parentId,
        categoryIds: snapshot.categoryIds,
        status: snapshot.status,
        priority: snapshot.priority,
        type: snapshot.type,
        createdBy: snapshot.createdBy,
        executedBy: snapshot.executedBy,
        dueAt: snapshot.dueAt,
        remindAt: snapshot.remindAt,
        isPinned: snapshot.isPinned,
        fixedInVersion: snapshot.fixedInVersion,
        // 撤销是人的动作，与界面操作同一放行口径
        source: 'gui',
        actor: 'human'
      })
      return { todo, commentsRestored: 0, childrenRelinked: [], conflicts: [] }
    }

    /** 老墓碑没有这两段 → 空数组 = 只恢复主体（不报错） */
    const tomb = this.findDeletedSnapshot(snapshot.id)
    const comments = tomb?.comments ?? []
    const childIds = tomb?.childIds ?? []

    /**
     * 先把"哪些挂回去、哪些报冲突"算清楚，再进事务写 ——
     * 事务里只做纯写入，判定集中在一处，用例也能直接对着这份计划断言。
     */
    const relink: string[] = []
    const conflicts: TodoRestoreConflict[] = []
    for (const childId of childIds) {
      const child = this.getById(childId)
      if (!child) {
        // 子事项本身也被删了：挪不回去，但这不是"被改派"，如实分开说清
        conflicts.push({ id: childId, title: childId, reason: '子事项已不存在（可能已被删除）' })
        continue
      }
      // 已经挂在旧父级下 = 上一次撤销做过了（幂等），不算冲突
      if (child.parentId === snapshot.id) continue
      if (child.parentId) {
        conflicts.push({
          id: child.id,
          title: child.title,
          reason: `已被指派给 ${child.parentId}`
        })
        continue
      }
      relink.push(child.id)
    }

    const created = withWriteRetry('todo.restore', () =>
      this.db.transaction(() => {
        const todo = this.restoreSubject(snapshot, parentId)
        const commentsRestored = new CommentRepository().restoreAll(comments)
        if (relink.length > 0) {
          /**
           * 关联真的变了，版本号也要跟着动 —— 否则别人手里那份旧快照
           * 还以为这条子事项的归属没被碰过（乐观锁比的就是 updated_at）。
           */
          const upd = this.db.prepare('UPDATE todos SET parent_id = ?, updated_at = ? WHERE id = ?')
          const at = nowVersion()
          for (const childId of relink) upd.run(todo.id, at, childId)
        }
        return { todo, commentsRestored }
      })()
    )

    return {
      todo: created.todo,
      commentsRestored: created.commentsRestored,
      childrenRelinked: relink,
      conflicts
    }
  }

  /**
   * 恢复主体：走 create 的导入通道（原 id + 原始时间戳 + skipGuards）；
   * 父级降级规则沿用 `restore` 的老口径（挂回一个不存在的父会撞外键，
   * 宁可让它成为顶层，也不要恢复失败）。
   *
   * 为什么拆成一个方法：评论与父子关系必须与主体落在**同一个事务**里
   * （见 `restoreWithReport`），而 `create` 内部那一层是 savepoint ——
   * 从外层事务里调它即可，不必把整段 create 调用再往右缩进一层，
   * 读起来也仍然是"恢复主体"这一件事。
   */
  private restoreSubject(snapshot: Todo, parentId: string | null): Todo {
    return this.create({
      id: snapshot.id,
      title: snapshot.title,
      description: snapshot.description,
      projectId: snapshot.projectId,
      parentId,
      categoryIds: snapshot.categoryIds,
      status: snapshot.status,
      priority: snapshot.priority,
      type: snapshot.type,
      createdBy: snapshot.createdBy,
      executedBy: snapshot.executedBy,
      dueAt: snapshot.dueAt,
      remindAt: snapshot.remindAt,
      isPinned: snapshot.isPinned,
      fixedInVersion: snapshot.fixedInVersion,
      createdAt: snapshot.createdAt,
      updatedAt: snapshot.updatedAt,
      completedAt: snapshot.completedAt,
      // 恢复的是已经存在过的数据，不是"现在提出一件事"，守卫不适用
      skipGuards: true,
      actor: 'human'
    })
  }

  /** 批量更新状态 */
  batchUpdateStatus(ids: string[], status: TodoStatus): void {
    /**
     * 同样用 `nowVersion()`（1.0.73）：这一批改完之后，
     * 紧接着对其中某一条做 `--if-updated-at` 写入时必须判得出"它变过"。
     * 用毫秒时间戳的话，同毫秒内的"批量改"与"单条改"会撞成同一版本号。
     *
     * 批内所有 id 共用一个时间戳是**对的** —— 它们是同一次操作改的，
     * 而版本号只在**同一条行的前后两次写入之间**被比较，跨行不比较。
     */
    const now = nowVersion()
    const completedAt = status === 'done' ? now : null

    const stmt = this.db.prepare(
      `UPDATE todos SET status = ?, updated_at = ?, completed_at = ? WHERE id = ?`
    )

    const transaction = this.db.transaction(() => {
      for (const id of ids) {
        stmt.run(status, now, completedAt, id)
      }
    })
    withWriteRetry('todo.batchUpdateStatus', () => transaction())
  }

  /**
   * 批量改（逐条执行 + 汇总回执）—— 2026-09-24 主用户拍板的批量能力
   *
   * ⚠️ 为什么不复用上面那种"单事务打包"：一条被守卫拦下
   * （父需求直接置完成 G6、待确认列不许代转 G4、优先级/类型非法…）
   * 会让**整批回滚**，而回执只说得出"整体失败"——**说不出是哪几条、为什么**。
   * 人只能一条条试，批量等于白做。
   *
   * 所以这里逐条走 `update()`：守卫照常生效、审计照常落，
   * 成功的进 updated，失败的连标题与原因一起进 failed，一次回执说清。
   *
   * `source` / `actor` 由 IPC 层盖章（与单条 update 同一套），这里不自己补。
   */
  batchUpdate(
    ids: string[],
    patch: Omit<UpdateTodoInput, 'id'>
  ): { updated: string[]; failed: { id: string; title: string; reason: string }[] } {
    const updated: string[] = []
    const failed: { id: string; title: string; reason: string }[] = []
    for (const id of ids) {
      const before = this.getById(id)
      const title = before?.title ?? id
      try {
        this.update({ ...patch, id } as UpdateTodoInput)
        updated.push(id)
      } catch (e) {
        failed.push({ id, title, reason: e instanceof Error ? e.message : String(e) })
      }
    }
    return { updated, failed }
  }

  /** 批量删（同上：逐条执行，一条失败不拖垮整批） */
  batchDelete(
    ids: string[],
    source?: 'gui' | 'cli'
  ): { deleted: string[]; failed: { id: string; title: string; reason: string }[] } {
    const deleted: string[] = []
    const failed: { id: string; title: string; reason: string }[] = []
    for (const id of ids) {
      const before = this.getById(id)
      /**
       * ⚠️ 先查存在性：`delete()` 对不存在的 id **静默成功**（不报错、不返回任何东西）。
       * 单条删时这算幂等、无所谓；但批量会把"N 条"当成回执报出去 ——
       * 其中混着几条早就没了的，界面就会说"已删除 N 条"，而实际只删掉了更少的数。
       * 更糟的是它掩盖了一次竞争（别人刚删过 / 列表是旧的）。
       * 所以这里主动分辨：不在的直接进 failed，理由写清楚。
       */
      if (!before) {
        failed.push({ id, title: id, reason: '不存在（可能已被别处删除，列表可能是旧的）' })
        continue
      }
      try {
        this.delete(id, source)
        deleted.push(id)
      } catch (e) {
        failed.push({
          id,
          title: before.title,
          reason: e instanceof Error ? e.message : String(e)
        })
      }
    }
    return { deleted, failed }
  }

  /** 查询待办事项列表 */
  /**
   * 查询待办
   *
   * `fixedInVersion` 支持两个特殊值（1.0.59）：
   * - `'unset'` → 只看**未标注**版本的（= 还没归入任何一版）
   * - `'any'`   → 只看**已标注**的（不管哪一版）
   * 具体版本号（如 '1.0.59'）→ 只看该版。
   *
   * 'unset' 存在的理由：发版前真正的清单就是"还没标注 + 状态在做/待验收"，
   * 没有它，"这版还剩哪些没收口"就筛不出来。
   */
  /**
   * 找出与给定标题疑似重复的事项（1.0.68，修 `84efa995`）
   *
   * ## 为什么要有
   *
   * 提单给的证据是**三方正经都犯过**：qwen 的 `c3a798c8`/`180928cf` 同义重复、
   * 我自己 09-30 同秒造过两条逐字相同（`ee24bd55`/`20430c0c`）、
   * 还有一条标题本身就写着"（重复登记，已挂起）"。
   * **三方都在犯，说明这不是"谁不小心"，是产品缺这道闸。**
   *
   * ⚠️ 她说过"数清单总数"是她的决策依据之一 ——
   * 重复项会让她把工作量算错。**那是输入污染了判断依据，比体验问题严重。**
   *
   * ## 判据怎么定的（**用真实数据反推，不是拍脑袋**）
   *
   * 我先在真实库上量了已知五对真重复的得分：
   * - 逐字/近逐字（`ee24bd55`‖`20430c0c`、以及三对完全相同的）→ **dice 0.74~1.00**
   * - 同义改写（`c3a798c8`「零 emoji 规范未覆盖 CLI」‖ `180928cf`「禁 emoji 扩到 CLI」）
   *   → **dice 仅 0.30**
   *
   * 而假阳性那边（"主测试卡"vs"子任务"、"操作审计视图"vs"日历视图"）dice 只有 0.25~0.29。
   *
   * **结论：单一相似度阈值做不到"不漏报也不误报"。**
   * 所以分两档：
   * - **档一（相似度）**：dice ≥ 0.7，抓逐字与近逐字重复 —— 覆盖 4/5 的真重复
   * - **档二（显式标记）**：新标题里带"重复登记"这类词 → 直接提示
   *   ——**同义改写那一类靠相似度抓不住，但人写出来时会主动标记**
   *
   * 剩下的同义改写（dice 0.2~0.4）**故意不检**：
   * 那个区间的得分与假阳性重叠，强行检会变成"每建一条都报重复"——
   * **一个天天误报的提醒等于没有提醒**（同 `3df42f82` 的教训）。
   *
   * ## 只提醒不拦
   *
   * 返回列表让调用方决定，**本方法不改任何数据**。
   * 与 G 系列软提醒同一档：硬拦会把"同名不同事"这类正当操作也挡住。
   */
  findSimilar(
    title: string,
    limit = 3,
    /** 排除某条 id —— 调用方是"刚建完这张"，它自己不该被算成重复 */
    excludeId?: string
  ): Array<{ todo: Todo; reason: string }> {
    const norm = (t: string): string =>
      t
        .toLowerCase()
        .replace(/[（(][^）)]*[）)]/g, '') // 去括注："（重复登记，已挂起）"不该参与判重
        .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '')
    /** 中文按 2-gram、英文数字整体成词 —— 无分词库时的最小可用切法 */
    /**
     * 2-gram 切法**复用 commonGrams 那一套**（不能各写一份 ——
     * 两套口径必然漂，而漂了之后理由里指的片段与实际算的就对不上）。
     */
    const grams = (t: string): Set<string> => this.grams2(t)
    const dice = (a: string, b: string): number => {
      const ga = grams(a)
      const gb = grams(b)
      if (!ga.size || !gb.size) return 0
      let inter = 0
      for (const g of ga) if (gb.has(g)) inter++
      return (2 * inter) / (ga.size + gb.size)
    }

      const normTitle = norm(title)
      /**
       * 档二：标题里显式带了"重复"字样 —— 人自己已说明意图
       *
       * ⚠️ **1.0.70 修（qwen 实测驳回）**：原来这里**无条件返回最近 3 条**，
       * 不管相似度 —— 于是探针卡「v70探针…自撤与去重闸」建一张标题带
       * 「重复标题测试」的卡，命中 3 条**毫不相干**的卡
       * （69b9b651 MCP 工具表、e5c23a1e 材料缺口，**标题里根本没有"重复"二字**），
       * 而理由文案统一写「标题里带了「重复」字样」——
       * **它连"为什么命中"都没说。**
       *
       * Bob的判断我完全接受：
       * 「**后果比没闸更糟 —— 提醒越不准，agent 越快学会无视它。**」
       *
       * 改法：**档二只作为"意图信号"，不能替代相似度** ——
       * 仍然按 dice 排，只把「意图强烈」反映在理由文案与排序上。
       * ⚠️ 阈值不降：**降阈值换来的召回会以误报为代价**（同 `3df42f82` 的教训）。
       */
      const explicitHint = /重复|duplicate|dupe/i.test(title)
      if (normTitle.length < 4) return []
      const scored = this.list()
        .filter((todo) => todo.id !== excludeId)
        .map((todo) => {
          const score = dice(title, todo.title)
          /**
           * 意图强烈的条目**加权重排**，而不是无条件放行 ——
           * 排序变、门槛不变。
           */
          const boosted = explicitHint ? Math.min(1, score + 0.15) : score
          return { todo, score: boosted, raw: score, boosted: explicitHint }
        })
        .filter((x) => x.score >= 0.7)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map(({ todo, score, raw, boosted }) => ({
          todo,
          /**
           * 理由要能回答"**凭什么是它**"（qwen 实测驳回的核心诉求）。
           *
           * 三个信息缺一不可：
           * ① 相似度数值 ② 命中的是**哪个片段**（不是"看起来像"）
           * ③ 若因标题含"重复"而**加权**，要说明那是加权不是命中
           *
           * 判据：**一条说不出"为什么是它"的提醒，等于没有提醒** ——
           * agent 学不会用，只会学会无视（同 `3df42f82`）。
           */
          reason:
            `标题相似度 ${(raw * 100).toFixed(0)}%` +
            `（共同片段：「${this.commonGrams(title, todo.title).slice(0, 3).join('」「')}」）` +
            (boosted ? '；你的标题含「重复」字样，已加权排序' : '') +
            '。若确属同一条，删掉刚建的这张'
        }))
      return scored
    }

    /**
     * 两个标题共有的 2-gram 片段（取最长的几个，短片段没信息量）
     *
     * 用于让提醒**指得出命中在哪** —— 只给一个百分比，
     * 调用方仍不知道该看哪一段文字。
     */
    private commonGrams(a: string, b: string): string[] {
      const ga = this.grams2(a)
      const gb = this.grams2(b)
      const shared = [...ga].filter((g) => gb.has(g))
      // 长的片段信息量更大：优先展示 3-gram，其次 2-gram
      return shared
        .sort((x, y) => y.length - x.length || x.localeCompare(y))
        .slice(0, 3)
    }

    /** findSimilar 用的 2-gram 切法（抽成方法，好让 commonGrams 复用同一套口径） */
    private grams2(t: string): Set<string> {
      const T = t
        .toLowerCase()
        .replace(/[（(][^）)]*[）)]/g, '')
        .replace(/[^a-z0-9一-鿿]+/g, '')
      if (T.length <= 3) return T ? new Set([T]) : new Set()
      const out = new Set<string>()
      for (let i = 0; i < T.length - 1; i++) out.add(T.slice(i, i + 2))
      return out
    }

    list(filter?: {
      status?: TodoStatus
      categoryId?: string
      keyword?: string
      fixedInVersion?: string
    }): Todo[] {
    let sql = 'SELECT * FROM todos WHERE 1=1'
    const params: unknown[] = []

    if (filter?.fixedInVersion === 'unset') {
      sql += ' AND fixed_in_version IS NULL'
    } else if (filter?.fixedInVersion === 'any') {
      sql += ' AND fixed_in_version IS NOT NULL'
    } else if (filter?.fixedInVersion) {
      sql += ' AND fixed_in_version = ?'
      params.push(filter.fixedInVersion)
    }

    if (filter?.status) {
      sql += ' AND status = ?'
      params.push(filter.status)
    }
    if (filter?.categoryId) {
      // v9 起标签在关联表里，用 EXISTS 而不是 JOIN —— JOIN 会让一条多标签的
      // 待办重复出现多次
      sql +=
        ' AND EXISTS (SELECT 1 FROM todo_categories tc WHERE tc.todo_id = todos.id AND tc.category_id = ?)'
      params.push(filter.categoryId)
    }
    if (filter?.keyword) {
      sql += ' AND title LIKE ?'
      params.push(`%${filter.keyword}%`)
    }

    // 置顶排前，再按创建时间倒序；同一毫秒的按 id 倒序（兜底次序键，卡 07015c7e）
    sql += ' ORDER BY is_pinned DESC, created_at DESC, id DESC'

    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[]
    return this.mapRows(rows)
  }

  /** 根据 ID 获取待办事项 */
  getById(id: string): Todo | null {
    const row = this.db.prepare('SELECT * FROM todos WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined
    return row ? this.mapRow(row) : null
  }

  /**
   * 按 id 或 id 前缀解析出完整 id
   *
   * CLI 输出的是完整 uuid，但人（和 agent）引用时几乎总是截前 8 位。
   * 不支持前缀就得每次先 list 再复制 —— 多一次往还，还容易粘错。
   *
   * 前缀撞到多个时抛错，不随便挑一个：删错一条待办是不可逆的。
   */
  resolveId(idOrPrefix: string, opts: { allowDeleted?: boolean } = {}): string {
    const hit = this.getById(idOrPrefix)
    if (hit) return hit.id

    /**
     * ⚠️ 前缀里不能出现 LIKE 的通配符（1.0.40 修）。
     *
     * 下面用的是 `id LIKE ?`，而 LIKE 里 `%`（任意串）与 `_`（任意单字符）
     * 是通配符：
     * - `dp todo rm "%"` → 拼成 `LIKE '%%'` → 匹配**全部**行。多数时候
     *   matches.length > 1 会被下面的"匹配到多条"挡住，但**库里恰好只有
     *   1 条待办时 matches.length === 1 → 直接返回它并删掉** ——
     *   一次笔误就能删掉仅有的数据。
     * - `dp todo rm "_"` 同理。
     *
     * 这里只拦这三个字符（`\` 一并拦，因为它是 SQL 的 ESCAPE 字符，
     * 将来若给 LIKE 加 `ESCAPE '\'` 它就是特殊字符），**不限制整个字符集**：
     * 真实 id 是 uuid（只含 [0-9a-f-]），但把校验放宽到"只拦危险字符"
     * 更稳 —— 既堵住注入，又不会因为将来 id 形态变化误伤合法前缀。
     */
    if (/[%_\\]/.test(idOrPrefix)) {
      throw new UsageError(
        `[TodoRepository] id 前缀不能包含 % _ \\ 这些字符: ${idOrPrefix}`
      )
    }

    const matches = this.db
      .prepare('SELECT id FROM todos WHERE id LIKE ?')
      .all(idOrPrefix + '%') as Array<{ id: string }>

    if (matches.length === 1) return matches[0].id
    if (matches.length > 1) {
      throw new UsageError(
        `[TodoRepository] id 前缀 "${idOrPrefix}" 匹配到 ${matches.length} 条待办，请写更长一些`
      )
    }
    /**
     * 已删条目的墓碑解析（1.0.60，主用户驳回 b3ac3d32 的**真因**）。
     *
     * ── 为什么要有这一段 ──
     *
     * `todo history` 早就写好了墓碑分支（见 commands.ts 的 `findDeletedSnapshot`），
     * 但它**永远走不到**：命令第一行就是 `resolveId(input)`，而已删条目的 id
     * 在 `todos` 表里已经不存在 → 这里直接抛 "待办不存在"，
     * 后面的墓碑分支连碰都碰不到。
     *
     * 于是"删除留痕"的验收判据（`todo history <已删id>` 回墓碑而不是 not_found）
     * 在代码上写着、在实测里不成立 —— 又一次"文案说修了、代码没落地"。
     *
     * ── 为什么不直接让 resolveId 兜底 ──
     *
     * 改**全局默认行为**会波及所有调用方：`todo update/comment/rm` 拿到一个
     * 已删 id 时，错误就会从"待办不存在"变成各路下游的诡异报错。
     * 所以墓碑解析只在调用方显式要求时才走（`allowDeleted: true`），
     * **只读路径用它，写路径一律不用**。
     */
    if (!opts.allowDeleted) {
      throw new NotFoundError(`[TodoRepository] 待办不存在: ${idOrPrefix}`)
    }

    const tomb = this.findDeletedSnapshot(idOrPrefix)
    if (tomb) return String(tomb.snapshot.id)

    /**
     * 前缀匹配墓碑：与上面的 todos 前缀逻辑同口径（唯一的差别是数据源）。
     * ⚠️ 通配符校验在上面已经做过，这里不必重复。
     */
    const tombIds = this.listDeletedSnapshots()
      .map((t) => String(t.snapshot.id))
      .filter((id) => id.startsWith(idOrPrefix))
    if (tombIds.length === 1) return tombIds[0]
    if (tombIds.length > 1) {
      throw new UsageError(
        `[TodoRepository] id 前缀 "${idOrPrefix}" 匹配到 ${tombIds.length} 条已删待办，请写更长一些`
      )
    }

    throw new NotFoundError(`[TodoRepository] 待办不存在: ${idOrPrefix}`)
  }

  /** 获取所有设有提醒且未触发的待办 */
  getPendingReminders(): Todo[] {
    const now = new Date().toISOString()
    const rows = this.db
      .prepare(
        `SELECT * FROM todos WHERE remind_at IS NOT NULL AND remind_at > ? AND status != 'done'`
      )
      .all(now) as Record<string, unknown>[]
    return this.mapRows(rows)
  }

  /** 获取已过期但仍有提醒的待办 */
  getOverdueReminders(): Todo[] {
    const now = new Date().toISOString()
    const rows = this.db
      .prepare(
        `SELECT * FROM todos WHERE remind_at IS NOT NULL AND remind_at <= ? AND status != 'done'`
      )
      .all(now) as Record<string, unknown>[]
    return this.mapRows(rows)
  }

  /**
   * 批量取多条待办的分类（1.0.38）
   *
   * 此前 `mapRow` 对每一行各查一次 `getCategoryIds` —— 1000 条待办
   * 就是 1001 次查询。better-sqlite3 是同步 API，这 1000 次会**阻塞主进程**，
   * 直接冻结所有窗口；`backup.exportData()` 也走 `list()`，导出时同样卡。
   * 改成一次 `IN (...)` 预取后在内存分组。
   *
   * 分块是因为 SQLite 的绑定变量有上限（旧版本 999），
   * 一次塞几千个 `?` 会直接报 "too many SQL variables"。
   *
   * `ORDER BY rowid` 不能省：单条查询返回的是插入顺序，
   * 批量结果分组后必须保持同一顺序，否则 `categoryId`（取第一个）会漂移。
   */
  private getCategoryIdsBatch(todoIds: string[]): Map<string, string[]> {
    const result = new Map<string, string[]>()
    if (!todoIds.length) return result

    const CHUNK = 500
    for (let i = 0; i < todoIds.length; i += CHUNK) {
      const chunk = todoIds.slice(i, i + CHUNK)
      const placeholders = chunk.map(() => '?').join(',')
      const rows = this.db
        .prepare(
          `SELECT todo_id, category_id FROM todo_categories
           WHERE todo_id IN (${placeholders}) ORDER BY rowid`
        )
        .all(...chunk) as Array<{ todo_id: string; category_id: string }>

      for (const r of rows) {
        const list = result.get(r.todo_id)
        if (list) list.push(r.category_id)
        else result.set(r.todo_id, [r.category_id])
      }
    }
    return result
  }

  /**
   * 批量映射（替代 `rows.map(this.mapRow)`）
   *
   * ⚠️ 不要写 `rows.map(this.mapRow)` —— map 会把 **index** 当作第二个参数
   * 传进去，正好落在本函数的 `categoryIds` 位置上（1.0.38 修）。
   */
  private mapRows(rows: Record<string, unknown>[]): Todo[] {
    if (!rows.length) return []
    const batch = this.getCategoryIdsBatch(rows.map((r) => r.id as string))
    return rows.map((r) => this.mapRow(r, batch.get(r.id as string)))
  }

  /**
   * 将数据库行映射为 Todo 对象
   *
   * @param categoryIds 由 mapRows 批量预取后传入；不传则自己查一次
   *                    （仅供 getById 这类单行场景使用）
   */
  private mapRow = (row: Record<string, unknown>, categoryIds?: string[]): Todo => {
    const ids = categoryIds ?? this.getCategoryIds(row.id as string)
    return {
      id: row.id as string,
      title: row.title as string,
      // v24 起；旧行没有这一列，兜底为 null（= 未标注）
      fixedInVersion: (row.fixed_in_version as string | null) ?? null,
      description: (row.description as string | null) ?? null,
      categoryIds: ids,
      categoryId: ids[0] ?? '',
      projectId: (row.project_id as string | null) ?? null,
      parentId: (row.parent_id as string | null) ?? null,
      status: row.status as TodoStatus,
      // 历史行可能在迁移前写入，兜底为 normal
      priority: (row.priority as TodoPriority) ?? 'normal',
      // v12 起 type 列；历史行迁移时已回填 'task'，这里再保一层
      type: (row.type as TodoType) ?? 'task',
      // v12 起提出者/执行者分离；created_by 迁移时全量回填原 owner，这里再保一层
      createdBy: (row.created_by as TodoOwner) ?? 'human',
      // NULL = 执行者即提出者（不是数据缺失）
      executedBy: (row.executed_by as TodoOwner | null) ?? null,
      // 存量行在 schema 26 里已由迁移回填为 created_by；这里兜住更早的备份导入
      verifier: (row.verifier as TodoOwner | null) ?? (row.created_by as TodoOwner),
      dueAt: (row.due_at as string | null) ?? null,
      remindAt: row.remind_at as string | null,
      isPinned: Boolean(row.is_pinned),
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
      completedAt: row.completed_at as string | null
    }
  }
}
