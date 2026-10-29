import net from 'node:net'
import {
  pipeName,
  encodeMessage,
  EXEC_TIMEOUT_MS,
  type PipeRequest,
  type PipeResponse
} from '../../cli/pipe-protocol'
import { executeOne, guessCmdName, EXIT_CODES, type CliContext } from '../cli/commands'
import { formatOutcome, formatHelp } from '../cli/output'

/**
 * 通道 A：常驻命名管道服务端
 *
 * GUI 在跑时由它接活。和通道 B（无头启动一个进程）相比：
 * - 延迟从几百毫秒降到个位数毫秒
 * - 不新增进程（GUI 本来就常驻），也不吃额外的内存
 *
 * 命令执行复用 executeOne —— 与无头通道、与 batch 都是同一套逻辑，
 * 不允许出现"管道能用但命令行不能用"这种分叉。
 */
export class CliServerService {
  private server: net.Server | null = null
  private ctx: CliContext

  constructor(ctx: CliContext) {
    this.ctx = ctx
  }

  get isListening(): boolean {
    return this.server !== null
  }

  /** 启动监听；失败不抛异常，只是通道 A 不可用，调用方会自然降级 */
  start(): void {
    if (this.server) return

    try {
      const server = net.createServer((socket) => this.handleConnection(socket))

      server.on('error', (err) => {
        /**
         * 最常见的失败是同机另一个实例已经占着这个管道名（或权限异常）。
         * 这不该影响主功能 —— 通道 A 只是快路径，没有它照样能跑，
         * 所以这里只记日志、不抛出、不重试。
         */
        console.error('[CliServer] 通道 A 监听失败，将只提供无头通道:', err.message)
        this.server = null
      })

      server.listen(pipeName(), () => {
        console.log(`[CliServer] 通道 A 已监听: ${pipeName()}`)
      })

      this.server = server
    } catch (err) {
      console.error(
        '[CliServer] 通道 A 启动异常:',
        err instanceof Error ? err.message : String(err)
      )
      this.server = null
    }
  }

  stop(): void {
    if (this.server) {
      this.server.close()
      this.server = null
    }
  }

  /** 一条连接处理一条命令，处理完即关闭 —— 简单且不会有状态残留 */
  private handleConnection(socket: net.Socket): void {
    let buffer = ''
    let done = false

    const finish = (resp: PipeResponse) => {
      if (done) return
      done = true
      socket.end(encodeMessage(resp))
    }

    // 显式标 number：EXIT_CODES 是 as const，默认值会把类型收窄成字面量 1，
    // 之后传 usage(2) / notFound(3) 就都成了类型错误
    const fail = (stdout: string, exitCode: number = EXIT_CODES.error) =>
      finish({ stdout, exitCode })

    socket.setEncoding('utf8')
    /**
     * 超时分成两段，语义完全不同，必须分开看：
     *
     * ① **等待请求**（下面这 30 秒）：连上却不发数据。这是纯粹的异常，
     *    超时直接回失败，因为服务端什么都没做，**没有副作用要担心**。
     *
     * ② **执行命令**（见 EXEC_TIMEOUT_MS）：这条原来被 `socket.setTimeout(0)`
     *    整个关掉了 —— 于是命令一旦开始执行就永不超时。而客户端有 30 秒
     *    响应超时（RESPONSE_TIMEOUT_MS），两边口径不一致，制造出一个
     *    **危险窗口**：客户端已经报"可能已执行，请先确认"，服务端却还在
     *    写库，而且会一直写下去。调用方看到失败去重试，就可能重复写入。
     *
     * ②的修法不是简单加个超时 —— 那只会把"客户端先报错"变成"服务端先报错"，
     * 问题依旧是"报错时不知道执行到哪"。所以：
     *   - 超时值取得**比客户端大**（45s vs 30s），让客户端总是先放弃，
     *     服务端多留 15 秒把当前命令跑完 —— 命令跑完的结果留在库里，
     *     而不是被中途掐断留下半截状态；
     *   - 超时后**不再尝试写回响应**（客户端多半已断开），只记一条 warn，
     *     让日志里有据可查。
     */
    socket.setTimeout(30000, () => {
      if (!done) fail(JSON.stringify({ ok: false, code: 'timeout', message: '命令处理超时' }) + '\n')
    })

    socket.on('data', async (chunk: string) => {
      buffer += chunk
      const nl = buffer.indexOf('\n')
      if (nl === -1) return

      const line = buffer.slice(0, nl)

      let req: PipeRequest
      try {
        req = JSON.parse(line)
      } catch {
        fail(JSON.stringify({ ok: false, code: 'usage_error', message: '请求不是合法 JSON' }) + '\n', EXIT_CODES.usage)
        return
      }

      const tty = req?.tty === true

      if (!Array.isArray(req?.argv)) {
        fail(JSON.stringify({ ok: false, code: 'usage_error', message: '缺少 argv' }) + '\n', EXIT_CODES.usage)
        return
      }

      /**
       * 停止 ①（等待请求）的计时，改为 ②（执行期）。**不能清零** ——
       * 清零等于把超时整个关掉，命令跑多久都不会有记录。
       */
      const argvForLog = req.argv.map(String)
      socket.setTimeout(EXEC_TIMEOUT_MS, () => {
        if (done) return
        /**
         * 走到这里说明命令跑了 45 秒还没完。**不写响应**：
         * 客户端 30 秒就放弃了，写过去也没人收。只记日志。
         * 也不调 fail() —— 那会把 done 置 true，让命令正常结束时
         * 的 finish 变成 no-op，反而吞掉真正的结果。
         */
        console.warn(
          `[CliServer] 命令执行超过 ${Math.round(EXEC_TIMEOUT_MS / 1000)} 秒未返回，` +
            `客户端可能已超时放弃。命令继续执行完，结果以数据库为准：` +
            `${argvForLog.join(' ')}`
        )
      })

      // 无参数 / --help 走帮助输出，与无头通道一致
      if (!req.argv.length || req.argv[0] === '--help' || req.argv[0] === '-h') {
        /**
         * 转发 `help` 命令取数据（1.0.75 修 `1e525804` 第四处）。
         *
         * 此前这里把整个命令对象倒进 formatHelp —— 与无头通道拼的 name+desc 简表
         * 形状都不一样，readOnly/risk 随源表残缺（Carol三次驳回的那处）。
         * 顶层 `--help` 不许自己持有命令清单：两通道都转发 `help`，同源。
         * help 是只读自省命令，不动 ctx / 不落数据，用共享 ctx 无碍。
         */
        finish(formatHelp(await executeOne(this.ctx, ['help']), req.argv.map(String), tty))
        return
      }

      const startedAt = Date.now()
      /**
       * 用展开构造一份本次请求专属的 ctx，而不是往共享的 this.ctx 上写 stdin ——
       * 后者在两条连接交错时会把 A 的 stdin 泄漏给 B。
       * deps / meta 是只读的，浅拷贝共享引用即可。
       * actor 同理是请求专属的：调用方 shell 里 export 的 DESKPARTNER_AGENT
       * 由客户端带进报文，服务端进程自己的环境变量跟调用方毫无关系。
       */
      const callerActor = req.actor?.trim() || 'human'
      const outcome = await executeOne(
        {
          ...this.ctx,
          stdin: req.stdin,
          actor: callerActor,
          // 声明与推断分开（1.0.46）：actor 可能来自"自动带上唯一那份凭据"，
          // 那不是自称。ambiguous_identity 判据靠它区分，否则会误判调用方声明过身份。
          identityDeclared: req.identityDeclared === true,
          credential: req.credential?.trim() || undefined,
          /**
           * 管道通道下**恒定 false**："人在场"在这里不可验证（P0 修复）。
           *
           * 服务端是常驻的 GUI 进程，它看不到调用方有没有终端 ——
           * `req.tty` / `req.interactive` 都是调用方自报的，
           * 任何连得上管道的进程填一个 true 就能跳过凭据校验、
           * 分级授权与 approved 三道闸门（2026-09-22 实测复现）。
           *
           * 真正的"人在场"只能由**服务端自己观测**，而那只发生在无头通道
           * （那个进程是被调用方直接 spawn 的，stdio 继承，能看 process.stdout）。
           * 所以有终端的调用方会由启动器直接送去无头通道，见 launcher.ts。
           *
           * 这里仍然保留 `tty` 字段的读取，但只用于**输出格式**
           * （人读文本 / 机读 JSON），不再参与授权 —— 与管道协议里
           * "tty 决定输出格式、interactive 决定要不要卡身份"的分工一致，
           * 只是现在 interactive 在这个通道上没有可信来源，只能是 false。
           */
          interactive: false,
          // 会话 id：分级授权里"仅本次会话有效"靠它判定，缺了就只能给长期授权
          session: req.session?.trim() || undefined,
          // 多份凭据未声明身份：由客户端发现并带过来（服务端看不到调用方的主目录）
          ...(req.ambiguousIds?.length ? { ambiguousIds: req.ambiguousIds } : {}),
          /**
           * 说明书版本（G8 漂移提醒）：**同样必须由客户端带过来**（1.0.57）。
           * 服务端是常驻 GUI 进程，`process.env` 里没有调用方声明的那个变量 ——
           * 原先命令实现直接读 env，导致 GUI 一开着漂移提醒就静默失效
           * （Bob实测 52b6b726）。与 actor / credential / session 同一类问题。
           */
          ...(req.skillVersion?.trim() ? { skillVersion: req.skillVersion.trim() } : {}),
          /**
           * 通道标识（1.0.63）：由客户端带过来（服务端看不到调用方环境）。
           * 命令层（如 whoami）用它给"你正通过 MCP 调用"这类对话定调；
           * 埋点也用它区分 mcp/cli —— 此前硬编码 'cli'，MCP 用量看不见。
           */
          ...(req.surface?.trim() ? { surface: req.surface.trim() } : {})
        },
        req.argv.map(String)
      )

      // 埋点：记下这次是走管道来的，便于观察通道 A 的实际使用与降级情况
      const isTelemetryCmd = req.argv[0] === 'telemetry'
      // 只格式化一次：埋点要读它的退出码，返回值也要用它
      const formatted = formatOutcome(outcome, req.argv.map(String), tty)
      if (!isTelemetryCmd) {
        try {
          this.ctx.deps.telemetry.record({
            actor: callerActor,
            // 与无头通道同一判据（1.0.63）：MCP 调用经客户端声明 surface=mcp，
            // 缺省 cli。不再硬编码，否则两通道的 MCP 用量一个记对、一个记错。
            surface: req.surface?.trim() || 'cli',
            category: 'cli',
            event: 'invoke',
            ok: outcome.ok,
            durationMs: Date.now() - startedAt,
            /**
             * 对话级标识（1.0.49，修 3d6e4395）：调用方的 DESKPARTNER_SESSION
             * 经客户端带入报文，必须走**顶层 sessionId** 而不是 props ——
             * 塞进 props 的话 `session_id` 列仍是实例 uuid，按对话归组无效
             * （无头通道 run.ts 同款问题，一起修的）。
             */
            ...(req.session?.trim() ? { sessionId: req.session.trim() } : {}),
            props: {
              // 失败也要记命令名：失败多半发生在参数校验阶段，此时命令名已经解析得出来。
              // 全记 "(unknown)" 的话，最想看的「agent 常在哪条命令上犯错」就归不了因。
              cmd: guessCmdName(req.argv, outcome.ok),
              channel: 'pipe',
              // 与无头通道保持一致：退出码 + 错误码（1.0.37 补回，理由见 run.ts）
              exitCode: formatted.exitCode,
              ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {})
            }
          })
        } catch {
          // 埋点失败不影响命令结果
        }
      }

      finish(formatted)
    })

    socket.on('error', () => {
      // 客户端提前断开是正常情况（比如它自己超时了），无需处理
    })
  }
}
