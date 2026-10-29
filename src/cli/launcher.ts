#!/usr/bin/env node
/**
 * deskpartner 命令行入口（客户端）
 *
 * 两条通道，优先后者更快：
 * - 通道 A：连常驻 GUI 的命名管道 → 个位数毫秒
 * - 通道 B：启动一个 Electron 无头进程 → 几百毫秒，且每次吃一份内存
 *
 * 本文件必须保持**纯 Node**：一旦它自己加载 Electron，
 * 降级的价值就没了 —— 那几百毫秒启动开销正是要省掉的东西。
 * 所以这里只 import node: 内置模块、本目录的纯 Node 模块（pipe-protocol /
 * credentials / file-flags），以及服务端那两个**叶子**模块（错误码清单、
 * 域错误类型）—— 它们都不依赖 Electron（1.0.110 起）。
 */
import net from 'node:net'
import path from 'node:path'
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import {
  pipeName,
  encodeMessage,
  CONNECT_TIMEOUT_MS,
  RESPONSE_TIMEOUT_MS,
  type PipeRequest,
  type PipeResponse
} from './pipe-protocol'
import { pickCredential, listCredentialIds } from './credentials'
import { expandFileFlags, expandFileFlagsInBatch } from './file-flags'
/**
 * 启动器自己的失败出口要用服务端那份分类（`classifyError` / `formatUncaughtFailure`）。
 *
 * 这两个是纯叶子模块（错误码清单 + 域错误类型），不碰 Electron、不碰数据库，
 * 所以"本文件不加载 Electron"的前提没变。
 */
import { formatUncaughtFailure } from '../main/cli/error-codes'

/**
 * `--desc-file <path>`：把文件内容展开成 `--desc`（1.0.39）
 *
 * 为什么要它：往 --desc 传含反引号 / 尖括号 / $ 的长文本时，
 * bash 会先做命令替换与重定向，内容被**静默吞掉**且命令仍返回 ok、
 * 不报错（实测登记看板时整段描述消失过一次，事后才发现）。
 * 现在只能绕：先写脚本生成 NDJSON 再 cat 进 batch，多一步还不好排查。
 *
 * 为什么放在启动器而不是服务端展开：
 * ① 服务端是常驻 GUI 进程，它读的文件路径未必是调用方想指的那个；
 * ② 启动器展开后，管道走 JSON、无头走 spawn 数组传参，
 *    两条通道都不经过 shell，特殊字符天然安全 —— 服务端完全不必知道
 *    这个 flag 的存在。
 *
 * ⚠️ 保留的既有语义：`--desc ""` 等于**清空描述**，空串有含义。
 * 所以文件读到空内容时如实展开成空串（= 清空），不擅自改成跳过。
 *
 * ⚠️ 失败时**抛错、不自己输出**（1.0.40 修）。
 * Bob复测报的：这里原先直接 `console.error(...) + process.exit(2)`，
 * 输出的是人类可读纯文本 —— 而 CLI 的契约是"非 TTY 时 stdout 给
 * {ok,code,message} 信封"。按契约解析 stdout 的 agent 拿到的是空输出，
 * 只知道"exit 2"，不知道错在哪。抛出去让 main().catch 走统一出口，
 * 那里本来就分 TTY（人读文本）/ 非 TTY（JSON 信封）两种。
 */

/**
 * 可被展开的「<flag>-file」对：文件内容展开成对应参数。
 *
 * 1.0.54 从只有 --desc-file 泛化而来 —— `todo comment --body` 成了长文本的
 * 主要入口（往来都走评论），它和 --desc 有**完全一样**的遭遇：
 * 多行 / 含反引号 $ < 的正文经 shell 会被静默吞掉，命令仍返回 ok。
 * 实测踩到：`todo comment <id> --body "第一行\n第二行"` 直接报
 * "未知命令"，因为换行把 argv 切断了。
 *
 * 为什么在启动器展开而不是服务端：见上面的说明 ①②（服务端读不到调用方的相对路径；
 * 两条通道都不经 shell）。服务端永远收不到 `-file` 形式。
 *
 * ── 1.0.73：清单与展开逻辑都搬到 `./file-flags`（单源） ──
 *
 * 此前这里与 `commands.ts` 的拦截表各写一份，于是 `--comment-file`
 * 声明进命令表后**两边都没跟上**，变成"接受但什么都不做"。
 * 现在定义处只有一个，本文件只做转发（保留本地函数名，调用点不动）。
 */
function expandDescFile(args: string[]): string[] {
  return expandFileFlags(args)
}

const tty = Boolean(process.stdout.isTTY)

/**
 * 展开 batch 输入里每行的文件入参（1.0.41 起；1.0.73 搬到单源）
 *
 * Bob实测报的：`batch` 里那条 `todo add --desc-file x.txt` 返回 ok=true 还给了 id，
 * 但事后查库 **desc 长度为 0，内容整段没了** —— 单条命令下同一个文件却完全正常。
 *
 * 根因是两条参数处理路径不重合：文件入参只在**启动器**展开，而 batch 里
 * 每条命令的 args 是**服务端**展平成 argv 的，压根不经过启动器。
 * 更糟的是我上一版为了 help 可发现性，把 `--desc-file` 也声明进了服务端的
 * args 表 —— 于是服务端从"报未知 flag"（能被发现）变成了"认识但不处理"
 * （**静默忽略**）。教训：**为了文档目的声明一个 flag，会顺带把它在别的
 * 路径上变成"接受但不处理"**，声明和实现必须一起到位。
 *
 * 为什么在启动器修、而不是照Bob建议"让 batch 复用服务端那条路径"：
 * 服务端是**常驻 GUI 进程**，它的 cwd 是 GUI 启动时的目录，不是调用方的 ——
 * 相对路径会读错文件（这正是当初把展开放启动器的第一理由）。
 * 启动器与调用方同进程同 cwd，在这里展开语义才对。
 *
 * 实现已搬到 `./file-flags`（与单条路径同一份判定），这里只转发。
 */
function expandDescFileInBatch(argv: string[], stdin: string | undefined): string | undefined {
  return expandFileFlagsInBatch(argv, stdin)
}

/**
 * 展开后的参数。**在 main() 里赋值而不是模块顶层**（1.0.40 修）：
 * 顶层执行时抛错没人接得住，`main().catch` 只兜 main 内部的异常 ——
 * 那样上面的统一错误出口就形同虚设。
 */
let argv: string[] = []

/**
 * 调用方身份：优先用环境变量的显式声明，没有就从 ~/.deskpartner/credentials.json 取。
 *
 * 后者是关键（1.0.35）：凭据是 `agent credential` 时落盘的，之后**每次调用自动带上**，
 * agent 不用"记得"任何事 —— 靠记得声明守不住（实测 1147 条调用里 1142 条因此记成了 human）。
 *
 * 两条通道都要带上：管道请求放进报文（服务端进程的环境变量是 GUI 的，看不见调用方）；
 * 无头通道走 spawn 时显式注入的环境变量。
 */
/**
 * 从 argv 里读调用方自己声明的身份（`--created-by agent:x` / `--owner agent:x`）
 *
 * 为什么 argv 也算声明（1.0.37，Bob 32f0bf89）：
 * 它一直用 `--created-by agent:bob` 表明"这次是我在操作"，
 * 但启动器此前只看 DESKPARTNER_AGENT，看不到这个声明，于是把 default 凭据
 * （alice 的）给它带上 —— 声明被无视，身份被顶替。
 *
 * ⚠️ 这里**不把 --created-by 当成认证**：它只用来"挑该用哪份凭据"。
 * 声明了身份但本机没有该身份的凭据时，凭据留空 —— 门禁会以
 * credential_missing 拒绝并指路领凭据，而不是放行或借别人的。
 * 这样"归属标注"与"身份认证"的分界仍然守住（见 agent-guide 的 ownership.boundary）。
 */
function declaredActorFromArgv(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const cur = argv[i]
    for (const flag of ['--created-by', '--owner']) {
      const inline = `${flag}=`
      const value =
        cur === flag ? argv[i + 1]?.trim() : cur.startsWith(inline) ? cur.slice(inline.length).trim() : undefined
      if (value?.startsWith('agent:')) return value
    }
  }
  return undefined
}

/**
 * 调用身份：优先环境变量，其次 argv 里的显式声明，最后（仅当本机只有一份凭据）用它。
 */
const envActor = process.env.DESKPARTNER_AGENT?.trim() || undefined
const declaredActor = envActor || declaredActorFromArgv(argv)
const credential = pickCredential(declaredActor)
const callerActor = declaredActor || credential?.agentId
const callerCredential =
  credential && credential.agentId === callerActor ? credential.token : undefined
const callerSession = process.env.DESKPARTNER_SESSION?.trim() || undefined

/**
 * 调用方手上那份说明书的版本（G8 漂移提醒用，1.0.57）
 *
 * 必须由启动器读自己的环境再**带进管道请求**：服务端是常驻 GUI 进程，
 * 它的 `process.env` 是 GUI 的，读不到调用方 shell 里声明的值。
 * 这与 actor / credential / session 是同一类问题 ——
 * Bob实测（52b6b726）：GUI 开着时声明 1.0.50，回执 notice 为空；
 * 加 DESKPARTNER_NO_PIPE=1 走无头通道才有提醒（那时服务端就是它的子进程）。
 *
 * 无头通道也会带上这个字段，但服务端那边优先用请求体里的值、
 * 回退读 env —— 两条通道共用一份判据，不再各写一套。
 */
const callerSkillVersion = process.env.DESKPARTNER_SKILL_VERSION?.trim() || undefined

/**
 * 调用方走的哪张皮（1.0.63）：`cli`（人/脚本）或 `mcp`（MCP 工具进程）。
 *
 * MCP 进程 spawn 启动器时会在 env 里设 `DESKPARTNER_SURFACE=mcp`。
 * 同样属于"服务端看不到调用方环境"的一类，**必须由启动器带进管道请求**，
 * 否则 GUI 开着时 MCP 调用又被记成 cli（surface 在服务端硬编码）。
 * 默认 cli：人/脚本直接敲时没有任何声明，这也是绝大多数调用。
 */
const callerSurface = process.env.DESKPARTNER_SURFACE?.trim() || 'cli'

/**
 * 多份凭据 + 没声明身份 = 不猜（1.0.37）
 *
 * 此前会退回文件里的 default，于是后注册的 agent 的调用被带上先注册者的凭据：
 * 埋点 actor、授权申请、审计全都记到别人名下（Bob 32f0bf89 实测）。
 * 错记的身份**事后无法还原**，当时不猜就是数据不被污染的唯一机会。
 *
 * 只标"多份且没声明"：单人单 agent 完全不受影响，那是 1.0.35 的零摩擦路径。
 *
 * ⚠️ 这里只把情况**带下去**，不在这里拒绝：读命令不需要身份，
 * 在启动器一刀切会把 `todo list` 也堵死。该不该拦由门禁按命令的档位决定
 * （与"batch 自己不过门禁、子命令各自过"同一个原则：判据放在最懂业务的那一层）。
 */
const ambiguousIds =
  !tty && !declaredActor && !callerCredential && listCredentialIds().length > 1
    ? listCredentialIds()
    : undefined

/**
 * 读出调用方重定向进来的 stdin
 *
 * 关键在于"什么情况下该读"：若 stdin 是终端，说明没人重定向给它，
 * 去读就会挂在那里等输入；若 stdin 是管道（比如被别的程序 spawn），
 * 管道可能一直不关闭，同样会挂。
 *
 * 所以判据是**首字节**：短暂等不到任何数据就当作没有 stdin。
 */
function readPipedStdin(): Promise<string | undefined> {
  if (process.stdin.isTTY) return Promise.resolve(undefined)

  return new Promise((resolve) => {
    let data = ''
    let settled = false
    const done = () => {
      if (settled) return
      settled = true
      resolve(data || undefined)
    }

    // 首字节超时：重定向的场景数据会立刻到达，等不到就说明没有
    const firstByteTimer = setTimeout(done, 400)

    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk: string) => {
      clearTimeout(firstByteTimer)
      data += chunk
    })
    process.stdin.on('end', done)
    process.stdin.on('error', done)
  })
}

/** 尝试走通道 A
 *
 * 返回 null 表示"这条路走不通"，调用方应降级。
 * 注意两种 null 都不是错误：GUI 没启动是完全正常的情况。
 */
function tryPipe(stdin?: string): Promise<PipeResponse | null> {
  /**
   * 调试开关：强制跳过通道 A
   *
   * 排查"到底是管道那边的问题还是无头那边的问题"时必需 ——
   * 否则常驻实例会一直接管，无头路径根本没机会被执行到。
   * （同用户名只会有一个实例占住管道，先到的赢、后到的静默降级，
   * 所以开发时也常常连不上管道，这个开关同样有用。）
   */
  if (process.env.DESKPARTNER_NO_PIPE === '1') {
    return Promise.resolve(null)
  }

  return new Promise((resolve, reject) => {
    let settled = false
    let buf = ''
    let respTimer: ReturnType<typeof setTimeout> | undefined

    const socket = net.connect(pipeName())
    const finish = (v: PipeResponse | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(respTimer)
      socket.destroy()
      resolve(v)
    }

    // 连接超时设得很短：GUI 在跑时连接是毫秒级的，
    // 拖久了说明它不在，早点降级比让用户干等好
    const timer = setTimeout(() => finish(null), CONNECT_TIMEOUT_MS)

    socket.setEncoding('utf8')
    socket.on('connect', () => {
      /**
       * 连上之后改由**响应超时**接管（1.0.40 补上）。
       *
       * 这两行注释原来就在，但代码里只有 `clearTimeout(timer)` ——
       * 注释描述了意图、实现漏了。后果：服务端连上后卡住（死锁、被挂起、
       * 处理中途异常退出）时，客户端**永久挂起**，人只能 Ctrl+C。
       * `RESPONSE_TIMEOUT_MS` 一直在 pipe-protocol 里导出却从没人用，就是这个漏。
       *
       * ⚠️ 超时后**不降级重试**，而是明确报错。
       * 因为这时无法知道服务端执行到哪一步了 —— 降级会让同一条命令
       * 再跑一遍（batch 场景就是重复写入）。宁可让人确认后再决定，
       * 也不能用"自动重试"把错误放大成数据问题。
       */
      clearTimeout(timer)
      respTimer = setTimeout(() => {
        if (settled) return
        settled = true
        socket.destroy()
        /**
         * 提示必须说清"两条通道的差别"，否则调用方会误判：
         *
         * - 管道（通道 A）：服务端是常驻 GUI，它**不知道客户端已经走了**，
         *   会继续把命令执行完（服务端执行期超时比这里大，见 EXEC_TIMEOUT_MS）。
         *   所以"可能已执行"是**大概率**，重跑要格外谨慎。
         * - 无头（通道 B）：进程就是自己 spawn 的，destroy 之后它随之结束，
         *   但也可能刚好写完了才被杀 —— 所以同样不能假设没执行。
         *
         * 两种情况下都**不自动重试**：batch 场景重跑就是重复写入。
         */
        reject(
          new Error(
            `管道 ${Math.round(RESPONSE_TIMEOUT_MS / 1000)} 秒无响应。` +
              `这条命令**可能已经在执行**（管道通道下服务端会继续跑完），` +
              `请先用 \`todo list\` 之类的方式确认结果，再决定是否重试 —— 直接重跑可能重复写入。` +
              `若确认要重跑并强制绕开管道，可设 DESKPARTNER_NO_PIPE=1。`
          )
        )
      }, RESPONSE_TIMEOUT_MS)
      socket.write(
        encodeMessage({
          argv,
          tty,
          stdin,
          actor: callerActor,
          identityDeclared: Boolean(envActor || declaredActorFromArgv(argv)),
          credential: callerCredential,
          interactive: tty,
          session: callerSession,
          ...(ambiguousIds ? { ambiguousIds } : {}),
          ...(callerSkillVersion ? { skillVersion: callerSkillVersion } : {}),
          surface: callerSurface
        } as PipeRequest)
      )
    })
    socket.on('data', (chunk: string) => {
      buf += chunk
      const nl = buf.indexOf('\n')
      if (nl === -1) return
      try {
        finish(JSON.parse(buf.slice(0, nl)) as PipeResponse)
      } catch {
        finish(null)
      }
    })
    // 连不上、被拒绝、对端关闭 —— 一律当作"该降级"
    socket.on('error', () => finish(null))
    socket.on('close', () => finish(null))
  })
}

/** 定位程序本体（用于降级启动） */
function resolveMain(): { exe: string; prefix: string[] } | null {
  const root = path.resolve(__dirname, '../..')

  const candidates: Array<{ exe: string; prefix: string[] }> = []

  if (process.env.DESKPARTNER_MAIN) {
    candidates.push({ exe: process.env.DESKPARTNER_MAIN, prefix: [] })
  }

  // 开发态：直接用 electron 二进制，绕开 npm shim
  // （shim 自身约 900ms 开销，实测过）
  const devExe = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
  candidates.push({ exe: devExe, prefix: [root] })

  // 打包态：与本启动器同级的程序本体
  const packaged = path.join(root, 'DeskPartner.exe')
  candidates.push({ exe: packaged, prefix: [] })

  for (const c of candidates) {
    try {
      if (fs.existsSync(c.exe)) return c
    } catch {
      /* 继续试下一个 */
    }
  }
  return null
}

/**
 * 看起来像 URL scheme 的值
 *
 * Electron 启动时会把非开关参数当成"要打开的文件 / URL"来处理。
 * `agent:alice` 这种值会被识别成 scheme 为 `agent` 的 URL，
 * 而 Electron 处理不了这个 scheme —— 结果是**直接崩溃**：
 * 没有任何输出、退出码 0xFFFFFFFF。
 *
 * 更阴的是它有触发条件：**必须后面还跟着别的参数**才崩，
 * 放在末尾反而正常。所以 `--owner agent:x` 单独用没事、
 * 后面再加个 `--status done` 就挂，极难定位。
 *
 * （`2026-09-20T18:00:00` 虽然也含冒号却没事 —— 它不以字母开头，构不成 scheme。）
 */
const URL_LIKE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/

/**
 * 把「会被误认为 URL 的值」并进前一个开关里：`--owner agent:x` → `--owner=agent:x`
 *
 * 不做通用合并（那会把 `--yes <位置参数>` 之类也吃掉），
 * 只处理真正有问题的值。合并后该值不再作为独立 argv 元素出现，陷阱消失。
 */
function foldUrlLikeValues(argv: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const cur = argv[i]
    const next = argv[i + 1]
    if (cur.startsWith('--') && !cur.includes('=') && next && URL_LIKE.test(next)) {
      out.push(`${cur}=${next}`)
      i++
    } else {
      out.push(cur)
    }
  }
  return out
}

/**
 * 降级到通道 B 之前先自检（1.0.65，修 `cfbf8a7a`）
 *
 * ## 这条提单是Carol（agent:carol）09-30 报的
 *
 * Windows 应用日志近 30 天 **1229 次**同一签名（`ntdll.dll` / `c000000d`），
 * 伴随 stderr 的 `0xc0000142`（DLL 初始化失败）。
 *
 * **受害者不是别人，是我**：一个以 bypassPermissions 运行的自动化会话
 * 在按固定间隔轮询 CLI 读看板，每一轮都被这条回退分支带崩，
 * 对外表现为「自动化助手自己挂掉」。10-01 07:16 那个会话已被人工停止。
 *
 * ⚠️ 我先前把它读成"没人用的降级路径"（**错的**）——
 * 有受害者，而且受害者报的是一条**方案①**，不是我选的那条。
 *
 * ## 为什么静默降级本身是缺陷（不只是"会崩"）
 *
 * 这条分支存在的唯一前提是"程序本体能起来"——
 * `ELECTRON_RUN_AS_NODE` 被 delete 之后，**开发态的 electron.exe 会去开 GUI 窗口**，
 * 在无桌面/服务/SSH 会话下当场崩。而崩溃时调用方只看到"连不上看板"，
 * **"无头通道崩了"与"GUI 没启动"在它眼里完全一样**。
 *
 * 于是 1229 次崩溃没有一次落到人眼里 —— 一次失败静默了一千多次。
 * 判据：**沉默的失败态是最贵的失败态。**
 *
 * ## 自检判据：宁可不跑，不要崩着跑
 *
 * Carol建议①的原话是「自检不过就直接返回明确错误码，不再 spawn」，
 * 代价是「本来能跑的命令会从『能跑但崩』变成『直接报错』」。
 * **那正是我们要的** —— 报错有信息，崩溃没有。
 *
 * 查什么：程序本体存在（已在原逻辑里）+ **它是不是能被当 node 跑**。
 * 后者是关键 —— 开发态的 electron.exe 没有那个变量就会开 GUI。
 */
function preflightHeadless(main: { exe: string; prefix: string[] }): string | null {
  /** 返回错误文案；null = 可以降级 */
  if (!fs.existsSync(main.exe)) {
    return `程序本体不存在：${main.exe}`
  }
  /**
   * 开发态判定：候选是 electron.exe —— 那是 Electron 运行时，**不是程序本体**。
   * 它需要 ELECTRON_RUN_AS_NODE=1 才会当纯 node 跑，缺了就去开 GUI 窗口并崩。
   * 打包态的 DeskPartner.exe 不需要（它认 `--cli`，带上反而出错）。
   */
  const isElectronRuntime = /[\\/]electron\.exe$/i.test(main.exe)
  if (isElectronRuntime) {
    return (
      `开发态降级通道不可用：${main.exe} 是 Electron 运行时，` +
      `没有 ELECTRON_RUN_AS_NODE 时它会尝试开 GUI 窗口并崩溃` +
      `（实测 30 天 1229 次，事件签名 ntdll.dll / c000000d）。\n` +
      `  这是已知缺陷，不是你的用法有问题。绕法：\n` +
      `    1) 启动 DeskPartner 常驻实例，CLI 会走管道通道（最快）\n` +
      `    2) 设 DESKPARTNER_MAIN 指向打包版 DeskPartner.exe（已装的话）\n` +
      `    3) 装好依赖后 npm run build，再重试开发态降级`
    )
  }
  return null
}

/** 降级到通道 B：启动无头进程，并把它的 stdio 原样透传 */
function fallbackToHeadless(stdin?: string): Promise<never> {
  return new Promise((_resolve, reject) => {
    const main = resolveMain()
    if (!main) {
      reject(
        new Error(
          '未找到程序本体，无法降级执行。请确认 DeskPartner 已正确安装，或设置 DESKPARTNER_MAIN 指向可执行文件。'
        )
      )
      return
    }

    /**
     * 自检不过就**在这里结束**（1.0.65）
     *
     * 绝不 spawn —— 原来 spawn 完再崩，崩了只有退出码没有文字。
     * 现在拒绝发生在 spawn 之前，错误文案能完整送到调用方。
     */
    const preflightError = preflightHeadless(main)
    if (preflightError) {
      reject(new Error(preflightError))
      return
    }

    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    /**
     * 无头通道看不到调用方的环境变量之外的东西，身份与凭据要显式注入。
     * interactive 同样要传：子进程（Electron）的 stdout 是继承来的，
     * 它自己判 TTY 会跟调用方不一致。
     */
    if (callerActor) env.DESKPARTNER_AGENT = callerActor
    /**
     * 声明与推断必须分开传（1.0.46）。
     *
     * `callerActor` 有两种来源：调用方自己声明（export / --created-by），
     * 或本机只有一份凭据时被自动带上（1.0.35 的零摩擦）。后者不是任何人的自称，
     * 但 `DESKPARTNER_AGENT` 这个名字会让下游以为它是声明 ——
     * 于是 `ambiguous_identity` 那一关会误判（实测：调用方没声明过任何身份，
     * 却被报"你有两个身份我分不清"）。带上这个标记，下游才判得准。
     */
    if (envActor) env.DESKPARTNER_IDENTITY_DECLARED = '1'
    else delete env.DESKPARTNER_IDENTITY_DECLARED
    if (callerCredential) env.DESKPARTNER_CREDENTIAL = callerCredential
    env.DESKPARTNER_INTERACTIVE = tty ? '1' : '0'
    /**
     * 多份凭据未声明身份的情况也要带过去：无头进程能看到自己的 env，
     * 但这个判断是**启动器**做的（它才读过凭据文件），子进程重做一遍会重复且可能不一致。
     */
    if (ambiguousIds) env.DESKPARTNER_AMBIGUOUS_IDS = ambiguousIds.join(',')
    else delete env.DESKPARTNER_AMBIGUOUS_IDS
    /**
     * G8 漂移提醒用的说明书版本（1.0.57）：无头通道这里靠 `{...process.env}` 本就带得过去，
     * 但显式写出来是为了**防重构**——上面的 actor/credential 一旦被改成白名单式重建，
     * 没有对应行就会被静默丢掉，而这类"声明了却不生效"的故障最难查
     * （Bob 52b6b726 就是这么连错四轮的）。
     */
    if (callerSkillVersion) env.DESKPARTNER_SKILL_VERSION = callerSkillVersion
    else delete env.DESKPARTNER_SKILL_VERSION
    /**
     * 通道标识（1.0.63）：无头路径下 `{...process.env}` 本就带得过去，
     * 显式写出来与 skillVersion 同理 —— 防将来把 env 改成白名单重建时静默丢掉，
     * 让 MCP 调用又混回 cli 统计。
     */
    env.DESKPARTNER_SURFACE = callerSurface

    /**
     * stdin 必须用 pipe 再喂回去，**不能靠 inherit**：
     * 为了走管道（通道 A）我们已经把调用方的 stdin 读空了，
     * inherit 给子进程的是一个已到 EOF 的流 —— 子进程读到的永远是空。
     * （这就是"batch 走无头也报 stdin 为空"的原因。）
     */
    const child = spawn(main.exe, [...main.prefix, '--cli', ...foldUrlLikeValues(argv)], {
      env,
      stdio: ['pipe', 'inherit', 'inherit'],
      windowsHide: true
    })

    if (stdin !== undefined) {
      child.stdin.write(stdin)
    }
    // 无论有没有内容都要关闭，否则子进程会一直等 stdin
    child.stdin.end()

    /**
     * spawn 留痕（1.0.65，修 `cfbf8a7a` 的②：崩了也留痕）
     *
     * Carol建议②：spawn 时记 pid、参数、退出码。
     * 自检（①）掐断的是**已知**那条路，而这条路之外崩了仍要有证据 ——
     * 否则下次又是"1229 次没人知道为什么"。
     *
     * 为什么写 stderr 而不是文件：**不引入新的落盘物**。
     * CLI 的 stdout 契约是只出 JSON（见第 2 条不变量），
     * 而这里是在无 GUI 通道下 —— 写文件会撞上"程序本体是 electron.exe 时路径可能不可写"。
     * stderr 是当时唯一一定通到调用方的通道。
     */
    const trace = (msg: string): void => {
      process.stderr.write(`[deskpartner:降级] ${msg}\n`)
    }
    trace(
      `spawn pid=${child.pid ?? '?'} exe=${main.exe} args=${JSON.stringify(argv.slice(0, 6))}` +
        `${argv.length > 6 ? ' …' : ''}`
    )

    child.on('error', (err) => {
      trace(`spawn 失败：${err instanceof Error ? err.message : String(err)}`)
      reject(err)
    })
    child.on('close', (code, signal) => {
      // 退出码 0 是正常收口，不必留痕（否则每次成功调用都刷一行）
      if (code !== 0) {
        trace(
          `子进程异常结束 pid=${child.pid ?? '?'} 退出码=${code}` +
            `${signal ? ` 信号=${signal}` : ''} —— 命令可能未执行完，请确认结果`
        )
      }
      process.exit(code ?? 1)
    })
  })
}

async function main(): Promise<void> {
  // 参数展开放在这里，失败时能被下面的 catch 统一处理（见 expandDescFile 的说明）
  argv = expandDescFile(process.argv.slice(2))

  // 先读 stdin 再连管道：stdin 读的是调用方的流，与走哪条通道无关
  const rawStdin = await readPipedStdin()
  // batch 的每行参数由服务端展平，所以它的 --desc-file 得在这里补展开
  const stdin = expandDescFileInBatch(argv, rawStdin)

  /**
   * 有终端时**强制走无头通道**，不连管道（P0 修复）。
   *
   * 原因：管道那头是常驻的 GUI 进程，它看不见调用方的终端 ——
   * `interactive` 只能由调用方自报（见 cli-server.service.ts），
   * 于是任何连得上管道的进程发一个 `tty:true` 就能拿到"人在场"的全部权限。
   * 无头通道不一样：这个进程是被调用方直接 spawn 的，stdio 继承过来，
   * 服务端能自己看 `process.stdout` 判断调用方是不是终端。
   *
   * 一句话：**想被当作"人在场"，就得让服务端看得见你。**
   * 代价是每次敲命令要起一个 Electron（比管道慢），换来的是判据可验证。
   */
  const viaPipe = tty ? null : await tryPipe(stdin)
  if (viaPipe) {
    process.stdout.write(viaPipe.stdout)
    process.exit(viaPipe.exitCode)
  }
  await fallbackToHeadless(stdin)
}

main().catch((err: unknown) => {
  /**
   * 启动器自己的失败出口 —— 走到这里的错误**没经过 `executeOne`**
   * （`--desc-file` 读不到文件、`dp skill` 主题写错、无头通道起不来…），
   * 所以分类要在这里做（1.0.110，收 `7a6ac97e`）。
   *
   * 此前这里写死 `code: 'error'` + `exit 1`：调用方只知道"exit 1"，
   * 而"我参数写错了"（改命令就行）与"环境坏了"（看日志 / 换台机器）
   * 该做的事完全相反 —— 判据是**报错要能分流**，不是"报一个错就行"。
   *
   * 现在与 `executeOne` 那条出口共用 `classifyError`：用法错误 →
   * `usage_error` / exit 2，与无头通道、管道通道同一档位；
   * `error` / exit 1 从此只表示"真的预期外"。
   */
  const failure = formatUncaughtFailure(err, tty)
  if (failure.stderr) process.stderr.write(failure.stderr)
  if (failure.stdout) process.stdout.write(failure.stdout)
  process.exit(failure.exitCode)
})
