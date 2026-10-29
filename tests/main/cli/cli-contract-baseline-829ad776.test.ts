/**
 * 命令面契约的可重跑基线（卡 `829ad776`）
 *
 * ## 它治的病
 *
 * 三张结构债卡（`bbeb1b51` / `d1b71d28` / `69788c32`）都声称"外部契约一行没变"，
 * 而证据是**一次性比对**：拆之前 dump 三份、拆完逐字节 diff，全等就算证明。
 * 那份证据随 scratchpad 一起消失，仓库里没有留下任何可重跑的东西。
 *
 * 而 `commands/meta.ts` 的头注释自己写着：
 * 「数组**顺序是外部契约**的一部分：`dp help` 的排列、`dp schema` 的命令清单、
 * MCP `tools/list` 的工具顺序都由这张表的顺序决定」——
 * **契约写在注释里，没有闸门**。今天有人把两个域的顺序对调，没有一条用例会红。
 *
 * ## 冻的是哪三份
 *
 * | 契约 | 取法 | 为什么是它 |
 * | --- | --- | --- |
 * | `schema` | `executeOne(ctx, ['schema'])` 的非 TTY 输出（JSON 信封） | 命令清单 + 参数 + 枚举 + 出口码，agent 自举的唯一入口 |
 * | `help` | 顶层 `help` + 每条命令的 `help <命令名>`，同一套非 TTY 输出 | 人读出口；`readOnly` / `risk` / `dataShape` 都在里面 |
 * | MCP `tools/list` | 内存通道真连一次 server，取 `listTools()` | 宿主模型看到的那份，含 `inputSchema` 与 `annotations` |
 *
 * 三份都从**源码内**取，不 spawn、不打包（跑得快、也能在任何分支上跑）。
 * MCP 那份注入假 `invoke` 喂真 `buildSchema()`，于是工具表还是"schema 的派生物"，
 * 与线上同一条路（`createMcpServer` 的第二个参数就是为这件事留的）。
 *
 * ## 判据（卡面逐条）
 *
 * 1. 两条命令顺序对调 ⇒ 红，并报出「第 i 位、当前 X、基线 Y」；
 * 2. 单条命令的 help 文案/参数变了 ⇒ 红，并**点名那条命令**；
 * 3. 增删一条命令 / 一个工具 ⇒ 红，并点名多出或缺失的那个；
 * 4. 本文件的"反向验证"一节用**合成契约**证明这套差异判定不是恒绿；
 * 5. 普通测试运行**绝不改写基线**；更新走显式入口
 *    `node scripts/update-cli-contract-baseline.mjs`（它设 `UPDATE_CLI_CONTRACT=1` 跑本文件）。
 *
 * ⚠️ 契约里**不许出现会随发版变的运行时事实**（版本号、库路径、调用者）——
 * 出现了这份基线就没法跟着发版走（每次发版必红，很快会被人加 `--update` 糊过去）。
 * 「不随运行时事实变化」那一节就是盯这件事的。
 */
import { describe, it, expect, beforeAll, vi } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { runMigrations } from '../../../src/main/database/migrations'
import { TodoRepository } from '../../../src/main/database/todo.repository'
import { CategoryRepository } from '../../../src/main/database/category.repository'
import { ProjectRepository } from '../../../src/main/database/project.repository'
import { MemoRepository } from '../../../src/main/database/memo.repository'
import { CommentRepository } from '../../../src/main/database/comment.repository'
import { NotificationRepository } from '../../../src/main/database/notification.repository'
import { ReminderReceiptRepository } from '../../../src/main/database/reminder-receipt.repository'
import { RulesRepository } from '../../../src/main/database/rules.repository'
import { ProtocolRepository } from '../../../src/main/database/protocol.repository'
import { ProfileRepository } from '../../../src/main/database/profile.repository'
import { executeOne } from '../../../src/main/cli/commands'
import { formatOutcome } from '../../../src/main/cli/output'
import { buildSchema } from '../../../src/main/cli/command-schema'
import { createMcpServer } from '../../../src/cli/mcp-server'

const db = new Database(':memory:')
vi.mock('../../../src/main/database/index', () => ({ getDatabase: () => db }))

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BASELINE_PATH = path.join(HERE, 'cli-contract-baseline.json')
const UPDATE = process.env.UPDATE_CLI_CONTRACT === '1'
/** 基线在本次运行开始时的那份字节 —— 「不许被悄悄改写」的比对对象 */
const BASELINE_AT_START = fs.existsSync(BASELINE_PATH)
  ? fs.readFileSync(BASELINE_PATH, 'utf8')
  : null

const sha = (text: string): string => crypto.createHash('sha256').update(text, 'utf8').digest('hex')

/** 一段契约：有序名单（顺序本身是契约）+ 逐条指纹（失败时能点名，而不是"哈希对不上"） */
interface Section {
  _what: string
  order: string[]
  entries: Record<string, string>
}

interface Contract {
  _note: string
  schema: Section & { envelope: string; rest: string }
  help: Section & { top: string }
  mcp: Section & { list: string }
}

interface SchemaCommand {
  name: string
  [k: string]: unknown
}

interface ToolListItem {
  name: string
  [k: string]: unknown
}

/** 造一个与其它 CLI 用例同形的 ctx（deps 用真仓储 —— 卡 69788c32 之后这是约定） */
function makeCtx(version: string, dbPath: string) {
  return {
    deps: {
      todoRepo: new TodoRepository(),
      categoryRepo: new CategoryRepository(),
      projectRepo: new ProjectRepository(),
      memoRepo: new MemoRepository(),
      commentRepo: new CommentRepository(),
      notificationRepo: new NotificationRepository(),
      reminderReceiptRepo: new ReminderReceiptRepository(),
      rulesRepo: new RulesRepository(),
      protocolRepo: new ProtocolRepository(),
      profileRepo: new ProfileRepository(),
      settingsRepo: { get: () => ({}) },
      agentRepo: { countGrants: () => 0, listGrants: () => [] },
      events: { append: () => {} },
      telemetry: { record: () => {}, query: () => [] }
    },
    meta: { version, dbPath, schemaVersion: 46, via: 'headless' },
    interactive: false,
    actor: 'human'
  } as never
}

/** MCP `tools/list` —— 内存通道真连一次，拿到宿主看到的那份（含 inputSchema） */
async function mcpToolsList(): Promise<ToolListItem[]> {
  const server = await createMcpServer('contract-probe', async (argv) =>
    argv[0] === 'schema' ? { ok: true, data: buildSchema() } : { ok: false, code: 2 }
  )
  const [clientT, serverT] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'contract-probe', version: '0' }, { capabilities: {} })
  await Promise.all([server.connect(serverT), client.connect(clientT)])
  try {
    const res = (await client.listTools()) as { tools: ToolListItem[] }
    return res.tools
  } finally {
    await client.close()
  }
}

/**
 * 算一遍三份契约。
 *
 * `version` / `dbPath` 由调用方给：除"不随运行时事实变化"那一节外，一律用哨兵值 ——
 * 基线不许绑定真实版本号。
 */
export async function computeContract(version: string, dbPath: string): Promise<Contract> {
  const ctx = makeCtx(version, dbPath)

  const schemaOutcome = await executeOne(ctx, ['schema'])
  const schemaStdout = formatOutcome(schemaOutcome, ['schema'], false).stdout
  const data = schemaOutcome.data as { commands: SchemaCommand[] } & Record<string, unknown>
  const schemaOrder = data.commands.map((c) => c.name)
  const schemaEntries: Record<string, string> = {}
  for (const c of data.commands) schemaEntries[c.name] = sha(JSON.stringify(c))
  const { commands: _omit, ...rest } = data

  const topStdout = formatOutcome(await executeOne(ctx, ['help']), ['help'], false).stdout
  const helpEntries: Record<string, string> = {}
  for (const name of schemaOrder) {
    const argv = ['help', ...name.split(' ')]
    helpEntries[name] = sha(formatOutcome(await executeOne(ctx, argv), argv, false).stdout)
  }

  const tools = await mcpToolsList()
  const mcpEntries: Record<string, string> = {}
  for (const t of tools) mcpEntries[t.name] = sha(JSON.stringify(t))

  return {
    _note:
      '命令面契约基线（卡 829ad776）。由 tests/main/cli/cli-contract-baseline-829ad776.test.ts 逐条比对。' +
      '契约要改就是显式改：跑 `node scripts/update-cli-contract-baseline.mjs`，把这个文件的 diff 带进评审。' +
      '普通测试运行不会改写它。',
    schema: {
      _what: '`dp schema` 的非 TTY 输出：envelope=整份字节；rest=除 commands 之外的部分；entries=逐条命令',
      envelope: sha(schemaStdout),
      rest: sha(JSON.stringify(rest)),
      order: schemaOrder,
      entries: schemaEntries
    },
    help: {
      _what: '`dp help` 与 `dp help <命令>` 的非 TTY 输出：top=顶层清单；entries=逐条命令',
      top: sha(topStdout),
      order: schemaOrder,
      entries: helpEntries
    },
    mcp: {
      _what: 'MCP `tools/list` 的结果：list=整份字节；entries=逐个工具（含 inputSchema / annotations）',
      list: sha(JSON.stringify({ tools })),
      order: tools.map((t) => t.name),
      entries: mcpEntries
    }
  }
}

/** 比一段有序名单 + 逐条指纹，差异要说人话：第几位、谁变了、多谁少谁 */
function diffSection(label: string, base: Section, cur: Section, out: string[]): number {
  const before = out.length
  if (base.order.join('\u0000') !== cur.order.join('\u0000')) {
    if (base.order.length !== cur.order.length) {
      out.push(`${label}：条数 ${base.order.length} → ${cur.order.length}`)
    }
    let named = 0
    const n = Math.max(base.order.length, cur.order.length)
    for (let i = 0; i < n && named < 5; i++) {
      if (base.order[i] === cur.order[i]) continue
      out.push(
        `${label}：第 ${i + 1} 位 当前 "${cur.order[i] ?? '(无)'}" / 基线 "${base.order[i] ?? '(无)'}"`
      )
      named++
    }
    const added = cur.order.filter((x) => !base.order.includes(x))
    const gone = base.order.filter((x) => !cur.order.includes(x))
    if (added.length) out.push(`${label}：多出 ${added.length} 个 —— ${added.slice(0, 6).join(' / ')}`)
    if (gone.length) out.push(`${label}：少了 ${gone.length} 个 —— ${gone.slice(0, 6).join(' / ')}`)
  }
  // 逐条指纹：只比两侧都在的条目，增删已经由上面那段点过名了
  for (const [name, h] of Object.entries(base.entries)) {
    const curH = cur.entries[name]
    if (curH === undefined || curH === h) continue
    out.push(`${label}：「${name}」的内容变了`)
  }
  return out.length - before
}

/** 三份契约的差异清单；空数组 = 完全一致 */
export function diffContract(base: Contract, cur: Contract): string[] {
  const out: string[] = []
  const schemaN = diffSection('schema', base.schema, cur.schema, out)
  diffSection('help', base.help, cur.help, out)
  const mcpN = diffSection('mcp', base.mcp, cur.mcp, out)

  // 逐条都对得上、整份却不同 ⇒ 变的是"信封/总则"那一层，得说清楚，不然最难看懂
  if (base.schema.envelope !== cur.schema.envelope && schemaN === 0) {
    out.push('schema：命令条目逐条一致，变的是信封本身（output / exitCodes / gates 那部分）')
  }
  if (base.schema.rest !== cur.schema.rest) {
    out.push('schema：rest（除 commands 之外的总则部分）变了')
  }
  if (base.help.top !== cur.help.top) out.push('help：顶层清单变了')
  if (base.mcp.list !== cur.mcp.list && mcpN === 0) {
    out.push('mcp：工具条目逐条一致，变的是整份 tools/list（顺序或包装）')
  }
  return out
}

function readBaselineFile(): Contract {
  if (!fs.existsSync(BASELINE_PATH)) {
    throw new Error(
      `缺基线：${BASELINE_PATH}\n` +
        '生成它（并把这个文件的 diff 带进评审）：node scripts/update-cli-contract-baseline.mjs'
    )
  }
  return JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')) as Contract
}

/**
 * 「零差异」那条比的是**本次运行开始时**的那份字节：
 * 若有人（或某条用例）在运行中间改写了基线，这里读到的才是"跑之前的事实"。
 */
function readBaselineAtStart(): Contract {
  if (BASELINE_AT_START === null) {
    throw new Error(
      `缺基线：${BASELINE_PATH}\n` +
        '生成它（并把这个文件的 diff 带进评审）：node scripts/update-cli-contract-baseline.mjs'
    )
  }
  return JSON.parse(BASELINE_AT_START) as Contract
}

/** 与线上同一个口径：无 TTY 一律 JSON 信封；哨兵版本号让基线不绑版本 */
const SENTINEL = '0.0.0-contract-sentinel'

describe('命令面契约基线（829ad776）', () => {
  beforeAll(() => {
    runMigrations(db)
  })

  it('三份契约与基线零差异', async () => {
    const current = await computeContract(SENTINEL, ':memory:')

    if (UPDATE) {
      fs.writeFileSync(BASELINE_PATH, JSON.stringify(current, null, 2) + '\n', 'utf8')
      // 写进去的必须就是刚算出来的那份（不然"更新成功"是句空话）
      const written = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')) as Contract
      expect(diffContract(written, current), '刚写下的基线读回来必须零差异').toEqual([])
      console.log(
        `[契约基线] 已更新 ${path.relative(process.cwd(), BASELINE_PATH)}：` +
          `schema ${current.schema.order.length} 条 / help ${current.help.order.length} 条 / mcp ${current.mcp.order.length} 个工具`
      )
      return
    }

    const diffs = diffContract(readBaselineAtStart(), current)
    expect(
      diffs,
      '命令面契约变了。这是**外部契约**，改之前先确认是有意的；确认后跑 ' +
        '`node scripts/update-cli-contract-baseline.mjs` 刷新基线，并把 diff 带进评审。'
    ).toEqual([])
  })

  it('契约不随运行时事实变化（版本 / 库路径）', async () => {
    const a = await computeContract('0.0.0-contract-a', ':memory:')
    const b = await computeContract('9.9.9-contract-b', 'C:/另一台机器/别的库.db')
    expect(
      JSON.stringify(b),
      '契约里混进了版本号或库路径 —— 这份基线就没法跟着发版走（每版必红），快把它摘出去'
    ).toBe(JSON.stringify(a))
  })

  it('没显式更新时，基线文件一个字节都不许改', () => {
    if (UPDATE) return
    expect(fs.readFileSync(BASELINE_PATH, 'utf8'), '普通测试运行改写了基线').toBe(BASELINE_AT_START)
  })
})

describe('反向验证：这套差异判定看得见变化（不是恒绿）', () => {
  /** 拿基线当"当前值"，再按各种改法弄脏一份副本 */
  const clone = (c: Contract): Contract => JSON.parse(JSON.stringify(c)) as Contract
  let base: Contract
  beforeAll(() => {
    base = readBaselineFile()
  })

  it('原样比对：零差异（先证明判据不是"永远报红"）', () => {
    expect(diffContract(base, clone(base))).toEqual([])
  })

  it('① 两条命令顺序对调 ⇒ 点名具体位置', () => {
    const cur = clone(base)
    const i = 10
    const a = cur.schema.order[i]
    cur.schema.order[i] = cur.schema.order[i + 1]
    cur.schema.order[i + 1] = a
    cur.help.order = [...cur.schema.order]
    const diffs = diffContract(base, cur)
    expect(diffs.join('\n'), '顺序对调必须红').toContain(`第 ${i + 1} 位`)
    expect(diffs.join('\n')).toContain(a)
  })

  it('② 单条命令的 help 变了 ⇒ 点名那条命令', () => {
    const cur = clone(base)
    const name = cur.help.order[7]
    cur.help.entries[name] = sha('被改过的帮助文本')
    const diffs = diffContract(base, cur)
    expect(diffs.join('\n')).toContain(`「${name}」的内容变了`)
  })

  it('③ 少一条命令、多一个工具 ⇒ 各自点名', () => {
    const cur = clone(base)
    const gone = cur.schema.order.pop() as string
    delete cur.schema.entries[gone]
    cur.help.order = [...cur.schema.order]
    delete cur.help.entries[gone]
    cur.mcp.order.push('凭空多出来的工具')
    const diffs = diffContract(base, cur)
    const text = diffs.join('\n')
    expect(text).toContain('少了 1 个')
    expect(text).toContain(gone)
    expect(text).toContain('凭空多出来的工具')
  })

  it('④ 逐条都对得上、整份不同 ⇒ 指出是信封那一层', () => {
    const cur = clone(base)
    cur.schema.envelope = sha('另一个信封')
    const diffs = diffContract(base, cur)
    expect(diffs.join('\n')).toContain('变的是信封本身')
  })
})
