/**
 * 发版单入口：`npm run release`
 *
 * ── 它解决什么 ──
 *
 * 此前发版是**人肉串 8 条命令**，每条都带着一个已记录在案的坑：
 *
 *   1. `electron-vite build` 会清 `out/` → 曾靠手工 `mv out out.bak-<ts>` 兜底
 *   2. ABI：`npm test` 停在 Node ABI(127)，打包要 Electron ABI(130) → 靠人记得顺序
 *   3. 打包 + `latest.yml` 重算 → 每次手工重算 sha512/size（工具写错文件名，是长期坑）
 *   4. exe 版本元数据核验 → **不信退出码**（safe-delete 闸门会误报 rc=1）
 *   5. asar / MCP 静态核验
 *
 * 这个脚本按序做完，**每步失败即停、并打印下一步该干什么**。
 *
 * ── 🚨 1.0.63：第 1 步先查工作区是否干净 ──
 *
 * 动机是本机真实踩过的：1.0.63 打完包、写完文档，**18 个源文件的改动还在工作区**。
 * 后果不是"少一条 commit"，而是**已发出的版本指不回任何源码** —— 要回退时无路可退。
 * 现在工作区有未提交改动就直接中止，逼出回滚点；确实不需要时用 `--allow-dirty`
 * （该产物不算交付）。
 *
 * ── 🚨 1.0.62：整条流程**零删除** ──
 *
 * 原先第 2 步把整个 `out/` 改名成 `out.bak-<ts>`，第 8 步再删掉它。
 * 那是个几十万文件的目录 —— 删除量必然撞上沙箱的删除阈值，于是**每发一次版，
 * 人就被叫来签一次删除授权**（而授权本身要花她的时间）。这是纯自找的成本：
 *
 * - `out/` 是纯构建产物，源码一条 `electron-vite build` 就能整份重建，
 *   备份它换不来任何东西（真出问题该回到的是源码，不是上一次的产物）；
 * - 即使真要留档，正确做法也不是"改名 + 事后删"，而是**留档不动**。
 *
 * 所以现在**不改名、不备份、不删除**：让 `electron-vite build` 直接清空 `out/`
 * 并重新生成。少一步操作、少一次授权，失败时依照源码重建即可。
 *
 * ── 它**不**解决什么（先说清，免得期待错）──
 *
 * 它不减少发版的那 16 分钟。大头是 electron-builder（≥880s），那是硬成本。
 * 它减少的是"手跑 8 条命令、每条都可能踩坑"。
 *
 * 也**不建议**建云端 CI（GitHub Actions 等）：这是本机 GUI 应用，核心验证是
 * CDP 真实界面，云 runner 起不了桌面；而且只有她 + 一个 agent，CI 的多人协作收益不存在。
 *
 * ── 🚨 1.0.74：三步人工动作收进脚本（卡 f6c186b8 / ae9f5fdd 的驳回）──
 *
 * 此前发版脚本之外还有 3 步靠人：升 package.json version、release add 版本登记、
 * 决定跑不跑测试。后果已经真实发生过一次：**1.0.73 用 release 能力发的版，
 * 自己却没登记** —— `dp release list` 至今是空数组，登记动作压根没接进脚本，
 * 全靠人记得。与"通知说假话"同一族：能力在，闭环断在最后一公里。
 *
 * 现在四件都收进这条链（版本号联动是 1.0.107 后补的第四件，卡 5cc426b9）：
 *   - 升版本：脚本按补丁位 +1 写 package.json（`--to x.y.z` 显式指定），
 *     写后回读核对；
 *   - 版本号联动（卡 5cc426b9）：升号的**同一步**把 README / AGENTS 的当前态版本号
 *     改对并复核 —— 以前升完号文档就落后一版，而没有任何一步会因此变红；
 *   - 测试：**默认执行**（`--skip-tests` 显式跳过，跳过要自报"没过测试闸门"）；
 *   - 登记：发版**最后一步强制**执行 `release add`（缺摘要在前置就报错中止），
 *     登记失败 = 发版失败，登完 `release show` 回读核对。
 *
 * ── 用法 ──
 *
 *   node scripts/release.mjs --project "DeskPartner" --summary "这版做了什么"    # 默认跑测试，收尾强制登记
 *   node scripts/release.mjs --summary "…" --skip-tests  # 显式跳过测试（产物没过测试闸门）
 *   node scripts/release.mjs --summary "…" --skip-backup-drill  # 显式跳过真库往返验收（产物同样不算过闸门）
 *   node scripts/release.mjs --summary "…" --overwrite # dist/ 里已有该号的包时也照打（会覆盖已发出去的包）
 *   node scripts/release.mjs --summary "…" --to 1.0.80   # 显式指定版本号（默认补丁位 +1）
 *   node scripts/release.mjs --summary "…" --highlight "要点"  # 可重复传，进登记的要点
 *   node scripts/release.mjs --summary "…" --allow-dirty # 工作区脏也照打（该产物不算交付）
 *   node scripts/release.mjs --summary "…" --dry-run     # 只打印将要执行什么（不写库、不登记）
 *
 * ⚠️ `--summary` 必填：它就是收尾 `release add` 的登记摘要，缺了在前置检查就中止 ——
 * 不是打完 16 分钟的包之后才告诉你"没登记成"。
 *
 * ⚠️ `--project` 同理必填（卡 36f3eaa4，1.0.115）：版本挂在项目下，缺了**在前置检查就中止**。
 * 1.0.114 实测过另一条路有多贵 —— 前 12 步全过，到第 13 步才发现没给项目名，
 * package.json 已升号、dist/ 里已有一个包，登记却没落。
 */
import { spawnSync } from 'node:child_process'
// existsSync 查产物在不在；read/writeFileSync 是 1.0.74 升版本（写 package.json）用的
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, currentAbi } from './lib/prebuild-abi.mjs'
import { packageVersion, artifactPaths } from './lib/exe-version.mjs'
import { installerName } from './lib/latest-yml.mjs'
import {
  parseReleaseArgs,
  requireSummary,
  requireProject,
  requireAgentIdentity,
  resolveReleaseVersion,
  applyVersionToJson,
  buildReleaseAddArgs,
  buildRegisterEnv,
  assertRegistrationInstance
} from './lib/release-register.mjs'

const argv = process.argv.slice(2)
const DRY = argv.includes('--dry-run')
const SKIP_TESTS = argv.includes('--skip-tests')
// 备份往返验收的显式跳过（2026-10-21 卡 d562f985 的驳回要求②：这条闸门必须进必跑链）
const SKIP_DRILL = argv.includes('--skip-backup-drill')
// 该号在 dist/ 里已存在时照样打包（会覆盖已发出去的包）—— 卡 2cf2ecbd：默认必须阻断
const OVERWRITE = argv.includes('--overwrite')
const ALLOW_DIRTY = argv.includes('--allow-dirty')
// 带值 flag（--project/--summary/--to/--highlight）摘干净，剩下的位置参数才给 verify-package 当 key
const {
  project: PROJECT,
  summary: SUMMARY,
  to: VERSION_OVERRIDE,
  highlights: HIGHLIGHTS,
  keys: VERIFY_KEYS
} = parseReleaseArgs(argv)

/**
 * 找一个**能直接 spawn 的** git（绝对路径）。
 *
 * 为什么不直接 `spawnSync('git', ...)`：本机 PATH 里的 `git` 来自 Git Bash，
 * 是 `/mingw64/bin/git` 这样的 POSIX 路径 —— Windows 上的 node 解析不到，
 * spawn 会回 `EBUSY`。实测踩过：闸门因此"取不到状态"、静默放行整个发版。
 *
 * 所以按"绝对路径候选 → 退化到裸名"的顺序探，取第一个能跑通的。
 *
 * ⚠️ stdio 必须**显式**声明（下面用 pipe）。默认 stdio 在受限环境（沙箱 / CI）
 * 下 spawn 会 EBUSY —— 实测踩过，表现和"命令不存在"一模一样，很能骗人。
 */
function resolveGit() {
  const candidates = [
    'C:/Program Files/Git/cmd/git.exe',
    'C:/Program Files (x86)/Git/cmd/git.exe',
    join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'cmd', 'git.exe'),
    'git'
  ]
  for (const c of candidates) {
    if (!c) continue
    const r = spawnSync(c, ['--version'], GIT_OPTS)
    if (!r.error && r.status === 0) return c
  }
  return null
}
/**
 * 每条 spawn 的上界（卡 3766c307）
 *
 * 此前发版链的 spawnSync **全部没有 timeout**：任何一步的子进程卡住
 * （git 等在锁上、doctor 连不上实例、packager 死锁），整条链就**无限等**下去，
 * 而且没有任何一行输出说它在等什么。与"静默"同族 —— 不是失败，是永远不结束。
 *
 * 默认 30 分钟：electron-builder 那步本机实测 ≥880s，留足余量；
 * git 那几个探针另给 60s（它们本该在毫秒级回来，卡住就是卡住了）。
 *
 * ⚠️ `DESKPARTNER_SPAWN_TIMEOUT_MS` 可整体覆盖 —— 它存在的理由就是让
 * "挂住必须终止"这件事**能被反向验证**（设成 1ms，链路必须在第一步就带着
 * 可读报错终止，而不是继续往下跑）。
 */
const SPAWN_TIMEOUT_MS = Number(process.env.DESKPARTNER_SPAWN_TIMEOUT_MS || 30 * 60_000)
const GIT_TIMEOUT_MS = Number(process.env.DESKPARTNER_SPAWN_TIMEOUT_MS || 60_000)

/**
 * 超时判据：spawnSync 超时后 `status` 是 **null**、`error.code` 是 `ETIMEDOUT`。
 * 只认 `error.code`：Windows 上进程是被内核终止的，`signal` 不一定是 SIGTERM，
 * 按 signal 判会在某些路径上滑过去（那又变成"没拿到输出却当成功"）。
 */
const timedOut = (r) => r?.error?.code === 'ETIMEDOUT'

/**
 * 超时后 **必须由链条自己报错停下**，不能把 status=null 当普通非零退出码
 * （那样报出来的话是"退出码 1"，指向完全错误的方向 —— 真实原因是"它没回来"）。
 */
const fmtMs = (ms) => (ms >= 1000 ? `${Math.round(ms / 1000)}s` : `${ms}ms`)
const timeoutReason = (what, ms) =>
  `${what} 超过 ${fmtMs(ms)} 没有结束 —— 已按上界掐断` +
  `（不是它报了错，是它没回来）`

const GIT_OPTS = {
  encoding: 'utf8',
  shell: false,
  stdio: ['ignore', 'pipe', 'pipe'],
  timeout: GIT_TIMEOUT_MS
}
const GIT = resolveGit()

const DIST = join(ROOT, 'dist')

// 要发的号：--to 显式指定，否则补丁位 +1 —— 升版本是脚本的事，不再靠人记得改 package.json
const currentVersion = packageVersion()
let version
try {
  version = resolveReleaseVersion(currentVersion, VERSION_OVERRIDE)
} catch (e) {
  die(e.message, '版本号必须是 x.y.z；用 --to 显式指定要发的号')
}

let step = 0
const costs = []
const t0 = Date.now()

function head(title) {
  step++
  console.log(`\n${'═'.repeat(62)}`)
  console.log(`【${step}】${title}`)
  console.log('═'.repeat(62))
}

function run(cmd, args, label, spawnOpts = {}) {
  console.log(`\n> ${label || `${cmd} ${args.join(' ')}`}\n`)
  if (DRY) {
    console.log('  （--dry-run，未执行）')
    return 0
  }
  const started = Date.now()
  // shell: true 是历史行为；参数里带用户文本（摘要）的调用方传 { shell: false } 原样送达
  const r = spawnSync(cmd, args, {
    stdio: 'inherit',
    cwd: ROOT,
    shell: true,
    timeout: SPAWN_TIMEOUT_MS,
    ...spawnOpts
  })
  costs.push([label || `${cmd} ${args[0]}`, Date.now() - started])
  if (timedOut(r)) {
    die(
      timeoutReason(label || `${cmd} ${args[0]}`, SPAWN_TIMEOUT_MS),
      `看那条命令卡在哪儿（它自己的输出就在上面）；确实需要更久就设 ` +
        `DESKPARTNER_SPAWN_TIMEOUT_MS=<毫秒> 再跑`
    )
  }
  return r.status ?? 1
}

/**
 * run() 的孪生：**捕获 stdout**（登记实例自证要读 doctor 的 JSON）。
 *
 * stdio 必须显式声明（spawn-stdio-guard 闸门）：受限环境下不声明会 EBUSY，
 * stdout 变 undefined 而失败态指向完全错误的方向（同一坑已复现多次）。
 * spawn 没起来（ENOENT 等）不许静默返回 1 —— 上抛，让调用方 die。
 */
function runCapture(cmd, args, label, spawnOpts = {}) {
  console.log(`\n> ${label || `${cmd} ${args.join(' ')}`}\n`)
  if (DRY) {
    console.log('  （--dry-run，未执行）')
    return { status: 0, stdout: '', stderr: '' }
  }
  const started = Date.now()
  const r = spawnSync(cmd, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: ROOT,
    shell: true,
    encoding: 'utf8',
    ...spawnOpts
  })
  costs.push([label || `${cmd} ${args[0]}`, Date.now() - started])
  if (r.error) {
    // 超时也走这里：status 是 null，调用方绝不能把"没跑完"当成"跑通了"
    if (timedOut(r)) throw new Error(timeoutReason(label || `${cmd} ${args[0]}`, SPAWN_TIMEOUT_MS))
    throw r.error
  }
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

/** 失败即停，并把"下一步干什么"写清楚 */
function die(reason, next) {
  console.error(`\n${'─'.repeat(62)}`)
  console.error(`✗ 发版中止：${reason}`)
  if (next) console.error(`  下一步：${next}`)
  console.error('─'.repeat(62))
  process.exit(1)
}

// ── 0. 前置：工作区干净（否则这个包没有回滚点）──
/**
 * 为什么把这条放在发版脚本里，而不是靠"我记得先 commit"：
 *
 * 2026-09-30 就是这么栽的 —— 1.0.63 打完了包、写完了文档，
 * 18 个源文件 / +2477 行的改动**还躺在工作区没提交**。
 * 后果不是"少一条 commit 记录"，而是：**已经发出去的版本，指不回任何一份源码**。
 * 出错要回退时，无路可退。
 *
 * 判据必须是实测（`git status --porcelain`），不是"我记得我提交过"。
 * 只拦"有未提交改动"，不拦"本地比远端多几个 commit" —— 后者是推送节奏，
 * 与"这个包的源码存不存在"无关，硬拦只会逼人加参数绕过。
 *
 * 确实要在脏工作区打包（例如只为复现某个构建问题、不打算交付）时用 `--allow-dirty`，
 * 但那样打出的包**不算交付产物**。
 */
head('前置检查 · 工作区是否干净')
{
  // 这是只读检查，--dry-run 也照跑 —— dry-run 的价值之一就是先看"会不会被这条拦下"。
  if (!GIT) {
    console.log('  [!] 找不到可用的 git，本条跳过（**没能确认**工作区是否干净）')
  } else {
    const st = spawnSync(GIT, ['status', '--porcelain'], Object.assign({ cwd: ROOT }, GIT_OPTS))
    if (st.error || st.status !== 0) {
      // 查不出来**不是"干净"**：与"取不到状态就放行"相比，宁可停下问一句。
      die(
        `git 在 ${GIT}，但取工作区状态失败（${st.error ? st.error.code : 'exit ' + st.status}）`,
        '手动跑一次 `git status --porcelain` 看是什么问题；\n' +
          '        确认干净且不想被拦，加 --allow-dirty。'
      )
    } else {
      const dirty = st.stdout.split('\n').filter((l) => l.trim())
      if (dirty.length === 0) {
        console.log('  ok  工作区干净，这个包有回滚点')
      } else if (ALLOW_DIRTY) {
        console.log(
          `  [!] 工作区有 ${dirty.length} 处未提交改动，但传了 --allow-dirty：\n` +
            `      这样打出的包**没有对应的源码提交**，不算可交付产物。`
        )
      } else {
        console.error(`  [!] 未提交改动 ${dirty.length} 处：`)
        for (const l of dirty.slice(0, 10)) console.error(`      ${l}`)
        if (dirty.length > 10) console.error(`      …另有 ${dirty.length - 10} 处`)
        die(
          `工作区有 ${dirty.length} 处未提交改动 —— 现在打的包没有回滚点`,
          '先 `git add -A && git commit`，再重跑 `npm run release`；\n' +
            '        确实不需要回滚点时加 --allow-dirty（该产物不算交付）。'
        )
      }
    }
  }
}

console.log(
  `DeskPartner 发版  版本 ${version}${version !== currentVersion ? `（自 ${currentVersion} 自动升）` : ''}${DRY ? '  [dry-run]' : ''}`
)
console.log(`目标产物: dist/${installerName(version)}`)

// ── 0. 前置：版本号是否已被占用（防"发了个跟上次同名的包"）──
head('前置检查')
{
  // 只读校验，--dry-run 也照跑 —— dry-run 的价值之一就是先看"会不会被这步拦下"。
  // 摘要是收尾 release add 的登记内容，缺了要在**发版前**报错，不是打完包才说没登记成。
  try {
    requireSummary(SUMMARY)
  } catch (e) {
    die(e.message, '补 --summary "这版做了什么" 再发；--dry-run 也要求有摘要，登记不能为空')
  }

  // 身份同理：登记是写命令，缺身份会在最后一步 ambiguous_identity 炸（1.0.74 实测踩过，
  // 构建打包全白跑）。与 requireSummary 同构：--dry-run 也要求，演练就演练全套前置。
  try {
    const actor = requireAgentIdentity(process.env)
    console.log(`  ok  登记身份: ${actor}`)
  } catch (e) {
    die(e.message, 'export DESKPARTNER_AGENT=agent:<你> 再发；--dry-run 也要求有身份')
  }

  /**
   * 登记项目名（卡 36f3eaa4，1.0.115）：与摘要 / 身份同构，前置就校验。
   *
   * 这条判据原先**只写在拼 `release add` 的 argv 那一步**（第 13 步）——
   * 1.0.114 实测：前 12 步（测试 + 打包 + 产物验收，约 16 分钟）全过，
   * 到登记才发现没给 `--project`，此时 `package.json` 已升号、`dist/` 里已躺着一个包，
   * 登记没落 —— 版本"发出去了但查不到"，只能手写脚本补登。
   *
   * 校验点离使用点最近这个直觉在这条链上是错的：**每一步都很贵**，
   * 越晚校验，白跑的越多。所以 `requireProject` 与拼 argv 共用同一处判据
   * （scripts/lib/release-register.mjs），前置检查先跑一遍。
   */
  try {
    const project = requireProject(PROJECT)
    console.log(`  ok  登记项目: ${project}`)
  } catch (e) {
    die(
      e.message,
      '补 --project "项目名" 再发（`release add` 用它挂归属）；--dry-run 也要求，演练就演练全套前置'
    )
  }

  /**
   * 卡 2cf2ecbd：这里原本**只说不断** —— 文案写着"确认要覆盖才继续"，
   * 代码却没有任何等待/阻断，于是继续跑就覆盖旧包、重算 latest.yml，
   * 已发出去的版本被悄悄换掉（发布事实被篡改，事后无从察觉）。
   *
   * 现在按发版链一贯的"每步失败即停"：占用即中止，要覆盖得显式说 `--overwrite`。
   * 代价只是重发同一个号时多敲一个参数 —— 换来的是"发布过的产物不会被一次手滑替换"。
   */
  const existing = artifactPaths(version).installer
  if (existsSync(existing) && !OVERWRITE) {
    die(
      `dist/ 里已存在 ${installerName(version)} —— 这个号已被占用（--to 指回了旧号，或上次尝试留下的包）`,
      '换成新号发：去掉 --to（默认补丁位 +1）；或确实要覆盖已发出去的包，加 --overwrite。\n' +
        '        继续跑会覆盖旧包并把 latest.yml 重算成新包的哈希 —— 已发布的版本就被悄悄换掉了。'
    )
  }
  if (existsSync(existing)) {
    console.log(
      `  [!] dist/ 里已存在 ${installerName(version)}，但传了 --overwrite：\n` +
        `      新包会**覆盖**旧包，latest.yml 会被重算成新包的哈希 ——\n` +
        `      若这个号已经发出去过，那一刻起"发布事实"就换成了这份新包。`
    )
  } else {
    console.log(`  ok  dist/ 里还没有 ${installerName(version)}，本次是新产物`)
  }

  const abi = currentAbi()
  console.log(`  当前 node_modules ABI: ${abi.abi ?? `未知(${abi.reason})`}`)
  if (SKIP_TESTS) {
    console.log('  已选 --skip-tests：跳过测试 —— 这个产物**没过测试闸门**')
    if (abi.abi !== 'electron') {
      die(
        `打包要求 node_modules 是 Electron ABI(130)，当前是 ${abi.abi ?? '未知'}`,
        'node scripts/swap-abi.mjs electron'
      )
    }
  } else {
    console.log('  测试默认执行：它会把 ABI 切到 node，「对齐 ABI」那步切回 electron')
  }
}

// ── 1. 测试（默认执行；--skip-tests 显式跳过）──
if (!SKIP_TESTS) {
  head('跑测试（它会把 ABI 切到 node 再切回来）')
  const code = run(process.execPath, [join(ROOT, 'scripts', 'run-tests.mjs')], 'npm test 等价')
  if (code !== 0) die('测试未通过', '先修测试，测试没过不该发版')
  const abi = currentAbi()
  if (abi.abi !== 'electron') {
    console.log(`\n  [!] 测试后 ABI 停在 ${abi.abi ?? abi.reason}，「对齐 ABI」那步会切回 electron`)
  }
}

// ── 1.5. 备份往返验收（真库只读副本；因此不在 npm test 里）──
/**
 * 为什么要挂在发版链上（待验收卡 `d562f985` 的驳回，2026-10-21 主用户验收）
 *
 * 驳回原文：`npm run verify:backup` rc=1，**而这条闸门不在 npm test / 发版链里，
 * 红着没人看** —— 从 1.0.105 起红了两周，直到这次大验收才被翻出来。
 * 与 5cc4669 / 5cc426b9 同族：能力在、闸门也在，只是没有哪个步骤会因此变红。
 *
 * 它为什么**不能**进 `npm test`：它要读**本机真库**（`DESKPARTNER_DRILL_DB`
 * 指向一份用 sqlite backup API 取的一致性副本），换台机器就没有 ——
 * 而 `npm test` 必须到哪都能跑。但"不能进 npm test"不等于"可以被静默跳过"：
 * 发版链是它的唯一必跑位置，跳过要显式说（`--skip-backup-drill`），
 * 且跳过了这个产物就**不能自称过了测试闸门**（见下面 --tested 的判据）。
 *
 * ⚠️ 放在这一步而不是打包之后：它是唯一真读**真库**的闸门，
 * 一旦红，当场停等于省掉后面 16 分钟的构建与打包。
 * ⚠️ 它会先把原生模块切到 Node ABI，跑完自己切回 electron（脚本内负责，
 * 不还原会以 rc≠0 收场）——「对齐 ABI」那步仍会复核一次。
 */
head('备份往返验收（真库只读副本；不在 npm test 里，所以挂在这里）')
if (SKIP_DRILL) {
  console.log(
    '  已选 --skip-backup-drill：**这次没有验收真库往返** ——\n' +
      '      没有这一步，就没有任何东西能证明"这份备份导回去还一样"。'
  )
} else if (DRY) {
  console.log('  （--dry-run）将跑 node scripts/verify-backup-roundtrip.mjs')
} else {
  const code = run(
    process.execPath,
    [join(ROOT, 'scripts', 'verify-backup-roundtrip.mjs')],
    'verify:backup（真库副本导出→清空→导入→逐字段比对）'
  )
  if (code !== 0) {
    die(
      '备份往返验收未通过（真库导出的 JSON 导回去对不上，或闸门自身失效）',
      '看上面的差异报告与用例名；先修到 `node scripts/verify-backup-roundtrip.mjs` rc=0；\n' +
        '        真库不在本机、或确实要先发版，用 --skip-backup-drill（该产物不算过备份闸门）。'
    )
  }
}

// ── 2. 升版本（写 package.json，写后回读核对）──
head(
  version !== currentVersion
    ? `升版本 ${currentVersion} → ${version}（写 package.json）`
    : `版本号保持 ${version}（--to 指回当前号，不升）`
)
{
  if (version === currentVersion) {
    console.log('  不写 package.json，按原号重打')
  } else if (DRY) {
    console.log(`  （--dry-run）将把 package.json 的 version 写成 ${version}（当前 ${currentVersion}）`)
  } else {
    const pkgPath = join(ROOT, 'package.json')
    const raw = readFileSync(pkgPath, 'utf8')
    // 只改 version 一个字段（JSON.parse 回写会把无关行也重排进 diff）
    writeFileSync(pkgPath, applyVersionToJson(raw, version))
    const back = packageVersion()
    if (back !== version) {
      die(
        `写后回读不一致：package.json 读回 ${back}，期望 ${version}`,
        'package.json 可能被别的进程同时改动；核对后重跑'
      )
    }
    console.log(`  ok  package.json version = ${back}（已回读核对）`)
  }
}

// ── 2.5. 入口文档的版本号跟着改（同一步，卡 5cc426b9）──
/**
 * 为什么"升号"这一跳必须同时负责改文档：
 *
 * 升完版本号那一刻，README / AGENTS 里的当前态**确实**落后一版。补一道只核不改的闸门，
 * 每次发版都会被它真红一次 —— 于是要么每次要人先手改两行（等于没治），要么人学会绕过它。
 * 所以这一跳既改写、又复核：`--fix-source` 只动**源码文本就能定**的版本类字段
 * （`package.json` 的版本、`DB_VERSION`），不碰命令数 —— 那一刻跑着的应用必然还是上一版，
 * 拿它改写会把文档改坏。
 *
 * 命令数那边的漂移由 `npm test` 里的**源码侧**用例拦（本脚本第 1 步就跑 `npm test`），
 * 也就是说：入口文档跟事实不同源，这个包发不出来。
 */
head('入口文档当前态（README / AGENTS 的版本号与 schema）同步')
{
  if (DRY) {
    console.log('  （--dry-run）跳过：不改入口文档')
  } else {
    const code = run(
      process.execPath,
      [join(ROOT, 'scripts', 'verify-current-facts.mjs'), '--fix-source'],
      'verify:facts --fix-source'
    )
    if (code !== 0) {
      die(
        '入口文档的版本号没有同步成当前源码事实',
        '升号这一跳负责把 README / AGENTS 的当前态改对；它失败了先修，别往下走'
      )
    }
  }
}

// ── 3. 让构建自己清空 out/（不备份、不改名）──
head('准备构建（out/ 由构建自己清空，不备份）')
console.log('  out/ 是纯构建产物：electron-vite build 会整份重建，无需备份')

// ── 4. ABI 对齐到 electron（打包照抄 node_modules 现状）──
head('对齐原生模块 ABI → electron (v130)')
{
  const abi = currentAbi()
  if (abi.abi === 'electron') {
    console.log('  已经是 Electron ABI，无需切换')
  } else {
    const code = run(
      process.execPath,
      [join(ROOT, 'scripts', 'swap-abi.mjs'), 'electron'],
      'swap-abi electron'
    )
    if (code !== 0) die('切换 Electron ABI 失败', '确认 npm 缓存里有 electron-v130 的预编译产物')
  }
}

// ── 5. 构建（node 直调，绕开 npm script 的 wsl 黑名单）──
head('构建（electron-vite build + CLI）')
{
  const a = run(
    process.execPath,
    [join(ROOT, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js'), 'build'],
    'electron-vite build'
  )
  if (a !== 0) die('构建失败', '看上面的报错；out/ 会在下次构建时整份重建')
  const b = run(
    process.execPath,
    [join(ROOT, 'scripts', 'build-cli.mjs')],
    'build-cli'
  )
  if (b !== 0) die('CLI 构建失败', '看上面的报错')
}

// ── 6. 打包 ──
head('打包（electron-builder；⚠️ 退出码可能因 safe-delete 闸门误报 1）')
{
  console.log('  提示：内容校验在「发版验收」那步做，这里**不以退出码为准**')
  const code = run(
    process.execPath,
    [
      join(ROOT, 'node_modules', 'electron-builder', 'cli.js'),
      '-c.npmRebuild=false'
    ],
    'electron-builder'
  )
  if (code !== 0) {
    console.log(
      `\n  [!] electron-builder 退出码 ${code}。\n` +
        `      这**不一定是失败** —— safe-delete 闸门拦下删除中间产物时也会报 1，\n` +
        `      而安装包其实已经完整生成。继续走内容校验来判断。`
    )
  }
}

// ── 7. latest.yml 重算 ──
head('重算 latest.yml（工具写的文件名历来是错的）')
if (DRY) {
  console.log('  （--dry-run，未重算）')
} else {
  try {
    const { rewriteLatestYml } = await import('./lib/latest-yml.mjs')
    rewriteLatestYml(version)
  } catch (e) {
    die(`重算 latest.yml 失败：${e.message}`, `确认 dist/${installerName(version)} 真的生成了`)
  }
}

// ── 8. 内容验收：产物版本 + ABI + latest.yml + 关键字符串 ──
head('发版验收（判据是产物本身，不是退出码）')
{
  // 位置参数当"关键字符串"。摘要/要点的值已在 parseReleaseArgs 摘走，
  // 不会混进来变成永远查不到的检索串
  const keys = VERIFY_KEYS
  const code = run(
    process.execPath,
    [join(ROOT, 'scripts', 'verify-package.mjs'), ...keys],
    'verify-package'
  )
  if (code !== 0) {
    die(
      '发版验收未通过',
      '上面每条 FAIL 都有对应判据；修完重跑本条，不必重新打包（除非是 ABI 或构建问题）'
    )
  }
}

// ── 9. 版本登记（强制：登记失败 = 发版失败）──
/**
 * 登记与对账**共用**同一个 CLI 路径与同一组注入环境（1.0.116 发版实测）。
 *
 * 两者必须同通道：对账核的就是"这一版登记了什么、关联了哪些卡"，
 * 换个实例去查，等于拿旧命令表核新产物。
 *
 * ⚠️ 这两个值原先声明在第 9 步的**块级作用域**里，第 14 步的 `release audit` 读不到 ——
 * 1.0.116 实测：包打好了、版本登记也成了（linkedTodos 6），收尾对账却
 * `ReferenceError: cli is not defined` 崩掉。作用域上的小疏漏，代价是"发到一半的版本"。
 */
const cli = join(ROOT, 'out', 'cli', 'deskpartner.cjs')
const mainPath = artifactPaths(version).unpackedExe
const regEnv = buildRegisterEnv(process.env, { mainPath, mainExists: existsSync(mainPath) })

head(`版本登记（release add ${version}）`)
{
  console.log(`  摘要: ${SUMMARY}`)
  if (HIGHLIGHTS.length) console.log(`  要点: ${HIGHLIGHTS.join(' / ')}`)
  /**
   * ⚠️ 这两步 spawn 必须 `shell: false`：摘要里有空格与中文标点，
   * Windows 下 `spawnSync` + `shell: true` 拼命令行**不给参数加引号**，
   * "这版做了什么"会被拆成五个 argv —— 登记进去的摘要只剩第一个词。
   * run() 默认 shell: true 是历史行为，这里显式关掉。
   */
  if (!existsSync(cli)) {
    if (DRY) {
      console.log(`  （--dry-run）注意：${cli} 还不存在，真发版时构建那步会产出它`)
    } else {
      die(`找不到 ${cli}`, 'CLI 没构建出来；重跑发版（构建那步会 build-cli）')
    }
  }
  /**
   * 登记前置自证（8b9abe42）：登记必须由**本版产物**执行。
   *
   * 病根：CLI 启动器优先走命名管道，管道那头是**正在跑的实例** —— CLI 的行为版本
   * = 实例版本，不是磁盘产物的版本。机器上跑着旧 GUI 时，发版链每一步"用新参数
   * 调 CLI"都会被旧命令表拒收（1.0.75 实测：`release add 不接受 --tested` 发版中止）。
   *
   * 修法：登记显式走**新产物通道** ——
   * buildRegisterEnv 注入 DESKPARTNER_NO_PIPE=1（绕开管道）+ DESKPARTNER_MAIN
   * 指向刚构建的 win-unpacked 产物（无头降级才执行磁盘上那份代码；产物不在就只关
   * 管道，由下面的自证兜住 —— 宁可前置报错，也不把"碰巧跑通"当"用对了代码"）。
   * 然后 doctor 自报"登记由哪个实例执行、其版本是否 = 本版"，对不上就地停。
   */
  console.log(
    `  登记通道: ${regEnv.via}${regEnv.mainPath ? `（${regEnv.mainPath}）` : '（产物不在，仅关管道）'}`
  )
  if (DRY) {
    console.log('  （--dry-run）跳过登记实例自证')
  } else {
    let doc
    try {
      doc = runCapture(process.execPath, [cli, 'doctor'], 'doctor 自证（登记由哪个实例执行）', {
        shell: false,
        env: regEnv.env
      })
    } catch (e) {
      die(`登记前置自证跑不起来：${e.message}`, `当前登记通道 ${regEnv.via}；查上面的报错`)
    }
    if (doc.status !== 0) {
      die(
        `登记前置自证跑不起来：doctor 退出码 ${doc.status}\n` +
          `      ${(doc.stdout || doc.stderr || '').trim().slice(0, 400)}`,
        `确认 dist/win-unpacked/DeskPartner.exe 是刚构建出来的产物（当前通道 ${regEnv.via}）`
      )
    }
    let doctor
    try {
      const parsed = JSON.parse(doc.stdout)
      if (parsed && parsed.ok === false) {
        die(`登记前置自证失败：doctor 报错：${parsed.message ?? '(无正文)'}`, '查上面的输出')
      }
      doctor = parsed && typeof parsed === 'object' && 'data' in parsed ? parsed.data : parsed
    } catch (e) {
      die(
        `登记前置自证失败：doctor 输出不是 JSON（${e.message}）`,
        '说不清登记由哪份代码执行，不敢登记'
      )
    }
    try {
      const inst = assertRegistrationInstance({ expectedVersion: version, doctor, via: regEnv.via })
      console.log(
        `  ok  登记将由 ${inst.version} 版实例执行（via ${doctor?.via ?? inst.via}）—— 与本版一致`
      )
    } catch (e) {
      die(
        e.message,
        '关掉正在运行的旧界面再发；或确认 dist/win-unpacked/DeskPartner.exe 是刚构建出来的产物'
      )
    }
  }
  let addArgs
  try {
    // --shipped-at 传"此刻"：登记发生在发版收尾，这就是发布事实（不是计划时间）
    // tested 传真实值（065dcde4）：--skip-tests = skipped（没过测试闸门），
    // 否则测试那步已跑通 = yes。事后 `dp release show` 可核对，不靠终端历史
    addArgs = buildReleaseAddArgs({
      project: PROJECT,
      version,
      summary: SUMMARY,
      highlights: HIGHLIGHTS,
      shippedAt: new Date().toISOString(),
      // 备份往返也是闸门的一部分：跳过了它，这个产物同样不能自称"过了测试"
      tested: SKIP_TESTS || SKIP_DRILL ? 'skipped' : 'yes'
    })
  } catch (e) {
    die(e.message, '补 --project "项目名" --summary "这版做了什么" 后重跑')
  }
  // add 与 show 都走注入 env（8b9abe42）：自证了"登记由谁执行"，登记本身就得
  // 真的由它执行 —— 只自证不换通道，等于自证完又把命令发给了旧实例。
  const code = run(process.execPath, [cli, ...addArgs], `release add ${version}`, {
    shell: false,
    env: regEnv.env
  })
  if (code !== 0) {
    die(
      `版本登记失败（release add 退出码 ${code}）—— 不登记不算发完`,
      `查上面的报错；修完手动补登：\n` +
        `        node out/cli/deskpartner.cjs release add --project "项目名" --version ${version} --summary "这版做了什么"`
    )
  }
  // 写后回读核对：登记与读取同源 —— add 说成功但 show 查不到，就当没登记
  // show 按 (项目, 版本号) 定位（a2ea95f8）：--project 必须一并带上
  const back = run(
    process.execPath,
    [cli, 'release', 'show', version, '--project', PROJECT],
    `release show ${version} 回读`,
    { shell: false, env: regEnv.env }
  )
  if (back !== 0) {
    die(
      '登记回读失败：release add 返回成功，但 release show 查不到这一版',
      '查 dp release list 看实际落了什么；确认后手动补登/改登'
    )
  }
}

/**
 * 登记之后**当面对账**（卡 `c291b93a`）
 *
 * 1.0.111 的教训：登记写了摘要、写了 highlights、tested 也记了，
 * 唯独一张卡都没关联 —— 而当时没有任何一步因此变红。
 * 差集非空就中止，别让"看起来发过、其实查不到收了什么"的版本流出去。
 */
head('发版对账（release audit）')
{
  const audit = run(
    process.execPath,
    [cli, 'release', 'audit', '--project', PROJECT, '--version', version],
    `release audit ${version}`,
    { shell: false, env: regEnv.env }
  )
  if (audit !== 0) {
    die(
      `发版对账没通过（release audit 退出码 ${audit}）—— 这一版收的卡对不上账`,
      `看上面那份回执里的 unmarked（做完却没标版本的卡）与 unregistered（标了没登记的版本）：\n` +
      `        node out/cli/deskpartner.cjs todo update <卡> --fixed-in ${version}\n` +
      `      逐张标完，再跑一次 release audit 确认，然后手动补登记\n` +
      `        node out/cli/deskpartner.cjs release add --project "${PROJECT}" --version ${version} --summary "…"`
    )
  }
}

// ── 10. 收尾 ──
head('完成')
const total = Date.now() - t0
console.log(`  产物: dist/${installerName(version)}`)
console.log(`  清单: dist/latest.yml（已重算并回读核对）`)
console.log(`  登记: release add ${version}（已 release show 回读核对）`)
console.log(`  耗时: ${Math.round(total / 1000)}s`)
if (costs.length > 1) {
  console.log('\n  各步耗时（找瓶颈用）：')
  for (const [label, ms] of costs.sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(Math.round(ms / 1000)).padStart(5)}s  ${label}`)
  }
}
if (version !== currentVersion && !DRY) {
  console.log(
    `\n  下一步：git add package.json README.md AGENTS.md && git commit -m "release: ${version}"\n` +
      `  （版本号与入口文档的当前态都要提交，这个包才指得回源码；\n` +
      `   不提交的话下一次发版会被"工作区不干净"拦下）`
  )
}
