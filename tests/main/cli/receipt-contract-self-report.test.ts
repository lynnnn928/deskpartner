/**
 * 回执契约的自报闸门（1.0.110，收 `07a244d9` + `516a74d4`）
 *
 * 两张卡问的是同一件事：**回执长什么样，契约里说清了吗。**
 *
 * ── 07a244d9：`data` 是数组还是对象 ──
 *
 * 说明书里有一句承诺 ——「计数在 `meta` 里而不是 `data` 里，是为了让 `data`
 * 始终是数组（老脚本按数组解析不受影响）」。实测只对 list 类成立：
 * `todo get` / `todo children` / `project get` / `notification list` 回**对象**，
 * 而 schema 里一个字都没说，调用方只能按键试错。
 * 处置是 **B：每条命令声明 `dataShape`，并配一条"声明与实跑一致"的断言**。
 *
 * ── 516a74d4：默认带不带描述 ──
 *
 * 同一份库，CLI 直连默认带上描述、MCP 的 `list_todos` 默认兜 `--brief`，
 * 两次回执字节数差一大截，而**回执里没有任何字段说这件事**。
 * 处置是双向自报：契约里 `commands[].defaults`，运行时 `meta.fields`。
 *
 * ── 这条闸门为什么必须"真跑一遍" ──
 *
 * 只查"每条命令都声明了 `dataShape`"是**假闸门**：声明与实装分处两地，
 * 声明漂了照样全绿（本仓库在 `cli-wiring-gate.test.ts` 里栽过同一个跟头 ——
 * "每个参数都在 schema 里"在当前结构下恒真）。所以这里对着 fixture
 * **把每条命令真跑一遍**，比 `Array.isArray(data)` 与声明是否一致；
 * 跑不动的命令不许静默跳过（下面有覆盖断言）。
 *
 * ⚠️ 覆盖范围与它的边界：fixture 是内存库 + 真实仓储 + 几个桩
 * （`events` / `telemetry`），所以**每条命令都能跑**（含写命令，写完就重新种数据）。
 * 未覆盖的是"真实通道下的字节"，那部分由 `516a74d4` 那组用例按 **MCP 自己拼的
 * argv** 走一遍来回答（不是这里造的近似值）。
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { runMigrations } from '../../../src/main/database/migrations'
import {
  commands,
  executeOne,
  buildSchema,
  commandUsage
} from '../../../src/main/cli/commands'
import { formatOutcome } from '../../../src/main/cli/output'
import { buildAgentGuide } from '../../../src/main/cli/agent-guide'
import type { CliContext, CommandSpec, Outcome } from '../../../src/main/cli/commands'

const db = new Database(':memory:')

/**
 * 凭据文件也指到临时目录（1.0.116 起本文件要真跑 `agent credentials` /
 * `agent purge-credentials`）：不隔离的话，这条闸门读的是**本机真实凭据**，
 * 而 `purge-credentials` 会真的删掉一条 —— 用真实身份当探针是要不得的。
 */
const credsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-receipt-creds-'))
process.env.DESKPARTNER_CREDENTIALS_FILE = path.join(credsDir, 'credentials.json')
fs.writeFileSync(
  process.env.DESKPARTNER_CREDENTIALS_FILE,
  JSON.stringify(
    {
      version: 1,
      default: 'agent:probe',
      profiles: {
        'agent:probe': { token: 'probe-token', issuedAt: '2026-01-01T00:00:00.000Z' },
        'agent:probe-orphan': { token: 'orphan-token', issuedAt: '2026-10-06T00:00:00.000Z' }
      }
    },
    null,
    2
  )
)
vi.mock('../../../src/main/database/index', () => ({ getDatabase: () => db }))

/**
 * ⚠️ 必须拦掉"写真实凭据文件"（`commands.test.ts` 里的同一处坑）：
 * 这里会跑 `agent credential`，而它内部会 `fs.writeFileSync(~/.deskpartner/credentials.json)` ——
 * 那跟数据库半点关系没有，在测试里照写不误，会把本机真实身份的凭据换成随机 token。
 */
vi.mock('../../../src/cli/credentials', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/cli/credentials')>()
  return { ...actual, writeCredential: vi.fn() }
})

const { TodoRepository } = await import('../../../src/main/database/todo.repository')
const { CategoryRepository } = await import('../../../src/main/database/category.repository')
const { ProjectRepository } = await import('../../../src/main/database/project.repository')
const { MemoRepository } = await import('../../../src/main/database/memo.repository')
const { SettingsRepository } = await import('../../../src/main/database/settings.repository')
const { AgentRepository } = await import('../../../src/main/database/agent.repository')
const { ReleaseRepository } = await import('../../../src/main/database/release.repository')
const { CommentRepository } = await import('../../../src/main/database/comment.repository')
const { NotificationRepository } = await import('../../../src/main/database/notification.repository')
const { ReminderReceiptRepository } = await import('../../../src/main/database/reminder-receipt.repository')
const { RulesRepository } = await import('../../../src/main/database/rules.repository')
const { ProtocolRepository } = await import('../../../src/main/database/protocol.repository')
const { ProfileRepository } = await import('../../../src/main/database/profile.repository')

const todoRepo = new TodoRepository()
const categoryRepo = new CategoryRepository()
const projectRepo = new ProjectRepository()
const memoRepo = new MemoRepository()
const settingsRepo = new SettingsRepository()
const agentRepo = new AgentRepository()
const releaseRepo = new ReleaseRepository()
const commentRepo = new CommentRepository()

/** 信封类命令 = `data` 这个键真的存在的那种（`output` 缺省即 json） */
const envelopeCommands = commands.filter((c) => (c.output ?? 'json') === 'json')

let ids: {
  todo: string
  reviewTodo: string
  comment: string
  project: string
  category: string
  categoryB: string
  memo: string
  version: string
}

/** 每次都重种：一条命令一次干净的现场（写命令会改数据，跑完即弃） */
function seed() {
  db.prepare('DELETE FROM todos').run()
  db.prepare('DELETE FROM projects').run()
  db.prepare('DELETE FROM categories').run()
  const cat = categoryRepo.create({ name: '原方向', color: '#1', sortOrder: 0 })
  const catB = categoryRepo.create({ name: '探针目标', color: '#2', sortOrder: 1 })
  const proj = projectRepo.create({ name: '原项目' })
  projectRepo.create({ name: '备用项目' })
  const todo = todoRepo.create({
    title: '原始标题',
    /** 故意长于 LIST_DESC_PREVIEW_CHARS：摘要与全文的差别要能被用例看见 */
    description: '原始描述'.repeat(60),
    categoryIds: [cat.id],
    projectId: proj.id
  } as never)
  const reviewTodo = todoRepo.create({
    title: '待验收标题',
    description: '待验收描述',
    projectId: proj.id,
    status: 'awaiting_review'
  } as never)
  const comment = commentRepo.create({
    todoId: todo.id,
    body: '原始评论',
    authorType: 'human'
  } as never)
  const memo = memoRepo.create({ text: '原始备忘', author: 'human' } as never)
  releaseRepo.create({ projectId: proj.id, version: '0.0.1', summary: '探针版本' } as never)
  projectRepo.saveHandoff(proj.id, '初始接手说明')
  ids = {
    todo: todo.id,
    reviewTodo: reviewTodo.id,
    comment: comment.id,
    project: proj.id,
    category: cat.id,
    categoryB: catB.id,
    memo: memo.id,
    version: '0.0.1'
  }
}

/**
 * 让每条命令跑起来需要的最小参数。
 *
 * ⚠️ 这些是**探针参数**，不是"命令该怎么用"的说明书：
 * 值取自 `ids`（真 id / 真项目名），所以命令走的是真路径，不是被桩住的分支。
 * 三条危险动作（`agent credential` 写凭据文件、破坏性命令要 `--yes`）在文件顶部
 * 与 `NEEDS_YES` 里显式处理 —— 闸门不许有"悄悄跳过"的角落。
 */
const FLAG_VALUES: Record<string, string> = {
  '--title': '探针标题',
  '--desc': '探针描述',
  '--reason': '探针理由',
  '--comment': '探针评论',
  '--summary': '探针摘要',
  '--version': '0.0.1',
  '--key': 'theme',
  '--value': 'dark',
  '--query': '原项目',
  '--owner': 'human',
  '--to': 'human',
  '--status': 'todo',
  '--priority': 'normal',
  '--type': 'task',
  '--category': '原方向',
  '--fixed-in': '0.0.1',
  '--created-by': 'human',
  '--executed-by': 'human',
  '--verifier': 'human',
  '--due': '2026-12-01T18:00:00+08:00',
  '--remind': '2026-12-01T18:00:00+08:00',
  '--shipped-at': '2026-12-01',
  '--tested': 'yes',
  '--highlight': '探针亮点',
  '--revision': '1',
  '--rule': 'G1',
  '--enforcement': 'block',
  '--project': '原项目',
  '--name': '探针名称',
  '--text': '探针备忘',
  '--body': '探针正文'
}

const NEEDS_YES = new Set([
  'todo rm',
  'todo delete-comment',
  'telemetry clear',
  'project rm',
  'release rm',
  'memo rm',
  'category rm',
  'category merge',
  'agent purge-credentials'
])

/** schema 里没标 required、但运行时不给就走不通的那些 */
const EXTRA: Record<string, Record<string, string>> = {
  'todo update': { '--title': '探针标题' },
  'todo close': { '--did': '做了这件事', '--verified': '跑了测试', '--pass-criteria': '测试通过' },
  'project handoff-propose': { '--body': '探针接手说明' },
  'project handoff-update': { '--body': '探针接手说明' },
  'profile propose': { '--block': 'basics' },
  'protocol propose': { '--block': 'roles' },
  'release add': { '--version': '0.0.2' },
  /** 未注册的探针身份：清理只受理不在册的那些 */
  'agent purge-credentials': { '--id': 'agent:probe-orphan' }
  // project rm 的 '--to' 随 1.0.111 的口径一起移除（卡 c177e466），此处不再需要补参数
}

function positionalFor(cmdName: string, spec: NonNullable<CommandSpec['positional']>): string[] {
  if (cmdName === 'help') return ['todo', 'add']
  if (spec.name === 'ids') return [ids.category, ids.categoryB]
  const names = [spec.name, ...(spec.arity === 2 ? [spec.name] : [])]
  return names.filter(Boolean).map((n) => {
    if (n === 'id') {
      if (cmdName.startsWith('todo delete-comment')) return ids.comment
      if (cmdName.startsWith('todo')) return cmdName === 'todo reject' ? ids.reviewTodo : ids.todo
      if (cmdName.startsWith('project')) return ids.project
      if (cmdName.startsWith('memo')) return ids.memo
      if (cmdName.startsWith('category')) return ids.category
      return 'agent:probe'
    }
    if (n === 'version') return ids.version
    if (n === 'topic') return ''
    /** `doc show <name>`：出口只有这几份，拿短名探就行 */
    if (n === 'name') return 'collaboration'
    return ids.todo
  })
}

function argvFor(cmd: CommandSpec): string[] {
  const flags: string[] = []
  for (const a of cmd.args) {
    if (!a.required) continue
    if (a.type === 'boolean') flags.push(a.flag)
    else flags.push(a.flag, EXTRA[cmd.name]?.[a.flag] ?? FLAG_VALUES[a.flag] ?? '探针')
  }
  for (const [flag, v] of Object.entries(EXTRA[cmd.name] ?? {})) {
    if (flags.includes(flag)) continue // 已作为必填参数填过（EXTRA 也能给必填项定探针值）
    flags.push(flag, v)
  }
  for (const flag of ['--body', '--reason']) {
    if (cmd.args.some((a) => a.flag === flag) && !flags.includes(flag)) flags.push(flag, FLAG_VALUES[flag])
  }
  if (NEEDS_YES.has(cmd.name) && cmd.args.some((a) => a.flag === '--yes')) flags.push('--yes')
  return [cmd.name, ...(cmd.positional ? positionalFor(cmd.name, cmd.positional) : []), ...flags]
}

function ctxOf(): CliContext {
  return {
    deps: {
      todoRepo,
      categoryRepo,
      projectRepo,
      memoRepo,
      settingsRepo,
      agentRepo,
      releaseRepo,
      /* 卡 69788c32：命令层要读哪个仓储由 deps 决定 —— 缺一个，跑到那条命令就炸 */
      commentRepo: new CommentRepository(),
      notificationRepo: new NotificationRepository(),
      reminderReceiptRepo: new ReminderReceiptRepository(),
      rulesRepo: new RulesRepository(),
      protocolRepo: new ProtocolRepository(),
      profileRepo: new ProfileRepository(),
      events: { append: () => {} },
      telemetry: { record: () => {}, stats: () => ({}), query: () => [], clear: () => 0 }
    },
    meta: {
      version: 'test',
      dbPath: ':memory:',
      schemaVersion: 45,
      busyTimeoutMs: 5000,
      channels: ['headless'],
      via: 'headless',
      startedAt: Date.now()
    },
    /** 按"人在终端敲"来跑：这里验的是命令自己回什么，门禁有自己的用例 */
    interactive: true,
    actor: 'human',
    stdin: '{"cmd":"todo list"}'
  } as unknown as CliContext
}

/**
 * 静态判据：**纯函数**，好让"喂一份假声明必须判红"这条反向验证能直接跑它。
 *
 * 两条都查，因为两头都有病：
 * - 信封类漏声明 —— 调用方还是只能按键试错（卡上要治的那个）；
 * - 非信封类乱声明 —— `output: 'text'` 却说 `dataShape`，同一个事实两处声明，迟早漂。
 */
function declarationProblems(
  cmds: Pick<CommandSpec, 'name' | 'output' | 'dataShape'>[]
): string[] {
  const bad: string[] = []
  for (const c of cmds) {
    const envelope = (c.output ?? 'json') === 'json'
    if (envelope && c.dataShape !== 'array' && c.dataShape !== 'object') {
      bad.push(`${c.name}: 信封类命令没声明 dataShape（拿到它的人只能按键试错）`)
    }
    if (!envelope && c.dataShape !== undefined) {
      bad.push(`${c.name}: output=${c.output} 没有信封 data，不该声明 dataShape（形状由 output 回答）`)
    }
  }
  return bad
}

describe('回执 data 的形状要在契约里声明（07a244d9）', () => {
  beforeAll(() => {
    runMigrations(db)
    db.pragma('foreign_keys = OFF')
    agentRepo.register({ id: 'agent:probe', displayName: '探针身份' } as never)
    agentRepo.setApproved('agent:probe', true)
  })

  beforeEach(() => seed())

  it('闸门自己别瞎了：扫到的是真实的命令面', () => {
    expect(commands.length, '命令表为空 —— 这条闸门等于没跑').toBeGreaterThan(30)
    expect(envelopeCommands.length, '信封类命令一条都扫不到').toBeGreaterThan(30)
    expect(
      commands.length - envelopeCommands.length,
      '非信封类命令（text / ndjson）一条都没有？那"不许声明"那条判据没被验到'
    ).toBeGreaterThan(0)
  })

  it('每条信封类命令都声明了形状，非信封类一条都不许声明', () => {
    expect(declarationProblems(commands)).toEqual([])
  })

  it('反向验证：喂一份假声明，判据必须判红（否则它是假闸门）', () => {
    const fake = [
      { name: 'todo get', output: 'json' as const, dataShape: undefined },
      { name: 'todo list', output: 'json' as const, dataShape: 'array' as const },
      { name: 'skill', output: 'text' as const, dataShape: 'array' as const }
    ]
    const bad = declarationProblems(fake)
    expect(bad.length, '漏声明与乱声明都得判红').toBe(2)
    expect(bad.join('\n')).toContain('todo get')
    expect(bad.join('\n')).toContain('skill')
  })

  it('schema 把声明带出去了（与命令表逐条一致）', () => {
    const schema = buildSchema() as { commands: { name: string; dataShape?: string }[] }
    const byName = new Map(schema.commands.map((c) => [c.name, c]))
    for (const c of commands) {
      expect(byName.get(c.name), `${c.name} 不在 schema 的命令表里`).toBeTruthy()
      expect(byName.get(c.name)!.dataShape, `${c.name} 的 dataShape 没进 schema`).toBe(c.dataShape)
    }
    /**
     * 说明书也得说：agent 唯一会主动读的是 schema 与本文件生成的说明书，
     * "能查到"和"知道去查"是两件事（qwen 实测在 schema 全文搜 G10 得 0 次那次同源）。
     */
    expect(JSON.stringify(schema)).toContain('dataShape')
    expect(buildAgentGuide()).toContain('dataShape')
  })

  it('help 单条也带形状（与 schema 同源，不是第三份判据）', () => {
    const hit = commands.find((c) => c.name === 'todo get')!
    expect(commandUsage(hit).dataShape).toBe('object')
  })

  it('逐条真跑一遍：data 的真实形状与声明一致（含写命令）', async () => {
    const mismatched: string[] = []
    let checked = 0
    for (const c of envelopeCommands) {
      seed()
      const outcome = (await executeOne(ctxOf(), argvFor(c))) as unknown as Outcome
      expect(
        outcome.ok,
        `${c.name} 在 fixture 上跑不动（探针参数该修）：${String((outcome as { message?: string }).message)}`
      ).toBe(true)
      const actual = Array.isArray((outcome as { data?: unknown }).data) ? 'array' : 'object'
      checked++
      if (actual !== c.dataShape) {
        mismatched.push(`${c.name}: 声明 ${c.dataShape}，实跑是 ${actual}`)
      }
    }
    expect(mismatched, '声明与实装漂了 —— 拿到 schema 的人会按错的形状解析').toEqual([])
    expect(checked, '有命令被静默跳过（覆盖数少于信封类命令数）').toBe(envelopeCommands.length)
  })

  it('说明书不再声称"data 始终是数组"（承诺只覆盖 list 类）', () => {
    const guide = buildAgentGuide()
    expect(guide).toContain('这几条 list 命令')
    /** 老写法（无限定的那句）不许回来 */
    expect(guide).not.toContain('是为了让 `data` 始终是数组')
  })

  it('翻页不改形状：memo list 截断时 data 仍是数组', async () => {
    const outcome = (await executeOne(ctxOf(), ['memo', 'list', '--limit', '1'])) as unknown as {
      ok: boolean
      data: unknown
      meta?: Record<string, unknown>
    }
    expect(outcome.ok).toBe(true)
    expect(Array.isArray(outcome.data), '截断时把 data 换成对象 = 老脚本 foreach 静默空转').toBe(true)
    expect(outcome.meta?.truncated, '这个现场本该被截断，否则这条用例什么也没验到').toBe(true)
    /** 参数说明此前说的"回执是数组 ⇒ 读完了"是错的：变的是有没有 meta，不是形状 */
    const desc = String(commands.find((c) => c.name === 'memo list')!.args.find((a) => a.flag === '--offset')!.desc)
    expect(desc).toContain('有没有 `meta`')
  })
})

describe('默认口径要在契约与回执里自报（516a74d4）', () => {
  beforeAll(() => {
    runMigrations(db)
    db.pragma('foreign_keys = OFF')
    agentRepo.register({ id: 'agent:probe', displayName: '探针身份' } as never)
    agentRepo.setApproved('agent:probe', true)
  })

  beforeEach(() => {
    seed()
    /**
     * 只留三条：CLI 的默认 20 条与 MCP 的默认 50 条**都装得下**，
     * 于是两条通道的差别只剩"带不带描述"——正是这张卡要解释的那一件事。
     */
    db.prepare('DELETE FROM todos').run()
    todoRepo.create({
      title: '带长描述的卡',
      description: '描述'.repeat(200),
      projectId: ids.project
    } as never)
    todoRepo.create({ title: '第二条', projectId: ids.project } as never)
  })

  const fieldsOf = (o: { meta?: Record<string, unknown> }) =>
    ((o.meta ?? {}) as { fields?: { description?: string; previewChars?: number } }).fields ?? {}

  it('schema 里的默认口径与常量同源（不许在 schema 里另抄一个数字）', () => {
    const schema = buildSchema() as {
      commands: { name: string; defaults?: { limit?: number; fields?: { description?: string; previewChars?: number } } }[]
    }
    const list = schema.commands.find((c) => c.name === 'todo list')!
    expect(list.defaults?.limit).toBe(20)
    expect(list.defaults?.fields).toEqual({ description: 'preview', previewChars: 80 })
    const grants = schema.commands.find((c) => c.name === 'agent grants')!
    expect(grants.defaults?.limit, '默认有界那条卡留下的常量也得从这里露出来').toBe(20)
  })

  it('CLI 直连的回执自报"带描述"，且真的带了', async () => {
    const cli = (await executeOne(ctxOf(), ['todo', 'list'])) as unknown as {
      ok: boolean
      data: Record<string, unknown>[]
      meta?: Record<string, unknown>
    }
    expect(cli.ok).toBe(true)
    expect(fieldsOf(cli)).toEqual({ description: 'preview', previewChars: 80 })
    expect(cli.data.length).toBeGreaterThan(0)
    for (const row of cli.data) {
      /** 键必须在（没有描述的行动里是 null —— 那是"这条没写描述"，不是"这次不带描述"） */
      expect('description' in row, '自报说带了描述，行里就得有这个键').toBe(true)
      if (row.description === null) continue
      expect(typeof row.description, '描述只能是字符串或 null').toBe('string')
      expect(
        Array.from(String(row.description)).length,
        '自报说截到 80 字，就得真截（截断判定也在这条上验）'
      ).toBeLessThanOrEqual(81)
    }
    expect(cli.data.some((r) => r.descriptionTruncated === true), '长描述要被标成截断').toBe(true)
  })

  it('显式传 --brief 时自报换成 omitted —— 自报的是"这一次"，不是"默认"', async () => {
    const brief = (await executeOne(ctxOf(), ['todo', 'list', '--brief'])) as unknown as {
      data: Record<string, unknown>[]
      meta?: Record<string, unknown>
    }
    expect(fieldsOf(brief)).toEqual({ description: 'omitted', previewChars: 0 })
    for (const row of brief.data) expect('description' in row).toBe(false)
  })

  it('同一份库：CLI 与 MCP 各调一次，字节差**只有**描述那三个字段解释得了', async () => {
    /**
     * MCP 那一次的 argv **由 MCP 自己拼**（`list_todos` 的 `toArgv`）——
     * 不是这里造的近似值：通道默认兜什么东西，判据在通道自己手里。
     */
    const { TOOLS } = await import('../../../src/cli/mcp-server')
    const mcpTool = TOOLS.find((t) => t.name === 'list_todos')
    expect(mcpTool, 'list_todos 不在了？那这条用例验的不是 MCP 真实的调用').toBeTruthy()
    const mcpArgv = mcpTool!.toArgv({})

    const cli = (await executeOne(ctxOf(), ['todo', 'list'])) as unknown as {
      ok: boolean
      data: Record<string, unknown>[]
      meta?: Record<string, unknown>
      notice?: string
    }
    const mcp = (await executeOne(ctxOf(), mcpArgv)) as unknown as {
      ok: boolean
      data: Record<string, unknown>[]
      meta?: Record<string, unknown>
      notice?: string
    }
    expect(cli.ok && mcp.ok).toBe(true)

    /** ① 两侧各自自报，值不同而**都如实** */
    expect(fieldsOf(cli).description).toBe('preview')
    expect(fieldsOf(mcp).description).toBe('omitted')

    /** ② 回执字节差有解释：剥掉那三个字段后，两份 data 必须**逐字节相同** */
    const strip = (rows: Record<string, unknown>[]) =>
      rows.map(({ description: _d, descriptionTruncated: _t, remindAt: _r, ...rest }) => rest)
    expect(JSON.stringify(strip(cli.data))).toBe(JSON.stringify(strip(mcp.data)))

    const cliOut = formatOutcome(cli as never, ['todo', 'list'], false)
    const mcpOut = formatOutcome(mcp as never, mcpArgv, false)
    const saved = cliOut.stdout.length - mcpOut.stdout.length
    const descCost = JSON.stringify(cli.data).length - JSON.stringify(strip(cli.data)).length
    expect(saved, 'MCP 那条更短 —— 短的就是描述').toBeGreaterThan(0)
    expect(
      saved,
      `字节差 ${saved} 与描述本身的开销 ${descCost} 对不上：说明差异还有别的来源`
    ).toBeGreaterThanOrEqual(descCost)
  })
})
