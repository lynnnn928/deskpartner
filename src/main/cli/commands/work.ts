/**
 * `work next` —— 回答"我现在该动什么"（卡 `ce43b4ba`）
 *
 * ## 为什么要有这条命令
 *
 * 独立验收（`1b176fcb`）§4 的原话："从 75 条命令里没有任何入口回答'我现在该动什么'。
 * 每轮开工我要自己拼 inbox → project list → 按项目拉状态 → 逐张读判据。
 * **一个陌生 agent 第一次接手会在这里停住**：它不知道该干什么，只能等指令。"
 *
 * 能力其实都在（`todo inbox` / `todo list` / `todo get`），缺的是**按身份排好的那一份**。
 * 这条命令只**读**：不改状态、不领活、不替人拍板 —— 它给的是"下一步"，不是"代你走"。
 *
 * ## 判据（可静态看，也可实跑）
 *
 * - **按主体**：agent 看到的是"等你验收 / 你进行中 / 指派给你 / 可领 / 等人 / 挂起"；
 *   人看到的是"等你拍板 / 等你验收 / 等 agent"—— 同一份数据，责任不同。
 * - **不越权**：候选池（proposed）对 agent 永远进 `waiting`，不进 `recommend`
 *   （G4 只许人挪走，推荐给你等于教你去撞关口）。
 * - **自报体量**：`budget` 里写明上界与本次字节数；超了从最不紧急的一类尾部丢，
 *   并给 `nextSteps` 指路 —— 不静默截断，也不硬塞。
 * - **不猜**：拿不准"未指派"算不算你的，就单列 `available`（可领），不混进 `recommend`。
 *
 * ## 与 `caa0d1c1` 的关系
 *
 * 体量判据只此一份（`../response-budget.ts`），两卡共用；`project get` 那边接的是
 * 同一个 `fitToBudget`，不另写一套 20KB。
 */

import { NotFoundError, UsageError } from '../../lib/domain-errors'
import type { Todo } from '../../../renderer/types/todo'
import { LIMIT_ZERO_DOC, parseLimit } from '../command-text'
import { actorOf } from '../command-core'
import type { CommandSpec } from '../command-core'
import { FIRST_READ_BUDGET_BYTES, fitToBudget, measureJsonBytes } from '../response-budget'

/** 每类默认最多给几条（再往上读用 `todo list`，别把首读撑爆） */
const DEFAULT_PER_BUCKET = 3

/**
 * 写回 `budget.bytes` 会让 payload 长出几位数字 —— 拟合时先留出这点余量，
 * 保证**最终**序列化后的字节数仍在上界内（判据是"不超过"，不是"差不多"）。
 */
const WRITE_BACK_HEADROOM_BYTES = 64

const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 }

export interface WorkItem {
  todoId: string
  title: string
  status: Todo['status']
  priority: Todo['priority']
  projectName: string | null
  dueAt: string | null
  /** 为什么给你看它（一句话，不写机制词） */
  why: string
  /** 具体下一步命令 */
  nextStep: string
}

/** 执行者：没显式指派 = 提出即执行（与数据层 `attributedExecutor` 同一口径） */
function executorOf(todo: Todo): string {
  return todo.executedBy ?? todo.createdBy
}

/**
 * 排序：优先级 → 截止时间近的 → 最近改动 → id。
 *
 * 最后一档用 id 而不是"保持原序"：同一毫秒改动的两条要有稳定次序，
 * 否则同一份数据两次调用给出不同顺序，调用方会以为数据变了。
 */
function workOrder(a: Todo, b: Todo): number {
  const pa = PRIORITY_RANK[a.priority] ?? 9
  const pb = PRIORITY_RANK[b.priority] ?? 9
  if (pa !== pb) return pa - pb
  const da = a.dueAt ? Date.parse(a.dueAt) : Number.MAX_SAFE_INTEGER
  const db = b.dueAt ? Date.parse(b.dueAt) : Number.MAX_SAFE_INTEGER
  if (da !== db) return da - db
  if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1
  return a.id < b.id ? -1 : 1
}

function toItem(
  todo: Todo,
  why: string,
  nextStep: string,
  projectNames: Map<string, string>
): WorkItem {
  return {
    todoId: todo.id,
    title: todo.title,
    status: todo.status,
    priority: todo.priority,
    projectName: todo.projectId ? (projectNames.get(todo.projectId) ?? null) : null,
    dueAt: todo.dueAt,
    why,
    nextStep
  }
}

function take(list: WorkItem[], count: number): WorkItem[] {
  return count > 0 ? list.slice(0, count) : list
}

export const workCommands: CommandSpec[] = [
  {
    name: 'work next',
    dataShape: 'object',
    readOnly: true,
    desc:
      '回答「我现在该动什么」：按你的身份排——等你验收 / 你进行中 / 指派给你 / 可领 / 等人 / 挂起；' +
      '只读，不改数据，回执自报体量上界',
    args: [
      { flag: '--project', type: 'string', desc: '只看某个项目（完整名称或 id）' },
      { flag: '--limit', type: 'string', desc: `每类最多几条（默认 ${DEFAULT_PER_BUCKET}）；${LIMIT_ZERO_DOC}` }
    ],
    run: (ctx, flags) => {
      const subject = actorOf(ctx)
      const isHuman = subject === 'human'
      const perBucket = parseLimit(flags['--limit'], 'work next') ?? DEFAULT_PER_BUCKET

      const projects = ctx.deps.projectRepo.list()
      const projectNames = new Map(projects.map((p) => [p.id, p.name]))
      const rawProject = flags['--project'] === undefined ? null : String(flags['--project']).trim()
      let projectId: string | null = null
      if (rawProject) {
        const hit = projects.find((p) => p.id === rawProject || p.name === rawProject)
        if (hit) {
          projectId = hit.id
        } else {
          try {
            projectId = ctx.deps.projectRepo.resolveId(rawProject)
          } catch (err) {
            if (err instanceof UsageError) throw err
            throw new NotFoundError(
              `项目不存在：${rawProject}（已有：${projects.map((p) => p.name).join(' / ') || '无'}）`
            )
          }
        }
      }

      const archivedProjectIds = new Set(projects.filter((p) => p.archived).map((p) => p.id))
      const open = ctx.deps.todoRepo
        .list()
        .filter((t) => t.status !== 'done' && t.status !== 'discarded')
        .filter((t) =>
          projectId ? t.projectId === projectId : !t.projectId || !archivedProjectIds.has(t.projectId)
        )
        .sort(workOrder)

      /**
       * 分桶规则（每一条都能在回执里看出"为什么给我看"）：
       *
       * - 验收：`awaiting_review` 且**验收者是我、执行者不是我**（运动员不当裁判）
       * - 继续：`in_progress` 且执行者是我
       * - 指派：`todo` 且执行者是我
       * - 可领：`todo` 且**没有显式执行者**、也不是我提的（单列，不混进"该动"）
       * - 等人：`proposed`（agent 不能动 —— 进了 recommend 等于教人撞 G4）
       * - 挂起：`suspended`，且跟我有关系（我提的或我做）
       */
      const verifyQueue: WorkItem[] = []
      const continueQueue: WorkItem[] = []
      const assignedQueue: WorkItem[] = []
      const available: WorkItem[] = []
      const waiting: WorkItem[] = []
      const blocked: WorkItem[] = []

      for (const t of open) {
        const executor = executorOf(t)
        const mine = executor === subject
        const short = t.id.slice(0, 8)

        if (isHuman) {
          if (t.status === 'proposed') {
            verifyQueue.push(
              toItem(t, '候选池：等你拍板（不拍就一直在列里）', `todo update ${short} --status todo`, projectNames)
            )
            continue
          }
          if (t.status === 'awaiting_review' && t.verifier === 'human') {
            continueQueue.push(
              toItem(t, '已交付，等你验收', `todo get ${short}（看结论后 todo done ${short}）`, projectNames)
            )
            continue
          }
          if (t.status === 'in_progress' && mine) {
            continueQueue.push(toItem(t, '进行中，指派给你', `todo get ${short}`, projectNames))
            continue
          }
          if (t.status === 'todo' && mine) {
            assignedQueue.push(toItem(t, '待办，指派给你', `todo get ${short}`, projectNames))
            continue
          }
          if (t.status === 'awaiting_review' && t.verifier !== 'human') {
            waiting.push(toItem(t, `等 ${t.verifier} 验收`, `todo get ${short}`, projectNames))
            continue
          }
          if (t.status === 'suspended' && (mine || t.createdBy === 'human')) {
            blocked.push(toItem(t, '挂起：等外部输入', `todo get ${short}`, projectNames))
          }
          continue
        }

        if (t.status === 'awaiting_review' && t.verifier === subject && executor !== subject) {
          verifyQueue.push(
            toItem(
              t,
              '别人做完了，等你验收',
              `todo get ${short}；通过 todo done ${short}，不通过 todo reject ${short} --reason "…"`,
              projectNames
            )
          )
          continue
        }
        if (t.status === 'in_progress' && mine) {
          continueQueue.push(toItem(t, '进行中，指派给你', `todo get ${short}`, projectNames))
          continue
        }
        if (t.status === 'todo' && mine) {
          assignedQueue.push(toItem(t, '待办，指派给你', `todo get ${short}`, projectNames))
          continue
        }
        if (t.status === 'todo' && !t.executedBy && t.createdBy !== subject) {
          available.push(
            toItem(t, '未指派：想接就领走', `todo update ${short} --executed-by ${subject}`, projectNames)
          )
          continue
        }
        if (t.status === 'awaiting_review' && executor === subject && t.verifier !== subject) {
          // 你做完了、还在等别人验收：不是"该动"，但你要知道它在等谁
          waiting.push(toItem(t, `等 ${t.verifier} 验收`, `todo get ${short}`, projectNames))
          continue
        }
        if (t.status === 'proposed') {
          waiting.push(toItem(t, '候选池：等人拍板，你动不了', `todo get ${short}`, projectNames))
          continue
        }
        if (t.status === 'suspended' && (mine || t.createdBy === subject)) {
          blocked.push(toItem(t, '挂起：等外部输入', `todo get ${short}`, projectNames))
        }
      }

      /**
       * 动作类型优先于优先级：**别人卡在你这一步**（验收 / 拍板）比"我有件急事"更该先看。
       * 组内仍按优先级 → 截止 → 更新 → id 排（`workOrder`）。
       */
      const recommend = [...verifyQueue, ...continueQueue, ...assignedQueue]
      const now = Date.now()
      const counts = {
        open: open.length,
        mine: open.filter((t) => executorOf(t) === subject).length,
        overdue: open.filter((t) => t.dueAt && Date.parse(t.dueAt) < now).length,
        proposed: open.filter((t) => t.status === 'proposed').length,
        awaitingReview: open.filter((t) => t.status === 'awaiting_review').length,
        /** 各类**匹配**多少条（回执只回前若干条时，据此知道还有多少） */
        recommend: recommend.length,
        available: available.length,
        waiting: waiting.length,
        blocked: blocked.length
      }

      const buckets = {
        recommend: take(recommend, perBucket),
        available: take(available, perBucket),
        waiting: take(waiting, perBucket),
        blocked: take(blocked, perBucket)
      }
      /** 按类截断也要说（`--limit` 的收窄与预算的收窄是两件事，都不能静默） */
      const cutByLimit =
        perBucket > 0 &&
        (recommend.length > perBucket ||
          available.length > perBucket ||
          waiting.length > perBucket ||
          blocked.length > perBucket)

      /** 从最不紧急的一类开始丢（可领 → 挂起 → 等人 → 该动），每类从尾部丢 */
      const dropOrder = ['available', 'blocked', 'waiting', 'recommend'] as const
      const targetProjects = projects.filter((p) => !p.archived && (!projectId || p.id === projectId))
      const staleHandoffProjects = targetProjects
        .filter((p) => {
          if (!p.handoffMarkdown?.trim()) return false
          const state = ctx.deps.projectRepo.getHandoffState(p.id, { version: ctx.meta.version })
          return state.freshness.state !== 'fresh'
        })
        .map((p) => p.name)

      const droppable =
        buckets.recommend.length + buckets.available.length + buckets.waiting.length + buckets.blocked.length

      const assemble = (dropped: number) => {
        let left = dropped
        const kept = {
          recommend: buckets.recommend,
          available: buckets.available,
          waiting: buckets.waiting,
          blocked: buckets.blocked
        }
        const out: typeof kept = { ...kept }
        for (const key of dropOrder) {
          const list = kept[key]
          const drop = Math.min(left, list.length)
          out[key] = drop > 0 ? list.slice(0, list.length - drop) : list
          left -= drop
        }
        /**
         * 引子放在第一步（卡 `cb7924c2`，1.0.133）：下面每一条都是 **DeskPartner CLI 的子命令**，
         * 而本机没有 `dp` 这个词（产品不写用户 PATH，`2cc71a13`）。
         * 原先每条都写成 `dp todo …` —— 照抄就是一条跑不通的命令。
         * 一句话说清怎么执行，比在十条里各写一遍调用方式省得多。
         */
        const nextSteps: string[] = [
          '下列是 DeskPartner CLI 的子命令（本机没有 `dp` 这条命令）：命令行用 `node "$DESKPARTNER_CLI" <子命令>` 执行，MCP 用同名工具'
        ]
        const first = out.recommend[0]
        if (first) {
          nextSteps.push(first.nextStep)
        } else {
          nextSteps.push(
            isHuman
              ? 'todo list --status proposed --limit 20（看有没有等你拍板的）'
              : `todo list --executed-by ${subject} --status in_progress --limit 20`
          )
        }
        if (out.available[0]) {
          nextSteps.push(`领一件：todo update ${out.available[0].todoId.slice(0, 8)} --executed-by ${subject}`)
        }
        if (out.waiting.length > 0 && !isHuman) {
          nextSteps.push('todo list --status proposed --limit 20（等人的那批：别替人拍板）')
        }
        if (staleHandoffProjects.length > 0) {
          const firstProj = staleHandoffProjects[0]
          nextSteps.push(
            isHuman
              ? `接手说明待复核（${staleHandoffProjects.join(' / ')}）：project get "${firstProj}" 或去审批页处理提议`
              : `接手说明待更新（${staleHandoffProjects.join(' / ')}）：本轮收尾时跑 project handoff-propose "${firstProj}" --body-file <文件>`
          )
        }
                nextSteps.push(
          'skill core（状态关口与收口纪律；不确定就留在原地等）：' +
            'MCP 调 `get_guide` 的 core 主题，命令行跑 `node "$DESKPARTNER_CLI" skill core`'
        )

        const humanUnreadMemos = (() => {
          try {
            const allMemos = ctx.deps.memoRepo?.list?.() ?? []
            return allMemos
              .filter((m) => m.status === 'unread' && m.recipient === 'human')
              .slice(0, perBucket > 0 ? perBucket : 10)
              .map((m) => ({
                id: m.id,
                from: m.author,
                linkedTodoId: m.linkedTodoId ?? null,
                text: m.text.slice(0, 120),
                createdAt: m.createdAt
              }))
          } catch {
            return []
          }
        })()
        const pendingProposals = (() => {
          try {
            const profile = ctx.deps.profileRepo?.listProposals?.('pending')?.length ?? 0
            const protocol = ctx.deps.protocolRepo?.listProposals?.('pending')?.length ?? 0
            const rules = ctx.deps.rulesRepo?.listProposals?.('pending')?.length ?? 0
            const handoff = ctx.deps.projectRepo?.listHandoffProposals?.('pending')?.length ?? 0
            return {
              total: profile + protocol + rules + handoff,
              profile,
              protocol,
              rules,
              handoff
            }
          } catch {
            return { total: 0, profile: 0, protocol: 0, rules: 0, handoff: 0 }
          }
        })()
        const waitingForHuman = {
          unreadMemos: humanUnreadMemos,
          pendingProposals,
          proposedTodos: counts.proposed,
          awaitingHumanReviewTodos: open.filter((t) => t.status === 'awaiting_review' && t.verifier === 'human').length,
          assignedToHumanTodos: open.filter((t) => (t.status === 'todo' || t.status === 'in_progress') && executorOf(t) === 'human').length
        }

        return {
          subject,
          scope: { project: projectId ? (projectNames.get(projectId) ?? null) : null },
          counts,
          waitingForHuman,
          recommend: out.recommend,
          available: out.available,
          waiting: out.waiting,
          blocked: out.blocked,
          nextSteps,
          budget: {
            limitBytes: FIRST_READ_BUDGET_BYTES,
            bytes: 0,
            dropped,
            truncated: dropped > 0 || cutByLimit,
            overBudget: false
          }
        }
      }

      /**
       * 拟合时先扣掉写回 `bytes` 的余量：`fitToBudget` 量的是 `bytes: 0` 的那一版，
       * 真正回填之后 payload 会长几位数字 —— 不扣余量就可能"声明 ≤ 20KB、实际 20.02KB"。
       */
      const fit = fitToBudget(FIRST_READ_BUDGET_BYTES - WRITE_BACK_HEADROOM_BYTES, droppable, assemble)
      const payload = assemble(fit.dropped)
      payload.budget.bytes = fit.bytes
      // 回填真实字节数后再量一次：报的必须是**这份回执**的大小，不是估计
      payload.budget.bytes = measureJsonBytes(payload)
      payload.budget.overBudget = measureJsonBytes(payload) > FIRST_READ_BUDGET_BYTES
      if (payload.budget.truncated) {
        /**
         * 两种截断要说清是哪一种：**按条数收窄**（--limit）与**按预算丢条目**（数据太大）
         * 对调用方的含义不同 —— 前者翻页就能拿全，后者要先缩小查询范围。
         */
        payload.nextSteps.push(
          payload.budget.dropped > 0
            ? `本次因体量预算丢了 ${payload.budget.dropped} 条（上限 ${FIRST_READ_BUDGET_BYTES} 字节）；先按项目或状态收窄，再读`
            : `本次每类只回前 ${perBucket} 条；要更多用 todo list --limit 50 或 --offset 翻页`
        )
      }
      return payload
    }
  }
]
