/**
 * batch 通道的 `--desc-file` 不许再静默丢正文（修 `7f48eb16`）
 *
 * 【事故】同一份文件，单条 `todo add --desc-file` 正文完整落库；
 * 经 batch 通道却「回 ok:true 还给了 id，库里 desc 长度 0」—— 内容整段丢。
 * 根因有两层：
 * 1. batch 每行的 args 由**服务端**展平成 argv，不经过启动器的单条展开；
 * 2. `--desc-file` 又被声明进服务端 args 表 —— 从"报未知参数"（能被发现）
 *    退化成"认识但不处理"（静默丢）。
 *
 * 【本文件钉三层】
 * 1. 行为：batch 通道（展开 → 执行）落库的正文 = 文件内容（换行/引号/emoji 都在）；
 * 2. 行为：文件读不到在展开阶段就抛错；服务端真收到 `--desc-file` 明确报错
 *    （两条路都不许再出现"ok:true 而内容没了"）；
 * 3. 结构：launcher 的 batch 通道真的把 stdin 过了文件参数展开
 *    （那行消费删掉就回到静默丢正文，且不会有任何报错 —— 必须有用例盯着）。
 *
 * 反向验证（判别逻辑已用 node 直接执行验证过，未跑 vitest）：
 * - 结构判定喂"stdin 直通"的假 launcher 源码 → 判违规；
 * - 喂现状源码（含新旧两种展开调用名）→ 放行。
 *
 * 单元级展开清单另见 `file-flags-expand.test.ts`（3c522bdb）；
 * 本文件是 `7f48eb16` 这张卡的专属回归锁，按卡 id 落名（b3643767 纪律）。
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { runMigrations } from '../../../src/main/database/migrations'
import { expandFileFlagsInBatch } from '../../../src/cli/file-flags'

const db = new Database(':memory:')
vi.mock('../../../src/main/database/index', () => ({ getDatabase: () => db }))

/**
 * 与 commands.test.ts 同理：拦住 writeCredential 写真实磁盘凭据。
 * 那边注释里记了 2026-09-22 的事故 —— 测试跑一次就换掉本机真实凭据。
 */
vi.mock('../../../src/cli/credentials', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/cli/credentials')>()
  return { ...actual, writeCredential: vi.fn() }
})

const { TodoRepository } = await import('../../../src/main/database/todo.repository')
const { CategoryRepository } = await import('../../../src/main/database/category.repository')
const { ProjectRepository } = await import('../../../src/main/database/project.repository')
const { MemoRepository } = await import('../../../src/main/database/memo.repository')
const { SettingsRepository } = await import('../../../src/main/database/settings.repository')
const { AgentRepository } = await import('../../../src/main/database/agent.repository')
const { executeOne } = await import('../../../src/main/cli/commands')

const todoRepo = new TodoRepository()
const categoryRepo = new CategoryRepository()
const projectRepo = new ProjectRepository()
const memoRepo = new MemoRepository()
const settingsRepo = new SettingsRepository()
const agentRepo = new AgentRepository()

const ctx = {
  deps: {
    todoRepo,
    categoryRepo,
    projectRepo,
    memoRepo,
    settingsRepo,
    agentRepo,
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

/** 假 reader：不碰磁盘，内容含换行/引号/emoji —— 正是会丢的那类正文 */
const FILES: Record<string, string> = {
  'a.txt': '第一行：结论\n第二行："引号" `反引号` 🎯'
}
const read = (f: string): string => {
  if (!(f in FILES)) throw new Error(`ENOENT: no such file or directory, open '${f}'`)
  return FILES[f]
}

beforeAll(() => {
  runMigrations(db)
})

beforeEach(() => {
  db.prepare('DELETE FROM todo_categories').run()
  db.prepare('DELETE FROM todos').run()
  db.prepare('DELETE FROM projects').run()
  db.prepare('DELETE FROM categories').run()
})

describe('batch 通道的 --desc-file 必须展开成 --desc，正文完整落库（7f48eb16）', () => {
  it('batch 里 --desc-file 的正文必须落库（换行/引号/emoji 都在，不再是空描述）', async () => {
    categoryRepo.create({ name: '方向', color: '#1', sortOrder: 0 })
    projectRepo.create({ name: '测试项目' })
    const stdin = JSON.stringify({
      cmd: 'todo add',
      args: {
        '--title': 'batch 的卡',
        '--desc-file': 'a.txt',
        '--project': '测试项目',
        '--category': '方向'
      }
    })
    // 与真实链路同一顺序：启动器侧展开 → 服务端 batch 执行
    const expanded = expandFileFlagsInBatch(['batch'], stdin, read)
    const res = await executeOne({ ...ctx, stdin: expanded } as never, ['batch'])
    expect(res.ok, JSON.stringify(res)).toBe(true)
    expect((res.data as { failed: number }).failed).toBe(0)

    const row = db
      .prepare("SELECT description FROM todos WHERE title = 'batch 的卡'")
      .get() as { description: string | null } | undefined
    expect(row, '卡没建出来').toBeDefined()
    // 钉最终可见结果：落库正文 = 文件内容。事故当时这里是长度 0。
    expect(row!.description, 'batch 通道又把正文丢了').toBe(FILES['a.txt'])
  })

  it('文件读不到在展开阶段就抛错，不给"ok:true 而内容丢了"留缝', () => {
    const stdin = JSON.stringify({
      cmd: 'todo add',
      args: { '--title': 'x', '--desc-file': 'missing.txt' }
    })
    expect(() => expandFileFlagsInBatch(['batch'], stdin, read)).toThrow(/--desc-file 读不到/)
  })

  it('服务端真收到 --desc-file 明确报错（保险层：不许再"认识但不处理"）', async () => {
    categoryRepo.create({ name: '方向', color: '#1', sortOrder: 0 })
    projectRepo.create({ name: '测试项目' })
    const res = await executeOne(ctx as never, [
      'todo', 'add', '--title', '绕过启动器', '--desc-file', 'C:/tmp/x.txt',
      '--project', '测试项目', '--category', '方向'
    ])
    expect(res.ok, '服务端把 --desc-file 静默收下了 —— 这正是事故的另一半').toBe(false)
    expect(res.code).toBe(2) // usage_error
    expect(res.message).toContain('--desc-file')
    const n = (db.prepare('SELECT COUNT(*) AS n FROM todos').get() as { n: number }).n
    expect(n, '报了错却还落了卡 —— 又留一半').toBe(0)
  })
})

describe('结构闸门：launcher 的 batch 通道真的消费文件参数展开（7f48eb16）', () => {
  /** 剥注释后再判：注释里提到展开不算接线 */
  const stripComments = (src: string): string =>
    src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')

  /**
   * 判定：batch 的 stdin 必须来自一次"展开"调用。
   * 认新旧形状：expandDescFileInBatch（旧转发名）/ expandFileFlagsInBatch（单源名）；
   * revert 成 `const stdin = rawStdin` 直通、或把消费整段删掉 → 判违规。
   */
  const judge = (launcherSrc: string): boolean =>
    /stdin\s*=\s*[Ee]xpand\w*\(\s*[\w.[\]]*\s*,\s*rawStdin\s*\)|stdin\s*=\s*[Ee]xpand\w*\(\s*rawStdin\s*\)/.test(
      stripComments(launcherSrc)
    )

  it('batch 的 stdin 必须来自 expand* 展开（删掉这行消费就回到静默丢正文）', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../../src/cli/launcher.ts'), 'utf8')
    expect(
      judge(src),
      'launcher 的 batch 通道没把 stdin 过文件参数展开 —— --desc-file 会静默丢正文（7f48eb16 回潮）'
    ).toBe(true)
  })

  it('反向验证：喂"stdin 直通"的假源码被判违规（闸门认得出回潮形态）', () => {
    expect(judge('const stdin = expandDescFileInBatch(argv, rawStdin)'), '旧形状被误判违规').toBe(true)
    expect(judge('const stdin = expandFileFlagsInBatch(argv, rawStdin)'), '新形状被误判违规').toBe(true)
    expect(judge('const stdin = rawStdin'), 'stdin 直通没被判出来 —— 闸门失效').toBe(false)
    expect(judge(''), '消费删光了还是绿 —— 闸门失效').toBe(false)
  })
})
