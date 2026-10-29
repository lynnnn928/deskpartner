/**
 * GUI 收件箱与 CLI 收口到同一份读法（卡 `cba46119`）
 *
 * ## 它治的病
 *
 * 收件箱在 GUI 侧曾经是：**列表写死 500、角标与「全部已读」走 100000、
 * 分类 chip 与页头「未读 N」在渲染侧对那一页 `.filter`**。于是同一个「未读」是两个数，
 * 而 500 条之外的东西既列不出来、也不说。
 *
 * 副本实测（注入 600 条很旧的系统通知）：列表卡在 500（真实 649）、角标 633、
 * 页头 484 —— 差 149 条翻不到；chip「备忘」窗口内 457、真实 606；
 * 点一次「全部已读」清掉 633 条，其中 133 条当时看不见。
 *
 * ## 判据（与卡上四条一致）
 *
 * 1. 某个范围超过窗口时，界面能看出"还有更多"，并且能继续读（`truncated` / `nextOffset`）；
 * 2. 三个计数（角标 / 页头 / chip）与列表**同源**：同一份 WHERE、不含窗口；
 * 3. 「全部已读」清掉的条数**就是它宣称的范围**；
 * 4. chip 的数字是"这一类在**整个范围**里有多少条"，而不是窗口内。
 *
 * 前三张表是仓储层（`inboxPage` 就是界面拿到的那一份回执），最后一组是源码闸门：
 * 渲染侧不许再对一页去数、IPC 只许搬参数。
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { runMigrations } from '../../src/main/database/migrations'
import { NotificationRepository } from '../../src/main/database/notification.repository'
import { TodoRepository } from '../../src/main/database/todo.repository'
import { ProjectRepository } from '../../src/main/database/project.repository'

const db = new Database(':memory:')
vi.mock('../../src/main/database/index', () => ({ getDatabase: () => db }))

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8')

const SYSTEM_MEMOS = 600
const SYSTEM_REVIEWS = 30

let repo: NotificationRepository
let projectId: string
let otherProjectId: string
/** 系统范围（没有项目归属）：600 条很旧的备忘 + 30 条新的 review */
let systemIds: string[] = []
let projectIds: string[] = []
let otherProjectIds: string[] = []

describe('GUI 收件箱的窗口与计数（cba46119）', () => {
  beforeAll(() => {
    runMigrations(db)
    db.pragma('foreign_keys = OFF')
  })

  beforeEach(() => {
    for (const t of [
      'todos',
      'todo_categories',
      'todo_comments',
      'memos',
      'notifications',
      'projects',
      'categories'
    ]) {
      db.prepare(`DELETE FROM ${t}`).run()
    }
    // 事项必须落在某个分类下（`TodoRepository.create` 会解析分类），先铺一个默认分类
    db.prepare(
      "INSERT INTO categories (id, name, color, is_default, sort_order) VALUES ('c-inbox', '其他', '#5388F6', 1, 0)"
    ).run()
    const projects = new ProjectRepository()
    projectId = projects.create({ name: '收件箱项目' }).id
    otherProjectId = projects.create({ name: '另一个项目' }).id
    const todos = new TodoRepository()

    repo = new NotificationRepository()
    systemIds = []
    projectIds = []
    otherProjectIds = []

    // 系统范围：600 条"很早"的备忘（旧实现的 500 窗口会把它们整段挡在外面）
    const backdate = db.prepare('UPDATE notifications SET created_at = ? WHERE id = ?')
    const backfill = db.transaction(() => {
      for (let i = 0; i < SYSTEM_MEMOS; i++) {
        const id = repo.create({ type: 'memo', title: `旧备忘-${String(i).padStart(3, '0')}` }).id
        backdate.run(new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(), id)
        systemIds.push(id)
      }
    })
    backfill()
    for (let i = 0; i < SYSTEM_REVIEWS; i++) {
      systemIds.push(repo.create({ type: 'review', title: `系统-review-${i}` }).id)
    }

    // 项目范围：各挂一条事项，通知靠 ref_id 反查出项目
    for (let i = 0; i < 5; i++) {
      const todo = todos.create({
        title: `本项目事项-${i}`,
        projectId,
        createdBy: 'agent:alice'
      })
      projectIds.push(repo.create({ type: 'reminder', title: `本项目提醒-${i}`, refId: todo.id }).id)
    }
    for (let i = 0; i < 3; i++) {
      const todo = todos.create({
        title: `别项目事项-${i}`,
        projectId: otherProjectId,
        createdBy: 'agent:alice'
      })
      otherProjectIds.push(repo.create({ type: 'reminder', title: `别项目提醒-${i}`, refId: todo.id }).id)
    }
  })

  it('前提：系统范围 630 条，且这 630 条都排在那 30 条 review 之外的很早处', () => {
    expect(repo.countWithProject({ projectId: null })).toBe(SYSTEM_MEMOS + SYSTEM_REVIEWS)
    expect(repo.countWithProject({ projectId })).toBe(5)
    expect(repo.countWithProject({ projectId: otherProjectId })).toBe(3)
  })

  it('窗口不写死：--limit 500 只收窗口，命中数照实说（旧实现只回 500 且不说）', () => {
    const page = repo.inboxPage({ projectId: null, limit: 500 })
    expect(page.rows).toHaveLength(500)
    expect(page.returned).toBe(500)
    expect(page.matched, '命中总数不含窗口').toBe(630)
    expect(page.truncated).toBe(true)
    expect(page.nextOffset, '下一页从这里开始').toBe(500)
  })

  it('--offset 翻页：不重、不漏，读到底 truncated 变假', () => {
    const seen: string[] = []
    let offset = 0
    for (let i = 0; i < 10; i++) {
      const page = repo.inboxPage({ projectId: null, limit: 200, offset })
      expect(page.returned, `第 ${i + 1} 页`).toBe(Math.min(200, 630 - offset))
      seen.push(...page.rows.map((r) => r.id))
      if (!page.truncated) {
        expect(page.nextOffset).toBeNull()
        break
      }
      offset = page.nextOffset as number
    }
    expect(seen).toHaveLength(630)
    expect(new Set(seen).size, '同一页不该重复').toBe(630)
    expect(new Set(seen)).toEqual(new Set(systemIds))
  })

  it('分类筛选先于窗口：600 条备忘全在旧窗口之外，也照样数得出来', () => {
    const page = repo.inboxPage({ projectId: null, type: 'memo', limit: 500 })
    expect(page.matched, '整段在 500 之外 —— 旧实现对一页过滤只会给出一小撮').toBe(600)
    expect(page.returned).toBe(500)
    expect(page.nextOffset).toBe(500)

    const all = repo.inboxPage({ projectId: null, type: 'memo' })
    expect(all.rows).toHaveLength(600)
    expect(new Set(all.rows.map((r) => r.id))).toEqual(new Set(systemIds.slice(0, 600)))
  })

  it('判据 4：chip 的数字是"这一类在整个范围里有多少条"，且不受当前分类影响', () => {
    const byType = repo.inboxPage({ projectId: null }).byType
    expect(byType.memo?.total).toBe(600)
    expect(byType.review?.total).toBe(30)
    const filtered = repo.inboxPage({ projectId: null, type: 'memo' }).byType
    expect(filtered, '切到某一类之后，其它类的数字必须还在').toEqual(byType)
  })

  it('判据 2：三个计数与列表同源（同一份 WHERE、不含窗口）', () => {
    const page = repo.inboxPage({ projectId: null })
    const sum = Object.values(page.byType).reduce((n, c) => n + (c?.total ?? 0), 0)
    expect(sum, 'chip 加起来就是列表的命中总数').toBe(page.matched)
    expect(page.unread, '页头的未读 = 同一范围 ∩ 同一分类的未读').toBe(
      repo.countWithProject({ projectId: null, unreadOnly: true })
    )
    expect(page.unread, '角标（系统未读）与页头同一个数').toBe(repo.unreadSystemCount())

    const memoPage = repo.inboxPage({ projectId: null, type: 'memo' })
    expect(memoPage.unread).toBe(
      repo.countWithProject({ projectId: null, type: 'memo', unreadOnly: true })
    )
  })

  it('把一部分读掉之后，三个数一起跟着变（不是各数各的）', () => {
    for (const id of systemIds.slice(0, 100)) repo.markRead(id)
    const page = repo.inboxPage({ projectId: null })
    expect(page.unread).toBe(530)
    expect(repo.unreadSystemCount()).toBe(530)
    expect(page.byType.memo?.unread, 'chip 那一路也要跟上').toBe(500)
    expect(page.matched, '总数不受已读影响').toBe(630)
  })

  it('判据 3：「全部已读」清掉的就是它宣称的范围（系统 630 条，不碰项目）', () => {
    const cleared = repo.markSystemAllRead()
    expect(cleared, '系统范围共 630 条未读').toBe(630)
    expect(repo.unreadSystemCount()).toBe(0)
    expect(repo.countWithProject({ projectId, unreadOnly: true }), '项目范围原样未读').toBe(5)
    expect(repo.countWithProject({ projectId: otherProjectId, unreadOnly: true })).toBe(3)
  })

  it('项目页：先筛后限 —— limit 1 也照样说出这个项目有多少条', () => {
    const page = repo.inboxPage({ projectId, limit: 1 })
    expect(page.rows).toHaveLength(1)
    expect(page.rows[0].projectId).toBe(projectId)
    expect(page.matched, '命中数属于这个项目，不是全表').toBe(5)
    expect(page.byType.reminder?.total).toBe(5)
    expect(page.truncated).toBe(true)
  })

  it('「本类已读」走同一份范围：只清这一类，且只清这个项目', () => {
    expect(repo.markProjectRead(projectId, 'review'), '这个项目没有 review').toBe(0)
    expect(repo.countWithProject({ projectId, unreadOnly: true })).toBe(5)
    expect(repo.markProjectRead(projectId, 'reminder')).toBe(5)
    expect(repo.countWithProject({ projectId, unreadOnly: true })).toBe(0)
    expect(repo.countWithProject({ projectId: otherProjectId, unreadOnly: true }), '别的项目不受影响').toBe(3)
    expect(repo.unreadSystemCount(), '系统范围更不受影响').toBe(630)
  })

  it('listWithProjectPage().matched 与 countWithProject 是同一份 WHERE', () => {
    const queries = [
      { projectId: null },
      { projectId },
      { projectId: null, type: 'memo' as const },
      { projectId: null, unreadOnly: true },
      { projectId, type: 'reminder' as const, unreadOnly: true }
    ]
    for (const q of queries) {
      expect(repo.listWithProjectPage({ ...q, limit: 5 }).matched, JSON.stringify(q)).toBe(
        repo.countWithProject(q)
      )
    }
  })

  it('源码闸门：仓储里不许再有自己编的数字窗口', () => {
    const src = read('src/main/database/notification.repository.ts')
    // 注释里说明"此前是什么"是历史，不算代码 —— 只看真正会跑的那些行
    const code = src
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n')
    expect(code, '100000 那个数字窗口应当已经删掉').not.toContain('100000')
    expect(code, 'listWithProject(100000) 那种"先取一大批再筛"的老路').not.toContain('listWithProject(100000)')
    expect(src).toContain('inboxPage(')
  })

  it('源码闸门：IPC 只搬参数，形状与语义在仓储（这才接得上线）', () => {
    const src = read('src/main/ipc.ts')
    const at = src.indexOf("ipcMain.handle('notification:listWithProject'")
    expect(at, '通道不见了？').toBeGreaterThan(-1)
    const next = src.indexOf('ipcMain.handle(', at + 10)
    const handler = src.slice(at, next === -1 ? undefined : next)
    expect(handler, 'handler 必须走 inboxPage').toContain('inboxPage(')
    expect(handler, 'handler 不许自己拼计数（那正是刚才那种"两处各写一遍"）').not.toContain('countsByTypeWithProject')
    expect(handler).not.toContain('countWithProject(')
    // 角标口径没变（仍走仓储的 unreadSystemCount）；`reader` 是 c13dbb16 加的**主体**：
    // 数的是「主用户还没看过的」，靠仓储同一份 WHERE 保证与通知页页头同源。
    expect(src, '角标仍走 unreadSystemCount').toContain('unreadSystemCount(reader)')
  })

  /**
   * 渲染侧没有组件级测试环境（仓库里没有 @testing-library，`tests/renderer` 全是纯函数与源码闸门），
   * 所以这一组守的是"界面读的是主进程那一份"：**注释之外的行里**不许再出现
   * 「对已经取回的那一页做筛选 / 计数」，三个数必须写明了来自 `pageInfo`。
   */
  it('源码闸门：渲染侧不许再对一页去数、也不许在渲染侧筛分类', () => {
    const view = read('src/renderer/components/notification/NotificationsView.tsx')
    const code = view
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n')
    expect(code, '分类筛选要下推给主进程').toContain("type: which === 'all' ? null : which")
    expect(code, '对一页 `.filter` 就是"筛选落在窗口之内"').not.toContain('items.filter')
    expect(code, '列表 = 主进程给的那一页').toContain('const visible = items')
    expect(code, 'chip 的数字来自主进程的分类计数').toContain('Object.entries(pageInfo.byType)')
    expect(code, '项目页「本类已读」也要声明分类').toContain("type: filter === 'all' ? null : filter")
    expect(code, '页头未读取自主进程（不是对一页去数）').toContain('const unread = pageInfo.unread')
    expect(code, '判据 1：还有多少条 = 命中总数 − 已读进来').toContain(
      'Math.max(0, pageInfo.matched - items.length)'
    )
    expect(view, '判据 1：还有多少条要说出来').toContain('还有 {remaining} 条未显示')
    expect(view, '判据 1：还要能继续读').toContain('pageInfo.nextOffset')
    expect(view).toContain('继续读取')
  })

  it('源码闸门：IPC 类型表把回执写成"一页 + 计数"', () => {
    const types = read('src/renderer/types/ipc.ts')
    expect(types).toContain("'notification:listWithProject'")
    expect(types).toContain('result: InboxPage')
    expect(types, '入参要能传 offset 与 type').toMatch(/offset\?: number; projectId\?: string \| null; type\?: NotificationType \| null/)
    // 与 c13dbb16 一起长了一格：`reader` = 清**谁**的那一份（不传才是全局口径）
    expect(types, '按类已读也要能传 type').toContain(
      '{ projectId: string; type?: NotificationType | null; reader?: string }'
    )
  })
})
