/**
 * 批量命令（1.0.112 域切，卡 d1b71d28）
 *
 * 从 `command-table.ts` 里**整块搬来**的，条目逐字节未改 —— 参数声明与 `run` 都在
 * 这里，`schema` 直接序列化它（接口文档不可能与实现脱节）。
 *
 * ⚠️ 数组**顺序是外部契约**的一部分：`dp help` 的排列、`dp schema` 的命令清单、
 * MCP `tools/list` 的工具顺序都由 `command-table.ts` 里那张表的顺序决定。
 */

import { rowLimitDefault } from '../../../cli/mcp-tools-from-schema'
import { UsageError } from '../../lib/domain-errors'
import { EXIT_CODES, readStdin } from '../command-core'
import type { CommandSpec } from '../command-core'
import { BATCH_TOTAL_LIMIT, batchLineBytes, boundBatchLine } from '../command-batch'
import { executeOne } from '../command-exec'
import { findCommand } from '../command-table'

export const batchCommands: CommandSpec[] = [
  {
    /**
     * batch 自己不写任何数据：子命令逐条走 executeOne，**各自过自己的门禁**。
     * 这里再拦一道只会让"批量只读"也被卡住；真正的判据在每条子命令上。
     */
    name: 'batch',
    dataShape: 'object',
    /**
     * 🚨 **批量执行容器一律按 write 计**（`ce0ea82f`，2026-10-20 修）
     *
     * 这里此前是 `readOnly: true` —— 而 batch 从 stdin 读 NDJSON 并**执行**其中的命令，
     * 那些命令可以是一条 `todo add`。标只读、实际能写，代价是
     * **宿主的确认机制在这条路上失效**：`readOnlyHint` 的意义就是"宿主据此决定
     * 要不要先问用户"，而实测 1.0.107 的 MCP `tools/list` 里 batch 是
     * `readOnlyHint: true`（60 个工具里 29 个只读，它占一个）。
     *
     * ## 为什么不做成"含写命令才 write"
     *
     * 风险档一旦上下文相关，宿主的**静态**判断就没法用了 —— 它必须在调用**之前**
     * 决定要不要弹确认，而那时内容还没到。同理不能只改 MCP 侧那个注解：
     * 那就是两处判据，正是 `1e525804` 修了三轮的形状（四个出口必须同源）。
     *
     * ## 判据
     *
     * **能执行别的命令的入口，不得是 read 档**，由
     * `tests/main/cli/batch-risk-tier-ce0ea82f.test.ts` 的源码扫描闸门钉住
     * （凡是 `run` 里调 `executeOne(` 的命令，一律不许声明成只读）。
     *
     * 代价（有意接受）：`--doc` 与 `--dry-run` 从此也要身份。它们是这个入口的一部分，
     * 而"这个入口要不要身份"必须是一个静态、可读的答案 —— 省掉的那点摩擦，
     * 换不来"同一个入口有两种身份要求"。
     */
    risk: 'write',
    /**
     * 批量容器：**从 stdin 读记录**（1.0.107，修 `0a9f42f8`）。
     *
     * 声明它之后，MCP 的工具表会由 `generateMcpTools` 自动补一个 `records` 入参，
     * 由 handler 拼成 NDJSON 写进子进程的 stdin。此前 MCP 侧只能回「stdin 为空」：
     * 生成出来的工具连内容入口都没有，而 `invokeCli` 的子进程 stdin 是 `'ignore'`。
     */
    stdin: 'ndjson',
    desc: '从 stdin 读取 NDJSON 批量执行，一次进程开销处理多条命令',
    args: [
      {
        flag: '--stop-on-error',
        type: 'boolean',
        desc: '遇到第一条失败立即停止；默认跳过失败项继续执行完'
      },
      {
        flag: '--doc',
        type: 'boolean',
        desc: '输出 batch 记录格式说明（NDJSON 每行的结构），不用传 stdin'
      },
      {
        /**
         * 只校验不执行（1.0.65 修 `1e525804`）
         *
         * 给 agent 一个"动手前先自查一遍"的办法：跑一次就知道哪几行参数写错、
         * 哪几行没权限，而**一条数据都不会动**。
         */
        flag: '--dry-run',
        type: 'boolean',
        desc: '只校验不执行：逐行检查参数与权限，全都不落数据'
      }
    ],
    run: async (ctx, flags) => {
      // 记录格式说明：Bob反馈"猜了 3 次才试出格式"——直接给例子，别让人猜
      if (flags['--doc']) {
        return {
          format:
            'stdin 每行一个 JSON 对象：{"cmd":"<命令名>","args":{"--flag":"值", "--bool":true},"positional":["位置参数"]}',
          fields: {
            cmd: '必填。完整命令名，如 "todo add"；两词命令中间一个空格',
            args: '可选。flag → 值的映射；布尔 flag 传 true 会展开成裸 flag（如 {"--yes":true} → --yes），传 false 展开成 --yes=false；字符串值一律展平成 --flag=值（等号形式，值里带 -- 也不会被当成 flag）',
            positional: '可选。位置参数数组，如 todo done 的 id 要写 "positional":["<id>"]，放进 args 会报"缺少 id"'
          },
          examples: [
            '{"cmd":"todo add","args":{"--title":"调研 X","--created-by":"agent:a","--category":"方向"}}',
            '{"cmd":"todo done","positional":["123e4567"]}',
            '{"cmd":"todo update","args":{"--status":"awaiting_review","--desc":"结论…"},"positional":["123e4567"]}'
          ],
          exitBehavior:
            '默认逐行执行并汇总。退出码口径：**全部失败 → 整体非零**（信封带 allFailed:true）；' +
            '**部分成功 → 整体 ok**（exit 0，需逐条检查 results 里每行的 ok）。' +
            '[!] --stop-on-error 只决定「失败后是否继续跑剩下的行」（首败即停），**与退出码无关** —— ' +
            '不要以为加了它才能拿到非零退出码。',
          bounds:
            '结果体积有两道上界：**单行** 64KB（超了就按条截断：行内 data.truncated=true，' +
            '另给 total/returned/bytes）、**整批** 256KB（到了就停：信封带 data.truncated / data.skipped，' +
            '剩余记录**没有执行**，拆成新的一批再发）。\n' +
            '另外，逐行输出类命令（如 telemetry export）**没在 args 里写 --limit 时，batch 会替它补上默认条数**' +
            '（与 MCP 直连同一份判据、同一个数）；被补过的那一行带 appliedDefaults —— ' +
            '别把"默认那一截"当成全部，要全量就显式写 --limit（写 0 = 不收窄）。',
          dryRun:
            '**--dry-run：只校验不执行，一条数据都不会动。** ' +
            '动手前先自查一遍的标准做法：哪几行参数写错、哪几行没权限，一次看清。' +
            '[!] 它只答"参数与权限过不过"，**不答"目标还在不在"** —— ' +
            '目标解析发生在执行阶段，要判就得真的执行，那与 dry-run 的前提矛盾。' +
            '回执里带 executed:false，别把校验通过当成已经做完。'
        }
      }

      // 管道路径下 stdin 由客户端带过来；无头路径下才读自己进程的
      const raw = ctx.stdin ?? readStdin()
      const lines = raw
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('//'))

      if (!lines.length) throw new UsageError('stdin 为空，没有可执行的命令')

      const results: unknown[] = []
      let failed = 0
      /**
       * 整批体积的记账（1.0.108，修 `a7f94301`）—— 见 `BATCH_TOTAL_LIMIT`。
       *
       * `usedBytes` 量的是**每一行印进整批信封里的**体积（`batchLineBytes`，与单行上界同一把尺），
       * 不是各行单独序列化之和：后者会比真实输出小一截，那样算出来的预算是"假上界"。
       */
      let usedBytes = 0
      let batchTruncated = false
      /**
       * dry-run 用的子 context（1.0.65）
       *
       * 只改这一次循环用的那一份，不动外层 ctx —— 否则退出循环后
       * 同一进程里的后续命令也会以为自己不用执行。
       * （同一进程会跑多条命令：batch 的服务端回放、批准即执行都是这种形状。）
       */
      const runCtx = flags['--dry-run'] === true ? { ...ctx, dryRun: true } : ctx

      for (let i = 0; i < lines.length; i++) {
        let item: { cmd?: string; args?: Record<string, string | boolean>; positional?: string[] }
        try {
          item = JSON.parse(lines[i])
        } catch {
          failed++
          /**
           * ⚠️ `errorCode` 必填（1.0.65 修 `10fcb47f` D1/D2）：
           * 这两行此前只给了数字 `code`，没有 `errorCode` ——
           * 而**同一个 batch 里走 executeOne 的行是有 errorCode 的**
           * （not_found / usage_error / grant_required…）。
           * 于是调用方要按"失败类型"分流时，同一批里两种形状都得处理，
           * 而按 `results[i].errorCode` 过滤的那段会**静默漏掉解析失败的行**。
           *
           * 判据：**失败信封的形状必须一致**，否则"按 code 分流"这个动作
           * 本身就要写两遍 —— 而漏掉的那一遍不会报错，只会少处理一条。
           * 数字 code 保留（退出码语义），errorCode 给稳定的可分流名。
           */
          results.push({
            index: i,
            ok: false,
            code: 'usage_error',
            exitCode: EXIT_CODES.usage,
            errorCode: 'usage_error',
            message: `第 ${i + 1} 行不是合法 JSON`
          })
          if (flags['--stop-on-error']) break
          continue
        }

        if (!item.cmd) {
          failed++
          results.push({
            index: i,
            ok: false,
            code: 'usage_error',
            exitCode: EXIT_CODES.usage,
            errorCode: 'usage_error',
            message: `第 ${i + 1} 行缺少 cmd`
          })
          if (flags['--stop-on-error']) break
          continue
        }

        /**
         * 逐行输出类命令的**默认条数上界**在这里补齐（1.0.108，修 `a7f94301`）。
         *
         * ## 它治的病
         *
         * `7e321f6d` 给"逐行输出的**工具**"兜过默认条数，但那一跳挂在 **MCP handler 的入参**上。
         * batch 的入参是**命令**，而命令自己的 `--limit` 不传就是全量 ——
         * 同一条 `telemetry export`：MCP 直连 21,355 字节，塞进 batch 的记录里 66,113 字节
         * （bob 实测）。宿主把一批命令装进 batch，就推翻了整条"默认有界"。
         *
         * ## 为什么补在 argv 上，而不是让子命令自己去认
         *
         * 命令本身**没有**这个默认：CLI 直连不传 `--limit` 就是全量，那是有意的
         * （`dp telemetry export > 文件` 要拿全量，说明书里写着）。所以默认的生效面是
         * **通道这一侧** —— MCP 直连与 batch 同属通道，补法出自同一个推导
         * （`rowLimitDefault`），不在这里另写一份判据。
         *
         * ## 显式给的条数一律不动
         *
         * 记录里写了 `--limit`（含 `--limit=0` = 全量）就照它的来：默认有界 ≠ 硬上限。
         * 被补过的那一行会在行结果里带 `appliedDefaults` —— **不能让调用方把"默认那一截"
         * 当成全部**（与"静默截断比不截断更坏"同一条底线：补默认也是一种收窄）。
         */
        const cmdTokens = String(item.cmd).split(/\s+/)
        const givenArgs = item.args ?? {}
        const rowDefault = rowLimitDefault(findCommand(cmdTokens)?.cmd ?? {})
        const fillDefault =
          rowDefault && givenArgs[rowDefault.flag] === undefined ? rowDefault : null

        // 复用单条命令的完整执行链路（含必填/枚举校验与错误分类），
        // 保证 batch 与单条调用行为完全一致
        const outcome = await executeOne(runCtx, [
          ...cmdTokens,
          ...(fillDefault ? [`${fillDefault.flag}=${fillDefault.value}`] : []),
          ...Object.entries(givenArgs).flatMap(([k, v]) =>
            /**
             * 一律展平成 `--flag=值`，不再拆成 `--flag 值` 两个 token。
             *
             * Bob 21bd6f34：值本身以 -- 开头时（{"--title":"--help 未注册…"}），
             * 拆开后第二个 token 会被当成 flag，title 静默变成 true。
             * `=` 形式没有这个歧义 —— 等号后面的一切都是值。
             * 顺带修掉布尔 false：老写法 `--yes false` 会把 "false" 掉进位置参数。
             */
            v === true ? [k] : [`${k}=${String(v)}`]
          ),
          ...(item.positional ?? []).map(String)
        ])

        /**
         * 每行结果的信封（1.0.72 修 `10fcb47f` 的 D2，Carol两次驳回）
         *
         * 此前是 `{...outcome}` **原样摊平**，于是行内 `code` 装的是
         * **数字退出码**（3），而顶层 `code` 被 `output.ts` 换成了
         * **字符串 errorCode**（`not_found`）。同一个 `code` 字段在
         * 一份回执里装着两种类型的东西：
         *
         *   直连    code = "not_found"   退出码 3
         *   batch顶层 code = "batch_all_failed"  退出码 1
         *   batch行内 code = 3           errorCode = "not_found"
         *
         * 三套口径。脚本写 `if (code === 'not_found')` 在 batch 里**永远不成立**
         * —— 不报错，只是静默漏掉处理。
         *
         * ⚠️ 注意 `errorCode` 落到行内是对的、别删：1.0.65 Carol认可过
         * "行内给可分流名"这个方向（`errorCode` 是 `10fcb47f` D1 已闭合的部分）。
         * 缺的是**给 `code` 一个稳定的字符串值**。
         *
         * 修法：`code` 改成**与直连同构的字符串**（`errorCode ?? 'error'`），
         * 数字退出码另存为 `exitCode`（不丢信息，且名字说清它是什么）。
         * 顶层也补 `exitCode`，让"退出码"这件事只有一个出处。
         *
         * 判据：**一份回执里同一个字段名只能有一种类型**。
         * 字段名相同而类型不同，比缺字段更坏 —— 它让"读字段"这个动作
         * 在两条路径上悄悄走到不同的分支。
         */
        const { code: exitCodeNumber, ...outcomeRest } = outcome
        /**
         * 每行结果过一道**体积上界**（1.0.107，修 `a7f94301`）：行结果里带着整个
         * `data`，一条导出命令就能把回执撑到 54 万字节（实测 546,868）。
         * 见 `boundBatchLine` —— 截断的是"数据有多大"，不是"这条成没成功"。
         */
        const lineResult = boundBatchLine({
          index: i,
          cmd: item.cmd,
          /**
           * 这一行被补过默认口径的话**必须说出来**（1.0.108，修 `a7f94301`）：
           * 补上 `--limit=50` 之后的 50 条，与"本来就只有 50 条"在回执里长得一模一样，
           * 而后者会让调用方得出"这就是全部"。
           */
          ...(fillDefault ? { appliedDefaults: { [fillDefault.flag]: fillDefault.value } } : {}),
          ...outcomeRest,
          code: outcome.errorCode ?? (outcome.ok ? 'ok' : 'error'),
          /**
           * 成功 Outcome 不带 code（直连成功退出码就是 0），这里补 0 而不是留
           * undefined —— JSON.stringify 会把 undefined 的键整个抹掉，行内就没有
           * `exitCode` 字段，按 exitCode 分流的调用方会把成功行漏判（e209441e）。
           * 与 formatOutcome 的退出码口径同源：成功 0，失败取 code ?? error。
           */
          exitCode: exitCodeNumber ?? (outcome.ok ? EXIT_CODES.ok : EXIT_CODES.error)
        })
        /**
         * 整批的**总量上界**（1.0.108，修 `a7f94301`）—— 见 `BATCH_TOTAL_LIMIT`。
         *
         * 单行上界管不住"很多行"：1000 行 × 单行上界 = 64MB 的回执。
         * 判据仍是那一条：**回执多大不能由数据量决定**；"我写了几行"调用方是看得见的，
         * 但它看不见"一行会有多大"，所以整批也必须有一道自己的上界。
         */
        const lineBytes = batchLineBytes(lineResult)
        if (usedBytes > 0 && usedBytes + lineBytes > BATCH_TOTAL_LIMIT) {
          /**
           * ⚠️ 越过预算的这一行**已经执行了** —— 一行会有多大，要跑完才知道，
           * 执行前拦不下来（"先估体积再决定跑不跑"只是把判据换成猜测）。
           * 所以这里扣的是**数据**，不是**成败**：`ok` / `exitCode` / `errorCode` 照常返回，
           * 只把 `data` 换成一段说明。反过来，**跑了却不说**（整行不返回）才是更坏的：
           * 调用方不知道这条已经生效，重发就会做两遍。
           *
           * 到这里就停：后面的记录**没有执行**（信封里的 `skipped` 告诉你还剩几条）。
           * 不在这里停的话，"每行一段说明"自己就能把回执再撑成无界 —— 上界又要靠自觉。
           */
          results.push({
            ...lineResult,
            data: {
              truncated: true,
              bytes: lineBytes,
              note:
                `本行已执行（ok / exitCode 是真实结果），但结果数据未随回执返回：` +
                `整批体积已达总量上界（${BATCH_TOTAL_LIMIT} 字节）。` +
                `要它的数据就用这条命令自己的翻页参数单独再取。`
            }
          })
          batchTruncated = true
          if (!outcome.ok) failed++
          break
        }
        usedBytes += lineBytes
        results.push(lineResult)
        if (!outcome.ok) {
          failed++
          if (flags['--stop-on-error']) break
        }
      }

      /**
       * notice 去重聚合到顶层（1.0.65，修 `3df42f82`，Bob建议①）
       *
       * 【问题】每条命令的收尾都会重算一遍"未读摘要"，所以一次 batch 里
       * 第 1 条触发的 notice 被后续每条**原样重复**一次 ——
       * Bob实测 20 条命令收到 20 份相同提醒。
       * 代价有三：占上下文、让人误以为是 20 个不同问题、
       * 而**提醒刷屏会降低真正重要提醒的到达率**。
       *
       * 【为什么不能只在顶层算一次】摘要的内容依赖"这一批命令跑完之后"的状态，
       * 而每条执行时的中途状态确实会变（比如第 5 条刚被退回、第 20 条才建好）。
       * 所以正确做法是**收齐后去重**，不是不算。
       *
       * 【口径：只提醒不拦】与 G3/G5 同一档 —— 逐条那份也保留在
       * `results[i].notice` 里，**没抹掉**：调用方要逐条看时仍拿得到，
       * 只是顶层不再重复 20 遍。
       */
      const noticeSet = new Set<string>()
      for (const r of results) {
        const n = (r as { notice?: string }).notice
        if (typeof n === 'string' && n.trim()) noticeSet.add(n.trim())
      }
      const notices = [...noticeSet]

      /**
       * 全败/部分失败的退出码：failed>0 且成功数为 0 时返回非零（exit 1）。
       * Bob反馈：全失败仍 ok:true + exit 0，只看退出码的 agent 会把整批失败当成功。
       * 折中口径：全败 = 整体失败（非零）；部分成功 = 整体 ok（data 里可查 failed），
       * 结果信封同时带 allFailed 标记，不想猜的 agent 读字段。
       */
      const allFailed = failed > 0 && failed === lines.length
      /**
       * 三个返回点统一成**包装形状** `{ __notice?, data: <回执> }`（e209441e，选①）。
       *
       * 此前这里返回平铺的 `{ total, failed, results, __notice }`，不带 `data` 键 ——
       * 而 executeOne 的展开条件要求 `'data' in r`，于是整包（含 `__notice`）被当成
       * data：提醒落进 `data.__notice`，而不是 schema 承诺的顶层 `notice`。
       * 同一条命令直连提醒在顶层、batch 却在 data 里 —— 两条路径不同源。
       *
       * ⚠️ `__notice` 键必须**恒在**（无提醒时值为 undefined，不是不给键）：
       * executeOne 按 `'__notice' in r`（键存在性）认包装 —— 与上面 `todo done`
       * 收口命令 `__notice: … ? undefined : …` 同一约定。键缺席时 `{ data }`
       * 会被当成裸 payload 整包塞进 data（双重包装）。
       */
      /**
       * 整批被切短时的说明（1.0.108，修 `a7f94301`）
       *
       * 三个返回点都要带上它 —— 少带一处，那条路上的调用方就看不到"回执只有一截"，
       * 而这正是本卡要治的"静默"（与逐行截断必须带 `truncated` 同一条底线）。
       *
       * ⚠️ `allFailed` 的判据**没动**（仍是"每一行都失败了"）：被截断时整批根本没跑完，
       * 报"整体失败"是另一个谎。逐行的 `ok` 仍在 `results` 里，分流不受影响。
       */
      const truncation = batchTruncated
        ? {
            truncated: true as const,
            skipped: lines.length - results.length,
            bytes: usedBytes,
            limitBytes: BATCH_TOTAL_LIMIT,
            note:
              `整批结果已达总量上界（${BATCH_TOTAL_LIMIT} 字节，用到 ${usedBytes}），` +
              `因此到此为止：剩下的 ${lines.length - results.length} 条**没有执行**。` +
              `把它们拆成新的一批再发；要看更多数据用子命令自己的 --limit / --since 单独取。`
          }
        : {}
      if (allFailed) {
        return {
          __batchFailure: true,
          message: `批量执行 ${lines.length} 条全部失败，详见 results`,
          ...(notices.length ? { __notice: notices.join('\n') } : { __notice: undefined }),
          data: { total: lines.length, failed, results, ...truncation }
        }
      }
      /**
       * dry-run 的回执必须**自报没执行**（1.0.65）
       *
       * 否则它长得和真跑过一样（`ok:true` + results 里每行也有 ok），
       * 调用方很可能把"校验通过"当成"已经做完了"——
       * 那比报错更贵：它会以为自己已经建好的事项并不存在。
       * 与 G3/G5 软提醒同一个道理：**要说清做了什么、没做什么。**
       */
      if (flags['--dry-run'] === true) {
        return {
          ...(notices.length ? { __notice: notices.join('\n') } : { __notice: undefined }),
          data: {
            total: lines.length,
            failed,
            allFailed,
            dryRun: true,
            executed: false,
            message: `只校验未执行：${lines.length - failed}/${lines.length} 条通过参数与权限校验`,
            results,
            ...truncation
          }
        }
      }
      return {
        ...(notices.length ? { __notice: notices.join('\n') } : { __notice: undefined }),
        data: { total: lines.length, failed, allFailed, results, ...truncation }
      }
    }
  },
]
