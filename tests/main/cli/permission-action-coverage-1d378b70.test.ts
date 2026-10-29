/**
 * 权限矩阵的**穷尽性**：矩阵里每个动作，都有一条真实命令能触发到它（卡 `1d378b70`）
 *
 * ## 它治的病
 *
 * 权限矩阵（`rules get` 里的 18 个动作）是主用户在界面上**真能编辑**的东西，
 * 源码里也自己写着「权限矩阵必须真正参与执行，不能停留在 GUI 可编辑的'展示配置'」。
 * 可 `update_profile` / `update_protocol` 这两个动作**一个执法点都没有**：
 * 动作名在矩阵里、`profile propose` / `protocol propose` 两条命令也在，
 * 中间那根线（`permissionActionFor()` 的映射）没接 —— 设成 deny 也拦不住 agent。
 *
 * 而它们恰恰是最该管的两个：改的是影响所有 agent 的公共信息。
 *
 * ## 判据
 *
 * 对矩阵里的**每一个**动作：把它对 `all_agents` 设成 `deny`，然后用一条真实命令
 * （走完整的参数解析与门禁）跑一次，回执必须是 `permission_denied` 且点名该动作。
 *
 * 表里必须覆盖 `PERMISSION_ACTIONS` 的**全部**动作 —— 以后新增动作而不接线，
 * 这一条就变红。这正是本卡要的"穷尽性回归"：一个动作验通过 ≠ 18 个动作都接了线。
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import os from 'node:os'
import path from 'node:path'
import { runMigrations } from '../../../src/main/database/migrations'
import { PERMISSION_ACTIONS, type PermissionAction } from '../../../src/main/database/rules'

const db = new Database(':memory:')
vi.mock('../../../src/main/database/index', () => ({ getDatabase: () => db }))

/**
 * 拦掉"写真实凭据文件"（`commands.test.ts` 里那次事故的同一道防线）：
 * 测试不该动宿主主目录里的凭据。
 */
vi.mock('../../../src/cli/credentials', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/cli/credentials')>()
  return { ...actual, writeCredential: vi.fn() }
})

const { TodoRepository } = await import('../../../src/main/database/todo.repository')
const { CategoryRepository } = await import('../../../src/main/database/category.repository')
const { ProjectRepository } = await import('../../../src/main/database/project.repository')
const { MemoRepository } = await import('../../../src/main/database/memo.repository')
const { AgentRepository } = await import('../../../src/main/database/agent.repository')
const { ReleaseRepository } = await import('../../../src/main/database/release.repository')
const { SettingsRepository } = await import('../../../src/main/database/settings.repository')
const { RulesRepository } = await import('../../../src/main/database/rules.repository')
const { CommentRepository } = await import('../../../src/main/database/comment.repository')
const { NotificationRepository } = await import('../../../src/main/database/notification.repository')
const { ReminderReceiptRepository } = await import('../../../src/main/database/reminder-receipt.repository')
const { ProtocolRepository } = await import('../../../src/main/database/protocol.repository')
const { ProfileRepository } = await import('../../../src/main/database/profile.repository')
const { executeOne } = await import('../../../src/main/cli/commands')

const todoRepo = new TodoRepository()
const categoryRepo = new CategoryRepository()
const projectRepo = new ProjectRepository()
const memoRepo = new MemoRepository()
const agentRepo = new AgentRepository()
const releaseRepo = new ReleaseRepository()
const settingsRepo = new SettingsRepository()

const ACTOR = 'agent:alice'
const AGENT = 'agent:alice'

let ctx: never
/** 每个用例重新播一遍的种子 id */
let seedIds: { todo: string; proposed: string; review: string; memo: string; project: string } = {
  todo: '',
  proposed: '',
  review: '',
  memo: '',
  project: ''
}

/** 把某个动作对全体 agent 设成 deny（等价于主用户在界面上点的那一下） */
const deny = (action: PermissionAction): void => {
  new RulesRepository().savePermission({ scope: 'global' }, action, 'all_agents', 'deny', 'human')
}

const run = (args: string[], extra: Record<string, unknown> = {}) =>
  executeOne({ ...(ctx as object), ...extra } as never, args)

beforeAll(() => {
  runMigrations(db)
  process.env.DESKPARTNER_CREDENTIALS_FILE = path.join(
    os.tmpdir(),
    `deskpartner-perm-coverage-${process.pid}.json`
  )
  agentRepo.register({ id: AGENT, displayName: 'Alice' })
  agentRepo.setApproved(AGENT, true)
})

beforeEach(() => {
  db.prepare('DELETE FROM permission_matrix').run()
  db.prepare('DELETE FROM todos').run()
  db.prepare('DELETE FROM memos').run()
  db.prepare('DELETE FROM projects').run()
  db.prepare('DELETE FROM releases').run()
  db.prepare('DELETE FROM categories').run()

  const project = projectRepo.create({ name: '权限项目' })
  const category = categoryRepo.create({ name: '方向', color: '#111', sortOrder: 0 })
  const todo = todoRepo.create({
    title: '普通事项',
    categoryIds: [category.id],
    projectId: project.id,
    status: 'todo',
    skipGuards: true
  } as never)
  const proposed = todoRepo.create({
    title: '待确认事项',
    categoryIds: [category.id],
    projectId: project.id,
    status: 'proposed',
    skipGuards: true
  } as never)
  const review = todoRepo.create({
    title: '待验收事项',
    categoryIds: [category.id],
    projectId: project.id,
    status: 'awaiting_review',
    executedBy: AGENT,
    skipGuards: true
  } as never)
  const memo = memoRepo.create({ author: AGENT, text: '备忘' })
  releaseRepo.create({ version: '1.0.0', projectId: project.id })

  seedIds = { todo: todo.id, proposed: proposed.id, review: review.id, memo: memo.id, project: project.id }

  // 凭据每次重新签一份并原样带进 ctx —— 门禁要在"持证且已批准"之后才查权限矩阵
  const issued = agentRepo.issueCredential(AGENT)
  ctx = {
    deps: {
      todoRepo,
      categoryRepo,
      projectRepo,
      memoRepo,
      agentRepo,
      releaseRepo,
      settingsRepo,
      /* 卡 69788c32：命令层要读哪个仓储由 deps 决定 —— 缺一个，跑到那条命令就炸 */
      commentRepo: new CommentRepository(),
      notificationRepo: new NotificationRepository(),
      reminderReceiptRepo: new ReminderReceiptRepository(),
      rulesRepo: new RulesRepository(),
      protocolRepo: new ProtocolRepository(),
      profileRepo: new ProfileRepository(),
      events: { append: () => {} },
      telemetry: { record: () => {}, stats: () => ({}), query: () => [], clear: () => {} }
    },
    meta: { version: '1.0.107', dbPath: ':memory:', schemaVersion: 45, via: 'headless' },
    interactive: false,
    actor: ACTOR,
    credential: issued?.token
  } as never
})

/**
 * 矩阵里的动作 → 触发它的那条真实调用。
 *
 * 表必须覆盖 `PERMISSION_ACTIONS` 的全部动作（下面有条闸门钉住）——
 * 漏一个就说明矩阵里又出现了"有展示、没执法"的动作。
 */
const CASES: Array<{
  action: PermissionAction
  /** 真实调用：位置参数用种子里的 id 拼，跑前替换 */
  argv: () => string[]
  /** 需要额外 ctx 字段的（batch 从 stdin 读记录） */
  ctxExtra?: Record<string, unknown>
}> = [
  { action: 'create_todo', argv: () => ['todo', 'add', '--title', '新事项', '--project', '权限项目'] },
  { action: 'update_todo', argv: () => ['todo', 'update', seedIds.todo, '--title', '改标题'] },
  {
    action: 'change_todo_status',
    argv: () => ['todo', 'update', seedIds.todo, '--status', 'in_progress']
  },
  {
    action: 'move_out_of_proposed',
    argv: () => ['todo', 'update', seedIds.proposed, '--status', 'todo']
  },
  { action: 'self_verify', argv: () => ['todo', 'done', seedIds.review] },
  { action: 'comment_todo', argv: () => ['todo', 'comment', seedIds.todo, '--body', '评论'] },
  {
    action: 'batch_todo',
    argv: () => ['batch'],
    ctxExtra: { stdin: '{"cmd":"todo add","args":{"--title":"批量建的"}}\n' }
  },
  { action: 'delete_todo', argv: () => ['todo', 'rm', seedIds.todo, '--yes'] },
  { action: 'delete_project', argv: () => ['project', 'rm', seedIds.project, '--yes'] },
  { action: 'delete_memo', argv: () => ['memo', 'rm', seedIds.memo, '--yes'] },
  { action: 'release_add', argv: () => ['release', 'add', '--version', '2.0.0', '--project', '权限项目'] },
  { action: 'release_update', argv: () => ['release', 'update', '1.0.0', '--project', '权限项目'] },
  {
    action: 'release_delete',
    argv: () => ['release', 'rm', '1.0.0', '--project', '权限项目', '--yes']
  },
  { action: 'ui_config', argv: () => ['ui', 'set', '--key', 'theme', '--value', 'dark'] },
  { action: 'rules_propose', argv: () => ['rules', 'propose', '--rule', 'G10', '--enforcement', 'off'] },
  {
    action: 'update_handoff',
    argv: () => ['project', 'handoff-update', seedIds.project, '--body', '接手说明']
  },
  // 卡 `1d378b70` 报的就是这两条：命令在、动作名在，中间那根线此前没接
  { action: 'update_profile', argv: () => ['profile', 'propose', '--block', 'basics', '--body', '档案'] },
  {
    action: 'update_protocol',
    argv: () => ['protocol', 'propose', '--block', 'roles', '--body', '协议']
  }
]

describe('权限矩阵的执法点穷尽性（1d378b70）', () => {
  it('表覆盖了矩阵里的每一个动作，而且没有重复', () => {
    const covered = CASES.map((c) => c.action)
    expect(new Set(covered).size, '同一个动作在表里出现了两次').toBe(covered.length)
    const matrix = PERMISSION_ACTIONS.map((a) => a.action).sort()
    expect(
      [...covered].sort(),
      '矩阵里的动作与"能触发它的命令"对不上：新增动作必须接线，并且在这里给出触发它的真实调用'
    ).toEqual(matrix)
  })

  for (const c of CASES) {
    it(`${c.action}：设成 deny 后 ${c.argv()[0]}… 返回 permission_denied`, async () => {
      deny(c.action)
      const res = await run(c.argv(), c.ctxExtra)
      expect(res.ok, `${c.action} 设成 deny 却照样跑成功了：${JSON.stringify(res).slice(0, 200)}`).toBe(false)
      expect(res.errorCode, `${c.action} 的拒绝原因不是权限`).toBe('permission_denied')
      expect(String(res.message)).toContain(c.action)
      // 拒绝消息要给出下一步（让主用户去改），否则调用方只知道自己被拒
      expect(String(res.message)).toContain('协作规则')
    })
  }

  it('deny 是按动作隔离的：拦下 A 不等于拦下 B', () => {
    deny('update_profile')
    return (async () => {
      const blocked = await run(['profile', 'propose', '--block', 'basics', '--body', '档案'])
      expect(blocked.errorCode).toBe('permission_denied')
      const other = await run(['protocol', 'propose', '--block', 'roles', '--body', '协议'])
      expect(other.errorCode).not.toBe('permission_denied')
    })()
  })

  it('默认口径没被改掉：这两个动作出厂是 require_approval，"提议"这条路仍然走得通', async () => {
    /**
     * 修的是"设成 deny 拦不住"，不是"把它们变成拒绝"：出厂默认是 `require_approval`，
     * 而这两条命令本身**就是**那条审批路 —— `profile propose` 提交的提议要在审批页
     * 由人采纳才生效。所以默认配置下它必须能跑。
     */
    const profile = await run(['profile', 'propose', '--block', 'basics', '--body', '档案'])
    expect(profile.ok, `默认配置下档案提议不该被拒：${JSON.stringify(profile).slice(0, 200)}`).toBe(true)
    const protocol = await run(['protocol', 'propose', '--block', 'roles', '--body', '协议'])
    expect(protocol.ok).toBe(true)
  })

  it('项目作用域的行也吃全局 deny（否则"只在某个项目里禁掉"会看着生效）', async () => {
    deny('update_profile')
    const res = await run([
      'profile', 'propose', '--project', '权限项目', '--block', 'basics', '--body', '档案'
    ])
    expect(res.errorCode).toBe('permission_denied')
  })

  it('这条矩阵只约束 agent：人在终端敲同一个动作不受影响', async () => {
    /**
     * 矩阵里 `human` 一律 allow，而且门禁对"人在终端敲"（interactive）**直接放行** ——
     * 权限检查必须排在那之后，否则主用户会被自己配的规则锁在外面。
     */
    deny('update_profile')
    const res = await run(['profile', 'propose', '--block', 'basics', '--body', '档案'], {
      actor: 'human',
      interactive: true,
      credential: undefined
    })
    expect(res.ok, `人敲的同一条命令不该被拦住：${JSON.stringify(res).slice(0, 200)}`).toBe(true)
  })
})
