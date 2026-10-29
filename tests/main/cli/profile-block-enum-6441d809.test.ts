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
import { ProfileRepository, PROFILE_BLOCK_KEYS } from '../../../src/main/database/profile.repository'
import { executeOne } from '../../../src/main/cli/commands'
import { formatOutcome } from '../../../src/main/cli/output'
import { buildSchema } from '../../../src/main/cli/command-schema'
import { commands } from '../../../src/main/cli/command-table'

/**
 * 卡 `6441d809`：`profile propose --block` 不是枚举。
 *
 * ## 病
 *
 * 合法值只有 `PROFILE_BLOCK_KEYS` 那四个，声明却是 `string` —— 传错区块要跑到仓储才炸，
 * 回的是 `error`（退出码 1）而不是 `usage_error`（退出码 2）。**按退出码分流的调用方
 * 会把它判成"数据层异常"**，而它其实是"你把参数写错了"。`dp help` 里也没有那四个值，
 * 只能撞一次错才发现。
 *
 * ## 本文件钉三个出口（与 `1.0.72` 那条"一份语义三个出口"同规矩）
 *
 * ① 命令表：`--block` 声明成 enum，且值来自 `PROFILE_BLOCK_KEYS`（不是抄一份字面量）；
 * ② `dp schema`：枚举带出去了（调用方不用再猜）；
 * ③ `dp help`：人读的那份也看得到合法值。
 * 外加行为：非法值 → `usage_error`，合法值 → 能真的建出提议。
 */
const db = new Database(':memory:')
vi.mock('../../../src/main/database/index', () => ({
  getDatabase: () => db
}))

/** 与 commands.test.ts 同一条坑：只 mock 数据库时 `writeCredential()` 会写真实凭据文件 */
vi.mock('../../../src/cli/credentials', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/cli/credentials')>()
  return { ...actual, writeCredential: vi.fn() }
})

const profileRepo = new ProfileRepository()
const projectRepo = new ProjectRepository()

function makeCtx() {
  return {
    deps: {
      todoRepo: new TodoRepository(),
      categoryRepo: new CategoryRepository(),
      projectRepo,
      commentRepo: new CommentRepository(),
      notificationRepo: new NotificationRepository(),
      reminderReceiptRepo: new ReminderReceiptRepository(),
      rulesRepo: new RulesRepository(),
      protocolRepo: new ProtocolRepository(),
      profileRepo,
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
    actor: 'human'
  } as never
}

/** 跑一条命令，回最终信封 */
async function run(args: string[]) {
  const outcome = await executeOne(makeCtx(), args)
  const { stdout } = formatOutcome(outcome, args, false)
  return JSON.parse(stdout) as {
    ok: boolean
    code?: number | string
    message?: string
    data?: Record<string, unknown>
  }
}

beforeAll(() => {
  runMigrations(db)
})

beforeEach(() => {
  db.prepare('DELETE FROM profile_proposals').run()
  db.prepare('DELETE FROM projects').run()
})

const spec = () => commands.find((c) => c.name === 'profile propose')!
const blockArg = () => spec().args.find((a) => a.flag === '--block')!

describe('profile propose --block 是枚举（卡 6441d809）', () => {
  it('命令表声明成 enum，值来自 PROFILE_BLOCK_KEYS（不是另抄一份字面量）', () => {
    expect(blockArg().type).toBe('enum')
    expect(blockArg().enum).toEqual([...PROFILE_BLOCK_KEYS])
    expect(blockArg().required).toBe(true)
  })

  it('`dp schema` 把这个枚举带出去了 —— 调用方不用猜', () => {
    const cmd = buildSchema().commands.find((c) => c.name === 'profile propose')!
    const arg = cmd.args.find((a) => a.flag === '--block')!
    expect(arg.type).toBe('enum')
    expect(arg.enum).toEqual([...PROFILE_BLOCK_KEYS])
  })

  it('`dp help` 也看得到合法值（人读的那条出口）', async () => {
    const env = await run(['help', 'profile propose'])
    expect(env.ok).toBe(true)
    const args = (env.data as { args: Array<{ flag: string; type: string; enum?: string[] }> }).args
    const arg = args.find((a) => a.flag === '--block')!
    expect(arg.type, 'help 里 --block 还是自由文本').toBe('enum')
    expect(arg.enum).toEqual([...PROFILE_BLOCK_KEYS])
  })

  it('非法区块回 usage_error（退出码 2），不再落到仓储的 error（退出码 1）', async () => {
    const env = await run(['profile', 'propose', '--block', 'about', '--body', '随便写点'])
    expect(env.ok).toBe(false)
    expect(String(env.code), '非法枚举必须判成用法错误').toBe('usage_error')
    // 报错里要能看见合法值，否则调用方还得再猜一次
    expect(String(env.message)).toContain('basics')
    expect(String(env.message)).toContain('completion')
  })

  it('合法区块照旧能建出提议（枚举没把正常路堵死）', async () => {
    const env = await run([
      'profile',
      'propose',
      '--block',
      'basics',
      '--body',
      '用户希望回复先给结论、再给依据。'
    ])
    expect(env.ok).toBe(true)
    expect((env.data as { status?: string }).status).toBe('pending')
    expect(profileRepo.listProposals('pending').length).toBe(1)
  })
})
