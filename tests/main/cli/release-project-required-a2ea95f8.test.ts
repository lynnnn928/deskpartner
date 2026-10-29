import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runMigrations } from '../../../src/main/database/migrations'
import { buildReleaseAddArgs } from '../../../scripts/lib/release-register.mjs'

const db = new Database(':memory:')
vi.mock('../../../src/main/database/index', () => ({
  getDatabase: () => db
}))

const { ReleaseRepository } = await import('../../../src/main/database/release.repository')
const { ProjectRepository } = await import('../../../src/main/database/project.repository')
const { TodoRepository } = await import('../../../src/main/database/todo.repository')
const { CategoryRepository } = await import('../../../src/main/database/category.repository')
const { executeOne } = await import('../../../src/main/cli/commands')

const releaseRepo = new ReleaseRepository()
const projectRepo = new ProjectRepository()
const todoRepo = new TodoRepository()
const categoryRepo = new CategoryRepository()

const ctx = {
  deps: {
    todoRepo,
    categoryRepo,
    projectRepo,
    releaseRepo,
    memoRepo: {} as never,
    settingsRepo: {} as never,
    agentRepo: {} as never,
    events: { append: vi.fn() },
    telemetry: { record: vi.fn(), stats: vi.fn(), query: vi.fn(), clear: vi.fn() }
  },
  meta: {
    version: 'test',
    dbPath: ':memory:',
    schemaVersion: 33,
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
})

beforeEach(() => {
  db.exec('DELETE FROM releases')
  db.exec('DELETE FROM todos')
  db.exec('DELETE FROM todo_categories')
  db.exec('DELETE FROM projects')
  projectRepo.create({ name: 'DeskPartner' })
})

/**
 * 版本归项目下（a2ea95f8，主用户 10-09）：「版本应该是项目下的二级概念」
 *
 * 病根：releases.project_id 可空、`release add` 的 --project 可选 ——
 * 于是 4 个已登记版本（1.0.71-1.0.75）全没挂项目，界面上看不出"谁发的版"。
 *
 * 修法（归属必填走代码层校验，同 v16 项目必填的判据，不动列约束）：
 *   ① CLI `release add` 的 --project 必填，不传停在入口；
 *   ② 库层 create/update 双双校验 —— 界面 / IPC 绕过 CLI 也拦得住；
 *   ③ **(项目, 版本号) 是定位键、不支持改归属**（要挪项目只能删了重建）；
 *      且版本空间**按项目独立**（主用户拍板：「各项目的版本空间独立了」）——
 *      跨项目同名版本是常态，唯一性只管到项目内；
 *   ④ 发版链 buildReleaseAddArgs 同步必填 —— 否则发版收尾登记会被卡；
 *   ⑤ 版本视图按项目分组（版本长在项目下，不是一列平铺版本号）。
 *
 * 判据（卡面）：界面上版本挂在项目下看得见；不挂项目的版本进不来。
 */
describe('版本归项目下：归属必填（a2ea95f8）', () => {
  describe('CLI 入口', () => {
    it('不传 --project 被拒（版本不挂项目不登记）', async () => {
      const r = await run(['release', 'add', '--version', '1.0.76'])
      expect(r.ok).toBe(false)
      expect(r.code).toBe(2)
      expect(String(r.message)).toMatch(/project/i)
    })

    it('空串 --project 同样被拒（不是"传了就行"）', async () => {
      const r = await run(['release', 'add', '--version', '1.0.76', '--project', '   '])
      expect(r.ok).toBe(false)
      expect(r.code).toBe(2)
    })

    it('传 --project 落库：release show 按 (项目, 版本号) 回出', async () => {
      await run(['release', 'add', '--project', 'DeskPartner', '--version', '1.0.76'])
      const r = (await run(['release', 'show', '1.0.76', '--project', 'DeskPartner'])) as {
        ok: boolean
        data: { projectId: string | null }
      }
      expect(r.ok).toBe(true)
      expect(r.data.projectId).toBeTruthy()
    })

    it('项目不存在时报错并列出现有项目（不静默建成无归属）', async () => {
      const r = await run(['release', 'add', '--project', '不存在的项目', '--version', '1.0.76'])
      expect(r.ok).toBe(false)
      expect(String(r.message)).toMatch(/DeskPartner/)
    })
  })

  describe('库层最后一道（绕过 CLI 也拦得住）', () => {
    it('create 不给 projectId 直接抛', () => {
      expect(() =>
        releaseRepo.create({ version: '9.9.1', projectId: '' as never })
      ).toThrow(/projectId/)
      expect(() =>
        releaseRepo.create({ version: '9.9.1' as never })
      ).toThrow(/projectId/)
    })

    it('update 的 projectId 是定位键（空值被拒，定位不了就不改）', async () => {
      await run(['release', 'add', '--project', 'DeskPartner', '--version', '9.9.2'])
      expect(() =>
        releaseRepo.update({ version: '9.9.2', projectId: '' as never })
      ).toThrow(/projectId/)
    })

    it('update 按 (项目, 版本号) 定位：拿别的项目名去改 = 定位不到（挪不了项目）', async () => {
      projectRepo.create({ name: '知彼' })
      await run(['release', 'add', '--project', 'DeskPartner', '--version', '9.9.3', '--summary', '原'])
      // 知彼下没有 9.9.3 —— 不是"把 DeskPartner 的版本挪走"，是定位失败
      const r = await run(['release', 'update', '9.9.3', '--project', '知彼', '--summary', '改'])
      expect(r.ok).toBe(false)
      expect(r.code).toBe(3)
      const pid = projectRepo.list().find((p) => p.name === 'DeskPartner')!.id
      expect(releaseRepo.getByProjectAndVersion(pid, '9.9.3')?.summary).toBe('原')
    })
  })

  describe('发版链不被必填卡住', () => {
    it('buildReleaseAddArgs 缺 project 抛（拼 argv 时就挡，不是打完包才炸）', () => {
      expect(() => buildReleaseAddArgs({ version: '1.0.76', summary: 's' })).toThrow(/缺 --project/)
    })

    it('带 project 时 argv 里有 --project（发版收尾登记能挂上项目）', () => {
      const args = buildReleaseAddArgs({ project: 'DeskPartner', version: '1.0.76', summary: 's' })
      expect(args[args.indexOf('--project') + 1]).toBe('DeskPartner')
    })
  })
})

describe('版本空间按项目独立（选项二，a2ea95f8）', () => {
  /**
   * 主用户拍板（10-09）：「各项目的版本空间独立了，这当然是更合理的，也是我想要的」
   *
   * 判据：版本号跨项目撞号是常态（「总有一天会撞上同一个版本号」）——
   * 两个项目各有自己的 1.0.76 互不冲突；唯一性只管到项目内。
   * 反查（detail 关联卡、delete 的 orphanTodos）都在项目语境内，不许串台。
   */
  const pidOf = (name: string) => projectRepo.list().find((p) => p.name === name)!.id

  it('两个项目各有自己的 1.0.76，互不冲突（登记都成功、各回各的）', async () => {
    projectRepo.create({ name: '知彼' })
    await run(['release', 'add', '--project', 'DeskPartner', '--version', '1.0.76', '--summary', 'DP 的 1.0.76'])
    await run(['release', 'add', '--project', '知彼', '--version', '1.0.76', '--summary', '知彼 的 1.0.76'])
    expect(releaseRepo.getByProjectAndVersion(pidOf('DeskPartner'), '1.0.76')?.summary).toBe('DP 的 1.0.76')
    expect(releaseRepo.getByProjectAndVersion(pidOf('知彼'), '1.0.76')?.summary).toBe('知彼 的 1.0.76')
  })

  it('同项目下同名版本仍报重复（唯一性是项目内的）', async () => {
    await run(['release', 'add', '--project', 'DeskPartner', '--version', '1.0.76', '--summary', '原'])
    const r = await run(['release', 'add', '--project', 'DeskPartner', '--version', '1.0.76', '--summary', '新'])
    expect(r.ok).toBe(false)
    expect(String(r.message)).toMatch(/已登记过/)
  })

  it('detail 的关联卡在项目语境内：各收各项目的卡（不串台）', async () => {
    projectRepo.create({ name: '知彼' })
    const cat = categoryRepo.create({ name: '修复', color: '#5B8FF9', sortOrder: 0 })
    todoRepo.create({
      title: 'DP 的卡',
      projectId: pidOf('DeskPartner'),
      categoryIds: [cat.id],
      status: 'done',
      fixedInVersion: '1.0.76'
    })
    todoRepo.create({
      title: '知彼 的卡',
      projectId: pidOf('知彼'),
      categoryIds: [cat.id],
      status: 'done',
      fixedInVersion: '1.0.76'
    })
    await run(['release', 'add', '--project', 'DeskPartner', '--version', '1.0.76'])
    await run(['release', 'add', '--project', '知彼', '--version', '1.0.76'])

    const dp = await run(['release', 'show', '1.0.76', '--project', 'DeskPartner'])
    expect(dp.ok).toBe(true)
    expect((dp.data as { todos: { title: string }[] }).todos.map((t) => t.title)).toEqual(['DP 的卡'])

    const zb = await run(['release', 'show', '1.0.76', '--project', '知彼'])
    expect(zb.ok).toBe(true)
    expect((zb.data as { todos: { title: string }[] }).todos.map((t) => t.title)).toEqual(['知彼 的卡'])
  })

  it('delete 的项目语境内保护：只阻止本项目的关联卡（别项目同名版本不串台）', async () => {
    projectRepo.create({ name: '知彼' })
    const cat = categoryRepo.create({ name: '修复', color: '#5B8FF9', sortOrder: 0 })
    todoRepo.create({
      title: 'DP 的卡',
      projectId: pidOf('DeskPartner'),
      categoryIds: [cat.id],
      fixedInVersion: '1.0.76'
    })
    todoRepo.create({
      title: '知彼 的卡',
      projectId: pidOf('知彼'),
      categoryIds: [cat.id],
      fixedInVersion: '1.0.76'
    })
    await run(['release', 'add', '--project', 'DeskPartner', '--version', '1.0.76'])
    await run(['release', 'add', '--project', '知彼', '--version', '1.0.76'])

    const r = await run(['release', 'rm', '1.0.76', '--project', 'DeskPartner', '--yes'])
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/仍关联 1 条事项/)
    expect(releaseRepo.getByProjectAndVersion(pidOf('DeskPartner'), '1.0.76')).not.toBeNull()
    expect(releaseRepo.getByProjectAndVersion(pidOf('知彼'), '1.0.76')).not.toBeNull()
  })
})

// ── 界面：版本长在项目下（源码契约，stripComments 防注释假绿）──
const src = readFileSync(
  join(process.cwd(), 'src', 'renderer', 'components', 'releases', 'ReleasesView.tsx'),
  'utf8'
)
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

describe('版本视图按项目分组（a2ea95f8）', () => {
  it('清单按 projectId 分组渲染，组头是项目名（不是平铺版本号）', () => {
    // 分组数据结构存在且按项目归组
    expect(code).toMatch(/grouped\s*=\s*useMemo/)
    expect(code).toMatch(/byProject\.set\(/)
    // 组头渲染项目名与项目色点
    expect(code).toMatch(/g\.name/)
    expect(code).toMatch(/backgroundColor:\s*g\.color/)
    // 组内才是版本条目
    expect(code).toMatch(/g\.items\.map\(/)
    // **接线**：渲染入口必须吃 grouped —— 零件都在但入口退回平铺是假绿（反向验证实抓过一次）
    expect(code).toMatch(/\{\s*grouped\.map\(\(g\)/)
  })

  /**
   * 反向验证：把入口换回 `releases.map(`（平铺）就红 ——
   * 断言打在**接线**上，不是零件清单上。
   */
  it('不是平铺列表（防退回）', () => {
    expect(code).not.toMatch(/releases\.map\(/)
  })
})
