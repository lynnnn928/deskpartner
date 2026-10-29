import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '../../../src/main/database/migrations'
import { buildReleaseAddArgs } from '../../../scripts/lib/release-register.mjs'

const db = new Database(':memory:')
vi.mock('../../../src/main/database/index', () => ({
  getDatabase: () => db
}))

const { ReleaseRepository } = await import('../../../src/main/database/release.repository')
const { ProjectRepository } = await import('../../../src/main/database/project.repository')
const { executeOne } = await import('../../../src/main/cli/commands')

const releaseRepo = new ReleaseRepository()
const projectRepo = new ProjectRepository()

const ctx = {
  deps: {
    todoRepo: {} as never,
    categoryRepo: {} as never,
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
    schemaVersion: 32,
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
  db.exec('DELETE FROM projects')
  projectRepo.create({ name: 'DeskPartner' })
})

/**
 * 发版事实不记录测试跑没跑（1.0.75 修 `065dcde4`）
 *
 * 病根：发版链 `--skip-tests` 只在**终端**打一行"没过测试闸门"，发版后无从查证。
 * 验收方（Carol f6c186b8）想核"测试默认跑"没有任何出口 ——
 * "这个产物过没跑测试"只活在发版那个人的终端历史里，换个验收人就断了。
 *
 * 修法：releases 表加 tested 列（yes/no/skipped/NULL），发版链登记时传真实值。
 *
 * 判据（卡面原文）：**releases 表里每行能答「这版跑没跑测试」，
 * --skip-tests 发的版事后能被认出来。** 且历史行 NULL 不编造。
 */
describe('releases.tested：测试事实进登记（065dcde4）', () => {
  it('发版链把测试事实传进 release add：--skip-tests → skipped，正常 → yes', () => {
    const skipped = buildReleaseAddArgs({
      project: 'DeskPartner',
      version: '1.0.75',
      summary: 'x',
      shippedAt: '2026-10-08T00:00:00Z',
      tested: 'skipped'
    })
    expect(skipped).toContain('--tested')
    expect(skipped[skipped.indexOf('--tested') + 1]).toBe('skipped')

    const tested = buildReleaseAddArgs({ project: 'DeskPartner', version: '1.0.75', summary: 'x', tested: 'yes' })
    expect(tested[tested.indexOf('--tested') + 1]).toBe('yes')
  })

  it('发版链不传 tested 时**不带** --tested（不传 = 不知道，不编造成 yes）', () => {
    const args = buildReleaseAddArgs({ project: 'DeskPartner', version: '1.0.75', summary: 'x' })
    expect(args).not.toContain('--tested')
  })

  it('buildReleaseAddArgs 拒绝坏值（别把拼错的测试事实写进登记）', () => {
    expect(() =>
      buildReleaseAddArgs({ project: 'DeskPartner', version: '1.0.75', summary: 'x', tested: 'true' as never })
    ).toThrow(/yes \/ no \/ skipped/)
  })

  it('--skip-tests 发的版事后能被认出来：release show 回出 tested=skipped', async () => {
    await run([
      'release', 'add', '--project', 'DeskPartner', '--version', '9.0.1', '--summary', '跳过测试发的',
      '--shipped-at', '2026-10-08T00:00:00Z', '--tested', 'skipped'
    ])
    const r = (await run(['release', 'show', '9.0.1', '--project', 'DeskPartner'])) as {
      ok: boolean
      data: { tested?: unknown }
    }
    expect(r.ok).toBe(true)
    expect(r.data.tested, '验收方 dp release show 必须能认出这版没过测试闸门').toBe('skipped')
  })

  it('跑了且过 → yes 落库并可查', async () => {
    await run(['release', 'add', '--project', 'DeskPartner', '--version', '9.0.2', '--summary', 's', '--tested', 'yes'])
    const r = (await run(['release', 'show', '9.0.2', '--project', 'DeskPartner'])) as { data: { tested?: unknown } }
    expect(r.data.tested).toBe('yes')
  })

  it('不传 --tested 落 NULL，出口显式回 null（不知道 ≠ 跑过测试）', async () => {
    await run(['release', 'add', '--project', 'DeskPartner', '--version', '9.0.3', '--summary', '手工登记'])
    const r = (await run(['release', 'show', '9.0.3', '--project', 'DeskPartner'])) as { data: { tested?: unknown } }
    expect('tested' in r.data, 'tested 字段必须存在（缺字段会被当成"没有这个事实"）').toBe(true)
    expect(r.data.tested, '不许猜成 yes —— 没记就是没记').toBe(null)
  })

  it('release list 也带 tested（扫列表就能看出哪版跳过了测试）', async () => {
    await run(['release', 'add', '--project', 'DeskPartner', '--version', '9.0.4', '--summary', 's', '--tested', 'skipped'])
    const r = (await run(['release', 'list'])) as {
      data: { version: string; tested?: unknown }[]
    }
    const row = r.data.find((x) => x.version === '9.0.4')
    expect(row?.tested).toBe('skipped')
  })

  it('release update 能改、能 clear（回到"不知道"，不是塞个默认值）', async () => {
    await run(['release', 'add', '--project', 'DeskPartner', '--version', '9.0.5', '--summary', 's', '--tested', 'yes'])
    await run(['release', 'update', '9.0.5', '--project', 'DeskPartner', '--tested', 'no'])
    let r = (await run(['release', 'show', '9.0.5', '--project', 'DeskPartner'])) as { data: { tested?: unknown } }
    expect(r.data.tested).toBe('no')

    await run(['release', 'update', '9.0.5', '--project', 'DeskPartner', '--tested', 'clear'])
    r = (await run(['release', 'show', '9.0.5', '--project', 'DeskPartner'])) as { data: { tested?: unknown } }
    expect(r.data.tested).toBe(null)
  })

  it('坏值进不了库：CLI 拒绝、库里坏值读回 null（不编造）', async () => {
    const bad = (await run([
      'release', 'add', '--project', 'DeskPartner', '--version', '9.0.6', '--summary', 's', '--tested', 'true'
    ])) as { ok: boolean; errorCode?: string }
    expect(bad.ok, '枚举外的 --tested 必须被拒').toBe(false)

    // 直接写一行坏值模拟历史脏数据：读出必须归 null，不能原样透传
    // （project_id 必填是 a2ea95f8 之后的口径 —— 坏的是 tested 值，不是归属）
    const pid = projectRepo.list().find((p) => p.name === 'DeskPartner')!.id
    db.prepare(
      'INSERT INTO releases (version, project_id, shipped_at, summary, highlights, created_at, tested) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('9.0.7', pid, null, 's', '[]', '2026-10-08T00:00:00Z', 'garbage')
    const r = (await run(['release', 'show', '9.0.7', '--project', 'DeskPartner'])) as { data: { tested?: unknown } }
    expect(r.data.tested, '坏值归 null（不知道），不透传也不猜').toBe(null)
  })

  it('schema 里 release add 的 --tested 参数可见（能力没写进说明书等于没有）', async () => {
    const r = (await run(['schema'])) as {
      data: {
        commands: {
          name: string
          args: { flag: string; enum?: string[] }[]
        }[]
      }
    }
    const add = r.data.commands.find((c) => c.name === 'release add')
    const flag = add?.args.find((a) => a.flag === '--tested')
    expect(flag, 'schema 的 release add 必须带 --tested').toBeTruthy()
    expect(flag!.enum).toEqual(['yes', 'no', 'skipped'])
  })
})
