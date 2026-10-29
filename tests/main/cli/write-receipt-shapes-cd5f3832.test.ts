import { describe, it, expect, beforeAll, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { runMigrations } from '../../../src/main/database/migrations'
import { commands, executeOne } from '../../../src/main/cli/commands'
import { riskOf, type CliContext } from '../../../src/main/cli/command-core'
import { WRITE_RECEIPT_SHAPES, buildSurfaceInventoryMarkdown } from '../../../src/main/cli/surface-inventory'

const db = new Database(':memory:')

const credsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-write-probe-creds-'))
process.env.DESKPARTNER_CREDENTIALS_FILE = path.join(credsDir, 'credentials.json')

vi.mock('../../../src/main/database/index', () => ({ getDatabase: () => db }))
vi.mock('../../../src/cli/credentials', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/cli/credentials')>()
  return { ...actual, writeCredential: vi.fn() }
})

const { TodoRepository } = await import('../../../src/main/database/todo.repository')
const { CategoryRepository } = await import('../../../src/main/database/category.repository')
const { ProjectRepository } = await import('../../../src/main/database/project.repository')
const { MemoRepository } = await import('../../../src/main/database/memo.repository')
const { SettingsRepository } = await import('../../../src/main/database/settings.repository')
const { AgentRepository } = await import('../../../src/main/database/agent.repository')
const { ReleaseRepository } = await import('../../../src/main/database/release.repository')
const { CommentRepository } = await import('../../../src/main/database/comment.repository')
const { NotificationRepository } = await import('../../../src/main/database/notification.repository')
const { ReminderReceiptRepository } = await import('../../../src/main/database/reminder-receipt.repository')
const { RulesRepository } = await import('../../../src/main/database/rules.repository')
const { ProtocolRepository } = await import('../../../src/main/database/protocol.repository')
const { ProfileRepository } = await import('../../../src/main/database/profile.repository')

const todoRepo = new TodoRepository()
const categoryRepo = new CategoryRepository()
const projectRepo = new ProjectRepository()
const memoRepo = new MemoRepository()
const settingsRepo = new SettingsRepository()
const agentRepo = new AgentRepository()
const releaseRepo = new ReleaseRepository()
const commentRepo = new CommentRepository()

describe('写入命令回执形状盘点（卡 cd5f3832）与 doc show 自述报错（卡 9a991bb1）', () => {
  let token = ''
  beforeAll(() => {
    runMigrations(db)
    db.pragma('foreign_keys = OFF')
    agentRepo.register({ id: 'agent:probe', displayName: '探针身份' } as never)
    agentRepo.setApproved('agent:probe', true)
    const issued = agentRepo.issueCredential('agent:probe')
    token = issued.token
    fs.writeFileSync(
      process.env.DESKPARTNER_CREDENTIALS_FILE!,
      JSON.stringify(
        {
          version: 1,
          default: 'agent:probe',
          profiles: {
            'agent:probe': { token, issuedAt: '2026-01-01T00:00:00.000Z' },
            'agent:probe-orphan': { token: 'orphan-token', issuedAt: '2026-10-06T00:00:00.000Z' }
          }
        },
        null,
        2
      )
    )
  })

  it('38 条非只读命令在 WRITE_RECEIPT_SHAPES 与 headless-surface.md 中零遗漏、零冗余，且实跑顶层键与门禁码完全一致', async () => {
    const writeCommands = commands.filter((c) => !c.readOnly)
    expect(writeCommands.length).toBe(38)

    const declaredNames = Object.keys(WRITE_RECEIPT_SHAPES)
    expect(declaredNames.sort()).toEqual(writeCommands.map((c) => c.name).sort())

    const md = buildSurfaceInventoryMarkdown()
    expect(md).toContain('## 2b. 写入型命令回执形状（38 条，卡 cd5f3832）')
    expect(md).toContain('需人工授权，形状未知')

    for (const c of writeCommands) {
      db.prepare('DELETE FROM todos').run()
      db.prepare('DELETE FROM projects').run()
      db.prepare('DELETE FROM categories').run()
      db.prepare('DELETE FROM memos').run()
      db.prepare('DELETE FROM releases').run()
      db.prepare('DELETE FROM todo_comments').run()

      const cat = categoryRepo.create({ name: '原方向', color: '#1', sortOrder: 0 })
      const catB = categoryRepo.create({ name: '探针目标', color: '#2', sortOrder: 1 })
      const proj = projectRepo.create({ name: '原项目' })
      projectRepo.create({ name: '备用项目' })
      projectRepo.saveHandoff(proj.id, '初始接手说明 v1')
      projectRepo.saveHandoff(proj.id, '初始接手说明 v2')
      const todo = todoRepo.create({
        title: '原始标题',
        description: '原始描述',
        categoryIds: [cat.id],
        projectId: proj.id,
        createdBy: 'human',
        executedBy: 'human'
      } as never)
      const reviewTodo = todoRepo.create({
        title: '待验收标题',
        description: '待验收描述',
        projectId: proj.id,
        status: 'awaiting_review',
        createdBy: 'human',
        executedBy: 'human',
        verifier: 'agent:probe'
      } as never)
      const ownComment = commentRepo.create({
        todoId: todo.id,
        body: '探针自己写的评论',
        authorType: 'agent',
        authorId: 'agent:probe'
      } as never)
      const memo = memoRepo.create({ text: '原始备忘', author: 'human', recipient: 'agent:probe' } as never)
      releaseRepo.create({ projectId: proj.id, version: '0.0.1', summary: '探针版本' } as never)

      const argv: string[] = [c.name]
      if (c.positional) {
        if (c.positional.name === 'ids') {
          argv.push(cat.id, catB.id)
        } else if (c.positional.name === 'id') {
          if (c.name === 'todo delete-comment') argv.push(ownComment.id)
          else if (c.name === 'todo reject' || c.name === 'todo close' || c.name === 'todo done') argv.push(reviewTodo.id)
          else if (c.name.startsWith('todo')) argv.push(todo.id)
          else if (c.name.startsWith('project')) argv.push(proj.id)
          else if (c.name.startsWith('memo')) argv.push(memo.id)
          else if (c.name.startsWith('category')) argv.push(cat.id)
          else argv.push('agent:probe')
        } else if (c.positional.name === 'version') {
          argv.push('0.0.1')
        }
      }

      const flagValues: Record<string, string> = {
        '--title': '探针标题',
        '--desc': '探针描述',
        '--reason': '探针理由',
        '--comment': '探针评论',
        '--summary': '探针摘要',
        '--version': '0.0.1',
        '--key': 'theme',
        '--value': 'dark',
        '--query': '原项目',
        '--owner': 'agent:probe',
        '--to': 'human',
        '--status': 'todo',
        '--priority': 'normal',
        '--type': 'task',
        '--category': '原方向',
        '--fixed-in': '0.0.1',
        '--created-by': 'human',
        '--executed-by': 'human',
        '--verifier': 'agent:probe',
        '--due': '2026-12-01T18:00:00+08:00',
        '--remind': '2026-12-01T18:00:00+08:00',
        '--shipped-at': '2026-12-01',
        '--tested': 'yes',
        '--highlight': '探针亮点',
        '--revision': '1',
        '--rule': 'G1',
        '--enforcement': 'block',
        '--project': '原项目',
        '--name': '探针名称',
        '--text': '探针备忘',
        '--body': '探针正文',
        '--id': 'agent:new-probe'
      }
      const extra: Record<string, Record<string, string>> = {
        'todo update': { '--title': '探针标题' },
        'todo close': { '--did': '做了这件事', '--verified': '跑了测试', '--pass-criteria': '测试通过', '--leftover': '请复核' },
        'project handoff-propose': { '--body': '探针接手说明' },
        'project handoff-update': { '--body': '探针接手说明' },
        'profile propose': { '--block': 'basics' },
        'protocol propose': { '--block': 'roles' },
        'release add': { '--version': '0.0.2', '--summary': '新版本' },
        'release update': { '--summary': '更新摘要' },
        'agent purge-credentials': { '--id': 'agent:probe-orphan' }
      }
      if (c.name === 'agent credential' || c.name === 'agent revoke') {
        agentRepo.register({ id: 'agent:new-probe', displayName: '新探针' } as never)
      }
      for (const a of c.args) {
        if (!a.required) continue
        if (a.type === 'boolean') argv.push(a.flag)
        else argv.push(a.flag, extra[c.name]?.[a.flag] ?? flagValues[a.flag] ?? '探针')
      }
      for (const [f, v] of Object.entries(extra[c.name] ?? {})) {
        if (!argv.includes(f)) argv.push(f, v)
      }
      for (const f of ['--body', '--reason']) {
        if (c.args.some((a) => a.flag === f) && !argv.includes(f)) argv.push(f, flagValues[f])
      }
      if (c.args.some((a) => a.flag === '--yes') && !argv.includes('--yes')) argv.push('--yes')

      const ctx: CliContext = {
        deps: {
          todoRepo,
          categoryRepo,
          projectRepo,
          memoRepo,
          settingsRepo,
          agentRepo,
          releaseRepo,
          commentRepo,
          notificationRepo: new NotificationRepository(),
          reminderReceiptRepo: new ReminderReceiptRepository(),
          rulesRepo: new RulesRepository(),
          protocolRepo: new ProtocolRepository(),
          profileRepo: new ProfileRepository(),
          events: { append: () => {} },
          telemetry: { record: () => {}, stats: () => ({}), query: () => [], clear: () => 0 }
        },
        meta: {
          version: '1.0.129',
          dbPath: ':memory:',
          schemaVersion: 47,
          busyTimeoutMs: 5000,
          channels: ['headless'],
          via: 'headless',
          startedAt: Date.now()
        },
        interactive: false,
        actor: 'agent:probe',
        credential: token,
        stdin: '{"cmd":"todo list"}'
      } as unknown as CliContext

      const spec = WRITE_RECEIPT_SHAPES[c.name]
      expect(spec, `缺少 ${c.name} 的 WRITE_RECEIPT_SHAPES 定义`).toBeTruthy()

      const outcome = (await executeOne(ctx, argv)) as Record<string, unknown>
      if (spec.unattended === 'ok') {
        expect(outcome.ok, `${c.name} 应直通成功，实际报错: ${String(outcome.message)}`).toBe(true)
        const d = outcome.data
        const keys = Array.isArray(d)
          ? (d[0] ? Object.keys(d[0] as object) : [])
          : (d && typeof d === 'object' ? Object.keys(d as object) : [])
        expect(keys, `${c.name} 的回执顶层键漂移`).toEqual([...spec.keys])
      } else {
        expect(outcome.ok, `${c.name} (${riskOf(c)}) 在无人值守下应被门禁拦下`).toBe(false)
        expect(outcome.errorCode, `${c.name} 的门禁 errorCode 不匹配`).toBe(spec.unattended)

        // 验证人工授权通过后的真实回执键与声明一致
        const humanCtx = { ...ctx, interactive: true, actor: 'human', credential: undefined } as unknown as CliContext
        const humanOutcome = (await executeOne(humanCtx, argv)) as Record<string, unknown>
        expect(humanOutcome.ok, `${c.name} 在人工上下文下应成功`).toBe(true)
        const hd = humanOutcome.data
        const hkeys = Array.isArray(hd)
          ? (hd[0] ? Object.keys(hd[0] as object) : [])
          : (hd && typeof hd === 'object' ? Object.keys(hd as object) : [])
        expect(hkeys, `${c.name} 授权后的回执顶层键漂移`).toEqual([...spec.keys])
      }
    }
  })

  it('doc show --project 查不到文档时报错自述最接近候选（did you mean）与该项目可用 name 清单（卡 9a991bb1）', () => {
    const tmpDocsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-doc-show-9a991bb1-'))
    try {
      fs.writeFileSync(path.join(tmpDocsDir, 'DESIGN.md'), '# 设计规则\n正文', 'utf8')
      fs.writeFileSync(path.join(tmpDocsDir, '2026-10-19-roadmap.md'), '# 路线图\n正文', 'utf8')
      fs.writeFileSync(path.join(tmpDocsDir, 'agent-usage-contract.md'), '# 契约\n正文', 'utf8')

      const proj = projectRepo.create({ name: '自述报错测试项目', docsDir: tmpDocsDir })

      // 1) 传带 docs/ 前缀的错路径 docs/DESIGN.md：应报 NotFoundError，且给出 did you mean: DESIGN.md + 可用 name 清单
      expect(() => projectRepo.readProjectDoc(proj.id, 'docs/DESIGN.md')).toThrowError(
        /最接近的候选（did you mean）：DESIGN\.md/
      )
      expect(() => projectRepo.readProjectDoc(proj.id, 'docs/DESIGN.md')).toThrowError(
        /请按 doc list --project "自述报错测试项目" 返回的 name 字段.*可用 name 清单.*DESIGN\.md/
      )

      // 2) 传完全不存在的任意错名：同样自述可用 name 清单与候选
      expect(() => projectRepo.readProjectDoc(proj.id, 'non-existent-doc')).toThrowError(
        /可用 name 清单.*2026-10-19-roadmap\.md、agent-usage-contract\.md、DESIGN\.md/
      )
    } finally {
      fs.rmSync(tmpDocsDir, { recursive: true, force: true })
    }
  })
})
