/**
 * 多余的位置参数必须报 usage_error（1.0.107，修 `350f9631`）
 *
 * ## 它治的病
 *
 * 未知 flag 早已被拦下（1.0.64，`777eaf34` / `3628895c`），但**位置参数**
 * 一直是"多给就丢"：实测 1.0.107 的 `agent grants zzz` 回全部 81 条授权、
 * exit 0、ok:true —— 调用方以为筛选生效了。而 `agent grants` 根本没有位置参数
 * （筛选靠 `--id`）。这类"静默的数据错误"比一次可诊断的失败贵得多：
 * `251eb399` 那次就是靠这条宽松规则把"筛选失效"瞒成了"筛选没写"。
 *
 * ## 本文件盯的三件事
 *
 * ① **多给就错**：没有位置参数声明的命令给一个、只吃一个的命令给两个，
 *    都必须回 `usage_error`，且文案里列出**该命令接受的参数**（一次就能改对）；
 * ② **不误伤**：唯一合法的多位置参数命令 `category merge <源> <目标>` 照常成功
 *    —— 它的 `arity: 2` 若被删掉，这条会红；
 * ③ **用法优先**：`--help` 仍然先答（问用法不该被参数错误拦）。
 *
 * 结构闸门（"run 用了 positional 就必须声明"）与它的反向验证在
 * `cli-wiring-gate.test.ts` —— 那里正是卡上点名的"参数接线闸门"。
 */
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
import { EXIT_CODES, executeOne, maxPositionalArgs, commands } from '../../../src/main/cli/commands'
import { formatOutcome } from '../../../src/main/cli/output'

const db = new Database(':memory:')
vi.mock('../../../src/main/database/index', () => ({
  getDatabase: () => db
}))

const todoRepo = new TodoRepository()
const categoryRepo = new CategoryRepository()
const projectRepo = new ProjectRepository()

/**
 * human 交互身份：本文件验的是**参数校验**，不是权限 ——
 * 写档的 `category merge` 走到 `run` 时不该被门禁拦下
 * （`assertCallerAllowed` 对 interactive 直接放行）。
 */
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
      telemetry: { record: () => {}, stats: () => null, clear: () => 0, query: () => [] }
    },
    meta: {
      version: '1.0.107',
      dbPath: ':memory:',
      schemaVersion: 45,
      busyTimeoutMs: 5000,
      channels: ['headless'],
      via: 'headless',
      startedAt: 0
    },
    interactive: true,
    actor: 'human',
    ...over
  } as never
}

beforeAll(() => {
  runMigrations(db)
  db.pragma('foreign_keys = OFF')
})

beforeEach(() => {
  db.prepare('DELETE FROM todo_categories').run()
  db.prepare('DELETE FROM todos').run()
  db.prepare('DELETE FROM projects').run()
  db.prepare('DELETE FROM categories').run()
  projectRepo.create({ name: '位置参数测试项目' })
  // 建待办必须先有分类（TodoRepository.create 找不到兜底分类会 GuardError）
  categoryRepo.create({ name: '位置参数用分类', color: '#333', sortOrder: 0 })
})

describe('位置参数多给即报错（350f9631）', () => {
  /**
   * 判据本身的单元测试：三档都从 `CommandSpec.positional` 推出来。
   * 这里钉住的是"默认 1"与"没声明就是 0"—— 换成别的默认值，
   * 下面两条行为用例也会跟着变，但那两条读起来没那么直白。
   */
  it('maxPositionalArgs：没声明 0、默认 1、category merge 2', () => {
    const byName = (n: string) => commands.find((c) => c.name === n)!
    expect(maxPositionalArgs(byName('agent grants')), '没有位置参数的读命令应为 0').toBe(0)
    expect(maxPositionalArgs(byName('batch')), 'batch 从 stdin 读记录，位置参数应为 0').toBe(0)
    expect(maxPositionalArgs(byName('todo get')), '默认应为 1').toBe(1)
    expect(maxPositionalArgs(byName('skill')), '可选位置参数也算 1（少给由 required 管）').toBe(1)
    expect(
      maxPositionalArgs(byName('category merge')),
      'category merge 吃两个 id —— 这条红了说明 arity: 2 被删了'
    ).toBe(2)
    expect(
      maxPositionalArgs(byName('help')),
      'help 的命令名可能是两个词（help todo rm）—— 这条红了说明 arity: 2 被删了'
    ).toBe(2)
  })

  /**
   * 卡上那条实测：`agent grants zzz`（改前回全部 81 条、ok:true）。
   * 现在必须回 usage_error，且文案里带上它真正接受的参数。
   */
  it('没有位置参数声明的命令多给一个 → usage_error（改前是 ok:true 回全量）', async () => {
    const res = await executeOne(makeCtx(), ['agent', 'grants', 'zzz-no-such-id'])

    expect(res.ok, `改前这里回 ok:true 加一列授权；实际：${JSON.stringify(res).slice(0, 200)}`).toBe(false)
    expect(res.code).toBe(EXIT_CODES.usage)
    expect(res.errorCode).toBe('usage_error')
    expect(String(res.message)).toContain('不接受多余的参数')
    expect(String(res.message), '文案要含被拒的参数本身，否则调用方看不出是哪一段多了').toContain(
      'zzz-no-such-id'
    )
    expect(String(res.message), '文案要列出该命令接受的参数，免得再跑一趟 schema').toContain('--id')
    /** 关键反证：**没有**任何数据被当成结果送出去（改前这里有 count:81 与 grants 数组） */
    expect(res.data, '报错时不该再带一份"看着正常"的数据').toBeUndefined()
  })

  /** 只吃一个位置参数的命令多给一个，同样要报错，并指出位置参数的名字 */
  it('只吃一个位置参数的命令多给一个 → usage_error 且点出位置参数名', async () => {
    const project = projectRepo.list()[0]
    const todo = todoRepo.create({
      title: '一条用于取回显的待办',
      categoryIds: [],
      projectId: project.id,
      priority: 'normal'
    })

    const res = await executeOne(makeCtx(), ['todo', 'get', todo.id, 'extra-token'])

    expect(res.ok).toBe(false)
    expect(res.errorCode).toBe('usage_error')
    expect(String(res.message)).toContain('不接受多余的参数')
    expect(String(res.message)).toContain('extra-token')
    expect(String(res.message), '缺了"该命令接受什么"，agent 只能猜').toContain('位置参数 <id>')
  })

  /**
   * **不误伤**：`category merge <源> <目标> --yes` 的两个位置参数都是合法的。
   *
   * 这条同时是 `arity: 2` 的回归保护 —— 删掉那个字段，它会以
   * "不接受多余的参数：<目标 id>" 变红（判据默认 1）。
   */
  it('category merge 两个位置参数仍然合法（arity: 2 的回归保护）', async () => {
    const from = categoryRepo.create({ name: '竞争调研', color: '#111', sortOrder: 0 })
    const to = categoryRepo.create({ name: '竞品调研', color: '#222', sortOrder: 1 })

    const res = await executeOne(makeCtx(), ['category', 'merge', from.id, to.id, '--yes'])

    expect(
      String(res.message ?? ''),
      '两个 id 被当成"多余的参数"拒掉了 —— category merge 的 arity 声明丢了'
    ).not.toContain('不接受多余的参数')
    expect(res.ok, `实际：${res.errorCode} / ${res.message}`).toBe(true)
    expect(res.data, '合并成功该给出结果').toBeTruthy()
  })

  /**
   * **不误伤（第二处）**：`help` 的命令名可能是两个词。
   *
   * 这条是被真实回归逼出来的：第一版只给 `category merge` 写了 `arity: 2`，
   * `help todo rm` 当场被判"多给了一个参数"—— `programmable-surface.test.ts`
   * 的 `help <命令>` 用例先红了。两个词的命令名一直合法（`run` 里 join 回名字），
   * 所以 `help` 也得显式声明 2。
   */
  it('help 的两个词命令名仍然合法（arity: 2 的回归保护）', async () => {
    const two = await executeOne(makeCtx(), ['help', 'todo', 'rm'])
    expect(two.ok, `help todo rm 被拒了：${two.errorCode} / ${two.message}`).toBe(true)
    expect((two.data as { name?: string }).name).toBe('todo rm')

    const one = await executeOne(makeCtx(), ['help', 'batch'])
    expect(one.ok).toBe(true)
    expect((one.data as { name?: string }).name).toBe('batch')

    // 三段以上：命令名最长两段，多出来的必然是调用方搞错了
    const three = await executeOne(makeCtx(), ['help', 'todo', 'rm', 'extra'])
    expect(three.ok).toBe(false)
    expect(three.errorCode).toBe('usage_error')
    expect(String(three.message)).toContain('不接受多余的参数')
    // 吃多个的命令，报错里要写出上限 —— 否则调用方看着 <command> 还得再猜一次
    expect(
      String(three.message),
      '多段命令的位置参数提示没写上限，调用方看不出两个词是合法的'
    ).toContain('最多 2 段')
  })

  /** 反向：合法的单个位置参数不受影响 */
  it('合法的单个位置参数照常工作', async () => {
    const project = projectRepo.list()[0]
    const todo = todoRepo.create({
      title: '取回显',
      categoryIds: [],
      projectId: project.id,
      priority: 'normal'
    })
    const res = await executeOne(makeCtx(), ['todo', 'get', todo.id])
    expect(res.ok, `实际：${res.errorCode} / ${res.message}`).toBe(true)
  })

  /** `--help` 先答：问用法不该被"多给了一个位置参数"拦下 */
  it('--help 仍然优先于位置参数校验（问用法就是问用法）', async () => {
    const res = await executeOne(makeCtx(), ['todo', 'get', 'whatever', '--help'])
    expect(res.ok).toBe(true)
    expect((res.data as { name?: string }).name).toBe('todo get')
  })

  /** 报错要走**最终输出层**：中间对象对了、信封里没有，调用方还是看不到 */
  it('错误信封里真的带着这条 usage 文案（不是只在中间对象里）', async () => {
    const res = await executeOne(makeCtx(), ['agent', 'grants', 'zzz'])
    const formatted = formatOutcome(res, ['agent', 'grants', 'zzz'], false)
    const parsed = JSON.parse(formatted.stdout) as {
      ok: boolean
      message?: string
      /** 信封里的 `code` 是**错误码字符串**（数字的那份是进程退出码） */
      code?: string
    }
    expect(parsed.ok).toBe(false)
    expect(parsed.code).toBe('usage_error')
    expect(formatted.exitCode, '退出码必须是 usage，脚本按它分流').toBe(EXIT_CODES.usage)
    expect(String(parsed.message)).toContain('不接受多余的参数')
  })

  /** `batch` 的位置参数同样不接受：它的入口是 stdin，不是 argv */
  it('batch 多给位置参数 → usage_error（它的内容入口是 stdin）', async () => {
    const res = await executeOne(makeCtx({ stdin: '' }), ['batch', 'todo list'])
    expect(res.ok).toBe(false)
    expect(res.errorCode).toBe('usage_error')
    expect(String(res.message)).toContain('不接受多余的参数')
  })
})
