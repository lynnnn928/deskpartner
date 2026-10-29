import { EventsRepository } from '../database/events.repository'
import { FIELD_LABELS, ENUM_LABELS } from './field-changes'

/** 审计流水里的一条（给人看的形态） */
export interface TodoAuditLine {
  at: string
  actor: string
  kind: string
  what: string
}

/**
 * 审计事件的最小输入形态（1.0.62）
 *
 * 这层翻译**不该自己去查库**：CLI 与界面各有一个读出入口，但翻译逻辑
 * 必须只有一份 —— 所以查询留在调用方，这里只接收数据。
 * 它也让这层变得可纯函数测试（此前只能靠真库）。
 */
export interface AuditEventInput {
  type: string
  actor: string | null
  payload: unknown
  createdAt: string
}

/** 状态 → 中文（与渲染层 STATUS_META 同口径；audit 是给人看的，不是给机器看的） */
const STATUS_LABELS: Record<string, string> = {
  proposed: '待确认',
  todo: '待办',
  in_progress: '进行中',
  suspended: '挂起',
  awaiting_review: '待验收',
  done: '已完成'
}

/**
 * 流水里的一条（给界面用）—— 审计线与流转线合并后的统一形态
 *
 * 界面上同一条时间线要同时装得下「内容被改了/被删了」与「状态变了」，
 * 所以合并成一个类型（合并逻辑见 `mergeTimeline`）。
 */
export interface TimelineEntry extends TodoAuditLine {
  /**
   * 排序序号。**必须显式带出来，不要在展示层按时间戳重排**：
   * 流转与审计可能落在同一毫秒（点「完成」会同时触发状态变更与提醒取消），
   * 只按时间戳排会让顺序随机。列表本身是旧→新，下标就是权威顺序。
   */
  timelineSeq: number
}

/**
 * 把一个事项的审计事件翻译成人看得懂的行（1.0.60，主用户驳回 68c7ccc1）
 *
 * ── 为什么需要这层翻译 ──
 *
 * 主用户的驳回原话：「留痕写进去了，但**没有任何地方读得出**，实际效果仍是无痕」。
 * 验收判据是：「`todo history` 能看到'某某在何时删了哪条评论'，
 * 不需要碰数据库」。
 *
 * 现实是：`comment_deleted` / `todo_deleted` 从 1.0.52 / 1.0.55 起就一直在
 * **如实写入**，payload 里带着完整的被删内容 —— 但 events 表当时只有
 * "给轮询用的增量读法"（`listSince`），**没有任何面向回溯的读入口**，
 * 所以"写入侧有、读取侧为零"，效果上等同于没留痕。
 *
 * 这层翻译还负责把 payload 摊平：它是给机器存的（嵌套的
 * snapshot / comment / transitions），直接丢给用户看等于没做。
 * 而这几类事件恰好是**"改掉已写下的东西"**这类最需要对证的动作，
 * 所以必须带上**被删除的内容本身** —— 只说"某条评论被删了"仍然
 * 没法对证"删掉的是不是那句承诺"。
 *
 * ⚠️ events 有保留策略（7 天 / 2000 条），结果可能不完整 ——
 * 调用方负责把这件事如实告诉用户，不能假装这是完整档案。
 */
export function buildTodoAudit(todoId: string, limit = 100): TodoAuditLine[] {
  const events = new EventsRepository().listForTodo(todoId, limit)
  return translateAuditEvents(events, todoId)
}

/**
 * 翻译层本体（纯函数，1.0.62 从 `buildTodoAudit` 里抽出来）
 *
 * 抽出来的理由：CLI 与界面是两个**不同的读出入口**，但"事件怎么翻译成人话"
 * 只能有一份判据 —— 复制一份到第二个调用点，就是给未来留一个"某天只改了一处"
 * 的哑弹（本文件存在的理由正是"写了却读不出"，详见 `buildTodoAudit` 的注释）。
 */
export function translateAuditEvents(
  events: readonly AuditEventInput[],
  todoId: string
): TodoAuditLine[] {
  const out: TodoAuditLine[] = []

  for (const e of events) {
    // 「改描述」写侧的 type 恒为 'todo'、靠 payload.action 区分动作（见 commands.ts
    // 的 description_changed）。读侧若只认 type 就会掉进 default，只剩一句
    // 「某人 · todo」——写了却读不出，与本文件存在的理由正面冲突。
    if (e.type === 'todo') {
      const todoPayload = (e.payload ?? {}) as Record<string, unknown>
      /**
       * 字段变更（1.0.73，`482e4b03`）
       *
       * ⚠️ **不写这一段，这条就白记了。** 本文件顶部的判据已经说过一次：
       * 「写了却读不出」与"根本没写"在效果上完全一致 ——
       * `comment_deleted` 就为此被主用户驳回过（68c7ccc1）。
       * 字段变更走的是同一个位置（`type='todo'` + payload.action 区分），
       * 漏了这一支，它会掉进 default，只显示一句「某人 · todo」。
       *
       * 逐条列出而不是给个"改了 3 个字段"的计数：变更记录是**对证**用的
       * （"我没让你改截止时间"），计数答不了这个问题。
       */
      if (todoPayload.action === 'fields_changed') {
        const changes = Array.isArray(todoPayload.changes)
          ? (todoPayload.changes as { field?: unknown; before?: unknown; after?: unknown }[])
          : []
        const parts = changes.map((c) => {
          const field = String(c.field ?? '')
          const label = FIELD_LABELS[field] ?? field
          const enumMap = ENUM_LABELS[field]
          const show = (v: unknown): string => {
            if (v === null || v === undefined) return '（空）'
            const s = String(v)
            if (field === 'isPinned') return s === 'true' ? '置顶' : '取消置顶'
            if (enumMap) return enumMap[s] ?? s
            return s
          }
          return `${label} ${show(c.before)} → ${show(c.after)}`
        })
        out.push({
          at: e.createdAt,
          actor: e.actor ?? '未记录',
          kind: '改字段',
          what: `${actorLabel(e.actor)} 改了 ${changes.length} 个字段：${parts.join('；')}`
        })
        continue
      }

      if (todoPayload.action === 'description_changed') {
        const before = typeof todoPayload.before === 'string' ? todoPayload.before : null
        const after = typeof todoPayload.after === 'string' ? todoPayload.after : ''
        const append = String(todoPayload.mode ?? 'replace') === 'append'
        const beforeText = before && before.trim() ? `旧文「${truncate(before, 60)}」` : '（原先没有描述）'
        out.push({
          at: e.createdAt,
          actor: e.actor ?? '未记录',
          kind: '改描述',
          what: append
            ? `${actorLabel(e.actor)} 追加了描述正文（+${after.length} 字）：「${truncate(after, 80)}」`
            : `${actorLabel(e.actor)} 覆写了描述正文：${beforeText} → 新文「${truncate(after, 80)}」（旧文整篇仍在事件里，可取回）`
        })
        continue
      }
    }

    const p = (e.payload ?? {}) as Record<string, unknown>
    switch (e.type) {
      case 'comment_deleted': {
        const c = (p.comment ?? {}) as Record<string, unknown>
        const body = typeof c.body === 'string' ? c.body : ''
        const author = typeof c.authorId === 'string' ? c.authorId : String(c.authorType ?? '?')
        const n = Number(p.cascadedReplies ?? 0)
        out.push({
          at: e.createdAt,
          actor: e.actor ?? '未记录',
          kind: '删评论',
          what:
            `${actorLabel(e.actor)} 删掉了 ${author} 的一条评论：「${truncate(body, 80)}」` +
            (n > 0 ? `（连带清掉 ${n} 条回复）` : '')
        })
        break
      }
      case 'todo_deleted': {
        const s = (p.snapshot ?? {}) as Record<string, unknown>
        const title = typeof s.title === 'string' ? s.title : todoId
        out.push({
          at: e.createdAt,
          actor: e.actor ?? '未记录',
          kind: '删事项',
          what: `${actorLabel(e.actor)} 删掉了这条事项（当时标题「${truncate(title, 60)}」，状态 ${statusLabel(s.status)}）`
        })
        break
      }
      case 'description_overwritten': {
        out.push({
          at: e.createdAt,
          actor: e.actor ?? '未记录',
          kind: '改描述',
          what: `${actorLabel(e.actor)} 覆写了描述正文（旧文本已存进事件，可从这里取回）`
        })
        break
      }
      default:
        // 不认识的事件照原样列出，不静默丢掉 —— 漏掉一条就等于"没留痕"
        out.push({
          at: e.createdAt,
          actor: e.actor ?? '未记录',
          kind: e.type,
          what: `${actorLabel(e.actor)} · ${e.type}`
        })
    }
  }
  return out
}

/**
 * 把「审计线」与「流转线」合并成一条时序（1.0.62，给界面用）
 *
 * ── 为什么是合并而不是并列两块 ──
 *
 * 两者是**互补**的，不是重复的：
 * - events（审计）回答「内容被改成什么了 / 什么东西被删了」——只覆盖**会丢东西**的动作
 * - todo_transitions 回答「状态怎么变的、谁推的」——只覆盖状态变更
 *
 * 分两块并列，人要在脑子里做一次归并才看得懂"先改规格、再推验收、又被退回"
 * 这条真实的因果。合并成一条时间线，因果关系是**读出来的**，不是推出来的。
 *
 * ⚠️ 排序：整体按 `created_at` 升序。**同一毫秒时审计在前、流转在后** ——
 * 这是确定的约定，不随 sort 实现漂。展示层照 `timelineSeq` 渲染即可，
 * 不要自己按 `at` 重排（同一毫秒的先后会被打乱）。
 */
export function mergeTimeline(
  auditLines: readonly TodoAuditLine[],
  transitions: readonly {
    fromStatus: string | null
    toStatus: string
    actor: string | null
    createdAt: string
    /** 1.0.72：这次「待验收 → 进行中」是不是驳回；老数据为 null（未记录） */
    isRejection?: boolean | null
  }[]
): TimelineEntry[] {
  const merged: TodoAuditLine[] = [
    // 注意：这个数组的**入列顺序不代表最终顺序** —— 下面的排序会重排。
    // 审计线本身是「新→旧」（`listForTodo` 给的是最近发生了什么），
    // 流转线是「旧→新」，两者方向相反，所以谁也不能靠输入顺序占便宜。
    ...auditLines,
    ...transitions.map((t) => ({
      at: t.createdAt,
      actor: t.actor ?? '',
      kind: '流转',
      /**
       * 驳回要说人话"驳回"，不能沿用"把状态从 A 推到 B"（1.0.72）。
       *
       * ⚠️ 此前这处与动态（`TimelineView`）**都**说"推到" ——
       * 而"从待验收推到进行中"这句话里，"被裁决了"这个事实被磨平了，
       * 于是驳回与执行方自己收回重开读起来一模一样。
       *
       * 判据只用 `isRejection === true`：`null`（老数据未记录）**不**说成驳回，
       * 因为"不知道"不是"是"。缺失与否定不是一回事。
       */
      what:
        t.isRejection === true
          ? `${actorLabel(t.actor)} 驳回了这条（验收未通过，退回「${statusLabel(t.toStatus)}」）`
          : `${actorLabel(t.actor)} 把状态从「${t.fromStatus ? statusLabel(t.fromStatus) : '新建'}」推到「${statusLabel(t.toStatus)}」`
    }))
  ]

  // 单步流转也合并进来（**不做减法**）：过滤与否是展示层的取舍 ——
  // 详情抽屉原口径是"只保留一步时不渲染"。翻译层要是替它减了，
  // 展示层想改口径就得回头改翻译，判据又变成两份。
  const auditCount = auditLines.length

  return merged
    .map((line, i) => ({
      line,
      // 审计线是「新→旧」（给的是最近发生了什么），把下标翻转成正序 ——
      // 否则同毫秒同 rank 的两条审计事件会用 `a.i - b.i` 保持"新的在前"，
      // 方向又反了。流转线本来就是正序，不翻。
      i: i < auditCount ? auditCount - 1 - i : i
    }))
    .sort((a, b) => {
      const ta = Date.parse(a.line.at)
      const tb = Date.parse(b.line.at)
      if (Number.isNaN(ta) || Number.isNaN(tb)) return a.i - b.i

      // 同一毫秒不能交给「输入顺序」决定（两个来源方向相反，会随实现漂）。
      // 显式约定：审计在前、流转在后 —— 同一瞬间先说"内容变成了什么"，
      // 再说"状态怎么变的"。
      if (ta === tb) {
        const ra = a.line.kind === '流转' ? 1 : 0
        const rb = b.line.kind === '流转' ? 1 : 0
        if (ra !== rb) return ra - rb
        return a.i - b.i
      }
      return ta - tb
    })
    .map(({ line }, seq) => ({ ...line, timelineSeq: seq }))
}

/** 动作人显示：未记录时不猜是谁（与动态视图同一口径） */
function actorLabel(actor: string | null): string {
  return actor && actor.trim() ? actor : '未记录'
}

/** 状态码 → 中文；认不出就原样给，别静默吞 */
function statusLabel(status: unknown): string {
  const s = typeof status === 'string' ? status : ''
  return STATUS_LABELS[s] ?? (s || '?')
}

/** 审计文本里的正文只给摘要：完整内容仍在事件里，列表要给的是"删的是哪条" */
function truncate(s: string, n: number): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > n ? `${flat.slice(0, n)}…` : flat
}
