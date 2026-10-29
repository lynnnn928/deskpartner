import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runMigrations } from '../../../src/main/database/migrations'
import {
  LIST_DESC_PREVIEW_CHARS,
  summarizeDescription,
  isDescriptionTruncated,
  commands,
  riskOf,
  grantTargetResolverNames
} from '../../../src/main/cli/commands'

const db = new Database(':memory:')
vi.mock('../../../src/main/database/index', () => ({
  getDatabase: () => db
}))

/**
 * ⚠️ 必须拦掉「写真实凭据文件」这一步（2026-09-22 踩的坑）
 *
 * 这里只 mock 了数据库（getDatabase → 内存库），但**漏了文件系统那一层**：
 * `writeCredential()` 内部是 `fs.writeFileSync(~/.deskpartner/credentials.json)`，
 * 它跟数据库毫无关系，于是在测试里照写不误。
 *
 * 触发路径：本文件有若干用例在内存库里 `setApproved('agent:bob', true)`，
 * 而库里没有该身份的凭据 → `assertCallerAllowed` 的「升级补发」分支被执行
 * （已批准但无凭据 → 补发一份）→ issueCredential 写**内存库**（无害）
 * → writeCredential 写**真实磁盘**（污染！）。
 *
 * 真实后果：每跑一次 `npm test`，本机 bob 的磁盘凭据就被换成测试随机生成的
 * token，而真实库里的 hash 没变 → Bob下次调用全部 `credential_invalid`。
 * 症状延迟到它下次调用才出现，所以极难联想到"跑过测试"。当晚实测撞上，
 * 排查了两轮才定位到这一行。
 *
 * 只覆盖 writeCredential，其余（hashToken / generateToken / readCredentials）
 * 保持真实实现 —— 测试需要真实的哈希行为，而它们没有写盘副作用。
 */
vi.mock('../../../src/cli/credentials', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/cli/credentials')>()
  return { ...actual, writeCredential: vi.fn() }
})

let seq = 0
vi.mock('uuid', () => ({
  v4: () => `cli-uuid-${++seq}`
}))

/**
 * 命令表测试为什么有必要
 *
 * 这个项目的教训是"参数收下了却没传下去"：category:update 曾收了 color
 * 却只把 name 传给 repo，改色静默失效，tsc 抓不到、repository 单测也不走这层。
 * 只有对着命令表跑一遍，才能验证「CLI 声明能改 → 真的改到了」。
 */
const { TodoRepository } = await import('../../../src/main/database/todo.repository')
const { CategoryRepository } = await import('../../../src/main/database/category.repository')
const { ProjectRepository } = await import('../../../src/main/database/project.repository')
const { MemoRepository } = await import('../../../src/main/database/memo.repository')
const { SettingsRepository } = await import('../../../src/main/database/settings.repository')
const { AgentRepository } = await import('../../../src/main/database/agent.repository')
const { CommentRepository } = await import('../../../src/main/database/comment.repository')
const { NotificationRepository } = await import('../../../src/main/database/notification.repository')
const { ReleaseRepository } = await import('../../../src/main/database/release.repository')
const { ReminderReceiptRepository } = await import('../../../src/main/database/reminder-receipt.repository')
const { RulesRepository } = await import('../../../src/main/database/rules.repository')
const { ProtocolRepository } = await import('../../../src/main/database/protocol.repository')
const { ProfileRepository } = await import('../../../src/main/database/profile.repository')
const { EventsRepository } = await import('../../../src/main/database/events.repository')
const { executeOne, executeApproved } = await import('../../../src/main/cli/commands')

const todoRepo = new TodoRepository()
const categoryRepo = new CategoryRepository()
const projectRepo = new ProjectRepository()
const memoRepo = new MemoRepository()
const settingsRepo = new SettingsRepository()
const agentRepo = new AgentRepository()
const commentRepo = new CommentRepository()
const notificationRepo = new NotificationRepository()
const releaseRepo = new ReleaseRepository()
const reminderReceiptRepo = new ReminderReceiptRepository()
const rulesRepo = new RulesRepository()
const protocolRepo = new ProtocolRepository()
const profileRepo = new ProfileRepository()

/**
 * 「未注册身份只能读、不能写」生效后，用例里用 agent: 身份写入会被自己的规则拦下。
 * 注册动作必须放在 beforeAll（迁移之后），不能在模块顶层 —— 那时 agents 表还不存在。
 */

const ctx = {
  deps: {
    todoRepo,
    categoryRepo,
    projectRepo,
    memoRepo,
    settingsRepo,
    agentRepo,
    releaseRepo,
    /* 卡 69788c32：命令层要读哪个仓储由 deps 决定 —— 缺一个，跑到那条命令就炸 */
    commentRepo,
    notificationRepo,
    reminderReceiptRepo,
    rulesRepo,
    protocolRepo,
    profileRepo,
    events: { append: vi.fn() },
    telemetry: { record: vi.fn(), stats: vi.fn(), query: vi.fn(), clear: vi.fn() }
  },
  meta: {
    version: 'test',
    dbPath: ':memory:',
    schemaVersion: 11,
    busyTimeoutMs: 5000,
    channels: ['headless' as const],
    via: 'headless' as const,
    startedAt: Date.now()
  },
  /**
   * 默认按「人在终端敲」：1.0.35 起写命令要过调用方门禁，
   * 而既有用例验证的是命令本身的行为，不该被门禁喧宾夺主。
   * 门禁自己有一组专门的用例（见文末「调用方门禁」）。
   */
  interactive: true
}

/** 建一条带完整关联的待办：项目 + 标签 + 描述 + 截止时间 */
function seed() {
  const cat = categoryRepo.create({ name: '原方向', color: '#1', sortOrder: 0 })
  const proj = projectRepo.create({ name: '原项目' })
  const todo = todoRepo.create({
    title: '原始标题',
    description: '原始描述',
    categoryIds: [cat.id],
    projectId: proj.id,
    priority: 'normal',
    dueAt: '2026-09-20T10:00:00.000Z'
  })
  return { cat, proj, todo }
}

async function run(args: string[]) {
  return executeOne(ctx as never, args)
}

/**
 * 「未注册身份只能读、不能写」生效后，用例里用 agent: 身份写入会被自己的规则拦下。
 * 注册放在**文件级** beforeAll：迁移之后才建得出 agents 表，且要对所有 describe 生效。
 */
beforeAll(() => {
  runMigrations(db)
  agentRepo.register({ id: 'agent:alice', displayName: 'Alice' })
  agentRepo.register({ id: 'agent:bob', displayName: 'Bob' })
})

describe('todo update', () => {
  beforeAll(() => {
    runMigrations(db)
    // 迁移之后才能注册身份（agents 表此时才存在）
    agentRepo.register({ id: 'agent:alice', displayName: 'Alice' })
    agentRepo.register({ id: 'agent:bob', displayName: 'Bob' })
  })

  beforeEach(() => {
    db.prepare('DELETE FROM todo_categories').run()
    db.prepare('DELETE FROM memos').run()
    db.prepare('DELETE FROM todos').run()
    db.prepare('DELETE FROM projects').run()
    db.prepare('DELETE FROM categories').run()
    /**
     * 预建「测试项目」：1.0.40 起 `--project` 传不存在的名字会**报错**
     * （原先静默新建，错字会分叉出垃圾项目 —— Bob实测报的）。
     * 本文件有 20+ 处用 `--project '测试项目'`，预建一个最省改动，
     * 也更贴近真实场景（项目本来就该先存在）。
     */
    // 先重置 id 计数器再预建：否则预建项目会消耗 cli-uuid-N，
    // 而随后的 seq=0 又把它归零，用例内新建的对象会撞上同一个 id
    // （UNIQUE constraint failed: projects.id）。顺序反了才是根因。
    seq = 0
    projectRepo.create({ name: '测试项目' })
  })

  it('改标题与优先级，id 不变、项目和标签不丢', async () => {
    const { cat, proj, todo } = seed()
    const res = await run([
      'todo', 'update', todo.id,
      '--title', '新标题',
      '--priority', 'high'
    ])

    expect(res.ok).toBe(true)
    const after = todoRepo.getById(todo.id)!
    expect(after.title).toBe('新标题')
    expect(after.priority).toBe('high')
    // 关键：不是"改好了但换了个东西"
    expect(after.id).toBe(todo.id)
    expect(after.projectId).toBe(proj.id)
    expect(after.categoryIds).toEqual([cat.id])
  })

  it('状态能从 done 改回 todo —— 此前没有任何出口', async () => {
    const { todo } = seed()
    todoRepo.update({ id: todo.id, status: 'done' })
    expect(todoRepo.getById(todo.id)!.status).toBe('done')

    const res = await run(['todo', 'update', todo.id, '--status', 'todo'])
    expect(res.ok).toBe(true)

    const after = todoRepo.getById(todo.id)!
    expect(after.status).toBe('todo')
    // 回退后完成时间必须一起清掉，否则"未完成却有完成时间"是脏数据
    expect(after.completedAt).toBeNull()
  })

  it('--desc 传空串表示清空描述', async () => {
    const { todo } = seed()
    const res = await run(['todo', 'update', todo.id, '--desc', ''])
    expect(res.ok).toBe(true)
    expect(todoRepo.getById(todo.id)!.description).toBeNull()
  })

  /**
   * `--comment-file` 是死参数（1.0.73 修，续做 `3c522bdb`）
   *
   * ## 缺陷本体
   *
   * 它只声明在 `todo update` 的 `args` 里 —— 启动器的展开表没有它、
   * 服务端的拦截表也没有它。于是服务端收到它时**既不认识、也不报错**，
   * 而"至少要改一个字段"那条校验只数 `patch`，`--comment-file` 不进 patch。
   *
   * 后果是一句 `todo update <id> --status x --comment-file f.txt`：
   * **状态改了、评论正文被静默丢弃、回执 ok:true**。
   * 这是本项目反复在治的"一半成功一半静默失败"的第四例
   * （前三例：--desc-file / --body-file / batch 的 --desc-file）。
   *
   * 判据：**改状态可以成功，但正文不许被悄悄丢掉** ——
   * 要么展开成评论写进去，要么明确报错，不能"看着成功"。
   */
  it('--comment-file 走服务端：明确报错，且状态不被改（不留下"改了一半"）', async () => {
    const { todo } = seed()
    expect(todoRepo.getById(todo.id)!.status).toBe('todo')

    const res = await run(['todo', 'update', todo.id, '--status', 'in_progress', '--comment-file', 'C:/tmp/nope.txt'])

    expect(res.ok).toBe(false)
    expect(res.code).toBe(2)
    expect(res.message).toContain('--comment-file')
    expect(res.message).toContain('--comment')
    // 报错发生在 run 之前 → 状态必须原样不动
    expect(todoRepo.getById(todo.id)!.status).toBe('todo')
  })

  /**
   * fa608cb9：`--desc` 默认语义从"替换"改成"追加"（1.0.49）
   *
   * 事故本身：主用户给 10 条别人提的事项跑 `--desc` 复测留证，
   * 回执看着是普通编辑，实际把原文（含"1.0.44 已做，请验收"这类
   * 实现细节）整段冲掉，最后靠碰巧存在的 v19 快照才救回来。
   *
   * 下面 5 条用例分别钉住：默认追加、显式替换、追加可追溯（署名/时间）、
   * 变更入审计（能被找回）、长度骤降给提醒。
   */
  it('--desc 默认追加：原文还在，补充内容接在后面（fa608cb9）', async () => {
    const { todo } = seed() // 原始描述 = '原始描述'
    const res = await run(['todo', 'update', todo.id, '--desc', '复测通过'])
    expect(res.ok).toBe(true)

    const after = todoRepo.getById(todo.id)!.description!
    // 原文必须完整保留 —— 这是这条修复的全部意义
    expect(after).toContain('原始描述')
    expect(after).toContain('复测通过')
    // 原文在前、补充在后，中间有分隔线，且补充带署名
    expect(after.indexOf('原始描述')).toBeLessThan(after.indexOf('复测通过'))
    expect(after).toContain('---')
    expect(after).toMatch(/补充（.+?·.+?）：/)
  })

  it('--overwrite-desc 才整体替换（老语义，显式声明）', async () => {
    const { todo } = seed()
    const res = await run([
      'todo', 'update', todo.id,
      '--desc', '整段重写',
      '--overwrite-desc'
    ])
    expect(res.ok).toBe(true)
    expect(todoRepo.getById(todo.id)!.description).toBe('整段重写')
  })

  it('--overwrite-desc 单独用（不带 --desc）报用法错误，不静默无效', async () => {
    const { todo } = seed()
    const res = await run(['todo', 'update', todo.id, '--overwrite-desc'])
    expect(res.ok).toBe(false)
    expect(res.code).toBe(2)
    // 原描述不能被动
    expect(todoRepo.getById(todo.id)!.description).toBe('原始描述')
  })

  it('描述变更入审计：追加记 append（before 为空，原文仍在新值里）', async () => {
    const { todo } = seed()
    const append = ctx.deps.events.append as unknown as ReturnType<typeof vi.fn>
    append.mockClear()

    await run(['todo', 'update', todo.id, '--desc', '补充一句'])

    const call = append.mock.calls.find(
      (c) => (c[2] as { action?: string })?.action === 'description_changed'
    )
    expect(call).toBeTruthy()
    const payload = call![2] as Record<string, unknown>
    expect(payload.mode).toBe('append')
    // 追加场景原文仍在新值中，不该重复存一份 before（避免 events 被撑大）
    expect(payload.before).toBeNull()
    expect(String(payload.after)).toContain('原始描述')
  })

  it('描述变更入审计：整体替换记 replace（before 存完整原文，能找回）', async () => {
    const { todo } = seed()
    const append = ctx.deps.events.append as unknown as ReturnType<typeof vi.fn>
    append.mockClear()

    await run(['todo', 'update', todo.id, '--desc', '短', '--overwrite-desc'])

    const call = append.mock.calls.find(
      (c) => (c[2] as { action?: string })?.action === 'description_changed'
    )
    expect(call).toBeTruthy()
    const payload = call![2] as Record<string, unknown>
    expect(payload.mode).toBe('replace')
    // 存的是完整正文 —— 这条记录存在的唯一理由就是"想找回原文"
    expect(payload.before).toBe('原始描述')
    expect(payload.after).toBe('短')
  })

  it('描述长度骤降到 30% 以下时给提醒（不拦执行，成功但带 notice）', async () => {
    const cat = categoryRepo.create({ name: '方向', color: '#1', sortOrder: 0 })
    const long = '很长的原始描述。'.repeat(40) // 约 320 字
    const t = todoRepo.create({ title: '带长描述', description: long, categoryIds: [cat.id] })

    const res = await run(['todo', 'update', t.id, '--desc', '短', '--overwrite-desc'])

    // 覆写是合法操作，不该被拒绝 —— 只是不能悄悄发生
    expect(res.ok).toBe(true)
    expect(res.notice).toBeTruthy()
    expect(res.notice).toContain('字')
    // 数据确实被改了（提醒不是拒绝）
    expect(todoRepo.getById(t.id)!.description).toBe('短')
  })

  it('正常补充（描述变长）不触发骤降提醒', async () => {
    const cat = categoryRepo.create({ name: '方向', color: '#1', sortOrder: 0 })
    const t = todoRepo.create({
      title: '带描述',
      description: '一句原始描述',
      categoryIds: [cat.id]
    })

    const res = await run(['todo', 'update', t.id, '--desc', '补一段更长的内容说明情况'])
    expect(res.ok).toBe(true)
    expect(res.notice).toBeUndefined()
  })

  it('--due clear 清空截止时间', async () => {
    const { todo } = seed()
    const res = await run(['todo', 'update', todo.id, '--due', 'clear'])
    expect(res.ok).toBe(true)
    expect(todoRepo.getById(todo.id)!.dueAt).toBeNull()
  })

  it('一个字段都不改时报错，而不是"成功但什么都没动"', async () => {
    const { todo } = seed()
    const res = await run(['todo', 'update', todo.id])
    expect(res.ok).toBe(false)
    expect(res.code).toBe(2)
    // 原数据必须完好
    expect(todoRepo.getById(todo.id)!.title).toBe('原始标题')
  })

  /**
   * f5e76697 回归钉：批准凭证是**通道事实**（不落库、不算字段变更，
   * `UpdateTodoInput.preApprovedGrantId` 注释里的原话）。
   *
   * 实测踩过：它被塞进 patch 组装后恒有一个键，
   * 上面那条「一个字段都不改」的检查数键数出 1 个"改动"，报错被吞成假成功。
   * 这里钉**更锋利的形状**：零字段改动、但带人批准凭证 —— 依旧报错。
   * （只钉"不带凭证"的形状不够：有人按"滤掉 undefined"修就会假绿。）
   */
  it('人批准凭证不算"改了东西"（f5e76697）：零字段改动 + 带凭证仍报错', async () => {
    const { todo } = seed()
    const res = await executeOne({ ...ctx, preApprovedGrantId: 'grant-x' } as never, [
      'todo',
      'update',
      todo.id
    ])
    expect(res.ok).toBe(false)
    expect(res.code).toBe(2)
    expect(todoRepo.getById(todo.id)!.title).toBe('原始标题')
  })

  it('支持 id 前缀，不必先 list 拿全串', async () => {
    const { todo } = seed()
    const res = await run(['todo', 'update', todo.id.slice(0, 8), '--title', '前缀改的'])
    expect(res.ok).toBe(true)
    expect(todoRepo.getById(todo.id)!.title).toBe('前缀改的')
  })

  it('标签不存在时报 not_found，且不改动原标签', async () => {
    const { cat, todo } = seed()
    const res = await run(['todo', 'update', todo.id, '--category', '不存在的方向'])
    expect(res.ok).toBe(false)
    expect(res.errorCode).toBe('not_found')
    // 失败不能留下半改状态
    expect(todoRepo.getById(todo.id)!.categoryIds).toEqual([cat.id])
  })

  it('改标签是覆盖，不是追加', async () => {
    const { todo } = seed()
    const other = categoryRepo.create({ name: '新方向', color: '#2', sortOrder: 1 })
    const res = await run(['todo', 'update', todo.id, '--category', '新方向'])
    expect(res.ok).toBe(true)
    expect(todoRepo.getById(todo.id)!.categoryIds).toEqual([other.id])
  })

  it('--project clear 被拒（1.0.37 起项目必填，清空等于给必填开后门）', async () => {
    const { proj, todo } = seed()
    const res = await run(['todo', 'update', todo.id, '--project', 'clear'])
    expect(res.ok).toBe(false)
    expect(res.code).toBe(2)
    expect(res.message).toContain('不能清空')
    // 拦下了就真的没动：归属还在
    expect(todoRepo.getById(todo.id)!.projectId).toBe(proj.id)
  })

  it('--project 空串同样被拒（留空是没填，清空是主动抹掉已有归属）', async () => {
    const { proj, todo } = seed()
    const res = await run(['todo', 'update', todo.id, '--project', ''])
    expect(res.ok).toBe(false)
    expect(res.code).toBe(2)
    expect(todoRepo.getById(todo.id)!.projectId).toBe(proj.id)
  })

  it('--parent 挂到父需求下', async () => {
    const { todo } = seed()
    const parent = todoRepo.create({ title: '父需求', status: 'todo' })
    const res = await run(['todo', 'update', todo.id, '--parent', parent.id])
    expect(res.ok).toBe(true)
    expect(todoRepo.getById(todo.id)!.parentId).toBe(parent.id)
  })

  it('--parent 前缀有歧义时报错而不是随便挑一个', async () => {
    const { todo } = seed()
    const parent = todoRepo.create({ title: '父需求', status: 'todo' })
    /**
     * 本文件 mock 的 id 是 `cli-uuid-N`，前 8 位对所有对象都一样，
     * 所以这个前缀必然是歧义的。这里验的是**歧义时不许猜** ——
     * 猜错会把子任务挂到毫不相干的父需求下，而且挂完看不出来。
     * （真实 uuid 下 8 位前缀几乎不可能撞，但"不猜"这条规则必须成立。）
     */
    const res = await run(['todo', 'update', todo.id, '--parent', 'cli-uuid'])
    expect(res.ok).toBe(false)
    expect(todoRepo.getById(todo.id)!.parentId).toBeNull()
    expect(parent.id).not.toBe(todo.id)
  })

  it('--parent clear 把子任务摘出来（不是报错）', async () => {
    const { todo } = seed()
    const parent = todoRepo.create({ title: '父需求', status: 'todo' })
    todoRepo.update({ id: todo.id, parentId: parent.id })
    expect(todoRepo.getById(todo.id)!.parentId).toBe(parent.id)

    const res = await run(['todo', 'update', todo.id, '--parent', 'clear'])
    expect(res.ok).toBe(true)
    expect(todoRepo.getById(todo.id)!.parentId).toBeNull()
  })

  it('--parent 传不存在的 id 报 not_found，并提示怎么查', async () => {
    const { todo } = seed()
    const res = await run(['todo', 'update', todo.id, '--parent', 'deadbeef'])
    expect(res.ok).toBe(false)
    // 不能让它炸成 FOREIGN KEY constraint failed —— 那种消息既不说是哪个参数也不说怎么改
    expect(res.message).toContain('父需求不存在')
    expect(res.message).toContain('todo list --brief')
  })

  it('--parent 挂到自己被拒（自引用会让层级遍历原地打转）', async () => {
    const { todo } = seed()
    const res = await run(['todo', 'update', todo.id, '--parent', todo.id])
    expect(res.ok).toBe(false)
    expect(res.code).toBe(2)
    expect(res.message).toContain('不能是自己')
  })

  it('--parent 挂到「待确认」的父需求被 G1 拦下', async () => {
    const { todo } = seed()
    // proposed = 还在待确认列，围绕它铺子任务等于在人点头前定死工作量
    const parent = todoRepo.create({ title: '待确认父需求', status: 'proposed' })
    const res = await run(['todo', 'update', todo.id, '--parent', parent.id])
    expect(res.ok).toBe(false)
    expect(res.message).toContain('待确认')
  })

  /**
   * 根因已定位（2026-09-22 修）：**不是 `--project` 的行为问题**，是测试自身的
   * id 计数器与预建项目的顺序反了。
   *
   * 具体是：`beforeEach` 里先 `projectRepo.create({ name: '测试项目' })`
   * 再 `seq = 0`。预建项目消耗掉 `cli-uuid-N`（N 承接上一个 describe 的遗留值），
   * 紧接着 seq 被归零 —— 于是用例内新建的对象又从 1 开始编号，
   * 撞上预建项目已占用的 id → `UNIQUE constraint failed: projects.id`。
   * 因为 N 取决于前序 describe 跑了多少次，所以**单跑通过、全量失败**。
   *
   * 修法：全文件 11 处 `beforeEach` 统一改成**先 `seq = 0` 再预建项目**。
   *
   * 教训：这条卡了很久的原因是**始终没打印 `res.message`** ——
   * 一直在猜"是不是 --project 校验太严"，而真实报错第一行就写着是哪张表撞了。
   * 遇到"单跑过、全量挂"先打真实错误，别先改断言。
   */
  it('--project 传新名字：改归属，不是清空', async () => {
    const { todo } = seed()
    projectRepo.create({ name: '另一个项目' })
    const res = await run(['todo', 'update', todo.id, '--project', '另一个项目'])
    expect(res.ok).toBe(true)
    const after = todoRepo.getById(todo.id)!
    expect(after.projectId).not.toBeNull()
    expect(projectRepo.getById(after.projectId!)!.name).toBe('另一个项目')
  })
})

describe('候选池（proposed / awaiting_review）', () => {
  beforeAll(() => {
    runMigrations(db)
    agentRepo.register({ id: 'agent:alice', displayName: 'Alice' })
  })

  beforeEach(() => {
    db.prepare('DELETE FROM todo_categories').run()
    db.prepare('DELETE FROM memos').run()
    db.prepare('DELETE FROM todos').run()
    db.prepare('DELETE FROM projects').run()
    db.prepare('DELETE FROM categories').run()
    /**
     * 预建「测试项目」：1.0.40 起 `--project` 传不存在的名字会**报错**
     * （原先静默新建，错字会分叉出垃圾项目 —— Bob实测报的）。
     * 本文件有 20+ 处用 `--project '测试项目'`，预建一个最省改动，
     * 也更贴近真实场景（项目本来就该先存在）。
     */
    // 先重置 id 计数器再预建：否则预建项目会消耗 cli-uuid-N，
    // 而随后的 seq=0 又把它归零，用例内新建的对象会撞上同一个 id
    // （UNIQUE constraint failed: projects.id）。顺序反了才是根因。
    seq = 0
    projectRepo.create({ name: '测试项目' })
  })

  it('todo add --status proposed 创建「待确认」提议', async () => {
    const cat = categoryRepo.create({ name: '方向', color: '#1', sortOrder: 0 })
    const res = await run([
      'todo', 'add', '--title', '调研迁移方案', '--created-by', 'agent:alice',
      '--category', '方向', '--status', 'proposed', '--project', '测试项目'
    ])
    expect(res.ok).toBe(true)
    const list = todoRepo.list({ status: 'proposed' })
    expect(list).toHaveLength(1)
    expect(list[0].title).toBe('调研迁移方案')
    expect(list[0].categoryIds).toEqual([cat.id])
  })

  it('todo add --type/--created-by/--executed-by 落库，--owner 兼容别名映射提出者', async () => {
    // 本 describe 的 beforeEach 会清库，身份可能被清掉 —— 用例内补一次注册
    agentRepo.register({ id: 'agent:alice', displayName: 'Alice' })
    // 这条用例要验证的是 --owner 别名映射，用到的身份必须先注册，否则会被身份校验拦下
    agentRepo.register({ id: 'agent:qwen', displayName: 'Bob' })
    categoryRepo.create({ name: '方向', color: '#1', sortOrder: 0 })
    const res = await run([
      'todo', 'add', '--title', '导出按钮无响应', '--type', 'bug',
      '--created-by', 'agent:alice', '--executed-by', 'human', '--category', '方向',
      '--project', '测试项目'
    ])
    expect(res.ok).toBe(true)
    const id = (res.data as { id: string }).id
    const todo = todoRepo.getById(id)!
    expect(todo.type).toBe('bug')
    expect(todo.createdBy).toBe('agent:alice')
    expect(todo.executedBy).toBe('human')

    // 旧参数名仍可用：--owner 等价于 --created-by
    const res2 = await run(['todo', 'add', '--title', '旧参数', '--owner', 'agent:qwen', '--category', '方向', '--project', '测试项目'])
    expect(res2.ok).toBe(true)
    const todo2 = todoRepo.getById((res2.data as { id: string }).id)!
    expect(todo2.createdBy).toBe('agent:qwen')
  })

  /**
   * 「未注册身份不能写」上线后，凡是用了 agent: 身份的用例，那个身份必须是注册过的。
   *
   * 这条用例曾因此在身份校验上线后变红：它验证的是「--owner 等价于 --created-by」
   * 这个别名映射，跟身份毫无关系，却因为顺手用了个未注册的 agent:qwen 被拦下。
   * 修的是测试装置（把用到的身份补注册），不是被测逻辑 ——
   * 拦人对着，错的是这条用例没跟着新规则更新自己的前提。
   */
  it('身份未注册的写入被拦下（退出码 3，不是笼统的 exit 1）', async () => {
    categoryRepo.create({ name: '方向', color: '#1', sortOrder: 0 })
    const res = await run([
      'todo', 'add', '--title', '幽灵写入', '--created-by', 'agent:ghost-x', '--category', '方向',
      '--project', '测试项目'
    ])
    expect(res.ok).toBe(false)
    expect(res.code).toBe(3)
    expect(res.message).toContain('身份未注册')
    // 报错要能自愈：告诉调用方该跑什么命令，而不是只说"不行"
    expect(res.message).toContain('agent register')
  })

  it('--type 非法值报用法错误', async () => {
    const res = await run(['todo', 'add', '--title', 'x', '--type', 'story', '--project', '测试项目'])
    expect(res.ok).toBe(false)
    expect(res.code).toBe(2)
    expect(res.message).toContain('--type')
  })

  it('todo update --executed-by clear 清掉指派回到提出者执行', async () => {
    categoryRepo.create({ name: '方向', color: '#1', sortOrder: 0 })
    const todo = todoRepo.create({ title: 'x', createdBy: 'agent:a', executedBy: 'human' })
    const res = await run(['todo', 'update', todo.id, '--executed-by', 'clear'])
    expect(res.ok).toBe(true)
    expect(todoRepo.getById(todo.id)!.executedBy).toBeNull()
  })

  it('todo add 不能直接建成「待验收」—— 没有过程可验收', async () => {
    const res = await run(['todo', 'add', '--title', 'x', '--status', 'awaiting_review', '--project', '测试项目'])
    expect(res.ok).toBe(false)
    expect(res.code).toBe(2)
    expect(res.message).toContain('待验收')
  })

  /**
   * 1.0.68 语义变更（`e0ec5f32`）：G4 放开了一条 ——
   * **提议人可把自己的 proposed 降级为待办 / 撤回（挂起）**，
   * 理由是"收回自己的请求"与"替别人拍板"是两件不同的事。
   *
   * ⚠️ 因此这条断言的样例必须改。原来用 `run()` 建卡（actor = 该 agent，
   * 建成卡的 createdBy 也是同一个 agent）→ **那正好命中新放行通道**，
   * 于是 G4 不再触发。我第一版没改样例、全量红，报错还指向
   * 「errorCode 不是 guard_blocked」，像是守卫坏了。
   *
   * 改法：**用另一个身份建卡**，让它测「移别人的卡」—— 那是 G4 真正要拦的。
   */
  it('G4：把「别人」提的 proposed 挪出「待确认」被硬拦（Bob实测的绕过路径已封死）', async () => {
    categoryRepo.create({ name: '方向', color: '#2', sortOrder: 0 })
    const created = await run([
      'todo',
      'add',
      '--title',
      '提议',
      '--status',
      'proposed',
      '--project',
      '测试项目',
      '--created-by',
      'agent:bob'
    ])
    const id = (created.data as { id: string }).id

    const res = await run(['todo', 'update', id, '--status', 'todo'])
    expect(res.ok).toBe(false)
    expect(res.code).toBe(4)
    expect(res.errorCode).toBe('guard_blocked')
    expect(res.message).toContain('G4')
    expect(todoRepo.getById(id)!.status).toBe('proposed')

    // 转 awaiting_review 同样被拦
    const res2 = await run(['todo', 'update', id, '--status', 'awaiting_review'])
    expect(res2.ok).toBe(false)
    expect(res2.code).toBe(4)
  })

  it('G3：父需求转「待验收」，描述与评论都没有时，成功但带 notice 提醒', async () => {
    const cat = categoryRepo.create({ name: '方向', color: '#1', sortOrder: 0 })
    const parent = todoRepo.create({ title: '父需求', categoryIds: [cat.id] })

    const res = await run(['todo', 'update', parent.id, '--status', 'awaiting_review'])
    expect(res.ok).toBe(true)
    expect(res.notice).toBeTruthy()
    expect(res.notice).toContain('待验收')
    expect(res.notice).toContain('todo comment')
    expect(todoRepo.getById(parent.id)!.status).toBe('awaiting_review')
  })

  it('G3（1.0.54 起）：结论写在评论里，同样算交代过，不再提醒', async () => {
    const cat = categoryRepo.create({ name: '方向', color: '#1', sortOrder: 0 })
    const parent = todoRepo.create({ title: '父需求', categoryIds: [cat.id] })
    commentRepo.create({
      todoId: parent.id,
      authorType: 'agent',
      authorId: 'agent:alice',
      body: '完成了 X，结论是 Y，坑是 Z',
      kind: 'comment'
    })

    const res = await run(['todo', 'update', parent.id, '--status', 'awaiting_review'])
    expect(res.ok).toBe(true)
    expect(res.notice).toBeUndefined()
  })

  it('G3：描述里本来就有内容时，不带 notice（存量数据不受影响）', async () => {
    const cat = categoryRepo.create({ name: '方向', color: '#1', sortOrder: 0 })
    const parent = todoRepo.create({
      title: '父需求',
      description: '完成了 X，结论是 Y，坑是 Z',
      categoryIds: [cat.id]
    })

    const res = await run(['todo', 'update', parent.id, '--status', 'awaiting_review'])
    expect(res.ok).toBe(true)
    expect(res.notice).toBeUndefined()
  })

  it('G2 经 CLI 生效：子任务没做完时，父需求转「待验收」被拒绝，退出码 4', async () => {
    const cat = categoryRepo.create({ name: '方向', color: '#1', sortOrder: 0 })
    const parent = todoRepo.create({ title: '父需求', categoryIds: [cat.id] })
    todoRepo.create({ title: '子任务', categoryIds: [cat.id], parentId: parent.id })

    const res = await run(['todo', 'update', parent.id, '--status', 'awaiting_review'])
    expect(res.ok).toBe(false)
    expect(res.code).toBe(4)
    expect(res.errorCode).toBe('guard_blocked')
    expect(res.message).toContain('子任务')
    // 拒绝后父需求不能真的跑进验收列
    expect(todoRepo.getById(parent.id)!.status).toBe('todo')
  })

  it('不存在的事项按 not_found 归类（exit 3），不再混进 exit 1', async () => {
    const res = await run(['todo', 'done', 'nonexistent-id-xyz'])
    expect(res.ok).toBe(false)
    expect(res.code).toBe(3)
    expect(res.errorCode).toBe('not_found')
  })

  /**
   * G6（2c8f2680，主用户 2026-09-19 拍板）：G2 只守 awaiting_review，
   * 绕开它直接置 done 就能把没做完的子任务一起埋进「完成」。
   */
  it('G6：子任务没做完时，父需求直接置 done 被硬拦（退出码 4，不是笼统 exit 1）', async () => {
    const cat = categoryRepo.create({ name: '方向', color: '#1', sortOrder: 0 })
    const parent = todoRepo.create({ title: '父需求', categoryIds: [cat.id] })
    todoRepo.create({ title: '子任务', categoryIds: [cat.id], parentId: parent.id })

    const res = await run(['todo', 'update', parent.id, '--status', 'done'])
    expect(res.ok).toBe(false)
    expect(res.code).toBe(4)
    expect(res.errorCode).toBe('guard_blocked')
    expect(res.message).toContain('G6')
    expect(todoRepo.getById(parent.id)!.status).toBe('todo')
  })

  it('G6：todo done 这条快捷路径同样被拦', async () => {
    const cat = categoryRepo.create({ name: '方向', color: '#1', sortOrder: 0 })
    const parent = todoRepo.create({ title: '父需求', categoryIds: [cat.id] })
    todoRepo.create({ title: '子任务', categoryIds: [cat.id], parentId: parent.id })

    const res = await run(['todo', 'done', parent.id])
    expect(res.ok).toBe(false)
    expect(res.code).toBe(4)
  })

  it('G6：子任务做完后再归档放行 —— 合法路径不能被堵死', async () => {
    const cat = categoryRepo.create({ name: '方向', color: '#1', sortOrder: 0 })
    const parent = todoRepo.create({ title: '父需求', categoryIds: [cat.id] })
    const child = todoRepo.create({ title: '子任务', categoryIds: [cat.id], parentId: parent.id })

    // 先拦
    expect((await run(['todo', 'update', parent.id, '--status', 'done'])).ok).toBe(false)
    // 子任务完成后放行（结论按 1.0.54 口径走评论，不写进描述）
    todoRepo.update({ id: child.id, status: 'done' })
    commentRepo.create({
      todoId: parent.id,
      authorType: 'agent',
      authorId: 'agent:alice',
      body: '子任务全部完成',
      kind: 'comment'
    })
    const res = await run(['todo', 'update', parent.id, '--status', 'done'])
    expect(res.ok).toBe(true)
    expect(todoRepo.getById(parent.id)!.status).toBe('done')
  })

  it('G5：标完成时描述与评论都没有，带 notice 提醒（不拦）', async () => {
    const cat = categoryRepo.create({ name: '方向', color: '#1', sortOrder: 0 })
    const one = todoRepo.create({ title: '普通事项', categoryIds: [cat.id] })

    const res = await run(['todo', 'update', one.id, '--status', 'done'])
    expect(res.ok).toBe(true)
    expect(res.notice).toBeTruthy()
    expect(res.notice).toContain('todo comment')
    expect(todoRepo.getById(one.id)!.status).toBe('done')
  })

  it('G5（1.0.54 起）：结论写在评论里，标完成不再提醒', async () => {
    const cat = categoryRepo.create({ name: '方向', color: '#1', sortOrder: 0 })
    const one = todoRepo.create({ title: '普通事项', categoryIds: [cat.id] })
    /**
     * ⚠️ 1.0.110 起判据升级（收 `eec2e1e7`）：**评论本身要有结构性要素**，
     * 不是"有评论就行"。这条用例原来喂的是「结论：已按新口径落地」——
     * 那正是Bob实测里"每张都有评论、一半只有一行字"的那一半，
     * 现在会被提醒（新增的分档用例见 `g5-closure-structure-eec2e1e7.test.ts`）。
     */
    commentRepo.create({
      todoId: one.id,
      authorType: 'agent',
      authorId: 'agent:alice',
      body: '【做了什么】按新口径落地\n【验证】跑了这条用例\n【什么算通过】不再提醒',
      kind: 'comment'
    })

    const res = await run(['todo', 'update', one.id, '--status', 'done'])
    expect(res.ok).toBe(true)
    expect(res.notice).toBeUndefined()
  })

  it('G6：没有子任务的普通事项置 done 不受影响', async () => {
    const cat = categoryRepo.create({ name: '方向', color: '#1', sortOrder: 0 })
    const todo = todoRepo.create({ title: '普通事项', categoryIds: [cat.id] })
    const res = await run(['todo', 'done', todo.id])
    expect(res.ok).toBe(true)
  })
})

describe('batch（NDJSON 批量）', () => {
  beforeAll(() => {
    runMigrations(db)
  })

  beforeEach(() => {
    db.prepare('DELETE FROM todo_categories').run()
    db.prepare('DELETE FROM memos').run()
    db.prepare('DELETE FROM todos').run()
    db.prepare('DELETE FROM projects').run()
    db.prepare('DELETE FROM categories').run()
    /**
     * 预建「测试项目」：1.0.40 起 `--project` 传不存在的名字会**报错**
     * （原先静默新建，错字会分叉出垃圾项目 —— Bob实测报的）。
     * 本文件有 20+ 处用 `--project '测试项目'`，预建一个最省改动，
     * 也更贴近真实场景（项目本来就该先存在）。
     */
    // 先重置 id 计数器再预建：否则预建项目会消耗 cli-uuid-N，
    // 而随后的 seq=0 又把它归零，用例内新建的对象会撞上同一个 id
    // （UNIQUE constraint failed: projects.id）。顺序反了才是根因。
    seq = 0
    projectRepo.create({ name: '测试项目' })
  })

  it('batch --doc 输出记录格式说明（Bob反馈：格式零文档，猜了 3 次才试出）', async () => {
    const res = await run(['batch', '--doc'])
    expect(res.ok).toBe(true)
    const doc = res.data as { format: string; examples: string[] }
    expect(doc.format).toContain('cmd')
    expect(doc.format).toContain('positional')
    expect(doc.examples.length).toBeGreaterThan(0)
  })

  it('全部失败时整体失败（ok:false），不再 exit 0 装成功', async () => {
    categoryRepo.create({ name: '方向', color: '#1', sortOrder: 0 })
    const ctxWithStdin = {
      ...ctx,
      stdin: [
        // 第一条：缺 --title（用法错误）
        '{"cmd":"todo add"}',
        // 第二条：直接建 awaiting_review（被拒）
        '{"cmd":"todo add","args":{"--title":"x","--status":"awaiting_review","--project":"测试项目"}}'
      ].join('\n')
    }
    const res = await executeOne(ctxWithStdin as never, ['batch'])
    expect(res.ok).toBe(false)
    expect(res.errorCode).toBe('batch_all_failed')
    const data = res.data as { total: number; failed: number }
    expect(data.total).toBe(2)
    expect(data.failed).toBe(2)
  })

  it('部分成功时整体 ok，data.failed 可查失败数', async () => {
    categoryRepo.create({ name: '方向', color: '#1', sortOrder: 0 })
    const ctxWithStdin = {
      ...ctx,
      stdin: [
        '{"cmd":"todo add","args":{"--title":"好的","--category":"方向","--project":"测试项目"}}',
        '{"cmd":"todo add"}'
      ].join('\n')
    }
    const res = await executeOne(ctxWithStdin as never, ['batch'])
    expect(res.ok).toBe(true)
    const data = res.data as { total: number; failed: number; allFailed: boolean }
    expect(data.total).toBe(2)
    expect(data.failed).toBe(1)
    expect(data.allFailed).toBe(false)
  })
})

describe('todo pin / unpin', () => {
  beforeAll(() => {
    runMigrations(db)
  })

  beforeEach(() => {
    db.prepare('DELETE FROM todo_categories').run()
    db.prepare('DELETE FROM memos').run()
    db.prepare('DELETE FROM todos').run()
    db.prepare('DELETE FROM projects').run()
    db.prepare('DELETE FROM categories').run()
    /**
     * 预建「测试项目」：1.0.40 起 `--project` 传不存在的名字会**报错**
     * （原先静默新建，错字会分叉出垃圾项目 —— Bob实测报的）。
     * 本文件有 20+ 处用 `--project '测试项目'`，预建一个最省改动，
     * 也更贴近真实场景（项目本来就该先存在）。
     */
    // 先重置 id 计数器再预建：否则预建项目会消耗 cli-uuid-N，
    // 而随后的 seq=0 又把它归零，用例内新建的对象会撞上同一个 id
    // （UNIQUE constraint failed: projects.id）。顺序反了才是根因。
    seq = 0
    projectRepo.create({ name: '测试项目' })
  })

  it('置顶后 isPinned 为真，且不动其他字段', async () => {
    const { todo } = seed()
    const res = await run(['todo', 'pin', todo.id])
    expect(res.ok).toBe(true)
    const after = todoRepo.getById(todo.id)!
    expect(after.isPinned).toBe(true)
    // 置顶只该改置顶，别顺手动别的
    expect(after.title).toBe('原始标题')
  })

  it('unpin 能取消置顶', async () => {
    const { todo } = seed()
    await run(['todo', 'pin', todo.id])
    const res = await run(['todo', 'unpin', todo.id])
    expect(res.ok).toBe(true)
    expect(todoRepo.getById(todo.id)!.isPinned).toBe(false)
  })
})

/**
 * category rm 的假成功（1.0.48 修，Bob f159d799）
 *
 * Bob实测：它按看板上的 8 位短号发 4 条 `category rm`，全部走完授权流程，
 * 三条授权被记成 consumed、回执说成功，**而四个分类一个都没少**。
 *
 * 根因不是"短号解析没做"这么简单 —— 是 `delete()` 查不到时
 * **静默返回 affectedTodos: 0** 而不报错，于是 exit 0、授权被消费、
 * 回执说成功。三重欺骗叠在一起：agent 以为完事、人以为点了允许就生效、
 * 审计账面上授权已经用掉。假成功比报错贵得多。
 */
describe('category rm 不能假成功（1.0.48）', () => {
  beforeAll(() => {
    runMigrations(db)
  })

  beforeEach(() => {
    db.prepare('DELETE FROM todos').run()
    db.prepare('DELETE FROM todo_categories').run()
    db.prepare('DELETE FROM categories').run()
  })

  it('短号能直接删（卡片上的 8 位，agent 自然会拿来用）', async () => {
    db.prepare(
      `INSERT INTO categories (id, name, color, is_default, sort_order) VALUES (?, ?, ?, ?, ?)`
    ).run('c8fbebbe-1234-5678-9abc-def012345678', '短号靶子', '#1', 0, 0)

    const res = await run(['category', 'rm', 'c8fbebbe', '--yes'])
    expect(res.ok).toBe(true)
    expect((res.data as { deleted: string }).deleted).toBe('c8fbebbe-1234-5678-9abc-def012345678')
    expect(categoryRepo.list()).toHaveLength(0)
  })

  it('不存在的 id 报 not_found（exit 3），不再静默成功', async () => {
    const res = await run(['category', 'rm', 'deadbeef', '--yes'])
    expect(res.ok).toBe(false)
    expect(res.code).toBe(3)
    expect(res.errorCode).toBe('not_found')
  })

  it('前缀歧义时拒绝执行，不随便挑一个删', async () => {
    db.prepare(
      `INSERT INTO categories (id, name, color, is_default, sort_order) VALUES (?, ?, ?, ?, ?)`
    ).run('abcd1111-0000-0000-0000-000000000000', 'A', '#1', 0, 0)
    db.prepare(
      `INSERT INTO categories (id, name, color, is_default, sort_order) VALUES (?, ?, ?, ?, ?)`
    ).run('abcd2222-0000-0000-0000-000000000000', 'B', '#2', 0, 1)

    const res = await run(['category', 'rm', 'abcd', '--yes'])
    expect(res.ok).toBe(false)
    expect(res.code).toBe(2) // usage_error
    expect(categoryRepo.list()).toHaveLength(2)
  })

  it('缺 --yes 时不删（原有防线不退化）', async () => {
    db.prepare(
      `INSERT INTO categories (id, name, color, is_default, sort_order) VALUES (?, ?, ?, ?, ?)`
    ).run('aaaa1111-0000-0000-0000-000000000000', '靶子', '#1', 0, 0)
    const res = await run(['category', 'rm', 'aaaa1111'])
    expect(res.ok).toBe(false)
    expect(res.code).toBe(2)
    expect(categoryRepo.list()).toHaveLength(1)
  })
})

describe('未知命令的报错', () => {
  beforeAll(() => {
    runMigrations(db)
  })

  it('首词能匹配时列出该前缀下的可用命令', async () => {
    const res = await run(['todo', 'updateee', 'x'])
    expect(res.ok).toBe(false)
    // 光说"未知命令"会逼 agent 多跑一轮 schema
    expect(res.message).toContain('update')
    expect(res.message).toContain('add')
    expect(res.message).toContain('list')
  })

  /**
   * 85740f50：`todo get` 被调用 11 次全部失败（当时该命令不存在）。
   *
   * 这类"猜一个不存在的命令"以后只会更多，所以除了列同前缀兄弟，
   * 还要在跨前缀写错时给近似命令（`todos list` → `todo list`）。
   */
  it('首词对不上但命令名近似时，提示「你是不是想用」', async () => {
    const res = await run(['todos', 'list'])
    expect(res.ok).toBe(false)
    expect(res.code).toBe(2)
    expect(res.message).toContain('你是不是想用')
    expect(res.message).toContain('todo list')
  })

  it('完全不沾边时不给建议 —— 硬凑建议等于噪音', async () => {
    const res = await run(['xyzzy'])
    expect(res.ok).toBe(false)
    expect(res.message).not.toContain('你是不是想用')
  })

  it('近似提示不越过同前缀兄弟 —— 前缀命中时优先列兄弟', async () => {
    const res = await run(['todo', 'nosuchcmd'])
    expect(res.ok).toBe(false)
    expect(res.message).toContain('todo 下可用')
    expect(res.message).not.toContain('你是不是想用')
  })
})

describe('project get/search 命令层契约', () => {
  let projectId: string
  let categoryId: string

  beforeEach(() => {
    db.exec(`
      DELETE FROM todo_comments;
      DELETE FROM todo_transitions;
      DELETE FROM todo_categories;
      DELETE FROM todos;
      DELETE FROM projects;
      DELETE FROM categories;
    `)
    seq = 0
    categoryRepo.initializeDefaults()
    categoryId = categoryRepo.list()[0].id
    projectId = projectRepo.create({
      name: 'CLI 接手项目',
      handoffMarkdown: '# CLI 接手背景\\n\\n入口关键字 needle'
    }).id
  })

  it('project get：默认只给接手说明与状态计数，不返回事项清单', async () => {
    const item = todoRepo.create({
      title: 'CLI 概览挂起项',
      categoryIds: [categoryId],
      projectId,
      status: 'suspended',
      createdBy: 'agent:runner',
      verifier: 'agent:reviewer',
      skipGuards: true
    })
    const result = await run(['project', 'get', projectId.slice(0, 8)])
    expect(result.ok).toBe(true)
    const data = result.data as {
      project: { id: string; handoffMarkdown: string }
      overview: {
        total: number
        statusCounts: Record<string, number>
        items: Array<{ id: string; executedBy: string; verifier: string }>
      }
      nextSteps?: string
    }
    expect(data.project).toMatchObject({ id: projectId, handoffMarkdown: '# CLI 接手背景\\n\\n入口关键字 needle' })
    expect(data.overview.total).toBe(1)
    expect(data.overview.statusCounts.suspended).toBe(1)
    expect(data.overview.items).toEqual([])
    expect(data.nextSteps).toContain('--limit')
    // 传 --limit 才给事项入口
    const withItems = await run(['project', 'get', projectId.slice(0, 8), '--limit', '20'])
    expect(withItems.ok).toBe(true)
    const itemsData = withItems.data as { overview: { items: Array<{ id: string; executedBy: string; verifier: string }> } }
    expect(itemsData.overview.items).toContainEqual(
      expect.objectContaining({ id: item.id, executedBy: 'agent:runner', verifier: 'agent:reviewer' })
    )
  })

  it('project search：全状态命中、回评论原文/作者/时间并拒绝未知参数', async () => {
    const done = todoRepo.create({
      title: '已完成事项',
      categoryIds: [categoryId],
      projectId,
      status: 'done',
      skipGuards: true
    })
    const discarded = todoRepo.create({
      title: 'needle 已废弃事项',
      categoryIds: [categoryId],
      projectId,
      status: 'discarded',
      skipGuards: true
    })
    const suspended = todoRepo.create({
      title: '挂起事项',
      description: 'needle 描述片段',
      categoryIds: [categoryId],
      projectId,
      status: 'suspended',
      skipGuards: true
    })
    const outsider = projectRepo.create({ name: 'CLI 边界外项目' })
    const outsideTodo = todoRepo.create({
      title: 'needle 边界外事项',
      categoryIds: [categoryId],
      projectId: outsider.id,
      status: 'done',
      skipGuards: true
    })
    const comment = commentRepo.create({
      todoId: done.id,
      body: '完成评论 needle 原文片段',
      authorType: 'agent',
      authorId: 'agent:reviewer'
    })

    const result = await run(['project', 'search', projectId, '--query', 'needle', '--limit', '100'])
    expect(result.ok).toBe(true)
    /**
     * 形状：`data` 是命中**数组**，计数在顶层 `meta`（1.0.107，修 `9bf9f667`）。
     * 1.0.106 一度改成 `{results, matched, ...}`，按数组解析的调用方会静默走空。
     */
    expect(Array.isArray(result.data)).toBe(true)
    const hits = result.data as Array<Record<string, unknown>>
    expect(result.meta).toMatchObject({
      matched: hits.length,
      returned: hits.length,
      truncated: false,
      nextOffset: null
    })
    expect(hits.map((hit) => hit.source)).toEqual(
      expect.arrayContaining(['handoff_markdown', 'todo_title', 'todo_description', 'comment'])
    )
    expect(hits.some((hit) => hit.todoId === discarded.id && hit.todoStatus === 'discarded')).toBe(true)
    expect(hits.some((hit) => hit.todoId === suspended.id && hit.todoStatus === 'suspended')).toBe(true)
    expect(hits.some((hit) => hit.todoId === outsideTodo.id)).toBe(false)
    expect(hits).toContainEqual(
      expect.objectContaining({
        source: 'comment',
        todoId: done.id,
        todoTitle: done.title,
        todoStatus: 'done',
        commentId: comment.id,
        author: 'agent:reviewer',
        createdAt: comment.createdAt,
        snippet: expect.stringContaining('完成评论 needle')
      })
    )

    const unknown = await run([
      'project', 'search', projectId, '--query', 'needle', '--not-declared', 'x'
    ])
    expect(unknown.ok).toBe(false)
    expect(unknown.code).toBe(2)
    const empty = await run(['project', 'search', projectId, '--query', '  '])
    expect(empty.ok).toBe(false)
    expect(empty.code).toBe(2)
  })

  it('project get/search 的分页元数据能提示调用方继续读取', async () => {
    for (let i = 0; i < 3; i++) {
      todoRepo.create({
        title: `分页事项 needle ${i}`,
        categoryIds: [categoryId],
        projectId,
        status: 'todo',
        skipGuards: true
      })
    }
    const detail = await run(['project', 'get', projectId, '--limit', '1'])
    expect(detail.ok).toBe(true)
    const overview = (detail.data as { overview: { total: number; returned: number; truncated: boolean; nextOffset: number | null; items: unknown[] } }).overview
    expect(overview.total).toBe(3)
    expect(overview.returned).toBe(1)
    expect(overview.truncated).toBe(true)
    expect(overview.nextOffset).toBe(1)
    expect(overview.items).toHaveLength(1)

    const page = await run(['project', 'search', projectId, '--query', '分页事项', '--limit', '1'])
    expect(page.ok).toBe(true)
    expect(Array.isArray(page.data)).toBe(true)
    expect(page.data).toHaveLength(1)
    expect(page.meta).toMatchObject({ matched: 3, returned: 1, truncated: true, nextOffset: 1 })
    const next = await run(['project', 'search', projectId, '--query', '分页事项', '--limit', '2', '--offset', '1'])
    expect(next.ok).toBe(true)
    expect(Array.isArray(next.data)).toBe(true)
    expect(next.data).toHaveLength(2)
    expect(next.meta).toMatchObject({ matched: 3, returned: 2, truncated: false, nextOffset: null })
  })
})

describe('todo get（1.0.49，修 85740f50）', () => {
  beforeAll(() => {
    runMigrations(db)
  })

  beforeEach(() => {
    db.prepare('DELETE FROM todo_categories').run()
    db.prepare('DELETE FROM todos').run()
    db.prepare('DELETE FROM projects').run()
    db.prepare('DELETE FROM categories').run()
    seq = 0
    projectRepo.create({ name: '测试项目' })
  })

  it('按 id 读一条，一次给全标签名/项目名/子任务进度/流转', async () => {
    const cat = categoryRepo.create({ name: '共享能力', color: '#1', sortOrder: 0 })
    const proj = projectRepo.create({ name: '某项目' })
    const parent = todoRepo.create({
      title: '父需求',
      description: '描述正文',
      categoryIds: [cat.id],
      projectId: proj.id
    })
    todoRepo.create({ title: '子1', categoryIds: [cat.id], parentId: parent.id })
    const child2 = todoRepo.create({ title: '子2', categoryIds: [cat.id], parentId: parent.id })
    todoRepo.update({ id: child2.id, status: 'done' })
    todoRepo.update({ id: parent.id, status: 'in_progress' })

    const res = await run(['todo', 'get', parent.id])
    expect(res.ok).toBe(true)
    const d = res.data as Record<string, unknown>

    // 基本信息
    expect(d.id).toBe(parent.id)
    expect(d.title).toBe('父需求')
    expect(d.description).toBe('描述正文')
    // 标签给名字而不只是 id —— 只给 id 等于让人再查一遍
    expect(d.categoryNames).toEqual(['共享能力'])
    expect(d.projectName).toBe('某项目')
    // 子任务进度
    expect(d.childCount).toBe(2)
    expect(d.childDone).toBe(1)
    // 流转历史：总数与实际带回的分开给，调用方才知道有没有被截断
    expect(d.transitionTotal).toBeGreaterThanOrEqual(2)
    expect(Array.isArray(d.transitions)).toBe(true)
  })

  it('支持 id 前缀（卡片上看到的就是 8 位）', async () => {
    const cat = categoryRepo.create({ name: '方向', color: '#1', sortOrder: 0 })
    const t = todoRepo.create({ title: '带前缀', categoryIds: [cat.id] })
    const res = await run(['todo', 'get', t.id.slice(0, 8)])
    expect(res.ok).toBe(true)
    expect((res.data as { id: string }).id).toBe(t.id)
  })

  it('--transitions 0 表示不带流转', async () => {
    const cat = categoryRepo.create({ name: '方向', color: '#1', sortOrder: 0 })
    const t = todoRepo.create({ title: '不带流转', categoryIds: [cat.id] })
    const res = await run(['todo', 'get', t.id, '--transitions', '0'])
    expect(res.ok).toBe(true)
    expect((res.data as { transitions: unknown[] }).transitions).toEqual([])
  })

  it('--transitions 传负数报用法错误', async () => {
    const cat = categoryRepo.create({ name: '方向', color: '#1', sortOrder: 0 })
    const t = todoRepo.create({ title: 'x', categoryIds: [cat.id] })
    const res = await run(['todo', 'get', t.id, '--transitions', '-1'])
    expect(res.ok).toBe(false)
    expect(res.code).toBe(2)
  })

  it('不存在的 id 报 not_found（exit 3），不是笼统 exit 1', async () => {
    const res = await run(['todo', 'get', 'nonexistent-xyz'])
    expect(res.ok).toBe(false)
    expect(res.code).toBe(3)
    expect(res.errorCode).toBe('not_found')
  })
})

describe('doctor 报 CLI 寻址状态（1.0.49，Bob 8bf64514 第三件）', () => {
  beforeAll(() => {
    runMigrations(db)
  })

  /**
   * 为什么这几条必须存在
   *
   * 说明书（`dp skill` 生成物）教 agent 用 `$DESKPARTNER_CLI` 寻址，
   * 并让它在拿不准时跑 `doctor` 自证。若 doctor 不报这一项，
   * 说明书就是在**承诺一个查不到的东西** —— agent 只能退回去硬写绝对路径，
   * 那正是这条缺陷要消灭的行为。所以"报得出"与"说明书这么教"必须一起验。
   */
  it('报出变量名、生效路径、来源与文件是否存在', async () => {
    const res = await run(['doctor'])
    expect(res.ok).toBe(true)
    const d = (res.data as { cli: Record<string, unknown> }).cli
    expect(d).toBeTruthy()
    expect(d.envVar).toBe('DESKPARTNER_CLI')
    expect(typeof d.value).toBe('string')
    expect(['env', 'env-missing-file', 'fallback']).toContain(d.source)
    expect(typeof d.exists).toBe('boolean')
    expect(typeof d.note).toBe('string')
  })

  it('路径统一正斜杠（agent 拿去拼命令不会踩反斜杠转义）', async () => {
    const res = await run(['doctor'])
    const d = (res.data as { cli: { value: string } }).cli
    expect(d.value).not.toContain('\\')
  })

  /**
   * 三种 source 的措辞必须各自可照做 —— 这是"报出来"的全部意义。
   * 若三种情况给同一句话，等于没报。
   */
  it('source=fallback 时说明是"没读到变量"，不断言"从未配过"', async () => {
    const saved = process.env.DESKPARTNER_CLI
    delete process.env.DESKPARTNER_CLI
    try {
      const res = await run(['doctor'])
      const d = (res.data as { cli: { source: string; note: string } }).cli
      expect(d.source).toBe('fallback')
      // 措辞不能写成"变量未配置"这种断言 —— 本进程没读到 ≠ 系统里没有
      expect(d.note).toContain('本进程')
    } finally {
      if (saved !== undefined) process.env.DESKPARTNER_CLI = saved
      else delete process.env.DESKPARTNER_CLI
    }
  })

  it('变量指向不存在的文件时单独报 env-missing-file（最坏的一种）', async () => {
    const saved = process.env.DESKPARTNER_CLI
    process.env.DESKPARTNER_CLI = 'C:/definitely/not/here/deskpartner.cjs'
    try {
      const res = await run(['doctor'])
      const d = (res.data as { cli: { source: string; exists: boolean; note: string } }).cli
      expect(d.source).toBe('env-missing-file')
      expect(d.exists).toBe(false)
      // 变量"看着配好了"但文件不在，是最难自查的一种，提示必须指路
      expect(d.note).toContain('重新安装')
    } finally {
      if (saved !== undefined) process.env.DESKPARTNER_CLI = saved
      else delete process.env.DESKPARTNER_CLI
    }
  })
})

describe('dp skill 说明书的寻址写法（1.0.49，Bob 8bf64514 第三件）', () => {
  /**
   * ⚠️ 不能在 describe 回调里 `await import` —— 那里不是 async 上下文，
   * 语法直接报 PARSE_ERROR（实测踩过）。放进 beforeAll。
   */
  let buildAgentGuide: (launcherPath?: string, version?: string) => string
  beforeAll(async () => {
    buildAgentGuide = (await import('../../../src/main/cli/agent-guide')).buildAgentGuide
  })

  /**
   * 说明书给哪种寻址方式，必须与本机实际有没有那个变量一致。
   * 不一致的后果是**文档制造故障**：教一句取不到值的命令，
   * agent 照抄后报"找不到文件"，而它会以为是 CLI 坏了。
   */
  it('变量在 → 教变量写法，并把绝对路径降级成兜底', () => {
    const saved = process.env.DESKPARTNER_CLI
    process.env.DESKPARTNER_CLI = 'C:/somewhere/deskpartner.cjs'
    try {
      const md = buildAgentGuide('C:/fallback/deskpartner.cjs', '9.9.9')
      expect(md).toContain('$DESKPARTNER_CLI')
      expect(md).toContain('C:/fallback/deskpartner.cjs')
      expect(md).toContain('兜底')
      // 正路是变量，路径不该再被写成"必须用绝对路径"
      expect(md).not.toContain('必须用绝对路径')
    } finally {
      if (saved !== undefined) process.env.DESKPARTNER_CLI = saved
      else delete process.env.DESKPARTNER_CLI
    }
  })

  it('变量不在 → 给绝对路径，并指路 doctor 与"启动一次界面后会改写法"', () => {
    const saved = process.env.DESKPARTNER_CLI
    delete process.env.DESKPARTNER_CLI
    try {
      const md = buildAgentGuide('C:/fallback/deskpartner.cjs', '9.9.9')
      // 绝不能教一个本机不存在的变量 —— 那就是文档制造的故障
      expect(md).not.toContain('$DESKPARTNER_CLI')
      expect(md).toContain('node "C:/fallback/deskpartner.cjs"')
      expect(md).toContain('doctor')
      expect(md).toContain('启动过一次界面')
    } finally {
      if (saved !== undefined) process.env.DESKPARTNER_CLI = saved
      else delete process.env.DESKPARTNER_CLI
    }
  })

  it('两条路都提醒"路径会随安装目录变化"（缺陷的原始代价）', () => {
    const saved = process.env.DESKPARTNER_CLI
    for (const set of [true, false]) {
      if (set) process.env.DESKPARTNER_CLI = 'C:/somewhere/deskpartner.cjs'
      else delete process.env.DESKPARTNER_CLI
      const md = buildAgentGuide('C:/fallback/deskpartner.cjs', '9.9.9')
      expect(md).toMatch(/搬家|安装目录/)
    }
    if (saved !== undefined) process.env.DESKPARTNER_CLI = saved
    else delete process.env.DESKPARTNER_CLI
  })

  it('两条路都不再教 .cmd 包装脚本（agent 用它会踩三重条件）', () => {
    const saved = process.env.DESKPARTNER_CLI
    process.env.DESKPARTNER_CLI = 'C:/somewhere/deskpartner.cjs'
    try {
      const md = buildAgentGuide('C:/fallback/deskpartner.cjs', '9.9.9')
      expect(md).toContain('不要用')
      expect(md).toContain('.cmd')
    } finally {
      if (saved !== undefined) process.env.DESKPARTNER_CLI = saved
      else delete process.env.DESKPARTNER_CLI
    }
  })
})

describe('parseFlags 的空串参数', () => {
  beforeAll(() => {
    runMigrations(db)
  })

  it('空串是合法参数值，不会被当成布尔 true', async () => {
    const { parseFlags } = await import('../../../src/main/cli/commands')
    const { flags } = parseFlags(['--desc', '', '--title', 'x'], [
      { flag: '--desc', type: 'string', desc: '' },
      { flag: '--title', type: 'string', desc: '' }
    ])
    // 曾经判真值，空串会落进 else 变成 true，"清空"语义丢失
    expect(flags['--desc']).toBe('')
    expect(flags['--title']).toBe('x')
  })

  it('strValue 把被吞成布尔的空参数还原为空串，而不是字符串 "true"', async () => {
    const { strValue } = await import('../../../src/main/cli/commands')
    /**
     * 实测踩到：经 PowerShell 调 `--desc ""`，空串被 shell 吞掉，
     * parseFlags 只能看到裸 --desc，判成布尔 true。
     * 若直接 String(true) 会把描述写成 "true" —— 数据脏且调用方不知情。
     */
    expect(strValue(true)).toBe('')
    expect(strValue(undefined)).toBe('')
    expect(strValue('')).toBe('')
    expect(strValue('真实内容')).toBe('真实内容')
  })
})

/**
 * Bob 21bd6f34：参数值以 -- 开头时被解析成 flag，落库后静默变成 true。
 * agent 报"某某 flag 不受支持"这类缺陷时，标题里带 --xxx 是常态，
 * 所以这一类必须钉死在测试里——它不报错，只是悄悄写错。
 */
describe('参数值以 -- 开头（21bd6f34）', () => {
  beforeAll(() => {
    runMigrations(db)
  })

  beforeEach(() => {
    db.prepare('DELETE FROM todo_categories').run()
    db.prepare('DELETE FROM todos').run()
    db.prepare('DELETE FROM projects').run()
    seq = 0
    projectRepo.create({ name: '测试项目' })  // 1.0.40：--project 传不存在的名字会报错，预建一个供测试用
    db.prepare('DELETE FROM categories').run()
  })

  it('长得像 flag 但不是本命令的 flag → 当值，不是当 flag', async () => {
    const { parseFlags } = await import('../../../src/main/cli/commands')
    const { flags } = parseFlags(['--title', '--help 未注册为受支持的 flag'], [
      { flag: '--title', type: 'string', desc: '' },
      { flag: '--desc', type: 'string', desc: '' }
    ])
    expect(flags['--title']).toBe('--help 未注册为受支持的 flag')
  })

  it('本命令认识的 flag 仍不被吞成值（--title --desc x 不该让 title 变成 x）', async () => {
    const { parseFlags } = await import('../../../src/main/cli/commands')
    const { flags } = parseFlags(['--title', '--desc', 'x'], [
      { flag: '--title', type: 'string', desc: '' },
      { flag: '--desc', type: 'string', desc: '' }
    ])
    expect(flags['--desc']).toBe('x')
    expect(flags['--title']).toBe(true)
  })

  it('batch 的值以 -- 开头：落库的是原值，不是 "true"', async () => {
    const { executeOne } = await import('../../../src/main/cli/commands')
    // repo 要求库里至少有一个分类（历史约定），否则 create 直接报"还没有任何分类"
    categoryRepo.create({ name: '临时方向', color: '#1', sortOrder: 0 })
    const line = JSON.stringify({
      cmd: 'todo add',
      args: {
        '--title': '--help 未注册为受支持的 flag',
        '--created-by': 'human',
        '--project': '测试项目'
      }
    })
    const res = await executeOne({ ...ctx, stdin: line } as never, ['batch'])
    expect(res.ok).toBe(true)

    const rows = db.prepare('SELECT title FROM todos').all() as Array<{ title: string }>
    expect(rows.map((r) => r.title)).toContain('--help 未注册为受支持的 flag')
    expect(rows.map((r) => r.title)).not.toContain('true')
  })
})

describe('子命令位置的 --help（21bd6f34）', () => {
  beforeAll(() => {
    runMigrations(db)
  })

  it('有必填参数的命令问用法：给用法，不报缺参数', async () => {
    // 曾经：todo add --help → "缺少必填参数 --title"（exit 2）
    const res = await run(['todo', 'add', '--help'])
    expect(res.ok).toBe(true)
    expect((res.data as { name: string }).name).toBe('todo add')
  })

  it('没有必填参数的命令问用法：给用法，不顺手执行', async () => {
    // 曾经：todo list --help → 静默忽略 --help，真的去查了一堆待办回来（exit 0）
    const res = await run(['todo', 'list', '--help'])
    expect(res.ok).toBe(true)
    expect((res.data as { name: string }).name).toBe('todo list')
  })

  it('help <命令> 与 <命令> --help 是同一份说明', async () => {
    const a = await run(['help', 'todo', 'add'])
    const b = await run(['todo', 'add', '--help'])
    expect(a.data).toEqual(b.data)
  })
})

describe('memo 命令', () => {
  beforeAll(() => {
    runMigrations(db)
  })

  beforeEach(() => {
    db.prepare('DELETE FROM todo_categories').run()
    db.prepare('DELETE FROM memos').run()
    db.prepare('DELETE FROM todos').run()
    db.prepare('DELETE FROM projects').run()
    db.prepare('DELETE FROM categories').run()
    /**
     * 预建「测试项目」：1.0.40 起 `--project` 传不存在的名字会**报错**
     * （原先静默新建，错字会分叉出垃圾项目 —— Bob实测报的）。
     * 本文件有 20+ 处用 `--project '测试项目'`，预建一个最省改动，
     * 也更贴近真实场景（项目本来就该先存在）。
     */
    // 先重置 id 计数器再预建：否则预建项目会消耗 cli-uuid-N，
    // 而随后的 seq=0 又把它归零，用例内新建的对象会撞上同一个 id
    // （UNIQUE constraint failed: projects.id）。顺序反了才是根因。
    seq = 0
    projectRepo.create({ name: '测试项目' })
  })

    it('memo add 建备忘，默认未读、作者是调用者身份（1.0.68 修：`--owner` 不再冒充 author）', async () => {
      const res = await run(['memo', 'add', '--text', 'todo rm 有条耗时异常，留意'])
      expect(res.ok).toBe(true)
      const list = memoRepo.list()
      expect(list).toHaveLength(1)
      expect(list[0].text).toBe('todo rm 有条耗时异常，留意')
      expect(list[0].status).toBe('unread')
      /**
       * ⚠️ 1.0.68 之前这里是 `expect(list[0].author).toBe('agent:cli')`
       * —— **那正是这个 bug 的化石**：把"没人认领的默认作者"当成正确行为钉住了，
       * 于是"收件人被写成作者"这件事被测试追认为合理。
       *
       * 现在 author = **本次调用的身份**（与 `todo add` 同一套归因），
       * 没指定收件人时 recipient 落 NULL 而**不是编一个**。
       */
      expect(list[0].author, 'author 应是调用者身份，而不是 agent:cli').not.toBe('agent:cli')
      expect(list[0].recipient, '没指定收件人时落 null，不编造').toBeNull()
      expect(list[0].readAt).toBeNull()
    })

    /* ── 1.0.68：递的人 vs 给谁（`3c436592`）── */

    it('`--to` 记收件人，author 仍是递的人（这是修好的核心）', async () => {
      await run(['memo', 'add', '--text', '这条给你', '--to', 'agent:qwen'])
      const m = memoRepo.list()[0]
      expect(m.recipient, '收件人没记上').toBe('agent:qwen')
      expect(
        m.author,
        'author 被收件人冒充了 —— 这就是该卡要修的那个错'
      ).not.toBe('agent:qwen')
    })

    it('`--owner` 保留为 `--to` 的别名（不打断既有用法）', async () => {
      await run(['memo', 'add', '--text', '别名也认', '--owner', 'agent:qwen'])
      expect(memoRepo.list()[0].recipient, '--owner 应等价于 --to').toBe('agent:qwen')
    })

    it('memo list --to-me 只看待在我这儿（分派可见）', async () => {
      await run(['memo', 'add', '--text', '给你的', '--to', 'agent:qwen'])
      await run(['memo', 'add', '--text', '我自己记的'])
      // ⚠️ run() 返回的是 { ok, data } **信封**，data 才是数组。
      // 我前两版分别按"裸数组"和"信封"读，拿到 undefined 与非数组，assert 全炸。
      const mine = (await run(['memo', 'list', '--to-me'])).data as Array<{
        recipient: string | null
      }>
      expect(
        mine.filter((m) => m.recipient === 'agent:qwen'),
        '给 agent:qwen 的不该出现在我这儿'
      ).toHaveLength(0)
    })

    it('memo list --from 按递的人筛（"谁递来的"查得出来了）', async () => {
      await run(['memo', 'add', '--text', 'x', '--to', 'agent:qwen'])
      const all = (await run(['memo', 'list'])).data as Array<{ author: string }>
      const selfAuthor = all[0].author
      const r = (await run(['memo', 'list', '--from', selfAuthor])).data as unknown[]
      expect(r).toHaveLength(1)
    })

    it('memo list --directed 只看指定了收件人的', async () => {
      await run(['memo', 'add', '--text', '给你的', '--to', 'agent:qwen'])
      await run(['memo', 'add', '--text', '我自己记的'])
      const r = (await run(['memo', 'list', '--directed'])).data as Array<{
        recipient: string | null
      }>
      expect(r).toHaveLength(1)
      expect(r[0].recipient).toBe('agent:qwen')
    })

  it('空内容直接报错 —— 备忘的价值就在内容本身', async () => {
    const res = await run(['memo', 'add', '--text', '   '])
    expect(res.ok).toBe(false)
    expect(res.message).toContain('--text')
  })

  it('--todo 关联待办：支持前缀，指向不存在的待办直接报错', async () => {
    const { todo } = seed()
    const ok = await run(['memo', 'add', '--text', '这条任务的坑', '--todo', todo.id.slice(0, 8)])
    expect(ok.ok).toBe(true)
    expect(memoRepo.list()[0].linkedTodoId).toBe(todo.id)

    const bad = await run(['memo', 'add', '--text', 'x', '--todo', 'nonexist99'])
    expect(bad.ok).toBe(false)
    expect(bad.message).toContain('不存在')
  })

  it('memo list 新→旧，--unread 只看未读，--brief 紧凑输出', async () => {
    await run(['memo', 'add', '--text', '第一条'])
    await run(['memo', 'add', '--text', '第二条'])
    memoRepo.ack(memoRepo.list()[0].id, 'human') // 最新那条已读

    const all = await run(['memo', 'list'])
    expect(all.ok).toBe(true)
    expect((all.data as unknown[]).length).toBe(2)

    const unread = await run(['memo', 'list', '--unread'])
    const unreadList = unread.data as Array<{ text: string }>
    expect(unreadList).toHaveLength(1)
    expect(unreadList[0].text).toBe('第一条') // 先创建的那条还没读（同毫秒时按 rowid 定序）

    const brief = await run(['memo', 'list', '--brief'])
    const briefList = brief.data as Array<Record<string, unknown>>
    expect(Object.keys(briefList[0]).sort()).toEqual(['author', 'id', 'text', 'unread'])
  })

  it('memo ack 标记已读并记时间；重复 ack 幂等不改时间', async () => {
    await run(['memo', 'add', '--text', '看一眼'])
    const target = memoRepo.list()[0]
    const first = await run(['memo', 'ack', target.id.slice(0, 8)])
    expect(first.ok).toBe(true)

    const afterFirst = memoRepo.get(target.id)!
    expect(afterFirst.status).toBe('read')
    expect(afterFirst.readAt).not.toBeNull()

    const second = await run(['memo', 'ack', target.id.slice(0, 8)])
    expect(second.ok).toBe(true)
    expect(memoRepo.get(target.id)!.readAt).toBe(afterFirst.readAt)
  })

  it('memo rm 需要 --yes；删除后列表为空', async () => {
    await run(['memo', 'add', '--text', '临时看看'])
    const target = memoRepo.list()[0]

    const noYes = await run(['memo', 'rm', target.id.slice(0, 8)])
    expect(noYes.ok).toBe(false)

    const ok = await run(['memo', 'rm', target.id.slice(0, 8), '--yes'])
    expect(ok.ok).toBe(true)
    expect(memoRepo.list()).toHaveLength(0)
  })

  /**
   * ui 命令（R2-3）
   *
   * 这层最该测的是「拒绝」而不是「成功」：白名单的意义就是挡住不该让 agent 碰的
   * 系统级与隐私项。一旦漏测，agent 就能关掉自己的行为记录或改开机自启，
   * 而界面上完全看不出来是谁干的。
   */
  describe('ui 命令（R2-3：agent 改界面）', () => {
    it('ui get 列出可改参数与当前值', async () => {
      const res = await run(['ui', 'get'])
      expect(res.ok).toBe(true)
      const data = res.data as { params: { key: string }[]; excluded: { key: string }[] }
      expect(data.params.some((p) => p.key === 'theme')).toBe(true)
      // 不开放的项要显式列出来，别让 agent 自己试错
      expect(data.excluded.map((e) => e.key)).toContain('telemetryEnabled')
    })

    it('ui get --key 看单个参数', async () => {
      const res = await run(['ui', 'get', '--key', 'theme'])
      expect(res.ok).toBe(true)
      expect((res.data as { key: string }).key).toBe('theme')
    })

    it('ui set 正常改一个视觉参数', async () => {
      const res = await run(['ui', 'set', '--key', 'theme', '--value', 'dark'])
      expect(res.ok).toBe(true)
      expect((res.data as { after: string }).after).toBe('dark')
      expect(settingsRepo.get().theme).toBe('dark')
    })

    it('拒绝白名单外的隐私开关（telemetryEnabled 绝不能开）', async () => {
      const res = await run(['ui', 'set', '--key', 'telemetryEnabled', '--value', 'false'])
      expect(res.ok).toBe(false)
      expect(res.errorCode).toBe('usage_error')
    })

    it('拒绝白名单外的系统级与窗口项', async () => {
      for (const key of ['autoStart', 'globalShortcut', 'kanbanAlwaysOnTop', 'customColors']) {
        const res = await run(['ui', 'set', '--key', key, '--value', 'x'])
        expect(res.ok, `${key} 应被白名单拦下`).toBe(false)
      }
    })

    it('枚举取值越界被拒', async () => {
      const res = await run(['ui', 'set', '--key', 'theme', '--value', 'rainbow'])
      expect(res.ok).toBe(false)
      expect(res.errorCode).toBe('usage_error')
    })

    it('数字超出范围被拒', async () => {
      const tooBig = await run(['ui', 'set', '--key', 'kanbanBorderRadius', '--value', '99'])
      expect(tooBig.ok).toBe(false)

      const tooSmall = await run(['ui', 'set', '--key', 'floatBallSize', '--value', '1'])
      expect(tooSmall.ok).toBe(false)
    })

    it('颜色格式不对被拒', async () => {
      const res = await run(['ui', 'set', '--key', 'floatBallColor', '--value', '蓝色'])
      expect(res.ok).toBe(false)
    })

    it('布尔值支持 true/false 与常见写法', async () => {
      const res = await run(['ui', 'set', '--key', 'cardActionsAlwaysVisible', '--value', 'false'])
      expect(res.ok).toBe(true)
      expect(settingsRepo.get().cardActionsAlwaysVisible).toBe(false)
    })

    /**
     * R3-1：身份注册
     *
     * 这层要证明的是「注册前后可区分」——未注册的标识照样能用，只是没有身份。
     * 别把它做成硬门槛，历史数据和一次性调用会先崩。
     */
    it('agent register 后 whoami 认得出来', async () => {
      await run(['agent', 'register', '--id', 'agent:smoke-a', '--name', '冒烟A', '--color', '#7F77DD'])
      const res = await run(['agent', 'whoami', 'agent:smoke-a'])
      expect(res.ok).toBe(true)
      const d = res.data as { id: string; registered: boolean; displayName: string; approved: boolean }
      expect(d.registered).toBe(true)
      expect(d.displayName).toBe('冒烟A')
      /**
       * 1.0.35 起新注册**默认未批准**：拿到身份 ≠ 拿到写权限，
       * 得人在界面上点头（否则 agent 自己注册就能写，门禁形同虚设）。
       */
      expect(d.approved).toBe(false)
    })

    it('未注册的标识 whoami 返回 registered=false，而不是报错', async () => {
      const res = await run(['agent', 'whoami', 'agent:never-registered'])
      expect(res.ok).toBe(true)
      expect((res.data as { registered: boolean }).registered).toBe(false)
    })

    it('重复 register 只更新展示信息，不改注册时间（不把老用户刷新用户）', async () => {
      await run(['agent', 'register', '--id', 'agent:smoke-b', '--name', '旧名字'])
      const first = await run(['agent', 'whoami', 'agent:smoke-b'])
      const createdAt = (first.data as { createdAt: string }).createdAt

      await run(['agent', 'register', '--id', 'agent:smoke-b', '--name', '新名字'])
      const second = await run(['agent', 'whoami', 'agent:smoke-b'])
      const d = second.data as { displayName: string; createdAt: string; reused?: boolean }
      expect(d.displayName).toBe('新名字')
      expect(d.createdAt).toBe(createdAt)
    })

    it('agent list 能列出已注册身份', async () => {
      await run(['agent', 'register', '--id', 'agent:smoke-c', '--name', '冒烟C'])
      const res = await run(['agent', 'list'])
      const list = res.data as Array<{ id: string }>
      expect(list.some((a) => a.id === 'agent:smoke-c')).toBe(true)
    })

    it('agent register 缺 --id / --name 会被拒', async () => {
      const noId = await run(['agent', 'register', '--name', 'x'])
      expect(noId.ok).toBe(false)
      const noName = await run(['agent', 'register', '--id', 'agent:x'])
      expect(noName.ok).toBe(false)
    })

    it('ui reset 恢复视觉默认', async () => {
      await run(['ui', 'set', '--key', 'theme', '--value', 'dark'])
      const res = await run(['ui', 'reset'])
      expect(res.ok).toBe(true)
      expect((res.data as { reset: boolean }).reset).toBe(true)
      // reset 只动视觉，系统级项不该被带走
      expect(typeof settingsRepo.get().telemetryEnabled).toBe('boolean')
    })
  })
})

describe('新 agent 接入闭环（1.0.63）', () => {
  /**
   * 主用户 2026-09-30：「新 agent 注册和教学的相关能力也一并考虑加上吧，
   * agent friendly 要从接入使用开始。」
   *
   * 这里锁住的是**接入第一步的闭环**：注册要主动通知人（否则 1.0.47 起
   * 自助注册的 agent 会静默躺在那里没人放行），回执要在**每一步**
   * 告诉它下一步敲什么（旧回执只回两个布尔值，调用方得自己推理卡在哪）。
   */
  const eventCalls: Array<{ type: string; actor: string; payload?: Record<string, unknown> | null }> = []

  beforeAll(() => {
    runMigrations(db)
  })

  beforeEach(() => {
    eventCalls.length = 0
    db.prepare('DELETE FROM agents WHERE id LIKE ?').run('agent:smoke-join%')
  })

  /** 带事件捕获的 ctx：注册通知是"写给界面的"，只能在 append 那一层断言 */
  const runJoin = (args: string[]) =>
    executeOne(
      {
        ...ctx,
        deps: {
          ...ctx.deps,
          events: {
            append: (type: string, actor: string, payload?: Record<string, unknown> | null) => {
              eventCalls.push({ type, actor, payload })
            }
          }
        }
      } as never,
      args
    )

  it('首次注册会主动落一条通知事件（界面据此弹「已接入，等你批准」横幅）', async () => {
    const res = await runJoin([
      'agent', 'register', '--id', 'agent:smoke-join-a', '--name', '新来的A'
    ])
    expect(res.ok).toBe(true)

    const registerEvents = eventCalls.filter((e) => e.type === 'agent_register')
    expect(registerEvents).toHaveLength(1)
    expect(registerEvents[0].payload?.agentId).toBe('agent:smoke-join-a')
    // 展示名要带上：横幅文案是「XX 已接入」，人得认出是哪个 agent
    expect(registerEvents[0].payload?.displayName).toBe('新来的A')

    const d = res.data as { humanNotified?: string }
    expect(d.humanNotified).toBeTruthy()
  })

  it('重复注册不再发通知（它早就躺在「等你批准」里，再来一条等于催命）', async () => {
    await runJoin(['agent', 'register', '--id', 'agent:smoke-join-b', '--name', '旧名'])
    eventCalls.length = 0

    const res = await runJoin(['agent', 'register', '--id', 'agent:smoke-join-b', '--name', '新名'])
    expect(res.ok).toBe(true)
    expect((res.data as { reused: boolean }).reused).toBe(true)
    expect(eventCalls.filter((e) => e.type === 'agent_register')).toHaveLength(0)
  })

  it('回执自带三步进度，下一步敲什么直接给出来（别让调用方自己推理）', async () => {
    const res = await runJoin(['agent', 'register', '--id', 'agent:smoke-join-c', '--name', '新来的C'])
    const d = res.data as {
      needsApproval: boolean
      nextSteps: Array<{ step: string; status: string; command?: string; who?: string }>
      nextHint: string
    }
    expect(d.needsApproval).toBe(true)
    expect(d.nextSteps).toHaveLength(3)
    expect(d.nextSteps[0].status).toBe('done')
    // 第二步必须给可照抄的命令，而不是"去领个凭据"
    expect(d.nextSteps[1]).toMatchObject({
      status: 'todo',
      command: 'agent credential --id agent:smoke-join-c'
    })
    // 第三步是等人的，要标明责任人，且**不能**给出一条 agent 自己跑的命令
    expect(d.nextSteps[2]).toMatchObject({ status: 'waiting', who: 'human' })
    expect(d.nextSteps[2].command).toBeUndefined()
    expect(d.nextHint).toContain('agent credential --id agent:smoke-join-c')
  })

  it('谁注册的也记进事件（审计要能追到"这次是谁在办手续"）', async () => {
    await runJoin(['agent', 'register', '--id', 'agent:smoke-join-d', '--name', '新来的D'])
    const ev = eventCalls.find((e) => e.type === 'agent_register')
    expect(ev?.actor).toBe('human')
  })
})

/**
 * whoami 的接入指引（1.0.63）
 *
 * 这几处文案此前会把人指到**已经搬走的入口**：1.0.60 起「谁能写入」
 * 整体迁到「审批」页，而 CLI 还在说「设置 → Agent 接入」「左下角头像 → 用户页」。
 * 照旧文案找，人只会在一个不存在的入口里翻 —— 这是"文档制造的故障"。
 */
describe('whoami 接入指引（1.0.63）', () => {
  beforeAll(() => {
    runMigrations(db)
    agentRepo.register({ id: 'agent:smoke-pending', displayName: '待批准的身份' })
  })

  it('已注册未批准：给可执行的下一步，并说清"你只要等"', async () => {
    const res = await executeOne(
      { ...ctx, actor: 'agent:smoke-pending', interactive: false } as never,
      ['agent', 'whoami']
    )
    expect(res.ok).toBe(true)
    const d = res.data as { approved: boolean; pending?: string; nextStep?: string }
    expect(d.approved).toBe(false)
    expect(d.pending).toContain('等')
    // 入口必须是agent 真能照做的那个 —— 审批页的待批准身份
    expect(d.nextStep).toContain('审批')
    // 旧文案指的入口已经不存在了，不能再出现在自检里
    expect(d.nextStep).not.toContain('设置')
  })

  it('未注册时的自救指引里，注册与领凭据是"你可以自己跑"的（1.0.47 起自助）', async () => {
    const res = await executeOne(
      { ...ctx, actor: 'agent:smoke-never', interactive: false } as never,
      ['agent', 'whoami']
    )
    const d = res.data as { note: string }
    expect(d.note).toContain('agent register --id agent:smoke-never')
    expect(d.note).toContain('自助')
  })

  it('MCP 接入时自检要说明"注册那两步不在工具面里，用命令行跑"', async () => {
    const res = await executeOne(
      { ...ctx, actor: 'agent:smoke-pending2', interactive: false, surface: 'mcp' } as never,
      ['agent', 'whoami']
    )
    // 未注册也有自检结论，重点是这句 MCP 提示不能缺席
    const d = res.data as { mcpNote?: string }
    expect(d.mcpNote).toContain('MCP')
    expect(d.mcpNote).toContain('agent credential')
  })

  it('CLI 接入时不塞 MCP 的话（没接入过 MCP 的人不该看到无关提示）', async () => {
    const res = await executeOne(
      { ...ctx, actor: 'agent:smoke-pending3', interactive: false } as never,
      ['agent', 'whoami']
    )
    expect((res.data as { mcpNote?: string }).mcpNote).toBeUndefined()
  })
})

describe('调用身份 → 流转动作人（1.0.34：DESKPARTNER_AGENT）', () => {
  beforeAll(() => {
    runMigrations(db)
    agentRepo.register({ id: 'agent:alice', displayName: 'Alice' })
    agentRepo.register({ id: 'agent:bob', displayName: 'Bob' })
  })

  beforeEach(() => {
    db.prepare('DELETE FROM todo_transitions').run()
    db.prepare('DELETE FROM todo_categories').run()
    db.prepare('DELETE FROM memos').run()
    db.prepare('DELETE FROM todos').run()
    db.prepare('DELETE FROM projects').run()
    seq = 0
    projectRepo.create({ name: '测试项目' })  // 1.0.40：--project 传不存在的名字会报错，预建一个供测试用
    db.prepare('DELETE FROM categories').run()
  })

  // ── 以下三条是 `63b707ca`（选 ①）的回归锁，按卡 id 落名（b3643767 纪律）──
  describe('提出者默认取调用身份，不必记得传 --created-by（63b707ca）', () => {
    /**
     * ⚠️ 判据在 1.0.73 变了（`63b707ca` 选 ①），这条测试随之改写。
     *
     * 旧判据：「不传 `--created-by` 就不该替调用方冒领，提出者仍是 human」。
     * 新判据：「**持有 agent 身份调用时，提出者默认取它**」。
     *
     * 为什么旧判据被推翻（核过代码与真实库，不是推演）：
     * 同一张新事项里会出现两个**自相矛盾**的归属 ——
     * 流转记 `actor: agent:alice`（"agent 新建了它"），
     * 提出者却记 `human`（"人提的"）。
     * 而 `--created-by human` 是看板上"哪些是用户自己提的"那个筛选的口径，
     * 错一次就跟着错一次，事后只能 `set-owner` **逐条补** ——
     * 本机已有 4 个 agent，每个都要踩一遍（提单原话）。
     *
     * 判据修正为：**按机制兜底，而不是"记得传那个参数"。**
     */
    it('设了调用身份：add 不带 --created-by，提出者默认取该 agent（不再错记成 human）', async () => {
      categoryRepo.create({ name: '方向', color: '#1', sortOrder: 0 })
      const ctxAsAgent = { ...ctx, actor: 'agent:alice' }
      const res = await executeOne(ctxAsAgent as never, [
        'todo', 'add', '--title', 'agent 干的活', '--category', '方向', '--project', '测试项目'
      ])
      expect(res.ok).toBe(true)
      const id = (res.data as { id: string }).id
      // 1.0.73 起：提出者默认取调用身份，不再落成 human
      expect(todoRepo.getById(id)!.createdBy).toBe('agent:alice')
      // 流转的动作人同样是真干活的人
      const ts = todoRepo.listTransitions(id)
      expect(ts[0].actor).toBe('agent:alice')
    })

    it('不带调用身份（人自己在终端敲）：提出者仍是 human（不替人冒领）', async () => {
      categoryRepo.create({ name: '方向', color: '#1', sortOrder: 0 })
      const res = await executeOne(ctx as never, [
        'todo', 'add', '--title', '人自己记的', '--category', '方向', '--project', '测试项目'
      ])
      expect(res.ok).toBe(true)
      const id = (res.data as { id: string }).id
      expect(
        todoRepo.getById(id)!.createdBy,
        '没身份就落 human —— 这是"用户自己提的待办"，落成 agent 才是冒领'
      ).toBe('human')
    })

    it('显式传 --created-by 仍然优先于「启动器自动带上的」调用身份（未声明身份时代录仍可用）', async () => {
      categoryRepo.create({ name: '方向', color: '#1', sortOrder: 0 })
      const ctxAsAgent = { ...ctx, actor: 'agent:alice' }
      const res = await executeOne(ctxAsAgent as never, [
        'todo', 'add', '--title', '代录', '--category', '方向', '--project', '测试项目',
        '--created-by', 'agent:bob'
      ])
      expect(res.ok).toBe(true)
      const id = (res.data as { id: string }).id
      expect(todoRepo.getById(id)!.createdBy, '显式声明必须压过默认').toBe('agent:bob')
    })
  })

  it('设了调用身份：update 推进状态，流转记 agent 而不是 NULL（主用户截图那条就是 NULL）', async () => {
    categoryRepo.create({ name: '方向', color: '#1', sortOrder: 0 })
    const todo = todoRepo.create({ title: 'x', status: 'todo' })
    const ctxAsAgent = { ...ctx, actor: 'agent:alice' }
    const res = await executeOne(ctxAsAgent as never, [
      'todo', 'update', todo.id, '--status', 'in_progress'
    ])
    expect(res.ok).toBe(true)
    const ts = todoRepo.listTransitions(todo.id)
    const move = ts.find((t) => t.toStatus === 'in_progress')
    expect(move).toBeDefined()
    expect(move!.actor).toBe('agent:alice')
  })

  it('没设调用身份（旧调用方）：--created-by 兼容旧的声明习惯', async () => {
    categoryRepo.create({ name: '方向', color: '#1', sortOrder: 0 })
    const res = await run([
      'todo', 'add', '--title', '旧习惯', '--created-by', 'agent:bob', '--category', '方向',
      '--project', '测试项目'
    ])
    expect(res.ok).toBe(true)
    const id = (res.data as { id: string }).id
    const ts = todoRepo.listTransitions(id)
    expect(ts[0].actor).toBe('agent:bob')
  })

  it('没设身份也没声明：动作人如实记 human，不再落 NULL', async () => {
    categoryRepo.create({ name: '方向', color: '#1', sortOrder: 0 })
    const res = await run(['todo', 'add', '--title', '人来记', '--category', '方向', '--project', '测试项目'])
    expect(res.ok).toBe(true)
    const id = (res.data as { id: string }).id
    const ts = todoRepo.listTransitions(id)
    expect(ts[0].actor).toBe('human')
  })

  it('todo done 也带动作人（此前 update({status:done}) 没传 actor，同样落 NULL）', async () => {
    categoryRepo.create({ name: '方向', color: '#1', sortOrder: 0 })
    const todo = todoRepo.create({ title: 'x', status: 'todo' })
    const ctxAsAgent = { ...ctx, actor: 'agent:alice' }
    const res = await executeOne(ctxAsAgent as never, ['todo', 'done', todo.id])
    expect(res.ok).toBe(true)
    const ts = todoRepo.listTransitions(todo.id)
    const done = ts.find((t) => t.toStatus === 'done')
    expect(done!.actor).toBe('agent:alice')
  })
})

describe('todo set-owner 支持 id 前缀（bob 实测：其它命令都支持，就它不支持）', () => {
  beforeAll(() => {
    runMigrations(db)
    agentRepo.register({ id: 'agent:alice', displayName: 'Alice' })
  })

  beforeEach(() => {
    db.prepare('DELETE FROM todo_transitions').run()
    db.prepare('DELETE FROM todo_categories').run()
    db.prepare('DELETE FROM memos').run()
    db.prepare('DELETE FROM todos').run()
    db.prepare('DELETE FROM projects').run()
    seq = 0
    projectRepo.create({ name: '测试项目' })  // 1.0.40：--project 传不存在的名字会报错，预建一个供测试用
    db.prepare('DELETE FROM categories').run()
  })

  it('前 8 位前缀能改提出者', async () => {
    categoryRepo.create({ name: '方向', color: '#1', sortOrder: 0 })
    const todo = todoRepo.create({ title: 'x', createdBy: 'human' })
    const res = await run(['todo', 'set-owner', todo.id.slice(0, 8), '--owner', 'agent:alice'])
    expect(res.ok).toBe(true)
    expect(todoRepo.getById(todo.id)!.createdBy).toBe('agent:alice')
  })

  it('不存在的 id 报待办不存在', async () => {
    const res = await run(['todo', 'set-owner', 'ffffffff', '--owner', 'agent:alice'])
    expect(res.ok).toBe(false)
    expect(res.message).toContain('待办不存在')
  })
})

describe('标题形状校验（bob 实测：换行与超长标题照收）', () => {
  beforeAll(() => {
    runMigrations(db)
  })

  beforeEach(() => {
    db.prepare('DELETE FROM todo_transitions').run()
    db.prepare('DELETE FROM todo_categories').run()
    db.prepare('DELETE FROM memos').run()
    db.prepare('DELETE FROM todos').run()
    db.prepare('DELETE FROM projects').run()
    seq = 0
    projectRepo.create({ name: '测试项目' })  // 1.0.40：--project 传不存在的名字会报错，预建一个供测试用
    db.prepare('DELETE FROM categories').run()
  })

  it('add：标题带换行被拒，并指路 --desc', async () => {
    const res = await run(['todo', 'add', '--title', '第一行\n第二行', '--project', '测试项目'])
    expect(res.ok).toBe(false)
    expect(res.code).toBe(2)
    expect(res.message).toContain('--desc')
  })

  it('add：超过 200 字符被拒', async () => {
    const res = await run(['todo', 'add', '--title', '长'.repeat(201), '--project', '测试项目'])
    expect(res.ok).toBe(false)
    expect(res.code).toBe(2)
    expect(res.message).toContain('200')
  })

  it('update：同样的校验（改标题也绕不过去）', async () => {
    categoryRepo.create({ name: '方向', color: '#1', sortOrder: 0 })
    const todo = todoRepo.create({ title: 'x' })
    const res = await run(['todo', 'update', todo.id, '--title', '含\n换行'])
    expect(res.ok).toBe(false)
    expect(res.code).toBe(2)
    // 正常标题不受影响
    const ok = await run(['todo', 'update', todo.id, '--title', '正常标题'])
    expect(ok.ok).toBe(true)
  })
})

describe('调用方门禁（1.0.35：持证 + 已批准，或人在终端敲）', () => {
  /**
   * 凭据文件重定向到临时目录：迁移逻辑会真的写一份凭据，
   * 不能让它落进真实主目录（测试不该有宿主副作用）。
   */
  const tmpCred = path.join(os.tmpdir(), `deskpartner-cred-test-${process.pid}.json`)

  beforeAll(() => {
    runMigrations(db)
    process.env.DESKPARTNER_CREDENTIALS_FILE = tmpCred
    agentRepo.register({ id: 'agent:alice', displayName: 'Alice' })
  })

  afterAll(() => {
    delete process.env.DESKPARTNER_CREDENTIALS_FILE
    try {
      fs.unlinkSync(tmpCred)
    } catch {
      /* 没生成就算了 */
    }
  })

  beforeEach(() => {
    db.prepare('DELETE FROM todo_transitions').run()
    db.prepare('DELETE FROM todo_categories').run()
    db.prepare('DELETE FROM memos').run()
    db.prepare('DELETE FROM todos').run()
    db.prepare('DELETE FROM projects').run()
    seq = 0
    projectRepo.create({ name: '测试项目' })  // 1.0.40：--project 传不存在的名字会报错，预建一个供测试用
    db.prepare('DELETE FROM categories').run()
    // 门禁状态是这条用例的核心变量：每个用例自己设定，不能继承上一轮的
    agentRepo.setApproved('agent:alice', false)
    db.prepare('UPDATE agents SET credential_hash = NULL WHERE id = ?').run('agent:alice')
  })

  const asAgent = (extra: Partial<{ credential: string; interactive: boolean; actor: string }> = {}) =>
    ({ ...ctx, actor: 'agent:alice', interactive: false, ...extra }) as never

  it('只读命令不设门禁：查询永远不该有摩擦', async () => {
    const res = await executeOne(asAgent(), ['todo', 'list'])
    expect(res.ok).toBe(true)
  })

  it('人在终端敲（interactive）放行，不制造摩擦', async () => {
    categoryRepo.create({ name: '方向', color: '#1', sortOrder: 0 })
    const res = await executeOne(
      { ...ctx, interactive: true } as never,
      ['todo', 'add', '--title', '人记的', '--category', '方向', '--project', '测试项目']
    )
    expect(res.ok).toBe(true)
  })

  it('无人值守却匿名写入：拒绝并指路注册（此前是静默记成 human）', async () => {
    const res = await executeOne(asAgent({ actor: 'human' }), [
      'todo', 'add', '--title', 'x', '--project', '测试项目'
    ])
    expect(res.ok).toBe(false)
    expect(res.code).toBe(4)
    expect(res.errorCode).toBe('identity_required')
    expect(res.message).toContain('agent register')
  })

  it('未批准：拒绝，并说明要谁来批准（拿到身份 ≠ 拿到写权限）', async () => {
    const res = await executeOne(asAgent(), ['todo', 'add', '--title', 'x', '--project', '测试项目'])
    expect(res.ok).toBe(false)
    expect(res.errorCode).toBe('identity_pending')
    expect(res.message).toContain('批准')
  })

  it('已批准但没出示凭据：拒绝（只报名字是自称，不算）', async () => {
    agentRepo.setApproved('agent:alice', true)
    agentRepo.issueCredential('agent:alice') // 已持证 → 这次缺的是"出示"而不是"办理"
    const res = await executeOne(asAgent(), ['todo', 'add', '--title', 'x', '--project', '测试项目'])
    expect(res.ok).toBe(false)
    expect(res.errorCode).toBe('credential_missing')
  })

  it('迁移：1.0.35 前已批准的老身份没有凭据，首次写入自动补发（不把已授权的人锁在门外）', async () => {
    categoryRepo.create({ name: '方向', color: '#1', sortOrder: 0 })
    agentRepo.setApproved('agent:alice', true)
    // hasCredential 为 false（beforeEach 清过 credential_hash）
    const res = await executeOne(asAgent(), [
      'todo', 'add', '--title', '迁移写入', '--category', '方向', '--project', '测试项目'
    ])
    expect(res.ok).toBe(true)
    // 补发后库里应当已有凭据哈希
    expect(agentRepo.get('agent:alice')!.hasCredential).toBe(true)
  })

  it('凭据对不上：拒绝，并提示可重发', async () => {
    agentRepo.setApproved('agent:alice', true)
    agentRepo.issueCredential('agent:alice')
    const res = await executeOne(asAgent({ credential: '假凭据' }), [
      'todo', 'add', '--title', 'x', '--project', '测试项目'
    ])
    expect(res.ok).toBe(false)
    expect(res.errorCode).toBe('credential_invalid')
  })

  it('持证 + 已批准：放行，且流转记的是它', async () => {
    categoryRepo.create({ name: '方向', color: '#1', sortOrder: 0 })
    agentRepo.setApproved('agent:alice', true)
    const { token } = agentRepo.issueCredential('agent:alice')!
    const res = await executeOne(asAgent({ credential: token }), [
      'todo', 'add', '--title', '持证写入', '--category', '方向', '--project', '测试项目'
    ])
    expect(res.ok).toBe(true)
    const id = (res.data as { id: string }).id
    expect(todoRepo.listTransitions(id)[0].actor).toBe('agent:alice')
  })

  /**
   * 1.0.47 语义变更：**agent 可以自己办手续了，人只负责审批。**
   *
   * 主用户 2026-09-23 判定：「必须允许 agent 自带身份办手续，人做审批。
   * 你现在的机制默认用户是开发者，会用命令系统，但现实用户更多是不会开发的普通人。」
   *
   * 原设计要 agent"先 unset DESKPARTNER_AGENT 再重跑"—— 这是开发者才会做的事，
   * 普通用户看到的是"我的助手说它注册不了"，而他不知道环境变量是什么。
   *
   * 为什么放开是安全的：`agent:setApproved` 只注册在 IPC 上（限设置页发起），
   * CLI 根本没有对应命令 —— agent 无论如何都批准不了自己。
   * 旧注释说的"它能注册一个名字、再自己批准"，那个"自己批准"从来做不到。
   *
   * 放开后仍必须锁住的：注册完 `approved=false`，一个字都写不进来。
   */
  it('agent 可以自己注册身份（1.0.47）：手续自己办，批准权仍在人手里', async () => {
    const res = await executeOne(asAgent(), [
      'agent', 'register', '--id', 'agent:ghost', '--name', '幽灵'
    ])
    expect(res.ok).toBe(true)
    const ghost = agentRepo.get('agent:ghost')
    expect(ghost).not.toBeNull()
    // 关键：注册不等于授权 —— 没有人点头，它写不进来
    expect(ghost!.approved).toBe(false)
  })

  /**
   * 1.0.46：本机只落过一份凭据时启动器会自动带上（1.0.35 的零摩擦设计），
   * 那不是"自称"。这条路径在 1.0.47 之后仍然要通 —— 别因为放开了
   * agent 自办手续，反而把人自己的路堵上。
   */
  it('本机凭据被自动带上（未声明）：人仍能办手续，不被误判成 agent', async () => {
    const autoLoaded = { ...ctx, actor: 'agent:alice', identityDeclared: false } as never
    const res = await executeOne(autoLoaded, [
      'agent', 'register', '--id', 'agent:auto-ok', '--name', '自动带上也能办'
    ])
    expect(res.ok).toBe(true)
    expect(agentRepo.get('agent:auto-ok')).not.toBeNull()
  })

  /**
   * 1.0.47 的安全边界（替代此前"agent 不能自办手续"那条）：
   * 手续可以自己办，但**批准只能由人做** —— CLI 侧没有 setApproved。
   */
  it('agent 自己声明身份也能注册，但注册后写不进数据（等界面批准）', async () => {
    const declared = { ...ctx, actor: 'agent:alice', identityDeclared: true } as never
    const res = await executeOne(declared, [
      'agent', 'register', '--id', 'agent:ghost2', '--name', '幽灵二号'
    ])
    expect(res.ok).toBe(true)
    expect(agentRepo.get('agent:ghost2')!.approved).toBe(false)

    // 写命令仍被拦：注册 ≠ 授权（approved 校验在凭据校验之前，所以无需出示凭据）
    const write = await executeOne(
      { ...ctx, actor: 'agent:ghost2', interactive: false } as never,
      ['todo', 'add', '--title', '试试能不能写', '--category', '方向', '--project', '测试项目']
    )
    expect(write.ok).toBe(false)
    expect(write.errorCode).toBe('identity_pending')
  })

  /**
   * 1.0.46 第二层：`identity_required` 的循环依赖。
   *
   * 非交互调用本该"先注册再写"，可 register 自己也被这一关拦住 ——
   * 报错文案让调用方去跑 register，跑 register 时收到的还是同一句话。
   * 实测：脚本里调 `agent register` 被拒，环境恢复不了。
   */
  it('非交互下 register/credential/revoke 不再自我指涉地拒绝（自服务豁免）', async () => {
    const unattended = { ...ctx, interactive: false, actor: 'human' } as never

    const reg = await executeOne(unattended, [
      'agent', 'register', '--id', 'agent:boot', '--name', '引导'
    ])
    expect(reg.ok).toBe(true)

    const cred = await executeOne(unattended, ['agent', 'credential', '--id', 'agent:boot'])
    expect(cred.ok).toBe(true)

    const revoke = await executeOne(unattended, ['agent', 'revoke', '--id', 'agent:boot'])
    expect(revoke.ok).toBe(true)
  })

  it('自服务豁免不扩散：普通写命令在非交互下照样要求身份', async () => {
    const unattended = { ...ctx, interactive: false, actor: 'human' } as never
    const res = await executeOne(unattended, ['todo', 'add', '--title', 'x', '--project', '测试项目'])
    expect(res.ok).toBe(false)
    expect(res.errorCode).toBe('identity_required')
  })

  it('whoami 不带 id = 自检：直接说清这次调用能不能写', async () => {
    agentRepo.setApproved('agent:alice', true)
    const { token } = agentRepo.issueCredential('agent:alice')!
    const res = await executeOne(asAgent({ credential: token }), ['agent', 'whoami'])
    expect(res.ok).toBe(true)
    const d = res.data as { actor: string; canWrite: boolean; credential: string }
    expect(d.actor).toBe('agent:alice')
    expect(d.credential).toBe('valid')
    expect(d.canWrite).toBe(true)
  })
})

describe('分级授权（1.0.36：读/写 免长期批准，改界面 本会话，删除 每次）', () => {
  beforeAll(() => {
    runMigrations(db)
    agentRepo.register({ id: 'agent:alice', displayName: 'Alice' })
  })

  beforeEach(() => {
    db.prepare('DELETE FROM agent_grants').run()
    db.prepare('DELETE FROM todos').run()
    db.prepare('DELETE FROM categories').run()
    agentRepo.setApproved('agent:alice', true)
    db.prepare('UPDATE agents SET credential_hash = NULL, last_write_at = NULL, last_write_cmd = NULL WHERE id = ?').run(
      'agent:alice'
    )
  })

  /** 持证 + 已批准的无人值守调用；额外的 session 用来验证"仅本次会话" */
  const asAgent = (
    extra: Partial<{ credential: string; interactive: boolean; session: string }> = {}
  ) => ({ ...ctx, actor: 'agent:alice', interactive: false, ...extra }) as never

  const withCredential = async (extra: Partial<{ session: string }> = {}) => {
    const { token } = agentRepo.issueCredential('agent:alice')!
    return asAgent({ credential: token, ...extra })
  }

  /** 界面上点「允许」：resolveGrant 就是 IPC agent:resolveGrant 背后那一步 */
  const approvePending = (scope: 'config' | 'destructive', longTerm = false) => {
    const p = agentRepo.listGrants({ agentId: 'agent:alice', scope, status: 'pending' })
    expect(p.length, `应当有一条 ${scope} 的待表态申请`).toBe(1)
    agentRepo.resolveGrant(p[0].id, true, { longTerm })
  }

  it('改界面属于 config 档：没授权直接拦，并落下一条待表态申请', async () => {
    // 先置成别的值，才能验证"被拦下 = 真的没改"（前面的用例可能已经把它设成 dark）
    settingsRepo.update({ theme: 'light' } as never)
    const res = await executeOne(await withCredential(), ['ui', 'set', '--key', 'theme', '--value', 'dark'])
    expect(res.ok).toBe(false)
    expect(res.code).toBe(4)
    expect(res.errorCode).toBe('grant_required')
    expect(res.message).toContain('仅本次会话')
    // 申请真的落库了 —— 界面上才看得到"它在等我点头"
    expect(agentRepo.listGrants({ agentId: 'agent:alice', scope: 'config', status: 'pending' }).length).toBe(1)
    // 拦下了就没真改
    expect(settingsRepo.get().theme).not.toBe('dark')
  })

  it('同一会话重复被拒不会堆出一串一模一样的申请', async () => {
    const c = await withCredential({ session: 's1' })
    await executeOne(c, ['ui', 'set', '--key', 'theme', '--value', 'dark'])
    await executeOne(c, ['ui', 'set', '--key', 'theme', '--value', 'dark'])
    expect(agentRepo.listGrants({ agentId: 'agent:alice', scope: 'config', status: 'pending' }).length).toBe(1)
  })

  it('人点头后重试即放行（同会话）', async () => {
    const c = await withCredential({ session: 's1' })
    const first = await executeOne(c, ['ui', 'set', '--key', 'theme', '--value', 'dark'])
    expect(first.ok).toBe(false)
    approvePending('config')
    const retry = await executeOne(c, ['ui', 'set', '--key', 'theme', '--value', 'dark'])
    expect(retry.ok).toBe(true)
    expect(settingsRepo.get().theme).toBe('dark')
  })

  it('改界面的授权只有本会话有效：换个会话又得重新申请', async () => {
    await executeOne(await withCredential({ session: 's1' }), ['ui', 'set', '--key', 'theme', '--value', 'dark'])
    approvePending('config')
    const other = await executeOne(await withCredential({ session: 's2' }), [
      'ui', 'set', '--key', 'theme', '--value', 'light'
    ])
    expect(other.ok).toBe(false)
    expect(other.errorCode).toBe('grant_required')
  })

  it('长期授权不限会话（人明确点了「长期允许」才给）', async () => {
    await executeOne(await withCredential({ session: 's1' }), ['ui', 'set', '--key', 'theme', '--value', 'dark'])
    approvePending('config', true)
    const other = await executeOne(await withCredential({ session: 's2' }), [
      'ui', 'set', '--key', 'theme', '--value', 'light'
    ])
    expect(other.ok).toBe(true)
  })

  it('删除属于 destructive 档：一次性，用掉即止', async () => {
    const cat = categoryRepo.create({ name: '方向', color: '#1', sortOrder: 0 })
    const todo = todoRepo.create({ title: '待删', categoryIds: [cat.id], priority: 'normal' })

    const c = await withCredential({ session: 's1' })
    const first = await executeOne(c, ['todo', 'rm', todo.id, '--yes'])
    expect(first.ok).toBe(false)
    expect(first.errorCode).toBe('grant_required')

    approvePending('destructive')
    const second = await executeOne(c, ['todo', 'rm', todo.id, '--yes'])
    expect(second.ok).toBe(true)

    // 同一条授权已经用掉：再删一条还得重新问
    const todo2 = todoRepo.create({ title: '待删2', categoryIds: [cat.id], priority: 'normal' })
    const third = await executeOne(c, ['todo', 'rm', todo2.id, '--yes'])
    expect(third.ok).toBe(false)
    expect(third.errorCode).toBe('grant_required')
    expect(
      agentRepo.listGrants({ agentId: 'agent:alice', scope: 'destructive', status: 'consumed' }).length
    ).toBe(1)
  })

  it('人在终端敲：改界面与删除都不卡（责任人在屏幕前）', async () => {
    const cat = categoryRepo.create({ name: '方向', color: '#1', sortOrder: 0 })
    const todo = todoRepo.create({ title: '人删', categoryIds: [cat.id], priority: 'normal' })
    const human = { ...ctx, interactive: true } as never
    expect((await executeOne(human, ['ui', 'set', '--key', 'theme', '--value', 'dark'])).ok).toBe(true)
    expect((await executeOne(human, ['todo', 'rm', todo.id, '--yes'])).ok).toBe(true)
  })

  it('审计：写入后记下"它动过数据"，只读不记', async () => {
    const cat = categoryRepo.create({ name: '方向', color: '#1', sortOrder: 0 })
    const c = await withCredential({ session: 's1' })
    await executeOne(c, ['todo', 'list'])
    expect(agentRepo.get('agent:alice')!.lastWriteAt).toBeNull()

    await executeOne(c, ['todo', 'add', '--title', '它加的', '--category', '方向', '--project', '测试项目'])
    const after = agentRepo.get('agent:alice')!
    expect(after.lastWriteAt).not.toBeNull()
    expect(after.lastWriteCmd).toBe('todo add')
  })

  /**
   * v19：删除授权必须**绑定目标**。
   *
   * Bob 2026-09-22 实测（本机真实发生、非推演）：它为清探针先申请删除 A 并获批，
   * 随后执行的是 `todo rm B` —— **退出码 0、deleted:true**，那条针对 A 的授权
   * 就这样被 B 消费掉了。结果是：批准要删的 A 至今还在，没被批准的 B 被删了。
   *
   * 也就是"批准删除这条"实际等于"30 分钟内允许删任意一条"。
   * 而 v18/v1.0.40 刚加的摘要让这个漏洞**更具欺骗性** —— 摘要写得越清楚，
   * 人越以为自己批的是定点手术。这条用例把"批的"与"做的"必须一致钉死。
   */
  it('删除授权绑定目标：批准删 A 后拿它去删 B 会被拒、A 才能删（v19 堵漏）', async () => {
    const cat = categoryRepo.create({ name: '方向', color: '#1', sortOrder: 0 })
    // 自己保证项目存在：这个 describe 的 beforeEach 与本文件其它块不同，
    // 不依赖"别处已经预建了测试项目"这种跨块假设
    const proj =
      projectRepo.list().find((p) => p.name === '测试项目') ??
      projectRepo.create({ name: '测试项目' })
    const mk = (title: string) =>
      todoRepo.create({
        title,
        categoryIds: [cat.id],
        projectId: proj.id,
        priority: 'normal'
      })
    const a = mk('目标 A')
    const b = mk('目标 B')

    const c = await withCredential({ session: 'target-scope' })

    // 对 A 申请删除 → 被拦下并要求授权
    const r1 = await executeOne(c, ['todo', 'rm', a.id, '--yes'])
    expect(r1.errorCode).toBe('grant_required')

    // 关键：申请那一刻就把确切目标记下来了
    const g = agentRepo.listGrants({
      agentId: 'agent:alice',
      scope: 'destructive',
      status: 'pending'
    })[0]
    expect(g.targetIds).toEqual([a.id])

    // 人在界面上点「允许」
    agentRepo.resolveGrant(g.id, true)

    // 拿这条授权去删 B → 必须被拒，且 B 必须还在
    const r2 = await executeOne(c, ['todo', 'rm', b.id, '--yes'])
    expect(r2.ok).toBe(false)
    expect(r2.errorCode).toBe('grant_required')
    expect(todoRepo.getById(b.id)).not.toBeNull()

    // 删它真正被批准的那一条 → 成功
    const r3 = await executeOne(c, ['todo', 'rm', a.id, '--yes'])
    expect(
      r3.ok,
      `删被批准的那条本应成功，实际：${r3.errorCode} / ${r3.message}`
    ).toBe(true)
    expect(todoRepo.getById(a.id)).toBeNull()

    // 收尾：把上面试探 B 时新落的待表态申请拒掉，
    // 免得它留在库里影响后续用例（agent_grants 不随 beforeEach 清空）
    for (const leftover of agentRepo.listGrants({
      agentId: 'agent:alice',
      scope: 'destructive',
      status: 'pending'
    })) {
      agentRepo.resolveGrant(leftover.id, false)
    }
  })

  /**
   * 1.0.49：授权必须绑定**命令**（与 v19 的目标绑定是同一条漏洞的两种逃逸路径）。
   *
   * v19 堵住了"批 A 删 B"，但校验只在**目标**这一维：命令名压根没进判据，
   * 于是同档位内换命令照样畅通 —— Bob d290ae7b 实测就是
   * "批准的是删待办，执行的是删分类"，退出码 0、分类真被删了。
   *
   * 根因有两层，缺一不可：
   * 1. `findUsableGrant` 不按命令过滤（本次修）；
   * 2. `summarizeGrantTarget` 只认 `todo rm`，其余删除命令的 `targetIds` 全空，
   *    撞上"任一方为空即不校验"的豁免 → 连目标约束也一并失效。
   *
   * 所以这组用例同时钉住**命令维度**与**目标维度**。
   */
  it('授权绑定命令：批准删待办后，拿它去删分类会被拒（1.0.49 堵漏）', async () => {
    const cat = categoryRepo.create({ name: '不许被偷删的分类', color: '#2', sortOrder: 1 })
    const proj =
      projectRepo.list().find((p) => p.name === '测试项目') ??
      projectRepo.create({ name: '测试项目' })
    const t = todoRepo.create({
      title: '被批准删的待办',
      categoryIds: [cat.id],
      projectId: proj.id,
      priority: 'normal'
    })

    const c = await withCredential({ session: 'cmd-scope' })

    // 申请删待办 → 被拦下，落一条 command='todo rm' 的申请
    const r1 = await executeOne(c, ['todo', 'rm', t.id, '--yes'])
    expect(r1.errorCode).toBe('grant_required')
    const g = agentRepo.listGrants({
      agentId: 'agent:alice',
      scope: 'destructive',
      status: 'pending'
    })[0]
    expect(g.command).toBe('todo rm')
    expect(g.targetIds).toEqual([t.id])

    // 人点头
    agentRepo.resolveGrant(g.id, true)

    /**
     * 关键一步：拿这条授权去跑**另一条删除命令**。
     * 旧实现只看 (身份, 档位, 会话)，category rm 的目标又是空集（豁免）→
     * 于是这条"删待办"的授权被用来删分类，且分类真的没了。
     */
    const r2 = await executeOne(c, ['category', 'rm', cat.id, '--yes'])
    expect(r2.ok).toBe(false)
    expect(r2.errorCode).toBe('grant_required')
    expect(categoryRepo.getById(cat.id), '分类没被批准，必须还在').not.toBeNull()

    // 用它删真正被批准的那条待办 → 成功，授权没被上面那次试探消费掉
    const r3 = await executeOne(c, ['todo', 'rm', t.id, '--yes'])
    expect(r3.ok, `删被批准的那条本应成功，实际：${r3.errorCode} / ${r3.message}`).toBe(true)
    expect(todoRepo.getById(t.id)).toBeNull()

    // 收尾：把试探时新落的待表态申请拒掉
    for (const leftover of agentRepo.listGrants({
      agentId: 'agent:alice',
      scope: 'destructive',
      status: 'pending'
    })) {
      agentRepo.resolveGrant(leftover.id, false)
    }
  })

  /**
   * 目标不存在时**不该**发起申请（1.0.49 修，实测踩中）
   *
   * 实测经过：几条测试残留其实早已被她批准并删掉，agent 没重新核对状态
   * 又发起了一轮 —— 目标早没了，界面却又弹了一次申请，她点完只得到
   * 一行「待办不存在」。人白点一次是小事，真正危险的是那条申请的
   * `targetIds` 为空，而空目标命中"任一方为空即不校验"的豁免 ——
   * v19 刚堵上的「批准删 A 却能删 B」会从这条缝里重新打开。
   */
  it('删除不存在的待办：报 notFound，且不生成申请（批了也做不成）', async () => {
    const res = await executeOne(await withCredential({ session: 'ghost-target' }), [
      'todo',
      'rm',
      'ffffffff',
      '--yes'
    ])

    expect(res.ok).toBe(false)
    expect(res.code, '这是"对象不存在"，不是"缺授权"').toBe(3)
    expect(res.errorCode).not.toBe('grant_required')
    expect(res.message).toContain('不存在')
    /**
     * 142d0420 附带的两处（2026-10-20 补）：
     *
     * ① 这条回执此前**没有结构化 code** —— output.ts 的信封是
     *    `code: outcome.errorCode`，而这里只给了数字退出码，于是 `code`
     *    字段整个消失，调用方只能按文案猜"是我的参数错了还是对象没了"。
     *    全项目只有这一条失败回执是这样，正因为它最需要区分这两种情形。
     *
     * ② 重述的命令行少了**第一个位置参数**（`tail` 从前用 `positional.slice(1)`
     *    拼，那是 argv 时代的习惯，而 positional 里本来就没有命令名）——
     *    恰好 id / 版本号就是 positional[0]，于是报错里看不见真正的目标。
     */
    expect(res.errorCode, '失败回执必须带结构化 code').toBe('not_found')
    expect(res.message, '重述的命令行要留住目标本身（第一个位置参数）').toContain('ffffffff')
    expect(
      agentRepo.listGrants({ agentId: 'agent:alice', scope: 'destructive' }),
      '不该留下一条"批了也做不成"的申请'
    ).toHaveLength(0)
  })

  it('对照：目标存在时照旧走申请流程（别把正常路径一起堵了）', async () => {
    const cat = categoryRepo.create({ name: '对照分类', color: '#4', sortOrder: 3 })
    const proj = projectRepo.create({ name: '对照项目' })
    const t = todoRepo.create({
      title: '真实存在的待办',
      categoryIds: [cat.id],
      projectId: proj.id,
      priority: 'normal'
    })

    const res = await executeOne(await withCredential({ session: 'real-target' }), [
      'todo',
      'rm',
      t.id,
      '--yes'
    ])

    expect(res.errorCode).toBe('grant_required')
    const g = agentRepo.listGrants({
      agentId: 'agent:alice',
      scope: 'destructive',
      status: 'pending'
    })
    expect(g).toHaveLength(1)
    expect(g[0].targetIds, '目标照旧要记全，否则一致性校验失效').toEqual([t.id])
  })

  it('每条删除命令都要记下目标 —— 空目标等于没有目标约束（1.0.49 扩面）', async () => {
    const cat = categoryRepo.create({ name: '待删分类', color: '#3', sortOrder: 2 })
    const proj = projectRepo.create({ name: '待删项目' })
    const memo = memoRepo.create({ author: 'agent:alice', text: '第一行是摘要\n第二行不该出现' })

    const c = await withCredential({ session: 'target-all' })

    const cases: { argv: string[]; expectId: string; expectSummaryHas: string }[] = [
      { argv: ['category', 'rm', cat.id, '--yes'], expectId: cat.id, expectSummaryHas: '待删分类' },
      { argv: ['project', 'rm', proj.id, '--yes'], expectId: proj.id, expectSummaryHas: '待删项目' },
      { argv: ['memo', 'rm', memo.id, '--yes'], expectId: memo.id, expectSummaryHas: '第一行是摘要' }
    ]

    for (const { argv, expectId, expectSummaryHas } of cases) {
      const res = await executeOne(c, argv)
      expect(res.errorCode).toBe('grant_required')

      const cmdName = `${argv[0]} ${argv[1]}`
      const g = agentRepo
        .listGrants({ agentId: 'agent:alice', scope: 'destructive', status: 'pending' })
        .find((x) => x.command === cmdName)
      expect(g, `${cmdName} 应当落一条申请`).toBeTruthy()
      /**
       * 目标必须解析成**完整 id**：界面显示 8 位短号，agent 自然拿短号来用，
       * 精确匹配会解析不出 → 目标落空 → 又回到"没有目标约束"。
       */
      expect(g!.targetIds, `${cmdName} 的目标不能为空`).toEqual([expectId])
      // 摘要要写清"动的是什么" —— 只给命令名人没法判断该不该批
      expect(g!.summary ?? '').toContain(expectSummaryHas)
    }

    // 收尾：三条待表态申请全部拒掉
    for (const leftover of agentRepo.listGrants({
      agentId: 'agent:alice',
      scope: 'destructive',
      status: 'pending'
    })) {
      agentRepo.resolveGrant(leftover.id, false)
    }
  })

  /**
   * 142d0420：`release rm` 在目标解析里**一个分支都没有**，于是每次都落进末尾
   * 兜底（空目标）→ 撞上"删除档必须有目标"的守卫 → 任何版本都删不掉，
   * 报错还只说"目标不存在或解析不出来"（看起来像目标没了，其实是没写分支）。
   *
   * 卡上记的现象（"目标解析前丢失版本号位置参数"）与真根因隔了一层，
   * 所以这条用例两头都钉：**能走到申请**（说明分支在），
   * 且**目标按 (项目, 版本号) 记全**（说明批的和做的对得上）。
   */
  it('release rm 走得到申请流程：目标按 (项目, 版本号) 记，批准后真能删掉（142d0420）', async () => {
    const proj = projectRepo.create({ name: '待删版本的项目' })
    releaseRepo.create({ projectId: proj.id, version: '9.9.142', summary: '一次性探针版本' })

    const c = await withCredential({ session: 'release-rm-target' })
    const res = await executeOne(c, ['release', 'rm', '9.9.142', '--project', proj.name, '--yes'])

    expect(
      res.errorCode,
      `目标就在库里，不该报"目标不存在"（实际回执：${res.message}）`
    ).toBe('grant_required')

    const g = agentRepo
      .listGrants({ agentId: 'agent:alice', scope: 'destructive', status: 'pending' })
      .find((x) => x.command === 'release rm')
    expect(g, '应当落一条 release rm 的申请').toBeTruthy()
    /**
     * 版本没有自己的 id（「DeskPartner 的 1.0.76」天然唯一），
     * 所以目标记复合键；跨项目可以撞同名版本号，只记版本号会串台。
     */
    expect(g!.targetIds).toEqual([`${proj.id}:9.9.142`])
    expect(g!.summary ?? '', '摘要要能分辨是哪个项目的哪一版').toContain('9.9.142')
    expect(g!.summary ?? '').toContain('待删版本的项目')

    /**
     * 人在界面上点「允许并执行」：服务端当场重放落库的 `requestArgv`。
     *
     * 这条路径同时把 142d0420 的三个环节串起来验证 ——
     * 目标记全（复合键）→ 重放时按同一 argv 重算目标 → 集合比对通过 → 真的删掉。
     * 少任何一环，用户点完「允许」得到的都是一条"授权不能用于这次动作"，
     * 而那看起来像授权过期，不像漏了分支。
     */
    agentRepo.resolveGrant(g!.id, true)
    const outcome = await executeApproved(ctx as never, g!.requestArgv, {
      agentId: g!.agentId,
      grantId: g!.id
    })
    expect(
      outcome.ok,
      `批准即执行本应删掉，实际：${outcome.errorCode} / ${outcome.message}`
    ).toBe(true)
    expect(releaseRepo.getByProjectAndVersion(proj.id, '9.9.142')).toBeNull()
    expect(releaseRepo.listByProject(proj.id)).toHaveLength(0)
  })

  it('release rm 目标真不存在时：不生成申请，且回执里看得见版本号与项目（142d0420）', async () => {
    const proj = projectRepo.create({ name: '没有登记过版本的项目' })
    const res = await executeOne(await withCredential({ session: 'release-rm-ghost' }), [
      'release',
      'rm',
      '9.9.404',
      '--project',
      proj.name,
      '--yes'
    ])

    expect(res.ok).toBe(false)
    expect(res.errorCode).toBe('not_found')
    expect(res.message, '重述的命令行里要看得见版本号').toContain('9.9.404')
    expect(res.message, '也要看得见项目（否则人无法判断是哪一条）').toContain(proj.name)
    expect(
      agentRepo.listGrants({ agentId: 'agent:alice', scope: 'destructive', status: 'pending' }),
      '批了也做不成的事不该来要授权'
    ).toHaveLength(0)
  })

  /**
   * 结构闸门（142d0420 建议③）：**每条删除档命令都要有目标解析分支**。
   *
   * 逐个补分支治不了"将来新增删除命令又漏一条"—— 而漏的后果是静默的：
   * 没有报错、没有警告，只是那条命令每次都"目标不存在"，永远走不到申请。
   * 所以钉住的是**清单本身**：静态删除档，加上"动态档位"的命令
   * （`todo delete-comment` 删别人写的评论时会转成删除档，同样是遗漏候选）。
   *
   * 判据取自实现自己的表（`grantTargetResolverNames`），不另写一份名单 ——
   * 另写一份等于把漂移换个地方发生。
   */
  it('每条删除档命令在目标解析表里都有分支（142d0420 结构闸门）', () => {
    const handled = new Set(grantTargetResolverNames())
    const needTarget = commands
      .filter((c) => riskOf(c) === 'destructive' || c.dynamicRisk)
      .map((c) => c.name)

    expect(needTarget.length, '一条删除档命令都没有？那说明命令表读错了').toBeGreaterThan(3)
    expect(
      needTarget.filter((n) => !handled.has(n)),
      '这些删除档命令没有目标解析分支：兜底路径是静默的（空目标 + 一句"目标不存在"）'
    ).toEqual([])
  })

  /**
   * `ce0ea82f` 的另一半：batch 的写路径**实跑一次**。
   *
   * 原卡明说「我没有实跑 batch 的写路径」，它是"静态契约观察 + 实现者自述"的合成。
   * 这条把它闭合：batch 真的执行了里面的写命令，落库为证。
   */
  it('batch 真的会执行写命令：写行进库（ce0ea82f 的实跑证据）', async () => {
    const cat = categoryRepo.create({ name: '批量写入分类', color: '#5', sortOrder: 0 })
    const proj = projectRepo.create({ name: '批量写入项目' })
    const title = 'batch 写路径实跑'
    const c = await withCredential({ session: 'batch-write' })
    const res = await executeOne(
      {
        ...(c as Record<string, unknown>),
        stdin: JSON.stringify({
          cmd: 'todo add',
          args: { '--title': title, '--project': proj.name, '--category': cat.name }
        })
      } as never,
      ['batch']
    )

    expect(
      res.ok,
      `实际：${res.errorCode} / ${res.message} / ${JSON.stringify(res.data)}`
    ).toBe(true)
    expect(
      todoRepo.list({ keyword: title }).some((t) => t.title === title),
      '回执说成功，库里就必须有它 —— 别拿回执当证据'
    ).toBe(true)
  })

  /**
   * 同一条改动的另一半：**batch 不再免批**。
   *
   * 里面是只读行也一样拦 —— 判据是"这个入口能不能写"，
   * 与这一行长什么样无关（按内容动态判会让宿主的静态确认机制失效）。
   */
  it('batch 不再免批：无人值守且没凭据时被拦在入口（ce0ea82f）', async () => {
    /**
     * 先正常领一份凭据：库里"有凭据"之后，下面那次调用才是**真缺凭据**。
     * 不先领的话会走「1.0.35 迁移：已批准但没凭据 → 自动补发」那条路，
     * 于是这个用例会假绿 —— 它测的就不是门禁了。
     */
    await withCredential({ session: 'batch-seed-cred' })

    const res = await executeOne(
      {
        ...(asAgent({ session: 'batch-no-cred' }) as Record<string, unknown>),
        stdin: '{"cmd":"todo list"}'
      } as never,
      ['batch']
    )

    expect(res.ok).toBe(false)
    expect(res.errorCode, '没凭据的入口不该跑到读 stdin 那一步').toBe('credential_missing')
  })

  /**
   * 1.0.49：申请落库时补 `--yes`（主用户 814ad86d 实测）。
   *
   * 删除档命令的 `run()` 都有一道 `if (!flags['--yes']) throw`，而门禁跑在
   * `run()` **之前** —— 它落下的 requestArgv 是调用方原样敲的 argv。
   * agent 在"还没获批"的阶段本来就不该带 `--yes`（那是批准方的话），
   * 于是「申请 → 人点允许并执行 → 重放 argv → 缺 --yes → 必然抛错」。
   *
   * 真实库佐证：argv 带 --yes 的 5 条授权全部成功，不带 --yes 的 3 条全部 error。
   *
   * 修法是在**申请落库时**补，而不是执行时临时注入：授权记录是审计凭据，
   * 它存的应当是真正会被执行的东西。
   */
  it('申请时补 --yes：不带 --yes 申请 → 批准即执行不再必然失败（1.0.49）', async () => {
    const cat = categoryRepo.create({ name: '方向', color: '#1', sortOrder: 0 })
    const proj =
      projectRepo.list().find((p) => p.name === '测试项目') ??
      projectRepo.create({ name: '测试项目' })
    const t = todoRepo.create({
      title: '不带 --yes 申请删的',
      categoryIds: [cat.id],
      projectId: proj.id,
      priority: 'normal'
    })

    const c = await withCredential({ session: 'yes-inject' })
    // 注意：这次**刻意不带 --yes**
    const res = await executeOne(c, ['todo', 'rm', t.id])
    expect(res.errorCode).toBe('grant_required')

    const g = agentRepo.listGrants({
      agentId: 'agent:alice',
      scope: 'destructive',
      status: 'pending'
    })[0]
    // 落库的 argv 必须已经带上 --yes —— 否则重放必然撞 run() 里那道确认
    expect(g.requestArgv).toEqual(['todo rm', t.id, '--yes'])

    agentRepo.resolveGrant(g.id, true)
    const outcome = await executeApproved(ctx as never, g.requestArgv, {
      agentId: g.agentId,
      grantId: g.id
    })
    expect(
      outcome.ok,
      `补了 --yes 之后应当成功，实际：${outcome.errorCode} / ${outcome.message}`
    ).toBe(true)
    expect(todoRepo.getById(t.id)).toBeNull()
  })

  /**
   * 1.0.45「批准即执行」：用户点「允许」时服务端当场把这件事做掉。
   *
   * 主用户 2026-09-22 的架构判断（原话）：
   * 「所以才说删除审批应该直接服务端处理呀，要不然就要有发通知给 agent
   *   的机制，不然一定会出问题的。」
   *
   * 她把我一直当成"体验优化"的这条判成了架构必解问题，并给出二选一。
   * 这里选 A（服务端直接执行）：B 只是把问题推后 —— agent 离线时通知堆积、
   * 上线后还要判断哪些已过期，复杂度从服务端转移到 agent，
   * 而 agent 本来就是"说断就断"的角色。A 让"agent 回来执行"根本不存在。
   *
   * 这组用例锁住三件事：
   * 1. 申请时**记下了完整 argv**（没有它就无法重建动作）；
   * 2. 执行以**发起申请的 agent 身份**落地（动作归属不能变成人）；
   * 3. 执行结果留下**回执**，且成功即销账（不存在"批一次、动两次"）。
   */
  describe('批准即执行（1.0.45）', () => {
    const mkTodo = (title: string) => {
      const cat =
        categoryRepo.list().find((c) => c.name === '方向') ??
        categoryRepo.create({ name: '方向', color: '#1', sortOrder: 0 })
      const proj =
        projectRepo.list().find((p) => p.name === '测试项目') ??
        projectRepo.create({ name: '测试项目' })
      return todoRepo.create({
        title,
        categoryIds: [cat.id],
        projectId: proj.id,
        priority: 'normal'
      })
    }

    it('申请时记下完整 argv —— 没有它服务端重建不出动作', async () => {
      const t = mkTodo('要被删的')
      const c = await withCredential({ session: 'pa-1' })
      const res = await executeOne(c, ['todo', 'rm', t.id, '--yes'])
      expect(res.errorCode).toBe('grant_required')

      const g = agentRepo.listGrants({
        agentId: 'agent:alice',
        scope: 'destructive',
        status: 'pending'
      })[0]
      // 参数（删哪一条）全在 argv 里 —— 只存 command='todo rm' 是不够的
      expect(g.requestArgv).toEqual(['todo rm', t.id, '--yes'])
      expect(g.targetIds).toEqual([t.id])
    })

    it('代人执行：以发起 agent 的身份落地，回执留在记录上，成功即销账', async () => {
      const t = mkTodo('代执行的靶子')
      const c = await withCredential({ session: 'pa-2' })
      await executeOne(c, ['todo', 'rm', t.id, '--yes'])
      const g = agentRepo.listGrants({
        agentId: 'agent:alice',
        scope: 'destructive',
        status: 'pending'
      })[0]

      // 人点头
      agentRepo.resolveGrant(g.id, true)

      // 服务端代为执行（IPC 层做的那一步）
      const outcome = await executeApproved(ctx as never, g.requestArgv, {
        agentId: g.agentId,
        grantId: g.id
      })
      expect(outcome.ok, `代为执行应成功，实际：${outcome.errorCode} / ${outcome.message}`).toBe(
        true
      )
      // 真的删掉了 —— 这才是"服务端直接处理"的意义
      expect(todoRepo.getById(t.id)).toBeNull()

      // 销账：一次性授权用掉即止，不存在"批一次、动两次"
      const after = agentRepo.getGrant(g.id)!
      expect(after.status).toBe('consumed')

      // 回执：人在界面上要能看到这一下到底做成了什么
      agentRepo.recordGrantExecution(g.id, true)
      expect(agentRepo.getGrant(g.id)!.execStatus).toBe('ok')
    })

    it('代人执行只认"刚点的那一条"：为 A 批过，不能拿来执行 B', async () => {
      const a = mkTodo('批准对象 A')
      const b = mkTodo('未批准对象 B')
      const c = await withCredential({ session: 'pa-3' })

      // 先为 A 申请并被批准（仍在有效期内）
      await executeOne(c, ['todo', 'rm', a.id, '--yes'])
      const grantA = agentRepo.listGrants({
        agentId: 'agent:alice',
        scope: 'destructive',
        status: 'pending'
      })[0]
      agentRepo.resolveGrant(grantA.id, true)

      /**
       * 再为 B 申请。此时库里同时躺着"一条已批准（A）"和"一条待表态（B）"。
       * 服务端要执行的是 **B 那条**（用户刚点的），而它还没被批准 ——
       * 只判"当前有可用授权"就会挑中 A 那条，于是又回到"批的与做的不一致"。
       */
      await executeOne(c, ['todo', 'rm', b.id, '--yes'])
      const grantB = agentRepo
        .listGrants({ agentId: 'agent:alice', scope: 'destructive', status: 'pending' })
        .find((x) => x.targetIds.includes(b.id))!

      const outcome = await executeApproved(ctx as never, grantB.requestArgv, {
        agentId: grantB.agentId,
        grantId: grantB.id
      })
      // 用户没批 B → 不能借 A 的授权把它做掉
      expect(outcome.ok).toBe(false)
      expect(todoRepo.getById(b.id), 'B 没有被批准，必须还在').not.toBeNull()
      // 而 A 的授权也不能被这次动作消费掉
      expect(agentRepo.getGrant(grantA.id)!.status).toBe('granted')

      // 收尾：拒掉 B 的待表态申请，别留库影响后续用例
      agentRepo.resolveGrant(grantB.id, false)
    })

    it('执行失败也留回执，且不吞掉人已经做过的这个决定', async () => {
      const t = mkTodo('执行时会消失的靶子')
      const c = await withCredential({ session: 'pa-4' })
      await executeOne(c, ['todo', 'rm', t.id, '--yes'])
      const g = agentRepo.listGrants({
        agentId: 'agent:alice',
        scope: 'destructive',
        status: 'pending'
      })[0]
      agentRepo.resolveGrant(g.id, true)

      // 模拟"批准之后、执行之前"目标被别处删掉了 → 执行必然失败
      todoRepo.delete(t.id, 'gui')

      const outcome = await executeApproved(ctx as never, g.requestArgv, {
        agentId: g.agentId,
        grantId: g.id
      })
      expect(outcome.ok).toBe(false)

      agentRepo.recordGrantExecution(g.id, false, outcome.message)
      const after = agentRepo.getGrant(g.id)!
      // 失败要说清为什么 —— 界面得能告诉人"这一下没做成"
      expect(after.execStatus).toBe('error')
      expect(after.execError).toBeTruthy()
      expect(after.executedAt).toBeTruthy()
    })

    it('历史申请没有 argv 时不假装成功（不静默吞掉人的点头）', async () => {
      const t = mkTodo('v20 之前的申请')
      const c = await withCredential({ session: 'pa-5' })
      await executeOne(c, ['todo', 'rm', t.id, '--yes'])
      const g = agentRepo.listGrants({
        agentId: 'agent:alice',
        scope: 'destructive',
        status: 'pending'
      })[0]
      agentRepo.resolveGrant(g.id, true)

      // 抹掉 argv，模拟 v20 之前落的申请
      db.prepare('UPDATE agent_grants SET request_argv = NULL WHERE id = ?').run(g.id)
      expect(agentRepo.getGrant(g.id)!.requestArgv).toEqual([])
      // 界面据 requestArgv.length === 0 判"无法代为执行"，
      // 授权仍生效、由 agent 自己重试 —— 但不能让人以为已经执行过了
    })

    /**
     * whoami 带 id 要能查到**执行回执**（1.0.48）。
     *
     * 主用户本轮定的判据是「人能看到的信息，agent 也要能看到」。
     * 原先这里只给 `status` —— 而"批准即执行"之后 `granted` 有两种含义：
     * 还没人点头、以及**人点了头但执行失败**（失败不销账，销账只在成功时发生）。
     * 两者从 status 上完全分不出来，agent 无从知道自己上次为什么没做成，
     * 只能翻早先那段可能已被裁掉的命令输出。
     */
    it('whoami 带 id 时把执行回执一并给出（与界面显示同一份事实）', async () => {
      const t = mkTodo('回执可见性靶子')
      const c = await withCredential({ session: 'who-receipt' })
      await executeOne(c, ['todo', 'rm', t.id, '--yes'])
      const g = agentRepo.listGrants({
        agentId: 'agent:alice',
        scope: 'destructive',
        status: 'pending'
      })[0]
      agentRepo.resolveGrant(g.id, true)
      // 目标在批准后、执行前被别处删掉 → 执行必然失败，回执落 error
      todoRepo.delete(t.id, 'gui')
      const outcome = await executeApproved(ctx as never, g.requestArgv, {
        agentId: g.agentId,
        grantId: g.id
      })
      expect(outcome.ok).toBe(false)
      agentRepo.recordGrantExecution(g.id, false, outcome.message)

      const res = await executeOne(ctx as never, ['agent', 'whoami', 'agent:alice'])
      expect(res.ok).toBe(true)
      const scopes = (res.data as { scopes: { destructive: Record<string, unknown> } }).scopes
      expect(scopes.destructive).toMatchObject({ status: 'granted', execStatus: 'error' })
      expect(String(scopes.destructive.execError)).toBeTruthy()
      expect(String(scopes.destructive.executedAt)).toBeTruthy()
    })
  })

  it('撤销：收回还没用掉的授权', async () => {
    await executeOne(await withCredential({ session: 's1' }), ['ui', 'set', '--key', 'theme', '--value', 'dark'])
    approvePending('config')

    /**
     * 1.0.47：撤销不再限人执行（与 register / credential 同批放开）。
     * 它只能**收窄**权限，最坏效果是把自己锁上，不可能提权 —— 所以
     * "agent 不能自己撤销"没有安全收益，反而挡住"助手发现权限过宽、
     * 主动申请收窄"这种正常场景。
     */
    const byAgent = await executeOne(await withCredential(), ['agent', 'revoke', '--id', 'agent:alice'])
    expect(byAgent.ok).toBe(true)
    expect((byAgent.data as { revokedGrants: number }).revokedGrants).toBe(1)

    // 收回之后，改界面又回到"要申请"
    const retry = await executeOne(await withCredential({ session: 's1' }), [
      'ui', 'set', '--key', 'theme', '--value', 'dark'
    ])
    expect(retry.ok).toBe(false)
  })

  /**
   * 1.0.47：办手续不再看"是不是终端"、也不再拦 agent。
   *
   * 历史：1.0.38 曾把判据从 `isInteractive` 改成"是不是 agent 身份"，
   * 理由是"agent 自报 tty:true 就能自己 register + 自己 credential"。
   * 但 1.0.47 重新判定了这个威胁模型 —— 自办手续**本身不构成提权**：
   * 注册只产出名字（approved=0）、凭据不通过审批照样被拦，
   * 而批准只能由人在界面上做（`agent:setApproved` 仅 IPC）。
   * 所以"谁办了手续"不再需要区分，这条闸门整体撤掉。
   *
   * 仍要锁住的：**自称在终端也拿不到写权限**（下面第二条断言）。
   */
  it('自办手续不再看终端也不拦 agent，但自报 TTY 拿不到写权限', async () => {
    const agentClaimingTty = { ...ctx, interactive: true, actor: 'agent:alice' } as never
    const registered = await executeOne(agentClaimingTty, [
      'agent', 'register', '--id', 'agent:poc-other', '--name', '另一个'
    ])
    expect(registered.ok).toBe(true)
    expect(agentRepo.get('agent:poc-other')!.approved).toBe(false)

    const human = { ...ctx, interactive: true } as never
    const byHuman = await executeOne(human, [
      'agent', 'register', '--id', 'agent:poc-new', '--name', '新来的'
    ])
    expect(byHuman.ok).toBe(true)
  })

  it('授权记录可查（撤销与审计的入口）', async () => {
    await executeOne(await withCredential({ session: 's1' }), ['ui', 'set', '--key', 'theme', '--value', 'dark'])
    const res = await executeOne(ctx as never, ['agent', 'grants', '--id', 'agent:alice'])
    expect(res.ok).toBe(true)
    const d = res.data as { count: number; grants: { scope: string; status: string; command: string | null }[] }
    expect(d.count).toBe(1)
    expect(d.grants[0]).toMatchObject({ scope: 'config', status: 'pending', command: 'ui set' })
  })

  it('whoami 自检把三档结论一次给全，不用撞墙才知道', async () => {
    const c = await withCredential({ session: 's1' })
    const before = await executeOne(c, ['agent', 'whoami'])
    expect((before.data as { scopes: { config: string } }).scopes.config).toBe('no')

    await executeOne(c, ['ui', 'set', '--key', 'theme', '--value', 'dark'])
    approvePending('config')
    const after = await executeOne(c, ['agent', 'whoami'])
    expect((after.data as { scopes: { config: string; destructive: string } }).scopes).toMatchObject({
      config: 'session',
      destructive: 'no'
    })
  })
})

/**
 * 1.0.37（主用户本轮提的三件事）
 *
 * 1. 审批入口不可发现 → 申请要能通知到 GUI（事件表 + 红点）
 * 2. Bob新报的两条：失败信封丢 data、telemetry 取数方向反了
 * 3. 项目设为必填（她："我根本不知道每个 agent 现在具体在围绕着什么事情做事"）
 */
describe('项目必填（1.0.37：主用户提的"看板上看不出谁在忙什么"）', () => {
  beforeAll(() => {
    runMigrations(db)
  })

  beforeEach(() => {
    db.prepare('DELETE FROM todo_categories').run()
    db.prepare('DELETE FROM memos').run()
    db.prepare('DELETE FROM todos').run()
    db.prepare('DELETE FROM projects').run()
    db.prepare('DELETE FROM categories').run()
    /**
     * 预建「测试项目」：1.0.40 起 `--project` 传不存在的名字会**报错**
     * （原先静默新建，错字会分叉出垃圾项目 —— Bob实测报的）。
     * 本文件有 20+ 处用 `--project '测试项目'`，预建一个最省改动，
     * 也更贴近真实场景（项目本来就该先存在）。
     */
    // 先重置 id 计数器再预建：否则预建项目会消耗 cli-uuid-N，
    // 而随后的 seq=0 又把它归零，用例内新建的对象会撞上同一个 id
    // （UNIQUE constraint failed: projects.id）。顺序反了才是根因。
    seq = 0
    projectRepo.create({ name: '测试项目' })
  })

  it('todo add 不带 --project：报 usage_error，且直接列出本机已有项目', async () => {
    projectRepo.create({ name: 'DeskPartner' })
    const res = await run(['todo', 'add', '--title', '忘了写项目'])
    expect(res.ok).toBe(false)
    expect(res.code).toBe(2)
    expect(res.message).toContain('--project')
    // 光说"缺参数"没用：agent 第一次撞上必填时最想知道的是"本机有哪些项目"
    expect(res.message).toContain('DeskPartner')
  })

  it('本机一个项目都没有时也给指路（不传 --project 会被拦下）', async () => {
    const res = await run(['todo', 'add', '--title', 'x'])
    expect(res.ok).toBe(false)
    // 断言放宽到关键词：文案会随 --project 的 desc 一起演进，
    // 揪住某一句话会让这条用例在每次改文案时误报
    expect(res.message).toContain('项目')
  })

  it('带了 --project 且项目存在：正常落库', async () => {
    // repo 要求库里至少有一个分类（历史约定），否则 create 直接报"还没有任何分类"
    categoryRepo.create({ name: '方向', color: '#1', sortOrder: 0 })
    const res = await run(['todo', 'add', '--title', '带项目', '--project', '测试项目'])
    expect(res.ok).toBe(true)
    const id = (res.data as { id: string }).id
    const todo = todoRepo.getById(id)!
    expect(todo.projectId).not.toBeNull()
    expect(projectRepo.getById(todo.projectId!)!.name).toBe('测试项目')
  })

  /**
   * 1.0.40 收紧：`--project` 传不存在的名字**默认报错**，不再静默新建。
   *
   * Bob实测：传错一个字母（DeskPartnr）就分叉出一个新项目、待办也进去了、
   * 全程无提示 —— 而项目是看板的主聚合维度，一散就很难收拾。
   * 真要新建得显式加 `--create-project`，一步不用多跑，但意图明确。
   */
  it('项目不存在时不自动建：报错并提示 --create-project；显式声明才建', async () => {
    categoryRepo.create({ name: '方向', color: '#1', sortOrder: 0 })

    const bad = await run(['todo', 'add', '--title', '错字', '--project', '错字项目'])
    expect(bad.ok).toBe(false)
    expect(bad.message).toContain('项目不存在')
    expect(bad.message).toContain('--create-project')
    // 关键：真的没建出来
    expect(projectRepo.list().some((p) => p.name === '错字项目')).toBe(false)

    const ok = await run([
      'todo', 'add', '--title', '新建的', '--project', '错字项目', '--create-project'
    ])
    expect(ok.ok).toBe(true)
    expect(projectRepo.list().some((p) => p.name === '错字项目')).toBe(true)
  })

  it('--help 仍然优先于必填校验（问用法不该被缺参数拦）', async () => {
    const res = await run(['todo', 'add', '--help'])
    expect(res.ok).toBe(true)
    expect((res.data as { name: string }).name).toBe('todo add')
  })
})

describe('授权申请要能被 GUI 感知（1.0.37：主用户"没看到任何审批提醒"）', () => {
  beforeAll(() => {
    runMigrations(db)
    agentRepo.register({ id: 'agent:alice', displayName: 'Alice' })
  })

  beforeEach(() => {
    db.prepare('DELETE FROM agent_grants').run()
    agentRepo.setApproved('agent:alice', true)
    db.prepare('UPDATE agents SET credential_hash = NULL WHERE id = ?').run('agent:alice')
  })

  const asAgentWithCredential = () => {
    const { token } = agentRepo.issueCredential('agent:alice')!
    return { ...ctx, actor: 'agent:alice', interactive: false, credential: token } as never
  }

  it('申请落地时追加一条 grant 事件（GUI 靠它弹横幅）', async () => {
    const append = vi.fn()
    const c = {
      ...(asAgentWithCredential() as object),
      deps: { ...ctx.deps, events: { append } }
    } as never

    await executeOne(c, ['ui', 'set', '--key', 'theme', '--value', 'dark'])

    const grantCall = append.mock.calls.find((call) => call[0] === 'grant')
    expect(grantCall, '应当追加一条 type=grant 的事件').toBeTruthy()
    expect(grantCall![2]).toMatchObject({ agentId: 'agent:alice', scope: 'config', command: 'ui set' })
    // 事件里要带申请 id，人点「去审批」时才对得上那一条
    expect(String(grantCall![2].grantId)).toBeTruthy()
  })

  it('同一会话重复被拒：申请合并且只通知一次（否则人会被同一个横幅弹十次）', async () => {
    const append = vi.fn()
    const c = {
      ...(asAgentWithCredential() as object),
      deps: { ...ctx.deps, events: { append } },
      session: 's1'
    } as never

    await executeOne(c, ['ui', 'set', '--key', 'theme', '--value', 'dark'])
    await executeOne(c, ['ui', 'set', '--key', 'theme', '--value', 'dark'])
    await executeOne(c, ['ui', 'set', '--key', 'theme', '--value', 'dark'])

    expect(append.mock.calls.filter((call) => call[0] === 'grant').length).toBe(1)
    expect(agentRepo.listGrants({ agentId: 'agent:alice', scope: 'config', status: 'pending' }).length).toBe(1)
  })
})

describe('失败信封带 data（1.0.37 修Bob be59a4cd）', () => {
  it('整体失败时 data 不能丢 —— message 里写着"详见 results"，信封里就得有 results', async () => {
    const { formatOutcome } = await import('../../../src/main/cli/output')
    const res = formatOutcome(
      {
        ok: false,
        code: 1,
        errorCode: 'batch_all_failed',
        message: '批量执行全部失败，详见 results',
        data: { total: 2, failed: 2, results: [{ ok: false }, { ok: false }] }
      },
      ['batch'],
      false
    )
    const envelope = JSON.parse(res.stdout) as Record<string, unknown>
    expect(envelope.ok).toBe(false)
    // 此前这里只有 {ok, code, message}，data 整个被丢掉
    expect(envelope.data).toBeTruthy()
    expect((envelope.data as { results: unknown[] }).results).toHaveLength(2)
  })
})

describe('telemetry 取数方向（1.0.37 修Bob b736ec95）', () => {
  let telemetry: InstanceType<typeof import('../../../src/main/database/telemetry.repository')['TelemetryRepository']>

  beforeAll(async () => {
    runMigrations(db)
    const { TelemetryRepository } = await import('../../../src/main/database/telemetry.repository')
    telemetry = new TelemetryRepository()
  })

  beforeEach(() => {
    db.prepare('DELETE FROM usage_events').run()
  })

  const seedEvents = (n: number) => {
    for (let i = 1; i <= n; i++) {
      telemetry.record({
        sessionId: `s${i}`,
        actor: 'human',
        surface: 'cli',
        category: 'cli',
        event: 'invoke',
        props: { seq: i }
      })
    }
  }

  it('默认取最新 N 条（此前取的是最旧的 N 条，排障结论整段作废）', () => {
    seedEvents(10)
    const rows = telemetry.query({ limit: 3 })
    // 最新三条 = seq 8/9/10
    expect(rows.map((r) => (r.props as { seq: number }).seq)).toEqual([8, 9, 10])
  })

  it('返回顺序始终是时间正序（要最新几条 ≠ 要倒着读）', () => {
    seedEvents(5)
    const rows = telemetry.query({ limit: 2 })
    const seqs = rows.map((r) => (r.props as { seq: number }).seq)
    expect(seqs).toEqual([4, 5])
    expect(seqs[0]).toBeLessThan(seqs[1])
  })

  it("order: 'oldest' 显式翻旧账：取最早 N 条", () => {
    seedEvents(10)
    const rows = telemetry.query({ limit: 3, order: 'oldest' })
    expect(rows.map((r) => (r.props as { seq: number }).seq)).toEqual([1, 2, 3])
  })

  it('stats 的 firstTs/lastTs 依赖正序，不能被倒序取数带偏', () => {
    seedEvents(6)
    const s = telemetry.stats({ limit: 3 }) as { total: number; firstTs: string | null; lastTs: string | null }
    expect(s.total).toBe(3)
    expect(s.firstTs).not.toBeNull()
    expect(s.lastTs).not.toBeNull()
    // 只取了最新三条，跨度应当是"第 4 条 → 第 6 条"，不能首尾颠倒
    expect(s.firstTs! <= s.lastTs!).toBe(true)
  })
})

describe('多身份凭据混同（1.0.37 修Bob 32f0bf89）', () => {
  beforeAll(() => {
    runMigrations(db)
    agentRepo.register({ id: 'agent:alice', displayName: 'Alice' })
    agentRepo.register({ id: 'agent:bob', displayName: 'Bob' })
    agentRepo.setApproved('agent:alice', true)
    agentRepo.setApproved('agent:bob', true)
  })

  /**
   * 本机有两份凭据、这次调用又没声明身份 —— 启动器会发现这个情况，
   * 把候选列表经 env（无头）或报文（管道）带进门禁。这里直接模拟那一步。
   */
  const ambiguousCtx = (extra: Record<string, unknown> = {}) =>
    ({
      ...ctx,
      interactive: false,
      actor: 'human',
      ambiguousIds: ['agent:alice', 'agent:bob'],
      ...extra
    }) as never

  it('读命令照常放行（不需要身份，不能一刀切堵死 todo list）', async () => {
    const res = await executeOne(ambiguousCtx(), ['todo', 'list'])
    expect(res.ok).toBe(true)
  })

  it('写命令拒绝，且不替调用方猜用哪一份（猜错就把操作记到别人名下）', async () => {
    const res = await executeOne(ambiguousCtx(), ['todo', 'add', '--title', 'x', '--project', '测试项目'])
    expect(res.ok).toBe(false)
    expect(res.code).toBe(4)
    expect(res.errorCode).toBe('ambiguous_identity')
    // 报错要能自救：列出候选 + 给出声明方式
    expect(res.message).toContain('agent:alice')
    expect(res.message).toContain('DESKPARTNER_AGENT')
  })

  it('声明了身份就不再是"没声明"：门禁往前走（这里因缺凭据被拦，而不是 ambiguous）', async () => {
    const res = await executeOne(ambiguousCtx({ actor: 'agent:bob' }), [
      'todo', 'add', '--title', 'x', '--project', '测试项目'
    ])
    expect(res.ok).toBe(false)
    // 关键：报的是它自己缺凭据，而不是"你有两个身份我分不清"
    expect(res.errorCode).not.toBe('ambiguous_identity')
  })

  it('whoami 自检直接把候选与修法报出来，不用撞墙才知道', async () => {
    const res = await executeOne(ambiguousCtx(), ['agent', 'whoami'])
    expect(res.ok).toBe(true)
    const d = res.data as { ambiguousIdentity?: { candidates: string[]; fix: string } }
    expect(d.ambiguousIdentity).toBeTruthy()
    expect(d.ambiguousIdentity!.candidates).toContain('agent:bob')
    expect(d.ambiguousIdentity!.fix).toContain('DESKPARTNER_AGENT')
  })

  it('单份凭据不受影响：没声明也照常放行（单人单 agent 的零摩擦要保住）', async () => {
    const res = await executeOne(
      { ...ctx, interactive: false, actor: 'agent:alice' } as never,
      ['agent', 'whoami']
    )
    expect(res.ok).toBe(true)
  })
})

/**
 * G7：待确认事项的描述要素自检（1.0.49，主用户 2026-09-24）
 *
 * 起因：她打开看板说"只有 2 件事情需要我确认，但里面只描述了问题，
 * 并没有给出我需要拍板的决策项…我不知道可以怎么给你拍板"。
 *
 * 这条闸门守的是**第二层**根因：写歪了没人提醒。
 * 第一层（不知道该写什么）由 agent 说明书 + ISSUE_STYLE.md 覆盖。
 */
describe('待确认事项的描述要素自检（G7 软提醒，1.0.49）', () => {
  beforeAll(() => {
    runMigrations(db)
    agentRepo.register({ id: 'agent:alice', displayName: 'Alice' })
  })

  beforeEach(() => {
    db.prepare('DELETE FROM todo_categories').run()
    db.prepare('DELETE FROM todos').run()
    db.prepare('DELETE FROM projects').run()
    db.prepare('DELETE FROM categories').run()
    seq = 0
    projectRepo.create({ name: '测试项目' })
    // 分类要预建：库里一个分类都没有时 `todo add` 无处回退，会直接失败
    categoryRepo.create({ name: '方向', color: '#1', sortOrder: 0 })
  })

  const addProposed = (extra: string[]) =>
    run([
      'todo', 'add', '--title', '一件事', '--created-by', 'agent:alice',
      '--status', 'proposed', '--project', '测试项目', '--category', '方向', ...extra
    ])

  it('「待确认」但没写描述 → 提醒"没有描述"，因为人无法据此拍板', async () => {
    const res = await addProposed([])
    expect(res.ok).toBe(true)
    expect(res.notice).toContain('没有描述')
  })

  it('描述缺要素 → 提醒里点名缺了哪些', async () => {
    const res = await addProposed(['--desc', '这块儿感觉有点别扭，你看看'])
    expect(res.ok).toBe(true)
    expect(res.notice).toContain('没看到这些要素')
    expect(res.notice).toContain('不选会怎样')
  })

  it('六要素齐全 → 不给提醒（别对写得好的人啰嗦）', async () => {
    const desc = [
      '【问题】待确认项看完不知道要定什么',
      '【要你定什么】描述要不要强制带要素',
      '【现状】现在没有任何约束',
      '【证据】实测 QuickAddForm.tsx:477',
      '【选项】① 软提醒 —— 代价：可能被忽略　② 硬拦 —— 代价：正当写法被挡',
      '【我的建议】①。理由：格式不是价值所在',
      '【不选会怎样】继续靠自觉，会漂'
    ].join('\n')
    const res = await addProposed(['--desc', desc])
    expect(res.ok).toBe(true)
    expect(res.notice).toBeUndefined()
  })

  it('非「待确认」不检查（待做/已完成不要求拍板要素）', async () => {
    const res = await run([
      'todo', 'add', '--title', '一件事', '--created-by', 'agent:alice',
      '--status', 'todo', '--project', '测试项目', '--category', '方向',
      '--desc', '随手记的一条'
    ])
    expect(res.ok).toBe(true)
    expect(res.notice).toBeUndefined()
  })

  it('改完描述后（仍在待确认）同样自检', async () => {
    await addProposed(['--desc', '【现状】x　【证据】y　【选项】① a ② b　【代价】c　【建议】①　【不选会怎样】d'])
    const id = todoRepo.list({ status: 'proposed' })[0].id
    const res = await run([
      'todo', 'update', id, '--desc', '重写成了很短的一句', '--overwrite-desc',
      '--created-by', 'agent:alice'
    ])
    expect(res.ok).toBe(true)
    expect(res.notice).toBeTruthy()
  })
})

/**
 * 评论线程的 CLI 三件套（1.0.54）
 *
 * 为什么这一组必须写在**命令层**：本项目的教训是"参数收下了却没传下去"
 * （category:update 收了 color 却只传 name，静态检查全绿、静默失效）。
 * repo 层单测（comment.repository.test.ts）验证的是仓储本身，
 * 走不到「命令声明的 flag → run() → 真的落库」这一段。
 */
describe('todo comment（1.0.54：往来走评论，不动描述）', () => {
  beforeAll(() => {
    runMigrations(db)
    agentRepo.register({ id: 'agent:alice', displayName: 'Alice' })
  })

  beforeEach(() => {
    db.prepare('DELETE FROM todo_comments').run()
    db.prepare('DELETE FROM todo_transitions').run()
    db.prepare('DELETE FROM todo_categories').run()
    db.prepare('DELETE FROM todos').run()
    db.prepare('DELETE FROM projects').run()
    db.prepare('DELETE FROM categories').run()
    seq = 0
    projectRepo.create({ name: '测试项目' })
    categoryRepo.create({ name: '方向', color: '#1', sortOrder: 0 })
  })

  const addTodo = (extra: string[] = []) =>
    run([
      'todo', 'add', '--title', '一条事项', '--project', '测试项目',
      '--category', '方向', '--desc', '原始规格', ...extra
    ])

  it('评论落库，且描述一个字节都不动', async () => {
    const add = await addTodo()
    const id = (add.data as { id: string }).id

    const res = await run(['todo', 'comment', id, '--body', '进度：解析完了'])
    expect(res.ok).toBe(true)
    const data = res.data as { commentId: string; parentId: string | null; commentCount: number }
    expect(data.parentId).toBeNull()
    expect(data.commentCount).toBe(1)

    // 关键：规格还在 description 里，没被"往来的内容"挤进去
    expect(todoRepo.getById(id)!.description).toBe('原始规格')
    const thread = commentRepo.listByTodo(id)
    expect(thread).toHaveLength(1)
    expect(thread[0].body).toBe('进度：解析完了')
    expect(thread[0].kind).toBe('comment')
  })

  it('带调用身份时记成 agent，不带时记 human（谁说的要分清）', async () => {
    const add = await addTodo()
    const id = (add.data as { id: string }).id
    const ctxAsAgent = { ...ctx, actor: 'agent:alice' }

    await executeOne(ctxAsAgent as never, ['todo', 'comment', id, '--body', 'agent 说的'])
    await run(['todo', 'comment', id, '--body', '人说的'])

    const thread = commentRepo.listByTodo(id)
    expect(thread[0].authorType).toBe('agent')
    expect(thread[0].authorId).toBe('agent:alice')
    expect(thread[1].authorType).toBe('human')
  })

  it('--reply-to 接楼中楼：parentId 指向被回复的那条', async () => {
    const add = await addTodo()
    const id = (add.data as { id: string }).id
    const first = await run(['todo', 'comment', id, '--body', '顶层'])
    const parentId = (first.data as { commentId: string }).commentId

    const res = await run(['todo', 'comment', id, '--body', '回复它', '--reply-to', parentId])
    expect(res.ok).toBe(true)
    expect((res.data as { parentId: string }).parentId).toBe(parentId)
    expect(commentRepo.listByTodo(id)).toHaveLength(2)
  })

  it('--reply-to 支持短号（与 todo id 同口径）', async () => {
    const add = await addTodo()
    const id = (add.data as { id: string }).id
    const first = await run(['todo', 'comment', id, '--body', '顶层'])
    const parentId = (first.data as { commentId: string }).commentId

    const res = await run(['todo', 'comment', id, '--body', '回它', '--reply-to', parentId.slice(0, 8)])
    expect(res.ok).toBe(true)
    expect((res.data as { parentId: string }).parentId).toBe(parentId)
  })

  it('--reply-to 指向别的事项的评论 → 报错，不挂错地方', async () => {
    const a = await addTodo()
    const b = await run([
      'todo', 'add', '--title', '另一条', '--project', '测试项目', '--category', '方向'
    ])
    const idA = (a.data as { id: string }).id
    const idB = (b.data as { id: string }).id

    const c = await run(['todo', 'comment', idA, '--body', 'A 的评论'])
    const commentIdA = (c.data as { commentId: string }).commentId

    // 用 B 的 id + A 的评论 id：评论确实存在，但不属于这条事项
    const res = await run(['todo', 'comment', idB, '--body', '挂错', '--reply-to', commentIdA])
    expect(res.ok).toBe(false)
    expect(res.code).toBe(3) // not_found
    expect(res.message).toContain('找不到评论')

    // B 上不能因此多出一条评论
    expect(commentRepo.listByTodo(idB)).toHaveLength(0)
  })

  it('正文为空 / 缺正文 → 用法错误，且不落库', async () => {
    const add = await addTodo()
    const id = (add.data as { id: string }).id

    const empty = await run(['todo', 'comment', id, '--body', '   '])
    expect(empty.ok).toBe(false)
    expect(empty.code).toBe(2)

    const missing = await run(['todo', 'comment', id])
    expect(missing.ok).toBe(false)
    expect(missing.code).toBe(2)

    expect(commentRepo.countByTodo(id)).toBe(0)
  })

  it('事项 id 不存在 → not_found，不是静默成功', async () => {
    const res = await run(['todo', 'comment', '不存在的id', '--body', 'x'])
    expect(res.ok).toBe(false)
    expect(res.code).toBe(3)
  })

  /**
   * --body-file 由启动器展开（src/cli/launcher.ts FILE_FLAGS）。
   * 服务端真收到它时必须**明确报错** —— 上一版 --desc-file 就是
   * "声明进 args 表讨好 help 可发现性" → 从"报未知 flag"退化成
   * "认识但不处理"，batch 通道静默丢内容还回 ok=true（Bob 7f48eb16）。
   */
  it('服务端收到 --body-file 明确报错，不静默丢正文', async () => {
    const add = await addTodo()
    const id = (add.data as { id: string }).id

    const res = await run(['todo', 'comment', id, '--body-file', 'C:/tmp/whatever.txt'])
    expect(res.ok).toBe(false)
    expect(res.code).toBe(2)
    expect(res.message).toContain('--body-file')
    expect(commentRepo.countByTodo(id)).toBe(0)
  })
})

describe('todo reject（1.0.54：退回要留下理由，且理由在评论里）', () => {
  beforeAll(() => {
    runMigrations(db)
    agentRepo.register({ id: 'agent:alice', displayName: 'Alice' })
  })

  beforeEach(() => {
    db.prepare('DELETE FROM todo_comments').run()
    db.prepare('DELETE FROM notifications').run()
    db.prepare('DELETE FROM todo_transitions').run()
    db.prepare('DELETE FROM todo_categories').run()
    db.prepare('DELETE FROM todos').run()
    db.prepare('DELETE FROM projects').run()
    db.prepare('DELETE FROM categories').run()
    seq = 0
    projectRepo.create({ name: '测试项目' })
    categoryRepo.create({ name: '方向', color: '#1', sortOrder: 0 })
  })

  /**
   * 造一条「待验收」的事项（agent 交付态）。
   *
   * 必须两步走：`todo add --status awaiting_review` 被 G3 明确拦下
   * （"没有执行过程的事没什么可验收"），这正是该命令的既有行为，
   * 但走 update 路径才会触发 recordTransition 里的交付/驳回通知。
   */
  const addAwaiting = async (owner = 'agent:alice') => {
    const add = await run([
      'todo', 'add', '--title', '待验收的活', '--project', '测试项目', '--category', '方向',
      '--desc', '规格：把按钮挪到左边', '--created-by', owner
    ])
    const id = (add.data as { id: string }).id
    const ctxAsAgent = { ...ctx, actor: owner }
    const up = await executeOne(ctxAsAgent as never, [
      'todo', 'update', id, '--status', 'awaiting_review'
    ])
    if (!up.ok) throw new Error(`造「待验收」失败: ${up.message}`)
    return id
  }

  it('驳回：状态退回「进行中」+ 落一条 kind=reject 的评论', async () => {
    const id = await addAwaiting()
    const res = await run(['todo', 'reject', id, '--reason', '按钮位置不对，重新对一遍稿'])

    expect(res.ok).toBe(true)
    expect(todoRepo.getById(id)!.status).toBe('in_progress')

    const thread = commentRepo.listByTodo(id)
    const reject = thread.find((c) => c.kind === 'reject')
    expect(reject).toBeDefined()
    expect(reject!.body).toBe('按钮位置不对，重新对一遍稿')
  })

  /**
   * 这是本次设计的核心边界：驳回理由**不进描述**。
   * 若它写进了 description，详情页的规格卡就被往来内容冲乱了 ——
   * 那正是 1.0.54 要解决的问题。
   */
  it('驳回理由写在评论、不写进描述（规格卡不被污染）', async () => {
    const id = await addAwaiting()
    const before = todoRepo.getById(id)!.description
    await run(['todo', 'reject', id, '--reason', '这块要重做'])

    expect(todoRepo.getById(id)!.description).toBe(before)
  })

  it('驳回同时写通知（执行方在收件箱里看得见，不用逐条翻描述）', async () => {
    const id = await addAwaiting()
    await run(['todo', 'reject', id, '--reason', '重做'])

    const list = notificationRepo.list()
    const hit = list.find((n) => n.refId === id && n.meta?.includes('"rejected":true'))
    expect(hit).toBeDefined()
    expect(hit!.title).toContain('退回')
  })

  it('缺 --reason → 用法错误，状态与评论都不动', async () => {
    const id = await addAwaiting()
    const res = await run(['todo', 'reject', id])
    expect(res.ok).toBe(false)
    expect(res.code).toBe(2)
    expect(res.message).toContain('--reason')
    expect(todoRepo.getById(id)!.status).toBe('awaiting_review')
    expect(commentRepo.countByTodo(id)).toBe(0)
  })

  it('--reason 只有空白 → 同样拒绝（别用空白当理由蒙混）', async () => {
    const id = await addAwaiting()
    const res = await run(['todo', 'reject', id, '--reason', '   '])
    expect(res.ok).toBe(false)
    expect(res.code).toBe(2)
    expect(todoRepo.getById(id)!.status).toBe('awaiting_review')
  })

  it('不在「待验收」的事项不能驳回（驳回 = 验收不通过）', async () => {
    const add = await run([
      'todo', 'add', '--title', '还在干', '--project', '测试项目', '--category', '方向',
      '--status', 'in_progress'
    ])
    const id = (add.data as { id: string }).id

    const res = await run(['todo', 'reject', id, '--reason', 'x'])
    expect(res.ok).toBe(false)
    expect(res.code).toBe(2)
    expect(res.message).toContain('待验收')
  })

  it('驳回后：执行方跑写命令，回执会提醒它有活被退回（B 方案）', async () => {
    const id = await addAwaiting()
    await run(['todo', 'reject', id, '--reason', '再改一版'])

    // 执行方下次调**写命令**时被提醒
    const ctxAsAgent = { ...ctx, actor: 'agent:alice' }
    const res = await executeOne(ctxAsAgent as never, [
      'todo', 'add', '--title', '另一件', '--project', '测试项目', '--category', '方向'
    ])
    expect(res.ok).toBe(true)
    expect(res.notice).toContain('被验收方退回')
    // 提醒必须指向评论（1.0.54 后驳回理由在评论里，不在描述里）
    expect(res.notice).toContain('评论')
  })

  it('读命令不刷驳回提醒（每次都刷太吵）', async () => {
    const id = await addAwaiting()
    await run(['todo', 'reject', id, '--reason', '重做'])

    const ctxAsAgent = { ...ctx, actor: 'agent:alice' }
    const res = await executeOne(ctxAsAgent as never, ['todo', 'list'])
    expect(res.ok).toBe(true)
    expect(res.notice ?? '').not.toContain('被验收方退回')
  })

  it('驳回的是别人的活 → 不提醒我（提醒按事项归属筛）', async () => {
    const id = await addAwaiting('agent:bob')
    await run(['todo', 'reject', id, '--reason', '重做'])

    const ctxAsAlice = { ...ctx, actor: 'agent:alice' }
    const res = await executeOne(ctxAsAlice as never, [
      'todo', 'add', '--title', '我的活', '--project', '测试项目', '--category', '方向'
    ])
    expect(res.ok).toBe(true)
    expect(res.notice ?? '').not.toContain('被验收方退回')
  })

  /**
   * 2026-10-01 实测修的口子：`awaiting_review → in_progress` 这条流转
   * **不等于**被驳回 —— 执行方也能自己把卡从「等你验收」收回「进行中」
   * （按人指示重开观察期就是这样）。早先只看流转，于是自己收回被误报成
   * "被验收方退回"，翻遍评论线程却找不到驳回理由，白跑一轮。
   */
  it('执行方自己把卡从「待验收」收回「进行中」→ 不算被驳回，不提醒', async () => {
    const id = await addAwaiting() // 造的时候 owner=agent:alice，此时 status=awaiting_review
    const ctxAsAgent = { ...ctx, actor: 'agent:alice' }
    // 自己收回：只改状态，没有 reject 评论
    const up = await executeOne(ctxAsAgent as never, [
      'todo', 'update', id, '--status', 'in_progress'
    ])
    expect(up.ok).toBe(true)
    expect(todoRepo.getById(id)!.status).toBe('in_progress')

    const res = await executeOne(ctxAsAgent as never, [
      'todo', 'add', '--title', '另一件', '--project', '测试项目', '--category', '方向'
    ])
    expect(res.ok).toBe(true)
    expect(res.notice ?? '').not.toContain('被验收方退回')
  })

  /**
   * 同一条流转的第二个出口：通知中心。09-29 一次性刷出 4 条假的
   * "验收未通过，已退回"就是这么来的 —— 卡上一条 reject 评论都没有。
   * 判据必须与回执提醒同源（都认那条 reject 评论）。
   */
  it('执行方自己收回 → 不写「验收未通过」通知（通知中心也会骗人）', async () => {
    const id = await addAwaiting()
    const ctxAsAgent = { ...ctx, actor: 'agent:alice' }
    await executeOne(ctxAsAgent as never, ['todo', 'update', id, '--status', 'in_progress'])

    const isRejectedNotice = (n: { refId: string | null; meta: string | null }) =>
      n.refId === id && String(n.meta ?? '').includes('"rejected"')

    const rejected = notificationRepo.list().filter(isRejectedNotice)
    expect(rejected).toHaveLength(0)
    // 但「交付待验收」那条索引通知还应该在（交付本身是事实）
    const delivered = notificationRepo.list().filter((n) => n.refId === id && n.title.includes('交付待验收'))
    expect(delivered.length).toBeGreaterThan(0)
  })

  it('真驳回（走 todo reject）→ 通知中心照旧留一条「验收未通过」', async () => {
    const id = await addAwaiting()
    await run(['todo', 'reject', id, '--reason', '按钮位置不对'])
    const rejected = notificationRepo
      .list()
      .filter((n) => n.refId === id && String(n.meta ?? '').includes('"rejected"'))
    expect(rejected).toHaveLength(1)
  })
})

describe('todo delete-comment（1.0.54：错了就删，别用新评论掩盖）', () => {
  /**
   * 1.0.63 起这条命令多了一道 `--yes`（与 todo rm 同口径），
   * 且删**别人写的**评论会转成删除档、需人点头（收 dbfbc553 选③）。
   * 本组用例是"自删"路径（作者=调用者本人），所以只需补上 --yes；
   * 分级本身另有一组专门用例，见后面「删评论授权分级」。
   */
  beforeAll(() => {
    runMigrations(db)
    agentRepo.register({ id: 'agent:alice', displayName: 'Alice' })
  })

  beforeEach(() => {
    db.prepare('DELETE FROM todo_comments').run()
    db.prepare('DELETE FROM todo_transitions').run()
    db.prepare('DELETE FROM todo_categories').run()
    db.prepare('DELETE FROM todos').run()
    db.prepare('DELETE FROM projects').run()
    db.prepare('DELETE FROM categories').run()
    seq = 0
    projectRepo.create({ name: '测试项目' })
    categoryRepo.create({ name: '方向', color: '#1', sortOrder: 0 })
  })

  const addTodo = async () => {
    const add = await run([
      'todo', 'add', '--title', '一条事项', '--project', '测试项目', '--category', '方向'
    ])
    return (add.data as { id: string }).id
  }

  it('按完整 id 删除，回执带删后计数', async () => {
    const id = await addTodo()
    const c = await run(['todo', 'comment', id, '--body', '写错了'])
    const commentId = (c.data as { commentId: string }).commentId

    const res = await run(['todo', 'delete-comment', commentId, '--yes'])
    expect(res.ok).toBe(true)
    const data = res.data as { commentId: string; commentCount: number; cascadedReplies: number }
    expect(data.commentId).toBe(commentId)
    expect(data.commentCount).toBe(0)
    expect(data.cascadedReplies).toBe(0)
    expect(commentRepo.countByTodo(id)).toBe(0)
  })

  it('支持短号（与 delete 的其它命令同口径）', async () => {
    const id = await addTodo()
    const c = await run(['todo', 'comment', id, '--body', '写错了'])
    const commentId = (c.data as { commentId: string }).commentId

    const res = await run(['todo', 'delete-comment', commentId.slice(0, 8), '--yes'])
    expect(res.ok).toBe(true)
    expect(commentRepo.countByTodo(id)).toBe(0)
  })

  it('删父评论时连带回复，并在回执里报出连带了几条', async () => {
    const id = await addTodo()
    const top = await run(['todo', 'comment', id, '--body', '顶层'])
    const parentId = (top.data as { commentId: string }).commentId
    await run(['todo', 'comment', id, '--body', '子1', '--reply-to', parentId])
    await run(['todo', 'comment', id, '--body', '子2', '--reply-to', parentId])

    const res = await run(['todo', 'delete-comment', parentId, '--yes'])
    expect(res.ok).toBe(true)
    expect((res.data as { cascadedReplies: number }).cascadedReplies).toBe(2)
    expect(commentRepo.countByTodo(id)).toBe(0)
  })

  /**
   * 假成功是本项目反复踩的坑（f159d799：category rm 静默返回空结果 →
   * 退出码 0 + 授权被消费 + 回执说成功，其实一条没删）。
   * 这里必须**报错**，不能回一句 ok。
   */
  it('查不到评论 → not_found，绝不静默回成功', async () => {
    const res = await run(['todo', 'delete-comment', '压根不存在的id', '--yes'])
    expect(res.ok).toBe(false)
    expect(res.code).toBe(3)
    expect(res.message).toContain('找不到评论')
  })

  it('短号命中多条 → 不猜，报找不到（宁可让人把 id 写全）', async () => {
    const id = await addTodo()
    // 直接写库控制 id，造出同前缀的两条
    db.prepare(
      "INSERT INTO todo_comments (id, todo_id, parent_id, author_type, author_id, body, kind, created_at) VALUES ('dup-aaaa', ?, NULL, 'human', 'human', 'A', 'comment', '2026-01-01T00:00:00.000Z')"
    ).run(id)
    db.prepare(
      "INSERT INTO todo_comments (id, todo_id, parent_id, author_type, author_id, body, kind, created_at) VALUES ('dup-bbbb', ?, NULL, 'human', 'human', 'B', 'comment', '2026-01-01T00:00:01.000Z')"
    ).run(id)

    const res = await run(['todo', 'delete-comment', 'dup-', '--yes'])
    expect(res.ok).toBe(false)
    expect(res.code).toBe(3)
    // 两条都还在 —— 拒绝时不能有副作用
    expect(commentRepo.countByTodo(id)).toBe(2)

    // 写全了就删得掉
    const full = await run(['todo', 'delete-comment', 'dup-aaaa', '--yes'])
    expect(full.ok).toBe(true)
    expect(commentRepo.countByTodo(id)).toBe(1)
  })

  it('删评论不影响事项状态与描述', async () => {
    const id = await addTodo()
    await run(['todo', 'update', id, '--desc', '规格', '--overwrite-desc'])
    const c = await run(['todo', 'comment', id, '--body', '往来'])
    const commentId = (c.data as { commentId: string }).commentId

    await run(['todo', 'delete-comment', commentId, '--yes'])

    const after = todoRepo.getById(id)!
    expect(after.description).toBe('规格')
    expect(after.status).toBe('todo')
  })

  /**
   * 验"events 表里真的留下了痕"的几条走这个 runner（卡 69788c32）。
   *
   * 共享夹具里的 `deps.events` 是个 spy（别处的用例要数 append 调没调过），
   * 而命令层的留痕现在**统一走 `ctx.deps.events`** —— 拿 spy 跑就什么都落不了库，
   * 于是本该绿的用例红了。这里按真实接线换成真仓储：**生产里 deps.events 就是
   * `EventsRepository`**（无头通道 new 一份、管道通道给 GUI 那份），所以这不是
   * 为了迁就测试去改行为，而是让夹具回到生产的样子。
   */
  const runAudit = (args: string[]) =>
    executeOne({ ...ctx, deps: { ...ctx.deps, events: new EventsRepository() } } as never, args)

  /**
   * 1.0.55（68c7ccc1 选②）：删评论要留痕。
   *
   * 此前它是物理删除、零痕迹，而同一版里 `--desc` 覆写有审计 ——
   * 同一种"改掉已写下的东西"，两种待遇。这几条守住"删除可追查"。
   */
  it('删除会写进 events：谁删的、删了什么内容都能追查', async () => {
    const id = await addTodo()
    const c = await runAudit(['todo', 'comment', id, '--body', '我承诺改成 B，代价是 C'])
    const commentId = (c.data as { commentId: string }).commentId

    await runAudit(['todo', 'delete-comment', commentId, '--yes'])

    const row = db
      .prepare(`SELECT actor, payload FROM events WHERE type = 'comment_deleted' ORDER BY id DESC LIMIT 1`)
      .get() as { actor: string; payload: string }
    expect(row).toBeTruthy()
    expect(row.actor).toBe('human')
    const payload = JSON.parse(row.payload) as {
      comment: { id: string; body: string; todoId: string }
      cascadedReplies: unknown[]
    }
    expect(payload.comment.id).toBe(commentId)
    expect(payload.comment.body).toBe('我承诺改成 B，代价是 C')
    expect(payload.comment.todoId).toBe(id)
    expect(payload.cascadedReplies).toHaveLength(0)
  })

  it('连带删掉的回复也一并留痕，不是只记一条', async () => {
    const id = await addTodo()
    const p = await run(['todo', 'comment', id, '--body', '父评论'])
    const parentId = (p.data as { commentId: string }).commentId
    await run(['todo', 'comment', id, '--body', '回复一', '--reply-to', parentId])
    await run(['todo', 'comment', id, '--body', '回复二', '--reply-to', parentId])

    const res = await runAudit(['todo', 'delete-comment', parentId, '--yes'])
    expect(res.ok).toBe(true)
    expect((res.data as { cascadedReplies: number }).cascadedReplies).toBe(2)

    const row = db
      .prepare(`SELECT payload FROM events WHERE type = 'comment_deleted' ORDER BY id DESC LIMIT 1`)
      .get() as { payload: string }
    const payload = JSON.parse(row.payload) as {
      cascadedReplies: { body: string }[]
    }
    expect(payload.cascadedReplies.map((r) => r.body).sort()).toEqual(['回复一', '回复二'])
  })

  it('删不存在的评论不留痕（失败的删除不产生审计噪音）', async () => {
    await addTodo()
    const before = db
      .prepare(`SELECT COUNT(*) AS n FROM events WHERE type = 'comment_deleted'`)
      .get() as { n: number }

    const res = await run(['todo', 'delete-comment', '压根不存在的id', '--yes'])
    expect(res.ok).toBe(false)

    const after = db
      .prepare(`SELECT COUNT(*) AS n FROM events WHERE type = 'comment_deleted'`)
      .get() as { n: number }
    expect(after.n).toBe(before.n)
  })

  it('缺 --yes 直接报错（与 todo rm 同口径，不做交互式提问）', async () => {
    const id = await addTodo()
    const c = await run(['todo', 'comment', id, '--body', '写错了'])
    const commentId = (c.data as { commentId: string }).commentId

    const res = await run(['todo', 'delete-comment', commentId])
    expect(res.ok).toBe(false)
    expect(res.code).toBe(2)
    expect(res.message).toContain('--yes')
    // 报错时不能有副作用：评论还在
    expect(commentRepo.countByTodo(id)).toBe(1)
  })
})

/**
 * 删评论的授权分级（1.0.63，收 dbfbc553 选③）
 *
 * qwen 实测报的缺陷：删评论落在写档 —— 不要 `--yes`、不生成授权申请，
 * 调一次就物理删掉别人的驳回理由。多 agent 共用一块看板已是本机现实，
 * "任何一方能悄悄抹掉另一方的结论"就是这条缝的后果。
 *
 * 主用户的决策是选③**分级**：删自己写错的只需 `--yes`（不打扰人），
 * 删别人写的进删除档（逐次经人点头、绑定目标）。
 */
describe('删评论授权分级（1.0.63，dbfbc553 选③）', () => {
  /**
   * 凭据表（1.0.63 补）：非交互的写档命令**必须持证**才过门禁，
   * 光 register + setApproved 不够 —— 后者只解决"能不能写"，
   * 这一层还要求"这次调用确实是它发的"。少了凭据的 ctx 会让
   * `todo add` 直接以 credential_missing 被拒，seed 出来的 data 是 undefined，
   * 后面的断言就全变成 TypeError（本组初版就踩了这个坑）。
   */
  const creds = new Map<string, string>()
  beforeAll(() => {
    runMigrations(db)
    agentRepo.register({ id: 'agent:alice', displayName: 'Alice' })
    agentRepo.register({ id: 'agent:bob', displayName: 'Bob' })
    agentRepo.setApproved('agent:alice', true)
    agentRepo.setApproved('agent:bob', true)
    creds.set('agent:alice', agentRepo.issueCredential('agent:alice')!.token)
    creds.set('agent:bob', agentRepo.issueCredential('agent:bob')!.token)
  })

  beforeEach(() => {
    db.prepare('DELETE FROM todo_comments').run()
    db.prepare('DELETE FROM todo_transitions').run()
    db.prepare('DELETE FROM todo_categories').run()
    db.prepare('DELETE FROM todos').run()
    db.prepare('DELETE FROM agent_grants').run()
    db.prepare('DELETE FROM events').run()
    db.prepare('DELETE FROM projects').run()
    db.prepare('DELETE FROM categories').run()
    seq = 0
    projectRepo.create({ name: '测试项目' })
    categoryRepo.create({ name: '方向', color: '#1', sortOrder: 0 })
  })

  /**
   * 无人值守（agent）调用的 ctx：不给 interactive（门禁才会真的起作用），
   * 但要带上该身份的真实凭据 —— 否则连写档的 `todo add` 都过不去。
   */
  const runAs = (actor: string, args: string[]) =>
    executeOne({ ...ctx, actor, interactive: false, credential: creds.get(actor) } as never, args)

  /** 与 runAs 同源，只是 events 换真仓储（卡 69788c32：留痕要走去真表） */
  const runAsAudit = (actor: string, args: string[]) =>
    executeOne(
      {
        ...ctx,
        actor,
        interactive: false,
        credential: creds.get(actor),
        deps: { ...ctx.deps, events: new EventsRepository() }
      } as never,
      args
    )

  /** 建一条事项并让 alice 留一条评论，返回 todoId / 评论 id */
  const seedComment = async () => {
    const add = await runAs('agent:alice', [
      'todo', 'add', '--title', '一条事项', '--project', '测试项目', '--category', '方向'
    ])
    const todoId = (add.data as { id: string }).id
    const c = await runAs('agent:alice', ['todo', 'comment', todoId, '--body', '我写错了'])
    return { todoId, commentId: (c.data as { commentId: string }).commentId }
  }

  it('删自己写的：写档放行，只要带 --yes，不生成授权申请', async () => {
    const { todoId, commentId } = await seedComment()

    const res = await runAs('agent:alice', ['todo', 'delete-comment', commentId, '--yes'])
    expect(res.ok).toBe(true)
    expect(commentRepo.countByTodo(todoId)).toBe(0)
    expect(agentRepo.listGrants({ status: 'pending' })).toHaveLength(0)
  })

  it('删别人写的：被删除档拦下，并自动生成一条待表态申请', async () => {
    const { commentId } = await seedComment()

    const res = await runAs('agent:bob', ['todo', 'delete-comment', commentId, '--yes'])
    expect(res.ok).toBe(false)
    expect(res.code).toBe(4)
    expect(res.errorCode).toBe('grant_required')
    // 评论还在 —— 被拦下时不能有副作用
    expect(commentRepo.resolveId(commentId)).not.toBeNull()

    const pending = agentRepo.listGrants({ status: 'pending', activeOnly: true })
    expect(pending).toHaveLength(1)
    expect(pending[0].scope).toBe('destructive')
    expect(pending[0].agentId).toBe('agent:bob')
    // 目标必须绑在这条评论上：批的是"这一条"，不能顺手套到别的评论
    expect(pending[0].targetIds).toEqual([commentId])
  })

  it('摘要要说清删的是哪条、什么性质（人只凭命令名没法判断该不该批）', async () => {
    const { todoId, commentId } = await seedComment()
    // 把评论改成 reject（驳回理由）—— 这正是最该被保护的那一类
    db.prepare(`UPDATE todo_comments SET kind = 'reject' WHERE id = ?`).run(commentId)

    await runAs('agent:bob', ['todo', 'delete-comment', commentId, '--yes'])

    const pending = agentRepo.listGrants({ status: 'pending', activeOnly: true })[0]
    expect(pending.summary).toContain('验收驳回理由')
    expect(pending.summary).toContain('我写错了')
    expect(todoId).toBeTruthy()
  })

  it('目标的授权不能挪用到另一条评论上（v19 的教训）', async () => {
    const { todoId, commentId } = await seedComment()
    const other = await runAs('agent:alice', ['todo', 'comment', todoId, '--body', '另一条'])

    // 先让 bob 去删 alice 写的那条 → 被删除档拦下、落下一条绑定该评论的申请
    const first = await runAs('agent:bob', ['todo', 'delete-comment', commentId, '--yes'])
    expect(first.code).toBe(4)

    // 人批准"删这条"，然后拿那条授权去删另一条 —— 必须被拦
    const pending = agentRepo.listGrants({ status: 'pending', activeOnly: true })[0]
    expect(pending.targetIds).toEqual([commentId])
    agentRepo.resolveGrant(pending.id, true)

    const sneaky = await executeOne(
      {
        ...ctx,
        actor: 'agent:bob',
        interactive: false,
        preApprovedGrantId: pending.id
      } as never,
      ['todo', 'delete-comment', (other.data as { commentId: string }).commentId, '--yes']
    )
    expect(sneaky.ok).toBe(false)
    // 另一条评论必须还在 —— 拦下时不能有副作用
    expect(commentRepo.resolveId((other.data as { commentId: string }).commentId)).not.toBeNull()
  })

  it('解析不出的评论报 not_found，而不是报"你没权限"', async () => {
    const res = await runAs('agent:bob', ['todo', 'delete-comment', '不存在的评论', '--yes'])
    expect(res.ok).toBe(false)
    // 报"目标不存在"比"你没权限"准确 —— 后者会让 agent 去申请一次注定失败的授权
    expect(res.code).toBe(3)
    expect(agentRepo.listGrants({ status: 'pending' })).toHaveLength(0)
  })

  it('人（交互调用）删任何评论都不受分级影响', async () => {
    const { commentId } = await seedComment()

    const res = await run(['todo', 'delete-comment', commentId, '--yes'])
    expect(res.ok).toBe(true)
  })

  it('留痕里记下作者与种类（事后要能追"这条原本是谁写的"）', async () => {
    const { commentId } = await seedComment()

    await runAsAudit('agent:alice', ['todo', 'delete-comment', commentId, '--yes'])

    const row = db
      .prepare(`SELECT payload FROM events WHERE type = 'comment_deleted' ORDER BY id DESC LIMIT 1`)
      .get() as { payload: string }
    const payload = JSON.parse(row.payload) as {
      authorId: string
      kind: string
      deletedBy: string
    }
    expect(payload.authorId).toBe('agent:alice')
    expect(payload.kind).toBe('comment')
    expect(payload.deletedBy).toBe('agent:alice')
  })
})

/**
 * G9 软提醒（1.0.63，收 4bdfe62a 方案1）
 *
 * 1.0.54 立了规矩「验收必须落到状态上」，但只写在说明书里、机制一句不拦 ——
 * qwen 当场踩实：复验不通过只发了条评论，事项仍留在「待验收」，
 * 被主用户当场抓到。这道闸门把那条文字规矩变成一次回执里的提醒。
 */
describe('G9 软提醒：待验收上只写评论不落状态（1.0.63）', () => {
  beforeAll(() => {
    runMigrations(db)
    agentRepo.register({ id: 'agent:alice', displayName: 'Alice' })
    agentRepo.register({ id: 'agent:bob', displayName: 'Bob' })
  })

  beforeEach(() => {
    db.prepare('DELETE FROM todo_comments').run()
    db.prepare('DELETE FROM todo_transitions').run()
    db.prepare('DELETE FROM todo_categories').run()
    db.prepare('DELETE FROM todos').run()
    db.prepare('DELETE FROM projects').run()
    db.prepare('DELETE FROM categories').run()
    seq = 0
    projectRepo.create({ name: '测试项目' })
    categoryRepo.create({ name: '方向', color: '#1', sortOrder: 0 })
  })

  /** 建一条"提出者=qwen、执行者=alice"的卡，并推到「待验收」 */
  const seedAwaitingReview = async () => {
    const add = await executeOne(
      { ...ctx, actor: 'agent:bob' } as never,
      [
        'todo', 'add', '--title', '一条交付', '--project', '测试项目', '--category', '方向',
        '--created-by', 'agent:bob', '--executed-by', 'agent:alice'
      ]
    )
    const todoId = (add.data as { id: string }).id
    await executeOne({ ...ctx, actor: 'agent:alice' } as never, [
      'todo', 'update', todoId, '--status', 'awaiting_review'
    ])
    return todoId
  }

  it('验收方在待验收的卡上只留评论 → 回执顶层带 G9 提醒', async () => {
    const todoId = await seedAwaitingReview()

    const res = await executeOne(
      { ...ctx, actor: 'agent:bob' } as never,
      ['todo', 'comment', todoId, '--body', '复验：仍未通']
    )
    expect(res.ok).toBe(true)
    // 软提醒不改退出码、不在 data 里 —— 只在顶层 notice
    expect(res.notice).toContain('G9')
    expect(res.notice).toContain('todo reject')
    /**
     * ⚠️ 这里**曾经**断言提醒里有 `todo done`，1.0.65 改掉了（`6a316a45`）。
     *
     * 那是本产品自己造的一个自相矛盾：G9 的回执教验收方"通过用 `todo done <id>`"，
     * 而同一版本里 G10 硬拦 `awaiting_review → done`（退出码 4）。
     * 于是 agent 照着回执执行 → 立刻被拒 → **人点了允许，什么都没发生**
     * （Carol 10-05 实测）。根因是我加 G10 时没回头看 G9 的文案。
     *
     * 判据：**出口不许教一条会被守卫拒绝的命令。**
     * 所以现在断言的是"不再教它"，并且要求提醒**说清该改走哪条路** ——
     * 只把旧文案删掉等于让人无从下手。
     */
    expect(
      res.notice,
      'G9 提醒不得再教 todo done（G10 会拒它）—— 这是自相矛盾'
    ).not.toContain('todo done')
    expect(
      res.notice,
      '必须说清"通过要在界面上点"，否则删掉旧指引后 agent 无从下手'
    ).toMatch(/界面|由人|人点/)
  })

  it('执行方自己补说明不响（那不是在验收）', async () => {
    const todoId = await seedAwaitingReview()

    const res = await executeOne(
      { ...ctx, actor: 'agent:alice' } as never,
      ['todo', 'comment', todoId, '--body', '补充：还差一处边界']
    )
    expect(res.ok).toBe(true)
    expect(res.notice ?? '').not.toContain('G9')
  })

  it('不在「待验收」列的正常往来不响（误报面要窄）', async () => {
    const add = await executeOne(
      { ...ctx, actor: 'agent:bob' } as never,
      [
        'todo', 'add', '--title', '一条进行中的事', '--project', '测试项目', '--category', '方向',
        '--created-by', 'agent:bob', '--executed-by', 'agent:alice'
      ]
    )
    const todoId = (add.data as { id: string }).id

    const res = await executeOne(
      { ...ctx, actor: 'agent:bob' } as never,
      ['todo', 'comment', todoId, '--body', '问一下进度']
    )
    expect(res.ok).toBe(true)
    expect(res.notice ?? '').not.toContain('G9')
  })

  it('执行者口径取「执行者??提出者」：提出即执行的卡，别人来评论仍响', async () => {
    // 这条卡没有 executedBy（提出即执行 = 提出者自己干）
    const add = await executeOne(
      { ...ctx, actor: 'agent:alice' } as never,
      [
        'todo', 'add', '--title', '自己提自己干', '--project', '测试项目', '--category', '方向',
        '--created-by', 'agent:alice'
      ]
    )
    const todoId = (add.data as { id: string }).id
    await executeOne({ ...ctx, actor: 'agent:alice' } as never, [
      'todo', 'update', todoId, '--status', 'awaiting_review'
    ])

    const res = await executeOne(
      { ...ctx, actor: 'agent:bob' } as never,
      ['todo', 'comment', todoId, '--body', '验收：不通过']
    )
    expect(res.ok).toBe(true)
    expect(res.notice).toContain('G9')
  })

  it('落实了状态就没有 G9 —— 而且它本身应当是验收动作', async () => {
    const todoId = await seedAwaitingReview()

    const rej = await executeOne(
      { ...ctx, actor: 'agent:bob' } as never,
      ['todo', 'reject', todoId, '--reason', '边界没处理']
    )
    expect(rej.ok).toBe(true)
    // 状态真的退回进行中了
    expect(todoRepo.getById(todoId)!.status).toBe('in_progress')
  })
})

describe('todo get 带出评论线程（1.0.54：一条调用拿全上下文）', () => {
  beforeAll(() => {
    runMigrations(db)
    agentRepo.register({ id: 'agent:alice', displayName: 'Alice' })
  })

  beforeEach(() => {
    db.prepare('DELETE FROM todo_comments').run()
    db.prepare('DELETE FROM todo_transitions').run()
    db.prepare('DELETE FROM todo_categories').run()
    db.prepare('DELETE FROM todos').run()
    db.prepare('DELETE FROM projects').run()
    db.prepare('DELETE FROM categories').run()
    seq = 0
    projectRepo.create({ name: '测试项目' })
    categoryRepo.create({ name: '方向', color: '#1', sortOrder: 0 })
  })

  it('描述与评论一起返回，且分得清哪是规格、哪是往来', async () => {
    const add = await run([
      'todo', 'add', '--title', '一条事项', '--project', '测试项目', '--category', '方向',
      '--desc', '这是规格'
    ])
    const id = (add.data as { id: string }).id
    await run(['todo', 'comment', id, '--body', '这是往来'])

    const res = await run(['todo', 'get', id])
    expect(res.ok).toBe(true)
    const data = res.data as { description: string; comments: { body: string; kind: string }[] }
    expect(data.description).toBe('这是规格')
    expect(data.comments).toHaveLength(1)
    expect(data.comments[0].body).toBe('这是往来')
    expect(data.comments[0].kind).toBe('comment')
  })

  it('没有评论时 comments 是空数组（不是 undefined，调用方不用额外判空）', async () => {
    const add = await run([
      'todo', 'add', '--title', '一条事项', '--project', '测试项目', '--category', '方向'
    ])
    const id = (add.data as { id: string }).id

    const res = await run(['todo', 'get', id])
    expect((res.data as { comments: unknown[] }).comments).toEqual([])
  })
})

/**
 * G8 漂移提醒的取数来源（1.0.57，Bob 52b6b726 驳回）
 *
 * 这一组测的不是"提醒怎么显示"，而是**值从哪来** —— 那才是当初错的地方。
 *
 * 背景：G8 原先在命令实现里直接读 `process.env.DESKPARTNER_SKILL_VERSION`。
 * 走管道时命令跑在**常驻 GUI 进程**里，它读的是 GUI 的环境，
 * 调用方 shell 里的声明根本看不见 → GUI 一开着提醒就恒不触发，
 * 反倒是 `DESKPARTNER_NO_PIPE=1`（无头，服务端就是调用方的子进程）正常。
 * Bob的实测就是这么来的：同一份声明，两条通道行为不一致。
 *
 * 修法是把值提升为 `ctx.skillVersion`，由启动器带进请求体，
 * 两条通道各自在入口把值填好，命令实现只认 ctx。
 *
 * 所以这里的关键断言是反过来的：**明明进程环境里声明了旧版本，也不该有提醒**
 * —— 命令如果又偷偷回去读 env，说明"来源统一"这件事没做到，一旦重构就复发
 * （"声明了却不生效"是这类缺陷的通病，Bob因此连错四轮）。
 */
describe('G8 说明书漂移提醒只认 ctx.skillVersion（1.0.57 修 52b6b726）', () => {
  const ctxV57 = {
    ...ctx,
    meta: { ...ctx.meta, version: '1.0.57' }
  }

  /** 用指定 ctx 跑一条读命令，取出回执里的 notice */
  async function noticeOf(context: unknown, args: string[]) {
    const res = await executeOne(context as never, args)
    return (res as { notice?: string }).notice
  }

  /**
   * 提醒里不许再出现裸的 `dp skill`（卡 `cb7924c2`，1.0.133）：本机没有 `dp` 这条命令，
   * 那句提醒等于让对方照抄一条跑不通的命令 —— 与 1.0.132 修入口提示词同源。
   * 按 surface 分流：命令行给 `node "$DESKPARTNER_CLI" skill`，MCP 指向 `get_guide`。
   */
  it('说明书过期 → 提醒里给的是能跑的写法，不是不存在的 dp skill', async () => {
    const notice = await noticeOf({ ...ctxV57, skillVersion: '1.0.50' }, ['schema'])
    expect(notice).toBeTruthy()
    expect(notice).toContain('1.0.50')
    expect(notice).toContain('1.0.57')
    expect(notice).toContain('node "$DESKPARTNER_CLI" skill')
    expect(notice).not.toMatch(/\bdp (skill|todo|project|agent|schema|help)/)
  })

  it('MCP 调用方的说明书过期提醒指向 get_guide，而不是命令行', async () => {
    const notice = await noticeOf({ ...ctxV57, skillVersion: '1.0.50', surface: 'mcp' }, ['schema'])
    expect(notice).toBeTruthy()
    expect(notice).toContain('get_guide')
    expect(notice).not.toContain('DESKPARTNER_CLI')
  })

  it('版本相同或更新 → 不提醒（用旧说明书不算错，只是可能过期）', async () => {
    expect(await noticeOf({ ...ctxV57, skillVersion: '1.0.57' }, ['schema'])).toBeUndefined()
    expect(await noticeOf({ ...ctxV57, skillVersion: '1.0.99' }, ['schema'])).toBeUndefined()
  })

  it('没声明版本 → 不提醒', async () => {
    expect(await noticeOf(ctxV57, ['schema'])).toBeUndefined()
  })

  it('进程环境里声明了旧版本也不生效 —— 值只能从 ctx 来', async () => {
    const saved = process.env.DESKPARTNER_SKILL_VERSION
    process.env.DESKPARTNER_SKILL_VERSION = '1.0.00'
    try {
      // ctx 没带 → 必须没有提醒。若这里失败，说明命令又回头读了全局环境，
      // 则管道路径下"时灵时不灵"的老毛病会原样复发。
      expect(await noticeOf(ctxV57, ['schema'])).toBeUndefined()
      // ctx 带了 → 以 ctx 为准，不看环境
      const notice = await noticeOf({ ...ctxV57, skillVersion: '1.0.50' }, ['schema'])
      expect(notice).toContain('1.0.50')
      expect(notice).not.toContain('1.0.00')
    } finally {
      if (saved === undefined) delete process.env.DESKPARTNER_SKILL_VERSION
      else process.env.DESKPARTNER_SKILL_VERSION = saved
    }
  })
})

/**
 * 「解决于版本」（v24，主用户 2026-09-29）
 *
 * 她提的两个问题 ——「当前版本准备处理哪些」/「发布后具体解决了哪些」——
 * 落成 CLI 就是 `--fixed-in` 的读写两侧。这一组把两侧都锁住：
 * 写得进（add/update）、读得出（list 回带 + 三档筛选）。
 */
describe('todo --fixed-in（v24：事项与版本的映射）', () => {
  beforeAll(() => {
    runMigrations(db)
  })

  /**
   * 本文件的外键是**开着的**（与 todo.repository.test.ts 不同，那边显式关了）。
   * 所以这里必须建真分类，不能用 'cat-1' 这种占位 id —— 会撞 FK。
   * 项目也要预建：`todo add --project` 找不到项目会报错（1.0.40 起不静默新建）。
   */
  let catId = ''
  beforeEach(() => {
    db.prepare('DELETE FROM todo_categories').run()
    db.prepare('DELETE FROM todos').run()
    db.prepare('DELETE FROM projects').run()
    db.prepare('DELETE FROM categories').run()
    seq = 0
    projectRepo.create({ name: '测试项目' })
    catId = categoryRepo.create({ name: '测试分类', color: '#5388F6', sortOrder: 0 }).id
  })

  it('add --fixed-in 标版本，list 回带该字段', async () => {
    await run([
      'todo', 'add', '--title', '补录的历史条目',
      '--project', '测试项目', '--fixed-in', '1.0.50'
    ])
    const res = await run(['todo', 'list'])
    const row = (res.data as Array<{ fixedInVersion: string | null }>)[0]
    expect(row.fixedInVersion).toBe('1.0.50')
  })

  it('update --fixed-in 标版本；不传该参数时保持原值', async () => {
    const t = todoRepo.create({ title: 'A', categoryIds: [catId] })
    await run(['todo', 'update', t.id, '--fixed-in', '1.0.59'])
    expect(todoRepo.getById(t.id)!.fixedInVersion).toBe('1.0.59')

    // 改标题不该顺手把版本号抹掉 —— 这是三态语义的回归点
    await run(['todo', 'update', t.id, '--title', '改了标题'])
    expect(todoRepo.getById(t.id)!.fixedInVersion).toBe('1.0.59')
  })

  it('update --fixed-in clear 清掉标注（标错了要能回退）', async () => {
    const t = todoRepo.create({ title: 'A', categoryIds: [catId] })
    await run(['todo', 'update', t.id, '--fixed-in', '1.0.59'])
    await run(['todo', 'update', t.id, '--fixed-in', 'clear'])
    expect(todoRepo.getById(t.id)!.fixedInVersion).toBeNull()
  })

  it('update --fixed-in unset/any 被挡下并指路（那是 list 侧的关键字）', async () => {
    // 不挡的话库里会出现一个名字叫 "unset" 的版本号，
    // 之后按版本筛选时下拉里冒出一个谁也看不懂的选项
    const t = todoRepo.create({ title: 'A', categoryIds: [catId] })
    const r = await run(['todo', 'update', t.id, '--fixed-in', 'unset'])
    expect(r.ok).toBe(false)
    expect(String(r.message)).toMatch(/list 侧/)
    expect(todoRepo.getById(t.id)!.fixedInVersion).toBeNull()
  })

  it('list --fixed-in 三档：版本号 / unset / any', async () => {
    const a = todoRepo.create({ title: '标 1.0.58', categoryIds: [catId] })
    const b = todoRepo.create({ title: '标 1.0.59', categoryIds: [catId] })
    todoRepo.create({ title: '没标', categoryIds: [catId] })
    await run(['todo', 'update', a.id, '--fixed-in', '1.0.58'])
    await run(['todo', 'update', b.id, '--fixed-in', '1.0.59'])

    const titles = async (flag: string) =>
      (await run(['todo', 'list', '--fixed-in', flag])).data as Array<{ title: string }>

    expect((await titles('1.0.59')).map((t) => t.title)).toEqual(['标 1.0.59'])
    expect((await titles('unset')).map((t) => t.title)).toEqual(['没标'])
    expect((await titles('any')).map((t) => t.title).sort()).toEqual(['标 1.0.58', '标 1.0.59'])
  })

  it('list --fixed-in 空串报 usage_error，不静默返回全部', async () => {
    // 静默返回全部 = 人以为筛过了，实际看的是全量
    const r = await run(['todo', 'list', '--fixed-in', ''])
    expect(r.ok).toBe(false)
  })
})

/**
 * 读命令默认形态（1.0.63）
 *
 * 这一组钉的是**默认值**，不是某个参数 —— 默认值最容易被后人"顺手改回去"，
 * 而它决定的恰恰是 agent 每轮第一件事看到什么。
 *
 * 背景（S2 场景，实测于 1.0.62）：裸 `todo list` 一次回 400 条 / 476KB，
 * 其中 73% 是 done；调用方只能拉回来自己按状态分组。默认口径与"给 uuid 不给名字"、
 * "执行者不可筛"合起来，构成"agent 用共享看板"最主要的摩擦。
 */
describe('todo list 读形态（1.0.63）', () => {
  beforeAll(() => {
    runMigrations(db)
    agentRepo.register({ id: 'agent:alice', displayName: 'Alice' })
  })

  beforeEach(() => {
    db.prepare('DELETE FROM todo_categories').run()
    db.prepare('DELETE FROM memos').run()
    db.prepare('DELETE FROM todos').run()
    db.prepare('DELETE FROM projects').run()
    db.prepare('DELETE FROM categories').run()
    seq = 0
    projectRepo.create({ name: '测试项目' })
    categoryRepo.create({ name: '方向', color: '#1', sortOrder: 0 })
  })

  /** 建一条指定状态的待办，返回 id */
  function seedWithStatus(title: string, status: Parameters<typeof todoRepo.create>[0]['status']) {
    return todoRepo.create({ title, categoryIds: [], status }).id
  }

  it('默认只回未完成的：done 不出现在裸 list 里', async () => {
    seedWithStatus('没做的', 'todo')
    seedWithStatus('做完了的', 'done')

    const res = await run(['todo', 'list'])
    const titles = (res.data as Array<{ title: string }>).map((t) => t.title)

    expect(titles).toContain('没做的')
    expect(titles).not.toContain('做完了的')
  })

  it('要看全量必须显式 --status any（默认收窄是可找回的，不是丢数据）', async () => {
    seedWithStatus('没做的', 'todo')
    seedWithStatus('做完了的', 'done')

    const res = await run(['todo', 'list', '--status', 'any'])
    const titles = (res.data as Array<{ title: string }>).map((t) => t.title)

    // 中文串的默认排序是码点序，"做"在"没"前 —— 与语言习惯相反，
    // 所以两边都用 sort() 而不是写死字面顺序
    expect(titles.sort()).toEqual(['做完了的', '没做的'].sort())
  })

  it('--status 支持逗号多值（此前只收单值，"待办+进行中"表达不了）', async () => {
    seedWithStatus('待办', 'todo')
    seedWithStatus('进行中', 'in_progress')
    seedWithStatus('待验收', 'awaiting_review')

    const res = await run(['todo', 'list', '--status', 'todo,in_progress'])
    const titles = (res.data as Array<{ title: string }>).map((t) => t.title)

    expect(titles.sort()).toEqual(['待办', '进行中'].sort())
  })

  it('多值里的非法值照样被拦（不能因为拼进逗号里就绕过校验）', async () => {
    const r = await run(['todo', 'list', '--status', 'todo,乱写的'])
    expect(r.ok).toBe(false)
    expect(r.errorCode).toBe('usage_error')
  })

  it('unfinished 显式写出来与默认一致；unfinished 在写命令侧非法', async () => {
    const id = seedWithStatus('没做的', 'todo')
    seedWithStatus('做完了的', 'done')

    const explicit = await run(['todo', 'list', '--status', 'unfinished'])
    expect((explicit.data as unknown[]).length).toBe(1)

    // 写命令不认 unfinished —— 它不是一个能落地的状态
    const w = await run(['todo', 'update', id, '--status', 'unfinished'])
    expect(w.ok).toBe(false)
    expect(w.errorCode).toBe('usage_error')
  })

  it('--search 也搜描述（此前只搜标题，凭描述里的词搜不到 → 误判"没登记过"）', async () => {
    todoRepo.create({ title: '标题里没有那个词', description: '描述里有 治理 二字', categoryIds: [] })
    todoRepo.create({ title: '无关的一条', description: null, categoryIds: [] })

    const res = await run(['todo', 'list', '--search', '治理'])
    expect((res.data as Array<{ title: string }>).map((t) => t.title)).toEqual(['标题里没有那个词'])
  })

  it('--executed-by 可筛（此前执行者是唯一读不出来的维度）', async () => {
    todoRepo.create({ title: '指派给 alice', categoryIds: [], executedBy: 'agent:alice' })
    todoRepo.create({ title: '提即执行', categoryIds: [], executedBy: null })
    todoRepo.create({ title: '指派给 user', categoryIds: [], executedBy: 'human' })

    const mine = await run(['todo', 'list', '--executed-by', 'agent:alice'])
    expect((mine.data as Array<{ title: string }>).map((t) => t.title)).toEqual(['指派给 alice'])

    const unset = await run(['todo', 'list', '--executed-by', 'unset'])
    expect((unset.data as Array<{ title: string }>).map((t) => t.title)).toEqual(['提即执行'])
  })

  it('回执同时给 id 与可读名（agent 拿到 uuid 既读不懂也回填不了别的命令）', async () => {
    const cat = categoryRepo.list().find((c) => c.name === '方向')!
    const proj = projectRepo.list().find((p) => p.name === '测试项目')!
    todoRepo.create({ title: '带关联的', categoryIds: [cat.id], projectId: proj.id })

    const res = await run(['todo', 'list', '--search', '带关联的'])
    const row = (res.data as Array<Record<string, unknown>>)[0]

    expect(row.projectId).toBe(proj.id)
    expect(row.projectName).toBe('测试项目')
    expect(row.categoryIds).toEqual([cat.id])
    expect(row.categoryNames).toEqual(['方向'])
    // updatedAt 也必须带上：--updated-since 与"这轮动了哪些"都靠它
    expect(typeof row.updatedAt).toBe('string')
  })

  it('--updated-since 按改动时间筛', async () => {
    const id = seedWithStatus('刚动的', 'todo')
    todoRepo.update({ id, title: '刚动的（改过）' })

    const now = new Date()
    const yesterday = new Date(now.getTime() - 86_400_000)
    /**
     * 🚨 必须按**本地时区**截日期，不能用 `toISOString().slice(0,10)`（2026-10-01 修）。
     *
     * 产品的 `--updated-since 2026-10-01` 语义是**本地时区的当天 00:00**
     * （commands.ts 里把裸日期补成 `${raw}T00:00:00`，由 Date.parse 按本地时区解释）。
     * 而 `toISOString()` 给的是 **UTC 日期** —— 东八区在北京时间 00:00~08:00 这段，
     * UTC 还停在前一天，两者差一天。
     *
     * 症状：这个用例**只在深夜（本地 00:00~08:00）跑才会红**，
     * 白天的 CI 全绿，于是看起来像"偶发"而不是"必然错"。
     * 断言里那句 `--updated-since <明天>` 应为空，会因差一天而把刚建的条目筛进来。
     */
    const iso = (d: Date) => {
      const p = (n: number) => String(n).padStart(2, '0')
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
    }

    const since = await run(['todo', 'list', '--updated-since', iso(yesterday)])
    expect((since.data as Array<{ title: string }>).map((t) => t.title)).toEqual(['刚动的（改过）'])

    const future = new Date(now.getTime() + 86_400_000)
    const none = await run(['todo', 'list', '--updated-since', iso(future)])
    expect((none.data as unknown[]).length).toBe(0)
  })

  it('--sort 只在显式传时生效，默认顺序不动（置顶优先）', async () => {
    const a = todoRepo.create({ title: '普通', categoryIds: [] })
    const b = todoRepo.create({ title: '置顶', categoryIds: [], isPinned: true })

    const def = await run(['todo', 'list'])
    expect((def.data as Array<{ title: string }>)[0].title).toBe('置顶')

    // 同一毫秒创建时 createdAt 相同 → 按创建时间排序退化、不可判；
    // 这里只断言 pinned 下置顶在前，并确认两个 id 不同（不是同一条被读了两次）
    expect(a.id).not.toBe(b.id)
  })

  it('--sort due：截止近的在前，没设截止的沉底', async () => {
    const now = Date.now()
    const iso = (offsetDays: number) => new Date(now + offsetDays * 86_400_000).toISOString()
    // 故意用与"截止远近"相反的顺序创建，避免"恰好按创建序"造成假通过
    todoRepo.create({ title: '后到期', categoryIds: [], dueAt: iso(5) })
    todoRepo.create({ title: '没截止', categoryIds: [], dueAt: null })
    todoRepo.create({ title: '先到期', categoryIds: [], dueAt: iso(1) })

    const res = await run(['todo', 'list', '--sort', 'due'])
    expect((res.data as Array<{ title: string }>).map((t) => t.title)).toEqual([
      '先到期',
      '后到期',
      '没截止'
    ])
  })

  it('--limit 截断时**显式说明**（静默截断会让调用方以为"就这么多"）', async () => {
    for (let i = 0; i < 5; i++) seedWithStatus(`第 ${i} 条`, 'todo')

    const cut = await run(['todo', 'list', '--limit', '2'])
    expect((cut.data as unknown[]).length).toBe(2)
    expect(String(cut.notice ?? '')).toContain('截断')

    // 不截断时不留噪声
    const full = await run(['todo', 'list', '--limit', '50'])
    expect(String(full.notice ?? '')).not.toContain('截断')
  })

  it('裸 todo list 默认最多返回 20 条，并通过 meta 告知还有更多', async () => {
    for (let i = 0; i < 21; i++) seedWithStatus(`默认上限 ${i}`, 'todo')

    const result = await run(['todo', 'list'])
    expect((result.data as unknown[]).length).toBe(20)
    expect(result.meta).toMatchObject({ matched: 21, returned: 20, truncated: true })
    expect(String(result.notice ?? '')).toContain('--limit 20')
  })

  it('--limit 0 保留显式全量读取能力', async () => {
    for (let i = 0; i < 21; i++) seedWithStatus(`显式全量 ${i}`, 'todo')

    const result = await run(['todo', 'list', '--limit', '0'])
    expect((result.data as unknown[]).length).toBe(21)
    expect(result.meta).toMatchObject({ matched: 21, returned: 21, truncated: false })
  })

  /**
   * 计数摘要走顶层 meta（1.0.63，18f25c17 第 4 项）
   *
   * 此前 agent 要"看板全貌"得把整批拉回来自己 for 一遍分类，对不许算数的模型
   * 就是白给。改法是直接给数字，但**必须放顶层 meta**：
   * 一旦改成 `data: {items, total}`，所有按数组解析的调用方（脚本 `for row in data`、
   * 宿主按 list 取值）会静默拿到一个对象 —— 不报错、遍历为空，比报错更难查。
   * 所以第一条断言就是 `Array.isArray(data)`。
   */
  it('计数摘要走顶层 meta（matched/returned/byStatus），data 仍是数组', async () => {
    seedWithStatus('待办一', 'todo')
    seedWithStatus('待办二', 'todo')
    seedWithStatus('进行中', 'in_progress')
    seedWithStatus('做完了的', 'done')

    const res = await run(['todo', 'list', '--status', 'any'])
    // 这是本设计唯一不能退让的一条：data 必须继续是数组
    expect(Array.isArray(res.data)).toBe(true)

    const meta = res.meta as {
      matched: number
      returned: number
      truncated: boolean
      byStatus: Record<string, number>
    }
    expect(meta.matched).toBe(4)
    expect(meta.returned).toBe(4)
    expect(meta.truncated).toBe(false)
    expect(meta.byStatus).toEqual({ todo: 2, in_progress: 1, done: 1 })
  })

  it('默认口径下 meta 只统计未完成集，--status any 才给全库分布', async () => {
    seedWithStatus('没做的', 'todo')
    seedWithStatus('做完了的', 'done')

    const def = await run(['todo', 'list'])
    expect((def.meta as { matched: number }).matched).toBe(1)

    const all = await run(['todo', 'list', '--status', 'any'])
    expect((all.meta as { matched: number }).matched).toBe(2)
    expect((all.meta as { byStatus: Record<string, number> }).byStatus).toEqual({ todo: 1, done: 1 })
  })

  it('截断时 meta 同时给 matched 与 returned（不靠数数组长度推"还有没有"）', async () => {
    for (let i = 0; i < 5; i++) seedWithStatus(`第 ${i} 条`, 'todo')

    const cut = await run(['todo', 'list', '--limit', '2'])
    const meta = cut.meta as { matched: number; returned: number; truncated: boolean }
    expect(meta.matched).toBe(5)
    expect(meta.returned).toBe(2)
    expect(meta.truncated).toBe(true)
    // 截断时 data 仍是数组，只是变短
    expect(Array.isArray(cut.data)).toBe(true)
    expect((cut.data as unknown[]).length).toBe(2)
  })

  /**
   * 信封层的判据：agent/脚本真正 parse 的是 formatOutcome 的 stdout，
   * 不是 executeOne 的返回值。所以"meta 在顶层、data 还是数组"必须在这一层
   * 也被钉住 —— 否则内部修对了、出口又拼错，调用方照样拿到对象。
   */
  it('JSON 信封里 meta 在顶层，data 仍是数组（老调用方零影响）', async () => {
    seedWithStatus('一条', 'todo')
    const outcome = await run(['todo', 'list'])
    const { formatOutcome } = await import('../../../src/main/cli/output')
    const res = formatOutcome(outcome as never, ['todo', 'list'], false) // false = 非 TTY → JSON
    const envelope = JSON.parse(res.stdout) as Record<string, unknown>

    expect(Array.isArray(envelope.data)).toBe(true)
    expect(envelope.meta).toBeTruthy()
    expect((envelope.meta as { matched: number }).matched).toBe(1)
  })

  it('改名/改状态的字段变化即时反映到下一次读（updatedAt 真的在动）', async () => {
    const id = seedWithStatus('原名', 'todo')
    const before = (await run(['todo', 'list'])).data as Array<{ id: string; updatedAt: string }>
    const t0 = before.find((t) => t.id === id)!.updatedAt

    await new Promise((r) => setTimeout(r, 5))
    await run(['todo', 'update', id, '--title', '改名了'])

    const after = (await run(['todo', 'list'])).data as Array<{ id: string; updatedAt: string }>
    const t1 = after.find((t) => t.id === id)!.updatedAt
    expect(Date.parse(t1)).toBeGreaterThan(Date.parse(t0))
  })
})

/**
 * 未读摘要搭写命令回执的便车（1.0.63）
 *
 * 核心判据是「**不依赖使用方自觉**」：此前只有主动跑 `memo list --unread` /
 * `todo list --executed-by <自己>` 才看得到这些，而实测只读命令的回执里
 * 根本没有 notice 字段 —— 也就是"扫一遍"全靠 agent 记得（S5 场景）。
 * 改法是把它送到**必经之路**（任何写命令的回执）上，一动手就撞见。
 */
describe('写命令回执里的未读摘要（1.0.63）', () => {
  beforeAll(() => {
    runMigrations(db)
    agentRepo.register({ id: 'agent:alice', displayName: 'Alice' })
  })

  beforeEach(() => {
    db.prepare('DELETE FROM todo_categories').run()
    db.prepare('DELETE FROM memos').run()
    db.prepare('DELETE FROM todos').run()
    db.prepare('DELETE FROM projects').run()
    db.prepare('DELETE FROM categories').run()
    seq = 0
    projectRepo.create({ name: '测试项目' })
    categoryRepo.create({ name: '方向', color: '#1', sortOrder: 0 })
  })

  /**
   * 用**持证**的 agent 身份跑写命令。
   *
   * 为什么必须持证：1.0.35 起非交互写命令要过调用方门禁，"agent 声称自己是谁"
   * 不够，得有凭据。不持证时命令会被拦在门禁处（exit 4），根本执行不到
   * 回执拼装那一步 —— 那样测的就不是摘要，是门禁了。
   * （这个坑本文件开头已记过一次：mock 漏了文件系统那层，凭据被写进真实磁盘。）
   */
  const writeCtx = () => {
    const { token } = agentRepo.issueCredential('agent:alice')!
    return { ...ctx, actor: 'agent:alice', interactive: false, credential: token } as never
  }
  const writeArgs = (title: string) => [
    'todo', 'add', '--title', title, '--category', '方向', '--project', '测试项目'
  ]

  it('有未读纸条时，写命令回执带一条摘要（不查也能看见）', async () => {
    memoRepo.create({ author: 'agent:bob', text: '留个纸条：这个坑我踩过' })

    const res = await executeOne(writeCtx(), writeArgs('x'))
    expect(res.ok).toBe(true)
    expect(String(res.notice ?? '')).toContain('未读纸条')
    expect(String(res.notice ?? '')).toContain('memo list --unread')
  })

  it('分派给我的待办也进摘要（executedBy 指向我）', async () => {
    todoRepo.create({
      title: '这条分给我了',
      categoryIds: [],
      executedBy: 'agent:alice'
    })

    const res = await executeOne(writeCtx(), writeArgs('y'))
    expect(String(res.notice ?? '')).toContain('指派给你')
    expect(String(res.notice ?? '')).toContain('这条分给我了')
  })

  it('没有未读时不留噪声（摘要只在有事时出现）', async () => {
    const t = todoRepo.create({ title: '别人的规格', categoryIds: [], createdBy: 'human' })
    const res = await executeOne(writeCtx(), ['todo', 'update', t.id, '--title', '补充规格'])
    expect(String(res.notice ?? '')).not.toContain('未读纸条')
    expect(String(res.notice ?? '')).not.toContain('指派给你')
  })

  it('被退回又分派给我的卡，只在一段摘要里点名（同一张卡不说两遍）', async () => {
    // 实测发现的重复：被退回的卡本来就满足「executedBy=我 且未 done」，
    // 于是驳回块和指派块各点名一次；一段回执里同一张卡写两遍白占上下文。
    const t = todoRepo.create({
      title: '退回后又归我的卡',
      categoryIds: [],
      executedBy: 'agent:alice',
      status: 'awaiting_review'
    })
    todoRepo.update({ id: t.id, status: 'in_progress', actor: 'agent:alice' })
    // 造一条 awaiting_review → in_progress 的流转 + 对应的 reject 评论。
    // ⚠️ 两条都要：判据是「流转 + reject 评论」两件套（2026-10-01 修正），
    // 只造流转不再算被退回 —— 那正是执行方自己收回的样子。
    db.prepare(
      `INSERT INTO todo_transitions (id, todo_id, from_status, to_status, actor, created_at)
       VALUES ('tr-reject-1', ?, 'awaiting_review', 'in_progress', 'agent:alice', ?)`
    ).run(t.id, new Date().toISOString())
    commentRepo.create({
      todoId: t.id,
      body: '退回来重做',
      authorType: 'agent',
      authorId: 'agent:bob',
      kind: 'reject'
    })

    const res = await executeOne(writeCtx(), writeArgs('dup'))
    const notice = String(res.notice ?? '')
    // 被驳回块点名了它
    expect(notice).toContain('退回')
    expect(notice).toContain('退回后又归我的卡')
    // 指派块不再重复点名 —— 出现次数恰为 1
    expect(notice.split('退回后又归我的卡').length - 1).toBe(1)
  })

  it('纸条的归属如实显示 author，不掩盖"作者被写成收件人"这件事', async () => {
    // memo add --owner 会把 author 覆盖成传入的值（qwen 已登记为独立缺陷）。
    // 这里只钉"摘要如实呈现 author"，不假装它是对的。
    await run(['memo', 'add', '--text', '给人看的纸条', '--owner', 'agent:alice'])
    const memo = memoRepo.list()[0]
    expect(
      memo.author,
      '1.0.68 起 --owner 是收件人别名；author 应是**调用者身份**（与 todo add 同一套归因）'
    ).not.toBe('agent:alice')
    expect(memo.recipient, '收件人记在 recipient 上').toBe('agent:alice')
    expect(memo.text).toBe('给人看的纸条')
  })

  it('同一会话相同提醒压缩，待处理数量变化时重新展开', async () => {
    db.prepare('DELETE FROM cli_reminder_receipts').run()
    todoRepo.create({ title: '待执行', categoryIds: [], executedBy: 'agent:alice' })
    const other = todoRepo.create({ title: '规格', categoryIds: [], createdBy: 'human' })
    const sessionCtx = { ...(writeCtx() as object), session: 'reminder-test' }
    const args = ['todo', 'update', other.id, '--title', '规格补充']
    const first = await executeOne(sessionCtx as never, args)
    const second = await executeOne(sessionCtx as never, args)
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    expect(first.notice).toContain('指派给你')
    expect(second.notice ?? '').not.toContain('指派给你')
    todoRepo.create({ title: '第二件', categoryIds: [], executedBy: 'agent:alice' })
    const changed = await executeOne(sessionCtx as never, args)
    expect(changed.notice).toContain('有 2 条')
  })

  it('ack-mine 仅知晓本人本次返回的通知，不越过 limit 或修改全局已读', async () => {
    db.prepare('DELETE FROM notifications').run()
    for (let i = 0; i < 3; i++) notificationRepo.create({
      type: 'memo', title: `给我-${i}`, recipient: 'agent:alice'
    })
    const other = notificationRepo.create({ type: 'memo', title: '给别人', recipient: 'agent:other' })
    const r = await executeOne(writeCtx(), ['notification', 'list', '--ack-mine', '--limit', '1'])
    expect(r.ok).toBe(true)
    expect((r.data as { notifications: unknown[] }).notifications).toHaveLength(1)
    const all = notificationRepo.list(100)
    expect(all.filter((n) => n.readBy?.includes('agent:alice'))).toHaveLength(1)
    expect(all.find((n) => n.id === other.id)?.readBy).not.toContain('agent:alice')
    expect(all.every((n) => n.status === 'unread')).toBe(true)
  })

  it('只剩已完成/已挂起的指派时不响（不然摘要永远消不掉）', async () => {
    todoRepo.create({
      title: '分给我但已完成的',
      categoryIds: [],
      executedBy: 'agent:alice',
      status: 'done'
    })

    const t = todoRepo.create({ title: '别人的规格', categoryIds: [], createdBy: 'human' })
    const res = await executeOne(writeCtx(), ['todo', 'update', t.id, '--title', '补充规格'])
    expect(String(res.notice ?? '')).not.toContain('指派给你')
  })
})

/**
 * 接手说明修订历史的命令层契约（36b44adb）
 *
 * 「参数收下了没传下去」只长在这一层：--limit / --revision 收下后必须真的落到仓储，
 * 回滚的调用身份必须真的记进修订作者，未知参数必须被拒（args 声明）。
 */
describe('project handoff-history / handoff-revision / handoff-rollback 命令层契约', () => {
  let projectId: string

  beforeEach(() => {
    db.exec(`
      DELETE FROM todo_comments;
      DELETE FROM todo_transitions;
      DELETE FROM todo_categories;
      DELETE FROM todos;
      DELETE FROM project_handoff_proposals;
      DELETE FROM project_handoff_revisions;
      DELETE FROM projects;
    `)
    projectId = projectRepo.create({ name: '修订命令项目' }).id
    projectRepo.saveHandoff(projectId, '第一版', 'human')
    projectRepo.saveHandoff(projectId, '第二版', 'agent:alice')
    projectRepo.saveHandoff(projectId, '第三版', 'human')
    ;(ctx.deps.events.append as ReturnType<typeof vi.fn>).mockClear()
  })

  it('命令表里三条都声明了 args，且读写档位正确（read / read / write）', async () => {
    const { commands, riskOf } = await import('../../../src/main/cli/commands')
    const byName = (n: string) => commands.find((c) => c.name === n)!
    expect(riskOf(byName('project handoff-history'))).toBe('read')
    expect(riskOf(byName('project handoff-revision'))).toBe('read')
    expect(riskOf(byName('project handoff-rollback'))).toBe('write')
    expect(byName('project handoff-history').args.map((a) => a.flag)).toEqual(['--limit'])
    expect(byName('project handoff-revision').args.map((a) => a.flag)).toEqual(['--revision'])
    expect(byName('project handoff-rollback').args.map((a) => a.flag)).toEqual(['--revision'])
  })

  it('handoff-propose：agent 提议不会直接覆盖接手说明，且可读取待处理记录', async () => {
    const agentCtx = { ...ctx, actor: 'agent:alice' }
    const created = await executeOne(agentCtx as never, [
      'project', 'handoff-propose', projectId, '--body', 'Agent 建议的新说明'
    ])
    expect(created.ok).toBe(true)
    expect(projectRepo.getById(projectId)?.handoffMarkdown).toBe('第三版')
    const proposals = projectRepo.listHandoffProposals()
    expect(proposals).toHaveLength(1)
    expect(proposals[0]).toMatchObject({
      body: 'Agent 建议的新说明', originalBody: '第三版', proposer: 'agent:alice', status: 'pending'
    })

    const listed = await executeOne(agentCtx as never, ['project', 'handoff-proposals'])
    expect(listed.ok).toBe(true)
    expect((listed.data as unknown[])).toHaveLength(1)
  })

  it('handoff-update：agent 即使传了基准修订也不能绕过审批；主用户仍可直接保存', async () => {
    const agentCtx = { ...ctx, actor: 'agent:alice' }
    const blocked = await executeOne(agentCtx as never, [
      'project', 'handoff-update', projectId, '--body', '不应直接生效', '--expected-revision', '3'
    ])
    expect(blocked.ok).toBe(false)
    expect(String(blocked.message)).toContain('project handoff-propose')
    expect(projectRepo.getById(projectId)?.handoffMarkdown).toBe('第三版')

    const humanSaved = await run(['project', 'handoff-update', projectId, '--body', '主用户直接保存'])
    expect(humanSaved.ok).toBe(true)
    expect(projectRepo.getById(projectId)?.handoffMarkdown).toBe('主用户直接保存')
  })

  it('handoff-history：倒序摘要不含全文；项目名/短 id 都能定位；--limit 真的传到仓储', async () => {
    const all = await run(['project', 'handoff-history', '修订命令项目'])
    expect(all.ok).toBe(true)
    const data = all.data as {
      project: string
      total: number
      returned: number
      revisions: Array<Record<string, unknown>>
    }
    expect(data).toMatchObject({ project: '修订命令项目', total: 3, returned: 3 })
    expect(data.revisions.map((r) => r.seq)).toEqual([3, 2, 1])
    expect(data.revisions[0]).toMatchObject({ author: 'human', kind: 'save', isCurrent: true, length: 3, preview: '第三版' })
    expect(data.revisions[0]).not.toHaveProperty('body')

    const limited = await run(['project', 'handoff-history', projectId.slice(0, 8), '--limit', '2'])
    const ld = limited.data as { total: number; returned: number; revisions: Array<{ seq: number }> }
    expect(ld.returned).toBe(2)
    expect(ld.total).toBe(3)
    expect(ld.revisions.map((r) => r.seq)).toEqual([3, 2])
  })

  it('handoff-history：--limit 非法一律被拒；--limit 0 = 全部（1.0.107，修 8d78af0d）', async () => {
    /**
     * ⚠️ 行为变化（请验收重点看）：`--limit 0` 从前报「需要正整数」，
     * 现在按全族口径 = **不做条数收窄**（与不传同义）。判据：同一个参数值
     * 只许有一种含义，做不到就明确报错 —— 这里能做到，所以它不再报错。
     */
    const plain = await run(['project', 'handoff-history', projectId])
    const zero = await run(['project', 'handoff-history', projectId, '--limit', '0'])
    expect(zero.ok).toBe(true)
    expect((zero.data as { revisions: unknown[] }).revisions.length).toBe(
      (plain.data as { revisions: unknown[] }).revisions.length
    )
    for (const bad of ['-1', 'abc', '1.5']) {
      const r = await run(['project', 'handoff-history', projectId, '--limit', bad])
      expect(r.ok, `--limit ${bad} 应当被拒`).toBe(false)
      expect(r.code).toBe(2)
    }
    const unknown = await run(['project', 'handoff-history', projectId, '--bogus', '1'])
    expect(unknown.ok).toBe(false)
    expect(unknown.code).toBe(2)
  })

  it('handoff-revision：按序号 / #序号 / id 取全文，作者与时间齐全；不存在给 not_found', async () => {
    const bySeq = await run(['project', 'handoff-revision', projectId, '--revision', '2'])
    expect(bySeq.ok).toBe(true)
    const rev = bySeq.data as { id: string; body: string; author: string; createdAt: string; seq: number }
    expect(rev).toMatchObject({ seq: 2, body: '第二版', author: 'agent:alice' })
    expect(Date.parse(rev.createdAt)).not.toBeNaN()

    const byHash = await run(['project', 'handoff-revision', projectId, '--revision', '#1'])
    expect((byHash.data as { body: string }).body).toBe('第一版')
    const byId = await run(['project', 'handoff-revision', projectId, `--revision=${rev.id}`])
    expect((byId.data as { body: string }).body).toBe('第二版')

    const missing = await run(['project', 'handoff-revision', projectId, '--revision', '99'])
    expect(missing.ok).toBe(false)
    expect(missing.errorCode).toBe('not_found')
    const noFlag = await run(['project', 'handoff-revision', projectId])
    expect(noFlag.ok).toBe(false)
  })

  it('handoff-rollback：--revision 传到仓储，作者取调用身份，留痕为 rollback 并通知 GUI；中间版本不删', async () => {
    const asAgent = { ...ctx, actor: 'agent:alice' }
    const res = await executeOne(asAgent as never, ['project', 'handoff-rollback', '修订命令项目', '--revision', '1'])
    expect(res.ok).toBe(true)
    expect(res.data).toMatchObject({
      project: '修订命令项目',
      changed: true,
      revision: { seq: 4, kind: 'rollback', sourceSeq: 1, author: 'agent:alice' }
    })
    expect(projectRepo.getById(projectId)!.handoffMarkdown).toBe('第一版')
    expect(projectRepo.countHandoffRevisions(projectId)).toBe(4)
    expect(ctx.deps.events.append).toHaveBeenCalledWith('project', 'agent:alice', expect.objectContaining({ id: projectId }))
  })

  it('handoff-rollback：回到与当前相同的版本 = changed=false 不写修订；不存在的版本报 not_found；缺 --revision 被拒', async () => {
    const same = await run(['project', 'handoff-rollback', projectId, '--revision', '3'])
    expect(same.ok).toBe(true)
    expect((same.data as { changed: boolean }).changed).toBe(false)
    expect(projectRepo.countHandoffRevisions(projectId)).toBe(3)
    expect(ctx.deps.events.append).not.toHaveBeenCalled()

    const missing = await run(['project', 'handoff-rollback', projectId, '--revision', '42'])
    expect(missing.ok).toBe(false)
    expect(missing.errorCode).toBe('not_found')

    const noFlag = await run(['project', 'handoff-rollback', projectId])
    expect(noFlag.ok).toBe(false)
  })

  it('handoff-rollback 是写档：无人值守的匿名调用被门禁拦下（走身份链，不绕开）', async () => {
    const anon = { ...ctx, actor: 'human', interactive: false } as never
    const res = await executeOne(anon, ['project', 'handoff-rollback', projectId, '--revision', '1'])
    expect(res.ok).toBe(false)
    expect(res.code).toBe(4)
    expect(projectRepo.getById(projectId)!.handoffMarkdown).toBe('第三版')
  })
})

describe('todo list 描述摘要（列表不带全文，全文用 todo get）', () => {
  it('短描述原样返回，不标截断', () => {
    expect(summarizeDescription('短描述')).toBe('短描述')
    expect(isDescriptionTruncated('短描述')).toBe(false)
  })

  it('刚好等于上限不截断（边界）', () => {
    const exact = 'a'.repeat(LIST_DESC_PREVIEW_CHARS)
    expect(summarizeDescription(exact)).toBe(exact)
    expect(isDescriptionTruncated(exact)).toBe(false)
  })

  it('超出上限截断并加省略号，标记 truncated', () => {
    const long = 'b'.repeat(LIST_DESC_PREVIEW_CHARS + 10)
    const s = summarizeDescription(long)!
    expect(s).toBe('b'.repeat(LIST_DESC_PREVIEW_CHARS) + '…')
    expect(isDescriptionTruncated(long)).toBe(true)
  })

  it('按字符而非 UTF-16 码元截断：中文与 emoji 不会切出半个字符', () => {
    const cjk = '中'.repeat(LIST_DESC_PREVIEW_CHARS + 1)
    expect(summarizeDescription(cjk)).toBe('中'.repeat(LIST_DESC_PREVIEW_CHARS) + '…')
    const emoji = '😀'.repeat(LIST_DESC_PREVIEW_CHARS + 1)
    expect(summarizeDescription(emoji)).toBe('😀'.repeat(LIST_DESC_PREVIEW_CHARS) + '…')
  })

  it('空描述与 null 返回 null，不算截断', () => {
    expect(summarizeDescription(null)).toBeNull()
    expect(summarizeDescription(undefined)).toBeNull()
    expect(summarizeDescription('')).toBeNull()
    expect(isDescriptionTruncated(null)).toBe(false)
    expect(isDescriptionTruncated('')).toBe(false)
  })
})
