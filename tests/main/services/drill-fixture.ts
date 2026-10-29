import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { runMigrations } from '../../../src/main/database/migrations'
import { DEFAULT_CATEGORIES, DB_VERSION } from '../../../src/renderer/lib/constants'

/**
 * 生成「真实形状」的演练基线库（1.0.49，修 8e238221）
 *
 * ── 为什么需要它 ──
 *
 * `backup.drill.test.ts` 是全项目**唯一**覆盖真实数据形状的测试，
 * 而它原先靠写死路径指向本机某份历史快照：
 *
 *   %APPDATA%/desk-partner/user.db.backup-v19-2026-09-22T11-13-48-110Z
 *
 * 两个问题叠在一起，让这道闸门**实际不生效**：
 * 1. 那份快照被 2026-09-22 的环境恢复消耗掉了（恢复是移动不是复制）
 *    → `skipIf` 生效 → 4 条用例静默跳过；
 * 2. `skipIf` **不报告** —— npm test 仍输出全绿，覆盖在没人注意的那天归零。
 *
 * 唯一能拦住「导入只恢复三个字段」这类回归的闸门，就这么废了。
 *
 * ── 修法 ──
 *
 * 把「真实形状」做成**合成 fixture**：形状按真实库统计复刻，
 * 内容全部是造的（不含任何真实数据）。任何机器、任何时间都跑得住。
 *
 * 形状对照（真实库 2026-09-23 实测 → 本 fixture）：
 *   总条数       267 → 200
 *   带 project   全部 → 全部（项目是必填项，这是关键约束）
 *   有描述       ~188 → ~140（含 emoji 与 376 字超长描述）
 *   已完成       ~144 → ~100
 *   有执行者     ~63  → ~50
 *   有父任务     ~27  → ~24（两层父子）
 *
 * 数量刻意取整（200 而非 267）：fixture 要能被读、被 review。
 * 判据不是"条数一样"，而是"这些形状都出现过"。
 *
 * ⚠️ 用**真实 runMigrations** 建表，不手写 CREATE TABLE ——
 * 手写的话 schema 一升级 fixture 就悄悄过期，而它恰恰是用来防这类问题的。
 * 迁移会写 `<db>.backup-v0-<stamp>` 快照，生成完一并清掉。
 */

/** 确定性伪随机（固定种子）：fixture 必须每次完全一致，否则测试会飘 */
let seed = 20260923
const rnd = (): number => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff
  return seed / 0x7fffffff
}
const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rnd() * arr.length)]
const int = (min: number, max: number): number => min + Math.floor(rnd() * (max - min + 1))

const T0 = Date.parse('2026-08-01T00:00:00.000Z')
/** 时间戳必须落在过去且彼此不同 —— 导入要保住原始时间戳，全一样就看不出失真 */
const ts = (daysAgo: number, h = 0, m = 0): string =>
  new Date(T0 + daysAgo * 86400000 + h * 3600000 + m * 60000).toISOString()

const PROJECTS = [
  { id: 'proj-0001-1111-2222-333333333333', name: 'DeskPartner', color: '#111827', sortOrder: 0 },
  { id: 'proj-0002-1111-2222-333333333333', name: '知彼', color: '#5388F6', sortOrder: 1 }
]

const AGENTS = [
  { id: 'agent:alice', displayName: 'Alice', color: '#5388F6' },
  { id: 'agent:bob', displayName: 'Bob', color: '#65C19C' }
]

/**
 * 描述模板 —— 刻意覆盖三类真实形状：
 * 1. 带 emoji（真实描述里确实有，导入要原样带回来）
 * 2. 超长（376 字级别，验证大字段不被截断）
 * 3. 多行 + markdown + 引号（换行符与转义最容易坏）
 *
 * ⚠️ 超长那条要**真的够长**：真实库最长 376 字。第一版模板实际只有 173 字
 * （字符串拼接里 `.repeat(3)` 漏掉了），于是"验证超长描述不被截断"这条
 * 断言其实什么都没验 —— 靠断言里的长度下限才抓出来。
 */
const LONG_DESC =
  ('【背景】这条是为了验证超长描述在导出导入后是否原样保留。\n\n' +
    '真实库里最长的一条约 376 字，包含多段、缩进、代码块与列表。\n\n' +
    '```bash\ndp todo list --project DeskPartner\n```\n\n' +
    '要点：\n- 换行符不能被吞\n- 反引号不能被转义坏\n- 中文与 emoji 混排要正常\n\n' +
    '结论：以上都保住了才算导入无损。\n\n' +
    '补充：这条描述还要覆盖"字段很长时 JSON 序列化会不会截断"这件事，' +
    '所以它必须显著超过普通描述的典型长度（一两百字）。') .repeat(2)

const DESCS: (string | null)[] = [
  null,
  null,
  '一句话说明。',
  '⚠️ 注意：这条描述带 emoji，导入后要原样回来。',
  '✅ 已完成，验收要点：\n1. 字段完整\n2. 时间戳不变\n3. 关联保住',
  LONG_DESC,
  '多行描述\n第二行\n第三行',
  '带 "双引号" 与 \'单引号\' 的文本，JSON 转义不能坏。'
]

const TITLES = [
  '修复导入丢字段', '补 CLI 文档', '核对看板计数', '清理测试残留',
  '授权状态机收口', '隔离开关防呆', '主题变量权威唯一', '零 emoji 覆盖 CLI',
  '备份恢复演练', '项目必填校验', '埋点口径统一', '看板筛选两层正交',
  '子任务解绑提示', '快照轮转策略', '通知中心收件箱', '统计页只读',
  '设置页三组 tabs', '审批迁用户页', 'agent 自办手续', '分级授权四档'
]

/**
 * 状态分布按真实库比例来（真实 267 条里 144 条已完成 ≈ 54%）。
 *
 * ⚠️ 不能用 `pick(STATUSES)` 均匀随机：六个状态等概率只有 ~17% 是 done，
 * 而 `completed_at` 的丢失恰恰只在 done 条目上才看得见 —— 占比太低
 * 会让"completed_at 有没有丢"这件事验不充分（第一版就是这么写的，
 * 实测只有 34 条 done，靠形状自检断言才抓出来）。
 */
const STATUS_PATTERN: (typeof STATUSES)[number][] = [
  ...Array(54).fill('done'),
  ...Array(20).fill('todo'),
  ...Array(12).fill('proposed'),
  ...Array(8).fill('in_progress'),
  ...Array(4).fill('awaiting_review'),
  ...Array(2).fill('suspended')
]
const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const
const TYPES = ['task', 'feature', 'bug'] as const

export interface FixtureShape {
  todos: number
  withProject: number
  withDescription: number
  done: number
  withExecutedBy: number
  withParent: number
  categories: number
  projects: number
  agents: number
  memos: number
}

/**
 * 把 fixture 写进给定的库连接（已迁移到最新 schema）。
 * 返回实际写入的形状统计 —— 测试拿它做断言，避免"以为造了形状其实没造"。
 */
export function seedRealisticShape(db: Database.Database): FixtureShape {
  const now = ts(0, 12)

  const insProject = db.prepare(
    'INSERT INTO projects (id, name, color, archived, sort_order, created_at) VALUES (?, ?, ?, 0, ?, ?)'
  )
  for (const p of PROJECTS) insProject.run(p.id, p.name, p.color, p.sortOrder, ts(50))

  const insAgent = db.prepare(
    'INSERT INTO agents (id, display_name, color, approved, created_at) VALUES (?, ?, ?, 1, ?)'
  )
  for (const a of AGENTS) insAgent.run(a.id, a.displayName, a.color, ts(50))

  const insCategory = db.prepare(
    'INSERT INTO categories (id, name, color, is_default, sort_order) VALUES (?, ?, ?, ?, ?)'
  )
  DEFAULT_CATEGORIES.forEach((c, i) => {
    insCategory.run(`cat-def-0000-0000-00000000000${i}`, c.name, c.color, 1, c.sortOrder)
  })
  // 12 个自定义分类，对齐真实库的 16
  for (let i = 0; i < 12; i++) {
    insCategory.run(
      `cat-cus-0000-0000-0000000000${String(i).padStart(2, '0')}`,
      `方向-${i + 1}`,
      pick(['#5388F6', '#65C19C', '#F5A623', '#C084FC']),
      0,
      4 + i
    )
  }

  const insTodo = db.prepare(
    `INSERT INTO todos
       (id, title, description, project_id, parent_id, status, priority, type,
        created_by, executed_by, due_at, remind_at, is_pinned,
        created_at, updated_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const insTag = db.prepare(
    'INSERT INTO todo_categories (todo_id, category_id) VALUES (?, ?)'
  )

  const TOTAL = 200
  const PARENTS = 24 // 其中前 24 条是顶层父需求，后 24 条挂它们下面（两层）

  const shape: FixtureShape = {
    todos: TOTAL,
    withProject: TOTAL, // 项目是必填项：一条都不能漏
    withDescription: 0,
    done: 0,
    withExecutedBy: 0,
    withParent: 0,
    categories: DEFAULT_CATEGORIES.length + 12,
    projects: PROJECTS.length,
    agents: AGENTS.length,
    memos: 0
  }

  for (let i = 0; i < TOTAL; i++) {
    const id = `todo-${String(i).padStart(4, '0')}-1111-2222-333333333333`
    const isChild = i >= PARENTS && i < PARENTS * 2
    const parentId = isChild ? `todo-${String(i - PARENTS).padStart(4, '0')}-1111-2222-333333333333` : null
    if (parentId) shape.withParent++

    const desc = pick(DESCS)
    if (desc) shape.withDescription++

    const status = i < 24 ? 'proposed' : pick(STATUS_PATTERN) // 前 24 条当父需求，统一 proposed
    if (status === 'done') shape.done++

    // 约 1/4 的条目有执行者，且执行者与提出者不同（跨主体交付的形状）
    const hasExec = i % 4 === 0
    const createdBy = i % 3 === 0 ? 'agent:alice' : i % 7 === 0 ? 'agent:bob' : 'human'
    const executedBy = hasExec ? (createdBy === 'human' ? 'agent:alice' : 'human') : null
    if (executedBy) shape.withExecutedBy++

    const created = ts(60 - (i % 50), i % 24, i % 60)
    const updated = ts(30 - (i % 25), (i + 3) % 24, (i + 7) % 60)

    insTodo.run(
      id,
      `${pick(TITLES)}（#${i + 1}）`,
      desc,
      pick(PROJECTS).id,
      parentId,
      status,
      pick(PRIORITIES),
      pick(TYPES),
      createdBy,
      executedBy,
      i % 5 === 0 ? ts(-3 + (i % 10)) : null,
      i % 9 === 0 ? ts(-1 + (i % 5)) : null,
      i % 11 === 0 ? 1 : 0,
      created,
      updated,
      status === 'done' ? updated : null
    )

    // 每条挂 1~2 个分类（真实库 267 条待办 / 268 条关联）
    insTag.run(id, pick(DEFAULT_CATEGORIES.map((_, k) => `cat-def-0000-0000-00000000000${k}`)))
    if (i % 2 === 0) {
      insTag.run(id, `cat-cus-0000-0000-0000000000${String(i % 12).padStart(2, '0')}`)
    }
  }

  // 备忘：两条，一条已读一条未读；其中一条关联待办
  const insMemo = db.prepare(
    'INSERT INTO memos (id, author, text, linked_todo_id, status, created_at, read_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  )
  insMemo.run(
    'memo-0001-1111-2222-333333333333',
    'agent:alice',
    '备忘一：未读，关联了第一条待办。',
    `todo-0000-1111-2222-333333333333`,
    'unread',
    ts(10),
    null
  )
  insMemo.run(
    'memo-0002-1111-2222-333333333333',
    'human',
    '备忘二：已读，不关联。',
    null,
    'read',
    ts(9),
    ts(8)
  )
  shape.memos = 2

  // settings 也放几条：导入要能保住界面配置
  const insSetting = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)')
  insSetting.run('theme', 'light')
  insSetting.run('stylePreset', 'frosted')
  insSetting.run('fontSizeScale', 'normal')

  // 库版本标记成最新 —— 让 drill 测试能直接用，不必再迁一次
  db.prepare('DELETE FROM _schema_version').run()
  db.prepare('INSERT INTO _schema_version (version) VALUES (?)').run(DB_VERSION)

  return shape
}

/**
 * 造一个完整的 fixture 库文件。
 *
 * 用真实迁移建表；迁移会在同目录落一份 `<db>.backup-v0-*` 快照，
 * 生成完必须清掉 —— 否则它会被当成"又一份可恢复快照"，把目录搅乱。
 */
export function createFixtureDb(dbPath: string): FixtureShape {
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  runMigrations(db)
  const shape = seedRealisticShape(db)
  db.pragma('wal_checkpoint(TRUNCATE)')
  db.close()

  // 清理迁移快照与 sidecar
  const dir = path.dirname(dbPath)
  const base = path.basename(dbPath)
  for (const f of fs.readdirSync(dir)) {
    if (f.startsWith(`${base}.backup-`)) {
      try {
        fs.unlinkSync(path.join(dir, f))
      } catch {
        /* 删不掉就算了 */
      }
    }
  }
  return shape
}
