/**
 * A 组：其余仓储的时间排序要有兜底次序键（卡 `07015c7e`，接 `1486836d` / `9536f9c3`）
 *
 * ## 它治的病
 *
 * `agent.repository.ts` 收干净之后，`src/main/database/*.ts` 里还剩 9 处
 * **只按时间排、没有兜底键**的查询。同一毫秒的两条，谁在前由 SQLite 的隐式顺序定 ——
 * 同一份库、同样的调用，两次可能给出不同顺序。三处带 `--limit`，平局时**先截错人**：
 *
 * | 位置 | 谁在读这个顺序 |
 * |---|---|
 * | `todo.repository.ts:1665` | 看板主列表 / `todo list` |
 * | `todo.repository.ts:1152` | `listChildren`：详情页/CLI 的子任务清单 |
 * | `todo.repository.ts:277` | G6 归档门禁回执"还有哪 10 条没做完"（`LIMIT 10`） |
 * | `todo.repository.ts:1058` | "被打回又回到进行中"清单（`LIMIT 50`） |
 * | `project.repository.ts:159` | 接手说明待批清单 |
 * | `protocol.repository.ts:137` | 协议提议清单 |
 * | `rules.repository.ts:314` | 规则提议清单 |
 * | `profile.repository.ts:163` | 档案提议清单 |
 * | `release.repository.ts:205` | 某版本包含的事项清单 |
 *
 * ## 判据
 *
 * **能算出来的顺序，不许交给数据库的隐式行为。**
 * 兜底键用 `id`、方向与主键同向（`DESC` 配 `, id DESC`、`ASC` 配 `, id ASC`），
 * 与上一批同一套。
 *
 * ## 本文件怎么证明"以前是错的"
 *
 * 每处都造**同一 `created_at`** 的两条（G6 那条造 11 条看 `LIMIT 10` 截谁），
 * 并跑**两种插入序**。改前两种插入序结果不同（隐式顺序就是扫描顺序），
 * 改后必须一致 —— 所以用例在版本回退时会红，不是"恰好通过"。
 *
 * ## 扫描范围为什么不含 migrations.ts
 *
 * `migrations.ts` 里还有 2 处（`:513`、`:1082`，回填时挑"第一个项目"）。**没改**：
 * 文件头写着「每次版本升级只追加新的迁移函数，不修改已有迁移」——
 * 改历史迁移会让升过级的库和新装的库在平局那一种情形下分叉。
 * 闸门因此把它排除，同时**另外断言那两处的数量**，免得"排除"被悄悄扩大。
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { runMigrations } from '../../../src/main/database/migrations'
import { TodoRepository } from '../../../src/main/database/todo.repository'
import { ProjectRepository } from '../../../src/main/database/project.repository'
import { ProtocolRepository } from '../../../src/main/database/protocol.repository'
import { ProfileRepository } from '../../../src/main/database/profile.repository'
import { RulesRepository } from '../../../src/main/database/rules.repository'
import { ReleaseRepository } from '../../../src/main/database/release.repository'

const db = new Database(':memory:')
vi.mock('../../../src/main/database/index', () => ({ getDatabase: () => db }))

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

/** 平局的前提：两边 `created_at` 一模一样 */
const INSTANT = '2026-10-21T05:00:00.000Z'

let todos: TodoRepository
let projects: ProjectRepository
let protocol: ProtocolRepository
let profile: ProfileRepository
let rules: RulesRepository
let releases: ReleaseRepository

const insertTodo = (o: {
  id: string
  title?: string
  status?: string
  parentId?: string | null
  createdAt?: string
  fixedInVersion?: string | null
  projectId?: string | null
}): void => {
  db.prepare(
    `INSERT INTO todos
       (id, title, status, created_at, updated_at, parent_id, is_pinned, fixed_in_version, project_id)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`
  ).run(
    o.id,
    o.title ?? `任务 ${o.id}`,
    o.status ?? 'todo',
    o.createdAt ?? INSTANT,
    o.createdAt ?? INSTANT,
    o.parentId ?? null,
    o.fixedInVersion ?? null,
    o.projectId ?? null
  )
}

/** 前提自检：插入序 == rowid 序，否则"两种插入序"这组对照就是假的 */
const rowidOrder = (table: string): string[] =>
  (db.prepare(`SELECT id FROM ${table} ORDER BY rowid ASC`).all() as { id: string }[]).map(
    (r) => r.id
  )

const ids = <T extends { id: string }>(rows: T[]): string[] => rows.map((r) => r.id)

describe('A 组：时间排序的兜底次序键（07015c7e）', () => {
  beforeAll(() => {
    runMigrations(db)
    db.pragma('foreign_keys = OFF')
  })

  beforeEach(() => {
    for (const t of [
      'todo_comments',
      'todo_transitions',
      'todos',
      'project_handoff_proposals',
      'protocol_proposals',
      'profile_proposals',
      'rule_proposals',
      'releases',
      'projects'
    ]) {
      db.prepare(`DELETE FROM ${t}`).run()
    }
    todos = new TodoRepository()
    projects = new ProjectRepository()
    protocol = new ProtocolRepository()
    profile = new ProfileRepository()
    rules = new RulesRepository()
    releases = new ReleaseRepository()
  })

  it('todo 主列表：同刻的两条按 id 倒序，且与插入序无关', () => {
    insertTodo({ id: 'aa-todo' })
    insertTodo({ id: 'zz-todo' })
    expect(rowidOrder('todos'), '前提：aa 先插').toEqual(['aa-todo', 'zz-todo'])
    expect(ids(todos.list()), '同刻的两条谁在前不能由隐式顺序决定').toEqual(['zz-todo', 'aa-todo'])

    db.prepare('DELETE FROM todos').run()
    insertTodo({ id: 'zz-todo' })
    insertTodo({ id: 'aa-todo' })
    expect(rowidOrder('todos'), '前提：插入序反过来').toEqual(['zz-todo', 'aa-todo'])
    expect(ids(todos.list()), '插入序反过来，结论必须一样').toEqual(['zz-todo', 'aa-todo'])
  })

  it('listChildren：同刻创建的子任务按 id 正序，且与插入序无关', () => {
    insertTodo({ id: 'p-parent', status: 'in_progress' })
    insertTodo({ id: 'zz-child', parentId: 'p-parent' })
    insertTodo({ id: 'aa-child', parentId: 'p-parent' })
    expect(ids(todos.listChildren('p-parent'))).toEqual(['aa-child', 'zz-child'])

    db.prepare('DELETE FROM todos').run()
    insertTodo({ id: 'p-parent', status: 'in_progress' })
    insertTodo({ id: 'aa-child', parentId: 'p-parent' })
    insertTodo({ id: 'zz-child', parentId: 'p-parent' })
    expect(ids(todos.listChildren('p-parent'))).toEqual(['aa-child', 'zz-child'])
  })

  it('G6 回执：11 条同刻子任务，列的 10 条稳定（id 正序的前 10 条）', () => {
    const parent = 'p-parent'
    insertTodo({ id: parent, status: 'in_progress' })
    /** 反向插：id 最小的最后插，若按插入序截就会截错人 */
    for (let i = 10; i >= 0; i--) {
      insertTodo({ id: `k${String(i).padStart(2, '0')}`, parentId: parent, title: `子任务${i}` })
    }

    const msg = ((): string => {
      try {
        todos.update({ id: parent, status: 'done' })
      } catch (e) {
        return (e as Error).message
      }
      throw new Error('预期被 G6 拦下，但它放过了')
    })()

    expect(msg).toContain('子任务0')
    expect(msg).toContain('子任务9')
    expect(msg, '第 11 条（id 最大）不该进这 10 条').not.toContain('子任务10')
    expect(msg).toContain('另有 1 条')

    /** 换成正向插：列出来的还是同样那 10 条 */
    db.prepare('DELETE FROM todos WHERE parent_id = ?').run(parent)
    for (let i = 0; i <= 10; i++) {
      insertTodo({ id: `k${String(i).padStart(2, '0')}`, parentId: parent, title: `子任务${i}` })
    }
    const again = ((): string => {
      try {
        todos.update({ id: parent, status: 'done' })
      } catch (e) {
        return (e as Error).message
      }
      throw new Error('预期被 G6 拦下，但它放过了')
    })()
    expect(again).toBe(msg)
  })

  it('listRejectedFor：同刻两条，回执按 tr.id 倒序，且与插入序无关', () => {
    const seed = (first: boolean): void => {
      for (const t of ['todo_comments', 'todo_transitions', 'todos']) db.prepare(`DELETE FROM ${t}`).run()
      const rows = [
        { todo: 'aa-rejected', tr: 'aa-tr' },
        { todo: 'zz-rejected', tr: 'zz-tr' }
      ]
      for (const r of first ? rows : [...rows].reverse()) {
        insertTodo({ id: r.todo, status: 'in_progress' })
        db.prepare(
          `INSERT INTO todo_transitions (id, todo_id, from_status, to_status, actor, created_at)
           VALUES (?, ?, 'awaiting_review', 'in_progress', 'human', ?)`
        ).run(r.tr, r.todo, INSTANT)
        db.prepare(
          `INSERT INTO todo_comments (id, todo_id, author_type, author_id, body, kind, created_at)
           VALUES (?, ?, 'human', 'human', '驳回：口径不符', 'reject', ?)`
        ).run(`c-${r.tr}`, r.todo, INSTANT)
      }
    }

    seed(true)
    expect(ids(todos.listRejectedFor(null)), '同刻的两条谁在前不能由隐式顺序决定').toEqual([
      'zz-rejected',
      'aa-rejected'
    ])

    seed(false)
    expect(ids(todos.listRejectedFor(null)), '插入序反过来，结论必须一样').toEqual([
      'zz-rejected',
      'aa-rejected'
    ])
  })

  it('listHandoffProposals：同刻提交的两条按 id 正序，且与插入序无关', () => {
    const projectId = projects.create({ name: '试验项目' }).id
    const insert = (id: string): void => {
      db.prepare(
        `INSERT INTO project_handoff_proposals
           (id, project_id, body, original_body, base_revision, proposer, status, created_at)
         VALUES (?, ?, '新正文', '旧正文', 0, 'agent:probe', 'pending', ?)`
      ).run(id, projectId, INSTANT)
    }

    insert('zz-handoff')
    insert('aa-handoff')
    expect(ids(projects.listHandoffProposals())).toEqual(['aa-handoff', 'zz-handoff'])

    db.prepare('DELETE FROM project_handoff_proposals').run()
    insert('aa-handoff')
    insert('zz-handoff')
    expect(ids(projects.listHandoffProposals())).toEqual(['aa-handoff', 'zz-handoff'])
  })

  it('listProposals（协议 / 规则 / 档案）：同刻提交的两条按 id 正序，且与插入序无关', () => {
    const insertProtocol = (id: string): void => {
      db.prepare(
        `INSERT INTO protocol_proposals
           (id, scope, project_id, block_key, body, proposer, status, created_at)
         VALUES (?, 'global', NULL, 'handoff', '新正文', 'agent:probe', 'pending', ?)`
      ).run(id, INSTANT)
    }
    const insertRule = (id: string): void => {
      db.prepare(
        `INSERT INTO rule_proposals
           (id, scope, project_id, category, rule_key, proposed_enforcement, original_enforcement,
            base_updated_at, proposer, status, created_at)
         VALUES (?, 'global', NULL, 'flow', 'G6', 'notice', 'block', NULL, 'agent:probe', 'pending', ?)`
      ).run(id, INSTANT)
    }
    const insertProfile = (id: string): void => {
      db.prepare(
        `INSERT INTO profile_proposals
           (id, scope, project_id, block_key, body, proposer, status, created_at)
         VALUES (?, 'global', NULL, 'about-me', '新正文', 'agent:probe', 'pending', ?)`
      ).run(id, INSTANT)
    }

    for (const [table, insert, read] of [
      ['protocol_proposals', insertProtocol, () => ids(protocol.listProposals())],
      ['rule_proposals', insertRule, () => ids(rules.listProposals())],
      ['profile_proposals', insertProfile, () => ids(profile.listProposals())]
    ] as [string, (id: string) => void, () => string[]][]) {
      db.prepare(`DELETE FROM ${table}`).run()
      insert('zz-prop')
      insert('aa-prop')
      expect(read(), `${table}：同刻两条谁在前不能由隐式顺序决定`).toEqual(['aa-prop', 'zz-prop'])

      db.prepare(`DELETE FROM ${table}`).run()
      insert('aa-prop')
      insert('zz-prop')
      expect(read(), `${table}：插入序反过来，结论必须一样`).toEqual(['aa-prop', 'zz-prop'])
    }
  })

  it('release detail：同刻收口的两条按 id 正序，且与插入序无关', () => {
    const projectId = projects.create({ name: '试验项目' }).id
    releases.create({ version: '1.0.109', projectId })

    insertTodo({ id: 'zz-fix', fixedInVersion: '1.0.109', projectId })
    insertTodo({ id: 'aa-fix', fixedInVersion: '1.0.109', projectId })
    expect(ids(releases.detail(projectId, '1.0.109')!.todos)).toEqual(['aa-fix', 'zz-fix'])

    db.prepare('DELETE FROM todos').run()
    insertTodo({ id: 'aa-fix', fixedInVersion: '1.0.109', projectId })
    insertTodo({ id: 'zz-fix', fixedInVersion: '1.0.109', projectId })
    expect(ids(releases.detail(projectId, '1.0.109')!.todos)).toEqual(['aa-fix', 'zz-fix'])
  })

  it('源码闸门：库里凡按时间排的 ORDER BY 都有兜底键（migrations.ts 之外一处不剩）', () => {
    const dir = path.join(root, 'src/main/database')
    /**
     * 判据：`ORDER BY` 子句里出现 `created_at` / `updated_at` 时，同一子句必须出现
     * 兜底键（`id` / `rowid` / `rid` / `seq` / `version`，允许带表别名前缀）。
     *
     * 只管时间键的排序：`archived ASC, sort_order ASC` 那类（B 组，另有卡登记）
     * 与 `ORDER BY n DESC`（Top-N 计数）不在本卡范围。
     */
    const TIME = /(created_at|updated_at)/
    const KEY = /(^|[\s,])([a-z_]+\.)?(id|rowid|rid|seq|version)\b/i
    const scan = (file: string): string[] => {
      const out: string[] = []
      fs.readFileSync(path.join(dir, file), 'utf8')
        .split(/\r?\n/)
        .forEach((line, i) => {
          const at = line.indexOf('ORDER BY')
          if (at < 0) return
          const clause = line.slice(at)
          if (!TIME.test(clause) || KEY.test(clause)) return
          out.push(`${file}:${i + 1} ${clause.trim()}`)
        })
      return out
    }

    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.ts') && f !== 'migrations.ts')
    expect(files.length, '目录扫描不出文件说明路径写错了，闸门会变成永远绿的假闸门').toBeGreaterThan(5)
    const missing = files.flatMap(scan)
    expect(missing, '这些时间排序缺兜底次序键（DESC 配 , id DESC；ASC 配 , id ASC）').toEqual([])

    /**
     * migrations.ts 被排除，但它的 2 处要**数得清**：
     * 数量变了就说明"排除"被扩大了，得回来看这张卡的说明。
     */
    const inMigrations = scan('migrations.ts')
    expect(inMigrations.length, 'migrations.ts 里没有兜底键的时间排序数量变了').toBe(2)
    expect(inMigrations.join('\n')).toContain('ORDER BY created_at ASC')
  })
})
