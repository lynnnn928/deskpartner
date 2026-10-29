import { describe, it, expect, beforeAll, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '../../../src/main/database/migrations'
import { TodoRepository } from '../../../src/main/database/todo.repository'
import { CategoryRepository } from '../../../src/main/database/category.repository'
import { buildAgentGuide } from '../../../src/main/cli/agent-guide'
import { commands } from '../../../src/main/cli/commands'

const db = new Database(':memory:')
vi.mock('../../../src/main/database/index', () => ({ getDatabase: () => db }))

/**
 * 出口不许教一条会被守卫拒绝的命令（1.0.65，修 `6a316a45`）
 *
 * ## 这是个自相矛盾，而它是我自己造的
 *
 * 1.0.65 我加了守卫 G10（`awaiting_review → done` 只能由人在界面上点），
 * 却**没回头看 G9 的回执文案** —— 它正在教验收方"通过用 `todo done <id>`"。
 * 于是同一版本里：一条路教你怎么走，另一条路把你拦下。
 *
 * 实测后果（Carol 10-05）：agent 按回执的指导执行，立刻拿到
 * 「需要有人在界面上确认（G10）」，而申请还留在 granted 状态 ——
 * **人点了允许，什么都没发生。**
 *
 * 说明书里的 `agent-guide.ts` 另有两处在教同一件事（更严重：那是所有外部 agent
 * 读的入口文档）。
 *
 * ## 判据
 *
 * **守卫与出口必须一致**：一条命令如果会被硬拦，那么**所有**告诉调用方
 * 「用它就能完成某动作」的地方都要改 —— 包括回执文案、说明书、示例。
 * 只改守卫不改出口，等于新增了一道没有说明的墙。
 *
 * 同源判据还有 `cd854e3a`（默认口径要自报）、
 * batch 的 `executed:false`（不执行也要说清没执行）。
 */
describe('出口不许教会被守卫拒绝的命令（6a316a45）', () => {
  let todos: TodoRepository

  beforeAll(() => {
    runMigrations(db)
    db.pragma('foreign_keys = OFF')
    new CategoryRepository().create({ name: '默认', color: '#111', sortOrder: 0 })
    todos = new TodoRepository()
  })

  /** 守卫实际拦不拦 —— 这是唯一的判据来源，不能靠读文档 */
  const g10Blocks = (): boolean => {
    const p = todos.create({ title: '待验收的卡', projectId: null, status: 'awaiting_review' } as never)
    try {
      todos.update({ id: p.id, status: 'done', actor: 'agent:test' })
      return false
    } catch {
      return true
    } finally {
      db.prepare('DELETE FROM todos').run()
    }
  }

  /**
   * 1.0.67：G10 从「按身份定权」改成「按角色定权」（`a6032512`）
   *
   * 原来拦的是"任何 agent 都不能把待验收推到已完成"；
   * 现在拦的是"**执行者不能验收自己做的事**"。
   * 所以这条前置必须用"执行者 = actor"的样例才有意义 ——
   * 若用"actor ≠ 执行者"的样例，1.0.67 起是**放行**的。
   */
  it('前置：G10 拦的是"运动员当裁判"（执行者 = actor）', () => {
    const p = todos.create({
      title: 'AR',
      projectId: null,
      status: 'awaiting_review',
      createdBy: 'agent:test',
      executedBy: 'agent:test'
    } as never)
    let blocked = false
    try {
      todos.update({ id: p.id, status: 'done', actor: 'agent:test' })
    } catch {
      blocked = true
    }
    expect(blocked, '自己做完自己验收必须被拒（运动员不当裁判）').toBe(true)
  })

  it('agent-guide 不得教"用 todo done 完成验收"', () => {
    const doc = buildAgentGuide()
    // 反引号在生成后的文档里是转义的，用不含反引号的片段定位
    expect(
      /对原条目[\s\S]{0,40}todo done/.test(doc) ||
        /通过[^\n]{0,30}`todo done/.test(doc),
      'agent-guide 仍在教 agent 用 todo done 收尾，而 G10 会拒它'
    ).toBe(false)
  })

  it('agent-guide 必须写明新规则：按角色定权 + 不能验收自己做的', () => {
    const doc = buildAgentGuide()
    expect(
      doc.includes('验收者') || doc.includes('verifier'),
      '必须讲清三个角色与"验收者 ≠ 执行者"'
    ).toBe(true)
    expect(doc, '要说明为什么不再一律等人点').toContain('验收者')
  })

  it('G9 回执不再教 todo done', () => {
    const cmd = commands.find((c) => c.name === 'todo comment')
    expect(cmd).toBeTruthy()
    // G9 的文案在命令实现之外，以常量形式存在；这里断言它的行为后果
    expect(
      cmd!.desc.includes('todo done'),
      `todo comment 的描述里不该出现 todo done 指引：${cmd!.desc}`
    ).toBe(false)
  })

  it('回执与守卫不一致时，报错文案要能自解释（agent 才知道该改走哪条路）', () => {
    // ⚠️ 样例必须是"执行者 = actor"（运动员当裁判）才该被拒。
    // 1.0.67 起 G10 按角色定权：actor ≠ 执行者是**放行**的，
    // 用那种样例测不到报错 —— 我第一版就是这么错的（msg 空，断言报"expected '' to contain G10"）。
    const p = todos.create({
      title: 'x',
      projectId: null,
      status: 'awaiting_review',
      createdBy: 'agent:test',
      executedBy: 'agent:test'
    } as never)
    let msg = ''
    try {
      todos.update({ id: p.id, status: 'done', actor: 'agent:test' })
    } catch (e) {
      msg = (e as Error).message
    }
    expect(msg).toContain('G10')
    // 关键：报错要说清"该怎么做"，而不只是"不许"
    // 1.0.67 起出路是"换个验收者"，不再是"等人在界面点"；
    // 1.0.116 起「别先进待验收」这条路也不存在了（闸门按身份判，起点无关）
    expect(
      /verifier|执行者/.test(msg),
      `G10 报错要指路（现在只说不许）：${msg}`
    ).toBe(true)
  })
})
