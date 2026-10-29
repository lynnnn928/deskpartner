/**
 * `batch` 单行结果的体积上界（1.0.107，修 `a7f94301`）
 *
 * ## 它治的病
 *
 * 行结果是把子命令的 `Outcome` 原样摊平进 `results`，于是 records 里写一条
 * `{"cmd":"telemetry export"}` 就能让一次 `batch` 调用回 **546,868 字节**
 * （2026-10-20 实测：一行里 1143 条记录）。`7e321f6d` 给"逐行输出的**工具**"兜过
 * 默认条数上界，但那一跳挂在**工具的入参**上，而 batch 的参数是**命令** ——
 * 同一条病的第二条路。
 *
 * ## 本文件盯的两条底线
 *
 * ① **截断必须可见**：被截断的行带 `truncated: true` 与 `total` / `returned` / `bytes`
 *    —— 调用方据此知道还有多少没看到。静默截断比不截断更坏（它会得出"就这么多"）。
 * ② **截断只动数据，不动成败**：`ok` / `code` / `exitCode` 一个都不许变 ——
 *    按 `exitCode` 分流的调用方读到的必须还是同一件事（`e209441e` 统一的正是这个）。
 *
 * 另外钉住**反向**：没超上界的行原样返回，形状与直连一致（数组仍是数组）。
 *
 * ⚠️ 1.0.108 起 batch 会给逐行输出类命令补上**默认条数**（`a7f94301` 的驳回），
 * 所以本文件的记录一律**显式写 `--limit 0`（全量）**：它们要造的是"超大的一行"，
 * 而那条默认口径本身由 `batch-default-limit-a7f94301.test.ts` 盯。
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '../../../src/main/database/migrations'
import { TodoRepository } from '../../../src/main/database/todo.repository'
import { CategoryRepository } from '../../../src/main/database/category.repository'
import { ProjectRepository } from '../../../src/main/database/project.repository'
import { BATCH_LINE_LIMIT, BATCH_TOTAL_LIMIT, executeOne } from '../../../src/main/cli/commands'
import { formatOutcome } from '../../../src/main/cli/output'

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

/** 埋点导出是"逐行输出、可能很长"的主要形状：这里由夹具决定它回多少条 */
let telemetryRows: unknown[] = []

/**
 * 夹具沿用 `batch-envelope-contract.test.ts` 的形状：human 交互身份
 * （写命令不过门禁，本文件要验的是信封体积与形状，不是权限），
 * 断言打在**最终输出层**（`formatOutcome` 的 stdout）而不是中间对象 ——
 * 中间对象对了、调用方拿到的信封里没有，只测中间对象会假绿。
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
      telemetry: { record: () => {}, stats: () => null, clear: () => 0, query: () => telemetryRows }
    },
    meta: {
      version: '1.0.107',
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
  projectRepo.create({ name: '体积上界测试项目' })
  telemetryRows = []
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
      }
    },
    bytes: Buffer.byteLength(formatted.stdout, 'utf8')
  }
}

/** 造 n 条埋点记录（形状贴近真实导出：一行一条的 JSON 对象） */
function events(n: number): unknown[] {
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

/** 一行结果里 data 的形状 */
type LineData = { truncated?: boolean; bytes?: number; total?: number; returned?: number; records?: unknown[]; preview?: string; note?: string }

describe('batch 单行结果的体积上界（a7f94301）', () => {
  it('没超上界的行原样通过：data 仍是数组，不带任何截断标记', async () => {
    telemetryRows = events(3)
    const { envelope } = await runBatch([{ cmd: 'telemetry export', args: { '--limit': 0 } }])
    const line = envelope.data.results[0]
    expect(line.ok).toBe(true)
    expect(
      Array.isArray(line.data),
      '小结果的形状必须与直连一致（数组还是数组）—— 这是"不涉及导出类命令的行为不变"'
    ).toBe(true)
    expect(line.data).toEqual(telemetryRows)
    expect((line.data as LineData).truncated, '没超上界就不该出现截断标记').toBeUndefined()
  })

  it('超上界的数组行：按条留到预算内，并给出 total/returned/bytes', async () => {
    telemetryRows = events(2000)
    const { envelope, bytes } = await runBatch([{ cmd: 'telemetry export', args: { '--limit': 0 } }])
    const line = envelope.data.results[0]
    const data = line.data as LineData

    expect(data.truncated, '一条导出命令就能把回执撑到 54 万字节 —— 必须带可见标记').toBe(true)
    expect(data.total, 'total 是"本来有多少"').toBe(2000)
    expect(data.returned, '一条都没留下 = 上界等于"什么都看不了"').toBeGreaterThan(0)
    expect(data.returned, 'returned 必须小于 total —— 否则这不是截断').toBeLessThan(2000)
    expect(data.records, '留的是记录本身，不是另一套形状').toHaveLength(data.returned!)
    expect(data.records![0], '留下的是**前几条原始记录**，顺序不变').toEqual(telemetryRows[0])
    expect(data.bytes, 'bytes 报的是截断前的真实体积').toBeGreaterThan(BATCH_LINE_LIMIT)
    expect(data.note, '得说清"怎么看全量"').toContain('--limit')

    // 这一行**真的**落回上界内（不是"大概"）
    expect(
      Buffer.byteLength(JSON.stringify(line, null, 2), 'utf8'),
      '行的体积必须真的落回上界内 —— 否则上界只是个数'
    ).toBeLessThanOrEqual(BATCH_LINE_LIMIT)

    /**
     * 判据落地的那一条：**调用方真拿到的那份回执**（信封 + 这一行）也有上界。
     * 信封自己那几十字节另算，所以留 1KB 余量 —— 但要能挡住"量小了 27%"那种错
     * （单独量这一行会给出一个比真实输出小得多的数）。
     */
    expect(
      bytes,
      '整批回执（信封 + 一行）必须落回上界附近 —— 这才是调用方看到的体积'
    ).toBeLessThanOrEqual(BATCH_LINE_LIMIT + 1024)

    // ② 截断只动数据，不动成败
    expect(line.ok).toBe(true)
    expect(line.code).toBe('ok')
    expect(line.exitCode).toBe(0)
  })

  it('data 不是数组（大对象）时：留预览与体积，并带标记', async () => {
    // `schema` 的 data 是一整份命令表（约 79KB）—— 真实存在的大对象形状
    const { envelope } = await runBatch([{ cmd: 'schema' }])
    const line = envelope.data.results[0]
    const data = line.data as LineData
    expect(line.ok).toBe(true)
    expect(data.truncated).toBe(true)
    expect(data.bytes).toBeGreaterThan(BATCH_LINE_LIMIT)
    expect(data.preview, '非数组只能给预览，但必须给').toBeTruthy()
    expect(data.records, '非数组不该凭空造出 records').toBeUndefined()
    expect(Buffer.byteLength(JSON.stringify(line, null, 2), 'utf8')).toBeLessThanOrEqual(
      BATCH_LINE_LIMIT
    )
  })

  it('单条记录本身就超过上界时：一条也不留，但总量与原因都说清楚', async () => {
    telemetryRows = [{ huge: 'x'.repeat(BATCH_LINE_LIMIT * 2) }]
    const { envelope } = await runBatch([{ cmd: 'telemetry export', args: { '--limit': 0 } }])
    const data = envelope.data.results[0].data as LineData
    expect(data.truncated).toBe(true)
    expect(data.total).toBe(1)
    expect(data.returned, '留不下就该是 0，而不是硬塞一条把上界顶穿').toBe(0)
    expect(data.note, '要说明为什么一条都没留').toContain('单条记录本身就超过上界')
  })

  /**
   * 两层上界（1.0.108）：**单行** 64KB 与**整批** 256KB。
   *
   * 两条大记录各被单行上界截到 ≈64KB，合起来（≈128KB）仍在整批上界之内 ——
   * 所以这里既看得到"每行都被截断"，也看得到"整批没被切"。
   * 整批真的被切是 `batch-default-limit-a7f94301.test.ts` 那条用例（6 行）。
   */
  it('单行上界与整批上界是两层：两条大记录各被截断，整批仍落在总量上界内', async () => {
    telemetryRows = events(2000)
    const { envelope, bytes } = await runBatch([
      { cmd: 'telemetry export', args: { '--limit': 0 } },
      { cmd: 'telemetry export', args: { '--limit': 0 } }
    ])
    expect(envelope.data.results).toHaveLength(2)
    for (const line of envelope.data.results) {
      expect((line.data as LineData).truncated).toBe(true)
    }
    expect(envelope.data.truncated, '两行还没到整批上界，不该被切').toBeUndefined()
    expect(
      bytes,
      '两行的回执该是"两个单行上界"，不是"两份全量导出"（改前是 2 × 546,868）'
    ).toBeLessThanOrEqual(2 * (BATCH_LINE_LIMIT + 1024) + 1024)
    expect(bytes, '也不能越过整批上界').toBeLessThan(BATCH_TOTAL_LIMIT)
  })

  it('上界本身是个正数、且小到能解释（结构闸门）', () => {
    expect(BATCH_LINE_LIMIT, '上界必须是个正数').toBeGreaterThan(0)
    expect(
      BATCH_LINE_LIMIT,
      '上界大过 1MB 就等于没设 —— 一次工具调用的结果直接进宿主上下文'
    ).toBeLessThan(1024 * 1024)
    expect(
      BATCH_TOTAL_LIMIT,
      '整批上界必须比单行上界大：不然第一条大记录就注定"已执行、数据不回"'
    ).toBeGreaterThan(BATCH_LINE_LIMIT)
  })
})
