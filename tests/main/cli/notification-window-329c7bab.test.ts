/**
 * `notification list` 的读窗口：筛选先于窗口（卡 `329c7bab`）
 *
 * ## 卡上报的病
 *
 * 这条命令此前是"**先取最新 200 条 → 再按 `--type`/`--unread` 过滤 → 再按 `--limit` 收窄**"。
 * 副本实测（有效通知 487 条、其中 memo 308 条）：
 *
 * | 调用 | 旧回执 | 实情 |
 * |---|---|---|
 * | `--limit 1000` | 200 条（`total` 也 200） | 窗口写死 `list(200)` |
 * | `--limit 5000 --type memo` | 21 条 | 真实 308 条 —— 过滤落在窗口**之内** |
 * | `--unread --limit 5000` | 180 条，而同一条回执 `unread: 467` | 计数走全表、列表走窗口 |
 *
 * 三处的共同点是**回执里看不出来**：21 条看着像"一共就 21 条"。
 *
 * ## 判据
 *
 * 1. **筛选属于 WHERE，窗口属于 LIMIT** —— 窗口只能在筛选**之后**收窄；
 * 2. 行与计数**共用同一份 WHERE**：`matched` 是"命中多少"，`returned` 是"这次回了多少"，
 *    两者并排出现才不会自相矛盾；
 * 3. `--limit 0` 与全族同一个含义（不做条数收窄）—— 这条命令从此不再有例外；
 * 4. `--offset` 只搬窗口，不参与筛选；`nextOffset` 是下一页该传的值；
 * 5. **只做加法**：回执形状（对象、`total`、`notifications`）不变，
 *    1.0.68 那两条口径（`--to-me` 走 `recipient`、`--ack-mine` 走 `read_by`）原样保留。
 *
 * ## 本文件怎么让"旧实现的病"看得见
 *
 * 数据是这样摆的：**250 条 memo 在旧（先建），200 条 review 在新（后建）**，
 * 全局已读打给"全部 review + 最新的 100 条 memo"，于是**没读过的那 150 条全在最新 200 条之外**。
 * 旧实现先取最新 200 条（全是 review、且都已读），再过滤 —— `--type memo` 与 `--unread`
 * 都会回 **0 条**。所以下面每条断言在不同实现下给出的是**不同的数**，不是"能跑就行"。
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { readCliChain } from './cli-chain'
import Database from 'better-sqlite3'
import { runMigrations } from '../../../src/main/database/migrations'
import { TodoRepository } from '../../../src/main/database/todo.repository'
import { CategoryRepository } from '../../../src/main/database/category.repository'
import { ProjectRepository } from '../../../src/main/database/project.repository'
import { MemoRepository } from '../../../src/main/database/memo.repository'
import { NotificationRepository } from '../../../src/main/database/notification.repository'
import { CommentRepository } from '../../../src/main/database/comment.repository'
import { ReminderReceiptRepository } from '../../../src/main/database/reminder-receipt.repository'
import { RulesRepository } from '../../../src/main/database/rules.repository'
import { ProtocolRepository } from '../../../src/main/database/protocol.repository'
import { ProfileRepository } from '../../../src/main/database/profile.repository'
import { executeOne, commands, parseOffset } from '../../../src/main/cli/commands'

const db = new Database(':memory:')
vi.mock('../../../src/main/database/index', () => ({ getDatabase: () => db }))

let ctx: never
let repo: NotificationRepository
/** 旧（最早建的）那一半：250 条 memo，收件人是 `agent:alice` */
let memoIds: string[] = []
/** 新（最晚建的）那一半：200 条 review，广播（没有收件人） */
let reviewIds: string[] = []
/** 全局未读：最旧的那 150 条 memo（**全部落在最新 200 条之外**） */
const unreadIds = (): string[] => memoIds.slice(0, 150)

const run = (args: string[]) => executeOne(ctx, args)

type Page = {
  total: number
  matched: number
  returned: number
  truncated: boolean
  nextOffset: number | null
  unreadMatched: number
  unread: number
  notifications: Array<{ id: string }>
  unreadForMe?: number
}
const pageOf = (data: unknown): Page => data as Page
const idsOf = (data: unknown): string[] => pageOf(data).notifications.map((n) => n.id)

describe('notification list 的读窗口（329c7bab）', () => {
  beforeAll(() => {
    runMigrations(db)
    db.pragma('foreign_keys = OFF')
  })

  beforeEach(() => {
    for (const t of ['todos', 'todo_comments', 'memos', 'notifications', 'projects', 'categories']) {
      db.prepare(`DELETE FROM ${t}`).run()
    }
    new CategoryRepository().create({ name: '方向', color: '#111', sortOrder: 0 })
    const projects = new ProjectRepository()
    projects.create({ name: 'P' })

    repo = new NotificationRepository()
    memoIds = []
    reviewIds = []
    for (let i = 0; i < 250; i++) {
      memoIds.push(
        repo.create({
          type: 'memo',
          title: `memo-${String(i).padStart(3, '0')}`,
          recipient: 'agent:alice'
        }).id
      )
    }
    for (let i = 0; i < 200; i++) {
      // refId 为 null ⇒ 不会被"已失效 review"扫掉（那条判据要求 ref_id 非空）
      reviewIds.push(repo.create({ type: 'review', title: `review-${String(i).padStart(3, '0')}` }).id)
    }
    /** 全局已读打给"全部 review + 最新的 100 条 memo" —— 于是未读的 150 条全在旧窗口之外 */
    for (const id of [...reviewIds, ...memoIds.slice(150)]) repo.markRead(id)

    ctx = {
      deps: {
        todoRepo: new TodoRepository(),
        categoryRepo: new CategoryRepository(),
        projectRepo: projects,
        /* 卡 69788c32：命令层要读哪个仓储由 deps 决定 —— 缺一个，跑到那条命令就炸 */
        commentRepo: new CommentRepository(),
        notificationRepo: new NotificationRepository(),
        reminderReceiptRepo: new ReminderReceiptRepository(),
        rulesRepo: new RulesRepository(),
        protocolRepo: new ProtocolRepository(),
        profileRepo: new ProfileRepository(),
        memoRepo: new MemoRepository(),
        settingsRepo: { get: () => ({}) },
        agentRepo: { countGrants: () => 0, listGrants: () => [] },
        events: { append: () => {} },
        telemetry: { record: () => {}, query: () => [] }
      },
      meta: { version: '1.0.107', dbPath: ':memory:', schemaVersion: 45, via: 'headless' },
      interactive: true,
      actor: 'agent:alice'
    } as never
  })

  it('前提：底数是 450 条，未读的 150 条全在最新 200 条之外', async () => {
    expect(repo.listPage().matched, 'live 通知总数').toBe(450)
    expect(repo.unreadCount(), '全局未读').toBe(150)
    const newest200 = new Set(idsOf((await run(['notification', 'list', '--limit', '200'])).data))
    expect(
      unreadIds().some((id) => newest200.has(id)),
      '未读的这 150 条若有一条落进最新 200 条，下面的用例就证明不了"筛选先于窗口"'
    ).toBe(false)
    expect(reviewIds.some((id) => newest200.has(id)), '最新 200 条应当全是 review').toBe(true)
  })

  it('窗口不再写死在 200：--limit 300 要多少给多少（旧实现只回 200）', async () => {
    const r = await run(['notification', 'list', '--limit', '300'])
    expect(r.ok, r.message ?? '').toBe(true)
    const p = pageOf(r.data)
    expect(p.returned).toBe(300)
    expect(p.matched, '命中多少与回了多少是两件事，这里两个数都对').toBe(450)
    expect(p.truncated).toBe(true)
    expect(p.nextOffset, '下一页该从 300 开始').toBe(300)
  })

  it('--limit 0 = 不做条数收窄（全族同一个含义）—— 它不再有"不接受 0"的例外', async () => {
    const r = await run(['notification', 'list', '--limit', '0'])
    expect(r.ok, `--limit 0 不该报错：${r.message ?? ''}`).toBe(true)
    const p = pageOf(r.data)
    expect(p.returned).toBe(450)
    expect(p.truncated).toBe(false)
    expect(p.nextOffset).toBeNull()
  })

  it('默认口径没被顺手改掉：不传仍是 20', async () => {
    expect(idsOf((await run(['notification', 'list'])).data)).toHaveLength(20)
  })

  it('--type 先于窗口：memo 全在最新 200 条之外，也照样回 250 条', async () => {
    const r = await run(['notification', 'list', '--type', 'memo', '--limit', '0'])
    const p = pageOf(r.data)
    expect(p.matched, '旧实现这里是 0（最新 200 条里一条 memo 都没有）').toBe(250)
    /**
     * ⚠️ 不带 `--unread` 时 `unreadMatched` 走的是 `countPage` ——
     * 它必须与 `listPage` **共用同一份 WHERE**，否则这里会给出 250（把已读的也算进来），
     * 而列表里那 150 条正是"筛出来的里面未读的"。这条断言就是给那条共用加锁的。
     */
    expect(p.unreadMatched, '命中集合里未读的条数：与列表同一批筛选、同一份 WHERE').toBe(150)
    expect(new Set(idsOf(r.data))).toEqual(new Set(memoIds))

    const r2 = await run(['notification', 'list', '--type', 'review', '--limit', '0'])
    expect(pageOf(r2.data).matched).toBe(200)
    expect(new Set(idsOf(r2.data))).toEqual(new Set(reviewIds))
  })

  it('--unread 先于窗口：未读的 150 条全在旧窗口之外，也照样回全', async () => {
    const r = await run(['notification', 'list', '--unread', '--limit', '0'])
    const p = pageOf(r.data)
    expect(p.returned, '旧实现这里是 0（最新 200 条都已读）').toBe(150)
    expect(new Set(idsOf(r.data))).toEqual(new Set(unreadIds()))
    expect(p.unreadMatched, '命中集合里未读的条数：与列表同一批筛选').toBe(150)
    /**
     * ⚠️ 这一条是"计数与列表不同源"那个病的回归点：
     * 旧实现同一份回执里能给出 `unread: 467` 而只列 180 条。
     */
    expect(p.unread, '全局未读（铃铛口径）应当与本页能列出的未读对得上').toBe(150)
  })

  it('--unread 与 --type 叠加时也是先筛后窗', async () => {
    const r = await run(['notification', 'list', '--unread', '--type', 'review', '--limit', '0'])
    expect(pageOf(r.data).matched, '未读的 review：一条都没有').toBe(0)
    const r2 = await run(['notification', 'list', '--unread', '--type', 'memo', '--limit', '30'])
    const p2 = pageOf(r2.data)
    expect(p2.returned).toBe(30)
    expect(p2.matched).toBe(150)
    expect(p2.truncated).toBe(true)
  })

  it('--offset 只搬窗口：翻页不重、不漏，读到底 truncated 就变假', async () => {
    const all = new Set(idsOf((await run(['notification', 'list', '--limit', '0'])).data))
    const seen: string[] = []
    let offset = 0
    for (let page = 0; page < 10; page++) {
      const r = await run(['notification', 'list', '--limit', '100', '--offset', String(offset)])
      const p = pageOf(r.data)
      expect(p.returned, `第 ${page + 1} 页（offset ${offset}）`).toBe(Math.min(100, 450 - offset))
      seen.push(...idsOf(r.data))
      if (!p.truncated) {
        expect(p.nextOffset, '读到底了就没有下一页').toBeNull()
        break
      }
      expect(p.nextOffset).toBe(offset + p.returned)
      offset = p.nextOffset as number
    }
    expect(seen.length, '五页应当正好把 450 条读完').toBe(450)
    expect(new Set(seen).size, '同一页不该重复出现').toBe(450)
    expect(new Set(seen)).toEqual(all)
  })

  it('--offset 越界与非法值：越界回空页，非法值报用法错误', async () => {
    const r = await run(['notification', 'list', '--offset', '500', '--limit', '100'])
    const p = pageOf(r.data)
    expect(r.ok, r.message ?? '').toBe(true)
    expect(p.returned).toBe(0)
    expect(p.matched, '越界也只影响窗口，不影响命中数').toBe(450)
    expect(p.truncated).toBe(false)
    expect(p.nextOffset).toBeNull()

    for (const bad of ['abc', '-1', '1.5']) {
      const bad1 = await run(['notification', 'list', '--offset', bad])
      expect(bad1.ok, `--offset ${bad} 不该跑成功`).toBe(false)
      expect(bad1.errorCode, `--offset ${bad} 的错误码`).toBe('usage_error')
      expect(String(bad1.message), `--offset ${bad} 要说清怎么传`).toContain('--offset 需要非负整数')
    }
    expect(parseOffset(undefined, 'x')).toBe(0)
    expect(parseOffset('0', 'x')).toBe(0)
    expect(parseOffset('7', 'x')).toBe(7)
  })

  it('--to-me 与仓储层同一份口径（收件人 + 广播），只是窗口交还给了命令行', async () => {
    const r = await run(['notification', 'list', '--to-me', '--limit', '0'])
    expect(idsOf(r.data)).toEqual(repo.listFor('agent:alice').map((n) => n.id))
    /**
     * ⚠️ `unreadForMe` 与 `unread`（全局 status）**不是一回事**：
     * 本用例里全局已读打了 300 条，但 `read_by` 一个人都没记过 ——
     * 所以"我还没看"是 450，"界面铃铛还有几条没看"是 150。两个数并存正是设计。
     */
    expect(pageOf(r.data).unreadForMe).toBe(repo.unreadCountFor('agent:alice', 'agent:alice'))
    expect(pageOf(r.data).unreadForMe).toBe(450)
    expect(pageOf(r.data).unread).toBe(150)
  })

  it('--ack-mine 仍是"我没确认过的"那批，且只确认本次返回的（1.0.68 口径原样保留）', async () => {
    db.prepare('DELETE FROM notifications').run()
    for (let i = 0; i < 3; i++) {
      repo.create({ type: 'memo', title: `ack-${i}`, recipient: 'agent:alice' })
    }
    const first = await run(['notification', 'list', '--ack-mine', '--limit', '1'])
    expect(pageOf(first.data).returned, '只确认本次实际返回的').toBe(1)
    expect(pageOf(first.data).matched, '命中集合 = 我没确认过的（含被 limit 截掉的那两条）').toBe(3)

    const second = await run(['notification', 'list', '--ack-mine', '--limit', '10'])
    expect(pageOf(second.data).returned, '已确认过的不再回 —— 少了这条，反复调用就没有终点').toBe(2)

    const third = await run(['notification', 'list', '--ack-mine', '--limit', '10'])
    expect(pageOf(third.data).returned).toBe(0)
    expect(pageOf(third.data).truncated).toBe(false)
    expect(repo.unreadCount(), '--ack-mine 走 read_by，不该动全局 status').toBe(3)

    const plain = await run(['notification', 'list', '--limit', '10'])
    expect(pageOf(plain.data).returned, '不带 --ack-mine 时都还在（只是都被我确认过了）').toBe(3)
  })

  it('回执形状只做加法：仍是对象，total 仍是"本次返回几条"', async () => {
    const p = pageOf((await run(['notification', 'list'])).data)
    expect(Array.isArray(p), 'data 仍是对象（改形状得单独通告，不能夹在修窗口里做）').toBe(false)
    expect(Array.isArray(p.notifications)).toBe(true)
    expect(p.total, 'total 的语义没变').toBe(p.notifications.length)
    expect(p.total).toBe(p.returned)
  })

  it('源码闸门：命令里不许再写窗口上限，且必须声明 --offset', () => {
    const src = readCliChain()
    expect(src, '窗口上限不许再写死在命令里').not.toContain('repo.list(200)')
    expect(src, '那个硬上限常量应当已经删掉了').not.toContain('NOTIFICATION_LIST_CAP')
    const cmd = commands.find((c) => c.name === 'notification list')
    expect(cmd, '命令不见了？').toBeTruthy()
    expect((cmd?.args ?? []).some((a) => a.flag === '--offset'), '要能翻页就得有 --offset').toBe(true)
    const limitDesc = String((cmd?.args ?? []).find((a) => a.flag === '--limit')?.desc ?? '')
    expect(limitDesc).toContain('0 = 全量')
    expect(limitDesc, '不再有"底层一次最多 200 条"这句例外').not.toContain('最多 200')
  })
})
