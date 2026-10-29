/**
 * 发版脚本的纯逻辑：升版本 + 收尾版本登记（`scripts/release.mjs` 消费）
 *
 * ── 为什么单独一个模块 ──
 *
 * 1.0.73 的教训（卡 `ae9f5fdd` 的驳回）：`release` 命令组做完了，但**这一版自己
 * 没用上** —— `npm run release` 里没有任何一处调 `release add`，登记靠人记得，
 * 于是上线第一版就忘了，`dp release list` 长期是空数组。能力在、闭环断在最后一公里。
 *
 * 收进脚本之后，「缺摘要必须报错」这类判据需要**可单测的纯函数**，
 * 而 `release.mjs` 是顶层即执行的脚本，没法被测试 import（一 import 就真发版）。
 *
 * 所以这里只放纯逻辑（不 spawn、不碰库、不写盘）：
 *   - requireSummary / requireProject / buildReleaseAddArgs —— 登记的强制校验与 argv 组装
 *   - nextPatchVersion / resolveReleaseVersion —— 要发的号怎么来
 *   - applyVersionToJson —— 只改 package.json 的 version 一个字段
 *   - parseReleaseArgs —— 发版脚本自己的带值 flag，与 verify-package 的 key 分开
 *   - buildRegisterEnv / assertRegistrationInstance —— 登记由哪份代码执行的自证（8b9abe42）
 *
 * ⚠️ 这里**不许**出现 spawnSync/execSync —— 会被 `spawn-stdio-guard.test.ts` 扫到，
 * 而这个模块根本没有起子进程的理由。
 */

/**
 * 登记摘要：**必填**，缺了或只有空白就抛。
 *
 * 为什么是硬错而不是"先发了再补"：卡 `ae9f5fdd` 的驳回写明
 * 「发版最后一步强制登记，缺摘要就报错」—— 没有摘要的版本登记
 * 等于把"这版做了什么"又推回给人记，正是这次要修的形态。
 */
export function requireSummary(summary) {
  const s = typeof summary === 'string' ? summary.trim() : ''
  if (!s) {
    throw new Error(
      '缺 --summary：版本登记必须写清"这版做了什么"，缺摘要不算发完（发版脚本会中止）'
    )
  }
  return s
}

/**
 * 登记身份：收尾 `release add` 是写命令，必须声明 `DESKPARTNER_AGENT`。
 *
 * 为什么在前置检查就要（1.0.74 发版实测踩过）：本机有 4 个 agent 凭据
 * （carol / qwen / bob / alice），缺身份时 CLI 会报
 * `ambiguous_identity` 拒绝猜 —— 于是发版链跑完 4 分半构建 + 打包 + 验收，
 * 卡在最后一步"版本登记"才炸，整条链白跑。
 * 登记是强制步骤，身份就是它的前置条件，必须在动手打包前确认。
 */
export function requireAgentIdentity(env = process.env) {
  const id = typeof env?.DESKPARTNER_AGENT === 'string' ? env.DESKPARTNER_AGENT.trim() : ''
  if (!id) {
    throw new Error(
      '缺 DESKPARTNER_AGENT：收尾版本登记是写命令，必须声明身份' +
        '（本机多个 agent 凭据，CLI 不替你猜）。' +
        '先 export DESKPARTNER_AGENT=agent:<你> 再发版'
    )
  }
  return id
}

/**
 * 登记项目名：**必填**，缺了或只有空白就抛（卡 `a2ea95f8` 定的判据）。
 *
 * 为什么单独成一个函数（卡 `36f3eaa4`，1.0.115）：这条判据原先**只写在拼 argv 那一步**
 * （`buildReleaseAddArgs`），也就是发版链的第 13 步 —— 而它前面是 16 分钟的测试、
 * 构建、打包、验收。1.0.114 实测：前 12 步全过，到登记那步才发现没给 `--project`，
 * 于是 `package.json` 已升号、`dist/` 里已躺着一个装机包，**登记却没落**，
 * 版本处于"发出去了但查不到"的状态（事后靠手写脚本补登才齐）。
 *
 * 所以把判据提成一个纯函数，前置检查与拼 argv **共用这一处**：
 * 校验点搬到最早，两处不可能再各说各话。
 */
export function requireProject(project) {
  const p = typeof project === 'string' ? project.trim() : ''
  if (!p) {
    throw new Error(
      '缺 --project：版本挂在项目下（版本是项目下的二级概念），登记前先给出它属于哪个项目'
    )
  }
  return p
}

/**
 * 拼 `release add` 的 argv（不含 CLI 路径本身）。
 *
 * 参数顺序：--project → --version → --summary → --highlight* → --shipped-at → --tested。
 * `project` **必填**（a2ea95f8）：版本挂在项目下，缺了直接抛 ——
 * 发版链跑完 4 分钟构建才在登记那步炸的教训（见 requireAgentIdentity），
 * 前置条件就要在拼 argv 这里挡掉。
 * `--highlight` 与产品 CLI 的 `repeat` 语义一致：一条一传，按传入顺序。
 * `shippedAt` 不传就**不**带 --shipped-at（产品语义：不传 = 还没发布，
 * 不预填计划时间，那是编造）。发版收尾登记时传"此刻"，那是发布事实。
 * `tested` 同理不传就不带（不传 = 不知道，不编造）；发版链按真实情况传
 * yes（跑了且过）/ skipped（--skip-tests 跳过）—— 修 `065dcde4`：
 * skip-tests 的产物必须事后能被认出来，而不是只活在发版人的终端历史里。
 */
export function buildReleaseAddArgs({ project, version, summary, highlights = [], shippedAt, tested } = {}) {
  const p = requireProject(project)
  const v = typeof version === 'string' ? version.trim() : ''
  if (!v) throw new Error('缺版本号：release add 必须带 --version')
  const s = requireSummary(summary)
  const args = ['release', 'add', '--project', p, '--version', v, '--summary', s]
  for (const h of highlights) {
    const t = typeof h === 'string' ? h.trim() : ''
    if (t) args.push('--highlight', t)
  }
  if (shippedAt) args.push('--shipped-at', String(shippedAt))
  if (tested !== undefined && tested !== null) {
    const t = String(tested).trim()
    if (!['yes', 'no', 'skipped'].includes(t)) {
      throw new Error(`tested 只认 yes / no / skipped，收到: ${tested}`)
    }
    args.push('--tested', t)
  }
  return args
}

/** 补丁位 +1（1.0.73 → 1.0.74）。非 x.y.z 直接抛 —— 不猜预发布号怎么动。 */
export function nextPatchVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(v ?? '').trim())
  if (!m) throw new Error(`版本号 ${v} 不是 x.y.z 形式，补丁位没法 +1`)
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`
}

/**
 * 要发的号：`--to` 显式指定优先，否则补丁位 +1。
 *
 * 升版本因此不再依赖"人记得改 package.json"（卡 `f6c186b8` 的三步之一）。
 * `--to` 指回当前号 = 不升、按原号重打（重打上一版的逃生口）。
 */
export function resolveReleaseVersion(current, to) {
  const target = typeof to === 'string' ? to.trim() : ''
  if (!target) return nextPatchVersion(current)
  if (!/^\d+\.\d+\.\d+$/.test(target)) {
    throw new Error(`--to ${target} 不是 x.y.z 形式的版本号`)
  }
  return target
}

/**
 * 把 package.json 文本里的 version 字段换成目标号，**其余一字不动**。
 *
 * 为什么不做 JSON.parse → 改 → JSON.stringify 回写：那会把无关行
 * （缩进、字段顺序、行尾）也重排进 diff，review 时看不清"这次到底改了什么"。
 * 用行锚定的正则只换 version 那一行，写后由调用方回读核对。
 */
export function applyVersionToJson(raw, version) {
  const v = String(version ?? '').trim()
  if (!/^\d+\.\d+\.\d+$/.test(v)) {
    throw new Error(`要写进 package.json 的版本号 ${version} 不是 x.y.z 形式`)
  }
  const re = /^(\s*"version"\s*:\s*")([^"]*)(")/m
  if (!re.test(raw)) {
    throw new Error('package.json 里找不到 "version" 字段，不敢盲写')
  }
  return raw.replace(re, `$1${v}$3`)
}

/**
 * 发版脚本自己的 argv 解析：带值 flag（--summary/--to/--highlight）摘出来，
 * 余下的**位置参数**照旧交给 verify-package 当"关键字符串" key。
 *
 * 为什么必须摘干净：verify-package 会把每个位置参数当"改动真的进包了吗"的
 * 检索串。摘要/要点的值不带 `--` 前缀，不摘走就会被当成检索串 ——
 * 验收层凭空多出几条永远查不到的 key，报一堆假 FAIL。
 */
export function parseReleaseArgs(argv) {
  const out = { summary: null, to: null, highlights: [], keys: [], project: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const take = () => {
      const v = argv[i + 1]
      if (v === undefined || v.startsWith('--')) return null
      i++
      return v
    }
    if (a === '--project') out.project = take()
    else if (a.startsWith('--project=')) out.project = a.slice('--project='.length)
    else if (a === '--summary') out.summary = take()
    else if (a.startsWith('--summary=')) out.summary = a.slice('--summary='.length)
    else if (a === '--to') out.to = take()
    else if (a.startsWith('--to=')) out.to = a.slice('--to='.length)
    else if (a === '--highlight') {
      const v = take()
      if (v !== null) out.highlights.push(v)
    } else if (a.startsWith('--highlight=')) out.highlights.push(a.slice('--highlight='.length))
    else if (a.startsWith('--')) continue // 开关类（--dry-run / --skip-tests …），不带值
    else out.keys.push(a)
  }
  return out
}

/**
 * 发版链登记的通道环境（`8b9abe42`，选项①）。
 *
 * 病根：CLI 启动器优先走命名管道，**管道那头是正在跑的旧实例** ——
 * CLI 的行为版本 = 实例版本，不是磁盘产物的版本。机器上跑着旧 GUI 时，
 * 发版链每一步「用新参数调 CLI」都会被旧命令表拒收（1.0.75 发版实测：
 * `release add 不接受 --tested` 发版中止，而磁盘上 --tested 明明在）。
 *
 * 修法：登记显式走**新产物通道** ——
 * `DESKPARTNER_NO_PIPE=1` 绕开管道 + `DESKPARTNER_MAIN` 指向打包产物，
 * 无头降级才会执行磁盘上刚构建出来的那份代码（开发态缺 MAIN 会被
 * preflight 自检拦死——1.0.65 的 electron.exe 崩溃教训）。
 *
 * `mainExists: false`（打包布局变了 / 产物还没打出来）时**不注入 MAIN**，
 * 只关管道 —— 此时登记由哪个执行是不确定的，由 assertRegistrationInstance 兜住：
 * 宁可前置报错，也不要把「碰巧跑通」当「用对了代码」。
 */
export function buildRegisterEnv(env, { mainPath, mainExists } = {}) {
  const base = { ...(env ?? process.env) }
  base.DESKPARTNER_NO_PIPE = '1'
  if (mainExists && typeof mainPath === 'string' && mainPath.trim()) {
    base.DESKPARTNER_MAIN = mainPath.trim()
    return { env: base, via: 'dist-main', mainPath: mainPath.trim() }
  }
  delete base.DESKPARTNER_MAIN // 别继承上层环境的旧值，指向哪份代码要说得清
  return { env: base, via: 'no-pipe-only', mainPath: null }
}

/**
 * 登记前置自证（`8b9abe42`）：执行登记的实例版本必须 = 本版。
 *
 * `doctor` 自报 `version`（实例版本）与 `via`（走了哪条通道）。
 * 版本对不上 = 登记会被旧命令表拒收、或写进错误的语义 ——
 * 在这里停，报错里写明「登记将由哪个版本执行」，别等 `release add`
 * 抛一句指向参数的「不接受 --tested」再让人重新诊断一轮。
 *
 * 返回自报文案要用的字段；不对就抛（调用方 die）。
 */
export function assertRegistrationInstance({ expectedVersion, doctor, via }) {
  const v = typeof doctor?.version === 'string' ? doctor.version.trim() : ''
  const expected = String(expectedVersion ?? '').trim()
  if (!v) {
    throw new Error(
      `登记前置自证失败：doctor 没报出执行实例的版本（via: ${via ?? '未知'}）—— ` +
        `说不清登记由哪份代码执行，不敢登记`
    )
  }
  if (v !== expected) {
    throw new Error(
      `登记将由 ${v} 版实例执行，不是本版 ${expected}（via: ${via ?? '未知'}）—— ` +
        `旧实例的命令表没有本版的新参数，登记会失败或写错。` +
        `关掉正在运行的旧界面，或确认 dist/win-unpacked/DeskPartner.exe 是刚构建出来的产物`
    )
  }
  return { version: v, via: via ?? doctor?.via ?? '未知' }
}
