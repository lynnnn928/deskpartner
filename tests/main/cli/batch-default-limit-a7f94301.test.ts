/**
 * `batch` 里的**默认条数口径**与**整批总量上界**（1.0.108，修 `a7f94301` 的驳回）
 *
 * ## 驳回点（bob 实测）
 *
 * 同一条 `telemetry export`：单独走 MCP 是 **21,355 字节**（默认已收敛，`7e321f6d` 通过），
 * 放进 batch 的 records 里是 **66,113 字节**（显式传 `--limit 50` 才降到 25,496）。
 * 也就是说"默认有界"这件事在 batch 这条路上**失效** —— 宿主只要把一批命令塞进 batch，
 * 就能绕过所有单命令的默认收敛。
 *
 * 本文件盯两件事：
 *
 * ① **batch 的行结果按命令各自的默认口径执行**：没在 args 里写 `--limit` 的逐行输出类命令，
 *    由 batch 补齐**同一个默认**（推导只有一份：`rowLimitDefault`，MCP handler 读的也是它），
 *    并在行结果里用 `appliedDefaults` 标出来 —— 不许调用方把"默认那一截"当成全部。
 *    通过判据就是驳回里那句：**一条不带 limit 的 telemetry export 在 batch 里的体积
 *    与单独调用同级（±20%）**。
 * ② **整批有总量上界**：到了就停（剩余记录**没有执行**，信封带 `truncated` / `skipped`），
 *    越过预算的那一行"已执行但数据不回"—— 扣数据不扣成败。
 *
 * 反向也钉住：显式写了 `--limit`（含 `0` = 全量）的记录**一个字节都不改**，
 * 非逐行输出类命令不受这套默认的影响（那是另一条判据）。
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '../../../src/main/database/migrations'
import { TodoRepository } from '../../../src/main/database/todo.repository'
import { CategoryRepository } from '../../../src/main/database/category.repository'
import { ProjectRepository } from '../../../src/main/database/project.repository'
import { BATCH_TOTAL_LIMIT, executeOne } from '../../../src/main/cli/commands'
import { formatOutcome } from '../../../src/main/cli/output'
import { DEFAULT_ROW_LIMIT, rowLimitDefault } from '../../../src/cli/mcp-tools-from-schema'
import { generateMcpTools } from '../../../src/cli/mcp-tools-from-schema'
import { commands } from '../../../src/main/cli/commands'
import { z } from 'zod'

const db = new Database(':memory:')
vi.mock('../../../src/main/database/index', () => ({
  getDatabase: () => db
}))

/** 拦掉"写真实凭据文件"那一步（与 `batch-envelope-contract.test.ts` 同因） */
vi.mock('../../../src/cli/credentials', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/cli/credentials')>()
  return { ...actual, writeCredential: vi.fn() }
})

const todoRepo = new TodoRepository()
const categoryRepo = new CategoryRepository()
const projectRepo = new ProjectRepository()

/** 夹具库里的埋点；导出命令按 limit 取"最新 N 条"（`--oldest` 不传时取尾部），这里简化成尾部切片 */
let telemetryRows: unknown[] = []
/** 最后一次 query 的入参 —— 断言"batch 到底给命令传了什么" */
let lastQuery: { limit?: number; order?: string } = {}

/**
 * 夹具沿用 `batch-envelope-contract.test.ts` 的形状：human 交互身份
 * （本文件验的是体积与口径，不是权限），断言打在**最终输出层**
 * —— 中间对象对了、调用方拿到的信封里没有，只测中间对象会假绿。
 */
function makeCtx(over: Record<string, unknown> = {}) {
  return {
    deps: {
      todoRepo,
      categoryRepo,
      projectRepo,
      memoRepo: { list: () => [], add: () => ({ id: 'm1' }), get: () => null },
      settingsRepo: { get: () => ({}) },
      agentRepo: {
        get: () => null,
        list: () => [],
        touch: () => null,
        markWrite: () => null,
        listGrants: () => [],
        findUsableGrant: () => null,
        findAnyUsableGrant: () => null,
        findLatestGrant: () => null,
        consumeGrant: () => null
      },
      events: { append: () => {} },
      telemetry: {
        record: () => {},
        stats: () => null,
        clear: () => 0,
        /**
         * **必须真的按 limit 收窄**：这一卡治的就是"默认口径有没有生效"，
         * 夹具若不认 limit，断言就会在两个都"全量"的路径上假绿。
         */
        query: (q: { limit?: number; order?: string }) => {
          lastQuery = { limit: q?.limit, order: q?.order }
          const ordered = q?.order === 'oldest' ? telemetryRows : [...telemetryRows].reverse()
          return typeof q?.limit === 'number' && q.limit > 0 ? ordered.slice(0, q.limit) : ordered
        }
      }
    },
    meta: {
      version: '1.0.108',
      dbPath: ':memory:',
      schemaVersion: 45,
      busyTimeoutMs: 5000,
      channels: ['headless'],
      via: 'headless',
      startedAt: 0
    },
    interactive: true,
    actor: 'human',
    ...over
  } as never
}

beforeAll(() => {
  runMigrations(db)
  db.pragma('foreign_keys = OFF')
})

beforeEach(() => {
  db.prepare('DELETE FROM todo_categories').run()
  db.prepare('DELETE FROM todos').run()
  db.prepare('DELETE FROM projects').run()
  db.prepare('DELETE FROM categories').run()
  projectRepo.create({ name: '批量默认口径测试项目' })
  telemetryRows = []
  lastQuery = {}
})

/** 跑一批 records，读**最终输出层**的信封 */
async function runBatch(records: unknown[]) {
  const ctx = makeCtx({ stdin: records.map((r) => JSON.stringify(r)).join('\n') })
  const outcome = await executeOne(ctx, ['batch'])
  const formatted = formatOutcome(outcome, ['batch'], false)
  return {
    envelope: JSON.parse(formatted.stdout) as {
      ok: boolean
      data: {
        total: number
        failed: number
        results: Record<string, unknown>[]
        truncated?: boolean
        skipped?: number
        bytes?: number
        limitBytes?: number
        note?: string
      }
    },
    bytes: Buffer.byteLength(formatted.stdout, 'utf8')
  }
}

/**
 * 一条直连调用（与 MCP handler 兜上默认之后的 argv 等价），走到**最终输出层**。
 *
 * 逐行输出的命令直连时吐的是**纯 NDJSON**（没有信封），而 MCP 侧正是把这些行
 * 聚成 `records` 数组回给宿主 —— 所以这里也照那条路把行解析回来，
 * 拿到的就是"单独调用时宿主看到的那份数据"。
 */
async function runDirect(args: string[]) {
  const ctx = makeCtx({})
  const outcome = await executeOne(ctx, args)
  const formatted = formatOutcome(outcome, args, false)
  const records = formatted.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as unknown)
  return { records, bytes: Buffer.byteLength(formatted.stdout, 'utf8') }
}

/** 造 n 条埋点记录（形状贴近真实导出：一行一条的 JSON 对象） */
function events(n: number): Array<Record<string, unknown>> {
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    ts: `2026-10-20T10:${String(Math.floor(i / 60) % 60).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}Z`,
    sessionId: `s-${i}`,
    actor: 'human',
    surface: 'kanban',
    category: 'todo',
    event: `todo.update.${i}`,
    ok: true,
    durationMs: 1,
    props: { i }
  }))
}

/** 真实埋点规模（bob 实测那台机器上是 1143 条） */
const REAL_EVENTS = 1143

type LineData = { truncated?: boolean; bytes?: number; total?: number; returned?: number; note?: string }

describe('batch 的默认条数口径与整批总量上界（a7f94301 驳回）', () => {
  /**
   * 结构闸门：**默认口径只有一份推导**。
   *
   * batch 与 MCP handler 都必须读 `rowLimitDefault`。任何一方自己写一个数字
   * （哪怕是同一个 50）都是"第二套判据"—— 而这一卡的病根就是"两处补法"。
   */
  it('默认上界的推导只有一处：命令声明 → 同一个函数 → 工具说明与 batch', () => {
    const cmd = commands.find((c) => c.name === 'telemetry export')!
    const derived = rowLimitDefault(cmd)
    expect(derived, '逐行输出 + 有 --limit 的命令必须能推导出默认上界').toEqual({
      flag: '--limit',
      value: DEFAULT_ROW_LIMIT
    })

    // 工具说明里写的数必须就是推导出来的数（说出口的上限 = 生效的上限）
    const tools = generateMcpTools(
      [
        {
          name: 'telemetry export',
          desc: cmd.desc,
          readOnly: true,
          output: 'ndjson',
          args: (cmd.args ?? []).map((a) => ({ flag: a.flag, type: a.type, desc: a.desc }))
        }
      ] as never,
      z
    )
    const limit = tools.find((t) => t.name === 'export_telemetry')!.input.limit as {
      description?: string
    }
    expect(limit.description, '说明里的默认值必须来自同一份推导').toContain(
      `默认 ${derived!.value} 条`
    )

    // 反向：非逐行输出、或没有 --limit 的命令一律推不出默认（不缺也不多给）
    expect(rowLimitDefault({ output: 'json', args: [{ flag: '--limit' }] })).toBeNull()
    expect(rowLimitDefault({ output: 'ndjson', args: [] })).toBeNull()
  })

  /**
   * 驳回点的**通过判据**：records 里放一条不带 limit 的 `telemetry export`，
   * 返回体积与单独调用同级（±20%）。
   */
  it('记录里不写 --limit 时：batch 按默认口径跑，体积与单独调用同级（±20%）', async () => {
    telemetryRows = events(REAL_EVENTS)

    const { envelope, bytes } = await runBatch([{ cmd: 'telemetry export' }])
    const line = envelope.data.results[0]

    expect(lastQuery.limit, 'batch 没有替它补上默认 —— 命令就按"全量"跑').toBe(DEFAULT_ROW_LIMIT)
    expect(
      line.appliedDefaults,
      '补了默认却不说：调用方会把"默认那一截"当成全部（与静默截断同一条底线）'
    ).toEqual({ '--limit': DEFAULT_ROW_LIMIT })
    expect((line.data as unknown[]).length, '行数据该是默认条数，不是全量').toBe(DEFAULT_ROW_LIMIT)

    // 单独调用（= MCP handler 兜上默认之后的 argv）
    const direct = await runDirect(['telemetry export', `--limit=${DEFAULT_ROW_LIMIT}`])
    expect(direct.records.length, '单独调用拿到的就该是默认条数').toBe(DEFAULT_ROW_LIMIT)

    /**
     * 判据落在**数据本身**的体积上（两边都在"宿主看到的那份数组"这一层）：
     * 直连那次要经 MCP handler 聚成 records，所以拿它比才对得上。
     * 差额只剩信封/字段名那几十字节 —— 真放行了全量的话，这个比值会是 20 倍以上。
     */
    const batchPayload = Buffer.byteLength(JSON.stringify(line.data), 'utf8')
    const directPayload = Buffer.byteLength(JSON.stringify(direct.records), 'utf8')
    const ratio = batchPayload / directPayload
    expect(
      ratio,
      `batch 行数据 ${batchPayload} 字节 vs 单独调用 ${directPayload} 字节` +
        `（整份回执 ${bytes} vs ${direct.bytes}）—— 超出 ±20% 就是"batch 绕过了默认"`
    ).toBeGreaterThan(0.8)
    expect(ratio).toBeLessThan(1.2)
    /**
     * 再钉一条**量级**：拿"显式要全量"那条路做对照 ——
     * 默认没生效的话，batch 的回执就是那个量级（46 万字节），而不是这一行的几十 KB。
     */
    const full = await runDirect(['telemetry export', '--limit=0'])
    expect(full.records.length, '对照组：--limit 0 确实拿到全量').toBe(REAL_EVENTS)
    expect(
      bytes,
      `整份回执 ${bytes} 字节 vs 全量那条路的 ${full.bytes} 字节 —— 没绕开默认就该小一个量级`
    ).toBeLessThan(full.bytes / 4)
  })

  it('显式写了 --limit 的记录一个字节都不改（含 0 = 全量）', async () => {
    telemetryRows = events(REAL_EVENTS)

    const { envelope } = await runBatch([
      { cmd: 'telemetry export', args: { '--limit': 7 } },
      { cmd: 'telemetry export', args: { '--limit': 0 } }
    ])
    const [seven, zero] = envelope.data.results

    expect((seven.data as unknown[]).length, '显式的条数必须优先').toBe(7)
    expect(seven.appliedDefaults, '没补就不该有标记').toBeUndefined()
    expect((zero.data as { total?: number }).total, '--limit 0 = 全量：batch 不许替它收窄').toBe(
      REAL_EVENTS
    )
    expect(zero.appliedDefaults).toBeUndefined()
    /**
     * 显式要全量也**不是绕过**：单行上界照样落在它身上（这一条是 `boundBatchLine` 的活），
     * 所以"把命令装进 batch"永远换不来"回执由数据量决定"。
     */
    expect((zero.data as LineData).truncated, '全量那一行必须被单行上界截断').toBe(true)
  })

  it('非逐行输出类命令不受影响：batch 不碰它自己的默认', async () => {
    todoRepo.create({
      title: '一条待办',
      categoryIds: [categoryRepo.create({ name: '默认口径', color: '#1', sortOrder: 0 }).id],
      projectId: projectRepo.list()[0].id,
      priority: 'normal'
    })

    const { envelope } = await runBatch([{ cmd: 'todo list' }])
    const line = envelope.data.results[0]
    expect(line.ok, '这一条该照常执行').toBe(true)
    expect(
      line.appliedDefaults,
      'todo list 的默认条数是它**命令自己**的事（TODO_LIST_DEFAULT_LIMIT），不是 batch 补的'
    ).toBeUndefined()
  })

  it('命令名写错时不去猜默认：交给 executeOne 报未知命令', async () => {
    const { envelope } = await runBatch([{ cmd: 'telemetry exportt' }])
    const line = envelope.data.results[0]
    expect(line.ok).toBe(false)
    expect(line.errorCode).toBe('usage_error')
    expect(line.appliedDefaults).toBeUndefined()
  })

  /**
   * 整批总量上界：单行上界管不住"很多行"（1000 行 × 单行上界 = 64MB）。
   */
  it('整批超总量上界：到这里为止，剩余记录不执行，越过预算的那一行只回判定', async () => {
    telemetryRows = events(REAL_EVENTS)
    /**
     * 行数**按实测的一行多大算**，不写死：写死的那个数会随夹具（记录形状、条数）
     * 悄悄漂成"刚好没超" —— 那时这条用例会绿着，而它盯的上界其实没被走到。
     */
    const one = await runBatch([{ cmd: 'telemetry export' }])
    const rowBytes = one.bytes
    const TOTAL_ROWS = Math.ceil(BATCH_TOTAL_LIMIT / rowBytes) + 2
    const records = Array.from({ length: TOTAL_ROWS }, () => ({ cmd: 'telemetry export' }))

    const { envelope, bytes } = await runBatch(records)
    const data = envelope.data

    expect(data.truncated, '整批被切短了却不说 —— 调用方会以为都跑完了').toBe(true)
    expect(data.total).toBe(TOTAL_ROWS)
    expect(data.results.length, '后面的记录没有执行，就不该有它们的行').toBeLessThan(TOTAL_ROWS)
    expect(data.results.length, '上界也不该小到"一条都回不来"').toBeGreaterThan(1)
    expect(data.skipped, 'skipped 是"还剩几条没执行"').toBe(TOTAL_ROWS - data.results.length)
    expect(data.limitBytes).toBe(BATCH_TOTAL_LIMIT)
    expect(data.note, '得说清怎么办').toContain('拆成新的一批')

    const crossing = data.results[data.results.length - 1] as Record<string, unknown>
    const crossingData = crossing.data as LineData
    expect(crossingData.bytes, '越过预算的那一行报的是它自己的体积').toBeGreaterThan(0)
    expect(
      crossingData.note,
      '已执行的部分必须说出来（否则调用方重发就会做两遍）'
    ).toContain('本行已执行')
    expect(crossing.ok, '扣的是数据，不是成败').toBe(true)
    expect(crossing.exitCode).toBe(0)

    expect(
      bytes,
      `实际回执 ${bytes} 字节 —— 超过"总量上界 + 一行 + 信封"就说明这一刀没落下去`
    ).toBeLessThanOrEqual(BATCH_TOTAL_LIMIT + 4096)
  })

  it('整批上界本身：比单行上界大、又小到能解释（结构闸门）', () => {
    expect(BATCH_TOTAL_LIMIT, '上界必须是正数').toBeGreaterThan(0)
    expect(
      BATCH_TOTAL_LIMIT,
      '整批上界小于单行上界的话，第一条大记录就注定要"已执行不回数据"'
    ).toBeGreaterThan(64 * 1024)
    expect(
      BATCH_TOTAL_LIMIT,
      '整批大过 1MB 就等于没设 —— 一次工具调用的结果直接进宿主上下文'
    ).toBeLessThan(1024 * 1024)
  })
})
