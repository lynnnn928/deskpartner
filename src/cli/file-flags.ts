/**
 * 「<flag>-file」文件入参的**唯一定义处**（1.0.73，续做 `3c522bdb`）
 *
 * ── 为什么必须单源 ──
 *
 * 这类参数天生要**跨两个进程**才能完成一次展开：
 *   调用方 → 启动器（读文件，因为只有它与调用方同 cwd）→ 服务端（消费展开后的值）
 * 于是它的正确性由**两份表**共同决定：
 *   1. 启动器侧：哪些 flag 要展开成哪个目标（`expandDescFile` / batch 展开）
 *   2. 服务端侧：收到未展开的形态要**明确报错**，不能静默忽略
 * 此前这两份表各写各的（一份在 `src/cli/launcher.ts`、一份在 `src/main/cli/commands.ts`），
 * 而命令表里还有**第三处**声明（`args` 数组，为了让 `--help` 能发现它）。
 *
 * 三处各自维护的直接后果已经发生过两次：
 * - `--desc-file` 声明进服务端 args 却只在启动器展开 → batch 路径**静默丢正文**（Bob 7f48eb16）；
 * - `--comment-file` 声明进 `todo update` 的 args，但**两张表都没它** →
 *   它既不会被展开（正常调用丢正文），也不会被拦（服务端直接收到时**连报错都没有**，
 *   正文被静默丢弃而调用方拿到 ok:true）。
 *
 * **判据：一个 flag 只要出现在 `args` 里，就必须同时出现在「展开表」与「拦截表」中。**
 * 这条由 `tests/main/cli/cli-wiring-gate.test.ts` 强制。
 */
import fs from 'node:fs'
import path from 'node:path'
/**
 * 本文件抛的是**用法错误**（参数写错 / 文件读不到），所以用 `UsageError`：
 * 它经启动器的失败出口会落成 `usage_error` / exit 2，而不是笼统的 `error` / exit 1
 * —— 调用方要能分清"我参数写错了"（改命令）与"环境坏了"（换台机器）
 * （1.0.110，收 `7a6ac97e`）。
 */
import { UsageError } from '../main/lib/domain-errors'

/** 一个文件入参：`flag` 指向文件路径，展开为 `target` 的值 */
export interface FileFlagSpec {
  /** 文件形式的 flag，如 `--desc-file` */
  flag: string
  /** 展开后的目标参数，如 `--desc` */
  target: string
}

/**
 * 全部「-file」参数。**加新的一行即可，两侧自动跟上** ——
 * 启动器据此展开，服务端据此报错。
 *
 * ⚠️ 新增前先确认 `target` 那条参数确实存在且被消费；
 * 本表不负责校验这一点，闸门测试负责。
 */
export const FILE_FLAGS: readonly FileFlagSpec[] = [
  { flag: '--desc-file', target: '--desc' },
  { flag: '--body-file', target: '--body' },
  /**
   * `--comment-file` → `--comment`（1.0.73 修）
   *
   * 它此前只声明在 `todo update` 的 args 里，属于"为文档目的声明、
   * 实现没跟上"的第三例 —— 而评论正文恰恰是最需要它的一类内容：
   * 收口结论多行、含反引号与路径，经 shell 会被静默吞掉。
   */
  { flag: '--comment-file', target: '--comment' }
]

/**
 * 展开输入里的读取器。默认读真实文件；
 * 测试可注入假实现而**不必造磁盘文件**（判定逻辑因此可单测）。
 */
export type FileReader = (file: string) => string

const defaultReader: FileReader = (file) => fs.readFileSync(path.resolve(file), 'utf8')

/**
 * 展开单条 argv 里的 `<flag>-file`：读文件，替换成 `target <内容>`。
 *
 * ⚠️ **必须在启动器侧执行**，不能在服务端：服务端是常驻 GUI 进程，
 * 它的 cwd 是 GUI 启动时的目录、不是调用方的 —— 相对路径会读错文件。
 * 启动器与调用方同进程同 cwd，在这里展开语义才对。
 *
 * 支持两种写法（与 `parseFlags` 的取值形态一致）：
 * - `--desc-file <path>`
 * - `--desc-file=<path>`
 *
 * 读不到文件时**抛错**（走启动器统一出口），不静默跳过 ——
 * 静默跳过等于又回到"内容丢了但命令成功"那类缺陷。
 */
export function expandFileFlags(args: string[], read: FileReader = defaultReader): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    let matched: FileFlagSpec | undefined
    let file: string | undefined

    for (const m of FILE_FLAGS) {
      if (a === m.flag) {
        matched = m
        /**
         * ⚠️ 这里必须区分"后面没有 token"与"后面有 token"：
         * 老实现把 `undefined` 与"没匹配上"合并处理，于是 `--comment-file`
         * 出现在**末尾**时既不展开、也不报错 —— 静默透传给服务端，
         * 而服务端会因为它是已知 flag 而"接受"它（0→usage_error 都没有）。
         * 一个写错的调用就这样变成了"看着没毛病"。
         */
        file = args[i + 1]
        i++
        break
      }
      if (a.startsWith(m.flag + '=')) {
        matched = m
        // `--flag=` 后面是空串 → 走下面的"需要一个文件路径"报错
        file = a.slice(m.flag.length + 1)
        break
      }
    }

    // 没匹配上任何文件参数：原样透传（不是我们要管的 flag）
    if (!matched) {
      out.push(a)
      continue
    }
    // 匹配上了但没值 / 值是空串：明确报错，不静默透传
    if (!file) {
      throw new UsageError(`${matched.flag} 需要一个文件路径`)
    }
    try {
      out.push(matched.target, read(file))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new UsageError(`${matched.flag} 读不到「${file}」: ${msg}`)
    }
  }
  return out
}

/**
 * 展开 batch 输入**每一行 JSON 里**的 `<flag>-file`。
 *
 * 为什么要单独一条路径：batch 的每行命令由**服务端**展平成 argv，
 * 不经过启动器的主参数展开。Bob实测（1.0.41）就是这里丢的内容 ——
 * `batch` 里那条 `todo add --desc-file x.txt` 返回 ok=true 还给了 id，
 * 但事后查库 desc 长度为 0、内容整段没了，而单条命令下同一个文件完全正常。
 *
 * 非 JSON 行、结构不符的行**原样透传**：让服务端去报它该报的错，
 * 不在这里吞掉。读文件失败则抛错（与单条路径一致）。
 */
export function expandFileFlagsInBatch(
  argv: string[],
  stdin: string | undefined,
  read: FileReader = defaultReader
): string | undefined {
  if (!stdin) return stdin
  // 只有 batch 需要这一层：单条命令的 args 已经在 expandFileFlags 里处理过了
  if (argv[0] !== 'batch') return stdin

  let touched = false
  const out = stdin.split('\n').map((line) => {
    const trimmed = line.trim()
    if (!trimmed) return line
    let obj: { args?: Record<string, unknown> }
    try {
      obj = JSON.parse(trimmed) as { args?: Record<string, unknown> }
    } catch {
      return line // 非 JSON：原样透传
    }
    const args = obj?.args
    if (!args || typeof args !== 'object') return line

    const entry = FILE_FLAGS.find((m) => typeof args[m.flag] === 'string')
    if (!entry) return line
    const file = args[entry.flag] as string

    if (!file) throw new UsageError(`${entry.flag} 需要一个文件路径`)
    let content: string
    try {
      content = read(file)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new UsageError(`${entry.flag} 读不到「${file}」: ${msg}`)
    }
    delete args[entry.flag]
    args[entry.target] = content
    touched = true
    return JSON.stringify(obj)
  })

  return touched ? out.join('\n') : stdin
}
