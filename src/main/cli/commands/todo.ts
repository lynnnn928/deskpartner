/**
 * 事项命令（1.0.112 域切，卡 d1b71d28）
 *
 * 从 `command-table.ts` 里**整块搬来**的，条目逐字节未改 —— 参数声明与 `run` 都在
 * 这里，`schema` 直接序列化它（接口文档不可能与实现脱节）。
 *
 * ⚠️ 数组**顺序是外部契约**的一部分：`dp help` 的排列、`dp schema` 的命令清单、
 * MCP `tools/list` 的工具顺序都由 `command-table.ts` 里那张表的顺序决定。
 *
 * ⚠️ 为什么这个文件导出**多段**：原表里它们被别的域隔开（不是按域连续排的），
 *    而顺序不能改。各段在 `command-table.ts` 的聚合处按原次序展开：
 *      · todoInboxCommands
 *      · todoCommands
 *      · todoOwnerCommands
 */

import type { UpdateTodoInput } from '../../../renderer/types/todo'
import type { TodoOwner } from '../../../renderer/types/todo'
import type { TodoPriority, TodoStatus, TodoType } from '../../../renderer/types/enums'
import { getDatabase } from '../../database/index'
import { NotFoundError, UsageError } from '../../lib/domain-errors'
import { buildDescChangeEvent } from '../../lib/desc-audit'
import { CLOSURE_SECTION } from '../../database/closure-structure'
import { buildTodoAudit } from '../../lib/audit-text'
import { FILTER_STATUSES, LIMIT_ZERO_DOC, LIST_DESC_PREVIEW_CHARS, OPEN_STATUSES, PRIORITIES, STATUSES, TODO_LIST_DEFAULT_LIMIT, TYPES, isDescriptionTruncated, parseLimit, parseOffset, summarizeDescription, takeLimit, todosForExecutor } from '../command-text'
import { AWAITING_REVIEW_COMMENT_HINT, AWAITING_REVIEW_HINT, DESC_SHRINK_HINT, DONE_HINT, actorOf, assertCreatedByNotImpersonating, assertNoLauncherOnlyFlags, assertRegisteredActor, assertValidTitle, commentDeleteRisk, missingClosure, parseTime, proposedDescNotice, resolveActor, resolveCreatedBy, resolveProjectForWrite, riskOf, strValue } from '../command-core'
import type { CommandSpec } from '../command-core'
import { normalizeGrantArgv } from '../command-table'

export const todoInboxCommands: CommandSpec[] = [
  {
    /**
     * 我的 inbox：哪些事在等我回应（1.0.68，`b097ca99` 的「叫醒」查询面）
     *
     * ## 为什么是独立命令而不是 `todo list --to-me`
     *
     * 三种"等我"是**不同的东西**，混在一个筛选里会得出"没有等我"这种假结论：
     * - 哪些事**指派给我做** → `todo list --executed-by`（1.0.62 就有）
     * - 哪些**纸条**递给我 → `memo list --to-me`（1.0.68 刚加）
     * - 哪些**评论 @ 了我** → **本命令**（三者里唯一"点名要我回应"的）
     *
     * 提单原话：「投递（pull）已有但坏了；叫醒（push）确实没有。」
     * 而 push 的查询面此前是**空的** —— 就算 `comment --to` 能写，也没人查得到。
     *
     * ## 为什么要有 `--replied-only`
     *
     * 默认给"全部 @ 过我的"；带 `--replied-only` 只给
     * **"我还没回过"的** —— 那是每轮开工该看的清单。
     */
    name: 'todo inbox',
    dataShape: 'object',
    readOnly: true,
    desc: '哪些事在等我回应：评论 @ 了我的（= 有人在那条评论上留话等我接）',
    args: [
      {
        flag: '--replied-only',
        type: 'boolean',
        desc: '只要**我还没回过**的（每轮开工该看的清单）'
      },
      {
        flag: '--limit',
        type: 'string',
        desc: `最多几条（不传 = 全部）；${LIMIT_ZERO_DOC}`
      },
      {
        flag: '--offset',
        type: 'string',
        desc:
          '分页偏移（默认 0）；上一个回执里的 `nextOffset` 就是这一页该传的值。' +
          '与 `--limit` 配对翻页：`truncated:true` 就说明这一页之后还有'
      }
    ],
    run: (ctx, flags) => {
      const me = actorOf(ctx)
      const repo = ctx.deps.commentRepo
      let rows = repo.listWaitingFor(me, { repliedOnly: flags['--replied-only'] === true })

      const total = rows.length
      const limit = parseLimit(flags['--limit'], 'todo inbox') ?? 0
      /**
       * 分页（1.0.109，修 `7f21841f`）：与 `todo list` 同一套读法 ——
       * 先定顺序（`listWaitingFor` 给的序），再切片；回执给 `returned` / `nextOffset`。
       *
       * 此前只有 `--limit`：截断时说得出"还有"，却说不出"下一批从哪开始"，
       * 于是"继续读取"只能靠放大窗口，或者靠"本页少于 limit 就到底"反推 ——
       * 后者在**恰好整除**时是错的（同族 `99be5ae7` 专门为它写过一条用例）。
       */
      const offset = parseOffset(flags['--offset'], 'todo inbox')
      if (offset > 0) rows = rows.slice(offset)
      rows = takeLimit(rows, limit)
      const returned = rows.length
      /** 截断 = **这一页之后还有**：被偏移吃掉的那部分不算"更多" */
      const truncated = offset + returned < total

      return {
        /** ⚠️ 旧字段，语义没变：命中数（截断前、偏移前的条数）。 */
        total,
        returned,
        truncated,
        nextOffset: truncated ? offset + returned : null,
        /**
         * ⚠️ `title` 在这里可能为空 —— 被 @ 的评论可能挂在一条已被删的事项上
         * （评论随事项 CASCADE 清理，但通知索引未必同步）。
         * **不编造标题**，空就是空。
         */
        items: rows.map((c) => {
          const t = ctx.deps.todoRepo.getById(c.todoId)
          return {
            commentId: c.id,
            todoId: c.todoId,
            todoTitle: t?.title ?? null,
            from: c.authorId,
            body: c.body,
            createdAt: c.createdAt,
            /** 我回过没有（本命令的核心判据） */
            repliedByMe: repo
              .listByTodo(c.todoId)
              .some((x) => x.parentId === c.id && x.authorId === me)
          }
        })
      }
    }
  },
  {
    name: 'todo comment',
    dataShape: 'object',
    desc: '在事项下发一条评论（不是改描述）。规格留在 description，往来都走评论',
    args: [
      {
        flag: '--body',
        type: 'string',
        desc: '评论正文'
      },
      {
        flag: '--body-file',
        type: 'string',
        desc: '从文件读评论正文（长文本/多行/含反引号 $ < 时必须走它；由启动器展开为 --body）'
      },
      {
        flag: '--reply-to',
        type: 'string',
        desc: '回复某条评论（传评论 id），形成楼中楼'
      },
      {
        flag: '--to',
        type: 'string',
        desc:
          '**@ 给某个 agent**（1.0.68，`b097ca99` 的「叫醒」）。' +
          '与 `--reply-to` **不是一回事**：那个是"我知道有这条才回它"，' +
          '这个是"**你在评论上留话，他被动能看到**"。不传 = 对着卡说，回应者自己看'
      }
    ],
    positional: { name: 'id', required: true, desc: '待办 ID（支持前缀）' },
    run: (ctx, flags, positional) => {
      const input = positional[0]
      if (!input) throw new UsageError('缺少待办 id')
      // 同 add/update：--body-file 由启动器展开为 --body，服务端收到即报错而非静默丢正文
      assertNoLauncherOnlyFlags(flags)
      const body = String(flags['--body'] ?? '').trim()
      if (!body) throw new UsageError('缺少 --body（评论正文不能为空）')

      const id = ctx.deps.todoRepo.resolveId(input)
      const todo = ctx.deps.todoRepo.getById(id)
      if (!todo) throw new NotFoundError(`待办不存在: ${id}`)

      const repo = ctx.deps.commentRepo
      const actor = actorOf(ctx)
      // 回复目标要校验归属：评论 id 存在但属于别的事项时，别让它挂错地方
      let parentId: string | null = null
      const replyTo = flags['--reply-to'] ? String(flags['--reply-to']).trim() : ''
      if (replyTo) {
        const all = repo.listByTodo(id)
        const hit = all.find((c) => c.id === replyTo || c.id.startsWith(replyTo))
        if (!hit) {
          throw new NotFoundError(`这条事项下找不到评论「${replyTo}」，无法回复`)
        }
        parentId = hit.id
      }

        const comment = repo.create({
          todoId: id,
          body,
          parentId,
          authorType: actor === 'human' ? 'human' : 'agent',
          authorId: actor,
          /** 给谁（1.0.68）—— @ 给某个 agent，他那边 `--to-me` 能查到 */
          recipient: flags['--to'] ? String(flags['--to']).trim() || null : null
        })

      const payload = {
        ok: true,
        commentId: comment.id,
        todoId: id,
        parentId: comment.parentId,
        author: actor,
        createdAt: comment.createdAt,
        commentCount: repo.countByTodo(id),
        message: '评论已写入。规格请改 description，往来都算评论 —— 这样详情页的规格卡才不会被追加内容冲乱。'
      }

      /**
       * G9（软提醒，1.0.63，收 4bdfe62a 方案1）
       *
       * 判据三条，缺一不可（详细理由见 AWAITING_REVIEW_COMMENT_HINT 的注释）：
       * ① 事项在「待验收」；② 发言者不是执行者（即他就是验收方）；③ 本次没改状态
       * —— `todo comment` 天然不改状态，所以第三条在这里恒成立，写出来是为了
       * 让下一个人在给别的命令复用这条判据时不会漏掉它。
       *
       * ⚠️ 执行者口径取 `executedBy ?? createdBy`（跨主体交付的定义，见 todo.repository）：
       * 只判 `executedBy` 会把"提出即执行"的卡漏成"执行者是 null"，
       * 于是执行方自己来补一句说明也会被提醒。
       */
      const executor = todo.executedBy ?? todo.createdBy
      const isReviewer = executor !== actor
      if (todo.status === 'awaiting_review' && isReviewer) {
        return { __notice: AWAITING_REVIEW_COMMENT_HINT, data: payload }
      }
      return payload
    }
  },
  {
    name: 'todo reject',
    dataShape: 'object',
    desc: '验收驳回：退回「进行中」并留下驳回理由（一条 reject 评论 + 一条通知）',
    args: [
      {
        flag: '--reason',
        type: 'string',
        desc: '哪里没做好 / 要改什么（驳回必须说清，否则执行方只能盲改）'
      }
    ],
    positional: { name: 'id', required: true, desc: '待办 ID（支持前缀）' },
    run: (ctx, flags, positional) => {
      const input = positional[0]
      if (!input) throw new UsageError('缺少待办 id')
      const reason = String(flags['--reason'] ?? '').trim()
      if (!reason) {
        throw new UsageError(
          '缺少 --reason。驳回必须写清"哪里没做好"，否则执行方收到退回也不知道改什么 —— ' +
            '这正是本功能要解决的问题。'
        )
      }

      const id = ctx.deps.todoRepo.resolveId(input)
      const todo = ctx.deps.todoRepo.getById(id)
      if (!todo) throw new NotFoundError(`待办不存在: ${id}`)
      if (todo.status !== 'awaiting_review') {
        throw new UsageError(
          `只有「待验收」的事项才能驳回（当前是 ${todo.status}）。驳回 = 验收不通过，` +
            '请确认这条已提交待验收。'
        )
      }

      const actor = actorOf(ctx)
      // 先落驳回评论，再走状态流转 —— 流转会写通知（meta.rejected），
      // 两边都留痕：通知告诉执行方"你有活被退回"，评论留下"为什么退回"。
      const comment = ctx.deps.commentRepo.create({
        todoId: id,
        body: reason,
        authorType: actor === 'human' ? 'human' : 'agent',
        authorId: actor,
        kind: 'reject'
      })

      const updated = ctx.deps.todoRepo.update({
        id,
        status: 'in_progress',
        actor
      })

      return {
        ok: true,
        todoId: id,
        status: updated.status,
        commentId: comment.id,
        reason,
        rejectedBy: actor,
        message: '已退回「进行中」并留下驳回理由。执行方下次跑写命令时，回执会提醒它有活被退回。'
      }
    }
  },
  {
    /**
     * 收口（`47d6ad52`，Bob建议②，主用户 10-06 拍板选②）
     *
     * ## 为什么要有这条命令
     *
     * Bob的实测：一次批量关 30 张卡，**G5 全部放行** —— 因为每张都有评论，
     * 但**其中一半当初只有一行字**。软提醒的判据太松（只查"有没有评论"），
     * 等于不校验；而要求评论必须含四个标记词，又会**逼出为过校验而写的空壳段落**。
     *
     * 这条走第三条路：**让"写全"比"不写"更省事**。
     * 四个入参由 CLI 组装成规范正文，agent 不需要自己组织语言，
     * 而正文天然是四段 —— 与「权限必须由机制强制，不由调用方自觉」同源。
     *
     * ⚠️ **它不是"绕过 G5 的后门"**：G5 仍然在（`todo update --status done`
     * 照样弹提醒），而 `todo close` 是**唯一能把四段一次写全**的路。
     * 我曾建议"顺便把 G5 判据升级为结构校验"，主用户当时先做了②这个增量（1.0.67）；
     * **1.0.110 补上了那一半**（收 `eec2e1e7`）：G5 的判据从"有没有评论"
     * 升级为"收口文本里有没有四段标记里的至少一个"。
     * 当初的顾虑是"要拦别人的路"—— 现在仍然**只提醒、不改退出码**，
     * 所以那道顾虑不成立；而 `todo close` 由此真的成了**最省事的那条路**：
     * 它写出去的四段天然带标记，不会被念。
     */
    name: 'todo close',
    dataShape: 'object',
    // 写档：它写一条评论 + 推状态。漏标会被 riskOf() 按"未标注 = 更严的一档"处理，
    // 但显式写出来才能让人在 --help / schema 里看见这一条要授权。
    risk: 'write',
    desc:
      '收口一件事：把「做了什么 / 验证过什么 / 什么算通过 / 取舍与遗留」四段一次写全并推进状态',
    args: [
      {
        flag: '--did',
        type: 'string',
        desc: '做了什么（必填）'
      },
      {
        flag: '--verified',
        type: 'string',
        desc: '怎么验证的：跑了哪条命令 / 看到什么现象（必填）'
      },
      {
        flag: '--pass-criteria',
        type: 'string',
        desc: '什么算通过：这次的目标是什么、达成到什么程度（必填）'
      },
      {
        flag: '--leftover',
        type: 'string',
        desc: '取舍与遗留：没做什么、留下的坑、后续谁接（可留空，但会提醒）'
      },
      {
        flag: '--notify',
        type: 'string',
        desc: '收口时显式指定提醒对象（如 human 或 agent:alice，多个用逗号分隔），向其投递未读备忘与收口通知'
      }
    ],
    positional: { name: 'id', required: true, desc: '待办 ID（支持前缀）' },
    run: (ctx, flags, positional) => {
      const input = positional[0]
      if (!input) throw new UsageError('缺少待办 id')

      /**
       * 三段必填、一段可选。
       *
       * ⚠️ 必填是**这套设计的核心**，不是省事：
       * Bob实测的病是"每张都有评论但只有一行字"，而软提醒拦不住那个。
       * 把三段做成必填，等于**让"写全"成为最短路径**而不是"额外的纪律"。
       */
      const did = String(flags['--did'] ?? '').trim()
      const verified = String(flags['--verified'] ?? '').trim()
      const passCriteria = String(flags['--pass-criteria'] ?? '').trim()
      const leftover = String(flags['--leftover'] ?? '').trim()

      const missing: string[] = []
      if (!did) missing.push('--did（做了什么）')
      if (!verified) missing.push('--verified（怎么验证的）')
      if (!passCriteria) missing.push('--pass-criteria（什么算通过）')
      if (missing.length) {
        throw new UsageError(
          `缺少必填：${missing.join('、')}\n` +
            '  收口就是"说清为什么算完了"。三段必填是为了让写全成为最短路径 —— ' +
            '否则会出现"每张都有评论、但只有一行字"（Bob实测 30 张里一半如此）。' +
            '\n  取舍与遗留（--leftover）可以留空，但留空会提醒。'
        )
      }

      const id = ctx.deps.todoRepo.resolveId(input)
      const todo = ctx.deps.todoRepo.getById(id)
      if (!todo) throw new NotFoundError(`待办不存在: ${id}`)

      const actor = actorOf(ctx)
      /** 收口评论与状态流转必须原子提交：守卫拒绝或任一步写入失败都回滚。 */
      /**
       * 四段标记取自 `CLOSURE_SECTION`（1.0.110，收 `eec2e1e7`）——
       * 与 G5 的判据、`closureByTodo` **同一个常量**。
       * 写出去的字与判进来的字分开写，改一处另一处就成了永远判不过。
       */
      const body = [
        `${CLOSURE_SECTION.did}${did}`,
        `${CLOSURE_SECTION.verified}${verified}`,
        `${CLOSURE_SECTION.passCriteria}${passCriteria}`,
        leftover
          ? `${CLOSURE_SECTION.leftover}${leftover}`
          : `${CLOSURE_SECTION.leftover}（未填）`
      ].join('\n')

      /**
       * 卡 `52cd076c`：验收收口后执行方零通知 —— 写在 `--leftover` 里的交办不能沉入已完成的死卡。
       * 当 `--leftover` 非空、且事项执行方（`executedBy ?? createdBy`）不等于收口人 `actor` 时：
       * 1）收口评论的 `recipient` 指向执行方（`todo inbox` 当场可见）；
       * 2）向执行方投递一条关联该事项的未读备忘（`memo list --to-me --unread-only` 可见，且支持 `--reply-to` 同线程回复结清）；
       * 3）写入一条给执行方的 `review` 通知（`notification list --to-me` 与 GUI 通知中心按项目可查）。
       */
      const rawNotify = flags['--notify'] !== undefined ? String(flags['--notify']).trim() : ''
      if (flags['--notify'] !== undefined && !rawNotify) {
        throw new UsageError('--notify 不能为空（请传 human 或 agent:<id>，多个用逗号分隔）')
      }
      const explicitTargets = rawNotify
        ? rawNotify
            .split(',')
            .map((x) => x.trim())
            .filter(Boolean)
        : []
      for (const target of explicitTargets) {
        if (target !== 'human' && !/^agent:[a-z0-9][a-z0-9_-]*$/i.test(target)) {
          throw new UsageError(`--notify 目标格式非法：${target}（应为 human 或 agent:<id>）`)
        }
      }

      const executor = (todo.executedBy ?? todo.createdBy ?? '').trim()
      const cleanedLeftover = leftover.replace(/^[（(]|[）)。.!！~～；;，,\s]+$/g, '').trim()
      const hasActionableLeftover = cleanedLeftover.length > 0 && !/^(无|没有|暂无|无遗留|无风险|无风险与遗留|同上|未填|none|n\/a|nil|-|—)$/i.test(cleanedLeftover)
      const leftoverTarget = hasActionableLeftover && executor && executor !== actor ? executor : null
      const notifyTargets = Array.from(
        new Set([
          ...(leftoverTarget ? [leftoverTarget] : []),
          ...explicitTargets.filter((t) => t !== actor)
        ])
      )
      const commentRecipient = explicitTargets[0] ?? leftoverTarget ?? null

      const { comment, updated, leftoverMemoId, notifiedMemoIds } = getDatabase().transaction(() => {
        const comment = ctx.deps.commentRepo.create({
          todoId: id,
          body,
          authorType: actor === 'human' ? 'human' : 'agent',
          authorId: actor,
          kind: 'comment',
          recipient: commentRecipient
        })
        const updated = ctx.deps.todoRepo.update({
          id,
          status: 'done',
          actor,
          preApprovedGrantId: ctx.preApprovedGrantId
        })
        let leftoverMemoId: string | null = null
        const notifiedMemoIds: string[] = []
        const noteText = leftover || did
        for (const target of notifyTargets) {
          if (typeof ctx.deps.memoRepo?.create === 'function') {
            const memo = ctx.deps.memoRepo.create({
              author: actor,
              recipient: target,
              linkedTodoId: id,
              text: `【验收收口遗留 #${id.slice(0, 8)}《${todo.title}》】${noteText}`
            })
            if (memo?.id) {
              notifiedMemoIds.push(memo.id)
              if (target === leftoverTarget) leftoverMemoId = memo.id
            }
          }
          if (explicitTargets.includes(target) && target !== executor && typeof ctx.deps.notificationRepo?.create === 'function') {
            ctx.deps.notificationRepo.create({
              type: 'review',
              title: `验收收口待办提醒：${todo.title}`,
              summary: `${actor} 在 #${id.slice(0, 8)} 收口时点名提醒你：${noteText}`,
              refId: id,
              actor,
              recipient: target
            })
          }
        }
        if (!leftoverMemoId && notifiedMemoIds.length > 0) {
          leftoverMemoId = notifiedMemoIds[0]
        }
        return { comment, updated, leftoverMemoId, notifiedMemoIds }
      })()

      return {
        ok: true,
        __notice: leftover
          ? undefined
          : '未填「取舍与遗留」—— 没过的事没人知道会漏掉，收口的人自己知道不算数。',
        data: {
          todoId: id,
          status: updated.status,
          commentId: comment.id,
          ...(leftoverTarget ? { leftoverNotifiedTo: leftoverTarget, leftoverMemoId } : {}),
          ...(explicitTargets.length ? { notifiedTo: notifyTargets, notifiedMemoIds } : {}),
          message:
            '已写入四段收口结论并推进状态。' +
            '若这次是别人的活，确认你**不是执行者** —— 1.0.67 起验收按角色定权。'
        }
      }
    }
  },
  {
    name: 'todo delete-comment',
    dataShape: 'object',
    risk: 'write',
    dynamicRisk: commentDeleteRisk,
    desc:
      '删掉一条评论（错了就删，别用新评论掩盖）。回复它的子评论会一并删除；' +
      '删自己写的只要 --yes，删**别人写的**（尤其驳回理由）会转成删除档、需人点头',
    args: [
      {
        flag: '--yes',
        type: 'boolean',
        desc: '确认删除（必填）。与 todo rm 同一口径：CLI 不做交互式提问'
      }
    ],
    positional: { name: 'id', required: true, desc: '评论 ID（支持前缀）' },
    run: (ctx, flags, positional) => {
      const input = positional[0]
      if (!input) throw new UsageError('缺少评论 id')

      const repo = ctx.deps.commentRepo
      const hit = repo.resolveId(input)
      if (!hit) {
        throw new NotFoundError(
          `找不到评论「${input}」。先用 \`todo get <待办id>\` 看评论线程里的 id。`
        )
      }

      /**
       * `--yes` 是**自删的确认**（1.0.63 补，与其它删除命令同一口径）。
       *
       * 删别人写的评论走的是删除档：那条路径由**人的点头**充当确认 ——
       * 而放行它的是 `preApprovedGrantId`，**不是** `normalizeGrantArgv` 补 `--yes`
       * （那份名单只覆盖**静态**删除档；本条静态是 write，所以那条登记根本走不到，
       * 1.0.107 `b3fe692e` 已把它删掉、改由命令表推导）。
       * 所以这里不要求调用方自带 —— 否则 agent 在人点头之后重试仍会被拒。
       *
       * 但自删没有那一步点头，必须自己说清"我确认删"。此前这条命令
       * 既不认 `--yes`（传了会 usage_error）也不要求它，等于零摩擦删除。
       */
      if (!flags['--yes'] && !ctx.preApprovedGrantId) {
        throw new UsageError(
          '删除评论需要确认，请加 --yes（CLI 不会停下来问你）。' +
            '如果这条是别人写的（人或别的 agent），它会被转成删除档、需要用户点头 —— 那种情况下不用带 --yes。'
        )
      }

      /**
       * 删除留痕（1.0.55，主用户 2026-09-28 拍板 68c7ccc1 选②）
       *
       * 此前这条是**物理删除、零痕迹**，而同一版里 `--desc` 覆写有审计
       * （events 存 before/after）—— 同一种"改掉已写下的东西"，两种待遇。
       * 场景：agent 发过一条带承诺的评论（"我改成 B，代价是 C"），
       * 被删掉后重发一版口径不同的，事后无从对证。
       *
       * 留痕取"不加摩擦"：只把删除写进 events —— 谁删的、删了什么、
       * 连带删了哪些回复，都能查回来。
       *
       * ⚠️ 1.0.63 起事件的 payload 多带 `authorId`/`kind`：分级判据是作者归属，
       * 事后追查"这条被谁删的、原本是谁写的"必须能从同一份记录里读出来。
       */
      const all = repo.listByTodo(hit.todoId)
      const replies = all.filter((c) => c.parentId === hit.id)
      repo.remove(hit.id)
      ctx.deps.events.append('comment_deleted', actorOf(ctx) ?? 'unknown', {
        comment: hit,
        cascadedReplies: replies,
        /** 分级依据（1.0.63）：删的是不是自己写的、是不是驳回理由 */
        authorId: hit.authorId,
        kind: hit.kind,
        deletedBy: actorOf(ctx) ?? 'unknown'
      })

      return {
        ok: true,
        commentId: hit.id,
        todoId: hit.todoId,
        cascadedReplies: replies.length,
        commentCount: repo.countByTodo(hit.todoId),
        message:
          replies.length > 0
            ? `评论已删除，连带清掉 ${replies.length} 条回复。`
            : '评论已删除。'
      }
    }
  },
]

export const todoCommands: CommandSpec[] = [
  {
    name: 'todo add',
    dataShape: 'object',
    desc: '新建待办',
    args: [
      { flag: '--title', type: 'string', required: true, desc: '标题' },
      { flag: '--desc', type: 'string', desc: '详细描述（卡片上不展示）' },
      /**
       * `--desc-file` 由**启动器**读文件并展开成 `--desc`，服务端永远收不到它。
       * 在这里声明纯粹是为了**可发现性**：Bob复测报的「实现认它、契约不认它」——
       * `help todo add` 的参数表里看不到它，agent 不知道有这条路，只能靠口口相传。
       * 服务端多认一个收不到的 flag 是无害的（真收到了也只是描述不变）。
       */
      {
        flag: '--desc-file',
        type: 'string',
        desc: '从文件读取描述内容（等价于 --desc <文件内容>；由启动器展开为 --desc）。相对路径按当前工作目录解析；含反引号/尖括号/$ 的长文本用它可绕开 shell 吞字符'
      },
      { flag: '--priority', type: 'enum', enum: PRIORITIES, desc: '优先级，默认 normal' },
      {
        flag: '--due',
        type: 'string',
        desc: '截止时间，支持 ISO / today / tomorrow / +3d / 09-20 18:00'
      },
      {
        flag: '--remind',
        type: 'string',
        desc:
          '提醒时间，与 --due 同一套解析（ISO / today / tomorrow / +3d / 09-20 18:00）。' +
          '到点在界面上弹提醒 —— 此前只能界面点，agent 建不了带提醒的事项（Bob cc87b788 实测）'
      },
      {
        flag: '--category',
        type: 'string',
        desc: '标签名，支持多个用逗号分隔，如 "竞品调研,看板功能"'
      },
      {
        flag: '--project',
        type: 'string',
        required: true,
        desc:
          '项目名，**不存在会报错**（1.0.40 起；确要新建加 --create-project）。**必填**（1.0.37）—— ' +
          '项目是"这件事围绕什么在做"的维度，留空会让看板退化成一堆看不出归属的孤立动作；' +
          '先 `project list` 看已有项目'
      },
      {
        flag: '--create-project',
        type: 'boolean',
        desc: '项目名不存在时新建它。不加则报错并列出现有项目 —— 防错字静默分叉出新项目'
      },
      {
        flag: '--parent',
        type: 'string',
        desc: '父需求 id（父需求用 parent_id 自引用表达层级）'
      },
      {
        flag: '--fixed-in',
        type: 'string',
        desc:
          '登记「这条解决于哪个版本」。补录历史时用（如某个 1.0.5x 已修的 bug）。' +
          '一般不填 —— 正常姿势是做完推 awaiting_review，发版时统一标版本'
      },
      {
        flag: '--status',
        type: 'enum',
        enum: STATUSES,
        desc: '初始状态，默认 todo。向用户提议一件事时传 proposed；登记"已经做完的事"时传 done'
      },
      {
        flag: '--type',
        type: 'enum',
        enum: TYPES,
        desc: '事项类型，默认 task。报缺陷传 bug，提需求传 feature'
      },
      {
        flag: '--created-by',
        type: 'string',
        desc:
          '提出者。**默认取你的调用身份**（1.0.73 起）——' +
          '你持 agent 身份调用时不必再传；不带身份（人自己敲）仍是 human。' +
          '要**代录**（如替用户记一条）才显式传；' +
          '[!] 声明了身份时**不能填别的 agent**（会报 usage_error）：' +
          '要把活派出去请用 --executed-by，提出者仍记你自己'
      },
      {
        flag: '--executed-by',
        type: 'string',
        desc: '执行者，默认即提出者。agent 报 bug 给用户修这类"谁提出、别人去干"的场景才需要传'
      },
      {
        flag: '--verifier',
        type: 'string',
        desc:
          '验收者：谁判断这件事做完了、可以收口。默认即提出者。' +
          '**1.0.67 起按角色定权**：验收者 ≠ 执行者就能把「待验收」推到「已完成」，' +
          '不再一律等人在界面点（实测 7 张里 5 张卡在等人点，而人能验的只有界面/体验类）。' +
          '[!] 执行者不能验收自己做的事 —— 那样会被拒'
      },
      {
        flag: '--owner',
        type: 'string',
        desc: '（兼容别名）等价于 --created-by；建议改用 --created-by'
      }
    ],
    run: (ctx, flags) => {
      const title = String(flags['--title'] || '').trim()
      if (!title) throw new UsageError('--title 不能为空')
      assertValidTitle(title)

      const priority = flags['--priority']
      if (priority && !PRIORITIES.includes(priority as TodoPriority)) {
        throw new UsageError(
          `--priority 只接受 ${PRIORITIES.join('/')}，收到 ${String(priority)}`
        )
      }

      const status = flags['--status']
      if (status && !STATUSES.includes(status as TodoStatus)) {
        throw new UsageError(`--status 只接受 ${STATUSES.join('/')}，收到 ${String(status)}`)
      }

      /**
       * 保险：`--desc-file` 由**启动器**读文件并展开成 `--desc`，服务端不该收到它。
       *
       * 上一版正是漏了这条保险才出的事：为了 help 可发现性把它声明进 args 表后，
       * 服务端从"报未知 flag"变成"认识但不处理" —— batch 通道下**静默丢内容**
       * 却回 ok=true（Bob 7f48eb16 实测）。现在启动器已能展开 batch 里的它，
       * 这里再兜一道：真收到了就明确报错，不要再让任何路径悄悄降级。
       */
      assertNoLauncherOnlyFlags(flags)

      const type = flags['--type']
      if (type && !TYPES.includes(type as TodoType)) {
        throw new UsageError(`--type 只接受 ${TYPES.join('/')}，收到 ${String(type)}`)
      }

      /**
       * --owner 是 v12 前的旧参数名（彼时它混着"谁记的"和"该谁干"两层语义）。
       * 现在拆成 --created-by / --executed-by：--owner 只映射到提出者，
       * 并给一句软提醒 —— 不硬拦，旧脚本/旧习惯不该突然炸掉。
       */
      const ownerFlag = flags['--owner']
      const createdByFlag = flags['--created-by']
      if (ownerFlag !== undefined) {
        console.error(
          '[提醒] --owner 已拆分为 --created-by（提出者）与 --executed-by（执行者）；本次按 --created-by 处理'
        )
      }
      const createdBy = (createdByFlag ?? ownerFlag) as string | undefined
      const executedByFlag = flags['--executed-by']

      /**
       * G3（add 侧）：提议转正用 proposed；把新事项直接建成「待验收」
       * 没有过程可验收，属于误用 —— 拦下并指路。
       *
       * ⚠️ 与 `--status done` 的不一致是**故意的**，但也是最容易踩的坑：
       * done 能一步建（那是"记一笔已完成的工作流水"，是记录），
       * awaiting_review 不能（那是"请你验收"，是流转，得先有过程）。
       * agent 看到 done 能建容易直接类推到这里，所以报错里
       * **必须给出能照抄的两步命令**，只说"不行"会让人原地转圈。
       */
      if (status === 'awaiting_review') {
        throw new UsageError(
          '新建事项不能直接进入「待验收」—— 没有执行过程的事没什么可验收。' +
            '请先建一条：`todo add --title "..." --status todo`，' +
            '做完后推：`todo update <id> --status awaiting_review`，' +
            '再用 `todo comment <id> --body "完成 X；结论 Y"` 留下收口结论。'
        )
      }

      const cats = ctx.deps.categoryRepo.list()
      /**
       * 支持多值：逗号分隔。
       *
       * 一条待办常常同时关联多个方向（"调研 TAPD"既属于竞品调研、
       * 又是为看板功能做的），单值表达不了。
       */
      const catNames = String(flags['--category'] ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)

      /**
       * 分类不自动建（不像 --project），因为标签会爆炸：
       * agent 各建各的话「竞品调研/竞品分析/竞品研究」会同时出现。
       * 但不给提示的话 agent 就卡住了——所以报错里带上已有分类，
       * 让它自己决定是复用还是 `category add` 新建。
       */
      const categoryIds = catNames.map((name) => {
        const hit = cats.find((c) => c.name === name)
        if (!hit) {
          const available = cats.map((c) => c.name).join('、') || '（暂无分类）'
          throw new NotFoundError(
            `分类不存在: ${name}。已有分类：${available}。可复用，或先 category add 再建`
          )
        }
        return hit.id
      })
      // 留空则由 repo 回退到第一个分类，这里不抢着决定

      /**
       * 项目：按名字找，找不到**报错**（1.0.40 收紧，原为自动建）。
       * 完整理由见 resolveProjectForWrite 的注释 —— 一句话：
       * project 必填后错字成了高频事件，而它是看板的主聚合维度。
       */
      let projectId: string | null = null
      const projectName = flags['--project']
      if (projectName) {
        projectId = resolveProjectForWrite(
          ctx,
          String(projectName),
          flags['--create-project'] === true
        )
      }

      let dueAt: string | null = null
      if (flags['--due']) {
        dueAt = parseTime(String(flags['--due']))
        if (!dueAt) throw new UsageError(`无法解析时间: ${String(flags['--due'])}`)
      }

      /**
       * 提醒时间（Bob cc87b788 实测：写侧界面有、CLI 没有，agent 建不了带提醒的事项）。
       * 复用 --due 那套时间解析，语义与界面上的提醒一致。
       */
      let remindAt: string | null = null
      if (flags['--remind']) {
        remindAt = parseTime(String(flags['--remind']))
        if (!remindAt) throw new UsageError(`无法解析时间: ${String(flags['--remind'])}`)
      }

      // 未注册身份只能读不能写：声明了 agent 身份就必须先注册过
      assertRegisteredActor(ctx, createdBy)

      /**
       * 冒名治理第 1 层（1.0.109，`b95e6bbb`）：这次调用自己给出的两个说法不能互相矛盾。
       * 放在身份校验之后 —— 调用方自己都没资格写时，先报那个更根本的问题。
       */
      assertCreatedByNotImpersonating(ctx, createdBy)

      /**
       * 父需求 id：必须先兑成完整 id
       *
       * 此前这里直接用用户/agent 给的原始值塞进外键列，于是 `todo add --parent <前缀>`
       * 会在 SQL 层炸出 `FOREIGN KEY constraint failed` —— 一条谁也看不懂的消息：
       * 既不说哪个参数错，也不说该怎么改。而 CLI 里其余所有 id 参数都支持前缀。
       *
       * 更糟的是它的连锁反应：repo 层的 G1 守卫按 parent_id 查父需求，
       * 查不到就报"父需求尚在「待确认」列"（G1）—— 父需求根本不存在，
       * 却被说成还在待确认。这种误导比报错本身更费时间。
       *
       * 兑前缀后两种情况各归各位：不存在走"不存在"，存在但待确认才走 G1。
       */
      let parentId: string | null = null
      if (flags['--parent']) {
        const rawParent = String(flags['--parent'])
        try {
          parentId = ctx.deps.todoRepo.resolveId(rawParent)
        } catch {
          throw new NotFoundError(
            `父需求不存在: ${rawParent}。传完整 id 或其前缀，先用 \`todo list --brief\` 查准确认`
          )
        }
      }

      /**
       * 提出者（1.0.73，`63b707ca` 选 ①）
       *
       * 不传 `--created-by` 时**不再无条件落 human**：
       * 调用方若持有 agent 身份（ctx.actor = `agent:<id>`），提出者默认取它。
       * 见 `resolveCreatedBy` 的注释 —— 判据是"有身份才兜底"，
       * 未声明身份仍是 human（人自己在终端上登记的场景不变）。
       */
      const effectiveCreatedBy = resolveCreatedBy(ctx, createdBy)

      const created = ctx.deps.todoRepo.create({
        title,
        description: flags['--desc'] ? String(flags['--desc']) : null,
        priority: (priority as TodoPriority) ?? 'normal',
        dueAt,
        ...(remindAt ? { remindAt } : {}),
        ...(type ? { type: type as TodoType } : {}),
        // --owner 是旧参数名，映射到提出者；执行者默认即提出者（落 NULL）
        ...(effectiveCreatedBy ? { createdBy: effectiveCreatedBy as TodoOwner } : {}),
        ...(executedByFlag !== undefined ? { executedBy: String(executedByFlag) as TodoOwner } : {}),
        // 验收者：1.0.67（`a6032512`）。不传则由 repo 默认取提出者
        ...(flags['--verifier'] !== undefined
          ? { verifier: String(flags['--verifier']) as TodoOwner }
          : {}),
        ...(categoryIds.length ? { categoryIds } : {}),
        ...(projectId ? { projectId } : {}),
        ...(parentId ? { parentId } : {}),
        // 补录"这条其实在 X 版就修好了"时才传
        ...(flags['--fixed-in'] ? { fixedInVersion: String(flags['--fixed-in']) } : {}),
        // 支持直接建成"已完成"：agent 登记本轮做过的事时要用
        ...(status ? { status: status as TodoStatus } : {}),
        // 「新建了」的动作人：调用身份优先，别让 agent 的登记记成 human 干的
        actor: resolveActor(ctx, createdBy)
      })

      /**
       * G7（软提醒）：建成「待确认」时自检描述要素 —— 不拦，只在缺得离谱时吱一声。
       * 理由见 proposedDescNotice 的注释。
       */
      const descNotice = created.status === 'proposed' ? proposedDescNotice(created.description) : null

      /**
       * 登记前去重提示（1.0.68，修 `84efa995`）—— **软提醒，不拦**
       *
       * 判据与阈值见 `TodoRepository.findSimilar` 的注释：
       * 那个 0.7 是**在真实库上量已知五对真重复反推出来的**，不是拍的。
       *
       * ⚠️ **查重放在 create 之后**（而不是之前）：要拿真实 id 与状态才能提示，
       * 而更重要的是——**绝不因为命中就不建这条**。
       * 命中只说明"可能重了"，要不要建由调用方判断；
       * 硬拦会把"同名不同事"这类正当操作也挡住。
       */
      const dup = ctx.deps.todoRepo.findSimilar(created.title, 3, created.id)
      const dupNotice = dup.length
        ? `检出 ${dup.length} 条疑似重复：` +
          dup
            .map(
              (d) =>
                `\n  · ${d.todo.title}（${d.todo.status}｜${d.todo.id.slice(0, 8)}）—— ${d.reason}`
            )
            .join('') +
          `\n  确实同一条就删掉刚建的这张（todo rm ${created.id.slice(0, 8)}）；不是就忽略本条。`
        : null

      // 两条提醒都在时拼起来，别互相盖掉
      const notices = [descNotice, dupNotice].filter(Boolean) as string[]
      if (notices.length) {
        return {
          __notice: notices.join('\n\n'),
          data: { id: created.id, title: created.title }
        }
      }
      return { id: created.id, title: created.title }
    }
  },
  {
    name: 'todo list',
    dataShape: 'array',
    /**
     * 默认口径声明（收 `516a74d4`）—— 见 `CommandSpec.defaults` 的说明。
     *
     * 两个值都取自本命令自己用的常量（`TODO_LIST_DEFAULT_LIMIT` /
     * `LIST_DESC_PREVIEW_CHARS`），schema 里不另写数字。
     */
    defaults: {
      limit: TODO_LIST_DEFAULT_LIMIT,
      fields: { description: 'preview', previewChars: LIST_DESC_PREVIEW_CHARS }
    },
    readOnly: true,
    desc: '查询待办（默认只回未完成的 open 四列；要真全量传 --status any）',
    args: [
      {
        flag: '--status',
        type: 'enum',
        enum: FILTER_STATUSES,
        multi: true,
        desc:
          '按状态过滤，可逗号多值（如 todo,in_progress）。' +
          'open（默认，旧名 unfinished）= 未完成四列（proposed/todo/in_progress/awaiting_review，' +
          '排除 done/suspended/discarded）；any = 真全量（七列全含，含 suspended/discarded/done）'
      },
      { flag: '--priority', type: 'enum', enum: PRIORITIES, multi: true, desc: '按优先级过滤，可逗号多值' },
      { flag: '--type', type: 'enum', enum: TYPES, multi: true, desc: '按事项类型过滤，可逗号多值' },
      {
        flag: '--search',
        type: 'string',
        desc: '关键字，匹配**标题或描述**（此前只搜标题，凭描述里的词搜不到）'
      },
      {
        flag: '--created-by',
        type: 'string',
        desc: '按提出者过滤：human 只看用户提出的，agent 看所有 agent 的，也可传完整 agent:<id>'
      },
      {
        flag: '--owner',
        type: 'string',
        desc: '（兼容别名）等价于 --created-by，按提出者过滤'
      },
      {
        flag: '--executed-by',
        type: 'string',
        desc:
          '按执行者过滤：传 agent:<id> 看指派给它的（含它自己提自己做的），' +
          '传 human 看该人执行的，传 unset 看**没有显式指派**的。' +
          '执行者字段此前是唯一读不出来的维度，而验收责任正记在它上面'
      },
      {
        flag: '--mine',
        type: 'boolean',
        desc: '按当前调用身份查询执行者是自己的事项；等价于 --executed-by <当前身份>'
      },
      { flag: '--category', type: 'string', multi: true, desc: '按分类名过滤，可逗号多值（命中任一即算）' },
      {
        flag: '--project',
        type: 'string',
        multi: true,
        desc:
          '按项目名过滤，可逗号多值（命中任一即算）。' +
          '**不传 = 全机（跨项目）查询**：回执 meta.projectScope 会说明这一页来自哪几个项目'
      },
      {
        flag: '--updated-since',
        type: 'string',
        desc:
          '只要在该时间之后**被改动过**的（ISO 或 YYYY-MM-DD）。' +
          '回答"上一轮之后哪些动了"，比逐个查 updatedAt 省一整轮'
      },
      {
        flag: '--created-after',
        type: 'string',
        desc:
          '只要在该时间之后**创建**的（ISO 或 YYYY-MM-DD）。' +
          '配 --created-by 查找某人近期新建的事项（避免被频繁更新的旧事项挤出默认分页窗口）'
      },
      {
        flag: '--sort',
        type: 'enum',
        enum: ['pinned', 'updated', 'created', 'due', 'priority'],
        desc:
          '排序依据。默认 pinned = 置顶优先 + 创建时间倒序（与看板一致）；' +
          'updated = 最近改动优先（配 --updated-since 看"这一轮动了哪些"）；' +
          'due = 截止时间近的在前；priority = 紧急的在前'
      },
      {
        flag: '--fixed-in',
        type: 'string',
        desc:
          '按「解决于版本」过滤。传版本号（如 1.0.59）看该版收口了哪些；' +
          '传 unset 看**尚未标注**的；传 any 只看**已标注**过的。' +
          '发版时用它核对"这一版到底修了哪几条"'
      },
      {
        flag: '--limit',
        type: 'string',
        desc:
          `返回条数上限。**不传 = 默认最多 ${TODO_LIST_DEFAULT_LIMIT} 条**；` +
          '翻页读取配 --offset（看下一批就传上一次回执里的 `meta.nextOffset`）；' +
          `传 ${LIMIT_ZERO_DOC}（配合 --status any 谨慎使用）`
      },
      {
        flag: '--offset',
        type: 'string',
        desc:
          '分页偏移，默认 0（从第几条开始取）。与 --limit 配对翻页：先取一页，' +
          '再看回执里的 `meta.nextOffset` 取下一段 —— 与 `project search` 同一套口径。' +
          '偏移超过匹配总数时回空数组，总数看 `meta.matched`'
      },
      {
        flag: '--brief',
        type: 'boolean',
        desc: '省略描述，输出更短（回执 meta.fields 会自报本次口径：preview / omitted）'
      }
    ],
    run: (ctx, flags) => {
      let out = ctx.deps.todoRepo.list()

      if (flags['--search']) {
        // 标题 + 描述都搜（此前只搜标题）：agent 记东西时说明往往写在描述里，
        // 拿描述里的词搜不到，就会误判"没登记过"而重复建卡（S8 场景）
        const kw = String(flags['--search']).toLowerCase()
        out = out.filter(
          (t) =>
            t.title.toLowerCase().includes(kw) ||
            (t.description ?? '').toLowerCase().includes(kw)
        )
      }

      /**
       * 状态过滤（1.0.63；1.0.74 修 `2e8dfa6d`）—— 默认 `open`（旧名 unfinished）。
       *
       * 默认值的取舍：`todo list` 是 agent 每轮的第一件事，它默认应该回答的是
       * "**还需要我处理的**"。旧默认（全量）实测把 400 条一次吐出来、其中 73% 是 done，
       * agent 只能拉回来自己按状态分组 —— 那是不该由调用方承担的加工（S2 场景）。
       * 要看全量：显式 `--status any`（真全量，含 suspended/discarded/done）；
       * 要看某几列：`--status todo,in_progress`。
       *
       * 放在命令层而不是 repo：repo 是通用的数据访问，不该替调用方决定
       * "不传等于要什么"—— 那是产品默认值，属于命令这一层。
       */
      const rawStatus = flags['--status'] !== undefined ? String(flags['--status']) : 'open'
      if (rawStatus !== 'any') {
        const wanted = rawStatus
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
        const allow = new Set<string>(
          wanted.includes('open') || wanted.includes('unfinished') ? OPEN_STATUSES : wanted
        )
        out = out.filter((t) => allow.has(t.status))
      }

      if (flags['--priority']) {
        const allow = new Set(String(flags['--priority']).split(',').map((s) => s.trim()))
        out = out.filter((t) => allow.has(String(t.priority)))
      }
      if (flags['--type']) {
        const allow = new Set(String(flags['--type']).split(',').map((s) => s.trim()))
        out = out.filter((t) => allow.has(String(t.type)))
      }
      // --owner 是旧参数名，与 --created-by 同义（按提出者过滤）
      const ownerWish = flags['--created-by'] ?? flags['--owner']
      if (ownerWish) {
        const want = String(ownerWish)
        // 传 "agent" 是"看所有 agent 的"的简写，不必逐个写 agent:<id>
        out =
          want === 'agent'
            ? out.filter((t) => t.createdBy.startsWith('agent:'))
            : out.filter((t) => t.createdBy === want)
      }
      /**
       * 按执行者过滤（1.0.63）—— 此前唯一读不出来的维度。
       *
       * 执行者 null 的语义是"执行者即提出者"（提出即执行），不是"没人管"——
       * 所以筛 `unset` 时给的是"**没有显式指派**"的那批，
       * 既包含"自己提自己干"的，也包含"agent 提给人干"时没标 executedBy 的。
       * 这与 agent-guide 里"执行者默认即提出者"是同一条约定，不另立一套。
       */
      if (flags['--mine'] === true && flags['--executed-by'] !== undefined) {
        throw new UsageError('--mine 不能与 --executed-by 同时使用')
      }
      if (flags['--mine'] === true || flags['--executed-by'] !== undefined) {
        const want = flags['--mine'] === true ? actorOf(ctx) : String(flags['--executed-by']).trim()
        if (!want) {
          throw new UsageError('--executed-by 不能为空；传 human、agent、agent:<id> 或 unset')
        }
        // 判据与 G9 回执的「指派给你」计数共用 todosForExecutor（2e8dfa6d）——
        // 两处各写一套过滤器时，提醒数与查询数已经漂移过一次
        out = todosForExecutor(out, want)
      }
      if (flags['--category']) {
        const names = String(flags['--category']).split(',').map((s) => s.trim()).filter(Boolean)
        const ids = names.map((name) => {
          const hit = ctx.deps.categoryRepo.list().find((c) => c.name === name)
          if (!hit) throw new NotFoundError(`分类不存在: ${name}`)
          return hit.id
        })
        // 多值：只要带了这个标签就算命中（含同时带了别的标签的）
        out = out.filter((t) => t.categoryIds.some((id) => ids.includes(id)))
      }
      if (flags['--project']) {
        const names = String(flags['--project']).split(',').map((s) => s.trim()).filter(Boolean)
        const ids = names.map((name) => {
          const hit = ctx.deps.projectRepo.list().find((p) => p.name === name || p.id === name)
          if (hit) return hit.id
          try {
            return ctx.deps.projectRepo.resolveId(name)
          } catch (err) {
            if (err instanceof UsageError) throw err
            throw new NotFoundError(`项目不存在: ${name}`)
          }
        })
        out = out.filter((t) => t.projectId !== null && ids.includes(t.projectId))
      }
      /**
       * 「这之后动过的」（1.0.63）—— 回答"上一轮之后哪些被改了"。
       *
       * 只按日期（YYYY-MM-DD）比较时取当天 00:00 —— 与 `--due` 的日期语义一致；
       * 带时间的 ISO 串则按完整时刻比。用 Date.parse 比而不是字符串比较：
       * 库里的时间戳是 ISO，而调用方可能只想写 `2026-09-30`。
       */
      if (flags['--updated-since'] !== undefined) {
        const raw = String(flags['--updated-since']).trim()
        const since = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00` : raw)
        if (Number.isNaN(since)) {
          throw new UsageError(`--updated-since 读不出时间: ${raw}（用 2026-09-30 或完整 ISO）`)
        }
        out = out.filter((t) => {
          const at = Date.parse(t.updatedAt)
          return !Number.isNaN(at) && at >= since
        })
      }
      if (flags['--created-after'] !== undefined) {
        const raw = String(flags['--created-after']).trim()
        const since = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00` : raw)
        if (Number.isNaN(since)) {
          throw new UsageError(`--created-after 读不出时间: ${raw}（用 2026-09-30 或完整 ISO）`)
        }
        out = out.filter((t) => {
          const at = Date.parse(t.createdAt)
          return !Number.isNaN(at) && at >= since
        })
      }
      /**
       * 按「解决于版本」过滤（v24）。
       *
       * 三个入口：具体版本号 / unset（未标注）/ any（已标注）。
       * 版本号**不校验是否存在** —— 版本号不是库里的实体，没有"版本表"，
       * 传一个不存在的版本号应回空列表（"这一版没收录任何事项"），
       * 而不是报错。报错会让"发版前先查一下"这个动作卡住。
       */
      if (flags['--fixed-in'] !== undefined) {
        const want = String(flags['--fixed-in']).trim()
        if (!want) {
          throw new UsageError('--fixed-in 不能为空；要用版本号、unset（未标注）或 any（已标注）')
        }
        out = out.filter((t) =>
          want === 'unset'
            ? t.fixedInVersion === null
            : want === 'any'
              ? t.fixedInVersion !== null
              : t.fixedInVersion === want
        )
      }
      /**
       * ── 截断必须显式（1.0.63）──
       *
       * 旧行为：`--limit` 默认 0（不截断）。看似"什么都不少给"，
       * 实测的后果是裸 `todo list` 一次吐 400 条 / 476KB，agent 的上下文被
       * 一次性挤掉；而它真正要的往往只有几十条未完成的。
       * 现在默认口径收窄到 open（旧名 unfinished）、默认上限 `TODO_LIST_DEFAULT_LIMIT` 条，
       * 量级下来了，但**一旦真发生截断就在回执里说明**——静默截断会让 agent 以为
       * "就这么多"而漏掉后面的（见 output 里的 __truncated）。
       *
       * ⚠️ 这几行此前写着"limit 保持'不传=不截断'"，而代码早已是默认 20 条 ——
       * 注释与行为打架，照注释算口径的人会算错。同 `2e948042` 那一族：说出口的必须是真的。
       */
      const total = out.length
      /**
       * 按状态计数（1.0.63）—— 对**匹配集**（过滤后、截断前）计数。
       *
       * 这是 18f25c17 第 4 项"无计数/分组"的正解：此前 agent 要"看板全貌"
       * 得把整批拉回来自己 `for` 一遍分类。放在 meta 里而不是 data 里，
       * 是因为 data 必须继续是数组（见 Outcome.meta 的注释）。
       * 要看**全库**分布就传 `--status any`，此时匹配集即全库。
       */
      const byStatus: Record<string, number> = {}
      for (const t of out) byStatus[t.status] = (byStatus[t.status] ?? 0) + 1
      /**
       * 排序（1.0.63；1.0.107 起**排完再分页**，修 `3675f993`）。
       *
       * 默认 `pinned` = **保持 repo 给的顺序**（置顶优先 + 创建时间倒序），不重排 ——
       * 免得改一个以"看一眼"为主的命令时顺手把所有人熟悉的顺序换了。
       *
       * ⚠️ 这一段原来在分页**之后**：`--sort priority --limit 5` 实际是
       * "repo 顺序的前 5 条，再按优先级排" —— 而说明书里写的是"紧急的在前"。
       * 加了 `--offset` 之后更说不通：排序若落在分页后，同一批数据的两页
       * 会各自排序，拼起来不是"排序后的前 40 条"。
       * 判据：**先定顺序，再切片** —— 分页只在排好的序列上切。
       */
      const sort = flags['--sort'] ? String(flags['--sort']) : 'pinned'
      const ts = (s: string | null): number => (s ? Date.parse(s) || 0 : 0)
      if (sort === 'updated') {
        out = [...out].sort((a, b) => ts(b.updatedAt) - ts(a.updatedAt))
      } else if (sort === 'created') {
        out = [...out].sort((a, b) => ts(b.createdAt) - ts(a.createdAt))
      } else if (sort === 'due') {
        // 没设截止的排最后（它们没有"更近"可言），其余按时间近的在前
        out = [...out].sort((a, b) => {
          const av = a.dueAt ? Date.parse(a.dueAt) : Number.POSITIVE_INFINITY
          const bv = b.dueAt ? Date.parse(b.dueAt) : Number.POSITIVE_INFINITY
          return av - bv
        })
      } else if (sort === 'priority') {
        const rank: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 }
        out = [...out].sort((a, b) => (rank[a.priority] ?? 9) - (rank[b.priority] ?? 9))
      }

      /**
       * ── 分页：排好再切一页（1.0.107，修 `3675f993`）──
       *
       * 旧行为只有 `--limit`、没有 `--offset`，而 `--limit` 的说明写着
       * "需要继续读取时显式传 --limit"。**没有偏移，"继续"就做不到** ——
       * 只能把窗口一次放大：实测 `--limit 0` 是 519 条 / 1.1MB。
       * 也就是说"默认有界"这条纪律在这条命令上只挡住了默认值，
       * 逃生门仍然是"一次拉爆上下文"。同版的 `project search` 早就有 offset + nextOffset。
       *
       * 判据：**"继续读取"必须真做得到。** 口径与 `project search` 对齐：
       * `--offset` 收非负整数，回执给 `nextOffset`（没有下一页时是 `null`）。
       *
       * `--limit 0` 保留为"显式全量"的逃生口（配合 `--status any` 谨慎用）——
       * 有了翻页，它就不再是唯一出路。
       */
      const limitGiven = flags['--limit'] !== undefined
      // 解析交给族内唯一一处（`8d78af0d`）：非负整数、0 = 全量、非法报 usage_error
      const limit = parseLimit(flags['--limit'], 'todo list') ?? TODO_LIST_DEFAULT_LIMIT
      /**
       * 偏移交给族内唯一一处（1.0.109，修 `7f21841f`）。
       *
       * 这一段此前手写：先 `Number()`，再只判"整数且非负"——
       * 而 `--offset` **裸着传**时 `parseFlags` 给的布尔 `true` 会过这一关
       * （`Number(true) === 1`），于是静默从第 2 条开始。`parseOffset` 只收
       * 字符串/数字，那种写法一律 `usage_error`。
       */
      const offset = parseOffset(flags['--offset'], 'todo list')
      if (offset > 0) out = out.slice(offset)
      out = takeLimit(out, limit)
      /** 截断 = **这一页之后还有**：被偏移吃掉的那部分不算截断（它不是"更多"） */
      const truncated = offset + out.length < total
      const nextOffset = truncated ? offset + out.length : null

      /**
       * 「最多几条」这句话**按真实参数生成**（1.0.107 后补，修 `2e948042`）
       *
       * 以前这里把默认上限写死成 20 条：CLI 直连默认确实是 20，
       * 但 MCP 的 `list_todos` 会替调用方兜上 `--limit 50`（通道侧默认，见 `mcp-server.ts`），
       * 于是同一条回执里 `returned` 是 50、这句话还说"最多 20" ——
       * 接入方按它判断自己是否看全，而它实际看到的是 50。
       *
       * 判据：**回执里说的上限，必须就是这一次生效的上限。**
       * 不传 = 说默认值（也就是生效值）；传了 = 说本次值，不再冒充"默认"。
       *
       * ⚠️ 顺带收掉同族的一处静默：`--limit abc` / `--limit -1` 以前按"非正数 = 全量"处理，
       * 而回执还说"最多 20 条"——两句话都不真。现在按同族命令的判据报 usage_error。
       *
       * ⚠️ 有了 `--offset`（`3675f993`）之后，这句话要教的是**翻页**：
       * 它以前只说"需全量请传 --status any --limit 0"，而那条路正是上面那 1.1MB ——
       * 现在指向回执自己给的 `nextOffset`，不再把人往逃生门上带。
       */
      const limitClaim = !limitGiven
        ? `默认最多返回 ${limit} 条；继续读传 --offset <回执里的 nextOffset>，要全量传 --status any --limit 0`
        : limit > 0
          ? `本次最多返回 ${limit} 条（--limit ${limit}）；继续读传 --offset <回执里的 nextOffset>`
          : `本次为全量（--limit 0），共 ${total} 条；要翻页读请传 --limit N`

      /**
       * id → 名字（1.0.63）：projectId / categoryIds 是 uuid，
       * agent 拿到既读不出含义、也无法回填到别的命令（那些命令要的是**名字**）。
       * 现在每个字段同时给 id 与可读名，两者都不丢。
       *
       * 名字解析失败时（脏数据 / 已删）**保留 id 并如实标 null**，不编造。
       */
      const projectName = new Map(ctx.deps.projectRepo.list().map((p) => [p.id, p.name]))
      const categoryName = new Map(ctx.deps.categoryRepo.list().map((c) => [c.id, c.name]))

      /**
       * 发版对账用的收口判据（1.0.68，修 `40294c81`）—— **只在按版本筛时算**
       *
       * ## 为什么要有
       *
       * `--fixed-in <版本>` 只回答"**改了哪些**"，不回答"**验了哪些**"——
       * 而发版决策必须把两件事一起看。
       * 以前要区分"done 是不是真验过"与"awaiting_review 还差什么"，
       * **只能逐条 `todo get` 读评论**（N 条 = N 次调用）。
       *
       * ⚠️ 主用户的验收习惯直接依赖这件事：
       * **「待验收列表里没有标注版本，我就不验收」** ——
       * 做成字段后这条纪律**可以机检**，而不是靠人扫列表。
       *
       * ## 判据是"有没有收口结论"，不是"有没有评论"
       *
       * Bob实测：批量关 30 张卡，G5 全部放行，而其中一半只有一行字。
       * **有评论 ≠ 交代过了** —— 所以判据落在 `todo close` 写的四段标记上。
       *
       * ## 为什么要批量
       *
       * 逐条查是 N+1。与 `countsByTodo` 同一个套路。
       */
      const wantClosure = flags['--fixed-in'] !== undefined
      const closure = wantClosure
        ? ctx.deps.commentRepo.closureByTodo(out.map((t) => t.id))
        : {}

      /**
       * 「这次带不带描述」——**唯一一份判定**（1.0.110，收 `516a74d4`）。
       *
       * 行构建与回执自报（`meta.fields`）必须读同一个值：
       * 两处各写一遍 `Boolean(flags['--brief'])` 就是又一次"两处口径"，漂了没人知道。
       */
      const brief = Boolean(flags['--brief'])

      // 四个维度都输出：agent 要靠它们做关联和筛选，
      // 只给标题等于让人"看得见但用不了"
      const rows = out.map((t) => {
        const catIds = t.categoryIds ?? []
        return {
          id: t.id,
          title: t.title,
          projectId: t.projectId ?? null,
          projectName: t.projectId ? (projectName.get(t.projectId) ?? null) : null,
          parentId: t.parentId ?? null,
          categoryIds: catIds,
          categoryNames: catIds.map((id) => categoryName.get(id) ?? null),
          status: t.status,
          priority: t.priority,
          type: t.type,
          createdBy: t.createdBy,
          executedBy: t.executedBy ?? null,
          dueAt: t.dueAt,
          createdAt: t.createdAt,
          /**
           * 验收状态（**只在 `--fixed-in` 时给**，1.0.68 修 `40294c81`）
           *
           * 三个取值：
           * - `pending` —— 还在「待验收」，差一次验收
           * - `no-closure` —— 已完成但**没有收口结论**（该补一条 `todo close`）
           * - `closed` —— 已完成且有收口结论
           *
           * 另带 `rejected`：有过驳回记录 —— 发版时值得多看一眼的那类。
           *
           * ⚠️ **不加在默认输出里**：平时不需要它，加了只是噪音 + 一次多余查询。
           * 判据：**字段要出现在用得到它的地方，不是出现在"看起来完整"的地方。**
           */
          ...(wantClosure
            ? (() => {
                const c = closure[t.id]
                return {
                  acceptance: {
                    status:
                      t.status === 'awaiting_review'
                        ? 'pending'
                        : c?.hasClosure
                          ? 'closed'
                          : 'no-closure',
                    hasClosure: c?.hasClosure ?? false,
                    rejected: c?.rejected ?? false
                  }
                }
              })()
            : {}),
          /**
           * updatedAt 一直带上（1.0.63）：`--updated-since` 与"上一轮之后哪些动了"
           * 都要靠它，而它此前**根本不在回执里**——调用方只能拿到 createdAt，
           * 拿不到"最近一次改动时刻"。与 fixedInVersion 同理由：省掉它就得再发一条命令。
           */
          updatedAt: t.updatedAt,
          /**
           * 置顶状态**一直带上**，--brief 也不例外（Bob cc87b788 实测报的）。
           *
           * 此前写侧（`todo pin`）有、读侧没有 —— agent 无法确认自己那次置顶
           * 到底生效没有，只能盲信返回值。
           *
           * 为什么不像 description 那样在 --brief 下省略：它是一个布尔，
           * 成本几乎为零，而且**解释了排序**（置顶的排前面）。省掉它，
           * agent 会看到"顺序有点怪"却找不到原因。
           */
          isPinned: Boolean(t.isPinned),
          /**
           * 解决于版本一直带上（同 isPinned 的理由）：它是"这一版修了哪些"
           * 的唯一依据，省掉它 agent 就得再发一条命令去查。
           */
          fixedInVersion: t.fixedInVersion ?? null,
          /**
           * 描述默认带上，--brief 才省略。
           *
           * agent 记东西时说明往往写在描述里（标题只是一句话），
           * 只回标题等于让它"看得见标题、读不到上下文"，下一轮续不上。
           * 列表长一点值得；真要精简时用 --brief。
           */
          ...(brief
            ? {}
            : {
                description: summarizeDescription(t.description ?? null),
                descriptionTruncated: isDescriptionTruncated(t.description ?? null),
                remindAt: t.remindAt ?? null
              })
        }
      })

      /**
       * 被截断时说清"这只是前 N 条"。**不能静默** —— 看不出被截的调用方
       * 会把它当成全集，进而误判"没有更多要处理的了"。
       * 与 batch 的逐行结果同风格：给结论（是否完整）而不是让调用方自己数。
       *
       * meta 无论是否截断都带上（1.0.63）：`matched`/`returned` 让"到底有多少"
       * 不必靠数数组长度推；`byStatus` 让"各列各多少"一次给全。
       */
      /**
       * 查询范围自报（2026-10-22 主用户定的）
       *
       * 病根：`--project` 不传时这条命令查**全机**，而回执里一个字都没说 ——
       * 每行虽然带 `projectName`，但那是逐行的：整份回执不告诉你这一页跨了几个项目，
       * 于是很自然地被读成"我在看某个项目的清单"。
       *
       * 为什么**保留**这条路（而不是要求先给项目）：跨项目的问题真实且常用 ——
       * 全机待验收有多少、待办列被谁塞了多少张、有没有卡指派给我。这些都跨项目，
       * 没有项目可先选。"先项目、后状态"是**教法的顺序**，不该靠删掉能力来实现。
       * 与看板同一套模型：看板有 project / all 两种工作区模式，默认进项目、
       * 看全部要显式切；这里就给"看全部"这件事补一句明说。
       *
       * 判据与 `defaultScope` 同源：**默认口径变了就在回执里说清**。
       * ⚠️ 两种范围都带 `projectScope`（而不是"传了 --project 就没这个字段"）——
       * "字段不在 ⇒ 按项目查" 又是一次靠猜的推断。
       */
      const involvedProjects: string[] = []
      for (const t of out) {
        const name = t.projectId
          ? (projectName.get(t.projectId) ?? '（项目已删）')
          : '（未归属项目）'
        if (!involvedProjects.includes(name)) involvedProjects.push(name)
      }
      const scopeHead = involvedProjects.slice(0, 3).join(' / ')
      const projectScope =
        flags['--project'] === undefined
          ? {
              kind: 'all-projects' as const,
              projects: involvedProjects.slice(0, 5),
              projectCount: involvedProjects.length,
              notice:
                `本次**没有按项目收窄**：这是全机（跨项目）查询 —— 本页 ${rows.length} 条来自 ` +
                `${involvedProjects.length} 个项目` +
                (involvedProjects.length
                  ? `（${scopeHead}${involvedProjects.length > 3 ? ' 等' : ''}）`
                  : '') +
                `；只看某一个项目请传 --project "<项目名>"`
            }
          : {
              kind: 'project' as const,
              projects: involvedProjects.slice(0, 5),
              projectCount: involvedProjects.length
            }

      const meta = {
        matched: total,
        returned: rows.length,
        truncated,
        /**
         * 下一页从哪开始（1.0.107，修 `3675f993`）：键名与 `project search` 对齐。
         * 没有下一页时是 `null` —— 调用方据此判断"读完了"，
         * 不必靠"数组长度小于 limit"反推（那个推断在恰好整除时是错的）。
         */
        nextOffset,
        byStatus,
        /** 范围声明：全机查询还是按项目（见上面的 projectScope） */
        projectScope,
        /**
         * 描述字段口径（1.0.110，收 `516a74d4`）——**这一次回执里的 `description` 是怎么给的**。
         *
         * ## 为什么必须有
         *
         * 同一份库、同一条命令，CLI 直连与 MCP 的回执**字节数差一大截**：
         * CLI 不传是带上描述（每条截到 `LIST_DESC_PREVIEW_CHARS` 字），
         * MCP 的 `list_todos` 默认替调用方兜 `--brief`。而此前**回执里没有任何字段**
         * 说这件事 —— 接入方看到"同一份库两次结果不一样"，只能猜是数据变了。
         *
         * ⚠️ 与 `defaultScope` 的分工：那一条说的是"**默认**口径是什么"（只在确实按默认
         * 过滤时出现），这一条说的是"**这一次**实际是哪种" —— 显式传了 `--brief` 时
         * 与默认不同，所以它**无条件出现**（两种口径都给出，不许用"字段不在 ⇒ 默认"来猜）。
         *
         * 取值与 schema 里 `defaults.fields` 同一套（`preview` / `omitted`）——
         * 同一个名词在两处指同一件事，调用方不必学第二套词。
         */
        fields: {
          description: brief ? ('omitted' as const) : ('preview' as const),
          previewChars: brief ? 0 : LIST_DESC_PREVIEW_CHARS
        },
        /**
         * 口径声明（1.0.65，修 `cd854e3a`；1.0.74 同步 `2e8dfa6d`）：**默认口径写进回执**。
         *
         * 1.0.64 起 `todo list` 默认只回未完成（加 `--status any` 才全量）。
         * 那个默认值本身是对的（默认看未完成更符合用途），但它**静默**：
         * 跨版本写的脚本按"拉 list 数条数"得到的数会与看板实际列数不一致，
         * 于是"还有 30 多张待办"这类判断的口径被打乱 —— 而**数不对时没有任何报错**。
         *
         * 判据：**默认值变了就在回执里说清默认值是什么。**
         * 同一个道理见 batch 的 `executed:false` ——
         * 不自报，调用方只能靠猜。
         *
         * ⚠️ 1.0.74 起默认列收窄为 open 四列（另排 suspended/discarded），
         * 文案必须**与真实行为一致**（2e8dfa6d）—— 之前文案只说"已排除 done"，
         * 而实际还排了两列，按文案推算的数就错了。
         *
         * ⚠️ 同一条文案里"最多几条"那句由 `limitClaim` **按真实参数生成**（1.0.107 后补，
         * 修 `2e948042`）：写死那句默认上限会在 MCP 那条路上变成假话 ——
         * `list_todos` 会替调用方兜上 `--limit 50`，同一条回执里 `returned` 是 50、这句话还说 20。
         *
         * ⚠️ 只在"确实按默认口径过滤"时声明 ——
         * 调用方显式传了 `--status`，那是他的口径，不该再啰嗦一句。
         */
        ...(flags['--status'] === undefined
          ? {
              defaultScope:
                '未完成（open 四列：proposed/todo/in_progress/awaiting_review，' +
                `已排除 done 与 suspended/discarded；${limitClaim}）`
            }
          : {})
      }
      return truncated
        ? {
            __notice: `结果被 --limit ${limit} 截断：匹配 ${total} 条，本页回了第 ${offset + 1}–${offset + rows.length} 条；继续读传 --offset ${nextOffset}。`,
            __meta: meta,
            data: rows
          }
        : { __meta: meta, data: rows }
    }
  },
  {
    /**
     * 改一条已存在的待办。
     *
     * 为什么必须有它：此前 agent 记错了只能删了重建，而**重建会换 id**，
     * 已经挂在它上面的项目、父需求、子任务引用全断。
     * 更糟的是状态只能前进不能回头 —— done 之后没有任何命令能改回来。
     */
    name: 'todo update',
    dataShape: 'object',
    desc: '修改已有待办（改标题/描述/优先级/截止时间/状态/标签/项目）',
    args: [
      { flag: '--title', type: 'string', desc: '新标题' },
      {
        flag: '--desc',
        type: 'string',
        desc:
          '补充描述。**默认是追加**（1.0.49 起）：新内容会接在原文后面，' +
          '带分隔线、署名与时间。传空串 "" 表示清空。要整体替换原文请配 --overwrite-desc'
      },
      {
        flag: '--overwrite-desc',
        type: 'boolean',
        desc:
          '把 --desc 的语义改成**整体替换**（1.0.49 之前的默认行为）。' +
          '会抹掉原有描述，只在你确实要重写正文时才用'
      },
      {
        flag: '--desc-file',
        type: 'string',
        desc: '从文件读取新描述（等价于 --desc <文件内容>；由启动器展开为 --desc）。相对路径按当前工作目录解析；含反引号/尖括号/$ 的长文本用它可绕开 shell 吞字符'
      },
      { flag: '--priority', type: 'enum', enum: PRIORITIES, desc: '新优先级' },
      {
        flag: '--due',
        type: 'string',
        desc: '新截止时间，支持 ISO / today / tomorrow / +3d / 09-20 18:00；传 clear 表示清空'
      },
      {
        flag: '--remind',
        type: 'string',
        desc: '新提醒时间，与 --due 同一套解析；传 clear 表示清空'
      },
      {
        flag: '--category',
        type: 'string',
        desc: '标签名，逗号分隔多个。会**覆盖**原有标签，不传则不动'
      },
      {
        flag: '--project',
        type: 'string',
        desc: '项目名（**不存在会报错**，1.0.40 起；确要新建加 --create-project）。项目为必填项，不能传 clear'
      },
      {
        flag: '--create-project',
        type: 'boolean',
        desc: '项目名不存在时新建它。不加则报错并列出现有项目'
      },
      {
        flag: '--parent',
        type: 'string',
        desc: '挂到某个父需求下（支持 id 前缀）；传 clear 表示摘出来变成独立事项'
      },
      {
        flag: '--status',
        type: 'enum',
        enum: STATUSES,
        desc: '新状态。可从 done 改回 todo/in_progress；父需求做完转 awaiting_review 请人验收（须先过子任务全部完成的硬校验）'
      },
      {
        flag: '--type',
        type: 'enum',
        enum: TYPES,
        desc: '新事项类型（bug/feature/task）'
      },
      {
        flag: '--created-by',
        type: 'string',
        desc:
          '新提出者（记错人时的补救）。' +
          '[!] 声明了身份时不能改成**别的** agent（那是冒名，会报 usage_error）；' +
          '改回自己的身份或 human 可以'
      },
      {
        flag: '--executed-by',
        type: 'string',
        desc: '新执行者；传 human 指派给用户，传 clear 表示回到提出者执行'
      },
      {
        flag: '--verifier',
        type: 'string',
        desc:
          '新验收者：谁判断这件事做完了。默认即提出者。' +
          '**验收者 ≠ 执行者**才能把「待验收」推到「已完成」（1.0.67 起按角色定权）'
      },
      {
        flag: '--fixed-in',
        type: 'string',
        desc:
          '标「解决于哪个版本」（发版收口时用）。传版本号如 1.0.59；' +
          '传 clear 表示清掉标注（标错了回退）'
      },
      {
        flag: '--owner',
        type: 'string',
        desc: '（兼容别名）等价于 --created-by'
      },
      {
        /**
         * 乐观锁（1.0.73，`9947bf5a`）
         *
         * 判据写在 `UpdateTodoInput.ifUpdatedAt` 的注释里（**单一来源**）：
         * 库里 `updated_at` 混着两种写法（6 位无 Z / 3 位带 Z），
         * 所以这里**原样传下去、不做任何解析或规范化** ——
         * 一旦在某处格式化，比对就再也不成立了，而且失败方式很安静
         * （每次都报冲突，人以为是"并发太多"）。
         */
        flag: '--if-updated-at',
        type: 'string',
        desc:
          '乐观锁：带上你 `todo get` 时看到的 updatedAt，只在它没变时才允许改。' +
          '不一致返回退出码 5 + conflict（**什么都没写**），' +
          '你该重读一遍再决定，而不是重试 —— 重试会再撞一次，还可能把别人刚改的盖掉'
      },
      {
        /**
         * 改状态的**同一调用里**写清理由（1.0.68，修 `20aee7a4`）
         *
         * ## 为什么加这个
         *
         * 这一天我自己撞了它 16 次：批量改状态时，
         * 「改状态」与「写理由」是**两条命令**，
         * 而**没有任何机制保证它们成对发生** ——
         * 漏了评论，状态就变了而理由没留下；或反之。
         *
         * 我那天为绕过它**直改了数据库** ——
         * 而直改库恰好绕过了"改状态要留理由"这条机制本身。
         *
         * ## 与 `todo comment` 的分工
         *
         * `todo comment` = 追加一条往来（**这条命令本身就是"说话"**）。
         * `--comment` = **这次改动的说明**（"为什么改它"）——
         * 写进同一张卡的评论线程，`kind=comment`，
         * 但**它与状态变更是一次调用**，不可能只做一半。
         *
         * ⚠️ **顺序：先写评论再改状态。**
         * 反过来的话，状态若被守卫拦下，评论已经写上了而状态没动 ——
         * 又是"看起来成功其实没成"。
         */
        flag: '--comment',
        type: 'string',
        desc:
          '这次改动的理由（与 --status 同一次调用写入，**不会只改一半**）。' +
          '它不是追加讨论，而是"为什么改它"'
      },
      {
        flag: '--comment-file',
        type: 'string',
        desc:
          '从文件读 --comment 的正文（长文本/含反引号 $ < 时必须走它；**由启动器展开**为 --comment，' +
          '相对路径按当前工作目录解析）'
      }
    ],
    positional: { name: 'id', required: true, desc: '待办 ID（支持前缀）' },
    run: (ctx, flags, positional) => {
      const input = positional[0]
      if (!input) throw new UsageError('缺少待办 id')
      const id = ctx.deps.todoRepo.resolveId(input)

      /**
       * preApprovedGrantId（f5e76697）：人已批准这次改动时带上，G4 据此放行
       *（与 delete 同源：判据是「带没带人的批准」，不是「谁在动」）。
       *
       * ⚠️ **不能写进 `patch`**（与下面 `--if-updated-at` 同一类坑）：
       * `UpdateTodoInput.preApprovedGrantId` 的注释写明它是通道事实 ——
       * 不落库、**不算字段变更**。而「一个字段都不改」那条检查数的是**键**，
       * 恒有这个键就会把"什么都没改"顶成"改了东西"，
       * 「至少要指定一个要改的字段」的报错被吞掉 → 假成功（实测红过 3 条）。
       * 与 ifUpdatedAt 一样：在下面 repo 调用处合并。
       */
      const patch: UpdateTodoInput = { id }

      // 同 add：服务端不该收到 --desc-file / --body-file（由启动器展开），收到即报错而非静默忽略
      assertNoLauncherOnlyFlags(flags)

      if (flags['--title'] !== undefined) {
        const title = strValue(flags['--title']).trim()
        if (!title) throw new UsageError('--title 不能为空；要清空请用 --desc ""')
        assertValidTitle(title)
        patch.title = title
      }

      /**
       * `--desc` 默认**追加**，不是替换（1.0.49，修主用户 fa608cb9）。
       *
       * ── 为什么改语义 ──
       *
       * 原语义是整体替换，但对调用方**没有任何提示**，回执也不区分
       * "改了一个字"和"抹掉 700 字"。主用户实测：跑 `todo update --desc`
       * 给 10 条事项留复测证据，回执看着是普通编辑，
       * 实际把别人写的原始描述（含"1.0.44 已做，请验收"这类实现细节）
       * 整段冲掉了。她是在被指出之后才去查能不能救 ——
       * 而当时描述不在审计范围内，最后靠一份碰巧存在的 v19 快照才救回来。
       *
       * agent 的典型姿势恰恰是"补充信息"（补结论、补证据、补复测结果），
       * 而不是"重写正文"。默认追加符合绝大多数真实意图，
       * 而"抹掉别人的字"这个动作必须有**显式**表达才允许。
       *
       * ── 三种写法 ──
       * - `--desc "..."`          → 追加（带时间戳与作者，分隔线隔开）
       * - `--desc ""`             → 清空（原有语义保留，这是显式动作）
       * - `--overwrite-desc "..."` → 整体替换（老语义，显式声明）
       */
      const overwriteDesc = flags['--overwrite-desc'] !== undefined
      if (overwriteDesc && flags['--desc'] === undefined) {
        throw new UsageError('--overwrite-desc 要配合 --desc 使用（它只是改变 --desc 的语义）')
      }
      /**
       * 改动前的描述 —— 两个用途：
       * 1. 追加语义要拿它拼新值；
       * 2. 审计要记 before（长度骤降提醒也靠它算比例）。
       *
       * 读一次存下来，不重复查库。`null` 表示"本次没碰描述"，
       * 与"描述是空的"（`''`）必须能区分。
       */
      let descBefore: string | null = null
      if (flags['--desc'] !== undefined) {
        descBefore = ctx.deps.todoRepo.getById(id)?.description ?? ''
        const incoming = strValue(flags['--desc'])
        if (overwriteDesc || incoming.trim() === '') {
          // 显式替换，或显式清空 —— 两者都是"我就是要覆盖"
          patch.description = incoming
        } else {
          /**
           * 追加。格式刻意做成"原文 + 分隔线 + 带署名与时间的补充"：
           * 分隔线让"哪些是原文、哪些是后补的"一眼可分；
           * 署名与时间让人能追溯"这段是谁什么时候加的"——
           * 而这两件事正是她事故里最缺的（补完之后分不出哪段是谁写的）。
           */
          const prev = descBefore.trim()
          const who = resolveActor(ctx, flags['--created-by'])
          const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16)
          patch.description = prev
            ? `${prev}\n\n---\n补充（${who} · ${stamp}）：\n${incoming}`
            : incoming
        }
      }

      if (flags['--priority'] !== undefined) {
        patch.priority = flags['--priority'] as TodoPriority
      }

      if (flags['--due'] !== undefined) {
        const raw = strValue(flags['--due'])
        if (raw === 'clear' || raw === '') {
          patch.dueAt = null
        } else {
          const due = parseTime(raw)
          if (!due) throw new UsageError(`无法解析时间: ${raw}`)
          patch.dueAt = due
        }
      }

      // 提醒时间：与 --due 同一套写法（含 clear 清除），保持两个时间字段语义一致
      if (flags['--remind'] !== undefined) {
        const raw = strValue(flags['--remind'])
        if (raw === 'clear' || raw === '') {
          patch.remindAt = null
        } else {
          const remind = parseTime(raw)
          if (!remind) throw new UsageError(`无法解析时间: ${raw}`)
          patch.remindAt = remind
        }
      }

      if (flags['--category'] !== undefined) {
        const cats = ctx.deps.categoryRepo.list()
        const names = String(flags['--category'])
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
        /**
         * 与 add 不同：这里空串是合法的，意思是"清空标签"。
         * 但 repo 的 resolveCategoryIds 会把空回退到第一个分类，
         * 清不干净 —— 所以空的情况直接抛错，不假装成功。
         */
        if (!names.length) {
          throw new UsageError('--category 传空无法清空标签（待办至少要有一个标签）')
        }
        patch.categoryIds = names.map((name) => {
          const hit = cats.find((c) => c.name === name)
          if (!hit) {
            const available = cats.map((c) => c.name).join('、') || '（暂无分类）'
            throw new NotFoundError(
              `分类不存在: ${name}。已有分类：${available}。可复用，或先 category add 再改`
            )
          }
          return hit.id
        })
      }

      if (flags['--project'] !== undefined) {
        const raw = strValue(flags['--project']).trim()
        /**
         * 清空项目这条出口在 1.0.37 关掉了。
         *
         * 项目既然是必填，`--project clear` 就等于给必填开了个后门 ——
         * 绕过去比留空更糟：留空是没填，清空是**主动把已有的归属抹掉**，
         * 而看板上"这条属于哪个项目"的信息一旦丢了就找不回来。
         * 要换归属就写新项目名，别清。
         */
        if (raw === 'clear' || raw === '') {
          throw new UsageError(
            '项目不能清空（1.0.37 起为必填项）。要改归属请传新项目名：--project "项目名"'
          )
        }
        // 同 add：找不到**报错**，不再静默新建（1.0.40 与 add 一致收紧）
        patch.projectId = resolveProjectForWrite(
          ctx,
          raw,
          flags['--create-project'] === true
        )
      }

      /**
       * 挂父需求 / 摘出来。
       *
       * 为什么 add 有了还不够：agent 的实际工作顺序常常是「先记下来，回头发现
       * 它其实是某个父需求下的一步」。此前唯一的补救是删掉重建，而**重建会换 id**，
       * 已经指向它的引用全断 —— 与 update 存在的理由同一个。
       *
       * 前缀必须兑成完整 id，理由同 add：原始值塞进外键列会炸出
       * `FOREIGN KEY constraint failed`，既不说是哪个参数也不说怎么改。
       * 另外这里**额外挡住自己挂自己**：repo 没做这个校验，而自引用会让
       * 层级遍历（父需求 -> 子任务）在原地打转。
       */
      if (flags['--parent'] !== undefined) {
        const raw = strValue(flags['--parent']).trim()
        if (raw === 'clear' || raw === '') {
          // null = 摘出来变独立事项；repo 侧 parentId 三态里 null 即清空
          patch.parentId = null
        } else {
          let parentId: string
          try {
            parentId = ctx.deps.todoRepo.resolveId(raw)
          } catch {
            throw new NotFoundError(
              `父需求不存在: ${raw}。传完整 id 或其前缀，先用 \`todo list --brief\` 查准确认`
            )
          }
          if (parentId === id) {
            throw new UsageError('父需求不能是自己（会形成自引用层级）')
          }
          patch.parentId = parentId
        }
      }

      if (flags['--status'] !== undefined) {
        patch.status = flags['--status'] as TodoStatus
      }
      if (flags['--type'] !== undefined) {
        const t = flags['--type']
        if (!TYPES.includes(t as TodoType)) {
          throw new UsageError(`--type 只接受 ${TYPES.join('/')}，收到 ${String(t)}`)
        }
        patch.type = t as TodoType
      }

      // --owner 是旧参数名，映射到提出者
      const newCreatedBy = flags['--created-by'] ?? flags['--owner']
      if (newCreatedBy !== undefined) {
        const v = strValue(newCreatedBy).trim()
        if (!v) throw new UsageError('--created-by 不能为空')
        // 冒名治理第 1 层（1.0.109，`b95e6bbb`）：两个说法矛盾时拦下，并指路 --executed-by
        assertCreatedByNotImpersonating(ctx, v)
        patch.createdBy = v as TodoOwner
      }

      if (flags['--executed-by'] !== undefined) {
        const raw = strValue(flags['--executed-by']).trim()
        // clear = 清掉指派，回到提出者执行（executedBy 落 NULL）
        if (raw === 'clear') {
          patch.executedBy = null
        } else {
          if (!raw) throw new UsageError('--executed-by 不能为空；要清掉指派请传 clear')
          patch.executedBy = raw as TodoOwner
        }
      }

      /**
       * 验收者（1.0.67，`a6032512`）—— 谁判断这件事做完了、可以收口
       *
       * ⚠️ **与 --executed-by 不同**：这里没有 `clear`。
       * 执行者可以是"没有显式指派"（null = 提出者执行），那是有意义的一态；
       * 而验收者**永远有一个**（默认提出者，schema 26 起 NOT NULL 语义）——
       * 留空会让"验收者 ≠ 执行者"这条守卫无从判断，等于闸门失效。
       * 要改回默认就传提出者的值。
       */
      if (flags['--verifier'] !== undefined) {
        const raw = strValue(flags['--verifier']).trim()
        if (!raw) throw new UsageError('--verifier 不能为空；它总是有值的（默认即提出者）')
        patch.verifier = raw as TodoOwner
      }

      /**
       * 解决于版本：字符串 = 标注，clear / 空串 = 清掉标注（三态里的 null 分支）。
       * 与 --executed-by 同一套写法 —— 清空类参数在 CLI 里统一用 `clear`。
       *
       * `unset` / `any` 是 **list 侧**的关键字，写侧出现只会造出一个
       * 名字叫 "unset" 的版本 —— 之后按版本筛选时会冒出一个谁也看不懂的选项。
       * 挡下来并指路（要清标注是 `clear`）。
       */
      if (flags['--fixed-in'] !== undefined) {
        const raw = strValue(flags['--fixed-in']).trim()
        if (raw === 'unset' || raw === 'any') {
          throw new UsageError(
            `--fixed-in ${raw} 是 list 侧的筛选关键字，不是版本号。` +
              '要清掉标注请传 clear；要标版本请传版本号（如 1.0.59）'
          )
        }
        patch.fixedInVersion = raw === 'clear' || raw === '' ? null : raw
      }

      /**
       * 乐观锁（1.0.73，`9947bf5a`）
       *
       * ⚠️ **不能写进 `patch`**：`patch` 是"要改的字段"，
       * 而它一个字段都不改 —— 它是**这次改动的前提条件**。
       * 塞进去的话下面那条 `changed` 检查会把它当成"改了东西"，
       * 于是 `todo update <id> --if-updated-at X`（没有任何真改动）
       * 会被放行成一次"成功但什么都没改"—— 正是这个方法反复在治的那类假成功。
       *
       * 用 `strValue` 收下并 trim：`--if-updated-at` 后面跟空串是无意义的，
       * 而空串会让比对永远失败（报一个查不出原因的冲突）。宁可在这里明确拦下。
       */
      let ifUpdatedAt: string | undefined
      if (flags['--if-updated-at'] !== undefined) {
        const raw = strValue(flags['--if-updated-at']).trim()
        if (!raw) {
          throw new UsageError(
            '--if-updated-at 不能为空；它要的是 `todo get <id>` 回执里的 updatedAt 原值。' +
              '不带这个参数就是不做乐观锁检查'
          )
        }
        ifUpdatedAt = raw
      }

      /**
       * 一个可改字段都没给就报错，而不是"成功但什么都没改"。
       *
       * 后者最坑：调用方看到 ok:true 以为改了，实际数据没动，
       * 而且这类错误在批量执行里会静默扩散到几十条命令。
       *
       * ⚠️ `--if-updated-at` **不算**"可改字段"（它只是前提条件），
       * 所以这里只看 `patch` —— 只带它不带任何真改动，就该报这个错。
       */
      const changed = Object.keys(patch).filter((k) => k !== 'id')
      if (!changed.length) {
        throw new UsageError(
          '至少要指定一个要改的字段：--title / --desc / --priority / --due / --remind / --category / --project / --parent / --status / --type / --created-by / --executed-by / --fixed-in'
        )
      }

      /**
       * 动作人 = 谁在操作，不是这条是谁提的。
       * 优先取调用身份（DESKPARTNER_AGENT 环境变量，两通道都会带进 ctx.actor）；
       * 没设时向后兼容旧的 --created-by 声明习惯。此前这里不传 --created-by 就记 NULL，
       * 主用户看到的"这条流转没登记是谁操作的"就是这么来的。
       */
      patch.actor = resolveActor(ctx, flags['--created-by'])

      // 同上：写入前校验身份（动作人声明了 agent 身份就必须已注册）
        assertRegisteredActor(ctx, patch.actor)
        assertRegisteredActor(ctx, patch.createdBy)

        /**
         * 理由先写，状态后改（1.0.68，`20aee7a4`）
         *
         * ⚠️ **顺序不能反**：状态若被守卫拦下（G4/G10 等），
         * 评论已经写上了而状态没动 —— 那正是本项目反复在治的
         * **"看起来成功其实没成"**。
         * 反过来（状态已改、评论写失败）更糟：理由永久缺失。
         *
         * ⚠️ 还要拦一种用法：**没改任何东西却带 --comment** ——
         * 那说明调用方以为"写个理由就算记录了"，而实际什么都没发生。
         */
        const commentBody = flags['--comment'] ? String(flags['--comment']).trim() : ''
        /**
         * 判"真的改了东西"。id / source / actor / preApprovedGrantId
         * 都是身份或通道事实（不落库、不算字段变更），不能顶成"改了东西"——
         * 与上面 `changed` 检查同一条判据（实测通道字段混进来吞过 3 条报错）。
         */
        const touched = Object.keys(patch).some(
          (k) =>
            k !== 'id' &&
            k !== 'source' &&
            k !== 'actor' &&
            k !== 'preApprovedGrantId' &&
            patch[k as keyof UpdateTodoInput] !== undefined
        )
        if (commentBody && !touched) {
          throw new UsageError(
            '--comment 只在这次调用真的改了东西时才写；' +
              '你只带了 --comment 而没改任何字段 —— 那等于什么都没发生。' +
              '若只想追加一条评论，用 `todo comment`。'
          )
        }
        /**
         * 通道事实在这里合并进调用入参（`ifUpdatedAt` / `preApprovedGrantId`）——
         * 两者都由 repo 作入参处理（不落库、不算字段变更），
         * 都**不许**进 `patch`（进了会让"一个字段都不改"的检查把通道当改动）。
         * 乐观锁冲突时抛出 ConflictError，由上面那层归类成 exit 5 / `conflict`。
         */
        const updated = ctx.deps.todoRepo.update({
          ...patch,
          ...(ifUpdatedAt !== undefined ? { ifUpdatedAt } : {}),
          ...(ctx.preApprovedGrantId !== undefined
            ? { preApprovedGrantId: ctx.preApprovedGrantId }
            : {})
        })

        /**
         * 理由**在状态成功之后**才写（1.0.68）
         *
         * ⚠️ **我第一版把顺序写反了，闸门当场抓住**：
         * 我以为守卫在 CLI 层、所以先写评论再改状态更安全 ——
         * **错。G4/G10 那些守卫在  内部**，
         * 也就是说**评论先写、然后 update 才被拦下**，
         * 结果是「状态没改成、评论却留下了」——
         * **那正是本项目反复在治的看起来记录了其实没成。**
         *
         * ⇒ 正确顺序：**先 update（它抛错就什么都没发生），成功后才写评论。**
         * 代价：状态改了但评论写失败时理由会缺 ——
         * 但那种情况比假装记下了好得多。
         */
        if (commentBody) {
          ctx.deps.commentRepo.create({
            todoId: id,
            body: commentBody,
            authorType: patch.actor === 'human' ? 'human' : 'agent',
            authorId: patch.actor,
            kind: 'comment'
          })
        }

      /**
       * 描述变更纳入审计（1.0.49，修主用户 fa608cb9）
       *
       * 她事故里最致命的一层是"**不可恢复**"：描述字段不在审计范围内，
       * 冲掉之后只能靠碰巧存在的历史快照救。原话：
       * 「最后是靠 12:36 那份 user.db.backup-v19 快照手工读出原文」——
       * 也就是说，能不能救回来**取决于运气**。
       *
       * 这里把 before/after 落进 events（按 10 个 id 前缀查命中 0 行
       * 正是她当时的取证结论）。存的是**完整正文**而不是长度或摘要：
       * 摘要在"想找回原文"的场景里没有用，而这条记录存在的唯一理由
       * 就是找回原文。
       *
       * 只在真的变了才记 —— 描述没动时不该产生噪音。
       */
      const descEvent = buildDescChangeEvent(descBefore, patch.description)
      if (descEvent) {
        try {
          ctx.deps.events.append('todo', patch.actor ?? 'cli', {
            cmd: 'todo update',
            id: updated.id,
            ...descEvent
          })
        } catch {
          // 审计写不进去不能让命令失败 —— 但也不静默（见下面的 notice 兜底）
        }
      }

      /**
       * G3（软约束）：agent 把父需求转「待验收」但既没写描述、又没留评论时，
       * 给一句提醒而不是拒绝 —— 硬拦会把"补个错字"这类正当修改也挡住。
       * 真正的硬约束（子任务全部完成）已在 repo 层拦截。
       *
       * 1.0.54 起收口结论改走**评论**（主用户 2026-09-28 拍板 5b385d19 选②）：
       * 边界只留一条「描述=规格、往来=评论」，所以"有没有交代"要
       * **描述与评论一起看** —— 只看描述会把"已经写了评论"的正常交付误报。
       */
      if (
        patch.status === 'awaiting_review' &&
        updated.parentId === null &&
        !updated.description?.trim() &&
        ctx.deps.commentRepo.countByTodo(updated.id) === 0
      ) {
        return { __notice: AWAITING_REVIEW_HINT, data: { ...updated, changed } }
      }

      /**
       * G5：谁都能置 done，但没留下**带结构性要素的**收口结论就提醒一句（不拦）。
       *
       * 1.0.110 起判据从"有没有评论"升级为"结论里有没有结构"（收 `eec2e1e7`）；
       * 这里判的是"描述 ∪ 评论"，所以刚写的 `--comment` 也在被判的文本里 ——
       * 这是有意的：一次调用里同时给理由和状态，理由就是这次的收口结论。
       */
      if (patch.status === 'done' && missingClosure(ctx, updated.description, updated.id)) {
        return { __notice: DONE_HINT, data: { ...updated, changed } }
      }

      /**
       * 描述长度骤降的软提醒（1.0.49，修主用户 fa608cb9）
       *
       * 这是三层修复里的第 3 层，也是最容易被忽略的一层：
       * 语义改成追加、审计能找回原文之后，**调用方仍然可能不知道自己
       * 刚刚抹掉了多少字** —— 回执只写 `changed:["description"]`。
       *
       * 阈值取 30%：与她的建议一致（「新值不足旧值 30%」）。
       * 为什么是这个数：正常补充会让描述变长；正常精简很少一次砍掉
       * 七成以上。跨过这条线的大多是"本想追加却写成了替换"。
       *
       * 与 G3/G5 同机制：只出现在成功响应的顶层 `notice`，
       * **不拦执行、不改退出码** —— 覆写是合法操作，只是不能悄悄发生。
       */
      if (
        descBefore !== null &&
        descBefore.trim().length > 0 &&
        updated.description !== null &&
        updated.description.length < descBefore.trim().length * 0.3
      ) {
        const oldLen = descBefore.trim().length
        const newLen = updated.description.length
        return {
          __notice: DESC_SHRINK_HINT.replace('%OLD%', String(oldLen))
            .replace('%NEW%', String(newLen))
            .replace('%PCT%', String(Math.round((newLen / oldLen) * 100))),
          data: { ...updated, changed }
        }
      }

      /**
       * G7（软提醒）：描述被改完后，若这条**处在「待确认」列**，自检要素是否齐。
       *
       * 与上面的长度骤降提醒并列而不互相覆盖：这里放在**最后**，
       * 只在前面没有更具体的提醒时才说话（更具体的提醒信息量更大）。
       */
      if (updated.status === 'proposed') {
        const g7 = proposedDescNotice(updated.description)
        if (g7) return { __notice: g7, data: { ...updated, changed } }
      }

      return { ...updated, changed }
    }
  },
  {
    name: 'todo done',
    dataShape: 'object',
    desc: '把待办标记为已完成',
    args: [],
    positional: { name: 'id', required: true, desc: '待办 ID' },
    run: (ctx, _flags, positional) => {
      const input = positional[0]
      if (!input) throw new UsageError('缺少待办 id')
      // 支持 id 前缀：前 8 位就够定位，不必每次先 list 拿全串
      const id = ctx.deps.todoRepo.resolveId(input)
      const updated = ctx.deps.todoRepo.update({
        id,
        status: 'done',
        actor: actorOf(ctx),
        preApprovedGrantId: ctx.preApprovedGrantId
      })

      /**
       * G5：同上 —— 送进 done 可以，但得说清为什么算完了。
       *
       * ⚠️ 这条（`todo done`）此前**只看描述、完全不看评论**，于是同一条闸门
       * 在两条路上两个判据（`todo update --status done` 看描述+评论、这里只看描述），
       * 一张"描述空但评论里写了四段收口"的卡走这条会被白念一句。
       * 1.0.110 起两处共用 `missingClosure`（收 `eec2e1e7`）。
       */
      if (missingClosure(ctx, updated.description, updated.id)) {
        return { __notice: DONE_HINT, data: updated }
      }
      return updated
    }
  },
  {
    /**
     * 置顶。
     *
     * 数据层（todos.is_pinned）和界面置顶早就有了，缺的只是 CLI 出口 ——
     * agent 明明知道哪条最要紧，却没法把它顶上来。
     */
    name: 'todo pin',
    dataShape: 'object',
    desc: '把待办置顶（排序时置顶项永远在前）',
    args: [{ flag: '--off', type: 'boolean', desc: '传了就是取消置顶' }],
    positional: { name: 'id', required: true, desc: '待办 ID（支持前缀）' },
    run: (ctx, flags, positional) => {
      const input = positional[0]
      if (!input) throw new UsageError('缺少待办 id')
      const id = ctx.deps.todoRepo.resolveId(input)
      const updated = ctx.deps.todoRepo.update({ id, isPinned: !flags['--off'] })
      return { id: updated.id, title: updated.title, isPinned: updated.isPinned }
    }
  },
  {
    name: 'todo unpin',
    dataShape: 'object',
    desc: '取消置顶（等价于 todo pin --off）',
    args: [],
    positional: { name: 'id', required: true, desc: '待办 ID（支持前缀）' },
    run: (ctx, _flags, positional) => {
      const input = positional[0]
      if (!input) throw new UsageError('缺少待办 id')
      const id = ctx.deps.todoRepo.resolveId(input)
      const updated = ctx.deps.todoRepo.update({ id, isPinned: false })
      return { id: updated.id, title: updated.title, isPinned: updated.isPinned }
    }
  },
  {
    /**
     * 删除 = destructive 档（1.0.36）：**每次都要**单独点头，用掉即止。
     *
     * 写入批准只说明"我信得过你会往里加东西"，不代表"你可以随便扔"。
     * 数据没了就没了，而 agent 特别容易走"删了重建"这条路
     * （它手边没有界面可点，重建看着比修改干净）——
     * 正好是这一档最该拦住的姿势。
     */
    name: 'todo rm',
    dataShape: 'object',
    risk: 'destructive',
    desc: '删除待办',
    args: [
      {
        flag: '--yes',
        type: 'boolean',
        desc: '确认删除。CLI 不做交互式提问，缺这个参数直接报错'
      },
      {
        flag: '--force',
        type: 'boolean',
        desc: '有子任务时仍然删除。不加会被拦下并告知会解绑几个 —— 那是让你先知道再决定'
      }
    ],
    positional: { name: 'id', required: true, desc: '待办 ID' },
    run: (ctx, flags, positional) => {
      const input = positional[0]
      if (!input) throw new UsageError('缺少待办 id')
      const id = ctx.deps.todoRepo.resolveId(input)
      if (!flags['--yes']) {
        throw new UsageError('删除是破坏性操作，需显式加 --yes（CLI 不会停下来问你）')
      }

      /**
       * 有子任务时**先拦下**，而不是删完才说。
       *
       * 子任务不会跟着消失，只会解绑成孤儿（parent_id 是 ON DELETE SET NULL）——
       * 删完才告知"刚才解绑了 N 个"是事后诸葛，agent 根本无从选择。
       * 必须先知道、再决定：拦一次，确认要删就显式加 --force。
       */
      const children = ctx.deps.todoRepo.childCount(id)
      if (children > 0 && !flags['--force']) {
        throw new UsageError(
          `这条还有 ${children} 个子任务，删除会让它们解绑（子任务本身保留，但不再挂在它下面）。` +
            `确认要删请加 --force；想先看是哪几条，用 \`todo children <id>\``
        )
      }

      // 删除留痕：动作人取本次调用的身份，事后才知道是谁删的
      // preApprovedGrantId（f5e76697）：人已批准这次删除时带上，G4 据此放行
      //（088282b2 承诺「批准后当场执行」，此前回放被断言拦下 = 假承诺）
      ctx.deps.todoRepo.delete(id, 'cli', ctx.actor ?? 'human', ctx.preApprovedGrantId)

      return {
        id,
        deleted: true,
        ...(children > 0
          ? {
              unlinkedChildren: children,
              note: `它关联的 ${children} 个子任务已解绑 —— 子任务保留，但不再挂在它下面`
            }
          : {})
      }
    }
  },
  {
    /**
     * todo history：一条事项的状态流转历史
     *
     * 为什么必须有这条命令（Bob 777eaf34 实测）：
     * v14 已经在记 todo_transitions，界面动态页也在读它，但 CLI 一个查询口都没有 ——
     * 库里有历史、agent 拿不到。结果是它只能靠推测写反馈："我以为我关掉了那几条，
     * 实际上无从核对谁在什么时候把它们拖去了哪一列"。
     * 审计能力只做一半，等于让 agent 用猜的来补另一半。
     *
     * 与动态页同源（同一个 repo 方法），不另立一套口径。
     */
    name: 'todo get',
    dataShape: 'object',
    readOnly: true,
    /**
     * 按 id 读**一条**完整事项（1.0.49，修 85740f50）
     *
     * ── 为什么这个命令必须存在 ──
     *
     * telemetry 实测：`todo get` 被调用 11 次、**全部失败**，因为这个命令
     * 此前不存在（`help` 的 38 条里没有它）。也就是说 agent 拿到接口后的
     * 第一直觉就是"按 id 读一条"，撞墙之后才改用 `todo list` 加过滤。
     *
     * 这不是谁笨 —— 是**接口形状跟直觉不符**：`todo history`、`todo children`
     * 都有了，唯独缺最基础的单条读取。命令表该顺着使用者的直觉长，
     * 而不是要求使用者先背下"这里只有 list"。
     *
     * 顺带把"一条事项的完整上下文"一次给全：基本信息 + 标签名 +
     * 子任务进度 + 流转历史。此前要看全得连发 3~4 条命令（list 找 id、
     * children 看子任务、history 看流转），每条都要重新寻址一次。
     */
    desc: '按 id 读一条事项的完整信息（基本信息 + 标签名 + 子任务进度 + 最近流转）',
    args: [
      {
        flag: '--transitions',
        type: 'string',
        desc: '附带多少条最近的流转记录（默认 5，传 0 表示不带）'
      }
    ],
    positional: { name: 'id', required: true, desc: '待办 ID（支持前缀）' },
    run: (ctx, flags, positional) => {
      const input = positional[0]
      if (!input) throw new UsageError('缺少待办 id')
      /**
       * 与 `todo history` 同一口径：已删条目也要读得到墓碑（1.0.60）。
       *
       * 驳回单里点名的是**两条命令**：「`todo history` 与 `todo get` 在
       * getById 落空时改走 findDeletedSnapshot」。只修 history 会留下
       * 半截修复 —— agent 最常用的其实是 `get`，它照样回 not_found。
       */
      const id = ctx.deps.todoRepo.resolveId(input, { allowDeleted: true })
      const todo = ctx.deps.todoRepo.getById(id)

      if (!todo) {
        const tomb = ctx.deps.todoRepo.findDeletedSnapshot(id)
        if (tomb) {
          return {
            id,
            deleted: true,
            deletedAt: tomb.deletedAt,
            deletedBy: tomb.actor,
            lastSnapshot: tomb.snapshot,
            transitions: tomb.transitions,
            audit: buildTodoAudit(id),
            message:
              `这条事项已被删除（${tomb.deletedAt}，操作者 ${tomb.actor}）。` +
              '上面是删除当时的快照与流转记录 —— 误删的话可以照它恢复。'
          }
        }
        throw new NotFoundError(`待办不存在: ${id}`)
      }

      const limitRaw = flags['--transitions']
      const limit = limitRaw === undefined ? 5 : Number(limitRaw)
      if (!Number.isFinite(limit) || limit < 0) {
        throw new UsageError(`--transitions 需要非负整数，收到「${String(limitRaw)}」`)
      }

      /** 标签名：库里存的是 id，只给 id 等于让人再查一遍 */
      const catNames = ctx.deps.categoryRepo.list()
      const categories = todo.categoryIds
        .map((cid) => catNames.find((c) => c.id === cid)?.name)
        .filter((n): n is string => Boolean(n))

      const project = todo.projectId
        ? (ctx.deps.projectRepo.list().find((p) => p.id === todo.projectId)?.name ?? null)
        : null

      const children = ctx.deps.todoRepo.listChildren(todo.id)
      const allTransitions = ctx.deps.todoRepo.listTransitions(todo.id)
      const transitions = limit > 0 ? allTransitions.slice(-limit) : []

      return {
        ...todo,
        /** 覆盖 categoryIds 之外再给可读的名字，免得调用方自己映射 */
        categoryNames: categories,
        projectName: project,
        childCount: children.length,
        childDone: children.filter((c) => c.status === 'done').length,
        /** 流转总数与"带了哪几条"分开给，调用方才知道有没有被截断 */
        transitionTotal: allTransitions.length,
        transitions: transitions.map((t) => ({
          from: t.fromStatus,
          to: t.toStatus,
          actor: t.actor,
          at: t.createdAt,
          /**
           * 这次退回是不是驳回（1.0.72）。
           *
           * ⚠️ 这是**第三个**流转映射点，前两处（`todo history` / `ipc` 的
           * `todo:timeline`）我都改了、这里漏了 —— 而它恰恰是 agent 读
           * "这条卡经历过什么"最常用的那条命令。
           *
           * 教训写进闸门了：手工挑字段的映射点**不止一处**，
           * 找齐的办法是 grep 字段名逐个看，不是改到我记得的那处。
           */
          isRejection: t.isRejection
        })),
        /**
         * 评论线程（1.0.54）：规格在 description，往来在评论。
         * 一次给全，agent 不必再发第二条命令 —— `todo get` 的定位就是
         * "一条事项的完整上下文"（见本命令开头的注释）。
         */
        comments: ctx.deps.commentRepo.listByTodo(todo.id).map((c) => ({
          id: c.id,
          parentId: c.parentId,
          authorType: c.authorType,
          author: c.authorId,
          kind: c.kind,
          body: c.body,
          at: c.createdAt
        }))
      }
    }
  },
  {
    name: 'todo history',
    dataShape: 'object',
    readOnly: true,
    desc: '查一条事项的状态流转历史：谁在什么时候把它从哪一列挪到了哪一列',
    args: [{ flag: '--limit', type: 'string', desc: `最多返回多少条（默认全部，按时间正序）；${LIMIT_ZERO_DOC}` }],
    positional: { name: 'id', required: true, desc: '待办 ID（支持前缀）' },
    run: (ctx, flags, positional) => {
      const input = positional[0]
      if (!input) throw new UsageError('缺少待办 id')
      /**
       * ⚠️ `allowDeleted: true` 是这里的关键（1.0.60）。
       *
       * 墓碑分支写了很久（1.0.52 起），但**从来没被执行过** ——
       * `resolveId` 对已删 id 会直接抛 "待办不存在"，命令在下一行就炸了，
       * 下面 `if (!todo)` 那段形同虚设。
       * 只读路径允许解析墓碑，写路径（update/comment/rm）一律不允许。
       */
      const id = ctx.deps.todoRepo.resolveId(input, { allowDeleted: true })
      const todo = ctx.deps.todoRepo.getById(id)

      /**
       * 删除留痕 ③（2026-09-28）：已删的条目不再只回"不存在"。
       *
       * 删除前写下的快照（见 todoRepo.delete）在这里被读回来 ——
       * 谁删的、什么时候、当时什么状态，都还在。
       * 这比"一句 not_found"有用得多：误删能定位，争议能说清。
       */
      if (!todo) {
        const tomb = ctx.deps.todoRepo.findDeletedSnapshot(id)
        if (tomb) {
          return {
            todoId: id,
            deleted: true,
            deletedAt: tomb.deletedAt,
            deletedBy: tomb.actor,
            lastSnapshot: tomb.snapshot,
            transitions: tomb.transitions,
            /* 已删条目同样要"读得出"它的审计（1.0.60）—— 墓碑之外还发生过什么 */
            audit: buildTodoAudit(id),
            message:
              `这条事项已被删除（${tomb.deletedAt}，操作者 ${tomb.actor}）。` +
              '上面是删除当时的快照与流转记录 —— 误删的话可以照它恢复。'
          }
        }
        throw new NotFoundError(`待办不存在: ${id}`)
      }

      const all = ctx.deps.todoRepo.listTransitions(id)
      /** 解析交给族内唯一一处（`8d78af0d`）：`--limit 0` 与不传同义（全部，按时间正序） */
      const limit = parseLimit(flags['--limit'], 'todo history') ?? 0
      const rows = limit > 0 ? all.slice(-limit) : all

      return {
        todoId: todo.id,
        todoTitle: todo.title,
        status: todo.status,
        /** 没有流转记录 = 建好后从没被挪过（v14 之前建的也可能如此），不是查失败 */
        total: all.length,
        transitions: rows.map((t) => ({
          from: t.fromStatus,
          to: t.toStatus,
          actor: t.actor,
          at: t.createdAt,
          /**
           * 这次「待验收 → 进行中」是不是驳回（1.0.72）。
           *
           * ⚠️ 这是同一个疏漏的**第三处**（另两处：ipc.ts 的 todo:timeline、
           * 以及最初漏掉的映射）。三处都手工挑字段、都只挑了旧的四个。
           *
           * 为什么它对 agent 特别重要：这就是"被驳回"的**可编程**信号。
           * agent 读 `from=awaiting_review, to=in_progress` 无法判断是驳回
           * 还是执行方自己收回 —— 而这两件事要求它做的事完全相反。
           * 字段名与主进程一致（`isRejection`），不做二次翻译。
           */
          isRejection: t.isRejection
        })),
        /**
         * 审计事件（1.0.60，主用户驳回 68c7ccc1）
         *
         * ── 为什么加这一段 ──
         *
         * 她的驳回原话：「留痕写进去了，但**没有任何地方读得出**，实际效果
         * 仍是无痕」。验收判据是：「`todo history` 能看到'某某在何时删了
         * 哪条评论'，不需要碰数据库」。
         *
         * 现实是：`comment_deleted` / `todo_deleted` 这两类审计事件
         * 从 1.0.52 / 1.0.55 起就一直在**如实写入**（payload 里带着完整的
         * 被删内容），但 events 表当时只有"给轮询用的增量读法"（`listSince`），
         * **没有任何面向回溯的读入口** —— 所以"写入侧有、读取侧为零"，
         * 效果上等同于没留痕。
         *
         * 这里把 `listForTodo` 的结果翻译成人话摊开：谁、何时、对什么东西
         * 做了什么。删除类事件连**被删的内容**一起给出来 —— 只说
         * "某条评论被删了"仍然没法对证，得看到删掉的是哪句话。
         */
        audit: buildTodoAudit(id),
        auditNote:
          '审计事件有保留策略（7 天 / 2000 条），更早的记录可能已被清理；' +
          '它是审计线索不是备份。'
      }
    }
  },
  {
    /**
     * 展开一个父任务的子任务。
     *
     * 卡片上只有"几条子任务"这个数字，看不到是哪几条 ——
     * 而这个产品最常见的工作方式就是 agent 把大任务拆成子任务，
     * 人要看的恰恰是"具体拆了什么、各做到哪一步"。
     */
    name: 'todo children',
    dataShape: 'object',
    readOnly: true,
    desc: '列出某条事项的直接子任务（含各自状态）',
    args: [],
    positional: { name: 'id', required: true, desc: '父任务 ID（支持前缀）' },
    run: (ctx, _flags, positional) => {
      const input = positional[0]
      if (!input) throw new UsageError('缺少待办 id')
      const id = ctx.deps.todoRepo.resolveId(input)
      const parent = ctx.deps.todoRepo.getById(id)
      if (!parent) throw new NotFoundError(`待办不存在: ${id}`)

      const children = ctx.deps.todoRepo.listChildren(id)
      const doneCount = children.filter((c) => c.status === 'done').length

      return {
        parentId: parent.id,
        parentTitle: parent.title,
        total: children.length,
        done: doneCount,
        children: children.map((c) => ({
          id: c.id,
          title: c.title,
          status: c.status,
          createdBy: c.createdBy,
          executedBy: c.executedBy
        }))
      }
    }
  },
]

export const todoOwnerCommands: CommandSpec[] = [
  {
    name: 'todo set-owner',
    dataShape: 'object',
    desc: '修改待办的提出者（登记时忘了带 --created-by 时的补救手段）',
    args: [
      {
        flag: '--owner',
        type: 'string',
        required: true,
        desc: '新的提出者，如 agent:alice 或 human'
      }
    ],
    positional: { name: 'id', required: true, desc: '待办 ID' },
    run: (ctx, flags, positional) => {
      // 支持 id 前缀：与其它 todo 命令一致，此前漏了这层（bob 实测报的）
      const raw = positional[0]
      if (!raw) throw new UsageError('缺少待办 id')
      const id = ctx.deps.todoRepo.resolveId(raw)
      const owner = String(flags['--owner'] ?? '').trim()
      if (!owner) throw new UsageError('--owner 不能为空')

      const updated = ctx.deps.todoRepo.update({
        id,
        createdBy: owner as TodoOwner,
        actor: actorOf(ctx)
      })
      return { id: updated.id, title: updated.title, createdBy: updated.createdBy }
    }
  },
]
