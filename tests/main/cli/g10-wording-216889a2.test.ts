import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import Database from 'better-sqlite3'
import { runMigrations } from '../../../src/main/database/migrations'
import { TodoRepository } from '../../../src/main/database/todo.repository'
import { CategoryRepository } from '../../../src/main/database/category.repository'
import { ProjectRepository } from '../../../src/main/database/project.repository'
import { AgentRepository } from '../../../src/main/database/agent.repository'
import { NotificationRepository } from '../../../src/main/database/notification.repository'
import { CommentRepository } from '../../../src/main/database/comment.repository'
import { EventsRepository } from '../../../src/main/database/events.repository'
import { ReleaseRepository } from '../../../src/main/database/release.repository'
import { executeOne, EXIT_CODES } from '../../../src/main/cli/commands'
import { gateById } from '../../../src/main/cli/gates'

const db = new Database(':memory:')
vi.mock('../../../src/main/database/index', () => ({ getDatabase: () => db }))
/** 签发凭据会写盘（同 guard-combination-matrix 的防线），测试里只需要"持证"这层判定 */
vi.mock('../../../src/cli/credentials', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/cli/credentials')>()
  return { ...actual, writeCredential: vi.fn() }
})

/**
 * G10 的说明书与报错不许教一条已经被堵死的绕行路（卡 `216889a2`）
 *
 * ## 缺陷
 *
 * 1.0.116 把 G10 从"按边执法"改成"按身份判"（`a7ad343f`）：
 * 只要这次调用的结果是「已完成」、而调用人正是执行者，就拦 ——
 * 起点在待办 / 进行中 / 挂起 / 待验收哪一列都一样。
 *
 * 但三处**会被人和 agent 当真**的文字没跟着改，还在教"别先进待验收、建完直接置完成"：
 *
 *  1. `gates.ts` G10 的 `doThis`（→ `dp schema`、`dp skill core` 照抄）
 *  2. `gates.ts` G10 的 `notes`（同上，"只拦 awaiting_review → done"）
 *  3. `todo.repository.ts` 抛错时的那句建议
 *
 * Bob照着 1 做，实测四列起点 × 三条命令全部 rc=4 —— 说明书在教一条走不通的路，
 * 而 agent 会一直重试。**说理与判据必须同源**，所以下半段把"哪一列都拦"真跑一遍。
 */
const ROOT = path.resolve(__dirname, '../../..')

describe('G10 的出口文案（216889a2）', () => {
  const gate = gateById('G10')!
  const repoSource = fs.readFileSync(
    path.join(ROOT, 'src/main/database/todo.repository.ts'),
    'utf8'
  )

  /** 三处里出现任意一处，就是在教"绕开待验收"那条已经不存在的路 */
  const BYPASS_HINTS = [
    '别先进',
    '建完直接置完成',
    '不受本守卫管',
    '只拦 `awaiting_review → done`'
  ]

  it('前置：G10 仍在，且文案字段读得到（防止路径/导出变化让闸门假绿）', () => {
    expect(gate, 'G10 从 gates.ts 里消失了').toBeTruthy()
    expect(gate.doThis.length).toBeGreaterThan(10)
    expect(gate.notes?.length ?? 0).toBeGreaterThan(10)
  })

  it('G10.doThis 不再教"建完直接置完成"，且给出真出路', () => {
    for (const hint of BYPASS_HINTS) {
      expect(gate.doThis, `doThis 仍在教绕行：「${hint}」`).not.toContain(hint)
    }
    expect(gate.doThis, 'doThis 要给唯一那条真出路：换验收者').toContain('verifier')
  })

  it('G10.notes 按"身份"讲判据，而不是按"某一条边"', () => {
    for (const hint of BYPASS_HINTS) {
      expect(gate.notes ?? '', `notes 仍在教绕行：「${hint}」`).not.toContain(hint)
    }
    expect(gate.notes ?? '', 'notes 必须写明判据是身份').toContain('身份')
    /** 起点无关这件事要在文案里明说，否则读者还是会按"只有待验收才拦"去推理 */
    expect(gate.notes ?? '').toContain('待办')
  })

  it('仓储抛错时只留"换验收者"这一条出路', () => {
    for (const hint of BYPASS_HINTS) {
      expect(repoSource, `todo.repository.ts 的报错仍在教绕行：「${hint}」`).not.toContain(hint)
    }
    expect(repoSource).toContain('这道门按身份判')
    /** 报错里的出路仍是 --verifier（换人收口） */
    expect(repoSource).toContain('--verifier 指定验收者')
  })
})

/**
 * 下半段：真跑。
 *
 * 文案说"哪一列都拦"，那就必须真的哪一列都拦 —— 否则这段文案是下一轮缺陷的种子。
 * 造法是让**执行者 = 调用人**（运动员当裁判），起点分别放在四列。
 */
const AUTHOR = 'agent:author'
const WORKER = 'agent:worker'
const tokens = new Map<string, string | undefined>()

const projectRepo = new ProjectRepository()
const agentRepo = new AgentRepository()

function mkCtx(actor: string): never {
  return {
    deps: {
      todoRepo: new TodoRepository(),
      categoryRepo: new CategoryRepository(),
      projectRepo,
      memoRepo: { list: () => [], add: () => ({}), get: () => null },
      settingsRepo: { get: () => ({}) },
      agentRepo,
      commentRepo: new CommentRepository(),
      notificationRepo: new NotificationRepository(),
      releaseRepo: new ReleaseRepository(),
      events: new EventsRepository(),
      telemetry: { record: () => {}, stats: () => {}, query: () => {}, clear: () => {} }
    },
    meta: {
      version: 'test',
      dbPath: ':memory:',
      schemaVersion: 99,
      busyTimeoutMs: 5000,
      channels: ['headless' as const],
      via: 'headless' as const,
      startedAt: Date.now()
    },
    // agent 必须按"无人值守"造：交互式会在门禁第二关直接放行，走不到协作规则矩阵
    interactive: false,
    actor,
    credential: tokens.get(actor)
  } as never
}

const run = (actor: string, args: string[]) => executeOne(mkCtx(actor), args)
const outcome = async (actor: string, args: string[]) => {
  const r = (await run(actor, args)) as { ok?: boolean; code?: number; errorCode?: string }
  return r.ok ? 'allow' : `${r.code}:${r.errorCode ?? 'no-code'}`
}

let todos: TodoRepository

beforeAll(() => {
  runMigrations(db)
  process.env.DESKPARTNER_CREDENTIALS_FILE = path.join(
    os.tmpdir(),
    `deskpartner-g10-wording-${process.pid}.json`
  )
  for (const id of [AUTHOR, WORKER]) {
    agentRepo.register({ id, displayName: id })
    agentRepo.setApproved(id, true)
    tokens.set(id, agentRepo.issueCredential(id)?.token)
  }
})

beforeEach(() => {
  for (const t of [
    'todos',
    'todo_transitions',
    'todo_comments',
    'todo_categories',
    'notifications',
    'agent_grants',
    'projects',
    'categories'
  ]) {
    db.prepare(`DELETE FROM ${t}`).run()
  }
  new CategoryRepository().create({ name: '默认', color: '#111', sortOrder: 0 })
  projectRepo.create({ name: 'P' })
  todos = new TodoRepository()
})

/** 执行者 = WORKER 的一张卡，落在指定列 */
function cardAt(status: 'todo' | 'in_progress' | 'suspended' | 'awaiting_review') {
  return todos.create({
    title: '卡',
    description: '【背景】x\n【目标】y\n【判据】z',
    projectId: null,
    status,
    createdBy: AUTHOR as never,
    executedBy: WORKER as never
  } as never)
}

const COLUMNS = ['todo', 'in_progress', 'suspended', 'awaiting_review'] as const

const CLOSE_ARGS = (id: string) => [
  'todo',
  'close',
  id,
  '--did',
  '做了',
  '--verified',
  '验证了',
  '--pass-criteria',
  '算通过'
]

describe('G10 的判据与文案同源：四列起点 × 三条命令全部拦下（216889a2）', () => {
  for (const column of COLUMNS) {
    it(`从「${column}」出发：todo close / todo done / update --status done 一律 rc=4`, async () => {
      const expected = `${EXIT_CODES.guard}:permission_denied`
      const close = cardAt(column)
      expect(await outcome(WORKER, CLOSE_ARGS(close.id)), 'todo close').toBe(expected)
      const done = cardAt(column)
      expect(await outcome(WORKER, ['todo', 'done', done.id]), 'todo done').toBe(expected)
      const update = cardAt(column)
      expect(
        await outcome(WORKER, ['todo', 'update', update.id, '--status', 'done']),
        'todo update --status done'
      ).toBe(expected)
    })
  }

  it('一步建到完成（born-done）仍然合法 —— 记自己的流水不是验收', async () => {
    expect(
      await outcome(WORKER, [
        'todo',
        'add',
        '--title',
        '我今天做完了什么',
        '--status',
        'done',
        '--project',
        'P'
      ])
    ).toBe('allow')
  })

  it('换个人收口就放行（G10 拦的是身份，不是"不许完成"）', async () => {
    const t = cardAt('awaiting_review')
    expect(
      await outcome(AUTHOR, ['todo', 'update', t.id, '--status', 'done']),
      '提出者不是执行者，可以验收'
    ).toBe('allow')
  })
})
