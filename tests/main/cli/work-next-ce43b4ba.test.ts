import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '../../../src/main/database/migrations'
import { TodoRepository } from '../../../src/main/database/todo.repository'
import { CommentRepository } from '../../../src/main/database/comment.repository'
import { CategoryRepository } from '../../../src/main/database/category.repository'
import { ProjectRepository } from '../../../src/main/database/project.repository'
import { NotificationRepository } from '../../../src/main/database/notification.repository'
import { ReminderReceiptRepository } from '../../../src/main/database/reminder-receipt.repository'
import { RulesRepository } from '../../../src/main/database/rules.repository'
import { ProtocolRepository } from '../../../src/main/database/protocol.repository'
import { ProfileRepository } from '../../../src/main/database/profile.repository'
import { executeOne } from '../../../src/main/cli/commands'
import { formatOutcome } from '../../../src/main/cli/output'
import { commands } from '../../../src/main/cli/command-table'
import { mcpToolName, shouldExpose } from '../../../src/cli/mcp-tools-from-schema'
import { FIRST_READ_BUDGET_BYTES } from '../../../src/main/cli/response-budget'

/**
 * 卡 `ce43b4ba`：`work next` —— 回答"我现在该动什么"。
 *
 * ## 为什么这条命令值一次验收
 *
 * 独立一手记录（`1b176fcb` §4）的原话：陌生 agent 从 75 条命令里找不到"我该动什么"，
 * 每轮开工要自己拼四条命令，第一次接手会直接停住。能力都在，缺的是**按身份排好的那一份**。
 *
 * ## 本文件钉五件事
 *
 * ① **按主体**：agent 与人看到的是不同的"该动"（人拍板、人验收；agent 干活、不代替拍板）；
 * ② **不越权**：候选池对 agent 只进 `waiting`，永不进 `recommend`（G4 只许人挪）；
 * ③ **不猜**：未指派的单列 `available`，不冒充"指派给你"；
 * ④ **自报体量**：`budget.limitBytes` 写死 20 KB，`bytes` 是真实回执大小，超了从最不紧急的尾部丢并给 nextSteps；
 * ⑤ **出口同源**：schema / help / MCP 都能看到这条命令（工具名 `next_work`）。
 */
const db = new Database(':memory:')
vi.mock('../../../src/main/database/index', () => ({
  getDatabase: () => db
}))

vi.mock('../../../src/cli/credentials', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/cli/credentials')>()
  return { ...actual, writeCredential: vi.fn() }
})

const todoRepo = new TodoRepository()
const categoryRepo = new CategoryRepository()
const projectRepo = new ProjectRepository()

function makeCtx(actor = 'agent:tester') {
  return {
    deps: {
      todoRepo,
      categoryRepo,
      projectRepo,
      commentRepo: new CommentRepository(),
      notificationRepo: new NotificationRepository(),
      reminderReceiptRepo: new ReminderReceiptRepository(),
      rulesRepo: new RulesRepository(),
      protocolRepo: new ProtocolRepository(),
      profileRepo: new ProfileRepository(),
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
      telemetry: { record: () => {}, query: () => [], stats: () => null, clear: () => 0 }
    },
    meta: {
      version: '1.0.125',
      dbPath: ':memory:',
      schemaVersion: 46,
      busyTimeoutMs: 5000,
      channels: ['pipe'],
      via: 'pipe',
      startedAt: 0
    },
    interactive: true,
    actor
  } as never
}

async function run(args: string[], actor = 'agent:tester') {
  const outcome = await executeOne(makeCtx(actor), args)
  const { stdout } = formatOutcome(outcome, args, false)
  return JSON.parse(stdout) as {
    ok: boolean
    code?: string
    message?: string
    data?: {
      subject: string
      scope: { project: string | null }
      counts: Record<string, number>
      recommend: Array<{ todoId: string; title: string; why: string; nextStep: string }>
      available: Array<{ todoId: string; title: string }>
      waiting: Array<{ todoId: string; title: string }>
      blocked: Array<{ todoId: string; title: string }>
      budget: { limitBytes: number; bytes: number; dropped: number; truncated: boolean; overBudget: boolean }
      nextSteps: string[]
    }
  }
}

let projectA = ''
let projectB = ''
const ids: Record<string, string> = {}

beforeAll(() => {
  runMigrations(db)
})

beforeEach(() => {
  db.prepare('DELETE FROM todo_comments').run()
  db.prepare('DELETE FROM todos').run()
  db.prepare('DELETE FROM projects').run()
  db.prepare('DELETE FROM categories').run()
  categoryRepo.create({ name: '方向', color: '#5388F6', sortOrder: 0 })
  projectA = projectRepo.create({ name: '项目甲' }).id
  projectB = projectRepo.create({ name: '项目乙' }).id
  for (const key of Object.keys(ids)) delete ids[key]

  ids.verify = todoRepo.create({
    title: '等人验收的一条',
    projectId: projectA,
    status: 'awaiting_review',
    priority: 'high',
    createdBy: 'agent:worker',
    executedBy: 'agent:worker',
    verifier: 'agent:tester',
    actor: 'agent:worker'
  }).id
  ids.continuing = todoRepo.create({
    title: '进行中的一条',
    projectId: projectA,
    status: 'in_progress',
    createdBy: 'agent:tester',
    executedBy: 'agent:tester'
  }).id
  ids.assigned = todoRepo.create({
    title: '指派给我的待办',
    projectId: projectB,
    status: 'todo',
    priority: 'urgent',
    createdBy: 'human',
    executedBy: 'agent:tester'
  }).id
  ids.unassigned = todoRepo.create({
    title: '没指派的一条',
    projectId: projectB,
    status: 'todo',
    createdBy: 'human',
    executedBy: null
  }).id
  ids.proposed = todoRepo.create({
    title: '等人拍板的一条',
    projectId: projectA,
    status: 'proposed',
    type: 'feature',
    createdBy: 'human'
  }).id
  ids.suspended = todoRepo.create({
    title: '挂起的一条',
    projectId: projectA,
    status: 'suspended',
    createdBy: 'agent:tester',
    executedBy: 'agent:tester'
  }).id
  ids.done = todoRepo.create({
    title: '已经做完的一条',
    projectId: projectA,
    status: 'done',
    createdBy: 'agent:tester'
  }).id
})

describe('work next：按主体排"该动的事"（卡 ce43b4ba）', () => {
  it('出口同源：readOnly、dataShape 对象、schema 里有、MCP 叫 next_work', () => {
    const spec = commands.find((c) => c.name === 'work next')!
    expect(spec.readOnly).toBe(true)
    expect(spec.dataShape).toBe('object')
    expect(shouldExpose('work next')).toBe(true)
    expect(mcpToolName('work next')).toBe('next_work')
  })

  it('agent 视角：验收 → 进行中 → 指派；未指派单列；候选池只进 waiting；挂起进 blocked', async () => {
    const env = await run(['work', 'next'])
    expect(env.ok, env.message).toBe(true)
    const d = env.data!

    expect(d.subject).toBe('agent:tester')
    expect(d.recommend.map((i) => i.todoId)).toEqual([ids.verify, ids.continuing, ids.assigned])
    expect(d.recommend[0].why).toContain('验收')
    expect(d.recommend[0].nextStep).toContain('todo get')

    expect(d.available.map((i) => i.todoId)).toEqual([ids.unassigned])
    expect(d.waiting.map((i) => i.todoId)).toEqual([ids.proposed])
    expect(d.blocked.map((i) => i.todoId)).toEqual([ids.suspended])

    // 已完成的不出现
    const all = [...d.recommend, ...d.available, ...d.waiting, ...d.blocked].map((i) => i.todoId)
    expect(all).not.toContain(ids.done)
  })

  it('nextSteps 不再教不存在的 dp 命令，第一条说清怎么执行（卡 cb7924c2）', async () => {
    const env = await run(['work', 'next'])
    expect(env.ok).toBe(true)
    const d = env.data!

    // 引子：本机没有 dp 这条命令，子命令要用启动器跑
    expect(d.nextSteps[0]).toContain('node "$DESKPARTNER_CLI"')
    expect(d.nextSteps[0]).toContain('本机没有 `dp`')

    // 其余建议里不许再出现裸的 dp <子命令>（照抄就是一条跑不通的命令）
    expect(d.nextSteps.slice(1).join('\n')).not.toMatch(/\bdp (todo|project|skill|agent|schema)/)
    expect(d.recommend.map((i) => i.nextStep).join('\n')).not.toMatch(/\bdp (todo|project|skill|agent|schema)/)
  })

  it('人视角：候选池进"等你拍板"；等 agent 验收的单列 waiting；可领为空', async () => {
    const env = await run(['work', 'next'], 'human')
    expect(env.ok).toBe(true)
    const d = env.data!
    expect(d.subject).toBe('human')
    expect(d.recommend[0].todoId).toBe(ids.proposed)
    expect(d.recommend[0].why).toContain('等你拍板')
    expect(d.waiting.map((i) => i.todoId)).toContain(ids.verify)
    expect(d.available).toEqual([])
  })

  it('--project 只看该项目；项目不存在时是 not_found 而不是空结果', async () => {
    const env = await run(['work', 'next', '--project', '项目乙'])
    expect(env.ok).toBe(true)
    expect(env.data!.scope.project).toBe('项目乙')
    const all = [...env.data!.recommend, ...env.data!.available]
    expect(all.map((i) => i.todoId)).toEqual([ids.assigned, ids.unassigned])

    const missing = await run(['work', 'next', '--project', '不存在的项目'])
    expect(missing.ok).toBe(false)
    expect(missing.code).toBe('not_found')
  })

  it('计数：未完成总数 / 指派给我 / 候选池 / 待验收', async () => {
    const env = await run(['work', 'next'])
    const c = env.data!.counts
    expect(c.open).toBe(6)
    expect(c.mine).toBe(3)
    expect(c.proposed).toBe(1)
    expect(c.awaitingReview).toBe(1)
  })

  it('体量闸门：--limit 0 也放得下 —— 字节数不超上界，超了如实标 truncated 并给 nextSteps', async () => {
    // 造 200 条指派给本 agent 的长标题事项，总量远超 20KB
    for (let i = 0; i < 200; i++) {
      todoRepo.create({
        title: `长标题探针第 ${i} 条：${'很长的标题'.repeat(20)}`,
        projectId: projectA,
        status: 'todo',
        createdBy: 'human',
        executedBy: 'agent:tester'
      })
    }
    const env = await run(['work', 'next', '--limit', '0'])
    expect(env.ok).toBe(true)
    const b = env.data!.budget
    expect(b.limitBytes).toBe(FIRST_READ_BUDGET_BYTES)
    expect(b.bytes).toBeLessThanOrEqual(FIRST_READ_BUDGET_BYTES)
    expect(b.truncated).toBe(true)
    expect(b.dropped).toBeGreaterThan(0)
    expect(env.data!.nextSteps.join('\n'), '超预算时要说清是哪一种截断').toContain('体量预算')
  })

  it('项目接手说明落后于事实时，nextSteps 主动提示更新/复核（收工交接闭环）', async () => {
    projectRepo.saveHandoff(projectA, '# 项目甲接手说明\n初始版本', 'human', undefined, {
      version: '1.0.100'
    })
    const agentEnv = await run(['work', 'next', '--project', '项目甲'], 'agent:tester')
    expect(agentEnv.ok).toBe(true)
    expect(agentEnv.data!.nextSteps.join('\n')).toContain('handoff-propose')

    const humanEnv = await run(['work', 'next', '--project', '项目甲'], 'human')
    expect(humanEnv.ok).toBe(true)
    expect(humanEnv.data!.nextSteps.join('\n')).toContain('接手说明待复核')
  })
})
