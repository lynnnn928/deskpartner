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
import { ProtocolRepository, PROTOCOL_BLOCK_KEYS } from '../../../src/main/database/protocol.repository'
import { ProfileRepository } from '../../../src/main/database/profile.repository'
import { executeOne } from '../../../src/main/cli/commands'
import { formatOutcome } from '../../../src/main/cli/output'
import { buildSchema } from '../../../src/main/cli/command-schema'
import { commands } from '../../../src/main/cli/command-table'

/**
 * 卡 `83d32f53`：`protocol propose --block` 枚举化（与 `6441d809` 同一形状）。
 *
 * 钉三个出口 + 两个行为：
 * ① 命令表：`--block` 声明成 enum，值来自 `PROTOCOL_BLOCK_KEYS`；
 * ② `dp schema`：枚举带出；
 * ③ `dp help`：合法值可见；
 * ④ 非法值 → `usage_error`（退出码 2）；
 * ⑤ 合法值 → 正常创建提议。
 */
const db = new Database(':memory:')
vi.mock('../../../src/main/database/index', () => ({
  getDatabase: () => db
}))

vi.mock('../../../src/cli/credentials', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/cli/credentials')>()
  return { ...actual, writeCredential: vi.fn() }
})

const protocolRepo = new ProtocolRepository()
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
      protocolRepo,
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
      version: '1.0.127',
      dbPath: ':memory:',
      schemaVersion: 47,
      busyTimeoutMs: 5000,
      channels: ['pipe'],
      via: 'pipe',
      startedAt: 0
    },
    interactive: true,
    actor: 'human'
  } as never
}

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
  db.prepare('DELETE FROM protocol_proposals').run()
  db.prepare('DELETE FROM projects').run()
})

const spec = () => commands.find((c) => c.name === 'protocol propose')!
const blockArg = () => spec().args.find((a) => a.flag === '--block')!

describe('protocol propose --block 是枚举（卡 83d32f53）', () => {
  it('命令表声明成 enum，值来自 PROTOCOL_BLOCK_KEYS（不是另抄一份字面量）', () => {
    expect(blockArg().type).toBe('enum')
    expect(blockArg().enum).toEqual([...PROTOCOL_BLOCK_KEYS])
    expect(blockArg().required).toBe(true)
  })

  it('`dp schema` 把这个枚举带出去了 —— 调用方不用猜', () => {
    const cmd = buildSchema().commands.find((c) => c.name === 'protocol propose')!
    const arg = cmd.args.find((a) => a.flag === '--block')!
    expect(arg.type).toBe('enum')
    expect(arg.enum).toEqual([...PROTOCOL_BLOCK_KEYS])
  })

  it('`dp help` 也看得到合法值（人读的那条出口）', async () => {
    const env = await run(['help', 'protocol propose'])
    expect(env.ok).toBe(true)
    const args = (env.data as { args: Array<{ flag: string; type: string; enum?: string[] }> }).args
    const arg = args.find((a) => a.flag === '--block')!
    expect(arg.type, 'help 里 --block 还是自由文本').toBe('enum')
    expect(arg.enum).toEqual([...PROTOCOL_BLOCK_KEYS])
  })

  it('非法区块回 usage_error（退出码 2），不再落到仓储的 error（退出码 1）', async () => {
    const env = await run(['protocol', 'propose', '--block', 'about', '--body', '随便写点'])
    expect(env.ok).toBe(false)
    expect(String(env.code), '非法枚举必须判成用法错误').toBe('usage_error')
    expect(String(env.message)).toContain('roles')
    expect(String(env.message)).toContain('language')
  })

  it('合法区块照旧能建出提议（枚举没把正常路堵死）', async () => {
    const env = await run([
      'protocol',
      'propose',
      '--block',
      'roles',
      '--body',
      '每项工作明确提出者、执行者与验收者。'
    ])
    expect(env.ok).toBe(true)
    expect((env.data as { status?: string }).status).toBe('pending')
    expect(protocolRepo.listProposals('pending').length).toBe(1)
  })
})
