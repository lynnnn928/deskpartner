import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '../../../src/main/database/migrations'
import { parseFlags } from '../../../src/main/cli/commands'

const db = new Database(':memory:')
vi.mock('../../../src/main/database/index', () => ({
  getDatabase: () => db
}))
vi.mock('../../../src/cli/credentials', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/cli/credentials')>()
  return { ...actual, writeCredential: vi.fn() }
})

let seq = 0
vi.mock('uuid', () => ({ v4: () => `rel-uuid-${++seq}` }))

const { TodoRepository } = await import('../../../src/main/database/todo.repository')
const { CategoryRepository } = await import('../../../src/main/database/category.repository')
const { ProjectRepository } = await import('../../../src/main/database/project.repository')
const { MemoRepository } = await import('../../../src/main/database/memo.repository')
const { SettingsRepository } = await import('../../../src/main/database/settings.repository')
const { AgentRepository } = await import('../../../src/main/database/agent.repository')
const { ReleaseRepository } = await import('../../../src/main/database/release.repository')
const { executeOne } = await import('../../../src/main/cli/commands')

const todoRepo = new TodoRepository()
const categoryRepo = new CategoryRepository()
const projectRepo = new ProjectRepository()
const memoRepo = new MemoRepository()
const settingsRepo = new SettingsRepository()
const agentRepo = new AgentRepository()
const releaseRepo = new ReleaseRepository()

const ctx = {
  deps: {
    todoRepo,
    categoryRepo,
    projectRepo,
    releaseRepo,
    memoRepo,
    settingsRepo,
    agentRepo,
    events: { append: vi.fn() },
    telemetry: { record: vi.fn(), stats: vi.fn(), query: vi.fn(), clear: vi.fn() }
  },
  meta: {
    version: 'test',
    dbPath: ':memory:',
    schemaVersion: 31,
    busyTimeoutMs: 5000,
    channels: ['headless' as const],
    via: 'headless' as const,
    startedAt: Date.now()
  },
  interactive: true
}

const run = (args: string[]) => executeOne(ctx as never, args)

beforeAll(() => {
  runMigrations(db)
  agentRepo.register({ id: 'agent:alice', displayName: 'Alice' })
})

beforeEach(() => {
  db.exec('DELETE FROM releases')
  db.exec('DELETE FROM todos')
  db.exec('DELETE FROM todo_categories')
  db.exec('DELETE FROM projects')
  projectRepo.create({ name: 'DeskPartner' })
})

/**
 * release 命令组（1.0.73）
 *
 * 这一组测试的重点不是"能不能建一条记录"，而是**三个容易静默出错的点**：
 * ① `--highlight` 可重复传（覆盖式赋值会静默丢掉前面几条）；
 * ② 版本登记与事项打标**不联动**（联动了就查不出谁改的归属）；
 * ③ 删登记不带走事项上的版本号（那是事项自己的事实）。
 */
describe('release 命令组（1.0.73）', () => {
  describe('--highlight 可重复传', () => {
    it('重复传多次，每条原样保留（不被覆盖、不被逗号切开）', async () => {
      const r = await run([
        'release',
        'add',
        '--project',
        'DeskPartner',
        '--version',
        '1.0.73',
        '--highlight',
        '第一条：releases 表',
        '--highlight',
        '第二条：含、逗号与，全角逗号的内容',
        '--highlight',
        '第三条'
      ])
      expect(r.ok).toBe(true)
      expect(r.data.highlights).toEqual([
        '第一条：releases 表',
        '第二条：含、逗号与，全角逗号的内容',
        '第三条'
      ])
    })

    /**
     * 这条是**反向验证**：把 `repeat` 拿掉（退回单值覆盖）就会红。
     * 判据：多条并列的内容被静默合成一条，是"看起来成功"的失效。
     */
    it('三条不是一条（防覆盖式赋值回归）', async () => {
      const r = await run(['release', 'add', '--project', 'DeskPartner', '--version', '1.0.74', '--highlight', 'A', '--highlight', 'B'])
      expect(r.data.highlights).toHaveLength(2)
    })

    it('单条也能用（不因为改成重复传就要求至少两条）', async () => {
      const r = await run(['release', 'add', '--project', 'DeskPartner', '--version', '1.0.75', '--highlight', '只有一条'])
      expect(r.data.highlights).toEqual(['只有一条'])
    })

    it('空要点被过滤掉，不落一个空字符串进 highlights', async () => {
      const r = await run([
        'release',
        'add',
        '--project',
        'DeskPartner',
        '--version',
        '1.0.76',
        '--highlight',
        '  ',
        '--highlight',
        '有内容'
      ])
      expect(r.data.highlights).toEqual(['有内容'])
    })

    it('--highlight=X 等号写法也进数组（与空格写法同一语义）', async () => {
      const r = await run(['release', 'add', '--project', 'DeskPartner', '--version', '1.0.77', '--highlight=A', '--highlight=B'])
      expect(r.data.highlights).toEqual(['A', 'B'])
    })
  })

  describe('release add', () => {
    it('登记后 detail 能读回（登记与读取同源）', async () => {
      await run(['release', 'add', '--project', 'DeskPartner', '--version', '1.0.73', '--summary', '版本对象'])
      const got = await run(['release', 'show', '1.0.73', '--project', 'DeskPartner'])
      expect(got.ok).toBe(true)
      expect(got.data.summary).toBe('版本对象')
      expect(got.data.todoCount).toBe(0)
    })

    it('可以关联项目（按名字）', async () => {
      const r = await run(['release', 'add', '--version', '1.0.73', '--project', 'DeskPartner'])
      expect(r.data.projectId).toBeTruthy()
    })

    it('项目名写错时报错并列出现有项目，不静默建成无归属', async () => {
      const r = await run(['release', 'add', '--version', '1.0.73', '--project', 'DeskPartnre'])
      expect(r.ok).toBe(false)
      expect(r.message).toMatch(/DeskPartner/)
    })

    it('不传 --project 报用法错误（版本必挂项目，a2ea95f8）', async () => {
      const r = await run(['release', 'add', '--version', '1.0.73'])
      expect(r.ok).toBe(false)
      expect(r.code).toBe(2)
      expect(String(r.message)).toMatch(/project/)
    })

    it('回执自报该类目下已有的关联卡数，并在 note 里指路下一步', async () => {
      const r = await run(['release', 'add', '--project', 'DeskPartner', '--version', '1.0.73'])
      expect(r.data.linkedTodos).toBe(0)
      expect(r.data.note).toMatch(/fixed-in/)
    })

    it('版本号重复登记报错（不静默覆盖已有摘要）', async () => {
      await run(['release', 'add', '--project', 'DeskPartner', '--version', '1.0.73', '--summary', '原说法'])
      const r = await run(['release', 'add', '--project', 'DeskPartner', '--version', '1.0.73', '--summary', '新说法'])
      expect(r.ok).toBe(false)
      expect(String(r.message)).toMatch(/已登记过/)
      const pid = projectRepo.list().find((p) => p.name === 'DeskPartner')!.id
      expect(releaseRepo.getByProjectAndVersion(pid, '1.0.73')?.summary).toBe('原说法')
    })

    it('不传 --version 报用法错误', async () => {
      const r = await run(['release', 'add', '--summary', 'x'])
      expect(r.ok).toBe(false)
      expect(r.code).toBe(2)
    })
  })

  describe('release list / show', () => {
    it('列表带出每版的关联卡数（不用逐条 show）', async () => {
      await run(['release', 'add', '--project', 'DeskPartner', '--version', '1.0.72'])
      await run(['release', 'add', '--project', 'DeskPartner', '--version', '1.0.73'])
      const r = await run(['release', 'list'])
      expect(r.data.map((x: { version: string }) => x.version)).toEqual(['1.0.73', '1.0.72'])
      expect(r.data[0]).toHaveProperty('todoCount')
    })

    it('--project 过滤拿得到（版本与项目关联的读法）', async () => {
      // 两个项目各发一版 —— 过滤要能分出"谁的版本"（版本必挂项目后更有意义）
      projectRepo.create({ name: '知彼' })
      await run(['release', 'add', '--version', '1.0.73', '--project', 'DeskPartner'])
      await run(['release', 'add', '--version', '0.9.0', '--project', '知彼'])
      const r = await run(['release', 'list', '--project', 'DeskPartner'])
      expect(r.data.map((x: { version: string }) => x.version)).toEqual(['1.0.73'])
    })

    it('show 一个没登记过的版本要报错并说明原因（不是返回空对象）', async () => {
      await run(['release', 'add', '--project', 'DeskPartner', '--version', '1.0.73'])
      const r = await run(['release', 'show', '1.0.50', '--project', 'DeskPartner'])
      expect(r.ok).toBe(false)
      expect(r.code).toBe(3) // not_found
      // 关键：说明书里要说清"事项可以标版本而不要求版本被登记"
      expect(String(r.message)).toMatch(/1\.0\.73/)
    })
  })

  describe('release update', () => {
    it('只改传进来的字段', async () => {
      await run([
        'release',
        'add',
        '--project',
        'DeskPartner',
        '--version',
        '1.0.73',
        '--summary',
        '旧摘要',
        '--highlight',
        '要点A'
      ])
      const r = await run(['release', 'update', '1.0.73', '--project', 'DeskPartner', '--summary', '新摘要'])
      expect(r.data.summary).toBe('新摘要')
      expect(r.data.highlights).toEqual(['要点A'])
    })

    it('--highlight 是整组替换，不是追加', async () => {
      await run(['release', 'add', '--project', 'DeskPartner', '--version', '1.0.73', '--highlight', '旧1', '--highlight', '旧2'])
      const r = await run(['release', 'update', '1.0.73', '--project', 'DeskPartner', '--highlight', '新只此一条'])
      expect(r.data.highlights).toEqual(['新只此一条'])
    })

    it('--project 是定位键不是改归属：版本挪不了项目（a2ea95f8）', async () => {
      // (项目, 版本号) 是版本的身份 —— update 的 --project 只用来定位"改谁"，
      // 拿另一个项目名去 update 会定位不到，而不是把版本"挪"过去
      projectRepo.create({ name: '知彼' })
      await run(['release', 'add', '--version', '1.0.73', '--project', 'DeskPartner', '--summary', '原'])
      const r = await run(['release', 'update', '1.0.73', '--project', '知彼', '--summary', '改'])
      expect(r.ok).toBe(false)
      expect(r.code).toBe(3) // not_found：知彼下没有 1.0.73
      // DeskPartner 的 1.0.73 原样没动（没被"挪走"也没被改）
      const pid = projectRepo.list().find((p) => p.name === 'DeskPartner')!.id
      expect(releaseRepo.getByProjectAndVersion(pid, '1.0.73')?.summary).toBe('原')
    })

    it('改不存在的版本报 not_found', async () => {
      const r = await run(['release', 'update', '9.9.9', '--project', 'DeskPartner', '--summary', 'x'])
      expect(r.ok).toBe(false)
      expect(r.code).toBe(3)
    })
  })

  describe('release rm', () => {
    it('缺 --yes 直接报用法错误（不做交互式确认）', async () => {
      await run(['release', 'add', '--project', 'DeskPartner', '--version', '1.0.73'])
      const r = await run(['release', 'rm', '1.0.73', '--project', 'DeskPartner'])
      expect(r.ok).toBe(false)
      expect(r.code).toBe(2)
      const pid = projectRepo.list().find((p) => p.name === 'DeskPartner')!.id
      expect(releaseRepo.getByProjectAndVersion(pid, '1.0.73')).not.toBeNull()
    })

    it('带 --yes 但仍有关联事项时拒绝删除并说明先解除关联', async () => {
      const proj = projectRepo.list()[0]
      const cat = categoryRepo.create({ name: '工作', color: '#1', sortOrder: 0 })
      todoRepo.create({
        title: '标了版本的卡',
        projectId: proj.id,
        categoryIds: [cat.id],
        status: 'done',
        fixedInVersion: '1.0.73'
      })
      await run(['release', 'add', '--project', 'DeskPartner', '--version', '1.0.73'])

      const r = await run(['release', 'rm', '1.0.73', '--project', 'DeskPartner', '--yes'])
      expect(r.ok).toBe(false)
      expect(r.message).toMatch(/先逐条解除|仍关联/)
      const pid = projectRepo.list().find((p) => p.name === 'DeskPartner')!.id
      expect(releaseRepo.getByProjectAndVersion(pid, '1.0.73')).not.toBeNull()
      expect(todoRepo.list().filter((t) => t.fixedInVersion === '1.0.73')).toHaveLength(1)
    })

    it('没有事项标着时不啰嗦 note', async () => {
      await run(['release', 'add', '--project', 'DeskPartner', '--version', '1.0.73'])
      const r = await run(['release', 'rm', '1.0.73', '--project', 'DeskPartner', '--yes'])
      expect(r.data.orphanTodos).toBe(0)
      expect(r.data.note).toBeUndefined()
    })
  })
})

/**
 * parseFlags 的 repeat 支持（1.0.73）
 *
 * 单独测这一层：`--highlight` 的行为由它决定，命令层只是消费结果。
 * 这里出错的表现是"少了几条要点"——不报错，只是内容没了。
 */
describe('parseFlags：repeat flag（1.0.73）', () => {
  const specs = [
    { flag: '--highlight', type: 'string' as const, repeat: true, desc: '' },
    { flag: '--version', type: 'string' as const, desc: '' }
  ]

  it('重复出现收集成数组，保持传入顺序', () => {
    const { flags } = parseFlags(['--version', '1.0.73', '--highlight', 'A', '--highlight', 'B'], specs)
    expect(flags['--highlight']).toEqual(['A', 'B'])
  })

  it('与单值 flag 互不干扰', () => {
    const { flags } = parseFlags(['--version', '1.0.73', '--highlight', 'A'], specs)
    expect(flags['--version']).toBe('1.0.73')
    expect(flags['--highlight']).toEqual(['A'])
  })

  it('值里含逗号不被切分（这正是 repeat 而不是 multi 的理由）', () => {
    const { flags } = parseFlags(['--highlight', '修了 A、B 两个坑，顺带清了 C'], specs)
    expect(flags['--highlight']).toEqual(['修了 A、B 两个坑，顺带清了 C'])
  })

  it('没传时不出现该键（而不是空数组，空数组会被误判成"传了但为空"）', () => {
    const { flags } = parseFlags(['--version', '1.0.73'], specs)
    expect(flags['--highlight']).toBeUndefined()
  })

  it('值里以 -- 开头但并非本命令的 flag 时，仍当值收下', () => {
    const { flags } = parseFlags(['--highlight', '--这不是flag'], specs)
    expect(flags['--highlight']).toEqual(['--这不是flag'])
  })
})
