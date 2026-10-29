/**
 * 命令层的仓储只能从 `ctx.deps` 来（1.0.112，卡 `69788c32`）
 *
 * 【要治的病】`CliDeps` 里早就摆着 `commentRepo` / `notificationRepo` / `rulesRepo`
 * 这些格子，而命令体自己 `new` —— **注入进去的实例根本收不到调用**。
 * `approved-review-replay.test.ts` 里的 `commentRepo` 就是这么被绕过的：用例塞了
 * 受控实例，验的却是另一条路，之所以还绿只是因为 `getDatabase()` 被 mock 成了同一个库。
 *
 * 【三条判据，缺一条这个洞就还在】
 * 1. **结构**：`src/main/cli/**` 里不许出现 `new *Repository(`（剥注释后判）；
 * 2. **接口完整性**：`CliDeps` 的每个字段都必须在**三处**构造点出现 ——
 *    只填无头那侧、漏了管道/批准回放，就是"加了字段却只在一条通道上生效"；
 * 3. **行为**：给 `deps` 注入受控假仓储，命令必须真调到它。
 *    这条在改造前**必然是红的**（假仓储收不到调用）—— 它不是新功能测试，
 *    是"注入成立"的判据本身。
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { runMigrations } from '../../../src/main/database/migrations'
import { TodoRepository } from '../../../src/main/database/todo.repository'
import { CategoryRepository } from '../../../src/main/database/category.repository'
import { ProjectRepository } from '../../../src/main/database/project.repository'
import { MemoRepository } from '../../../src/main/database/memo.repository'
import { AgentRepository } from '../../../src/main/database/agent.repository'
import { CommentRepository } from '../../../src/main/database/comment.repository'
import { NotificationRepository } from '../../../src/main/database/notification.repository'
import { ReminderReceiptRepository } from '../../../src/main/database/reminder-receipt.repository'
import { RulesRepository } from '../../../src/main/database/rules.repository'
import { ProtocolRepository } from '../../../src/main/database/protocol.repository'
import { ProfileRepository } from '../../../src/main/database/profile.repository'
import { executeOne } from '../../../src/main/cli/commands'

const db = new Database(':memory:')
vi.mock('../../../src/main/database/index', () => ({ getDatabase: () => db }))
vi.mock('../../../src/cli/credentials', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/cli/credentials')>()
  return { ...actual, writeCredential: vi.fn() }
})

const ROOT = path.resolve(__dirname, '../../..')
const CLI_DIR = path.join(ROOT, 'src', 'main', 'cli')

/** 与 audit-timeline.test.ts 的 stripComments 同一判据：块注释 + 行注释，避开 http:// */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

/** `src/main/cli/**` 下的全部 .ts（递归） */
function cliSources(): { rel: string; code: string }[] {
  const out: { rel: string; code: string }[] = []
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(abs)
      else if (entry.name.endsWith('.ts')) {
        out.push({
          rel: path.relative(ROOT, abs).replace(/\\/g, '/'),
          code: stripComments(fs.readFileSync(abs, 'utf8'))
        })
      }
    }
  }
  walk(CLI_DIR)
  return out
}

/** 取 `{` 之后配平的整段（粗略跳过字符串字面量里的括号） */
function braceBlock(src: string, openIndex: number): string {
  let depth = 0
  for (let i = openIndex; i < src.length; i++) {
    const c = src[i]
    if (c === "'" || c === '"' || c === '`') {
      const quote = c
      i++
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\') i++
        i++
      }
      continue
    }
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return src.slice(openIndex, i + 1)
    }
  }
  throw new Error('括号没配平 —— 源码结构变了？')
}

/** `interface CliDeps { ... }` 的字段名（只取第一层） */
function cliDepsFields(): string[] {
  const core = stripComments(fs.readFileSync(path.join(CLI_DIR, 'command-core.ts'), 'utf8'))
  const at = core.indexOf('export interface CliDeps {')
  expect(at, '找不到 CliDeps 接口 —— 闸门瞎了').toBeGreaterThan(-1)
  const block = braceBlock(core, core.indexOf('{', at))
  return [...block.matchAll(/^ {2}([a-z][A-Za-z0-9]*):/gm)].map((m) => m[1])
}

/** 某文件里 `deps: { ... }` 的每一段 */
function depsBlocks(file: string): string[] {
  const src = stripComments(fs.readFileSync(path.join(ROOT, file), 'utf8'))
  const out: string[] = []
  for (const m of src.matchAll(/\bdeps:\s*\{/g)) {
    out.push(braceBlock(src, src.indexOf('{', m.index)))
  }
  return out
}

describe('命令层的依赖一律从 ctx.deps 来（69788c32）', () => {
  describe('结构闸门：命令层不许自己 new 仓储', () => {
    it('src/main/cli/** 里没有 new *Repository(（剥注释后判）', () => {
      const offenders = cliSources()
        .filter((f) => /new\s+[A-Za-z_$][\w$]*Repository\s*\(/.test(f.code))
        .map((f) => f.rel)
      expect(
        offenders,
        `这些文件自己构造仓储 —— 构造点只能是接线处（index.ts 两条通道 + ipc.ts 批准回放）：\n` +
          offenders.join('\n')
      ).toEqual([])
    })

    it('反向验证：判定不是在数空气 —— 注入一处 new，同一判据必须点名那个文件', () => {
      // 拿真源码当夹具：把一处合法写法换成命令体自己 new，判据必须报它出来。
      const sample = cliSources()[0]
      expect(sample, '没读到命令层源码，闸门等于没跑').toBeTruthy()
      const injected = `function f() {\n  const repo = new CommentRepository()\n  return repo\n}`
      const judge = (code: string): boolean => /new\s+[A-Za-z_$][\w$]*Repository\s*\(/.test(code)
      expect(judge(injected), '注入的违规形态没被判出来 —— 这条闸门是恒绿的').toBe(true)
      expect(judge(sample.code), `命令层现在应当干净：${sample.rel}`).toBe(false)
    })

    it('命令层每个文件都被读到了（目录扫描，不是手写清单）', () => {
      const files = cliSources().map((f) => f.rel)
      expect(files.length, '命令层文件数明显变少 —— 扫描范围被改窄了？').toBeGreaterThan(12)
      for (const must of ['src/main/cli/command-core.ts', 'src/main/cli/commands/todo.ts']) {
        expect(files, `${must} 没被读到`).toContain(must)
      }
    })
  })

  describe('接口完整性：CliDeps 的每个字段都在三处构造点填上', () => {
    const fields = cliDepsFields()

    it('CliDeps 字段数与非空（闸门自己先自证）', () => {
      expect(fields.length, '一个字段都没解析出来 —— 解析规则失效').toBeGreaterThan(8)
      expect(fields).toContain('commentRepo')
      expect(fields).toContain('rulesRepo')
    })

    const sites: [string, string][] = [
      ['无头通道', 'src/main/index.ts'],
      ['管道通道', 'src/main/index.ts'],
      ['人工批准的批准回放', 'src/main/ipc.ts']
    ]

    for (const [name, file] of sites) {
      it(`${name}（${file}）把每个字段都填上了`, () => {
        const blocks = depsBlocks(file)
        // index.ts 两条通道各一段、ipc.ts 一段 —— 段数与预期对不上就说明构造点变了
        const expected = file.endsWith('index.ts') ? 2 : 1
        expect(blocks.length, `${file} 里的 deps 构造点数量变了`).toBe(expected)
        // 逐段核对：每个字段都要在这一段里出现（shorthand 或 key:）
        for (const block of blocks) {
          const missing = fields.filter(
            (f) => !new RegExp(`(^|[^\\w$])${f}\\s*[,:]`, 'm').test(block)
          )
          expect(
            missing,
            `${name} 的 deps 少了这些字段 —— 加字段只填了一半通道，另一半跑到那条命令时才炸：\n` +
              missing.join(' / ')
          ).toEqual([])
        }
      })
    }

    it('反向验证：从夹具里拿掉一个字段，同一判据必须报出来', () => {
      const block = depsBlocks('src/main/index.ts')[0]
      const minusOne = fields.filter((f) => !new RegExp(`(^|[^\\w$])${f}\\s*[,:]`, 'm').test(block))
      expect(minusOne, '真源码本来就缺字段？').toEqual([])
      // 把 commentRepo 那行删掉，判据必须不再放行
      const removed = block.replace(/\n\s*commentRepo,/, '')
      const missing = fields.filter((f) => !new RegExp(`(^|[^\\w$])${f}\\s*[,:]`, 'm').test(removed))
      expect(missing, '拿掉一个字段却没报 —— 这段判据是恒真的').toEqual(['commentRepo'])
    })
  })

  describe('行为闸门：注入的实例必须真收到调用', () => {
    /** 每个假仓储记下自己收到了哪些调用 */
    const calls: string[] = []
    const note = (label: string): void => {
      calls.push(label)
    }

    const commentRepo = {
      create: (input: { todoId: string; body: string; authorType: string; authorId: string; kind: string }) => {
        note('commentRepo.create')
        return {
          id: 'fake-comment',
          todoId: input.todoId,
          parentId: null,
          authorType: input.authorType,
          authorId: input.authorId,
          kind: input.kind,
          body: input.body,
          createdAt: new Date().toISOString()
        }
      },
      listByTodo: () => {
        note('commentRepo.listByTodo')
        return []
      },
      listWaitingFor: () => {
        note('commentRepo.listWaitingFor')
        return []
      },
      resolveId: () => {
        note('commentRepo.resolveId')
        return null
      },
      remove: () => {
        note('commentRepo.remove')
        return true
      },
      closureByTodo: () => {
        note('commentRepo.closureByTodo')
        return {}
      },
      countByTodo: () => {
        note('commentRepo.countByTodo')
        return 0
      }
    }
    const notificationRepo = {
      listPage: () => {
        note('notificationRepo.listPage')
        return { rows: [], matched: 0 }
      },
      countPage: () => {
        note('notificationRepo.countPage')
        return 0
      },
      markReadBy: () => {
        note('notificationRepo.markReadBy')
        return true
      },
      unreadCount: () => {
        note('notificationRepo.unreadCount')
        return 0
      },
      unreadCountFor: () => {
        note('notificationRepo.unreadCountFor')
        return 0
      }
    }
    const reminderReceiptRepo = {
      shouldExpand: () => {
        note('reminderReceiptRepo.shouldExpand')
        return false
      },
      markSeen: () => {
        note('reminderReceiptRepo.markSeen')
        return { changed: true, key: 'fake' }
      }
    }
    const rulesRepo = {
      listRules: () => {
        note('rulesRepo.listRules')
        return []
      },
      listPermissions: () => {
        note('rulesRepo.listPermissions')
        return []
      },
      propose: () => {
        note('rulesRepo.propose')
        return {}
      },
      listProposals: () => {
        note('rulesRepo.listProposals')
        return []
      }
    }
    const protocolRepo = {
      list: () => [],
      propose: () => ({}),
      listProposals: () => {
        note('protocolRepo.listProposals')
        return []
      }
    }
    const profileRepo = {
      list: () => [],
      propose: () => ({}),
      listProposals: () => {
        note('profileRepo.listProposals')
        return []
      }
    }

    let ctx: unknown

    beforeAll(() => {
      runMigrations(db)
    })

    beforeEach(() => {
      calls.length = 0
      db.exec(`
        DELETE FROM todo_comments;
        DELETE FROM todo_transitions;
        DELETE FROM todo_categories;
        DELETE FROM todos;
        DELETE FROM projects;
        DELETE FROM categories;
        DELETE FROM notifications;
      `)
      ctx = {
        deps: {
          todoRepo: new TodoRepository(),
          categoryRepo: new CategoryRepository(),
          projectRepo: new ProjectRepository(),
          memoRepo: new MemoRepository(),
          settingsRepo: { get: () => ({}) },
          agentRepo: new AgentRepository(),
          events: { append: () => {} },
          telemetry: { record: () => {}, query: () => [], stats: () => null, clear: () => 0 },
          commentRepo,
          notificationRepo,
          reminderReceiptRepo,
          rulesRepo,
          protocolRepo,
          profileRepo
        },
        meta: { version: '1.0.112', dbPath: ':memory:', schemaVersion: 46, via: 'pipe' },
        interactive: true,
        actor: 'human'
      }
    })

    const run = (args: string[]) => executeOne(ctx as never, args)

    const seedTodo = async (): Promise<string> => {
      new CategoryRepository().create({ name: '默认', color: '#111', sortOrder: 0 })
      new ProjectRepository().create({ name: 'P' })
      // `todo add` 起项目是必填（本机没有项目时缺了直接报 usage_error）
      const res = await run(['todo', 'add', '--title', '一条事项', '--project', 'P'])
      expect(res.ok, JSON.stringify(res)).toBe(true)
      return (res.data as { id: string }).id
    }

    it('todo comment：写评论走 ctx.deps.commentRepo，真实库一条都没落', async () => {
      const id = await seedTodo()
      const res = await run(['todo', 'comment', id, '--body', '注入的实例该收到这条'])
      expect(res.ok, JSON.stringify(res)).toBe(true)
      expect(calls, '注入的 commentRepo 一条调用都没收到 —— 命令又自己 new 了').toContain(
        'commentRepo.create'
      )
      // 真实库必须干净：这条用例证明的是"调用去了假货"，不是"两边都写一遍"
      expect(new CommentRepository().countByTodo(id), '假仓储该拦住的写入落进真库了').toBe(0)
    })

    it('todo inbox：读路径也走 ctx.deps.commentRepo', async () => {
      await seedTodo()
      await run(['todo', 'inbox'])
      expect(calls).toContain('commentRepo.listWaitingFor')
    })

    it('notification list：走 ctx.deps.notificationRepo（读窗口在它身上）', async () => {
      await run(['notification', 'list'])
      expect(calls).toContain('notificationRepo.listPage')
      expect(calls).toContain('notificationRepo.unreadCount')
    })

    it('任意写命令的会话提醒：走 ctx.deps.reminderReceiptRepo.shouldExpand', async () => {
      await seedTodo()
      expect(calls, '写命令之后没问过提醒回执 —— 提醒会重复推').toContain(
        'reminderReceiptRepo.shouldExpand'
      )
    })

    it('rules / protocol / profile 三个命令族：走各自的 deps 字段', async () => {
      await run(['rules', 'proposals'])
      await run(['protocol', 'proposals'])
      await run(['profile', 'proposals'])
      expect(calls).toContain('rulesRepo.listProposals')
      expect(calls).toContain('protocolRepo.listProposals')
      expect(calls).toContain('profileRepo.listProposals')
    })

    it('权限判定（GuardResolver）读的也是注入的 rulesRepo', async () => {
      await seedTodo()
      /**
       * 权限矩阵那条路只对**持证的 agent 身份**走（人自己敲不受矩阵约束）。
       * 所以这里真要验到 GuardResolver，就得按 agent 的样子来一遍 ——
       * 用人的身份跑，那条分支根本不会执行，用例会假绿。
       */
      const agents = new AgentRepository()
      agents.register({ id: 'agent:inject-check', displayName: '注入检查', color: '#111' } as never)
      agents.setApproved('agent:inject-check', true)
      const token = agents.issueCredential('agent:inject-check')?.token ?? ''
      expect(token, '拿不到凭据 —— 这条用例走不到权限判定').not.toBe('')

      calls.length = 0
      const asAgent = {
        ...(ctx as Record<string, unknown>),
        actor: 'agent:inject-check',
        credential: token,
        interactive: false
      }
      const res = await executeOne(asAgent as never, [
        'todo',
        'add',
        '--title',
        '再来一条',
        '--project',
        'P'
      ])
      expect(res.ok, JSON.stringify(res)).toBe(true)
      expect(
        calls,
        '守卫解析另起了一个 RulesRepository —— deps.rulesRepo 的注入在权限这条路上落空'
      ).toContain('rulesRepo.listPermissions')
    })
  })
})
