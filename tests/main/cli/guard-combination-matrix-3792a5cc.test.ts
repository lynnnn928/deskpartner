import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import os from 'node:os'
import path from 'node:path'
import { runMigrations } from '../../../src/main/database/migrations'
import { TodoRepository } from '../../../src/main/database/todo.repository'
import { CategoryRepository } from '../../../src/main/database/category.repository'
import { ProjectRepository } from '../../../src/main/database/project.repository'
import { AgentRepository } from '../../../src/main/database/agent.repository'
import { NotificationRepository } from '../../../src/main/database/notification.repository'
import { CommentRepository } from '../../../src/main/database/comment.repository'
import { EventsRepository } from '../../../src/main/database/events.repository'
import { ReleaseRepository } from '../../../src/main/database/release.repository'
import { executeOne, EXIT_CODES } from '../../../src/main/cli/commands'
import type { Todo } from '../../../src/renderer/types/todo'

/**
 * 守卫组合矩阵：**角色 × 列 × 命令**（卡 `3792a5cc`，Bob提）
 *
 * ## 为什么单条守卫的用例不够
 *
 * 已有的用例都是"造出一个触发条件 → 断言这一道拦得住"：
 * `inv6-guard-exit-codes`（退出码口径）、`discarded-is-final`（废弃终态）、
 * `delete-guard-unified-6720e1b9`（G4 挂载面）……每一条单拿出来都是对的。
 *
 * 而真实事故发生在**两条守卫的交界**：1.0.81 Bob实测的那次
 * "提出者既是默认执行者、又是验收者，于是谁都收不了口" ——
 * 单看 G4（离开待确认要人点）对、单看 G10（运动员不当裁判）也对，
 * 合起来却让一张卡在守卫层**没有合法出口**。这类缺口没有任何单条用例会发现。
 *
 * ## 这份矩阵怎么算"发现"而不是"抄现状"
 *
 * 每一格的期望值都从**关口清单里的口径**推出来，并写明依据（`why`），
 * 不是把当前代码的输出誊一遍。两组跨列的不变量单独断言：
 *
 * - `Inv-A 收口可达`：卡上写明的验收者必须能收口 —— **除非验收者本人就是执行者**
 *   （那正是 G10 要拦的，且写卡时就该避免）。这条在"执行者靠回落推定"的卡上会红，
 *   而红的原因不是"某道守卫写错了"，是两道守卫合起来把出口堵死了。
 * - `Inv-B 废弃是终态`：任何角色都不能把 `discarded` 的条目推回活列。
 *
 * ⚠️ 期望值里的 `permission_denied` 与 `guard_blocked` 是**两处不同的守卫**：
 * 前者来自协作规则矩阵（`self_verify` 对 agent 默认 deny），后者来自数据层。
 * 两者都必须是退出码 4，否则调用方会以为重试有用。
 */
const db = new Database(':memory:')
vi.mock('../../../src/main/database/index', () => ({ getDatabase: () => db }))

/**
 * 拦掉"写真实凭据文件"（`commands.test.ts` 里那次污染宿主凭据的事故同一道防线）。
 * agent 身份的用例要带真凭据才走得到协作规则矩阵，而签发凭据会写盘。
 */
vi.mock('../../../src/cli/credentials', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/cli/credentials')>()
  return { ...actual, writeCredential: vi.fn() }
})

const projectRepo = new ProjectRepository()
const agentRepo = new AgentRepository()

const AUTHOR = 'agent:author'
const WORKER = 'agent:worker'
const VERIFIER = 'agent:verifier'
const OTHER = 'agent:other'
const HUMAN = 'human'
const AGENTS = [AUTHOR, WORKER, VERIFIER, OTHER]

/** 每个 agent 的凭据 token（门禁要"持证 + 已批准"） */
const tokens = new Map<string, string | undefined>()

/**
 * 动作人 → ctx。
 *
 * ⚠️ **agent 必须按"无人值守"造**（`interactive: false` + 持证）：
 * 交互式 ctx 在门禁第二关就放行了（"人在终端敲"），**根本走不到协作规则矩阵** ——
 * 那样测出来的"agent 能收口"是假的，真实调用里它会先被 `self_verify` 拦一次。
 * 人则是 `interactive: true`（终端/界面）。
 */
function mkCtx(actor: string): never {
  const isHuman = actor === HUMAN
  return {
    deps: {
      todoRepo: new TodoRepository(),
      categoryRepo: new CategoryRepository(),
      projectRepo,
      memoRepo: { list: () => [], add: () => ({}), get: () => null },
      settingsRepo: { get: () => ({}) },
      agentRepo,
      commentRepo: new CommentRepository(),
      notificationRepo: new NotificationRepository(),
      releaseRepo: new ReleaseRepository(),
      events: new EventsRepository(),
      telemetry: { record: () => {}, stats: () => {}, query: () => {}, clear: () => {} }
    },
    meta: {
      version: 'test',
      dbPath: ':memory:',
      schemaVersion: 99,
      busyTimeoutMs: 5000,
      channels: ['headless' as const],
      via: 'headless' as const,
      startedAt: Date.now()
    },
    interactive: isHuman,
    actor,
    credential: isHuman ? undefined : tokens.get(actor)
  } as never
}

const run = (actor: string, args: string[]) => executeOne(mkCtx(actor), args)

let todos: TodoRepository

beforeAll(() => {
  runMigrations(db)
  process.env.DESKPARTNER_CREDENTIALS_FILE = path.join(
    os.tmpdir(),
    `deskpartner-guard-matrix-${process.pid}.json`
  )
  for (const id of AGENTS) {
    agentRepo.register({ id, displayName: id })
    agentRepo.setApproved(id, true)
    tokens.set(id, agentRepo.issueCredential(id)?.token)
  }
})

beforeEach(() => {
  for (const t of [
    'todos',
    'todo_transitions',
    'todo_comments',
    'todo_categories',
    'notifications',
    'agent_grants',
    'projects',
    'categories'
  ]) {
    db.prepare(`DELETE FROM ${t}`).run()
  }
  new CategoryRepository().create({ name: '默认', color: '#111', sortOrder: 0 })
  projectRepo.create({ name: 'P' })
  todos = new TodoRepository()
})

/** 造一条处于指定列的卡（`by` = 提出者，`executedBy` = 显式执行者，`verifier` = 验收者） */
function card(opts: {
  status: Todo['status']
  createdBy?: string
  executedBy?: string | null
  verifier?: string | null
  /** 造完后再把它推进到 awaiting_review 的人（写成真实流转，供判定取用） */
  pushedBy?: string | null
}): Todo {
  const t = todos.create({
    title: '卡',
    description: '【背景】x\n【目标】y\n【判据】z',
    projectId: null,
    status: opts.status === 'awaiting_review' && opts.pushedBy !== undefined ? 'in_progress' : opts.status,
    createdBy: (opts.createdBy ?? AUTHOR) as never,
    executedBy: opts.executedBy === undefined ? null : (opts.executedBy as never),
    verifier: (opts.verifier === undefined ? null : (opts.verifier as never)) as never
  } as never)
  if (opts.status === 'awaiting_review' && opts.pushedBy !== undefined) {
    todos.update({ id: t.id, status: 'awaiting_review', actor: opts.pushedBy as never })
  }
  return todos.getById(t.id)!
}

/** 把一次调用归成"放行 / 被哪道门拒绝" */
async function outcome(actor: string, args: string[]): Promise<string> {
  const r = (await run(actor, args)) as { ok?: boolean; code?: number; errorCode?: string }
  return r.ok ? 'allow' : `${r.code}:${r.errorCode ?? 'no-code'}`
}

const closeArgs = (id: string) => [
  'todo',
  'close',
  id,
  '--did',
  '做了',
  '--verified',
  '验证了',
  '--pass-criteria',
  '算通过'
]

describe('守卫组合矩阵', () => {
  describe('待确认列：谁能让它离开这一步', () => {
    /**
     * 这一列有两道门**叠在一起**，而它们的拒绝理由指向完全不同的方向：
     *
     * - `move_out_of_proposed`（协作规则矩阵，对 agent 默认 deny）→ `permission_denied`，
     *   文案让调用方去改协作规则配置；
     * - G4（数据层）→ `guard_blocked`，文案说"等人拍板"。
     *
     * 真实调用里 agent 先撞前者、人（终端）撞后者。矩阵把两种回执都钉下来，
     * 是为了让"到底该改什么"有据可查 —— 它们**都是退出码 4**，不会让人以为重试有用。
     */
    it('提议人自己可以降级为待办（撤回请求 ≠ 替人拍板）', async () => {
      const t = card({ status: 'proposed', createdBy: AUTHOR })
      expect(await outcome(AUTHOR, ['todo', 'update', t.id, '--status', 'todo'])).toBe('allow')
    })

    it('提议人自己可以撤回（挂起）', async () => {
      const t = card({ status: 'proposed', createdBy: AUTHOR })
      expect(await outcome(AUTHOR, ['todo', 'update', t.id, '--status', 'suspended'])).toBe('allow')
    })

    it('提议人不能把它推到更右边（降级 ≠ 批准）', async () => {
      const t = card({ status: 'proposed', createdBy: AUTHOR })
      expect(
        await outcome(AUTHOR, ['todo', 'update', t.id, '--status', 'awaiting_review'])
      ).toBe(`${EXIT_CODES.guard}:permission_denied`)
    })

    it('别人不能替提议人把它移出待确认', async () => {
      const t = card({ status: 'proposed', createdBy: AUTHOR })
      // 人（终端交互）走的是数据层的 G4
      expect(await outcome(HUMAN, ['todo', 'update', t.id, '--status', 'todo'])).toBe(
        `${EXIT_CODES.guard}:guard_blocked`
      )
      // 无人值守的 agent 在门禁层就被协作规则矩阵拦下
      for (const actor of [WORKER, OTHER]) {
        expect(await outcome(actor, ['todo', 'update', t.id, '--status', 'todo']), actor).toBe(
          `${EXIT_CODES.guard}:permission_denied`
        )
      }
    })

    it('删除待确认的卡走"转授权"而不是直接拒绝（agent 可发起申请）', async () => {
      const t = card({ status: 'proposed', createdBy: AUTHOR })
      const got = await outcome(OTHER, ['todo', 'rm', t.id, '--yes'])
      expect(got, 'G4-delete 是 authorize 档：申请授权，不是 guard_blocked').toBe(
        `${EXIT_CODES.guard}:grant_required`
      )
    })
  })

  describe('父子关系：G1 / G2 / G6 三条路的交界', () => {
    it('G1：父需求还在待确认时，谁都不能挂子任务（含人）', async () => {
      const p = card({ status: 'proposed', createdBy: AUTHOR })
      for (const actor of [HUMAN, AUTHOR, OTHER]) {
        const got = await outcome(actor, ['todo', 'add', '--title', '子', '--parent', p.id, '--project', 'P'])
        expect(got, actor).toBe(`${EXIT_CODES.guard}:guard_blocked`)
      }
    })

    it('G2：有未完成子任务的父需求不能转「待验收」', async () => {
      const p = card({ status: 'in_progress', createdBy: AUTHOR })
      todos.create({ title: '子', projectId: null, parentId: p.id, createdBy: AUTHOR } as never)
      expect(await outcome(AUTHOR, ['todo', 'update', p.id, '--status', 'awaiting_review'])).toBe(
        `${EXIT_CODES.guard}:guard_blocked`
      )
    })

    it('G6：子任务没完时也不能直接归档（绕开 G2 的那条路同样堵死）', async () => {
      const p = card({ status: 'in_progress', createdBy: AUTHOR })
      todos.create({ title: '子', projectId: null, parentId: p.id, createdBy: AUTHOR } as never)
      /**
       * ⚠️ 1.0.116 起回执换了码（`a7ad343f`）：self_verify 改成按身份判之后，
       * 执行者把卡从任何一列送到 done 都先在**门禁层**被拦（permission_denied），
       * 走不到数据层的 G6。判据本身没变 —— G6 仍然拦得住，只是下一段直接打数据层来验。
       */
      expect(await outcome(AUTHOR, ['todo', 'update', p.id, '--status', 'done'])).toBe(
        `${EXIT_CODES.guard}:permission_denied`
      )
      // G6 自己那条：不经门禁的那条路（界面/直接调仓储）仍然被数据层拦下
      expect(() => todos.update({ id: p.id, status: 'done', actor: OTHER as never })).toThrow()
    })

    /**
     * 废弃的子卡不算"还没做完"（`96e4fd0d`）
     *
     * 实测撞上的是：父卡 `96e4fd0d` 唯一的子卡早就被废弃了（"这件事不做了"），
     * 而 G2/G6 把它们当成未完成 —— 父卡既转不了待验收也归不了档。
     * 更糟的是报错只给出"删掉子任务"这一条出口：为一件已决定不做的事去删数据，
     * 恰恰是守卫该避免的事。
     *
     * ⭐ 反向验证：判据改回 `status != 'done'` → 前两条红（父卡被锁住）。
     */
    it('G6：子卡已废弃时，父需求可以直接归档（废弃是结论，不是没做完）', async () => {
      const p = card({ status: 'in_progress', createdBy: AUTHOR })
      const c = todos.create({ title: '子', projectId: null, parentId: p.id, createdBy: AUTHOR } as never)
      todos.update({ id: c.id, status: 'discarded', actor: AUTHOR })
      expect(await outcome(HUMAN, ['todo', 'update', p.id, '--status', 'done'])).toBe('allow')
    })

    it('G2：子卡已废弃时，父需求可以转「待验收」', async () => {
      const p = card({ status: 'in_progress', createdBy: AUTHOR })
      const c = todos.create({ title: '子', projectId: null, parentId: p.id, createdBy: AUTHOR } as never)
      todos.update({ id: c.id, status: 'discarded', actor: AUTHOR })
      expect(await outcome(AUTHOR, ['todo', 'update', p.id, '--status', 'awaiting_review'])).toBe('allow')
    })

    it('挂起的子卡仍然算没做完（别把「以后可能做」也放开）', async () => {
      const p = card({ status: 'in_progress', createdBy: AUTHOR })
      const c = todos.create({ title: '子', projectId: null, parentId: p.id, createdBy: AUTHOR } as never)
      todos.update({ id: c.id, status: 'suspended', actor: AUTHOR })
      expect(await outcome(HUMAN, ['todo', 'update', p.id, '--status', 'done'])).toBe(
        `${EXIT_CODES.guard}:guard_blocked`
      )
    })

    it('子任务全部完成后两条路都放行', async () => {
      const p = card({ status: 'in_progress', createdBy: AUTHOR })
      const c = todos.create({ title: '子', projectId: null, parentId: p.id, createdBy: AUTHOR } as never)
      todos.update({ id: c.id, status: 'done', actor: AUTHOR })
      expect(await outcome(OTHER, ['todo', 'update', p.id, '--status', 'awaiting_review'])).toBe('allow')
      /**
       * 第二步换个人收口 —— 不是随手写的：上一步 `OTHER` 把卡推到待验收，
       * 按"推进即认领"它已经成了执行者，**同一个人再点完成就会被 G10 拦**
       * （而那正是 G10 想要的）。想验"G6 放行"，得让非执行者来。
       */
      expect(await outcome(HUMAN, ['todo', 'update', p.id, '--status', 'done'])).toBe('allow')
    })
  })

  describe('待验收列：收口（G10 × 协作规则矩阵）', () => {
    const mk = () =>
      card({
        status: 'awaiting_review',
        createdBy: AUTHOR,
        executedBy: WORKER,
        verifier: VERIFIER
      })

    it('执行者不能自己签：无人值守的 agent 先撞协作规则（permission_denied）', async () => {
      const t = mk()
      /**
       * 期望是 `permission_denied` 而不是 `guard_blocked`，因为两道门分别在两层：
       * 协作规则矩阵（`self_verify` 对 agent 默认 deny）在**门禁**这一层先开火，
       * 数据层的 G10 是在它后面兜底的那道。
       */
      expect(await outcome(WORKER, ['todo', 'update', t.id, '--status', 'done'])).toBe(
        `${EXIT_CODES.guard}:permission_denied`
      )
      // 界面/主进程那条路（没有门禁）由数据层拦
      expect(() => todos.update({ id: t.id, status: 'done', actor: WORKER as never })).toThrow()
    })

    it('验收者可以收口', async () => {
      const t = mk()
      expect(await outcome(VERIFIER, closeArgs(t.id))).toBe('allow')
    })

    it('验收者以外的人也能收口（G10 只拦执行者，不指定谁能签）', async () => {
      const t = mk()
      expect(await outcome(OTHER, closeArgs(t.id))).toBe('allow')
    })

    it('人总能收口（界面/终端都算"人点了头"）', async () => {
      const t = mk()
      expect(await outcome(HUMAN, closeArgs(t.id))).toBe('allow')
    })

    it('驳回不受 G10 管：执行者也能把卡退回去（退回去是可逆动作）', async () => {
      const t = mk()
      expect(await outcome(WORKER, ['todo', 'reject', t.id, '--reason', '没做好'])).toBe('allow')
    })
  })

  /**
   * G10 是**身份规则**，不是路径规则（卡 `a7ad343f`）
   *
   * 这一组钉的是「起点不是待验收、结果却是 done」的四条边。
   * 修之前它们全是放行的 —— 执行者按说明书推荐的 `todo close` 一步收口，
   * 恰好走在不执法的那条边上，于是运动员不当裁判这条规则可以被正常用法绕开。
   *
   * ⭐ 反向验证：把 `command-core.ts` 里的判据改回 `todo.status === 'awaiting_review'`，
   * 这四条立刻变红（全部 allow）。
   */
  describe('G10 按身份判：任何进入 done 的边都拦（执行者不能自己签）', () => {
    const mk = (status: Todo["status"]) =>
      card({ status, createdBy: AUTHOR, executedBy: WORKER, verifier: VERIFIER })

    it('从待办 close：执行者被拦', async () => {
      const t = mk('todo')
      expect(await outcome(WORKER, closeArgs(t.id))).toBe(
        `${EXIT_CODES.guard}:permission_denied`
      )
    })

    it('从进行中 close：执行者被拦', async () => {
      const t = mk('in_progress')
      expect(await outcome(WORKER, closeArgs(t.id))).toBe(
        `${EXIT_CODES.guard}:permission_denied`
      )
    })

    it('从挂起 close：执行者被拦（挂起不是绕道）', async () => {
      const t = mk('suspended')
      expect(await outcome(WORKER, closeArgs(t.id))).toBe(
        `${EXIT_CODES.guard}:permission_denied`
      )
    })

    it('从待办 update --status done：执行者被拦（close 之外的另一条路）', async () => {
      const t = mk('todo')
      expect(await outcome(WORKER, ['todo', 'update', t.id, '--status', 'done'])).toBe(
        `${EXIT_CODES.guard}:permission_denied`
      )
    })

    it('换个验收者从待办 close：照旧放行（不许把所有人都挡住）', async () => {
      const t = mk('todo')
      expect(await outcome(VERIFIER, closeArgs(t.id))).toBe(
        'allow'
      )
    })
  })

  describe('Inv-A：待验收的卡必须有人能合法收口（"验收者 ≠ 执行者"要成立）', () => {
    /**
     * 五种卡面组合，逐个枚举"谁能收口"。
     *
     * 判据（从 G10 的口径推出来，不是从代码输出誊的）：
     * **卡上写明的验收者必须能收口，除非验收者本人就是执行者。**
     */
    const shapes: { label: string; mk: () => Todo; verifier: string }[] = [
      {
        label: '显式执行者 + 别人验收',
        mk: () => card({ status: 'awaiting_review', createdBy: AUTHOR, executedBy: WORKER, verifier: VERIFIER }),
        verifier: VERIFIER
      },
      {
        label: '显式执行者 + 提出者验收（默认）',
        mk: () => card({ status: 'awaiting_review', createdBy: AUTHOR, executedBy: WORKER, verifier: AUTHOR }),
        verifier: AUTHOR
      },
      {
        label: '无执行者 + 别人把它推到待验收（Bob 1.0.81 实测的形状）',
        mk: () =>
          card({
            status: 'awaiting_review',
            createdBy: AUTHOR,
            executedBy: null,
            verifier: AUTHOR,
            pushedBy: WORKER
          }),
        verifier: AUTHOR
      },
      {
        label: '无执行者 + 提出者自己推到待验收（自证闭环，应当拦）',
        mk: () =>
          card({
            status: 'awaiting_review',
            createdBy: AUTHOR,
            executedBy: null,
            verifier: VERIFIER,
            pushedBy: AUTHOR
          }),
        verifier: VERIFIER
      },
      {
        label: '无执行者 + 直接建成待验收（没有流转可查）',
        mk: () => card({ status: 'awaiting_review', createdBy: AUTHOR, executedBy: null, verifier: VERIFIER }),
        verifier: VERIFIER
      },
      {
        /**
         * Bob 1.0.81 实测的那一格：**提出者自己把卡推到待验收，而验收者也正是提出者**
         * （`verifier` 不传时默认就是提出者），执行者字段是 NULL。
         *
         * 结果：推定执行者 = 提出者 = 验收者，G10 把提出者拦在门外 ——
         * 这张卡**只能由人或不相干的第三方点完成**，写明的验收者反而签不了。
         *
         * 它不是"死卡"（人总能点，见下面那条"至少有一个身份能收口"），
         * 但它说明一件事：`verifier` 默认取提出者 + 执行者字段靠回落推定，
         * 这两条各自合理的设计合起来会产出"自己验自己"的卡。
         * 是修判定还是修默认值，见卡 `8bf6a932` 的评论线程 —— 本矩阵先把形状钉住。
         */
        label: '无执行者 + 提出者自己推到待验收 + 验收者=提出者（自己验自己）',
        mk: () =>
          card({
            status: 'awaiting_review',
            createdBy: AUTHOR,
            executedBy: null,
            verifier: AUTHOR,
            pushedBy: AUTHOR
          }),
        verifier: AUTHOR
      }
    ]

    for (const shape of shapes) {
      it(`${shape.label}：写明的验收者 ${shape.verifier} 能收口`, async () => {
        const t = shape.mk()
        /**
         * 豁免只有一种：**验收者本人就是执行者**（那正是 G10 要拦的，
         * 写卡时就该避免 —— G10 的补救文案就是"让执行者以外的验收者收口"）。
         * 用显式的 if 而不是"跳过断言"，是为了让这一格在报告里留痕，
         * 不至于把死锁伪装成豁免。
         */
        const resolvedExecutor = t.executedBy ?? t.createdBy
        if (shape.verifier === resolvedExecutor) {
          expect(await outcome(shape.verifier, closeArgs(t.id))).not.toBe('allow')
          return
        }
        expect(
          await outcome(shape.verifier, closeArgs(t.id)),
          `落在 ${shape.verifier} 身上的收口被拒：这条卡的执行者字段是 ${String(t.executedBy)}`
        ).toBe('allow')
      })
    }

    it('每一种卡面都至少有一个身份能收口（不能出现无出口的卡）', async () => {
      for (const shape of shapes) {
        const t = shape.mk()
        const results = await Promise.all(
          [HUMAN, AUTHOR, WORKER, VERIFIER, OTHER].map((actor) =>
            outcome(actor, ['todo', 'close', ...closeArgs(t.id).slice(2)])
          )
        )
        const pass = results.filter((r) => r === 'allow' || r === 'no-todo')
        expect(pass.length, `${shape.label}：五个身份全部被拒（${results.join(' / ')}）`).toBeGreaterThan(0)
      }
    })
  })

  describe('Inv-B：废弃是终态', () => {
    it('任何角色都不能把废弃的条目推回活列', async () => {
      const t = card({ status: 'in_progress', createdBy: AUTHOR })
      todos.update({ id: t.id, status: 'discarded', actor: AUTHOR })
      for (const actor of [HUMAN, AUTHOR, WORKER]) {
        for (const next of ['todo', 'in_progress', 'awaiting_review', 'done']) {
          const got = await outcome(actor, ['todo', 'update', t.id, '--status', next])
          expect(got, `${actor} 把废弃卡推回了 ${next}`).not.toBe('allow')
        }
      }
    })
  })

  describe('完成列：回头看的口径', () => {
    it('已完成 → 进行中 是自由的（不设"复活"关口）', async () => {
      const t = card({ status: 'in_progress', createdBy: AUTHOR })
      todos.update({ id: t.id, status: 'done', actor: AUTHOR })
      expect(await outcome(AUTHOR, ['todo', 'update', t.id, '--status', 'in_progress'])).toBe('allow')
    })
  })
})
