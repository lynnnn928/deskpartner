/**
 * 消息与提醒命令（1.0.112 域切，卡 d1b71d28）
 *
 * 从 `command-table.ts` 里**整块搬来**的，条目逐字节未改 —— 参数声明与 `run` 都在
 * 这里，`schema` 直接序列化它（接口文档不可能与实现脱节）。
 *
 * ⚠️ 数组**顺序是外部契约**的一部分：`dp help` 的排列、`dp schema` 的命令清单、
 * MCP `tools/list` 的工具顺序都由 `command-table.ts` 里那张表的顺序决定。
 *
 * ⚠️ 为什么这个文件导出**多段**：原表里它们被别的域隔开（不是按域连续排的），
 *    而顺序不能改。各段在 `command-table.ts` 的聚合处按原次序展开：
 *      · notificationCommands
 *      · reminderCommands
 *      · memoCommands
 */

import { NotFoundError, UsageError } from '../../lib/domain-errors'
import { LIMIT_ZERO_DOC, parseLimit, parseOffset, takeLimit } from '../command-text'
import { actorOf } from '../command-core'
import type { CommandSpec } from '../command-core'
import { buildSessionReminder } from '../command-exec'

export const notificationCommands: CommandSpec[] = [
  {
    /**
     * notification list（2026-09-28，D 方案）：**把通知收件箱开放给 agent**。
     *
     * 此前通知中心只有 GUI 能看，agent 一条命令都读不到 ——
     * 于是"验收被驳回""有待表态申请"这类事，执行方只能靠逐条翻描述才发现
     * （主用户实测提出的就是这个口子）。现在 agent 也能拉清单。
     *
     * ⚠️ **1.0.112（卡 `69788c32`）推翻了原先"不往 CliDeps 里塞 notificationRepo"
     * 的决定**。当时的理由是"它有 4 处构造点，改接口要动一堆"，可命令层实际只有 2 处；
     * 更要紧的是那条唯一能证明接线正确的判据 —— **注入进去的实例必须真收到调用** ——
     * 命令体自己 `new` 的时候根本不成立（用例里塞的 `notificationRepo` 是空的，
     * 却没人发现）。现在构造点只剩接线处：`index.ts` 两条通道 + `ipc.ts` 批准回放。
     */
    name: 'notification list',
    dataShape: 'object',
    readOnly: true,
    desc: '查通知收件箱（agent 也能看）：谁交付了什么、谁驳回了什么、什么在等你拍板',
    args: [
      {
        flag: '--type',
        type: 'string',
        desc: 'reminder / grant / exec_result / memo / review / decision（decision = 事项进了待确认列，等你拍板）'
      },
      { flag: '--unread', type: 'boolean', desc: '只看未读' },
      { flag: '--limit', type: 'string', desc: `最多几条（默认 20）；${LIMIT_ZERO_DOC}` },
      { flag: '--offset', type: 'string', desc: '从第几条开始（默认 0）；上一页回执里的 nextOffset 就是这一页该传的值' },
      {
        flag: '--to-me',
        type: 'boolean',
        desc:
          '**只看待在我这儿**（1.0.68）。与 --unread **正交**："给我的" ≠ "我还没看"。' +
          '此前未读位是全局一份，**A 读�� B 就当已读**'
      },
      {
        flag: '--ack-mine',
        type: 'boolean',
        desc: '按**我读过**记一次（1.0.68）。不动全局已读位 —— 否则两个 agent 会互相清掉未读'
      }
    ],
    run: (ctx, flags) => {
      const me = actorOf(ctx)
      /**
       * 读窗口与筛选的**顺序**（1.0.107，修 `329c7bab`）
       *
       * 此前是"先取最新 200 条 → 再按 `--type`/`--unread` 过滤 → 再按 `--limit` 收窄"，
       * 于是三件事同时在坏、而且**回执里都看不出来**：
       *
       * - 窗口写死在 `list(200)`：要 500 条也只回 200 条；
       * - 筛选落在窗口**之内**：`--type memo` 实际是"最新 200 条里的 memo"。实测副本
       *   （有效通知 487 条、其中 memo 308 条）回 21 条、`total` 也是 21 ——
       *   看着像"一共就 21 条"；
       * - 计数与列表不同源：`unreadCount()` 走全表、列表走窗口，
       *   同一条回执里 `unread: 467` 而只列 180 条。
       *
       * 现在：筛选（type / unread / to-me）下推到 SQL（`listPage`），
       * `limit` / `offset` 只负责收窗口，并把 `matched`/`truncated`/`nextOffset`
       * 一并给出 —— 与 `todo list` 同一套"看得见还有没有更多"的读法。
       */
      const limit = parseLimit(flags['--limit'], 'notification list') ?? 20
      const offset = parseOffset(flags['--offset'], 'notification list')
      const type = flags['--type'] ? String(flags['--type']) : null
      const unreadOnly = flags['--unread'] === true

      const repo = ctx.deps.notificationRepo
      /**
       * `--to-me` 与 `--ack-mine`（1.0.68，`3c436592` 第 2 环）
       *
       * ⚠️ **为什么走 `read_by` 而不是全局 `status`**：
       * `status`/`read_at` 是**界面铃铛**用的（"人看过了没"）。
       * 而 agent 之间要的是"**我**看过了没" ——
       * Bob读一条，不该让 alice 的未读数少一个。
       * 共用全局位就会互相覆盖，**两个 agent 交替读时未读数只对最后一个读者成立**。
       */
      const ackMine = flags['--ack-mine'] === true
      const forMe = flags['--to-me'] === true || ackMine
      /**
       * `--unread` 按 `--to-me` 分两种口径（1.0.68 的判据，搬家时**原样保留**）：
       * - 不带 `--to-me`：全局未读（`status`，与界面铃铛同口径）
       * - 带 `--to-me`：**我还没看过**（`read_by` 里没有我）
       */
      const unreadFilter = {
        unread: forMe ? ('mine' as const) : ('global' as const),
        ...(forMe ? { reader: me } : {})
      }
      const filters = {
        ...(forMe ? { recipientFor: me } : {}),
        ...(type ? { type } : {})
      }
      const unreadQuery = { ...filters, ...unreadFilter }
      /**
       * ⚠️ `--ack-mine` **也算**"我还没看过"这一路：旧实现里它在 `--unread` 之外
       * **另行**过滤了一遍"我没确认过的"（然后是"只确认本次返回的"）。
       * 这条口径原样保留 —— 否则 `--ack-mine` 反复调用会一直回同一批已确认的，
       * "知晓"这件事就没有终点了。
       */
      const pageQuery = unreadOnly || ackMine ? unreadQuery : filters
      const page = repo.listPage({
        ...pageQuery,
        offset,
        // `--limit 0` = 不收窄（全族同一个含义）—— 窗口现在真的可全量，这条命令也归队
        ...(limit > 0 ? { limit } : {})
      })
      const rows = page.rows
      /**
       * 命中集合里未读的条数 —— **与列表同一批筛选**（`--unread` 那条路下等于 `matched`）。
       *
       * ⚠️ 必须在 `markReadBy` **之前**算：ack 会改 `read_by`，之后再算就不是
       * "你刚看到的这一批"了。
       */
      const unreadMatched = unreadOnly ? page.matched : repo.countPage(unreadQuery)
      if (ackMine) {
        // 只确认本次实际返回的通知，不能把被 limit 截掉、尚未看到的记录也标为知晓。
        for (const n of rows) {
          repo.markReadBy(n.id, me)
          const readers = (n.readBy ?? '')
            .split(',')
            .map((x) => x.trim())
            .filter(Boolean)
          if (!readers.includes(me)) readers.push(me)
          n.readBy = readers.join(',')
        }
      }
      const returned = rows.length
      const truncated = offset + returned < page.matched

      return {
        /**
         * ⚠️ `total` 是**旧字段**，语义没变：本次返回几条（= `returned`）。
         * 要知道"一共命中多少"看 `matched`；要知道"还有没有更多"看 `truncated`/`nextOffset`。
         *
         * 本批**只做加法、没有改回执形状** —— 形状变更得单独通告，
         * 不能夹在"修窗口"里顺手做（`9bf9f667` 那次的教训）。
         */
        total: returned,
        matched: page.matched,
        returned,
        truncated,
        nextOffset: truncated ? offset + returned : null,
        unreadMatched,
        /** 全局未读（**界面铃铛**那个口径）：与上面的 `matched`/`unreadMatched` **不是一回事** */
        unread: repo.unreadCount(),
        /**
         * **我还没看**的条数（1.0.68）—— 与上面的 `unread` 不是一回事：
         * 那个答"人还有几条没看"，这个答"我这个 agent 还有几条没看"。
         * 只在 `--to-me` / `--ack-mine` 时给（要按收件人过滤才有意义）。
         *
         * 与 `unreadMatched` 的差别：这个**不受 `--type` 影响**（全局口径），
         * 那个只看本次筛选的命中集合 —— 要跟列表对得上就用 `unreadMatched`。
         */
        ...(forMe ? { unreadForMe: repo.unreadCountFor(me, me) } : {}),
        notifications: rows.map((n) => ({
          id: n.id,
          type: n.type,
          title: n.title,
          summary: n.summary,
          refId: n.refId,
          actor: n.actor,
          /** 给谁（1.0.68）—— 与 actor 是两个身份 */
          recipient: n.recipient,
          /** 谁读过（逗号分隔的主体集合，如 "human,agent:alice"；无人按主体确认时为 null） */
          readBy: n.readBy ? n.readBy : null,
          read_by: n.readBy ? n.readBy : null,
          status: n.status,
          createdAt: n.createdAt,
          /** 驳回通知带 rejected:true，agent 据此分辨"交付"与"退回" */
          meta: n.meta
        }))
      }
    }
  },
]

export const reminderCommands: CommandSpec[] = [
  {
    /**
     * `reminder snooze`（1.0.111，卡 `48f4e326` 的后半）
     *
     * 回执顶部那一段"你有 N 条被退回 / M 条指派给你 / K 张未读纸条"的**摘要**，
     * 现在同一批只推一次（未声明会话也按身份记账）。这条命令给调用方一个
     * **主动动作**：这批我知道了，别再推。
     *
     * 为什么不并进 `notification list --ack-mine`：那一条记的是**通知**的主体
     * 已读位（界面与 agent 共享的那一份），这里压的是**回执里的摘要**，粒度不同 ——
     * 混在一起会让"通知我看过了"顺手把"还有别的活"也静音掉。
     *
     * 风险档按读处理：它只写一条"这批不必再推"的临时快照（七天过期、不进事件审计），
     * 改不了任何人的数据、也改不了任何已读位。与 `notification list --ack-mine`
     * 同一档（`readOnly + 一个显式 ack 参数`）。
     */
    name: 'reminder snooze',
    dataShape: 'object',
    readOnly: true,
    desc: '把**当前这一批**会话提醒记成"已知晓，别再推"（内容一变照旧推）',
    args: [],
    run: (ctx) => {
      const actor = actorOf(ctx)
      const summary = buildSessionReminder(ctx)
      if (!summary) {
        return {
          snoozed: false,
          reason: '当前没有会话提醒可 snooze',
          message: '没有要压的提醒 —— 被退回 / 未读纸条 / 指派给你的卡都为空。'
        }
      }
      const seen = ctx.deps.reminderReceiptRepo.markSeen(actor, ctx.session, summary)
      return {
        snoozed: true,
        /** false = 这批此前已经记过（内容一字未变） */
        firstTime: seen.changed,
        key: seen.key,
        summary,
        message: seen.changed
          ? '这一批已按"已知晓"记下：内容不变时不再推给你；\n' +
            '出现新的纸条 / 新的指派 / 新的退回会重新推（压的只是"一字未变的同一批"）。'
          : '这一批此前已记过、内容没变，不会再推。'
      }
    }
  },
]

export const memoCommands: CommandSpec[] = [
  {
    name: 'memo add',
    dataShape: 'object',
    desc: '记一条备忘（递纸条）—— 不是待办：不进看板、不占队列，人看过就算送达',
    args: [
      { flag: '--text', type: 'string', required: true, desc: '备忘内容，一两句话说清"留意什么"' },
      {
        flag: '--todo',
        type: 'string',
        desc: '关联的待办 ID（可选），如"这条坑出在哪个任务上"'
      },
      {
        flag: '--to',
        type: 'string',
        desc:
          '给谁，如 agent:alice。**1.0.68 起这是收件人**；' +
          '不传 = 没指定给谁（recipient 落空，不编造）'
      },
      {
        flag: '--owner',
        type: 'string',
        desc: '`--to` 的别名（1.0.68 前的名字，留着不打断既有用法）'
      },
      {
        flag: '--reply-to',
        type: 'string',
        desc: '回复哪条备忘（支持 ID 前缀）；回复归入原备忘线程，不新建独立备忘条目'
      }
    ],
    run: (ctx, flags) => {
      const text = String(flags['--text'] ?? '').trim()
      if (!text) throw new UsageError('--text 不能为空；备忘的价值就在内容本身')

      let linkedTodoId: string | null = null
      if (flags['--todo'] !== undefined) {
        const ref = String(flags['--todo']).trim()
        if (ref) {
          // 支持 id 前缀；找不到直接报错 —— 关联指向不存在的事比不关联更糟
          try {
            linkedTodoId = ctx.deps.todoRepo.resolveId(ref)
          } catch {
            throw new NotFoundError(`关联的待办不存在: ${ref}`)
          }
        }
      }

      /**
       * ⚠️ **1.0.68 修一个不报错的错（`3c436592`）**
       *
       * 原来：`const owner = ...; create({ author: owner })` ——
       * **收件人被写成了作者**。于是"这张纸条是谁递的"查不出来，
       * 而"谁在什么时候提醒我什么"正是本产品对 agent 的核心卖点。
       * 而"与 `todo add` 的自动归因不一致"也是同一个病：
       * 两类对象用了两套身份口径。
       *
       * 现在：**作者 = 本次调用的身份**（`actorOf`，与 `todo add` 同一套归因），
       * 收件人 = `--to`（`--owner` 留作别名，不打断既有用法）。
       *
       * ⚠️ **不传 `--to` 时不编造收件人** —— recipient 落 NULL，
       * 表示"没指定给谁"。判据同 `84efa995`：**不该造一个看起来对的值。**
       */
      const author = actorOf(ctx)
      const toFlag = flags['--to'] ?? flags['--owner']
      const recipient = toFlag ? String(toFlag).trim() || null : null

      if (flags['--reply-to'] !== undefined) {
        const replyRef = String(flags['--reply-to']).trim()
        if (!replyRef) throw new UsageError('--reply-to 不能为空')
        const matches = ctx.deps.memoRepo.list().filter((m) => m.id.startsWith(replyRef))
        if (matches.length === 0) throw new NotFoundError(`备忘不存在: ${replyRef}`)
        if (matches.length > 1) {
          throw new UsageError(`备忘前缀「${replyRef}」命中 ${matches.length} 条，请提供更长前缀`)
        }
        const target = matches[0]
        const replied = ctx.deps.memoRepo.reply(target.id, {
          author,
          ...(toFlag !== undefined ? { recipient } : {}),
          text
        })
        if (!replied) throw new NotFoundError(`备忘不存在: ${replyRef}`)
        ctx.deps.events.append('memo', author, {
          action: 'reply',
          id: replied.memo.id,
          replyId: replied.reply.id,
          ...(replied.reply.recipient ? { recipient: replied.reply.recipient } : {})
        })
        return {
          id: replied.memo.id,
          replyTo: replied.memo.id,
          replyId: replied.reply.id,
          author: replied.reply.author,
          recipient: replied.reply.recipient,
          text: replied.reply.text,
          replies: replied.memo.replies ?? []
        }
      }

      const memo = ctx.deps.memoRepo.create({ author, recipient, text, linkedTodoId })
      ctx.deps.events.append('memo', author, {
        action: 'add',
        id: memo.id,
        ...(recipient ? { recipient } : {})
      })
      return {
        id: memo.id,
        author: memo.author,
        recipient: memo.recipient,
        text: memo.text
      }
    }
  },
  {
    name: 'memo list',
    dataShape: 'array',
    readOnly: true,
    desc: '列出备忘（新→旧）。带 --unread 只看未读',
    args: [
      { flag: '--unread', type: 'boolean', desc: '只列未读的' },
      {
        flag: '--limit',
        type: 'string',
        desc:
          '返回条数上限（不传 = 全部）。此前只有 todo list 有 --limit、memo list 没有，' +
          `同一个"列出一批"的动作两套参数 —— 未读攒起来后只能全量拉回来自己数；${LIMIT_ZERO_DOC}`
      },
      {
        flag: '--offset',
        type: 'string',
        desc:
          '分页偏移（默认 0）。**怎么读**：回执里**有没有 `meta`** —— 有 ⇒ 这一页之后还有，' +
          '`meta.nextOffset` 就是下一页该传的值；没有 ⇒ 读完了。' +
          '（`data` **始终是数组**、信封也始终是对象：翻页不改形状 —— 老脚本按数组解析不受影响。' +
          '1.0.110 更正：此前这里写的是"回执是数组 ⇒ 读完了"，而实测截断时回执仍是 ' +
          '{ok, data:[…], notice, meta}。）'
      },
      { flag: '--brief', type: 'boolean', desc: '省略冗余字段，输出更紧凑' },
      {
        flag: '--to-me',
        type: 'boolean',
        desc:
          '**只看待在我这儿**（recipient = 我）。1.0.68 起有了 —— ' +
          '此前无法回答"哪些纸条是给我的"'
      },
      {
        flag: '--from',
        type: 'string',
        desc: '只看某人递来的（按 author 筛），如 agent:qwen'
      },
      {
        flag: '--directed',
        type: 'boolean',
        desc: '只看**指定了收件人**的那些（排除自己记的备忘）'
      }
    ],
    run: (ctx, flags) => {
      const me = actorOf(ctx)
      let memos = ctx.deps.memoRepo.list()
      if (flags['--unread']) memos = memos.filter((m) => m.status === 'unread')
      /**
       * 收件人筛选（1.0.68，`3c436592`）
       *
       * ⚠️ `--to-me` 与 `--unread` **是两个正交的问题**：
       * "给我的" ≠ "我还没看"。而此前只有 `--unread`（且未读位全局一份），
       * **agent 收不到"这是递给我的"这个信号** —— 靠每轮全量拉回来自己认。
       */
      if (flags['--to-me']) memos = memos.filter((m) => m.recipient === me)
      if (flags['--from']) {
        const want = String(flags['--from']).trim()
        memos = memos.filter((m) => m.author === want)
      }
      if (flags['--directed']) memos = memos.filter((m) => m.recipient !== null)

      const total = memos.length
      const limit = parseLimit(flags['--limit'], 'memo list') ?? 0
      /**
       * 分页（1.0.109，修 `7f21841f`）：先筛（--unread / --to-me / --from / --directed），
       * 再切窗口 —— 与 `todo list` 同一套读法。
       *
       * ⚠️ **不传 `--offset`、没截断时仍然回数组**：`data` 是数组的命令，形状一个字都不能动
       * （同族 `9bf9f667` 的病 —— 数组变对象会让老调用方 `for`/`map` 静默走空、还不报错）。
       * 所以计数只落在**截断时才有的那层包装**里，而那个包装本来就在（notice 那条路）。
       */
      const offset = parseOffset(flags['--offset'], 'memo list')
      if (offset > 0) memos = memos.slice(offset)
      memos = takeLimit(memos, limit)
      const returned = memos.length
      /** 截断 = **这一页之后还有**：被偏移吃掉的那部分不算"更多" */
      const truncated = offset + returned < total
      const nextOffset = truncated ? offset + returned : null

      const rows = flags['--brief']
        ? memos.map((m) => ({
            id: m.id,
            author: m.author,
            text: m.text,
            unread: m.status === 'unread',
            ...(m.replies?.length ? { replies: m.replies } : {})
          }))
        : memos
      return truncated
        ? {
            __notice: `结果被 --limit ${limit} 截断：匹配 ${total} 条，本页回了第 ${offset + 1}–${offset + returned} 条；继续读传 --offset ${nextOffset}。`,
            /** 与 `todo list` / `project search` 同键名；不截断时没有它（形状不变） */
            __meta: { matched: total, returned, truncated, nextOffset },
            data: rows
          }
        : rows
    }
  },
  {
    name: 'memo ack',
    dataShape: 'object',
    desc: '把备忘标记为已读（收到确认；重复 ack 幂等）',
    args: [],
    positional: { name: 'id', required: true, desc: '备忘 ID（支持前缀）' },
    run: (ctx, _flags, positional) => {
      const id = positional[0]
      if (!id) throw new UsageError('缺少备忘 id')
      // memo id 不做前缀解析（量小，直接全量比对前缀）
      const hit = ctx.deps.memoRepo.list().find((m) => m.id.startsWith(id))
      if (!hit) throw new NotFoundError(`备忘不存在: ${id}`)
      const memo = ctx.deps.memoRepo.ack(hit.id, actorOf(ctx))
      ctx.deps.events.append('memo', 'human-ui', { action: 'ack', id: hit.id })
      return { id: memo!.id, status: memo!.status, readAt: memo!.readAt }
    }
  },
  {
    name: 'memo rm',
    dataShape: 'object',
    risk: 'destructive',
    desc: '删除备忘；删除需要 --yes（已读且无价值的清理用）',
    args: [
      { flag: '--yes', type: 'boolean', desc: '确认删除' }
    ],
    positional: { name: 'id', required: true, desc: '备忘 ID（支持前缀）' },
    run: (ctx, flags, positional) => {
      const id = positional[0]
      if (!id) throw new UsageError('缺少备忘 id')
      if (!flags['--yes']) throw new UsageError('删除备忘需要确认，请加 --yes')
      const hit = ctx.deps.memoRepo.list().find((m) => m.id.startsWith(id))
      if (!hit) throw new NotFoundError(`备忘不存在: ${id}`)
      const removed = ctx.deps.memoRepo.remove(hit.id)
      ctx.deps.events.append('memo', 'human-ui', { action: 'rm', id: hit.id })
      return { deleted: hit.id, ok: removed }
    }
  },
]
