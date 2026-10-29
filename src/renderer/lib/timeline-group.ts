import dayjs from 'dayjs'
import type { Todo, TodoTransition } from '../types/todo'
import { dayKey } from './date'

/**
 * 动态里的一个节点
 *
 * 一条事项会贡献一到两个节点。候选池引入后关键节点变成四种：
 * - created：普通创建（直接建成 todo/in_progress 等）
 * - proposed_created：以「待确认」提议的方式创建 —— "谁在什么时候提了什么"
 *   是候选池工作流的起点，过几天回看仍然有意义
 * - completed：普通完成
 * - review_completed：验收完成 —— 从「待验收」转入 done 的那一刻，
 *   意义不同于普通勾掉：这是人对 agent 交付的一次裁决
 *
 * v14 起多了第五种：
 * - transitioned：中间流转 —— 待办→进行中、进行中→待验收这类过程。
 *   以前动态只有"从头"和"到尾"，一件事是怎么被推进的全部不可见；
 *   人机共享的看板里"谁在推进"恰恰是主要信息（agent 推的和人推的要分得出来）。
 *
 * 1.0.72 多了第六种（它才是前面那条的子类）：
 * - rejected：**验收不通过被退回**。
 *   它和普通流转走的是同一条路（`awaiting_review → in_progress`），
 *   但性质完全不同：那是**裁决**，不是推进。
 *   此前两者都显示「推进了」，于是被驳回的卡在动态里长成
 *   「Bob 推进了 xxx」—— **裁决被记成了推进**。
 *   判据是流转自己带的 `isRejection`（写入那一刻定死，见迁移 30），
 *   不靠"这张卡现在有没有 reject 评论"反推 —— 那是当前状态，会误标。
 *
 * 判据不变：这个节点，过几天回看还有意义吗？
 * 「被驳回了」显然有 —— 它是"验收不通过、等重做"这个事实本身。
 */
export type TimelineKind =
  | 'created'
  | 'proposed_created'
  | 'completed'
  | 'review_completed'
  | 'transitioned'
  | 'rejected'

export interface TimelineEvent {
  todo: Todo
  kind: TimelineKind
  /** 该节点发生的时间 */
  at: string
  /**
   * 事件主语：**谁**做了这个动作。
   *
   * v14 起流转表里有真相：新建 = from 为 null 那条的 actor，完成 = 转 done 那条的 actor
   * （人在界面上点验收，记的是人 —— 此前按执行者猜，agent 交付的事项会被显示成
   * "agent 验收通过了"，而真正拍板的人反而看不见，2026-09-20 实测踩中）。
   * 没有流转记录的旧数据退回按归属推：创建用提出者，完成用执行者??提出者。
   */
  actor: string | null
  /** 仅 transitioned 节点携带：这次流转从哪到哪 */
  transition?: Pick<TodoTransition, 'fromStatus' | 'toStatus' | 'actor'>
}

/** 动作文案。写成带「了」的动词短语，因为它在句子里是谓语（"Alice 完成了 X"） */
export const TIMELINE_KIND_LABEL: Record<TimelineKind, string> = {
  created: '新建了',
  proposed_created: '提议了',
  completed: '完成了',
  review_completed: '验收通过了',
  transitioned: '推进了',
  /**
   * 用「驳回了」而不是「退回了」：
   * 前者说清了**是谁对谁做了什么裁决**（验收方驳回），
   * 而"退回"听起来像中性移动 —— 那正是它此前被当成"推进"的原因。
   * 一句话对比：「Bob 推进了 xxx」vs「Bob 驳回了 xxx」。
   */
  rejected: '驳回了'
}

/**
 * 时间范围
 *
 * 为什么要有它：动态是**一直往前长**的，没有时间维度就只能从头翻。
 * 快捷档覆盖绝大多数场景，'custom' 留给"上次那件事大概是几月做的"这类回溯。
 */
export type TimeRangeKey = 'all' | 'today' | '7d' | '30d' | 'custom'

export interface TimeRange {
  key: TimeRangeKey
  /** 仅 'custom' 时使用，'YYYY-MM-DD' */
  from?: string | null
  to?: string | null
}

export const TIME_RANGE_LABEL: Record<TimeRangeKey, string> = {
  all: '全部时间',
  today: '今天',
  '7d': '近 7 天',
  '30d': '近 30 天',
  custom: '自定义…'
}

export const DEFAULT_TIME_RANGE: TimeRange = { key: 'all' }

/**
 * 某个时刻是否落在所选范围内
 *
 * 「近 7 天」= 今天 + 前 6 天（共 7 个自然日），不是"现在往前推 168 小时" ——
 * 后者会把前天的记录漏掉一部分，用户看到的是"少了东西"却说不出哪里不对。
 * 所以统一按**自然日**切，与时间线的分组口径一致。
 */
export function isWithinTimeRange(at: string, range: TimeRange): boolean {
  if (range.key === 'all') return true

  const d = dayjs(at)
  const todayStart = dayjs().startOf('day')

  /*
   * 边界一律用 `!isBefore`（即 >=）而不是 isAfter。
   * 因为下界是某天的 00:00，恰好等于它的那条记录会被 isAfter 判成"不在范围内" ——
   * 表现是"近 7 天"里少了第 7 天最早的那几条，用户只觉得数字不对却说不出哪里错。
   */
  switch (range.key) {
    case 'today':
      return !d.isBefore(todayStart)
    case '7d':
      return !d.isBefore(todayStart.subtract(6, 'day'))
    case '30d':
      return !d.isBefore(todayStart.subtract(29, 'day'))
    case 'custom': {
      // 只填一端也算数：填了"从"就是"从那天起"，填了"到"就是"到那天为止"
      if (range.from && d.isBefore(dayjs(range.from).startOf('day'))) return false
      if (range.to && d.isAfter(dayjs(range.to).endOf('day'))) return false
      return true
    }
  }
}

/**
 * 把事项铺成"关键节点"序列，按天分组，最近的一天在最前
 *
 * 只取**关键**节点，刻意不做成"所有字段变更的流水账"：
 * 后者会把每次拖拽排序都算一条，真正重要的事反而被淹掉。
 * 判据：这个节点，过几天回看还有意义吗？—— 创建、完成、推进有，挪了个位置没有。
 *
 * 数据来源：
 * - 创建/完成节点来自 todos 表已有的 created_at / completed_at；
 * - 中间流转来自 v14 的 todo_transitions（append-only，仓库层只在世界状态
 *   真的变化时才多一行）。
 *
 * 流转节点与创建/完成节点刻意**不重叠**：
 * - from 为 null 的新建流转已被 created / proposed_created 覆盖；
 * - 转入 done 的流转已被 completed / review_completed 覆盖（时间也一致）。
 * 两边都显示的话，同一件事在时间线里会出现两遍。
 */
export function buildTimeline(
  todos: Todo[],
  transitions: TodoTransition[] = [],
  range: TimeRange = DEFAULT_TIME_RANGE
): { key: string; items: TimelineEvent[] }[] {
  const events: TimelineEvent[] = []

  // 事项索引：流转挂在事项上，被筛掉/已删除的事项的流转一并略去，
  // 否则动态里会出现"点不开、对不上号"的孤儿节点
  const byId = new Map(todos.map((t) => [t.id, t]))

  /*
   * 每条事项的"事件主语"真相（v14）：
   * - creationActor = from 为 null 那条流转的 actor（谁记的这条）
   * - doneActor = 最后一条转 done 流转的 actor（谁拍板验收的 —— 重开再完成取最后一次）
   * 取不到（v14 前的旧数据没记录）才退回按归属猜。
   */
  const creationActor = new Map<string, string | null>()
  const doneActor = new Map<string, string | null>()
  for (const tr of transitions) {
    if (!byId.has(tr.todoId)) continue
    if (tr.fromStatus === null) creationActor.set(tr.todoId, tr.actor)
    if (tr.toStatus === 'done') doneActor.set(tr.todoId, tr.actor)
  }

  for (const t of todos) {
    /*
     * 创建节点：提议创建与普通创建分开记。
     * createdAt 本身不区分两者，用创建时的状态判断 ——
     * "提议"这个动作只发生在创建一刻；提议后被驳回的历史无从还原，
     * 宁可统一按普通创建记，也不凭推测造假节点。
     *
     * 主语 = 谁记的这条：优先流转记录的 actor（真相），
     * 退回提出者。**不能用执行者**——"agent 报 bug 给我修"的事项，
     * 主语是 agent（它新建的），不是我（执行者）。
     */
    const created: TimelineEvent = {
      todo: t,
      kind: t.status === 'proposed' ? 'proposed_created' : 'created',
      at: t.createdAt,
      actor: creationActor.has(t.id) ? (creationActor.get(t.id) ?? t.createdBy) : t.createdBy
    }
    if (isWithinTimeRange(created.at, range)) events.push(created)

    /*
     * 完成节点。
     *
     * 只认 completedAt：它是"真的完成过"的证据。缺它的历史数据不补一条，
     * 宁可少一个节点，也不要凭 updatedAt 造一个假时间 ——
     * 那会让时间线出现"三个月前做完、今天才完成"这种自相矛盾。
     *
     * 验收通过 vs 普通完成（v12 起按提出者/执行者分离的口径）：
     * **执行者**不是提出者本人的（典型：agent 报的 bug 由用户修完、或
     * agent 替用户做完），交付必经人的验收列，标「验收通过」；
     * 提出即执行的事项勾掉就是普通「完成」。
     *
     * 主语 = 谁拍板置的 done：优先转 done 流转的 actor（人在界面上点的验收，
     * 记的是人）；旧数据没有流转记录，退回 执行者??提出者（彼时的最简口径）。
     */
    if (t.status === 'done' && t.completedAt) {
      const isReview = (t.executedBy ?? t.createdBy) !== t.createdBy
      const completed: TimelineEvent = {
        todo: t,
        kind: isReview ? 'review_completed' : 'completed',
        at: t.completedAt,
        actor: doneActor.has(t.id)
          ? (doneActor.get(t.id) ?? t.executedBy ?? t.createdBy)
          : (t.executedBy ?? t.createdBy)
      }
      if (isWithinTimeRange(completed.at, range)) events.push(completed)
    }
  }

  /*
   * 中间流转节点（v14）：谁把这条事项从哪推到了哪。
   *
   * 只留"中间"的流转 —— 头（新建）和尾（转 done）已被上面的节点覆盖，
   * 两边都显示同一件事就出现两遍。actor 为 null（旧数据/未记录）也显示，
   * 动态里如实标注"未记录"，不猜是谁。
   */
  for (const tr of transitions) {
    if (tr.fromStatus === null || tr.toStatus === 'done') continue
    const todo = byId.get(tr.todoId)
    if (!todo) continue
    const event: TimelineEvent = {
      todo,
      /**
       * 驳回单独成节点（1.0.72）。
       *
       * 判据是 `tr.isRejection` —— **写入那一刻定死的那个值**。
       * 刻意不用"这张卡有没有 reject 评论"反推：那是当前状态，
       * 卡被驳回过、后来执行方自己收回重开的话，反推会把它误标成驳回。
       *
       * ⚠️ `null`（迁移前的老数据）**不归入驳回**，也不假装是普通推进 ——
       * 它照常显示为「推进了」，但那条流转的 `isRejection` 仍是 null，
       * 界面在需要区分时（如详情页流转历史）能如实显示"未记录"。
       * 这里刻意不新增一个「未知」节点类型：动态是给人看动作的，
       * 塞一个占位节点只会让它变长，而它并不提供新信息。
       */
      kind: tr.isRejection === true ? 'rejected' : 'transitioned',
      at: tr.createdAt,
      actor: tr.actor,
      transition: { fromStatus: tr.fromStatus, toStatus: tr.toStatus, actor: tr.actor }
    }
    if (isWithinTimeRange(event.at, range)) events.push(event)
  }

  events.sort((a, b) => b.at.localeCompare(a.at))

  const map = new Map<string, TimelineEvent[]>()
  for (const e of events) {
    // 用本地日期做键，不能用 toISOString —— 那是 UTC，晚上做的事会被分到第二天
    const key = dayKey(e.at)
    const arr = map.get(key)
    if (arr) arr.push(e)
    else map.set(key, [e])
  }

  // Map 保留插入顺序，而 events 已按时间倒序 → 分组天然是"最近的一天在最前"
  return Array.from(map.entries()).map(([key, items]) => ({ key, items }))
}
