import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '../../../src/main/database/migrations'
import { TodoRepository } from '../../../src/main/database/todo.repository'
import { CommentRepository } from '../../../src/main/database/comment.repository'
import { CategoryRepository } from '../../../src/main/database/category.repository'
import { ProjectRepository } from '../../../src/main/database/project.repository'
import { NotificationRepository } from '../../../src/main/database/notification.repository'
import { ReminderReceiptRepository } from '../../../src/main/database/reminder-receipt.repository'
import { RulesRepository } from '../../../src/main/database/rules.repository'
import { ProtocolRepository } from '../../../src/main/database/protocol.repository'
import { ProfileRepository } from '../../../src/main/database/profile.repository'
import { MemoRepository } from '../../../src/main/database/memo.repository'
import { executeOne } from '../../../src/main/cli/commands'
import { formatOutcome } from '../../../src/main/cli/output'
import { buildAgentGuideTopic } from '../../../src/main/cli/agent-guide'

/**
 * 卡 `a5d947cf`（备忘定位收口与旧数据归属标注）+ 卡 `14ae42e5`（备忘回复线程闭环）
 */
const db = new Database(':memory:')
vi.mock('../../../src/main/database/index', () => ({
  getDatabase: () => db
}))

vi.mock('../../../src/cli/credentials', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/cli/credentials')>()
  return { ...actual, writeCredential: vi.fn() }
})

const memoRepo = new MemoRepository()
const notificationRepo = new NotificationRepository()

function makeCtx(actor: string) {
  return {
    deps: {
      todoRepo: new TodoRepository(),
      categoryRepo: new CategoryRepository(),
      projectRepo: new ProjectRepository(),
      commentRepo: new CommentRepository(),
      notificationRepo,
      reminderReceiptRepo: new ReminderReceiptRepository(),
      rulesRepo: new RulesRepository(),
      protocolRepo: new ProtocolRepository(),
      profileRepo: new ProfileRepository(),
      memoRepo,
      settingsRepo: { get: () => ({}) },
      agentRepo: {
        get: (id: string) => ({ id, displayName: id, approved: true }),
        list: () => [],
        touch: () => null,
        markWrite: () => null,
        listGrants: () => [],
        findUsableGrant: () => null,
        findAnyUsableGrant: () => null,
        findLatestGrant: () => null,
        consumeGrant: () => null
      },
      events: { append: () => {} },
      telemetry: { record: () => {}, query: () => [], stats: () => null, clear: () => 0 }
    },
    meta: {
      version: '1.0.127',
      dbPath: ':memory:',
      schemaVersion: 47,
      busyTimeoutMs: 5000,
      channels: ['pipe'],
      via: 'pipe',
      startedAt: 0
    },
    interactive: true,
    actor
  } as never
}

async function runAs(actor: string, args: string[]) {
  const outcome = await executeOne(makeCtx(actor), args)
  const { stdout } = formatOutcome(outcome, args, false)
  return JSON.parse(stdout) as {
    ok: boolean
    code?: number | string
    message?: string
    data?: unknown
  }
}

beforeAll(() => {
  runMigrations(db)
})

beforeEach(() => {
  db.prepare('DELETE FROM memos').run()
  db.prepare('DELETE FROM notifications').run()
})

describe('备忘回复线程闭环与定位收口（卡 14ae42e5 & a5d947cf）', () => {
  it('1. 备忘支持 --reply-to 回复在同一线程内：不新建独立备忘、不刷屏通知收件箱，且自动切换未读归属', async () => {
    // Bob给 Penguin 发一条备忘
    const created = await runAs('agent:bob', [
      'memo',
      'add',
      '--to',
      'agent:penguin',
      '--text',
      '发版前请看一眼契约基线'
    ])
    expect(created.ok).toBe(true)
    const memoId = (created.data as { id: string }).id

    // Penguin 在未读列表里能看到这条给自己的备忘
    const beforeReplyForPenguin = await runAs('agent:penguin', ['memo', 'list', '--to-me', '--unread'])
    expect((beforeReplyForPenguin.data as Array<{ id: string }>).length).toBe(1)

    // Penguin 直接通过 --reply-to 回复（支持前缀）
    const replied = await runAs('agent:penguin', [
      'memo',
      'add',
      '--reply-to',
      memoId.slice(0, 8),
      '--text',
      '已更新完契约基线并验绿'
    ])
    expect(replied.ok).toBe(true)
    const replyData = replied.data as {
      id: string
      replyTo: string
      author: string
      recipient: string
      replies: Array<{ author: string; recipient: string; text: string }>
    }
    expect(replyData.id).toBe(memoId)
    expect(replyData.replyTo).toBe(memoId)
    expect(replyData.author).toBe('agent:penguin')
    // 未显式传 --to 时自动回给原发件人 agent:bob
    expect(replyData.recipient).toBe('agent:bob')
    expect(replyData.replies).toHaveLength(1)
    expect(replyData.replies[0].text).toBe('已更新完契约基线并验绿')

    // 判据 2：不新建独立备忘条目，也不额外增加收件箱通知条目（仍是 1 条）
    expect(memoRepo.list()).toHaveLength(1)
    expect(notificationRepo.list()).toHaveLength(1)

    // 判据 3：回了原条对 Penguin 就算处理过（Penguin 的未读变为 0），同时对原发件人Bob变为未读
    const afterReplyForPenguin = await runAs('agent:penguin', ['memo', 'list', '--to-me', '--unread'])
    expect(afterReplyForPenguin.data).toEqual([])

    const afterReplyForQwen = await runAs('agent:bob', ['memo', 'list', '--to-me', '--unread'])
    const qwenMemos = afterReplyForQwen.data as Array<{
      id: string
      replies?: Array<{ author: string; text: string }>
    }>
    expect(qwenMemos).toHaveLength(1)
    expect(qwenMemos[0].id).toBe(memoId)
    expect(qwenMemos[0].replies?.[0]?.text).toBe('已更新完契约基线并验绿')

    // Bob ack 后，整条线程已读
    const acked = await runAs('agent:bob', ['memo', 'ack', memoId.slice(0, 8)])
    expect(acked.ok).toBe(true)
    expect(memoRepo.unreadCount()).toBe(0)
  })

  it('2. 存量单条备忘不含 replies 冗余字段；1.0.68 前的历史旧备忘在收件箱反查时保留 unknown:pre-1.0.68 标识', () => {
    const single = memoRepo.create({ author: 'agent:bob', recipient: 'agent:alice', text: '单条口信' })
    const fetched = memoRepo.get(single.id)!
    expect('replies' in fetched).toBe(false)

    // 模拟 1.0.68 前的存量行（memos.author = unknown:pre-1.0.68，但旧 notifications.actor 残留为收件人）
    db.prepare(
      `INSERT INTO memos (id, author, recipient, text, status, created_at, replies)
       VALUES ('legacy-m1', 'unknown:pre-1.0.68', 'agent:alice', '@Alice 旧纸条', 'read', '2026-09-30T00:00:00.000Z', '[]')`
    ).run()
    db.prepare(
      `INSERT INTO notifications (id, type, title, summary, ref_id, actor, recipient, status, created_at)
       VALUES ('legacy-n1', 'memo', '@Alice 旧纸条', '@Alice 旧纸条', 'legacy-m1', 'agent:alice', 'agent:alice', 'read', '2026-09-30T00:00:00.000Z')`
    ).run()

    const page = notificationRepo.inboxPage({})
    const legacyRow = page.rows.find((r) => r.id === 'legacy-n1')
    expect(legacyRow?.actor).toBe('unknown:pre-1.0.68')
  })

  it('3. dp skill access 明确写入「有具体事项→评论；需拍板→待确认；无对象跨身份留口信→备忘」三分法（卡 a5d947cf）', () => {
    const accessDoc = buildAgentGuideTopic('access', 'dp', '1.0.127')
    expect(accessDoc).toContain('跨身份协作沟通三分法')
    expect(accessDoc).toContain('memo add --reply-to')
  })
})
