/**
 * 单条执行与代人执行（拆分卡 bbeb1b51，纯搬移）
 *
 * `executeOne` 是所有通道（无头进程 / 常驻管道 / MCP）唯一的执行入口，
 * `executeApproved` 是人点过头的 grant 那条路 —— 两者共用同一套校验与错误码。
 */

import { classifyError } from './error-codes'

import { isOpenStatus, todosForExecutor } from './command-text'
import { EXIT_CODES, GLOBAL_FLAGS, actorOf, assertCallerAllowed, dedupeNoticeLines, isVersionOlder, parseFlags, riskOf, summarizeGrantTarget } from './command-core'
import type { CliContext, Outcome } from './command-core'
import { commandUsage, commands, findCommand, findNearCommands, maxPositionalArgs, normalizeGrantArgv } from './command-table'

/**
 * 执行单条命令并归一化结果
 *
 * 单条调用与 batch 都走这里 —— 如果各写一套，
 * 两条路径的校验与错误码迟早会长歪。
 */
/**
 * 当前这批**会话提醒**（被退回的 / 未读纸条 / 指派给你的）—— **单一出处**（卡 `48f4e326`）
 *
 * 两个调用方共用它：写命令回执顶部的 notice，与 `reminder snooze`。
 * 分成两份写会立刻分叉 —— snooze 按 A 记账、回执按 B 展示，于是
 * "说已知晓了却还在推"（或反过来"没推却在记账"）。这与本仓库
 * "计数只能有一个出处"（`2e8dfa6d`）是同一条纪律。
 *
 * 返回的字符串就是**要展示给调用方的那一段**（含 `[未读]` 前缀），
 * 也是"同一批"的判据（去重靠它的指纹）。
 */
export function buildSessionReminder(ctx: CliContext): string {
  if (!ctx.actor) return ''
  const sessionReminders: string[] = []
  // 驳回块已列过标题的 id：下面的指派块不再重复列，避免同一张卡在一段回执里出现两次
  const listedInReject = new Set<string>()
  try {
    const rejected = ctx.deps.todoRepo.listRejectedFor(ctx.actor)
    if (rejected.length) {
      const headsRejected = rejected.slice(0, 3)
      headsRejected.forEach((t) => listedInReject.add(t.id))
      const list = headsRejected.map((t) => t.title).join('；')
      const hint =
        `你有 ${rejected.length} 条事项被验收方退回，还在「进行中」：${list}` +
        `${rejected.length > 3 ? '…' : ''}。` +
        '用 `todo get <id>` 看它的评论线程（**驳回理由是一条 reject 评论，不是描述**），' +
        '或 `notification list --type review` 看退回记录。'
      sessionReminders.push(hint)
    }
  } catch {
    /* 提醒只是顺带，查不出来不该拖垮命令本身 */
  }

  /**
   * ── 未读摘要（1.0.63）── 「**别等它自觉去扫**」
   *
   * 前一条（驳回提醒）只覆盖"被退回"，而 agent 还会错过另外两类：
   * 别的 agent 留给它的纸条、以及**分派给它的新任务**。它们此前只有
   * 主动 `memo list --unread` / `todo list --executed-by agent:<自己>`
   * 才看得到 —— 也就是**依赖使用方自觉**。实测：只读命令回执里
   * **根本没有 notice 字段**（顶层只有 ok/data），所以"扫一遍"这个动作
   * 全靠 agent 记得；未读一攒就是一批，跨项目混在一起，两个 agent 还共用
   * 一份已读开关（S5 场景）。
   *
   * 这里不改通知系统，只把它**迎面送到必经之路上**：写命令的回执。
   * 判据是"它一动手就会撞上"，不要求任何自觉。
   *
   * 刻意做得**便宜**：只数数、给 id，不展开正文 —— 未读可能上百条，
   * 全塞进 notice 会把回执本身撑爆，又变成新的"输出很长"。
   */
  try {
    const parts: string[] = []

    const unreadMemos = ctx.deps.memoRepo.list().filter((m) => m.status === 'unread' && (!m.recipient || m.recipient === ctx.actor))
    if (unreadMemos.length) {
      const heads = unreadMemos
        .slice(0, 3)
        .map((m) => `「${m.text.slice(0, 12)}${m.text.length > 12 ? '…' : ''}」`)
        .join('；')
      parts.push(
        `有 ${unreadMemos.length} 张未读纸条（${heads}${unreadMemos.length > 3 ? '…' : ''}）。` +
          '读完用 `memo ack <id>` 清角标（看：`memo list --unread`）'
      )
    }

    // 分派给"我"的：executedBy 显式等于本 actor（executedBy=null 表示"提出即执行"，
    // 不算指派，所以那批不在这里）
    if (ctx.actor) {
      /**
       * 口径与 `todo list --executed-by` **同一个查询函数（todosForExecutor）、
       * 同一套默认列（OPEN_STATUSES）**（1.0.74 修 `2e8dfa6d`）。
       *
       * 此前这里手写了一套过滤：排 done/suspended 却**漏了 discarded**，
       * 把已废弃的卡也算成"等你做"，数量放大约六倍 —— 提醒数与
       * `todo list --executed-by` 的条数对不上，而两个数字都进了判断。
       * 判据：**计数只能有一个出处**，提醒数必须与同条件 list 查询逐字一致。
       */
      // 提醒与工作查询均包含“提出即执行”，保持计数同源。
      // 同会话重复摘要由下方的持久化知晓记录压缩。
      const assigned = todosForExecutor(ctx.deps.todoRepo.list(), ctx.actor).filter((t) =>
        isOpenStatus(t.status)
      )
      if (assigned.length) {
        /**
         * 上列（被退回）里已经点过名的，这里**只从标题里去重，不从计数里扣**：
         * 被退回的卡本来就在"指派给你"的集合里，全列一遍等于同一张卡写两次，
         * 但计数仍报 assigned.length —— 扣掉会让"提醒数"与
         * `todo list --executed-by ${ctx.actor}` 的条数对不上（2e8dfa6d）。
         */
        const fresh = assigned.filter((t) => !listedInReject.has(t.id))
        const heads = fresh.slice(0, 3).map((t) => t.title).join('；')
        const overlap = assigned.length - fresh.length
        parts.push(
          `有 ${assigned.length} 条待办指派给你${overlap > 0 ? `（其中 ${overlap} 条已在上列）` : ''}：` +
            (fresh.length ? `${heads}${fresh.length > 3 ? '…' : ''}` : '（全部已在上列）') +
            `（看：\`todo list --executed-by ${ctx.actor}\`）`
        )
      }
    }

    if (parts.length) sessionReminders.push(`[未读] ${parts.join('\n')}`)
  } catch {
    /* 同上：摘要只是顺带，读不出来不该拖垮命令 */
  }
  return sessionReminders.join('\n')
}

export async function executeOne(ctx: CliContext, args: string[]): Promise<Outcome> {
  const matched = findCommand(args)
  if (!matched) {
    /**
     * 报错里带上"你可能想找的命令"。
     *
     * 只说"未知命令"等于让 agent 再去跑一次 schema 才知道有什么 ——
     * 而 agentGuide 里还写着"调用前先跑 schema"，等于把成本转嫁给它。
     * 首词能匹配到命令前缀时（如 todo → todo add/list/update…），
     * 直接列出该前缀下的全部命令，一次调用就能纠正。
     *
     * ── 1.0.49 补：首词匹配不上时，给**近似命令**（修 85740f50）──
     *
     * telemetry 实测 `todo get` 被调用 11 次全部失败，而它当时不存在。
     * 这类"猜一个不存在的命令"以后只会更多，所以光在未知命令里
     * 列同前缀兄弟还不够 —— `todo get` 恰好前缀能命中，但如果 agent
     * 猜的是 `get todo` / `todos list` / `todo find` 这类形状，
     * 现有逻辑只会回一句冷冰冰的"未知命令"，无从纠正。
     *
     * 两条补救，按"确定性从高到低"排：
     * 1. 同前缀兄弟（`todo xxx` → 列出 todo 下全部）—— 最确定，保留原逻辑；
     * 2. 编辑距离近似的命令名（`todos list` → 提示 `todo list`）——
     *    跨前缀也能救，但要限定距离，免得给出毫不相干的建议。
     *
     * 两者都有才提示，且提示语明确说"你是不是想用" —— 不假装确定。
     */
    let hint = ''
    const head = args[0]
    if (head) {
      const siblings = commands.filter((c) => c.name.startsWith(`${head} `))
      if (siblings.length) {
        hint = `。${head} 下可用：${siblings.map((c) => c.name.slice(head.length + 1)).join(', ')}`
      }
    }
    if (!hint) {
      const typed = args.join(' ')
      const near = findNearCommands(typed)
      if (near.length) {
        hint = `。你是不是想用：${near.join(' 或 ')}？（完整清单见 schema）`
      }
    }
    return {
      ok: false,
      code: EXIT_CODES.usage,
      errorCode: 'usage_error',
      message: `未知命令: ${args.join(' ')}${hint}`
    }
  }
  const { cmd: rawCmd, rest } = matched
  const { flags, positional } = parseFlags(rest, rawCmd.args)

  /**
   * 动态档位（1.0.63，收 dbfbc553 选③）
   *
   * 在**所有校验与门禁之前**把档位定下来：`assertCallerAllowed`、
   * `summarizeGrantTarget`、`normalizeGrantArgv` 都只认 `riskOf(cmd)`，
   * 提前换掉 `cmd` 就足够，不需要在门禁里再加一条分支。
   * 换的是**浅拷贝**，命令表本身不被修改（它是模块级常量，被就地改会串场）。
   *
   * 判定失败一律退回静态档位：这里出错的代价不能是"命令莫名其妙失败"。
   */
  let cmd = rawCmd
  if (rawCmd.dynamicRisk) {
    try {
      const dynamic = rawCmd.dynamicRisk(ctx, flags, positional)
      if (dynamic !== riskOf(rawCmd)) cmd = { ...rawCmd, risk: dynamic }
    } catch {
      /* 判定不出来就按原档位走 —— 报错留给命令本身（not_found 比"没权限"准确） */
    }
  }

  /**
   * `--help` / `-h` 一律先答，且不参与后续校验。
   *
   * Bob 21bd6f34：同一个 flag 两种命运 —— `todo add --help` 因为必填校验在前，
   * 报"缺少必填参数 --title"（exit 2）；`todo list --help` 没有必填项，
   * 于是静默忽略 --help 直接执行查询（exit 0，返回一堆待办）。
   * 问用法就是问用法，不该被必填校验拦，也不该顺手把命令跑了。
   */
  if (flags['--help'] !== undefined || flags['-h'] !== undefined) {
    return { ok: true, data: commandUsage(cmd), output: cmd.output }
  }

  const isWithdrawCall = flags['--withdraw'] !== undefined && cmd.args.some((s) => s.flag === '--withdraw')
  for (const spec of cmd.args) {
    if (!isWithdrawCall && spec.required && flags[spec.flag] === undefined) {
      /**
       * --project 缺失时给更具体的指路（1.0.37）。
       *
       * 默认那句"缺少必填参数 --project"只说了事实，没说该填什么 ——
       * 而 agent 第一次撞上必填时最需要知道的恰恰是"本机已有哪些项目"。
       * 直接列出来，它就不用先跑一次 project list 再重试。
       */
      const extra =
        spec.flag === '--project'
          ? (() => {
              const names = ctx.deps.projectRepo.list().map((p) => p.name)
              return names.length
                ? `。已有项目：${names.join('、')}；没有合适的先 project add 再来`
                : '。本机还没有项目，先 project add 再来'
            })()
          : ''
      return {
        ok: false,
        code: EXIT_CODES.usage,
        errorCode: 'usage_error',
        message: `${cmd.name} 缺少必填参数 ${spec.flag}${extra}`
      }
    }
    const v = flags[spec.flag]
    if (typeof v === 'string' && spec.enum) {
      /**
       * 多值 flag 逐值校验（1.0.63）：`--status todo,in_progress` 不能因为
       * 整串不在枚举里就被判非法，也不能因为整串不在枚举里就**放行**。
       * 逐个值过同一份 enum —— 单值与多值共用一条判据。
       */
      const values = spec.multi ? v.split(',').map((s) => s.trim()).filter(Boolean) : [v]
      const bad = values.find((x) => !spec.enum!.includes(x))
      if (bad !== undefined) {
        return {
          ok: false,
          code: EXIT_CODES.usage,
          errorCode: 'usage_error',
          message: `${spec.flag} 只接受 ${spec.enum.join('/')}，收到 ${bad}`
        }
      }
    }
  }
  if (!isWithdrawCall && cmd.positional?.required && !positional.length) {
    return {
      ok: false,
      code: EXIT_CODES.usage,
      errorCode: 'usage_error',
      message: `${cmd.name} 缺少 ${cmd.positional.name}`
    }
  }

  /**
   * "这个命令接受什么" —— 下面两种参数错误（多给位置参数 / 未知 flag）共用同一段文案。
   *
   * 同一件事写两处，迟早有一处漏 —— 这是 `1e525804` 修了三轮的形状
   * （"四个出口必须同源"），在文案上也一样：调用方是靠这句话改对调用的。
   */
  const availParams = cmd.args.length ? cmd.args.map((s) => s.flag).join(', ') : '（无可选参数）'
  /**
   * 位置参数提示。吃多个的（`arity > 1`：`category merge` 的两个 id、
   * `help` 的两个词命令名）要写出**上限** —— 否则调用方看着 `<ids>`
   * 还得再猜一次，而这条报错的全部意义就是"一次改对"（1.0.107，修 `350f9631`）。
   */
  const maxPositional = maxPositionalArgs(cmd)
  const positionalHint = cmd.positional
    ? `，位置参数 <${cmd.positional.name}>${maxPositional > 1 ? `（最多 ${maxPositional} 段）` : ''}`
    : ''

  /**
   * 多余的位置参数一律报 usage_error —— 与"未知 flag"**同一条判据**（1.0.107，修 `350f9631`）
   *
   * ## 治的病：静默丢掉参数 = 看着正常的错误答案
   *
   * 未知 flag 在 1.0.64 那轮就被拦下了（`777eaf34` / `3628895c`），但**位置参数**
   * 一直是"多给就丢"。实测 1.0.107：`agent grants zzz` 回全部 81 条授权、
   * exit 0、ok:true —— 而 `agent grants` 根本没有位置参数（筛选靠 `--id`），
   * 调用方以为筛选生效了。代价不止一次困惑：`251eb399` 那次 MCP 把参数发错位置，
   * 正是靠这条宽松规则躲过了报错，"筛选失效"被当成"筛选没写"，白跑一轮排查。
   *
   * ## 判据：`maxPositionalArgs(cmd)` 与实际给的对不上
   *
   * - 没声明 `positional` 的命令（`agent grants` / `batch` / `todo list` …）：
   *   一个都不接受，给了就是错；
   * - 声明了但没写 `arity`：接受 1 个；
   * - 吃两个的显式写 `arity: 2`：`category merge`（源 目标 两个 id）与 `help`（两词命令名）。
   *
   * 三档都从**同一份声明**推出来（`maxPositionalArgs`），结构闸门也用同一个函数 ——
   * 另写一份判据的话，"执行时怎么判"与"闸门怎么查"会分叉，本仓库为此修过多次。
   *
   * ## 为什么不是"回执里提一句忽略了什么"
   *
   * 提示会被忽略，而错误答案不会：回执里的 `ok:true` 与一列数据比任何提醒都响。
   * 报错只影响"本来就在静默错着"的调用方 —— 它们此时才开始得到正确答案
   * （少了参数就不该照常执行）。
   */
  if (positional.length > maxPositional) {
    return {
      ok: false,
      code: EXIT_CODES.usage,
      errorCode: 'usage_error',
      message:
        `${cmd.name} 不接受多余的参数：${positional.slice(maxPositional).join(' ')}。` +
        `可用参数：${availParams}${positionalHint}`
    }
  }

  /**
   * 未知 flag 一律报 usage_error —— 绝不静默忽略
   *
   * Bob两轮实测（777eaf34 / 3628895c）指向同一条根因：
   * 解析器把没声明的 flag 收进 flags 就不管了，命令照常执行。于是
   * - `todo list --transitions` 返回一列普通待办（exit 0）→ 它以为自己拿到了审计记录，
   *   基于假数据连出两个误判；
   * - `ui reset --key theme` 忽略 --key、执行全量复位（exit 0）→ 作用范围被放大还报成功。
   *
   * 读命令吞掉未知 flag 只是"没生效"，写命令吞掉则是"干了比意图更大的事"。
   * 两种都比报一条 usage_error 贵得多：报错至少让 agent 立刻知道自己的调用是错的。
   */
  const declaredFlags = new Set(cmd.args.map((s) => s.flag))
  const unknownFlags = Object.keys(flags).filter(
    (f) => !declaredFlags.has(f) && !GLOBAL_FLAGS.has(f)
  )
  if (unknownFlags.length) {
    return {
      ok: false,
      code: EXIT_CODES.usage,
      errorCode: 'usage_error',
      message: `${cmd.name} 不接受 ${unknownFlags.join(', ')}。可用参数：${availParams}${positionalHint}`
    }
  }

  /**
   * 写入闸门（1.0.35）：非交互的调用必须有已批准、且持证的身份。
   *
   * 主用户 2026-09-21 问："既然都有身份注册机制了，所有行动不该都能跟踪和登记吗？"
   * 实测回答了代价：1147 条 CLI 调用里 1142 条记成 human —— 绝大多数其实是
   * agent 干的，却静默挂到了人名下。靠"agent 记得 export"是守不住的
   * （权限必须由框架强制，不由调用方自觉 —— Claude Code 的权限模型原话）。
   *
   * 判据是"是不是人在终端敲"（interactive）：
   * - 人在敲 → 按 human 放行，不制造摩擦；
   * - 无人值守的调用（agent / 脚本）→ 必须持证且已被批准，否则拒绝并指路。
   */
  const gate = assertCallerAllowed(
    ctx,
    cmd,
    summarizeGrantTarget(cmd, flags, positional, ctx),
    /**
     * 完整 argv 带进门禁，让它写进授权申请（v20）。
     *
     * 用 cmd.name + rest 而不是 args 原文：`rest` 已经去掉了命令名，
     * 两者拼起来正好是「命令名 + 参数」，而 args 里可能夹着 `--help`
     * 之类的解析细节。requestArgv 要能被原样重放，所以取规范化后的形态。
     *
     * 再过一道 `normalizeGrantArgv`：删除档补 `--yes`（1.0.49，主用户 814ad86d）。
     * 批准这个动作本身就是显式确认，而调用方在被批准前不该、也不会带它。
     */
    normalizeGrantArgv([cmd.name, ...rest]),
    flags,
    positional
  )
  if (gate.outcome) return gate.outcome

  /**
   * dry-run 的刹车点（1.0.65，`batch --dry-run`）
   *
   * 位置就是这里 —— 上面所有校验（必填 / 枚举 / 未知 flag / 门禁）都已跑完，
   * `cmd.run` 还没开始。停在这儿的语义是"**这条命令是合法的，而且你有权限跑**"。
   *
   * 为什么不给"目标是否真的存在"打包票：那是 `cmd.run` 内部才解析的
   * （`resolveId` 之类），要判就得把执行路径再跑一遍 —— 那样 dry-run
   * 反而可能产生副作用。**说清边界比假装能做更多更重要**：
   * 它答的是"参数写对了吗、够格跑吗"，不答"目标还在吗"。
   */
  if (ctx.dryRun) {
    return {
      ok: true,
      data: {
        dryRun: true,
        command: cmd.name,
        risk: riskOf(cmd),
        verdict: '参数与权限校验通过，未执行'
      }
    }
  }

  let data: unknown
  let notice: string | undefined
  let meta: Record<string, unknown> | undefined
  try {
    const r = await cmd.run(ctx, flags, positional)
    // run 允许返回 { __batchFailure, ... } 包装：batch 全部失败时用（先于 __notice 判）
    if (
      r &&
      typeof r === 'object' &&
      '__batchFailure' in (r as Record<string, unknown>)
    ) {
      /**
       * batch 全部失败：整体按失败处理（非零退出码）——
       * Bob反馈：全败仍 ok:true + exit 0，只看退出码的 agent 会把失败当成功
       *
       * 1.0.72（`10fcb47f` D2）：顶层补 `firstFailure`。
       *
       * 此前顶层只说 `batch_all_failed`（"全都失败了"），
       * 真正的失败类型埋在 `data.results[i].code` 里 ——
       * 而那个字段此前装的是**数字退出码**，按 code 分流的脚本拿不到可分流的名字。
       * 现在行内 `code` 已改成字符串（与直连同构），
       * 再补一个 `firstFailure` 让**只看顶层**的调用方不必下钻 results 就能分流：
       *
       *   "这批失败了"  → 顶层 code = batch_all_failed（这批的结论）
       *   "第一条为什么" → firstFailure.code（那一条的原因）
       *
       * 刻意不把顶层 code 直接改成第一条的原因：那会丢掉"这批整体失败"这个事实，
       * 而部分失败时顶层 ok:true —— 调用方需要知道**该不该重试整批**。
       */
      const {
        __batchFailure: _ignored,
        /**
         * 聚合提醒只是包装的传输键，不进失败信封：schema 承诺 notice 只出现在
         * 成功响应（"失败响应里不会出现"），逐条提醒仍在 `results[i].notice`；
         * 且全败时聚合必为空 —— 失败行的 Outcome 本就不带 notice（提醒只在
         * 命令成功后的收尾里生成）。丢掉它不丢信息。
         */
        __notice: _batchNotice,
        message: batchMessage,
        data: payload
      } = r as Record<string, unknown>
      const rows = Array.isArray((payload as { results?: unknown[] })?.results)
        ? (payload as { results: { ok?: boolean; code?: string; message?: string }[] }).results
        : []
      const firstBad = rows.find((x) => x && x.ok === false)
      return {
        ok: false,
        data: payload,
        code: EXIT_CODES.error,
        errorCode: 'batch_all_failed',
        ...(firstBad
          ? { firstFailure: { code: firstBad.code ?? 'error', message: firstBad.message ?? '' } }
          : {}),
        message: String(batchMessage ?? '批量执行全部失败')
      }
    } else if (
      r &&
      typeof r === 'object' &&
      /**
       * 判据是「有包装标记」而不是「有 __notice」——1.0.63 修。
       *
       * meta 出现后，一条列表命令**可能只有 __meta、没有 __notice**
       * （不截断时就是这样）。若仍只认 __notice，这种返回会掉进下面的 else，
       * 整个包装对象被当成 data：调用方拿到 `{__meta, data}` 而不是数组，
       * `data.map` 直接 TypeError。这正是本设计最怕的"data 不再是数组"，
       * 只不过换了个位置发生。
       */
      ('__notice' in (r as Record<string, unknown>) ||
        '__meta' in (r as Record<string, unknown>)) &&
      'data' in (r as Record<string, unknown>)
    ) {
      const wrapped = r as { __notice?: string; __meta?: Record<string, unknown>; data: unknown }
      notice = wrapped.__notice
      meta = wrapped.__meta
      data = wrapped.data
    } else {
      data = r
    }

    /**
     * 顶层 notice 收齐后**逐句去重**（1.0.110，收 `691c3b1e`）。
     *
     * 位置刻意在"包装解开之后、任何追加之前"：batch 的聚合提醒正是从这里进来的，
     * 而它内部可能已经带着同一句（每条子命令各自也走过这里）。放在追加处打补丁
     * 只能治那一条路，这里治的是**所有来源合并后的那一份**。
     */
    if (notice) notice = dedupeNoticeLines(notice)

    /**
     * G8（1.0.51，qwen 52b6b726）：**说明书漂移的主动提醒**。
     *
     * 此前 `doctor.skillVersion` 与说明书里的自检指引都在，但那要 agent
     * 主动去比 —— Bob实测就是拿着 1.0.39 的副本跑了四轮（跨了 46-50 五版），
     * 一直在按新规格里点名禁止的写法（硬写安装路径）干活，自己不知道。
     *
     * 现在：环境里声明了自己那份说明书的版本（`DESKPARTNER_SKILL_VERSION`），
     * 每次调用的回执里就会带一条提醒。不拦、不改退出码 —— 用旧说明书不算错，
     * 只是很可能已经过期了。
     *
     * ⚠️ 1.0.57 修：原先这里直接读 `process.env`，**管道路径下恒为空**
     * （服务端是常驻 GUI 进程，看不到调用方的环境）→ GUI 一开着提醒就失效，
     * 无头通道反而正常。Bob驳回并给了实测。现在改读 `ctx.skillVersion`
     * （由启动器带进请求体），两条通道共用同一判据。
     */
    const ackedSkillVersion =
      ctx.actor?.startsWith('agent:')
        ? (() => {
            try {
              return ctx.deps.reminderReceiptRepo?.getSkillReadVersion?.(ctx.actor) ?? undefined
            } catch {
              return undefined
            }
          })()
        : undefined
    const skillVersion =
      ackedSkillVersion && ackedSkillVersion === ctx.meta?.version ? ackedSkillVersion : ctx.skillVersion
    if (skillVersion && isVersionOlder(skillVersion, ctx.meta.version)) {
      /**
       * ⚠️ 别让人去跑 `dp skill`（卡 `cb7924c2`，1.0.133）：**本机没有 `dp` 这条命令** ——
       * 产品从 1.0.55 起就不写用户 PATH（`2cc71a13`）。给命令行就写真实调用方式，
       * 给 MCP 就指向 `get_guide`；写成 `dp xxx` 的后果是对方照抄一条跑不通的命令，
       * 然后像那个本地 agent 一样，把「跑不了」读成「产品不存在」。
       */
      const refresh =
        ctx.surface === 'mcp'
          ? '重新调用 `get_guide` 工具取一份'
          : '重跑 `skill`（`node "$DESKPARTNER_CLI" skill`；变量不在就用安装目录下的 resources/cli/deskpartner.cjs）'
      const hint =
        `你手上的说明书是 ${skillVersion}，当前 CLI 已是 ${ctx.meta.version} —— ` +
        `中间可能有行为变化。${refresh}再干，别照旧说明书写。`
      notice = notice ? dedupeNoticeLines(`${notice}\n${hint}`) : hint
    } else if (
      !skillVersion &&
      cmd.readOnly &&
      cmd.output !== 'text' &&
      cmd.output !== 'ndjson' &&
      ctx.actor?.startsWith('agent:')
    ) {
      const hint =
        `未声明说明书版本（DESKPARTNER_SKILL_VERSION），无法核对是否过期（当前 CLI 为 ${ctx.meta.version}）—— ` +
        `先取一份最新说明书（MCP 调 \`get_guide\`；命令行跑 \`node "$DESKPARTNER_CLI" skill\`），` +
        `并在环境中声明 \`DESKPARTNER_SKILL_VERSION=${ctx.meta.version}\`。`
      notice = notice ? dedupeNoticeLines(`${notice}\n${hint}`) : hint
    }

    /**
     * 驳回提醒（2026-09-28，B 方案）：**你有活被验收方退回了**。
     *
     * 主用户提的口子：验收不通过时，结论只进描述、状态还挂在待验收，
     * 执行方不逐条翻描述根本发现不了。配合 A（退回=转 in_progress）
     * 与 C（退回即写通知），这里再补一层"拉"：
     * 只要你在调命令，回执就会告诉你有几条被退回、是哪几条。
     *
     * 只在**写命令**后提醒：读命令（list/get 之类）每次都刷一遍太吵。
     */
    if (!cmd.readOnly && ctx.actor) {
      const summary = buildSessionReminder(ctx)
      let expand = summary.length > 0
      try {
        expand = ctx.deps.reminderReceiptRepo.shouldExpand(ctx.actor, ctx.session, summary)
      } catch {
        // 快照存储失败宁可重复提醒，不能隐藏用户尚未看到的内容。
      }
      if (expand) notice = notice ? dedupeNoticeLines(`${notice}\n${summary}`) : summary
    }
  } catch (err) {
    /**
     * 分类**只有一处**（`classifyError`，1.0.110 收 `7a6ac97e`）：
     * 稳定类型决定可编程错误码，提示文案 / 语言 / 关口编号只供人阅读 ——
     * 未知异常即使包含“不存在”或关口编号，也不能冒充业务拒绝。
     *
     * 判据：**同一份判定不许写两遍**。启动器那条出口（`main().catch`）此前
     * 自己写死 `code: 'error'` + exit 1，于是"参数写错"与"环境坏了"在两条通道上
     * 给出不同形状 —— 而它们该做的事完全相反（改命令 / 换台机器）。
     */
    const { errorCode, exitCode } = classifyError(err)
    return {
      ok: false,
      code: exitCode,
      errorCode,
      message: err instanceof Error ? err.message : String(err)
    }
  }

  /**
   * 写入类命令成功后追加一条变更事件，
   * 让正在运行的 GUI 通过轮询察觉到"数据被别的进程改了"。
   * 这是通道 B（无头执行）的兜底补偿 —— 正常路径由 GUI 自广播覆盖。
   */
  if (cmd.name.startsWith('todo ') && cmd.name !== 'todo list') {
    try {
      ctx.deps.events.append('todo', 'cli', { cmd: cmd.name })
     } catch {
      // 广播失败不能让命令本身失败
    }
  }

  /**
   * 写后收尾（1.0.36 审计）：记下"它动过数据"，并把一次性授权销账。
   *
   * 放在成功路径的末尾而不是门禁里：授权是"允许它做这一次"，
   * 命令失败时这一次并没做成，此时销账会白白吃掉人的一次点头。
   */
  const risk = riskOf(cmd)
  if (risk !== 'read') {
    const writer = actorOf(ctx)
    if (writer.startsWith('agent:')) {
      try {
        ctx.deps.agentRepo.markWrite(writer, cmd.name)
        if (gate.consumableGrantId) ctx.deps.agentRepo.consumeGrant(gate.consumableGrantId)
      } catch {
        // 审计失败不能让命令本身失败 —— 但也不静默：写不进去的审计等于没有审计
        console.error('[cli] 写入审计失败（授权销账可能未完成）')
      }
    }
  }

  return {
    ok: true,
    data,
    output: cmd.output,
    ...(notice ? { notice } : {}),
    ...(meta ? { meta } : {})
  }
}

/**
 * 代人执行一条**已被批准的**命令（1.0.45「批准即执行」）
 *
 * 主用户 2026-09-22 的架构判断：审批必须由服务端直接落地，
 * 否则就得另建一套「通知 agent 去执行」的机制 —— 而后者只是把问题推后
 * （agent 离线时通知堆积、上线后还要判断哪些已过期）。
 * 这里让「agent 回来执行」这一步**根本不存在**。
 *
 * 语义上是「用户刚刚点头了，替他把这件事做掉」，所以：
 *
 * 1. **身份仍是原来那个 agent**（`agentId`）—— 动作的归属不能变成人。
 *    看板上「谁删的」必须还是它；这里只是**执行时机**提前了。
 * 2. **不带 agent 的凭据**，改用 `preApprovedGrantId` 通行：
 *    服务端手上没有（也不该有）agent 的凭据明文。
 * 3. **执行前先标 consumed**，不做事后销账。理由与 agent 路径相反：
 *    那里是"没做成就不该吃掉人的点头"，这里**点头已经发生且动作已经发起** ——
 *    即使执行失败，那条一次性授权也该失效（否则 agent 回头再撞一次，
 *    又变成"批一次、动两次"）。结果由 recordGrantExecution 留痕。
 *
 * 返回 Outcome，形状与普通调用一致 —— 调用方（IPC）直接把它当结果回给界面。
 */
export async function executeApproved(
  ctx: CliContext,
  argv: string[],
  opts: { agentId: string; grantId: string }
): Promise<Outcome> {
  const cmdLine = argv.join(' ')
  try {
    return await executeOne(
      {
        ...ctx,
        // 动作人仍是发起申请的 agent：它想做的这件事，只是由人代按了确认
        actor: opts.agentId,
        // 这次不是 agent 出示凭据，而是"人已批准"这一事实
        credential: undefined,
        interactive: false,
        preApprovedGrantId: opts.grantId
      },
      argv
    )
  } catch (err) {
    // executeOne 内部已把错误转成 Outcome，走到这里说明是它自己崩了
    return {
      ok: false,
      code: EXIT_CODES.error,
      errorCode: 'error',
      message: `代人执行 ${cmdLine} 时异常：${err instanceof Error ? err.message : String(err)}`
    }
  }
}
