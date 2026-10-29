import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '../../../src/main/database/migrations'
import { TodoRepository } from '../../../src/main/database/todo.repository'
import { CategoryRepository } from '../../../src/main/database/category.repository'
import { ProjectRepository } from '../../../src/main/database/project.repository'
import { CommentRepository } from '../../../src/main/database/comment.repository'
import { NotificationRepository } from '../../../src/main/database/notification.repository'
import { ReminderReceiptRepository } from '../../../src/main/database/reminder-receipt.repository'
import { RulesRepository } from '../../../src/main/database/rules.repository'
import { ProtocolRepository } from '../../../src/main/database/protocol.repository'
import { ProfileRepository } from '../../../src/main/database/profile.repository'
import { executeOne, dedupeNoticeLines } from '../../../src/main/cli/commands'
import { formatOutcome } from '../../../src/main/cli/output'

const db = new Database(':memory:')
vi.mock('../../../src/main/database/index', () => ({
  getDatabase: () => db
}))
/** 拦掉"写真实凭据文件"这一步（与 batch-envelope-contract 同一处理） */
vi.mock('../../../src/cli/credentials', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/cli/credentials')>()
  return { ...actual, writeCredential: vi.fn() }
})

const todoRepo = new TodoRepository()
const categoryRepo = new CategoryRepository()
const projectRepo = new ProjectRepository()

/** 声明一份落后的说明书版本 → G8 告警每次调用都会带出来 */
const SKILL_VERSION = '1.0.1'
const CLI_VERSION = '1.0.73'
/** G8 那条告警句（逐字）—— 判据就是"它在一份回执里出现几次" */
const HINT =
  `你手上的说明书是 ${SKILL_VERSION}，当前 CLI 已是 ${CLI_VERSION} —— ` +
  '中间可能有行为变化。重跑 `skill`（`node "$DESKPARTNER_CLI" skill`；变量不在就用安装目录下的 resources/cli/deskpartner.cjs）再干，别照旧说明书写。'

function makeCtx(over: Record<string, unknown> = {}) {
  return {
    deps: {
      todoRepo,
      categoryRepo,
      projectRepo,
      /* 卡 69788c32：命令层要读哪个仓储由 deps 决定 —— 缺一个，跑到那条命令就炸 */
      commentRepo: new CommentRepository(),
      notificationRepo: new NotificationRepository(),
      reminderReceiptRepo: new ReminderReceiptRepository(),
      rulesRepo: new RulesRepository(),
      protocolRepo: new ProtocolRepository(),
      profileRepo: new ProfileRepository(),
      memoRepo: { list: () => [], add: () => ({ id: 'm1' }), get: () => null },
      settingsRepo: { get: () => ({}) },
      agentRepo: {
        get: () => null,
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
      version: CLI_VERSION,
      dbPath: ':memory:',
      schemaVersion: 25,
      busyTimeoutMs: 5000,
      channels: ['pipe'],
      via: 'pipe',
      startedAt: 0
    },
    interactive: true,
    actor: 'human',
    skillVersion: SKILL_VERSION,
    ...over
  } as never
}

/** 一段文字里这句话出现了几次 */
const countOf = (text: string | undefined, needle: string): number =>
  text ? text.split(needle).length - 1 : 0

type Envelope = {
  ok: boolean
  notice?: string
  data: { results?: { ok: boolean; notice?: string }[] }
}

/** 跑一批（stdin 从 ctx 进），拿到**最终输出层**的信封 —— 不是中间 Outcome */
async function runBatch(lines: string[]): Promise<{ envelope: Envelope; stdout: string }> {
  const ctx = makeCtx({ stdin: lines.join('\n') })
  const outcome = await executeOne(ctx, ['batch'])
  const out = formatOutcome(outcome, ['batch'], false)
  return { envelope: JSON.parse(out.stdout) as Envelope, stdout: out.stdout }
}

beforeAll(() => {
  runMigrations(db)
  db.pragma('foreign_keys = OFF')
})

beforeEach(() => {
  db.prepare('DELETE FROM todo_categories').run()
  db.prepare('DELETE FROM memos').run()
  db.prepare('DELETE FROM todos').run()
  db.prepare('DELETE FROM projects').run()
  db.prepare('DELETE FROM categories').run()
  categoryRepo.create({ name: '方向', color: '#1', sortOrder: 0 })
  projectRepo.create({ name: '测试项目' })
})

/**
 * G8 触发时 batch 顶层 notice 同一句逐字重复两遍（1.0.110，收 `691c3b1e`）
 *
 * ## 形状
 *
 * 直连：告警句在顶层 notice 里 1 次。
 * batch：行内 1 次（正常），顶层 **2 次**（同一句换行相连，全文 3 次）。
 *
 * ## 根因（为什么 Set 去重兜不住）
 *
 * 每条子命令都走 `executeOne`，行内那份已经带上了告警句；
 * 批跑完汇总成一份、回到最外层的 `executeOne` 时，**版本检查在命令之外又做了一遍**，
 * 于是又追加一次 —— 而 `3df42f82` 的 Set 去重发生在追加**之前**。
 *
 * 判据：**合并之后去重，而不是在某个入口上打补丁**。
 */
describe('顶层 notice 逐句去重（691c3b1e）', () => {
  it('直连：告警句在顶层 notice 里 1 次（这条通道本来就是对的）', async () => {
    const out = formatOutcome(await executeOne(makeCtx(), ['help']), ['help'], false)
    const envelope = JSON.parse(out.stdout) as { ok: boolean; notice?: string }
    expect(envelope.ok).toBe(true)
    expect(envelope.notice, '先钉住告警真的出现了 —— 否则下面的计数会被 0 === 0 假绿').toContain(HINT)
    expect(countOf(envelope.notice, HINT)).toBe(1)
  })

  it('batch 单行（卡上的复现）：顶层 1 次、行内 1 次、全文 2 次', async () => {
    const { envelope, stdout } = await runBatch([JSON.stringify({ cmd: 'help' })])
    expect(envelope.ok).toBe(true)
    expect(countOf(envelope.data.results?.[0]?.notice, HINT), '行内那份是既定口径，要保持 1 次').toBe(
      1
    )
    expect(
      countOf(envelope.notice, HINT),
      '顶层 notice 里同一句出现了两遍 —— 它是"按 notice 计数"的调用方的噪声'
    ).toBe(1)
    // 新提醒里带双引号（`node "$DESKPARTNER_CLI" skill`），stdout 里是转义过的，
    // 直接拿 HINT 去数必然 0 —— 数的是同一句话的 JSON 形态。
    expect(countOf(stdout, JSON.stringify(HINT).slice(1, -1)), '全文计数：顶层 1 + 行内 1').toBe(2)
  })

  it('两条子命令各自带着同一句：顶层合并后仍只 1 次', async () => {
    const cat = categoryRepo.list()[0]
    const todo = todoRepo.create({ title: '这批要收口', categoryIds: [cat.id] })
    const { envelope } = await runBatch([
      JSON.stringify({ cmd: 'todo done', positional: [todo.id] }),
      JSON.stringify({ cmd: 'help' })
    ])
    const rows = envelope.data.results ?? []
    expect(rows.length).toBe(2)
    // 前提：两份行内提醒**不同**且**都带着这句** —— 否则这条用例是空的
    expect(countOf(rows[0].notice, HINT)).toBe(1)
    expect(countOf(rows[1].notice, HINT)).toBe(1)
    expect(rows[0].notice, '两份行内提醒要不同，否则 Set 早就去掉了').not.toBe(rows[1].notice)
    expect(
      countOf(envelope.notice, HINT),
      '两个来源各自带一句 → 合并后必须只留一句'
    ).toBe(1)
    // 合并只是去重，不许把来源整段丢掉
    expect(envelope.notice).toContain('G5')
  })

  it('只聚合去重，不抹行内那份（沿用 3df42f82 的口径）', async () => {
    const { envelope } = await runBatch([JSON.stringify({ cmd: 'help' })])
    expect(envelope.data.results?.[0]?.notice).toContain(HINT)
  })
})

describe('去重规则本身（691c3b1e）', () => {
  it('同一句只留一份，顺序不动', () => {
    expect(dedupeNoticeLines(['第一句', '第二句', '第一句'].join('\n'))).toBe(
      ['第一句', '第二句'].join('\n')
    )
  })

  it('卡上的样子：同一句换行相连 → 合成一句', () => {
    expect(dedupeNoticeLines([HINT, HINT].join('\n'))).toBe(HINT)
  })

  it('空行是段落分隔：不去重、也不丢', () => {
    expect(dedupeNoticeLines(['第一句', '', '第二句', '第一句'].join('\n'))).toBe(
      ['第一句', '', '第二句'].join('\n')
    )
  })

  it('不同的句子一律保留（去重只认逐字相同）', () => {
    const text = ['说明书版本落后', '说明书版本落后了'].join('\n')
    expect(dedupeNoticeLines(text)).toBe(text)
  })
})
