import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '../../../src/main/database/migrations'
import { TodoRepository } from '../../../src/main/database/todo.repository'
import { CategoryRepository } from '../../../src/main/database/category.repository'
import { ProjectRepository } from '../../../src/main/database/project.repository'
import { CommentRepository } from '../../../src/main/database/comment.repository'
import { NotificationRepository } from '../../../src/main/database/notification.repository'
import { ReminderReceiptRepository } from '../../../src/main/database/reminder-receipt.repository'
import { RulesRepository } from '../../../src/main/database/rules.repository'
import { ProtocolRepository } from '../../../src/main/database/protocol.repository'
import { ProfileRepository } from '../../../src/main/database/profile.repository'
import { executeOne } from '../../../src/main/cli/commands'
import { formatOutcome } from '../../../src/main/cli/output'

const db = new Database(':memory:')
vi.mock('../../../src/main/database/index', () => ({
  getDatabase: () => db
}))

/**
 * ⚠️ 必须拦掉「写真实凭据文件」这一步（commands.test.ts 头注释记录过的坑）：
 * 这里只 mock 数据库，`writeCredential()` 写的是真实磁盘 ~/.deskpartner/。
 * 本文件走 human 交互身份、理论上走不到发凭据那步 —— 但那正是
 * "理论上下次也走不到"的形状，先拦住。
 */
vi.mock('../../../src/cli/credentials', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/cli/credentials')>()
  return { ...actual, writeCredential: vi.fn() }
})

const todoRepo = new TodoRepository()
const categoryRepo = new CategoryRepository()
const projectRepo = new ProjectRepository()

/**
 * 断言打到**最终输出层**（formatOutcome 的 stdout）—— 不是 executeOne 的
 * 中间 Outcome 对象。这两张卡的缺陷恰好都出在"跨不过 output 层"：
 * 中间对象对了、调用方拿到的信封里没有，只测中间对象会假绿。
 */
function makeCtx(over: Record<string, unknown> = {}) {
  return {
    deps: {
      todoRepo,
      categoryRepo,
      projectRepo,
      /* 卡 69788c32：命令层要读哪个仓储由 deps 决定 —— 缺一个，跑到那条命令就炸 */
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
      version: '1.0.73',
      dbPath: ':memory:',
      schemaVersion: 25,
      busyTimeoutMs: 5000,
      channels: ['pipe'],
      via: 'pipe',
      startedAt: 0
    },
    // human 交互：写命令不过身份/授权关口，这里要验的是信封形状，不是门禁
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
  db.prepare('DELETE FROM memos').run()
  db.prepare('DELETE FROM todos').run()
  db.prepare('DELETE FROM projects').run()
  db.prepare('DELETE FROM categories').run()
  categoryRepo.create({ name: '方向', color: '#1', sortOrder: 0 })
  projectRepo.create({ name: '测试项目' })
})

describe('batch 提醒进顶层 notice、成功行带 exitCode（e209441e）', () => {
  it('顶层 notice 与直连逐字一致，不再落 data.__notice；成功行 exitCode 有值且为 0', async () => {
    const cat = categoryRepo.list()[0]
    const directTodo = todoRepo.create({ title: '直连这条', categoryIds: [cat.id] })

    // 1) 直连跑一次：G5 软提醒应在顶层 notice
    const directOutcome = await executeOne(makeCtx(), ['todo', 'done', directTodo.id])
    const direct = formatOutcome(directOutcome, ['todo', 'done', directTodo.id], false)
    const directEnvelope = JSON.parse(direct.stdout) as {
      ok: boolean
      notice?: string
    }
    expect(directEnvelope.ok).toBe(true)
    // 先钉住提醒真的存在 —— 否则下面"两边一致"会被 undefined === undefined 假绿
    expect(directEnvelope.notice, '直连的 G5 提醒应当在顶层 notice').toContain('G5')

    // 2) 两次执行后均没有未完成的自提事项，避免把不同工作快照误当成通道差异。
    const batchTodo = todoRepo.create({ title: 'batch 这条', categoryIds: [cat.id] })
    const ctx = makeCtx({
      stdin: JSON.stringify({ cmd: 'todo done', positional: [batchTodo.id] })
    })
    const batchOutcome = await executeOne(ctx, ['batch'])
    const batch = formatOutcome(batchOutcome, ['batch'], false)
    const batchEnvelope = JSON.parse(batch.stdout) as {
      ok: boolean
      notice?: string
      data: {
        __notice?: string
        results: { ok: boolean; notice?: string; exitCode?: number }[]
      }
    }
    expect(batchEnvelope.ok).toBe(true)

    // 顶层 notice 与直连逐字一致 —— 不是同族文案，是同一段文字
    expect(batchEnvelope.notice, 'batch 的提醒必须在顶层 notice（与直连同源）').toBe(
      directEnvelope.notice
    )
    // 提醒不再被整包埋进 data
    expect(
      batchEnvelope.data.__notice,
      '提醒落进 data.__notice = 跨不过契约层，按顶层 notice 取数的 agent 全丢'
    ).toBeUndefined()
    // 逐条那份仍在（只聚合去重，不抹行内）
    expect(batchEnvelope.data.results[0].notice).toBe(directEnvelope.notice)

    // 成功行的 exitCode 必须有值，且与直连退出码同口径（0）
    const rowExit = batchEnvelope.data.results[0].exitCode
    expect(typeof rowExit, '成功行缺 exitCode → 按 exitCode 分流会漏判成功行').toBe('number')
    expect(rowExit).toBe(0)
    expect(rowExit, '行内 exitCode 与直连退出码两处口径必须一致').toBe(direct.exitCode)
  })
})

describe('失败信封序列化 firstFailure（51958ed9）', () => {
  it('batch 全败时顶层 firstFailure 等于 results 里第一条失败', async () => {
    const ctx = makeCtx({
      stdin: [
        // 第一行：目标不存在（not_found）
        JSON.stringify({ cmd: 'todo get', positional: ['deadbeef'] }),
        // 第二行：缺 --title（usage_error）—— 与第一行不同类，钉住"取的是第一条"
        JSON.stringify({ cmd: 'todo add' })
      ].join('\n')
    })
    const outcome = await executeOne(ctx, ['batch'])
    const res = formatOutcome(outcome, ['batch'], false)
    const envelope = JSON.parse(res.stdout) as {
      ok: boolean
      code?: string
      firstFailure?: { code?: unknown; message?: unknown }
      data: { results: { ok: boolean; code?: unknown; message?: unknown }[] }
    }
    expect(envelope.ok).toBe(false)
    expect(envelope.code).toBe('batch_all_failed')

    const ff = envelope.firstFailure
    expect(ff, '顶层缺 firstFailure —— executeOne 已产出，跨不过 output 层').toBeTruthy()
    expect(ff!.code).toBe('not_found')
    // 等于 results 里第一条失败，不是任意一条
    expect(ff!.code, 'firstFailure 必须等于 results 中第一条失败').toBe(
      envelope.data.results[0].code
    )
    expect(ff!.message).toBe(envelope.data.results[0].message)
    expect(ff!.code, 'firstFailure 不许跟着第二条走').not.toBe(envelope.data.results[1].code)
  })
})
