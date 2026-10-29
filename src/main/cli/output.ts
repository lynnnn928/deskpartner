import { EXIT_CODES, type Outcome } from './commands'

/**
 * CLI 输出格式化
 *
 * 两条通道（无头进程 / 常驻管道）必须产出**完全相同**的输出与退出码，
 * 否则调用方就得区分自己走的是哪条 —— 那通道就不再是透明的了。
 * 所以格式化只在这里做一次，两侧都调它。
 */

/** 人读模式下的打印 */
function printHuman(label: string, data: unknown): string {
  const lines: string[] = []
  const out = (s: string) => lines.push(s)

  if (data === null || data === undefined) {
    out(`${label}: (空)`)
    return lines.join('\n') + '\n'
  }

  if (Array.isArray(data)) {
    if (!data.length) {
      out(`${label}: (0 条)`)
      return lines.join('\n') + '\n'
    }
    out(`${label}: ${data.length} 条`)
    for (const row of data) {
      if (row && typeof row === 'object') {
        const r = row as Record<string, unknown>
        // 待办用 title，分类用 name，其余退回 id
        const head = r.title ?? r.name ?? r.id ?? ''
        out(`  - ${String(head)}  [${String(r.id ?? '')}]`)
      } else {
        out(`  - ${String(row)}`)
      }
    }
    return lines.join('\n') + '\n'
  }

  if (typeof data === 'object') {
    out(`${label}:`)
    out(JSON.stringify(data, null, 2))
    return lines.join('\n') + '\n'
  }

  out(`${label}: ${String(data)}`)
  return lines.join('\n') + '\n'
}

export interface FormattedResult {
  stdout: string
  exitCode: number
}

/**
 * 把执行结果格式化成"该写进 stdout 的内容 + 退出码"
 *
 * @param tty 调用方是不是人在终端里直接敲的。这个判断必须在**客户端**做：
 *            服务端在常驻进程里，它看自己的 stdout 永远是"非 TTY"。
 */
export function formatOutcome(
  outcome: Outcome,
  argv: string[],
  tty: boolean
): FormattedResult {
  const asJson = !tty

  if (outcome.ok && outcome.output === 'text') {
    // 原样输出：给 Markdown 这类内容用，不能套 JSON 信封
    return { stdout: String(outcome.data ?? ''), exitCode: EXIT_CODES.ok }
  }

  if (outcome.ok && outcome.output === 'ndjson') {
    // 纯 NDJSON：不加 JSON 信封，方便直接重定向成文件
    const rows = Array.isArray(outcome.data) ? outcome.data : []
    return {
      stdout: rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''),
      exitCode: EXIT_CODES.ok
    }
  }

  if (outcome.ok) {
    if (asJson) {
      return {
        // notice（G3 软提醒）必须进信封：Bob实测证实它此前被整个丢掉，
        // agent 侧永远收不到 —— 提醒写了等于没写
        //
        // meta（1.0.63 计数摘要）同理进顶层信封：它是"关于 data 的元信息"，
        // 塞进 data 会改变 data 形态（数组→对象），静默破坏按数组解析的调用方。
        stdout:
          JSON.stringify(
            {
              ok: true,
              data: outcome.data,
              ...(outcome.notice ? { notice: outcome.notice } : {}),
              ...(outcome.meta ? { meta: outcome.meta } : {})
            },
            null,
            2
          ) + '\n',
        exitCode: EXIT_CODES.ok
      }
    }
    // 人读模式：提醒走 stderr 更合适，但这里只有 stdout 一个出口，就拼在正文前
    //
    // ⚠️ 前缀用 ASCII `[!]` 而不是 emoji（1.0.49）：
    // 产品原则第七条是「全界面禁 emoji」，而设计原则又写明「CLI 是第二用户界面」——
    // 两句合起来规范本应覆盖 CLI。这个位置尤其不能留 emoji：它是 agent 读
    // 输出时**最先看到**的地方，而 `⚠` 是双宽字符，终端里宽度不稳定，
    // 对按列对齐解析的调用方也不友好。
    const noticePrefix = outcome.notice ? `[!] ${outcome.notice}\n` : ''
    return {
      stdout: noticePrefix + printHuman(argv.join(' '), outcome.data),
      exitCode: EXIT_CODES.ok
    }
  }

  if (asJson) {
    /**
     * 失败信封也要带上 data —— 1.0.37 修（Bob be59a4cd）。
     *
     * batch 全部失败时把逐行结果放在 data.results 里，message 写着"详见 results"，
     * 但这里此前只序列化 {ok, code, message}，把 data 整个丢掉了 ——
     * 报错文案指向一个信封里不存在的字段，调用方想看哪一行失败只能改用单条命令重跑。
     * 失败时的附加信息（逐行结果、affected 之类）和成功时一样是调用方的证据，
     * 不该因为整体判失败就一起丢掉。
     */
    const envelope: Record<string, unknown> = {
      ok: false,
      code: outcome.errorCode,
      message: outcome.message
    }
    /**
     * firstFailure 也必须进信封（1.0.73 修 `51958ed9`）：batch 全败时它是
     * "第一条失败"的摘要，executeOne 已经把它放进 Outcome，但这里此前只序列化
     * ok/code/message/data —— 承诺了三处（docs/RELEASES.md、README、
     * commands.ts 注释）、实拿零处。顶层给摘要，逐行细节仍在 data.results。
     */
    if (outcome.firstFailure !== undefined) envelope.firstFailure = outcome.firstFailure
    if (outcome.data !== undefined) envelope.data = outcome.data
    return {
      stdout: JSON.stringify(envelope, null, 2) + '\n',
      exitCode: outcome.code ?? EXIT_CODES.error
    }
  }
  return {
    stdout: `错误: ${outcome.message}\n`,
    exitCode: outcome.code ?? EXIT_CODES.error
  }
}

/**
 * 顶层帮助输出（`--help` / `-h` / 不带参数）
 *
 * 🚨 数据一律来自 **`help` 命令的执行结果**，这里只做呈现（1.0.75 修 `1e525804` 第四处）。
 *
 * 此前两个通道各自拼一份、还拼得不一样：无头 run.ts 只给 name+desc，
 * 管道 cli-server.service.ts 把整个命令对象倒出来 —— 同一个 `--help` 两种输出，
 * readOnly/risk 残缺不齐（Carol三次驳回的正是这一处：50 条里 28 条整段缺 readOnly）。
 *
 * 判据（本卡第四次栽跟头后的收口）：**顶层 `--help` 不许自己持有任何命令清单** ——
 * 转发 `help` 取数，于是它与 `dp help` 非 TTY 下连字节都一致；
 * 想再分叉出第五处都没有地方落。
 */
export function formatHelp(helpOutcome: Outcome, argv: string[], tty: boolean): FormattedResult {
  if (!helpOutcome.ok) return formatOutcome(helpOutcome, argv, tty)
  // 机读：与 `dp help` 同一信封、同一 data —— 同源的最强形式是"同一份字节"
  if (!tty) return formatOutcome(helpOutcome, argv, false)
  // 人读：对齐的命令表，风险档跟着每条走（人也要一眼看出哪条是写命令）
  const data = helpOutcome.data as {
    tip?: string
    commands: { name: string; desc: string; risk: string }[]
  }
  const lines = ['用法: deskpartner <命令> [参数]', '']
  for (const c of data.commands) {
    lines.push(`  ${c.name.padEnd(18)} ${c.desc}  [${c.risk}]`)
  }
  if (data.tip) lines.push('', data.tip)
  return { stdout: lines.join('\n') + '\n', exitCode: EXIT_CODES.ok }
}
