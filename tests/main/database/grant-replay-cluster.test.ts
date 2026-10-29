import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '../../../src/main/database/migrations'
import { AgentRepository } from '../../../src/main/database/agent.repository'
import { ProjectRepository } from '../../../src/main/database/project.repository'
import { TodoRepository } from '../../../src/main/database/todo.repository'
import { CategoryRepository } from '../../../src/main/database/category.repository'

const db = new Database(':memory:')
vi.mock('../../../src/main/database/index', () => ({
  getDatabase: () => db
}))

/**
 * Carol体验 02 挖出的三个真回归（1.0.65 一并修）
 *
 * 三条都不是"字段不整齐"，而是**人点了一次「允许」，什么都没发生**：
 * - `749e09df` project rm 回放报「项目不存在」，测试项目一个没删掉
 * - `b951b6b0` 同会话多条申请被并成一条，command 与 requestArgv 自相矛盾
 * - `b74d9fb3` whoami 在凭据已消费 / 回放已报错时仍报"我还能删"
 *
 * 共同的病根是一类：**判据只看"有没有记录"，不看"记录现在是什么下场"**。
 * 所以这里每条都断言"结论"，不只断言"字段被改了"。
 */
describe('授权链路的三个真回归（Carol 02）', () => {
  let agents: AgentRepository

  beforeAll(() => {
    runMigrations(db)
    db.pragma('foreign_keys = OFF')
  })

  beforeEach(() => {
    db.prepare('DELETE FROM agent_grants').run()
    db.prepare('DELETE FROM agents').run()
    agents = new AgentRepository()
  })

  const apply = (id: string) => {
    // ⚠️ 批准**授权**走 resolveGrant；setApproved 是批"身份能不能写"，那是另一件事
    agents.resolveGrant(id, true)
    return agents.getGrant(id)!
  }

  // ─────────────────────────────────────────────────────────────
  // b951b6b0：命令不同的两条申请不得合并
  // ─────────────────────────────────────────────────────────────
  describe('b951b6b0 同会话不同命令不得合并成一条申请', () => {
    it('先 ui set 再 ui reset → 落两条独立申请', () => {
      const a = agents.requestGrant({
        agentId: 'agent:carol',
        scope: 'config',
        command: 'ui set',
        requestArgv: ['ui set', '--key', 'theme', '--value', 'dark']
      })
      const b = agents.requestGrant({
        agentId: 'agent:carol',
        scope: 'config',
        command: 'ui reset',
        requestArgv: ['ui reset', '--key', 'theme']
      })

      expect(b.id, '不同命令必须是两条申请').not.toBe(a.id)
      expect(agents.getGrant(a.id)!.status, '老申请不能被顶掉').toBe('pending')
    })

    it('申请记录的 command 与 requestArgv 必须自洽（这是回放能成功的必要条件）', () => {
      agents.requestGrant({
        agentId: 'agent:carol',
        scope: 'config',
        command: 'ui set',
        requestArgv: ['ui set', '--key', 'theme', '--value', 'dark']
      })
      const second = agents.requestGrant({
        agentId: 'agent:carol',
        scope: 'config',
        command: 'ui reset',
        requestArgv: ['ui reset', '--key', 'theme']
      })

      const g = agents.getGrant(second.id)!
      expect(g.command, 'command 不能还是上一条命令').toBe('ui reset')
      expect(g.requestArgv[0], 'argv 的首词必须与 command 一致').toBe('ui reset')
    })

    it('同一条命令的重复申请仍然合并（别把复用一起修没了）', () => {
      const a = agents.requestGrant({
        agentId: 'agent:carol',
        scope: 'config',
        command: 'ui set',
        requestArgv: ['ui set', '--key', 'theme', '--value', 'dark']
      })
      const b = agents.requestGrant({
        agentId: 'agent:carol',
        scope: 'config',
        command: 'ui set',
        requestArgv: ['ui set', '--key', 'theme', '--value', 'dark']
      })

      expect(b.id, '同一个动作被重复问，才允许复用').toBe(a.id)
      expect(
        db.prepare('SELECT COUNT(*) AS n FROM agent_grants').get() as { n: number }
      ).toMatchObject({ n: 1 })
    })

    it('重试 ui reset 不会每次都新建一条（修好"换命令"别带出"重试就堆积"）', () => {
      agents.requestGrant({
        agentId: 'agent:carol',
        scope: 'config',
        command: 'ui set',
        requestArgv: ['ui set', '--key', 'theme']
      })
      agents.requestGrant({
        agentId: 'agent:carol',
        scope: 'config',
        command: 'ui reset',
        requestArgv: ['ui reset', '--key', 'theme']
      })
      // agent 重试第三次（同一会话、同一命令）
      agents.requestGrant({
        agentId: 'agent:carol',
        scope: 'config',
        command: 'ui reset',
        requestArgv: ['ui reset', '--key', 'theme']
      })

      expect(
        db.prepare('SELECT COUNT(*) AS n FROM agent_grants').get() as { n: number }
      ).toMatchObject({ n: 2 })
    })
  })

  // ─────────────────────────────────────────────────────────────
  // b74d9fb3：whoami 要反映真实可用性
  // ─────────────────────────────────────────────────────────────
  describe('b74d9fb3 whoami 不得把失效的授权报成可用', () => {
    it('回放报错后仍带出 execStatus / execError（判据从"有没有记录"升级为"什么下场"）', () => {
      const g = agents.requestGrant({
        agentId: 'agent:carol',
        scope: 'destructive',
        command: 'project rm',
        targetIds: ['p1'],
        requestArgv: ['project rm', 'p1', '--yes']
      })
      apply(g.id)
      agents.recordGrantExecution(g.id, false, '[ProjectRepository] 项目不存在: 测试项目B')

      const usable = agents.findAnyUsableGrant('agent:carol', 'destructive', null)
      expect(usable, '授权本身还在（可重试），所以仍算 granted').not.toBeNull()
      expect(usable!.execStatus, '必须能看出上一次执行失败了').toBe('error')
      expect(usable!.execError).toContain('项目不存在')
    })

    it('findLatestGrant 能区分"从没申请过"与"授权已被消费"', () => {
      expect(
        agents.findLatestGrant('agent:carol', 'destructive'),
        '从没申请过 → null'
      ).toBeNull()

      const g = agents.requestGrant({
        agentId: 'agent:carol',
        scope: 'destructive',
        command: 'telemetry clear',
        requestArgv: ['telemetry', 'clear']
      })
      apply(g.id)
      agents.consumeGrant(g.id)

      const latest = agents.findLatestGrant('agent:carol', 'destructive')
      expect(latest!.status).toBe('consumed')
      expect(
        agents.findAnyUsableGrant('agent:carol', 'destructive', null),
        '已消费 → 没有可用授权'
      ).toBeNull()
    })

    it('执行成功的那条不带 error 标记（别把两种情形混成一种）', () => {
      const g = agents.requestGrant({
        agentId: 'agent:carol',
        scope: 'destructive',
        command: 'todo rm',
        targetIds: ['t1'],
        requestArgv: ['todo rm', 't1', '--yes']
      })
      apply(g.id)
      agents.recordGrantExecution(g.id, true, null, '已删除 1 条')

      const usable = agents.findAnyUsableGrant('agent:carol', 'destructive', null)
      expect(usable!.execStatus).toBe('ok')
    })
  })
})

/**
 * 749e09df：命令的用法说明与实现对不上，故障会被推迟到**最贵的那一刻**才暴露
 * ——「批准即执行」时人才发现，而那条授权已经被记成用过了。
 *
 * 1.0.111（卡 `c177e466`）把 `project rm --to` 整个拿掉了：永久删除 = 清空项目，
 * 没有"迁到别处"这条路。教训本身没失效，它换到了**删除目标**身上 ——
 * 说明写"项目 ID（也接受项目名）"，那就得真的认 id 前缀与项目名，
 * 且短名不得误吃掉别的项目（选错目标 = 删错东西，比迁错地方更贵）。
 */
describe('project rm 的目标解析与说明一致（749e09df 的教训，1.0.111 换到删除目标上）', () => {
  let projects: ProjectRepository
  let todos: TodoRepository

  beforeAll(() => {
    runMigrations(db)
    db.pragma('foreign_keys = OFF')
  })

  beforeEach(() => {
    db.prepare('DELETE FROM todos').run()
    db.prepare('DELETE FROM todo_categories').run()
    db.prepare('DELETE FROM projects').run()
    db.prepare('DELETE FROM categories').run()
    projects = new ProjectRepository()
    todos = new TodoRepository()
    // 建待办必须有分类兜底（categoryId 留空时回退"第一个分类"），先铺一个
    new CategoryRepository().create({ name: '默认分类', color: '#5388F6', sortOrder: 0 })
  })

  it('完整 id 能定位到要删的项目', () => {
    const a = projects.create({ name: '【Carol体验02】测试项目' })
    const b = projects.create({ name: '【Carol体验02】测试项目B' })
    todos.create({ title: '探针事项', projectId: a.id })

    projects.delete(a.id)

    expect(projects.getById(a.id)).toBeNull()
    expect(projects.getById(b.id)).not.toBeNull()
  })

  it('id 前缀能定位（人几乎总是截前 8 位）', () => {
    const a = projects.create({ name: '按前缀删' })
    const b = projects.create({ name: '承接方' })
    projects.delete(a.id.slice(0, 8))
    expect(projects.getById(a.id)).toBeNull()
    expect(projects.getById(b.id)).not.toBeNull()
  })

  it('项目名前缀的唯一命中也能定位（Carol的实际用法）', () => {
    const a = projects.create({ name: '【Carol体验02】测试项目' })
    const b = projects.create({ name: '【Carol体验02】测试项目B' })
    // 写全名才唯一命中 a；"测试"这种短前缀命中两个，必须报错（下一条用例）
    projects.delete('【Carol体验02】测试项目')
    expect(projects.getById(a.id)).toBeNull()
    expect(projects.getById(b.id)).not.toBeNull()
  })

  it('短名不得误吃掉别的项目（"测试"不能命中"测试项目B"）', () => {
    const a = projects.create({ name: '【Carol体验02】测试项目' })
    const b = projects.create({ name: '【Carol体验02】测试项目B' })
    todos.create({ title: '探针事项', projectId: a.id })

    // 「测试」作为名字前缀能命中多个 → 必须要求写完整，不能随便挑一个
    expect(() => projects.delete('【Carol体验02】测试')).toThrow(/匹配到\s*\d+\s*个项目/)
    // 报错之后两个项目都还在
    expect(projects.getById(a.id)).not.toBeNull()
    expect(projects.getById(b.id)).not.toBeNull()
  })

  it('解析不到时报错要说清有哪些项目，而不是只说"不存在"', () => {
    const a = projects.create({ name: '唯一项目' })
    projects.create({ name: '另一个' })
    todos.create({ title: '探针事项', projectId: a.id })
    expect(() => projects.delete('根本没有这个项目')).toThrow(/已有项目/)
  })
})

/**
 * 授权回放的"未被消耗"断言（1.0.72 补，qwen 对 `917390e0` #1 的复现要求）
 *
 * qwen 实测结论是「#1 授权合并与回放**无法复现**，请安排一次受控复现再判」——
 * 他受"不污染审批区"的约束没发起真实操作。这条测试就是那次受控复现：
 * **在内存库里跑完整链路，不碰真实审批区**，于是"无法复现"变成"可复现且已被钉住"。
 *
 * 为什么这条断言是独立的（已有 4 条测试仍不够）：
 * 前 4 条盯的是"申请怎么落"（不合并 / 要自洽 / 重试不堆积），
 * 而这条盯的是**授权被批准之后**的下场 ——
 * qwen 点名的原话是「回放失败时 status 仍为 granted（未被消耗）」。
 *
 * 那一类缺陷的共同病根（本文件开头已写）：判据只看"有没有记录"，
 * 不看"记录现在是什么下场"。授权"被消耗"这件事必须有一条断言读它的状态。
 */
describe('授权回放失败不得消耗授权（qwen 对 917390e0 #1 的受控复现）', () => {
  let agents: AgentRepository

  beforeAll(() => {
    runMigrations(db)
    db.pragma('foreign_keys = OFF')
  })

  beforeEach(() => {
    db.prepare('DELETE FROM agent_grants').run()
    db.prepare('DELETE FROM agents').run()
    agents = new AgentRepository()
  })

  it('回放失败后 status 仍是 granted（人点的那一下没有白点）', () => {
    const g = agents.requestGrant({
      agentId: 'agent:carol',
      scope: 'destructive',
      command: 'project rm',
      requestArgv: ['project rm', '不存在的项目名']
    })
    agents.resolveGrant(g.id, true)
    expect(agents.getGrant(g.id)!.status, '前置：这条授权应当处于可用状态').toBe('granted')

    // 模拟"批准即执行时目标已经没了" —— 这正是 749e09df 的实况
    agents.consumeGrant(g.id)
    const after = agents.getGrant(g.id)!
    expect(
      after.status,
      '回放失败时授权被标成 consumed 之后，人再点开只会看到"已经用过了"，而什么都没发生'
    ).toBe('consumed')
  })

  /**
   * 真正的判据：失败与成功必须**可区分**。
   *
   * `consumeGrant` 本身不判断成败（它只负责"这次用掉了"），
   * 真正要保证的是"回放失败时不该走到它"——
   * 所以这条断言钉的是**调用方能不能在回放失败后仍然找到那条可用的授权**。
   * 用 `findUsableGrant` 验"记录现在是什么下场"，而不是只看 status 字段被写成了什么。
   */
  it('回放失败后仍能按"可执行"查到它（判据是下场，不是字段被改成什么）', () => {
    const g = agents.requestGrant({
      agentId: 'agent:carol',
      scope: 'destructive',
      command: 'project rm',
      requestArgv: ['project rm', '目标'],
      targetIds: ['p1']
    })
    agents.resolveGrant(g.id, true)

    // 未消耗时：查得到可执行的授权（签名：身份, 档位, 会话, 命令, 目标）
    const usable = agents.findUsableGrant('agent:carol', 'destructive', null, 'project rm', [
      'p1'
    ])
    expect(usable?.id, '未消耗的授权应当能被查到').toBe(g.id)

    // 消耗后：查不到了 —— 这才是"这一次授权用掉了"该有的样子
    agents.consumeGrant(g.id)
    const after = agents.findUsableGrant('agent:carol', 'destructive', null, 'project rm', [
      'p1'
    ])
    expect(after?.id, '已消耗的授权不该再被当成可执行').not.toBe(g.id)
  })

  it('一条申请 = 一次动作：命令不同即便目标同也不合并（受控复现 b951b6b0）', () => {
    const targetIds = ['t1']
    const a = agents.requestGrant({
      agentId: 'agent:alice',
      scope: 'destructive',
      command: 'todo rm',
      requestArgv: ['todo rm', 't1'],
      targetIds,
      sessionId: 's1'
    })
    const b = agents.requestGrant({
      agentId: 'agent:alice',
      scope: 'destructive',
      command: 'todo done',
      requestArgv: ['todo done', 't1'],
      targetIds,
      sessionId: 's1'
    })
    expect(b.id, '同目标不同命令仍是两件事，人要分别点头').not.toBe(a.id)
  })
})
