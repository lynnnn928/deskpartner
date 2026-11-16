import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { runMigrations } from '../../../src/main/database/migrations'

/**
 * 写命令跑完之后，界面到底知不知道（卡 `7c347b4b`，第 6 条）
 *
 * ── 缺陷本体 ──
 *
 * 通道 B（无头执行 / 常驻管道里由助手代跑）改完数据后，主进程会追加一条
 * `events` 记录，界面靠轮询它察觉"别的进程改了库"。此前这件事只认
 * `todo ` / `project ` / `profile ` / `protocol ` 四个**前缀**，
 * 于是 `category add`、`memo …`、`rules …` 这类写命令跑完**界面一直不刷新** ——
 * 命令回执 ok:true，人却看着旧数据，直到下一次不相关的刷新或重启。
 *
 * 前缀表的问题不是"漏了几条"，而是它**无法被穷举核对**：
 * 新增一条写命令时没有任何一处会红，只有人肉眼发现界面没动。
 *
 * 所以这里钉两件事：
 * ① 行为：写命令（`category add` / `category rm`）真的追加了对应事件；
 * ② 结构（见文件末尾）：命令表里**每一条**非 read 命令都映射到某个事件类型，
 *    或落在一份逐条写理由的「无需刷新」清单里 —— 新增命令漏映射会红。
 */

const db = new Database(':memory:')
vi.mock('../../../src/main/database/index', () => ({ getDatabase: () => db }))

/** 同 commands.test.ts：拦住"写真实凭据文件"那一步（测试不该有宿主副作用） */
vi.mock('../../../src/cli/credentials', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/cli/credentials')>()
  return { ...actual, writeCredential: vi.fn() }
})

let seq = 0
vi.mock('uuid', () => ({ v4: () => `cli-uuid-${++seq}` }))

const { TodoRepository } = await import('../../../src/main/database/todo.repository')
const { CategoryRepository } = await import('../../../src/main/database/category.repository')
const { ProjectRepository } = await import('../../../src/main/database/project.repository')
const { MemoRepository } = await import('../../../src/main/database/memo.repository')
const { SettingsRepository } = await import('../../../src/main/database/settings.repository')
const { AgentRepository } = await import('../../../src/main/database/agent.repository')
const { CommentRepository } = await import('../../../src/main/database/comment.repository')
const { NotificationRepository } = await import('../../../src/main/database/notification.repository')
const { ReleaseRepository } = await import('../../../src/main/database/release.repository')
const { ReminderReceiptRepository } = await import('../../../src/main/database/reminder-receipt.repository')
const { RulesRepository } = await import('../../../src/main/database/rules.repository')
const { ProtocolRepository } = await import('../../../src/main/database/protocol.repository')
const { ProfileRepository } = await import('../../../src/main/database/profile.repository')
const { executeOne, commands, riskOf } = await import('../../../src/main/cli/commands')
const { CHANGE_EVENT_BY_COMMAND, NO_REFRESH_COMMANDS } = await import(
  '../../../src/main/cli/command-exec'
)

const todoRepo = new TodoRepository()
const categoryRepo = new CategoryRepository()

/** 人在终端敲：门禁不该喧宾夺主，这里验的是"改完之后有没有广播" */
const ctx = {
  deps: {
    todoRepo,
    categoryRepo,
    projectRepo: new ProjectRepository(),
    memoRepo: new MemoRepository(),
    settingsRepo: new SettingsRepository(),
    agentRepo: new AgentRepository(),
    releaseRepo: new ReleaseRepository(),
    commentRepo: new CommentRepository(),
    notificationRepo: new NotificationRepository(),
    reminderReceiptRepo: new ReminderReceiptRepository(),
    rulesRepo: new RulesRepository(),
    protocolRepo: new ProtocolRepository(),
    profileRepo: new ProfileRepository(),
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
  interactive: true
}

const append = ctx.deps.events.append as unknown as ReturnType<typeof vi.fn>

async function run(args: string[]) {
  append.mockClear()
  return executeOne(ctx as never, args)
}

/** 只看"这条命令追加了哪些事件类型"（命令自己 append 的条目也可能是别的 payload） */
function appendedTypes(): string[] {
  return append.mock.calls.map((c) => c[0] as string)
}

beforeAll(() => {
  runMigrations(db)
})

beforeEach(() => {
  db.prepare('DELETE FROM todo_categories').run()
  db.prepare('DELETE FROM todos').run()
  db.prepare('DELETE FROM categories').run()
  seq = 0
})

describe('写命令成功后界面收得到（7c347b4b）', () => {
  it('category add → 追加 category 事件（此前界面完全不刷新）', async () => {
    const res = await run(['category', 'add', '--name', '竞争调研', '--color', '#5388F6'])
    expect(res.ok).toBe(true)
    expect(appendedTypes()).toContain('category')
  })

  it('category rm → category 与 todo 各追加一次（删分类会连带改挂在上面的待办）', async () => {
    const cat = categoryRepo.create({ name: '要删的方向', color: '#1' })
    const res = await run(['category', 'rm', cat.id, '--yes'])
    expect(res.ok).toBe(true)
    expect(appendedTypes()).toContain('category')
    expect(appendedTypes()).toContain('todo')
  })

  it('只读命令不追加事件（否则每次 list 都刷一遍界面）', async () => {
    const res = await run(['category', 'list'])
    expect(res.ok).toBe(true)
    expect(append).not.toHaveBeenCalled()
  })
})

/**
 * 穷举：命令表里每一条非 read 命令，都得说清"写完界面刷不刷新"
 *
 * 这才是本条卡真正要立的判据 —— 不是"这次补了哪几条"，而是
 * **以后新增写命令时漏了会红**。所以遍历命令表本身，不手抄名单：
 * 手抄的那份迟早与命令表长得不一样，而且没人会发现。
 */
describe('穷举：每条非 read 命令都有归属（7c347b4b）', () => {
  /**
   * 渲染层认识的类型名单从 `src/renderer/types/ipc.ts` 的 `event:dataChanged` 现读，
   * 不另抄一份：抄一份就会跟真名单漂移，而漂移的后果正是"发明了一个没人听的事件"。
   */
  const rendererIpc = fs.readFileSync(
    path.resolve(__dirname, '../../../src/renderer/types/ipc.ts'),
    'utf8'
  )
  const blockStart = rendererIpc.indexOf("  'event:dataChanged': {")
  const blockEnd = rendererIpc.indexOf("  'event:windowState'")
  const rendererTypes = new Set(
    [...rendererIpc.slice(blockStart, blockEnd).matchAll(/'([a-z_]+)'/g)].map((m) => m[1])
  )
  const mappedTypes = (name: string): readonly string[] => CHANGE_EVENT_BY_COMMAND[name] ?? []

  /** 既不在映射表、也不在「无需刷新」清单里的非 read 命令 */
  const uncovered = (list: Array<{ name: string; risk: string }>): string[] =>
    list
      .filter((c) => c.risk !== 'read')
      .filter((c) => !mappedTypes(c.name).length && !NO_REFRESH_COMMANDS[c.name])
      .map((c) => c.name)

  it('渲染层的事件类型名单本身读得到（名单没失效，下面的判定才有意义）', () => {
    expect(rendererTypes.has('todo')).toBe(true)
    expect(rendererTypes.has('category')).toBe(true)
    expect(rendererTypes.has('agent_register')).toBe(true)
  })

  it('没有任何一条非 read 命令被漏掉', () => {
    const missing = uncovered(commands.map((c) => ({ name: c.name, risk: riskOf(c) })))
    expect(missing, `这些命令写完不广播，界面会停在旧数据：${missing.join('、')}`).toEqual([])
  })

  it('反向验证：喂一条没映射的写命令，判定要红（否则这道闸门是空的）', () => {
    expect(
      uncovered([
        { name: 'todo list', risk: 'read' },
        { name: 'wat add', risk: 'write' }
      ])
    ).toEqual(['wat add'])
  })

  it('只读命令不进表（进表就等于每次 list 都刷一遍界面）', () => {
    const leaked = commands
      .filter((c) => riskOf(c) === 'read')
      .map((c) => c.name)
      .filter((n) => mappedTypes(n).length || NO_REFRESH_COMMANDS[n])
    expect(leaked).toEqual([])
  })

  it('表里指向的事件类型都在渲染层名单内（不发明没人听的事件）', () => {
    const unknown = Object.entries(CHANGE_EVENT_BY_COMMAND)
      .flatMap(([cmd, types]) => types.map((t) => ({ cmd, t })))
      .filter(({ t }) => !rendererTypes.has(t))
      .map(({ cmd, t }) => `${cmd} → ${t}`)
    expect(unknown).toEqual([])
  })

  it('两张表都不留死条目（命令表里已经没有的命令不该留在这里）', () => {
    const names = new Set(commands.map((c) => c.name))
    const stale = [
      ...Object.keys(CHANGE_EVENT_BY_COMMAND),
      ...Object.keys(NO_REFRESH_COMMANDS)
    ].filter((n) => !names.has(n))
    expect(stale).toEqual([])
  })

  it('「无需刷新」清单每一条都写了理由（空白理由等于没写）', () => {
    const empty = Object.entries(NO_REFRESH_COMMANDS)
      .filter(([, reason]) => !reason.trim())
      .map(([cmd]) => cmd)
    expect(empty).toEqual([])
  })
})
