import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '../../../src/main/database/migrations'
import { executeOne } from '../../../src/main/cli/commands'
import { TodoRepository } from '../../../src/main/database/todo.repository'
import { CategoryRepository } from '../../../src/main/database/category.repository'
import { ProjectRepository } from '../../../src/main/database/project.repository'
import { ReleaseRepository } from '../../../src/main/database/release.repository'
import { AgentRepository } from '../../../src/main/database/agent.repository'
import { NotificationRepository } from '../../../src/main/database/notification.repository'
import { CommentRepository } from '../../../src/main/database/comment.repository'
import { EventsRepository } from '../../../src/main/database/events.repository'

const db = new Database(':memory:')
vi.mock('../../../src/main/database/index', () => ({ getDatabase: () => db }))

/**
 * 发版对账的两个差集（卡 `c291b93a`）
 *
 * ## 它治的病（1.0.111 实测）
 *
 * `dp release show 1.0.111 --project DeskPartner` 回 `todoCount = 0`，
 * 而同一版的摘要里写着「UX 走查②组九张卡」—— 九张卡一张都没标版本。
 * 登记摘要、highlights、`tested=yes` 全都在，唯独关联为空，
 * **而没有任何一步因此变红**：登记校验只看"有没有摘要"。
 *
 * ## 判据
 *
 * - 硬 1：窗口（上一版之后）里已收口、却没标任何版本的卡 → 非空即对不上账；
 * - 硬 2：卡标了某版本号、该版本却没登记 → 非空即对不上账；
 * - 软：本版零卡 → 只报不拦（1.0.106 就是合法的零卡版本）。
 *
 * ⭐ 反向验证：把 `audit()` 里的 `unmarked` 查询直接返回 `[]` → 第 2/3 条用例变红；
 * 把窗口下界去掉（全历史）→ 第 4 条的"零卡但干净"会红（历史漏标把那版也拖红）。
 */
describe('发版对账：版本登记 vs 卡片标注（c291b93a）', () => {
  let todos: TodoRepository
  let releases: ReleaseRepository
  let projects: ProjectRepository
  let projectId = ''

  const V1_SHIPPED = '2026-01-01T00:00:00.000Z'
  const V2_SHIPPED = '2026-02-01T00:00:00.000Z'

  const mkCtx = () =>
    ({
      deps: {
        todoRepo: todos,
        commentRepo: new CommentRepository(),
        categoryRepo: new CategoryRepository(),
        projectRepo: projects,
        releaseRepo: releases,
        memoRepo: { list: () => [], add: () => ({}), get: () => null },
        settingsRepo: { get: () => ({}) },
        agentRepo: new AgentRepository(),
        notificationRepo: new NotificationRepository(),
        events: new EventsRepository(),
        telemetry: { record: () => {} }
      },
      meta: { version: 'test', dbPath: ':memory:', schemaVersion: 99, via: 'pipe' },
      interactive: false,
      actor: 'agent:carol'
    }) as never

  /** 造一张卡并直接钉死 completed_at（窗口判定按这个字段走） */
  const card = (opts: {
    title?: string
    status?: 'todo' | 'done'
    fixedIn?: string | null
    completedAt?: string
  }) => {
    const t = todos.create({
      title: opts.title ?? '一张卡',
      projectId,
      createdBy: 'agent:carol',
      status: opts.status ?? 'done',
      ...(opts.fixedIn ? { fixedInVersion: opts.fixedIn } : {})
    } as never)
    if (opts.completedAt) {
      db.prepare('UPDATE todos SET completed_at = ? WHERE id = ?').run(opts.completedAt, t.id)
    }
    return t
  }

  beforeAll(() => {
    runMigrations(db)
  })

  beforeEach(() => {
    for (const t of ['todos', 'releases', 'todo_comments', 'todo_transitions', 'projects', 'categories']) {
      db.prepare(`DELETE FROM ${t}`).run()
    }
    new CategoryRepository().create({ name: '默认', color: '#111', sortOrder: 0 })
    projects = new ProjectRepository()
    projectId = projects.create({ name: 'P' }).id
    todos = new TodoRepository()
    releases = new ReleaseRepository()
    releases.create({ version: '1.0.1', projectId, shippedAt: V1_SHIPPED, summary: '上一版' } as never)
    releases.create({ version: '1.0.2', projectId, shippedAt: V2_SHIPPED, summary: '这一版' } as never)
  })

  it('一致：窗口内收口的卡都标了本版', () => {
    card({ fixedIn: '1.0.2', completedAt: '2026-01-15T00:00:00.000Z' })
    card({ fixedIn: '1.0.2', completedAt: '2026-01-20T00:00:00.000Z' })
    const a = releases.audit(projectId, '1.0.2')
    expect(a.consistent).toBe(true)
    expect(a.unmarked).toEqual([])
    expect(a.empty).toEqual([])
    expect(a.message).toContain('一致')
  })

  it('故意漏标一张 → 对不上账（这就是 1.0.111 的形状）', () => {
    card({ fixedIn: '1.0.2', completedAt: '2026-01-15T00:00:00.000Z' })
    const forgotten = card({ completedAt: '2026-01-16T00:00:00.000Z' })
    const a = releases.audit(projectId, '1.0.2')
    expect(a.consistent).toBe(false)
    expect(a.unmarked.map((x) => x.id)).toEqual([forgotten.id])
    expect(a.message).toContain('没标版本')
  })

  it('本版零卡 + 窗口里有做完的卡 → 零卡线索与漏标同时出现（1.0.111 实况）', () => {
    card({ completedAt: '2026-01-16T00:00:00.000Z' })
    const a = releases.audit(projectId, '1.0.2')
    expect(a.empty).toEqual(['1.0.2'])
    expect(a.unmarked).toHaveLength(1)
    expect(a.consistent).toBe(false)
  })

  it('零卡但窗口里没有漏标的卡 → 一致（1.0.106 那种合法零卡版本不许被拦）', () => {
    // 上一版之前的漏标属于历史账，不在窗口内
    card({ completedAt: '2025-12-01T00:00:00.000Z' })
    const a = releases.audit(projectId, '1.0.2')
    expect(a.empty).toEqual(['1.0.2'])
    expect(a.unmarked, '窗口从上一版算起 —— 历史漏标不该让每一版都红').toEqual([])
    expect(a.consistent).toBe(true)
  })

  it('卡标了没登记的版本号 → 对不上账（先标卡、后忘了登记）', () => {
    card({ fixedIn: '1.0.9', completedAt: '2026-01-15T00:00:00.000Z' })
    const a = releases.audit(projectId, '1.0.9')
    expect(a.unregistered).toEqual(['1.0.9'])
    expect(a.consistent).toBe(false)
    expect(a.message).toContain('没有登记')
  })

  it('没标任何版本号、也没登记的版本 → 报"版本不存在"（对账没有对象）', () => {
    expect(() => releases.audit(projectId, '1.0.9')).toThrow(/版本不存在/)
  })

  it('CLI：release audit 能跑通，不带 --version 时对最新一版', async () => {
    card({ fixedIn: '1.0.2', completedAt: '2026-01-15T00:00:00.000Z' })
    const r = (await executeOne(mkCtx(), ['release', 'audit', '--project', 'P'])) as {
      ok?: boolean
      data?: { version: string; consistent: boolean }
    }
    expect(r.ok).toBe(true)
    expect(r.data!.version).toBe('1.0.2')
    expect(r.data!.consistent).toBe(true)
  })

  it('只在本项目内对账：另一个项目的同名版本不算（a2ea95f8）', () => {
    const other = projects.create({ name: 'Q' }).id
    releases.create({ version: '1.0.2', projectId: other, shippedAt: V2_SHIPPED } as never)
    const orphan = todos.create({
      title: '别人的卡',
      projectId: other,
      createdBy: 'agent:carol',
      status: 'done'
    } as never)
    db.prepare('UPDATE todos SET completed_at = ? WHERE id = ?').run('2026-01-16T00:00:00.000Z', orphan.id)
    const a = releases.audit(projectId, '1.0.2')
    expect(a.unmarked.map((x) => x.id)).not.toContain(orphan.id)
  })
})
