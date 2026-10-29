import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '../../../src/main/database/migrations'
import { TodoRepository } from '../../../src/main/database/todo.repository'
import { CategoryRepository } from '../../../src/main/database/category.repository'
import { ProjectRepository } from '../../../src/main/database/project.repository'
import { AgentRepository } from '../../../src/main/database/agent.repository'
import { executeOne } from '../../../src/main/cli/commands'

const db = new Database(':memory:')
vi.mock('../../../src/main/database/index', () => ({ getDatabase: () => db }))

/**
 * ⚠️ 拦掉「写真实凭据文件」（commands.test.ts 顶部记过的坑）。
 * 本文件的写命令走 interactive 通路到不了凭据分支，但 mock 掉是零成本的保险 ——
 * 一旦哪天门禁路径变了，代价是测试污染真实磁盘凭据，且症状延迟到下次真实调用才出现。
 */
vi.mock('../../../src/cli/credentials', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/cli/credentials')>()
  return { ...actual, writeCredential: vi.fn() }
})

const todoRepo = new TodoRepository()
const categoryRepo = new CategoryRepository()
const projectRepo = new ProjectRepository()
const agentRepo = new AgentRepository()

const ACTOR = 'agent:probe'
const ALL_SEVEN = [
  'proposed',
  'todo',
  'in_progress',
  'suspended',
  'awaiting_review',
  'done',
  'discarded'
] as const

const ctx = {
  deps: {
    todoRepo,
    categoryRepo,
    projectRepo,
    memoRepo: { list: () => [] },
    settingsRepo: { get: () => ({}) },
    agentRepo,
    events: { append: () => {} },
    telemetry: { record: () => {} }
  },
  meta: { version: 'test', dbPath: ':memory:', schemaVersion: 25, via: 'pipe' },
  interactive: true,
  actor: ACTOR
}

/**
 * 「全量」和「指派给你」两个口径不能说谎（`2e8dfa6d`，选①）
 *
 * 背景（1.0.73 实测）：G9 回执 notice 写「有 20 条待办指派给你」，标题里混着
 * 已丢进「已废弃」的探针卡；而同条件的 `todo list --executed-by <actor>` 只回个位数。
 * 提醒把已废弃的卡算成"等你做"，数量放大约六倍 —— **两个数字都进了 agent 的判断**。
 *
 * 拍板口径（选项①）：
 * - `--status any` = 真全量（七列全含，含 suspended/discarded/done）；
 * - `--status open`（旧名 unfinished，同一集合）= 未完成四列 = **默认**：
 *   proposed/todo/in_progress/awaiting_review，排除 done/suspended/discarded；
 * - 提醒计数与 `--executed-by` 过滤走**同一个查询函数、同一套默认列**，
 *   与同条件 list 查询条数**逐字一致**。
 *
 * ## 反向验证：不修时怎么红
 *
 * - **②红**：修前默认 = STATUSES 减 done（**含** suspended/discarded）——
 *   默认返回里 probe-suspended / probe-discarded 都在，两条断言当场失败。
 * - **③红**：修前提醒侧手写过滤（排 done/suspended 却**含 discarded**）、
 *   且计数报的是"从上列去重后"的条数。本夹具里修前提醒数 = 5
 *   （四列 open + 1 张 discarded），同条件 list 默认 = 6（修前默认含 suspended+discarded）
 *   —— 5 ≠ 6，失败。
 * - **①修前即绿**：`--status any` 自 1.0.63 起就跳过状态过滤，卡上
 *   「any 只给到两列」是 `--executed-by agent:bob` 名下 suspended/discarded
 *   **恰好 0 行**的假象（逐条 `--status discarded/--status suspended` 配
 *   `--executed-by` 实测均为 0）。①锁的是契约，防止将来把 any 收窄成
 *   「unfinished ∪ done」那种"名字叫全量、返回缺两列"的写法回潮。
 */
describe('any 真全量、open 默认列、提醒计数同源（2e8dfa6d）', () => {
  beforeAll(() => {
    runMigrations(db)
    db.pragma('foreign_keys = OFF')
    agentRepo.register({ id: ACTOR, displayName: '探针' })
  })

  beforeEach(() => {
    db.prepare('DELETE FROM todos').run()
    db.prepare('DELETE FROM todo_transitions').run()
    db.prepare('DELETE FROM categories').run()
    db.prepare('DELETE FROM projects').run()
    new CategoryRepository().create({ name: '默认', color: '#111', sortOrder: 0 })
    new ProjectRepository().create({ name: 'P' })
    // 七列各一张、全部显式指派给 ACTOR —— 一张卡一列，丢哪列都看得出来
    for (const s of ALL_SEVEN) {
      todoRepo.create({
        title: `probe-${s}`,
        status: s,
        executedBy: ACTOR,
        projectId: null,
        categoryIds: []
      } as never)
    }
    // 对照组两张：别人名下的 discarded、没有显式指派的（提出即执行）——
    // "同条件"必须只数 ACTOR 名下的，拿全库对数会把巧合当通过
    todoRepo.create({
      title: '别的 agent 的',
      status: 'discarded',
      executedBy: 'agent:other',
      projectId: null,
      categoryIds: []
    } as never)
    todoRepo.create({
      title: '提出即执行的',
      status: 'todo',
      executedBy: null,
      projectId: null,
      categoryIds: []
    } as never)
  })

  const list = async (args: string[]) => {
    const r = await executeOne(ctx as never, ['todo', 'list', ...args])
    expect(r.ok, JSON.stringify(r)).toBe(true)
    return r as never as {
      data: Array<{ id: string; status: string; title: string }>
      meta: Record<string, unknown>
    }
  }

  it('① --status any 是真全量：suspended 与 discarded 行必须在返回里', async () => {
    const r = await list(['--status', 'any'])
    const statuses = new Set(r.data.map((t) => t.status))
    expect(statuses.has('suspended'), 'any 少了 suspended 行 —— 名字叫 any 就不能缺列').toBe(true)
    expect(statuses.has('discarded'), 'any 少了 discarded 行 —— 名字叫 any 就不能缺列').toBe(true)
    // byStatus 是"看板全貌"的取数处，七列都要在场（0 行的列给 0，而不是消失）
    const byStatus = r.meta.byStatus as Record<string, number>
    expect(Object.keys(byStatus).sort()).toEqual([...ALL_SEVEN].sort())
  })

  it('② 默认即 open：suspended/discarded 不进默认列，且与 --status open 同口径', async () => {
    const def = await list([])
    const titles = def.data.map((t) => t.title)
    expect(titles, '已暂停/已废弃不是"等你做"，不许进默认列').not.toContain('probe-suspended')
    expect(titles).not.toContain('probe-discarded')
    expect(titles).not.toContain('probe-done')

    const defIds = def.data.map((t) => t.id).sort()
    const open = await list(['--status', 'open'])
    expect(open.data.map((t) => t.id).sort(), '--status open 必须与默认同一个口径').toEqual(defIds)
    // 旧名 unfinished 是 open 的别名 —— 不许出现两个"未完成"各数各的
    const unfin = await list(['--status', 'unfinished'])
    expect(unfin.data.map((t) => t.id).sort(), 'unfinished 是 open 的旧名，必须同一个集合').toEqual(defIds)

    // 逐行核对默认列的内容：四列 probe 各一张 + 对照组的"提出即执行"（todo 列）
    expect(def.meta.matched).toBe(5)
  })

  it('③ 提醒计数与同条件 list 查询条数逐字一致', async () => {
    // 任一写命令的回执收尾都会带 G9 的「指派给你」摘要 —— 用 todo add 触发一次
    const w = await executeOne(ctx as never, [
      'todo',
      'add',
      '--title',
      '触发回执用的一条',
      '--status',
      'todo',
      '--project',
      'P'
    ])
    expect(w.ok, JSON.stringify(w)).toBe(true)
    const notice = String((w as { notice?: string }).notice ?? '')
    const inNotice = Number(/有 (\d+) 条待办指派给你/.exec(notice)?.[1] ?? NaN)
    expect(Number.isNaN(inNotice), `回执里没有「指派给你」计数，实际 notice：${notice}`).toBe(false)

    const mine = await list(['--executed-by', ACTOR])
    expect(
      inNotice,
      '提醒数与同条件 list 查询条数必须逐字一致 —— 数字会进 agent 的判断，对不上比不报更糟'
    ).toBe(mine.meta.matched)
    // 同一数字的第三处对照：显式 open 口径（"同条件"的字面写法）
    const mineOpen = await list(['--executed-by', ACTOR, '--status', 'open'])
    expect(inNotice, '提醒数 = list --executed-by <actor> --status open 的条数').toBe(mineOpen.meta.matched)
  })

  it('defaultScope 的话要与真实口径一致（说出口的话不能漂）', async () => {
    const r = await list([])
    const scope = String(r.meta.defaultScope ?? '')
    expect(scope).toContain('已排除 done')
    expect(scope).toContain('--status any')
    // 1.0.74 起默认还排了这两列 —— 文案不点名，按文案推算的数就错了（2e8dfa6d）
    expect(scope, '默认排掉的列要在文案里点名').toContain('suspended')
    expect(scope).toContain('discarded')
  })
})
