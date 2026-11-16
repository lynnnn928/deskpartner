import { describe, it, expect, vi, beforeAll } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '../../../src/main/database/migrations'

/**
 * AI 猜命令名：`help todo` 与 `todo show` 不该是死路（卡 `7c347b4b`，评审第 4 条）
 *
 * ── 埋点里的两个坑 ──
 *
 * 1. `help todo` / `todo --help` 约 19 次全失败：`help` 只做**精确匹配**，
 *    而 `run.ts` 把 `todo --help` 改写成 `help todo` —— 于是"想看这一族有哪几条"
 *    这个最自然的问法，得到的是一句"没有这个命令"。
 *    修法：精确匹配不到、但名字是某个命令族的**前缀**时，列出该族命令（成功返回）。
 * 2. `todo show` 29 次全失败：命令表**没有别名机制**（`CommandSpec` 里没有 alias 字段，
 *    加一条 `todo show` 会让 schema / help / MCP 的工具清单多出第 80 条，
 *    也就是动契约基线）——所以不加别名，改在未知命令的报错里点名指路 `todo get`。
 *
 * 反向验证写在每条用例里。
 */

const db = new Database(':memory:')
vi.mock('../../../src/main/database/index', () => ({
  getDatabase: () => db
}))

let seq = 0
vi.mock('uuid', () => ({
  v4: () => `hf-uuid-${++seq}`
}))

const { TodoRepository } = await import('../../../src/main/database/todo.repository')
const { CategoryRepository } = await import('../../../src/main/database/category.repository')
const { ProjectRepository } = await import('../../../src/main/database/project.repository')
const { MemoRepository } = await import('../../../src/main/database/memo.repository')
const { SettingsRepository } = await import('../../../src/main/database/settings.repository')
const { AgentRepository } = await import('../../../src/main/database/agent.repository')
const { ReleaseRepository } = await import('../../../src/main/database/release.repository')
const { executeOne } = await import('../../../src/main/cli/commands')

const ctx = {
  deps: {
    todoRepo: new TodoRepository(),
    categoryRepo: new CategoryRepository(),
    projectRepo: new ProjectRepository(),
    memoRepo: new MemoRepository(),
    settingsRepo: new SettingsRepository(),
    agentRepo: new AgentRepository(),
    releaseRepo: new ReleaseRepository(),
    events: { append: vi.fn() },
    telemetry: { record: vi.fn(), stats: vi.fn(), query: vi.fn(), clear: vi.fn() }
  },
  meta: {
    version: 'test',
    dbPath: ':memory:',
    schemaVersion: 11,
    busyTimeoutMs: 5000,
    channels: ['headless' as const],
    via: 'headless' as const,
    startedAt: Date.now()
  },
  interactive: false
}

beforeAll(() => {
  runMigrations(db)
})

describe('`help <命令族>`：精确匹配不到时列出该族命令（7c347b4b）', () => {
  it('`help todo` 成功返回 todo 族的命令清单（`todo --help` 在 run.ts 里就是被改写成它）', async () => {
    const res = await executeOne(ctx as never, ['help', 'todo'])
    expect(res.ok).toBe(true)
    const names = (res.data as { commands: { name: string; desc: string }[] }).commands.map((c) => c.name)
    // 这一族里最常被找的两条要在
    expect(names).toContain('todo get')
    expect(names).toContain('todo list')
    // 不许混进别的族（那等于把 79 条又倒一遍）
    expect(names.every((n) => n.startsWith('todo '))).toBe(true)
    // 反向验证：把 meta.ts 里那段 family 分支删掉 → ok=false、errorCode=not_found，本条红。
  })

  it('族清单与顶层清单字段同源：只读标记与风险档都要在（不留"不知道"）', async () => {
    const res = await executeOne(ctx as never, ['help', 'todo'])
    const rows = (res.data as { commands: Record<string, unknown>[] }).commands
    for (const row of rows) {
      expect(typeof row.readOnly).toBe('boolean')
      expect(['read', 'write', 'config', 'destructive']).toContain(row.risk)
      expect(typeof row.desc).toBe('string')
    }
  })

  it('精确命中仍然优先：`help todo get` 还是那一条的完整参数', async () => {
    const res = await executeOne(ctx as never, ['help', 'todo get'])
    expect(res.ok).toBe(true)
    const data = res.data as { name: string; args: unknown }
    expect(data.name).toBe('todo get')
    expect(Array.isArray(data.args)).toBe(true)
  })

  it('既不是命令也不是命令族时照旧报错（提示语里留了出路）', async () => {
    const res = await executeOne(ctx as never, ['help', 'xyzzy'])
    expect(res.ok).toBe(false)
    expect(res.errorCode).toBe('not_found')
    expect(res.message).toContain('help 看全部')
  })
})

describe('`todo show`：报错里点名指路 `todo get`（命令表没有别名，7c347b4b）', () => {
  it('报错含 `todo get` —— agent 照着报错就能纠回来，不用再跑 schema', async () => {
    const res = await executeOne(ctx as never, ['todo', 'show', 'abc123'])
    expect(res.ok).toBe(false)
    expect(res.code).toBe(2)
    expect(res.message).toContain('todo get')
    // 原有的"同前缀兄弟"清单保留（第一次猜错时它比什么都确定）
    expect(res.message).toContain('todo 下可用')
    // 反向验证：把 command-exec.ts 里的同义词映射删掉 → 消息里只有兄弟清单，本条红。
  })

  it('同义词表只救它认识的那个词：别的错拼不许硬凑建议', async () => {
    const res = await executeOne(ctx as never, ['todo', 'nosuchcmd'])
    expect(res.ok).toBe(false)
    expect(res.message).not.toContain('todo get')
  })
})
