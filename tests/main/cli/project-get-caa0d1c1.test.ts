import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '../../../src/main/database/migrations'
import { DB_VERSION } from '../../../src/renderer/lib/constants'
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
import { FIRST_READ_BUDGET_BYTES } from '../../../src/main/cli/response-budget'

/**
 * 卡 `caa0d1c1`：`project get` 变成有界接续包 —— 事实 / 新鲜度 / 体量闸门。
 *
 * ## 判据（卡面原话）
 *
 * ① 回执含 freshness 字段；② 把接手说明撑大后回执仍在其声明的体量内；
 * ③ 超出部分有 nextSteps 指向（不是硬塞，也不是悄悄截断）。
 *
 * 体量判据复用 `src/main/cli/response-budget.ts`（与 `work next` 同一份）。
 */
const db = new Database(':memory:')
vi.mock('../../../src/main/database/index', () => ({ getDatabase: () => db }))
vi.mock('../../../src/cli/credentials', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/cli/credentials')>()
  return { ...actual, writeCredential: vi.fn() }
})

const projectRepo = new ProjectRepository()
const todoRepo = new TodoRepository()
const categoryRepo = new CategoryRepository()

function makeCtx() {
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
      version: '1.0.1',
      dbPath: ':memory:',
      schemaVersion: DB_VERSION,
      busyTimeoutMs: 5000,
      channels: ['pipe'],
      via: 'pipe',
      startedAt: 0
    },
    interactive: true,
    actor: 'agent:carol'
  } as never
}

async function run(args: string[]) {
  const outcome = await executeOne(makeCtx(), args)
  const { stdout } = formatOutcome(outcome, args, false)
  return JSON.parse(stdout) as {
    ok: boolean
    data?: {
      project: { handoffMarkdown: string }
      facts: { version: string | null; schemaVersion: number; mainTodo: { id: string } | null }
      handoff: { truncated: boolean; readFull: string | null; coverage: { version: string | null } | null }
      freshness: { state: string; reasons: string[] }
      budget: { limitBytes: number; bytes: number; overBudget: boolean }
      nextSteps: string
    }
  }
}

let projectId = ''
let categoryId = ''

beforeAll(() => {
  runMigrations(db)
  db.pragma('foreign_keys = OFF')
})

beforeEach(() => {
  db.prepare('DELETE FROM project_handoff_revisions').run()
  db.prepare('DELETE FROM project_handoff_proposals').run()
  db.prepare('DELETE FROM todos').run()
  db.prepare('DELETE FROM projects').run()
  db.prepare('DELETE FROM categories').run()
  categoryRepo.initializeDefaults()
  categoryId = categoryRepo.list()[0].id
  projectId = projectRepo.create({ name: '接续包项目' }).id
})

describe('project get：接续包（卡 caa0d1c1）', () => {
  it('回执含 facts / handoff / freshness / budget，且默认不返回事项清单', async () => {
    todoRepo.create({
      title: '当前主线',
      categoryIds: [categoryId],
      projectId,
      status: 'in_progress',
      priority: 'high',
      skipGuards: true
    })
    projectRepo.saveHandoff(projectId, '背景与主线', 'human', undefined, { version: '1.0.1' })

    const env = await run(['project', 'get', projectId.slice(0, 8)])
    expect(env.ok).toBe(true)
    const d = env.data!
    expect(d.freshness.state).toBe('fresh')
    expect(d.facts.mainTodo?.id).toBeTruthy()
    expect(d.facts.schemaVersion).toBe(DB_VERSION)
    expect(d.handoff.coverage?.version).toBe('1.0.1')
    expect(d.budget.limitBytes).toBe(FIRST_READ_BUDGET_BYTES)
    expect(d.project.handoffMarkdown).toBe('背景与主线')
    expect(d.nextSteps).toContain('--limit')
  })

  it('把接手说明撑到 30KB：回执仍在上界内，只给预览与读全文的入口', async () => {
    projectRepo.saveHandoff(projectId, '长说明'.repeat(6000), 'human', undefined, { version: '1.0.1' })
    const env = await run(['project', 'get', projectId.slice(0, 8)])
    expect(env.ok).toBe(true)
    const d = env.data!
    expect(d.budget.bytes).toBeLessThanOrEqual(FIRST_READ_BUDGET_BYTES)
    expect(d.budget.overBudget).toBe(false)
    expect(d.handoff.truncated).toBe(true)
    expect(d.project.handoffMarkdown.length).toBeLessThan(3000)
    expect(d.handoff.readFull).toContain('project handoff-revision')
    expect(d.nextSteps).toContain('说明全文')
  })

  it('--handoff-full 要全文就给全文，并如实说超没超体量', async () => {
    projectRepo.saveHandoff(projectId, '长说明'.repeat(6000), 'human', undefined, { version: '1.0.1' })
    const env = await run(['project', 'get', projectId.slice(0, 8), '--handoff-full'])
    expect(env.ok).toBe(true)
    const d = env.data!
    expect(d.project.handoffMarkdown.length).toBeGreaterThan(10000)
    expect(d.handoff.truncated).toBe(false)
    expect(d.budget.overBudget).toBe(true)
  })

  it('事实漂了 → freshness 变 review_required，并点名原因', async () => {
    projectRepo.saveHandoff(projectId, '背景', 'human', undefined, { version: '0.9.0' })
    const env = await run(['project', 'get', projectId.slice(0, 8)])
    const d = env.data!
    expect(d.freshness.state).toBe('review_required')
    expect(d.freshness.reasons.join(' / ')).toContain('0.9.0')
    expect(d.nextSteps).toContain('handoff-propose')
  })
})
