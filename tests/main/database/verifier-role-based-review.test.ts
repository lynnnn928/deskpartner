import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { readCliChain } from '../cli/cli-chain'
import Database from 'better-sqlite3'
import { runMigrations } from '../../../src/main/database/migrations'
import { TodoRepository } from '../../../src/main/database/todo.repository'
import { CategoryRepository } from '../../../src/main/database/category.repository'
import { ProjectRepository } from '../../../src/main/database/project.repository'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const db = new Database(':memory:')
vi.mock('../../../src/main/database/index', () => ({ getDatabase: () => db }))

/**
 * 验收按「角色」定权，不按「身份」（`a6032512`，Carol 10-05 提，10-06 拍板不拆版一起做）
 *
 * ## 为什么改（Carol给的实测，不是推演）
 *
 * 原规则按**身份**定权：`awaiting_review → done` 一律只能由人在界面上点。
 * 实测后果：**10-05 复验的 7 张里 5 张卡在"等人点完成"**，
 * 而产品负责人**只能验界面/体验类问题，CLI 与内部机制类缺陷无法验证**。
 * 也就是说"等人点"这条规则在多数场景下**不可执行** ——
 * G10 于是从一道闸门退化成"什么都得等我"，而我等不了。
 *
 * **"人一律得当裁判"不如"运动员不当裁判"**：
 * 前者假设有一个人能验所有东西（不成立），后者只要求验的人不是做的那个。
 *
 * ## 三个角色
 *
 * ���出者（谁记的）/ 执行者（谁干的）/ **验收者**（谁判它做完了）
 * 默认验收者 = 提出者 —— 多数卡是 agent 提、人执行，
 * 于是"验收者 ≠ 执行者"天然成立；而"自己提出自己验收"只��**显式指定**时才可能出现。
 */
describe('验收按角色定权（a6032512）', () => {
  let todos: TodoRepository

  beforeAll(() => {
    runMigrations(db)
    db.pragma('foreign_keys = OFF')
  })

  beforeEach(() => {
    db.prepare('DELETE FROM todos').run()
    // ⚠️ 分类与项目要**每次重建**：`todos.create` 会解析分类，
    // 而我 DELETE 了 todos —— 若分类也没了，建卡会抛「还没有任何分类」。
    // 第一版忘了重建，9 条用例集体红，报错却指向"字段没存进去" —— 方向完全错。
    db.prepare('DELETE FROM categories').run()
    db.prepare('DELETE FROM projects').run()
    new CategoryRepository().create({ name: '默认', color: '#111', sortOrder: 0 })
    new ProjectRepository().create({ name: 'P' })
    todos = new TodoRepository()
  })

  const mk = (over: Record<string, unknown> = {}) =>
    todos.create({ title: '一条待办', projectId: null, createdBy: 'agent:alice', ...over } as never)

  it('schema 升到 26，且 verifier 列真的存在', () => {
    const cols = db.prepare('PRAGMA table_info(todos)').all() as { name: string }[]
    expect(
      cols.map((c) => c.name),
      '迁移没跑（类型加了但列不存在）—— 判据：类型加了不等于存得进去'
    ).toContain('verifier')
  })

  it('DB_VERSION 与迁移条数一致（加迁移忘了升版本号 = 迁移永不执行）', () => {
    const src = readFileSync(join(__dirname, '../../../src/renderer/lib/constants.ts'), 'utf-8')
    const v = Number(src.match(/DB_VERSION\s*=\s*(\d+)/)?.[1])
    const mig = readFileSync(join(__dirname, '../../../src/main/database/migrations.ts'), 'utf-8')
    const count = (mig.match(/^  \(db\) => \{/gm) ?? []).length
    expect(
      v,
      `DB_VERSION=${v} 但迁移有 ${count} 条 —— 迁移数组比版本号多出的那些永远不会跑`
    ).toBe(count)
  })

  it('存量回填：verifier 默认取 created_by', () => {
    const t = mk()
    expect(todos.getById(t.id)!.verifier).toBe('agent:alice')
  })

  it('显式指定 verifier 存得进、读得出、update 改得动', () => {
    const t = mk({ executedBy: 'human', verifier: 'agent:qwen' })
    expect(todos.getById(t.id)!.verifier).toBe('agent:qwen')
    expect(todos.list()[0].verifier).toBe('agent:qwen')
    todos.update({ id: t.id, verifier: 'agent:other' } as never)
    expect(todos.getById(t.id)!.verifier).toBe('agent:other')
  })

  it('【核心】验收者 ≠ 执行者 → 放行（不再一律等人在界面点）', () => {
    const t = mk({ status: 'awaiting_review', executedBy: 'human' })
    expect(() =>
      todos.update({ id: t.id, status: 'done', actor: 'agent:alice' })
    ).not.toThrow()
    expect(todos.getById(t.id)!.status).toBe('done')
  })

  it('运动员当裁判仍被拒：执行者不能验收自己做的事', () => {
    const t = mk({ status: 'awaiting_review', executedBy: 'agent:alice' })
    expect(() =>
      todos.update({ id: t.id, status: 'done', actor: 'agent:alice' })
    ).toThrow(/G10/)
  })

  it('显式把 verifier 设成执行者 → 仍被拒（那条守卫按角色判，不看是谁）', () => {
    const t = mk({ status: 'awaiting_review', executedBy: 'agent:alice', verifier: 'agent:alice' })
    expect(() =>
      todos.update({ id: t.id, status: 'done', actor: 'agent:alice' })
    ).toThrow(/G10/)
  })

  it('拒绝后状态不变（不留"看起来成功"的半截改动）', () => {
    const t = mk({ status: 'awaiting_review', executedBy: 'agent:alice' })
    try {
      todos.update({ id: t.id, status: 'done', actor: 'agent:alice' })
    } catch {
      /* 预期被拒 */
    }
    expect(todos.getById(t.id)!.status).toBe('awaiting_review')
  })

  it('报错要指路（换个验收者），不是只说不许', () => {
    const t = mk({ status: 'awaiting_review', executedBy: 'agent:alice' })
    try {
      todos.update({ id: t.id, status: 'done', actor: 'agent:alice' })
      throw new Error('本该被拒')
    } catch (e) {
      const msg = (e as Error).message
      expect(msg).toContain('verifier')
      expect(msg, '报错要给出路').toContain('出路')
    }
  })

  it('GUI 侧不受本守卫管（人在界面上点一律放行，那是"人"不是"角色"）', () => {
    const t = mk({ status: 'awaiting_review', executedBy: 'agent:alice' })
    expect(() =>
      todos.update({ id: t.id, status: 'done', source: 'gui' } as never)
    ).not.toThrow()
  })

  it('没进过「待验收」的不受管（记录自己做完的事照旧）', () => {
    const t = mk({ status: 'in_progress', executedBy: 'agent:alice' })
    expect(() =>
      todos.update({ id: t.id, status: 'done', actor: 'agent:alice' })
    ).not.toThrow()
  })

  it('CLI 暴露 --verifier（add 与 update 都有）', () => {
    const src = readCliChain()
    const n = (src.match(/flag: '--verifier'/g) ?? []).length
    expect(n, '--verifier 只在一处声明，另一条命令用不了').toBeGreaterThanOrEqual(2)
    // 传值也要接上：参数声明了不传值等于没有
    expect(
      src.includes("flags['--verifier']"),
      'CLI 声明了 --verifier 却没有把值传给 repo —— 声明了不生效'
    ).toBe(true)
  })

  it('说明书改口：不再是"只能由人在界面上完成"', () => {
    const src = readFileSync(join(__dirname, '../../../src/main/cli/agent-guide.ts'), 'utf-8')
    expect(
      src.includes('只在界面上完成') || src.includes('由人在界面上完成'),
      '说明书还在教旧规则（验收只能人点）'
    ).toBe(false)
    expect(src.includes('verifier') || src.includes('验收者'), '说明书要讲清按角色定权').toBe(true)
  })
})
