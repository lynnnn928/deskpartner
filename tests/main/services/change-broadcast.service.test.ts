import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '../../../src/main/database/migrations'

/**
 * 横幅「取最新那条申请」为什么必须测
 *
 * 原实现用 `find()` 取这批事件里**第一条**（最早）的 grant 事件。
 * 只有一条申请时完全正常，所以单 agent 用很久都没暴露。但轮询一旦
 * 被系统节流／机器休眠过，下一批就会一次带回好几条 grant 事件 ——
 * 于是横幅永远停在**最早**那条上，后面 agent 的申请一个也弹不出来。
 *
 * 主用户 2026-09-22 实测撞到：14:41 alice 申请、14:52 Bob申请，
 * 横幅一直显示 alice，而设置页待表态列表里躺着Bob。
 * 表面看像"身份串了"，实际是横幅压根没换过。
 *
 * 这个用例把「一批多条 → 取最后一条」钉死：它正是单条场景测不出来的。
 *
 * 两个环境陷阱（踩过，记下）：
 * - ChangeBroadcastService 顶层 `import { BrowserWindow } from 'electron'`，
 *   Node 环境下加载不了 electron → 必须 mock 掉。
 * - 它内部自己 new EventsRepository（不是注入的），传假 repo 没用 →
 *   只能连真仓库一起测，用内存库。
 */
vi.mock('electron', () => ({ BrowserWindow: class {} }))

const db = new Database(':memory:')
vi.mock('../../../src/main/database/index', () => ({
  getDatabase: () => db
}))

const { ChangeBroadcastService } = await import(
  '../../../src/main/services/change-broadcast.service'
)

/** 往 events 表插一条事件，返回自增 id */
function insertEvent(type: string, payload: Record<string, unknown>): number {
  const r = db
    .prepare(`INSERT INTO events (type, actor, payload, created_at) VALUES (?, ?, ?, ?)`)
    .run(type, 'cli', JSON.stringify(payload), new Date().toISOString())
  return Number(r.lastInsertRowid)
}

/** 往 events 表插一条 grant 事件，返回自增 id */
function insertGrant(payload: Record<string, unknown>): number {
  return insertEvent('grant', payload)
}

/** 驱动一次 poll，返回两条回调各自收到的内容 */
function runPollFull() {
  const calls: Array<Record<string, unknown>> = []
  const joins: Array<Record<string, unknown>> = []
  const errors: string[] = []
  const errSpy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    errors.push(a.map(String).join(' '))
  })
  const svc = new ChangeBroadcastService(
    () => ({}),
    'gui',
    (p) => calls.push(p as unknown as Record<string, unknown>),
    (p) => joins.push(p as unknown as Record<string, unknown>)
  )
  // poll 是私有的：从外部驱动一次，等价于一个轮询周期
  ;(svc as unknown as { poll: () => void }).poll()
  errSpy.mockRestore()
  if (errors.length) throw new Error(`poll 内部报错：${errors.join(' | ')}`)
  return { grants: calls, joins }
}

/** 只关心授权横幅的老调用方（保持既有用例不动） */
function runPoll() {
  return runPollFull().grants
}

describe('ChangeBroadcastService 授权横幅', () => {
  beforeAll(() => {
    runMigrations(db)
  })

  beforeEach(() => {
    db.exec('DELETE FROM events')
  })

  it('一批里有两条申请时，弹的是**最新**那条而不是最早那条', () => {
    insertGrant({
      grantId: 'g-old',
      agentId: 'agent:alice',
      scope: 'destructive',
      command: 'todo rm',
      summary: 'todo rm「旧的那条」'
    })
    insertGrant({
      grantId: 'g-new',
      agentId: 'agent:bob',
      scope: 'destructive',
      command: 'todo rm',
      summary: 'todo rm「新的那条」'
    })

    const calls = runPoll()
    expect(calls).toHaveLength(1)
    expect(calls[0].agentId).toBe('agent:bob')
    expect(calls[0].grantId).toBe('g-new')
    expect(calls[0].summary).toBe('todo rm「新的那条」')
  })

  it('只有一条时照常弹（别为了修多条把单条弄坏）', () => {
    insertGrant({
      grantId: 'g-only',
      agentId: 'agent:alice',
      scope: 'config',
      command: 'ui set'
    })

    const calls = runPoll()
    expect(calls).toHaveLength(1)
    expect(calls[0].agentId).toBe('agent:alice')
    // 旧事件没有 summary 字段：应回退成 null 而不是字符串 "undefined"
    expect(calls[0].summary).toBeNull()
  })

  it('自己写入的事件不弹横幅（否则会把本地操作当成待审批）', () => {
    db.prepare(`INSERT INTO events (type, actor, payload, created_at) VALUES (?, ?, ?, ?)`).run(
      'grant',
      'gui',
      JSON.stringify({ grantId: 'g-self', agentId: 'agent:alice', scope: 'destructive' }),
      new Date().toISOString()
    )
    expect(runPoll()).toHaveLength(0)
  })

  it('非 grant 事件不触发横幅回调', () => {
    db.prepare(`INSERT INTO events (type, actor, payload, created_at) VALUES (?, ?, ?, ?)`).run(
      'todo',
      'cli',
      JSON.stringify({ id: 'x' }),
      new Date().toISOString()
    )
    expect(runPoll()).toHaveLength(0)
  })
})

/**
 * 新 agent 接入的通知（1.0.63）
 *
 * 主用户 2026-09-30：「新 agent 注册和教学的相关能力也一并考虑加上吧，
 * agent friendly 要从接入使用开始。」
 *
 * 这是接入第一步的"主动告知"那一半：agent 自己注册完（1.0.47 起自助），
 * 若没有这条通知，它会静默躺在"等你批准"里，而人**根本不知道它来了**。
 */
describe('ChangeBroadcastService 新 agent 接入', () => {
  beforeAll(() => {
    runMigrations(db)
  })

  beforeEach(() => {
    db.exec('DELETE FROM events')
  })

  it('agent_register 事件弹「它来了」而不是当成一条待批申请', () => {
    insertEvent('agent_register', { agentId: 'agent:rookie', displayName: '新来的' })

    const { grants, joins } = runPollFull()
    expect(joins).toHaveLength(1)
    expect(joins[0].agentId).toBe('agent:rookie')
    expect(joins[0].displayName).toBe('新来的')
    // 走错回调的后果是横幅弹成"它卡着等你批"，与实际不符
    expect(grants).toHaveLength(0)
  })

  it('一次带多条也只弹最新那个（休眠后补播不该叠一串）', () => {
    insertEvent('agent_register', { agentId: 'agent:a1', displayName: '甲' })
    insertEvent('agent_register', { agentId: 'agent:a2', displayName: '乙' })

    const { joins } = runPollFull()
    expect(joins).toHaveLength(1)
    expect(joins[0].agentId).toBe('agent:a2')
  })

  it('同批里既有新身份又有待批申请时，优先弹申请（那个是"它现在卡着"）', () => {
    insertEvent('agent_register', { agentId: 'agent:rookie', displayName: '新来的' })
    insertGrant({
      grantId: 'g-1',
      agentId: 'agent:bob',
      scope: 'destructive',
      command: 'todo rm',
      summary: 'todo rm「某条」'
    })

    const { grants, joins } = runPollFull()
    expect(grants).toHaveLength(1)
    // 两条横幅叠在一起等于没弹；被盖掉的那条在「待批准身份」里仍然存在
    expect(joins).toHaveLength(0)
  })

  it('缺 displayName 时回退用 id（不能把横幅标题弹成 undefined）', () => {
    insertEvent('agent_register', { agentId: 'agent:noname' })

    const { joins } = runPollFull()
    expect(joins).toHaveLength(1)
    expect(joins[0].displayName).toBe('')
    expect(String(joins[0].agentId)).not.toContain('undefined')
  })
})
