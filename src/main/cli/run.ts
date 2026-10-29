/**
 * CLI 无头通道入口（通道 B）
 *
 * 以无头模式复用程序本体执行：better-sqlite3 是按 Electron 运行时编译的，
 * 独立的 Node 程序加载不了，所以命令行必须跑在同一个运行时里，
 * 同时也能直接复用 Repository 层，不重复实现一套业务逻辑。
 *
 * 代价：每次调用都要起一个进程（冷启动偏慢）。所以客户端会优先尝试
 * 通道 A（常驻命名管道），连不上才落到这里。见 src/cli/launcher.ts。
 */
import { app } from 'electron'
import { executeOne, actorOf, guessCmdName, type CliContext } from './commands'
import { formatOutcome, formatHelp } from './output'

/** 从 process.argv 中取出 --cli 之后的参数 */
export function extractCliArgs(argv: string[]): string[] | null {
  const idx = argv.indexOf('--cli')
  if (idx === -1) return null
  return argv.slice(idx + 1)
}

/** 执行 CLI；本函数不会返回（内部调用 app.exit） */
export async function runCli(args: string[], ctx: CliContext): Promise<never> {
  const tty = Boolean(process.stdout.isTTY)

  const emit = (res: { stdout: string; exitCode: number }) => {
    process.stdout.write(res.stdout)
    app.exit(res.exitCode)
  }

  try {
    if (!args.length || args[0] === '--help' || args[0] === '-h') {
      /**
       * 顶层 `--help` / `-h` / 无参数：**转发给 `help` 命令取数据**，不自己拼清单
       * （1.0.75 修 `1e525804` 第四处，Carol三次驳回同一处）。
       *
       * 此前这里 `commands.map(({name, desc}))` 拼一份简表、管道侧又倒整个命令对象 ——
       * 同一个 `--help` 两条通道两种输出，readOnly/risk 缺失或残缺。
       * 现在顶层 --help 与 `dp help` 是同一份数据（见 output.ts 的 formatHelp）。
       *
       * Bob实测仍成立：连 args 一起序列化"看一眼"要 1.7 万字节，agent 读不起 ——
       * 所以顶层出的是 `help` 的简表（name/desc/readOnly/risk），不是 schema 全量。
       */
      emit(formatHelp(await executeOne(ctx, ['help']), args, tty))
      return undefined as never
    }

    // 子命令级 help：dp todo add --help
    const last = args[args.length - 1]
    if ((last === '--help' || last === '-h') && args.length > 1) {
      const cmdName = args.slice(0, -1).join(' ')
      const outcome = await executeOne(ctx, ['help', cmdName])
      emit(formatOutcome(outcome, args, tty))
      return undefined as never
    }

    const outcome = await executeOne(ctx, args)

    /**
     * 用 process.uptime() 而不是自己记时刻：
     * 一次调用的耗时大头是 Electron 二进制启动，而那段发生在
     * 我们的任何代码执行之前，自己计时无论如何都测不到。
     */
    const durationMs = Math.round(process.uptime() * 1000)

    const formatted = formatOutcome(outcome, args, tty)

    // telemetry 自身的命令不记，否则看统计时会自我放大
    if (args[0] !== 'telemetry') {
      /**
       * 对话级标识（1.0.49，修 3d6e4395）
       *
       * agent 侧 `export DESKPARTNER_SESSION=<对话 id>` 即可把同一轮对话里的
       * 多次调用串到同一个 `session_id` 上 —— 「规则给进去、十几二十轮之后
       * agent 不登记了」这条曲线全靠它才算得出来。
       *
       * ⚠️ 必须走**顶层 sessionId**，不能塞进 props：
       * 此前这里写的是 `props: { ..., sessionId }`，而 TelemetryService 的
       * record() 会把 `session_id` 列硬写成实例 uuid —— 于是这个标识
       * 只躺在 props 里、按会话归组的统计完全没用上。实测确认过：
       * 传 `DESKPARTNER_SESSION=dialog-test-abc`，导出的 `sessionId`
       * 仍是随机 uuid，标识只出现在 `props.sessionId`。
       */
      const dialogId = process.env.DESKPARTNER_SESSION?.trim()
      /**
       * 调用方走的哪张皮（1.0.63）：MCP 工具进程 spawn 启动器时会设
       * `DESKPARTNER_SURFACE=mcp`，启动器原样传下去。无头路径下"服务端就是
       * 调用方的子进程"，读自己的 env 是对的；管道路径则由启动器带进请求体
       * （见 cli-server.service.ts）——与 skillVersion 同一条规矩：
       * **命令/埋点层不要自己假设通道**，那正是"surface 硬编码 cli"的成因。
       */
      const surface = process.env.DESKPARTNER_SURFACE?.trim() || 'cli'
      ctx.deps.telemetry?.record({
        // 无头通道的调用方身份就在本进程的环境变量里（launcher spawn 时原样继承）
        actor: actorOf(ctx),
        surface,
        category: 'cli',
        event: 'invoke',
        ok: outcome.ok,
        durationMs,
        ...(dialogId ? { sessionId: dialogId } : {}),
        props: {
          // 只记命令名，不记参数值 —— 参数里可能带待办正文。
          // 失败也要尽力归因：全记 (unknown) 的话，「常在哪犯错」就看不到了。
          cmd: guessCmdName(args, outcome.ok),
          channel: 'headless',
          /**
           * 退出码 + 错误码（1.0.37 补回）。
           *
           * 早先 props 里记的是 exitCode，某次改动换成 channel 时把它顶掉了 ——
           * 于是 id 11~159 有 exitCode、之后的记录全没有，Bob在排障时发现
           * "新记录失败行的 props.exitCode 是 None，旧记录有值"，怀疑字段迁移了。
           * 没有迁移，是丢了。布尔 ok 只说明成败，而 2/3/4 能区分
           * 用法错误 / 目标不存在 / 守卫拒绝 —— 归因失败原因时差的就是这一档。
           */
          exitCode: formatted.exitCode,
          ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {})
        }
      })
    }

    emit(formatted)
  } catch (err) {
    // executeOne 已吞掉命令内部的错误，这里只兜住调度层之外的意外
    const message = err instanceof Error ? err.message : String(err)
    emit({
      stdout: JSON.stringify({ ok: false, code: 'error', message }, null, 2) + '\n',
      exitCode: 1
    })
  }

  return undefined as never
}
