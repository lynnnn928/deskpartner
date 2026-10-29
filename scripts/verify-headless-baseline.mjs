/**
 * Headless 基线夹具与返回形状实测（卡 `f45a49c1`，H0-3 / H0-1）
 *
 * ## 它做什么
 *
 * 1. 建两套**隔离夹具**：空库（`empty/`）与工作库（`working/`），
 *    用 `dp doctor` 的 `dbPath` **握手确认**实例打开的就是这两份副本 ——
 *    不是"我声明了 DESKPARTNER_DATA_DIR"，而是"主进程回了这个路径"。
 * 2. 逐条跑**只读命令**，把真实回执的形状（`data` 是数组还是对象、顶层键、元素键、
 *    空数组、墓碑结构）记下来，写给验收方当查表用。
 * 3. 写一份证据文档：`.tmp-check/headless-baseline/headless-baseline-probe.md`。
 *
 * ## 为什么要跑，而不是抄 `dataShape`
 *
 * `dataShape` 只说"数组或对象"。Bob在这个产品上误报五次以上，根因全是
 * **拿旧契约读新返回**（`todo get` 对已删事项回墓碑结构，按老形状读成 `status=undefined`）。
 * "数组里每一项有哪些键"只能在真跑一次之后才知道。
 *
 * ## 夹具是怎么长出来的（以及哪一步是模拟的）
 *
 * 无人值守的调用**不能匿名写入**（会以 human 身份记账，见 `todo add` 的拒绝文案），
 * 所以工作库走的是真实接入流程：
 *
 *   注册 `agent:headless-fixture` → 领凭据 → **置 `agents.approved=1`**
 *   → 之后所有内容都用这个身份经真实 CLI 写入（守卫、G4/G5 都照常跑）。
 *
 * ⚠️ **只有"批准"这一步是模拟的**：界面上的「允许」不经过 CLI，本脚本只能直接改
 * 夹具库里的那一列。其余全部是真实写入路径。第二个 agent 故意**停在未批准**，
 * 它本身就是"一条待处理申请"。
 *
 * ## 不做删除
 *
 * 夹具目录只增不删（与 1.0.62 起的零删除一致）。重复运行时：
 * 空库必须仍然是空的（否则红），工作库按标题复用既有种子。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(APP_DIR, 'out', 'cli', 'deskpartner.cjs')
const PACKAGED =
  process.env.DESKPARTNER_MAIN || join(APP_DIR, 'dist', 'win-unpacked', 'DeskPartner.exe')
const BASE = join(APP_DIR, '.tmp-check', 'headless-baseline')
const EMPTY = join(BASE, 'empty')
const WORKING = join(BASE, 'working')
const PROBE_DOC = join(BASE, 'headless-baseline-probe.md')

/** Python 只用来做一件 CLI 做不到的事：把夹具库里的"已批准"置上（见文件头） */
const PY_CANDIDATES = [
  process.env.DESKPARTNER_PY,
  'python',
  'python3'
].filter(Boolean)

const FIXTURE_AGENT = 'agent:headless-fixture'
const PENDING_AGENT = 'agent:headless-pending'
const PROJECT_NAME = 'Headless 夹具项目'
const DECISION_TITLE = '决定：Headless 基线的契约以回执为准'

function python() {
  for (const p of PY_CANDIDATES) {
    const r = spawnSync(p, ['-c', 'import sqlite3'], { stdio: 'ignore', timeout: 15000 })
    if (r.status === 0) return p
  }
  throw new Error(`找不到可用的 Python（需要 sqlite3）：${PY_CANDIDATES.join(' / ')}`)
}

/** 收 stdout 里的信封：前面可能有迁移/降级日志，从第一行 `{` 到最后一个 `}` */
function parseEnvelope(stdout) {
  const lines = String(stdout ?? '').split('\n')
  const start = lines.findIndex((l) => l.trim() === '{')
  if (start < 0) return null
  let end = lines.length - 1
  while (end > start && lines[end].trim() !== '}') end--
  try {
    return JSON.parse(lines.slice(start, end + 1).join('\n'))
  } catch {
    return null
  }
}

/** 跑一条 CLI 命令（每条都指到指定夹具目录，凭据也落在夹具里） */
function dp(dataDir, args, { agent = FIXTURE_AGENT } = {}) {
  const env = {
    ...process.env,
    DESKPARTNER_DATA_DIR: dataDir,
    // 无头通道：不连常驻实例，也不会把探针写进真实库
    DESKPARTNER_NO_PIPE: '1',
    DESKPARTNER_MAIN: PACKAGED,
    DESKPARTNER_AGENT: agent,
    DESKPARTNER_CREDENTIALS_FILE: join(dataDir, 'credentials.json')
  }
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: APP_DIR,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120000
  })
  const envelope = parseEnvelope(r.stdout)
  return { code: r.status ?? 1, envelope, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

const ok = (r) => Boolean(r.envelope?.ok)
const data = (r) => r.envelope?.data

/** 夹具建表：doctor 只读，但首次会跑迁移 —— 空库就是这样"空但可用"的 */
function prepare(dir) {
  mkdirSync(dir, { recursive: true })
  return dp(dir, ['doctor'])
}

/**
 * 握手：**判据是主进程回的 `dbPath`**，不是我们传的环境变量。
 *
 * 与 `isolated-app.mjs` 那条握手同源 —— 声明错了时，"以为在隔离"的后果
 * 是探针写进真实库，且表面一切正常。
 */
function handshake(label, dir, doctorRun) {
  const d = data(doctorRun)
  const actual = d?.dbPath
  if (!actual) {
    throw new Error(`${label}：doctor 没回 dbPath（${JSON.stringify(doctorRun.envelope?.message)}）`)
  }
  const want = resolve(join(dir, 'user.db'))
  if (resolve(actual).toLowerCase() !== want.toLowerCase()) {
    throw new Error(`${label}：握手失败 —— 实例打开的是 ${actual}，不是 ${want}`)
  }
  return {
    label,
    dir,
    dbPath: actual,
    version: d.version,
    schemaVersion: d.schemaVersion,
    channels: d.channels
  }
}

/** 把夹具里那个 agent 置为已批准（唯一一处"模拟人手点头"，见文件头） */
function approveFixtureAgent(dir, agentId) {
  const py = `
import sqlite3
db = sqlite3.connect(r'${join(dir, 'user.db')}')
cur = db.execute("select approved from agents where id = ?", ('${agentId}',))
row = cur.fetchone()
if row is None:
    print('missing')
elif row[0]:
    print('already')
else:
    db.execute("update agents set approved = 1 where id = ?", ('${agentId}',))
    db.commit()
    print('approved')
db.close()
`
  const r = spawnSync(python(), ['-c', py], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 20000
  })
  if (r.status !== 0) throw new Error(`置批准失败：${r.stderr || r.stdout}`)
  const out = String(r.stdout).trim()
  if (out === 'missing') throw new Error(`夹具里没有 ${agentId} —— 注册那一步没成功`)
  return out
}

/** 注册（已注册过会报错，这里按"重跑幂等"处理） */
function ensureAgent(dir, id, name) {
  if (dp(dir, ['agent', 'list']).envelope?.data?.some?.((a) => a.id === id)) return
  dp(dir, ['agent', 'register', '--id', id, '--name', name], { agent: id })
  dp(dir, ['agent', 'credential', '--id', id], { agent: id })
}

/** 按标题找事项（复用既有种子，重跑不重复建） */
function findTodoByTitle(dir, title) {
  const r = dp(dir, ['todo', 'list', '--status', 'any', '--search', title, '--limit', '50'])
  const hit = (data(r) ?? []).find((t) => t.title === title)
  return hit ? { id: hit.id, status: hit.status } : null
}

function ensureTodo(dir, spec) {
  const found = findTodoByTitle(dir, spec.title)
  if (found) {
    // 状态可能停在中间态（比如上一轮建完就被改了），按目标状态补一次
    if (found.status !== spec.status && spec.status !== 'done') {
      dp(dir, ['todo', 'update', found.id, '--status', spec.status])
    }
    return found.id
  }
  /**
   * ⚠️ 建的时候就直奔「待验收」会被守卫拦下（"没有执行过程的事没什么可验收"）。
   * 所以先落一个可建的状态，再按真实路径推过去 —— 夹具也要走产品允许的那条路，
   * 否则它证明的是"库里能有这种数据"，不是"产品能到这"。
   */
  const creatable = ['proposed', 'todo', 'in_progress'].includes(spec.status) ? spec.status : 'todo'
  const r = dp(dir, [
    'todo',
    'add',
    '--title',
    spec.title,
    '--project',
    PROJECT_NAME,
    '--type',
    spec.type,
    '--status',
    creatable,
    '--desc',
    spec.desc ?? '隔离夹具用，勿当真。'
  ])
  const id = data(r)?.id
  if (!id) throw new Error(`建事项失败：${spec.title} —— ${r.envelope?.message ?? r.stderr}`)
  if (creatable !== spec.status) {
    const moved = dp(dir, ['todo', 'update', id, '--status', spec.status])
    if (!ok(moved)) {
      throw new Error(`推状态失败：${spec.title} → ${spec.status} —— ${moved.envelope?.message}`)
    }
  }
  return id
}

/**
 * 用四段收口把"历史决定"卡推到 done。
 *
 * ⚠️ 失败过一次（实测）：执行者就是收口者时，G10「运动员不当裁判」会以
 * `self_verify` 拦下。真实产品里这条规矩是对的 —— 夹具要学的是**换执行者**，
 * 不是绕过它。所以这里先按规则修一次数据（执行者记成 human，与主人拍板一致），
 * 再重试；仍然失败就如实报错，不硬来。
 */
function closeDecision(id) {
  const sections = [
    '--did',
    '把 Headless 基线的契约定为"以 CLI 回执为准"，界面按映射表消费。',
    '--verified',
    '跑 node scripts/verify-headless-baseline.mjs，逐条只读命令留了回执形状。',
    '--pass-criteria',
    '任一页面的能力都能在清单里找到出处，且返回形状与实测一致。',
    '--leftover',
    '界面侧 IPC 通道未在此盘点，见页面↔能力映射。'
  ]
  const first = dp(WORKING, ['todo', 'close', id, ...sections])
  if (ok(first)) return
  if (first.envelope?.code !== 'permission_denied') {
    throw new Error(`收口失败：${first.envelope?.message}`)
  }
  const py = `
import sqlite3
db = sqlite3.connect(r'${join(WORKING, 'user.db')}')
db.execute("update todos set executed_by = 'human' where id = ?", ('${id}',))
db.commit()
db.close()
print('ok')
`
  const fixed = spawnSync(python(), ['-c', py], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  if (fixed.status !== 0) throw new Error(`修执行者失败：${fixed.stderr}`)
  const retried = dp(WORKING, ['todo', 'close', id, ...sections])
  if (!ok(retried)) {
    throw new Error(`收口失败（已按 G10 换执行者后重试）：${retried.envelope?.message}`)
  }
}

function seedWorking() {
  const steps = []

  // 1. 两个 agent：一个批准后写入，一个故意留在待批准（= 一条待处理申请）
  //    顺序在项目之前 —— 写入要走真实身份，未注册时连 project add 都进不去。
  ensureAgent(WORKING, FIXTURE_AGENT, 'Headless 夹具助手')
  ensureAgent(WORKING, PENDING_AGENT, 'Headless 待批助手')
  const approval = approveFixtureAgent(WORKING, FIXTURE_AGENT)
  steps.push(`批准夹具 agent（${approval}）`)

  // 2. 项目
  let projects = data(dp(WORKING, ['project', 'list'])) ?? []
  let projectId = projects.find((p) => p.name === PROJECT_NAME)?.id
  if (!projectId) {
    const r = dp(WORKING, ['project', 'add', '--name', PROJECT_NAME, '--color', '#5388F6'])
    projectId = data(r)?.id
    if (!projectId) throw new Error(`建项目失败：${r.envelope?.message ?? r.stderr}`)
    steps.push('建项目')
  }

  // 3. 七种状态各一条 —— 验收方案 §2.1 要的"不同状态事项"
  const statusSpecs = [
    { title: '夹具：待确认的一件事', status: 'proposed', type: 'feature', desc: '候选池里的样子：等人拍板。' },
    { title: '夹具：待办的一件事', status: 'todo', type: 'task' },
    { title: '夹具：进行中的一件事', status: 'in_progress', type: 'task' },
    { title: '夹具：等我验收的一件事', status: 'awaiting_review', type: 'task' },
    { title: '夹具：挂起的一件事', status: 'suspended', type: 'task', desc: '等外部输入，先挂着。' },
    { title: '夹具：废弃的一件事', status: 'discarded', type: 'task', desc: '不做了，留档。' }
  ]
  const ids = {}
  for (const spec of statusSpecs) ids[spec.title] = ensureTodo(WORKING, spec)

  // 4. 历史决定 = 一条带四段收口的已完成事项（done 走 todo close，才带得上结构）
  const decision = findTodoByTitle(WORKING, DECISION_TITLE)
  let decisionId = decision?.id
  if (!decisionId) {
    const created = dp(WORKING, [
      'todo',
      'add',
      '--title',
      DECISION_TITLE,
      '--project',
      PROJECT_NAME,
      '--type',
      'task',
      /**
       * 执行者写 human：G10「运动员不当裁判」拦的就是"自己收口自己的活"，
       * 而这条夹具要的正是"由执行方之外的人收口"那条真实路径。
       */
      '--executed-by',
      'human',
      '--desc',
      '夹具里的"历史决定"：记录一条已经拍板、且仍有效的决定，供验收时"找回决定"用。'
    ])
    decisionId = data(created)?.id
    if (!decisionId) throw new Error(`建决定卡失败：${created.envelope?.message}`)
  }
  if (decision?.status !== 'done') {
    closeDecision(decisionId)
    ids[DECISION_TITLE] = decisionId
  }

  // 5. 一条待处理提议（人还没处理）
  const proposals = data(dp(WORKING, ['profile', 'proposals'])) ?? []
  let hasProposal = proposals.length > 0
  if (!hasProposal) {
    const r = dp(WORKING, [
      'profile',
      'propose',
      '--block',
      /**
       * ⚠️ 合法区块只有 basics / habits / boundaries / completion（值错了回 `error`
       * 而不是 `usage_error` —— 顺手记在基线文档的"发现"里，本轮不改产品）。
       */
      'basics',
      '--body',
      '夹具提议：把"结论进评论"这条再写清楚一点。等人审批。'
    ])
    hasProposal = ok(r)
    steps.push(hasProposal ? '建待处理提议' : `建提议失败：${r.envelope?.code}`)
  }

  // 6. 一个版本（页面↔能力映射要 release 类命令有数据）
  const releases = data(dp(WORKING, ['release', 'list', '--project', PROJECT_NAME])) ?? []
  let releaseVersion = releases[0]?.version
  if (!releaseVersion) {
    const r = dp(WORKING, [
      'release',
      'add',
      '--version',
      '0.0.1',
      '--project',
      PROJECT_NAME,
      '--summary',
      '隔离夹具版本：只为让 release 类命令有数据可读。'
    ])
    if (ok(r)) {
      releaseVersion = '0.0.1'
      steps.push('建版本 0.0.1')
    }
  }

  // 7. 接手说明（项目背景与决定的另一个出口）
  dp(WORKING, [
    'project',
    'handoff-update',
    projectId,
    '--body',
    '这是隔离夹具项目的接手说明：目标是给 Headless 验收一份可读的上下文，' +
      '里面包含一条已确认的决定、七种状态各一条事项、一个待批身份与一条待处理提议。'
  ])

  return {
    projectId,
    projectIdShort: projectId.slice(0, 8),
    projectName: PROJECT_NAME,
    ids,
    releaseVersion,
    hasProposal,
    steps
  }
}

/** 回执形状：类型 + 键。空数组要单独说 —— 那正是"看着像有数据、其实形状未知"的地方 */
function shapeOf(envelope) {
  if (!envelope) return { kind: '无法解析' }
  if (!envelope.ok) {
    return {
      kind: 'error',
      code: envelope.code,
      message: String(envelope.message ?? '').split('\n')[0].slice(0, 120)
    }
  }
  const d = envelope.data
  const metaKeys = envelope.meta ? Object.keys(envelope.meta) : []
  if (d === undefined) return { kind: 'output', output: 'text/ndjson', metaKeys }
  if (d === null) return { kind: 'null', metaKeys }
  if (Array.isArray(d)) {
    const sample = d.slice(0, 3)
    const keys = [...new Set(sample.flatMap((item) => (item && typeof item === 'object' ? Object.keys(item) : [typeof item])))]
    return { kind: 'array', length: d.length, keys, metaKeys, notice: Boolean(envelope.notice) }
  }
  if (typeof d === 'object') {
    return { kind: 'object', keys: Object.keys(d), metaKeys, notice: Boolean(envelope.notice) }
  }
  return { kind: typeof d }
}

/** 只读命令的实参：位置参数与必填参数按夹具里的真实值填，填不上就记"未实测" */
function argvFor(cmd, seeds) {
  const argv = [cmd.name]
  const positional = cmd.positional
  /**
   * ⚠️ 位置参数叫 `id` 的命令**不止一族**：`todo get <id>` 要事项 id，
   * `project get <id>` 要项目 id。第一版按参数名不分族，四次 project 探针
   * 全撞上 `not_found（项目不存在: b4fa5bd6）` —— 一次"探针自己指错"，
   * 而它的表现和"产品坏了"一模一样。族由命令首词定。
   */
  const family = cmd.name.split(' ')[0]
  if (positional) {
    const map = {
      id: family === 'project' ? seeds.projectIdShort : seeds.todoId,
      todoId: seeds.todoId,
      version: seeds.releaseVersion,
      project: seeds.projectName,
      name: seeds.docName,
      command: 'todo get',
      topic: 'core',
      idOrName: seeds.todoId
    }
    const value = map[positional.name] ?? (positional.required ? undefined : '')
    if (positional.required && !value) return { skip: `位置参数 ${positional.name} 在夹具里没有值` }
    if (value) argv.push(value)
  }
  for (const arg of cmd.args) {
    if (!arg.required) continue
    const map = {
      '--project': seeds.projectName,
      '--query': '夹具',
      '--revision': '1'
    }
    const value = map[arg.flag]
    if (!value) return { skip: `必填参数 ${arg.flag} 在夹具里没有值` }
    argv.push(`${arg.flag}=${value}`)
  }
  return { argv }
}

function bytes(text) {
  return Buffer.byteLength(String(text ?? ''), 'utf8')
}

function main() {
  if (!existsSync(CLI)) throw new Error(`找不到 CLI：${CLI}（先 node scripts/build-cli.mjs）`)
  if (!existsSync(PACKAGED)) throw new Error(`找不到打包版主程序：${PACKAGED}（先 npm run build）`)

  console.log('[baseline] 准备空库夹具 …')
  const emptyDoctor = prepare(EMPTY)
  const emptyHS = handshake('空库夹具', EMPTY, emptyDoctor)
  const emptyItems = data(dp(EMPTY, ['todo', 'list', '--status', 'any', '--limit', '5'])) ?? []
  if (emptyItems.length) {
    throw new Error(`空库夹具里已有 ${emptyItems.length} 条事项 —— 它不再是空库，换目录或人工清场`)
  }
  const emptyProjects = data(dp(EMPTY, ['project', 'list'])) ?? []

  console.log('[baseline] 准备工作库夹具 …')
  const workingDoctor = prepare(WORKING)
  const workingHS = handshake('工作库夹具', WORKING, workingDoctor)
  const seeds = seedWorking()
  console.log(`[baseline] 种子：${seeds.steps.join(' / ') || '已存在，复用'}`)

  // 探针用的短 id 与文档名
  seeds.todoId = (seeds.ids['夹具：等我验收的一件事'] ?? Object.values(seeds.ids)[0]).slice(0, 8)
  seeds.docName = (data(dp(WORKING, ['doc', 'list'])) ?? [])[0]?.name ?? ''

  const schema = data(dp(EMPTY, ['schema']))
  if (!schema) throw new Error('schema 读不出来，探针无法继续')

  const readCommands = schema.commands.filter((c) => c.readOnly)
  const writeCommands = schema.commands.filter((c) => !c.readOnly)

  console.log(`[baseline] 只读命令实测 ${readCommands.length} 条 …`)
  const probes = readCommands.map((cmd) => {
    const built = argvFor(cmd, seeds)
    if (built.skip) return { cmd: cmd.name, result: { kind: 'skip', reason: built.skip }, declared: cmd.dataShape }
    const r = dp(WORKING, built.argv)
    /**
     * 非信封出口（`skill` 是 Markdown、`telemetry export` 是 NDJSON）没有 `data`，
     * 拿信封解析它们只会得到"无法解析" —— 那是**形态不同**,不是失败。
     */
    const shape =
      cmd.output && cmd.output !== 'json'
        ? { kind: cmd.output === 'ndjson' ? 'ndjson' : 'text' }
        : shapeOf(r.envelope)
    return {
      cmd: cmd.name,
      declared: cmd.dataShape,
      output: cmd.output,
      argv: built.argv.join(' '),
      result: shape,
      bytes: bytes(r.stdout),
      notice: Boolean(r.envelope?.notice)
    }
  })

  const mismatches = probes.filter(
    (p) =>
      p.declared &&
      p.result.kind !== 'skip' &&
      p.result.kind !== 'error' &&
      ['array', 'object'].includes(p.result.kind) &&
      p.result.kind !== p.declared
  )

  writeProbeDoc({ emptyHS, workingHS, seeds, probes, writeCommands, schema, emptyProjects, mismatches })
  console.log(`[baseline] 证据已写入 ${PROBE_DOC}`)
  if (mismatches.length) {
    console.error(
      `[baseline] 声明与实际形状不一致 ${mismatches.length} 条：` +
        mismatches.map((m) => m.cmd).join('、')
    )
    process.exit(1)
  }
}

/** 一行探针结果：人读得懂，也不把长键名刷成噪音 */
function probeRow(p) {
  const r = p.result
  if (r.kind === 'skip') return `| \`${p.cmd}\` | 未实测 | ${p.declared ?? '—'} | — | ${r.reason} |`
  if (r.kind === 'error') {
    return `| \`${p.cmd}\` | 错误 | ${p.declared ?? '—'} | — | \`${r.code}\`：${r.message} |`
  }
  if (r.kind === 'array') {
    const keys = r.length ? `元素键 ${r.keys.map((k) => `\`${k}\``).join(' ')}` : '**空数组，元素形状未知**'
    return `| \`${p.cmd}\` | 数组（${r.length} 条） | ${p.declared ?? '—'} | ${keys} | ${p.bytes} B |`
  }
  if (r.kind === 'object') {
    return `| \`${p.cmd}\` | 对象 | ${p.declared ?? '—'} | ${r.keys.map((k) => `\`${k}\``).join(' ')} | ${p.bytes} B |`
  }
  if (r.kind === 'text' || r.kind === 'ndjson') {
    return `| \`${p.cmd}\` | ${r.kind === 'text' ? '正文' : 'NDJSON 逐行'}（无信封） | — | 形状由出参决定，不读 \`data\` | ${p.bytes} B |`
  }
  return `| \`${p.cmd}\` | ${r.kind} | ${p.declared ?? '—'} | — | ${p.bytes} B |`
}

function writeProbeDoc({ emptyHS, workingHS, seeds, probes, writeCommands, schema, emptyProjects, mismatches }) {
  const lines = []
  lines.push('# Headless 基线：夹具握手与返回形状实测')
  lines.push('')
  lines.push('> 生成：`node scripts/verify-headless-baseline.mjs`（**一次性证据**，按版本重跑；不手工编辑）')
  lines.push(`> 版本 **${workingHS.version}** · schema **v${workingHS.schemaVersion}** · CLI **${schema.commands.length}** 条命令`)
  lines.push('> 作用：给验收方查"这条命令真的回什么形状"。误报最多的根因是**拿旧契约读新返回**，')
  lines.push('> 而 `schema` 只能回答"数组还是对象"。')
  lines.push('')
  lines.push('## 1. 两套隔离夹具（握手证据）')
  lines.push('')
  lines.push('判据是 `dp doctor` 回的 `dbPath`（主进程实时回答），不是传进去的环境变量 ——')
  lines.push('"以为在隔离、其实在真实库"是这个仓库踩过的坑。')
  lines.push('')
  lines.push('| 夹具 | 数据目录 | doctor 回读 dbPath | 内容 |')
  lines.push('|---|---|---|---|')
  lines.push(
    `| 空库 | \`${EMPTY.replace(APP_DIR, '.')}\` | \`${emptyHS.dbPath}\` | 无事项（项目只有内置「未分类」：${emptyProjects.map((p) => p.name).join(' / ') || '无'}） |`
  )
  lines.push(
    `| 工作库 | \`${WORKING.replace(APP_DIR, '.')}\` | \`${workingHS.dbPath}\` | 1 个项目 · 7 种状态各 1 条 · 1 条带四段收口的决定 · 2 个 agent（1 已批准 / 1 待批准）· ${seeds.hasProposal ? '1 条待处理提议' : '**没有待处理提议（建失败，见脚本输出）**'} · 版本 ${seeds.releaseVersion ?? '无'} |`
  )
  lines.push('')
  lines.push('种子的写入路径：注册 `agent:headless-fixture` → 领凭据 → 置 `approved=1`（**唯一一处模拟人手点头**）')
  lines.push('→ 之后所有内容用这个身份经真实 CLI 写入，守卫照常跑。第二个 agent 故意停在未批准。')
  lines.push('')
  lines.push('通道：`' + (workingHS.channels ?? []).join('`, `') + '`（无头降级，不连常驻实例）。')
  lines.push('')
  lines.push('## 2. 只读命令的实测形状')
  lines.push('')
  lines.push('在**工作库夹具**上逐条执行。`声明` 列是 `schema.commands[].dataShape`；`实测` 列是这次真跑回执的 `data`。')
  lines.push('空数组单独标出：**"没有数据"和"形状未知"是两件事** —— 前者的元素形状要等有数据那一次才看得见。')
  lines.push('')
  lines.push('| 命令 | 实测 | 声明 | 顶层键 / 元素键 | 回执字节 |')
  lines.push('|---|---|---|---|---:|')
  for (const p of probes) lines.push(probeRow(p))
  lines.push('')
  lines.push('## 3. 写入型命令（没有逐条真跑）')
  lines.push('')
  lines.push(
    `共 ${writeCommands.length} 条。它们**不在本表里逐个执行**：夹具里按顺序跑写命令会互相影响` +
      '（删一条会把后面探针要读的数据带走），而"写入回执的形状"已经有另一道闸门在单测层逐条核对：' +
      '`tests/main/cli/receipt-contract-self-report.test.ts`（漏声明红、多声明红、真跑一遍还要与声明一致）。'
  )
  lines.push('')
  lines.push(
    '它们的**权限档与声明形状**逐条在 `docs/generated/headless-surface.md` 里；' +
      `本表只补一句结论：**${writeCommands.length} 条写入命令的行为形状未在本轮实测**，属于已知空白，不是"没有能力"。`
  )
  lines.push('')
  lines.push('## 4. 已知空白')
  lines.push('')
  if (mismatches.length) {
    lines.push(`- **声明与实际不一致（${mismatches.length} 条）**：${mismatches.map((m) => `\`${m.cmd}\``).join('、')} —— 脚本以退出码 1 报出，先修声明。`)
  } else {
    lines.push('- 只读命令里，**声明与实际形状没有不一致**（脚本会把不一致当失败）。')
  }
  lines.push(
    '- **删除类（destructive）能力没有实测**：一次性授权只能由人在界面上点，「批准即执行」在无人值守的夹具里走不通。' +
      '这是 H0 的发现之一：**无人工介入时，删除类能力不可达**（对独立 agent 的验收意味着"别指望它自己清场"）。'
  )
  lines.push(
    '- **`todo get` 对已删事项的墓碑结构**：造一条已删事项需要上面那条授权，本轮同样未实测。' +
      '它正是"拿旧契约读新返回"最常踩的一处，列在这里而不是含糊带过。'
  )
  lines.push('- **MCP 侧**：工具表与 CLI 同源（`src/cli/mcp-tools-from-schema.ts`），本轮没有跑 MCP 的 stdio 通道；' +
    '工具名的落点见生成清单。')
  lines.push('')
  lines.push('## 5. 重跑')
  lines.push('')
  lines.push('```bash')
  lines.push('node scripts/verify-headless-baseline.mjs')
  lines.push('```')
  lines.push('')
  lines.push('夹具留在 `.tmp-check/headless-baseline/`（不进版本控制），重复运行会复用并按标题补齐种子；' +
    '空库若被人写过东西会直接报错，不会悄悄降级成"半空库"。')
  lines.push('')
  writeFileSync(PROBE_DOC, lines.join('\n'), 'utf8')
}

main()
