import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '../../../src/main/database/migrations'
import { TodoRepository } from '../../../src/main/database/todo.repository'
import { CategoryRepository } from '../../../src/main/database/category.repository'
import { ProjectRepository } from '../../../src/main/database/project.repository'

const db = new Database(':memory:')
vi.mock('../../../src/main/database/index', () => ({ getDatabase: () => db }))

/**
 * 登记前去重提示（`84efa995`）
 *
 * ## 它治的病（提单给的证据）
 *
 * **三方正经都犯过**：
 * - qwen 的 `c3a798c8` / `180928cf` 同义重复
 * - 我 09-30 同秒造过两条逐字相同（`ee24bd55` / `20430c0c`）
 * - 有一条标题本身就写着"（重复登记，已挂起）"
 *
 * **三方都在犯，说明这不是"谁不小心"，是产品缺这道闸。**
 * 而主用户说过"数清单总数"是她的决策依据之一 ——
 * 重复项会让她把工作量算错，**那是输入污染了判断依据**。
 *
 * ## ⚠️ 阈值不是拍的，是在真实库上量出来的
 *
 * 我先在真实库上量了五对**已知真重复**的 dice 得分：
 *
 * | 对 | dice | 形状 |
 * |---|---|---|
 * | `c6144e0e`‖`e44454d7` | 1.00 | 逐字相同 |
 * | `2d920c07`‖`e096014d` | 1.00 | 逐字相同 |
 * | `f25fd12f`‖`5e0dd131` | 1.00 | 逐字相同 |
 * | `ee24bd55`‖`20430c0c` | 0.74 | 近逐字（一条带「（重复登记）」括注） |
 * | `c3a798c8`‖`180928cf` | **0.30** | **同义改写** |
 *
 * 而假阳性那边（「主测试卡」vs「子任务」、「操作审计视图」vs「日历视图」）
 * dice 只有 0.25~0.29。
 *
 * **⇒ 单一阈值做不到不漏报也不误报。** 所以分两档：
 * ① dice ≥ 0.7 抓逐字/近逐字（覆盖 4/5）
 * ② 标题带「重复」字样 → 显式提示（人自己已经说明了意图）
 *
 * 同义改写那一档（0.2~0.4）**故意不检** ——
 * 那个区间与假阳性重叠，强行检会变成"每建一条都报重复"，
 * **一个天天误报的提醒等于没有提醒。**
 */
describe('登记前去重提示（84efa995）', () => {
  let todos: TodoRepository

  beforeAll(() => {
    runMigrations(db)
  })

  beforeEach(() => {
    db.prepare('DELETE FROM todos').run()
    db.prepare('DELETE FROM todo_transitions').run()
    db.prepare('DELETE FROM categories').run()
    db.prepare('DELETE FROM projects').run()
    new CategoryRepository().create({ name: '默认', color: '#111', sortOrder: 0 })
    new ProjectRepository().create({ name: 'P' })
    todos = new TodoRepository()
  })

  const seed = (title: string) =>
    todos.create({ title, projectId: null } as never)

  describe('用真实库里的五对真重复当素材', () => {
    it('逐字相同（dice 1.00）—— 必须检出', () => {
      seed('动态视图返工：改成关键节点流，每条写清「谁·做了什么·什么时候」')
      const hits = todos.findSimilar('动态视图返工：改成关键节点流，每条写清「谁·做了什么·什么时候」')
      expect(hits.length, '逐字重复必须检出').toBeGreaterThan(0)
    })

    it('近逐字 + 一条带「（重复登记）」括注（dice 0.74）—— 必须检出', () => {
      seed('1.0.62 内容：GUI 留痕读入口（变更记录 = 流转 + 审计合并成一条时序）')
      const hits = todos.findSimilar(
        '（重复登记，已挂起）1.0.62 内容：GUI 留痕读入口—— 见 ee24bd55'
      )
      expect(hits.length, '括注不该影响判重 —— 它正是「登记重了」的标记').toBeGreaterThan(0)
    })

    /**
     * 同义改写（dice 0.30）—— **1.0.70 改了这条断言**
     *
     * ⚠️ 它原来断言「标题带『重复』字样就该报出来」——
     * **而那正是Bob驳回的行为**：档二无条件放行，
     * 于是带「重复」二字的无辜卡也被报出来（他实测命中 3 条不相干的）。
     *
     * ⇒ 现在：`+0.15` 的加权**不足以越过 0.7 门槛**，
     * 所以"同义改写 + 显式标记"这种弱信号**不报**。
     *
     * **这是有意的取舍**：宁可漏报也不要误报 ——
     * 「提醒越不准，agent 越快学会无视它」（qwen 原话，也是 `3df42f82` 的道理）。
     * 真要抓同义改写，得靠描述/评论的语义相似度，那不是这一档的职责。
     */
    it('同义改写（dice 0.30）即使带「重复」字样也不报（宁漏不误）', () => {
      seed('零 emoji 规范未覆盖 CLI：用户可见 9 处仍在（清单说「仅 2 处」不准确）')
      const byScore = todos.findSimilar('禁 emoji 扩到 CLI —— 见 c3a798c8')
      expect(byScore.length, '相似度不够就不该报').toBe(0)
      const byMarker = todos.findSimilar('（重复登记）禁 emoji 扩到 CLI')
      expect(
        byMarker.length,
        '弱信号不足以越过门槛 —— 这是 1.0.70 刻意改的（qwen 驳回）'
      ).toBe(0)
    })
  })

  it('相似度档自己就能抓近逐字（不靠「重复」字样兜底）', () => {
    /**
     * ⚠️ 这条是为了**验档一真的在干活**。
     * 反向验证时我发现：把相似度档关掉，「近逐字」那条**仍然绿** ——
     * 因为它的标题里带了「（重复登记）」，被档二兜住了。
     * **那意味着我从来没验过"0.7 这个阈值抓不抓得住 0.74 那一档"。**
     *
     * 判据：**闸门要能区分"被机制抓到"与"被别的路径兜住"** ——
     * 全绿不代表每个分支都被覆盖。
     */
    seed('1.0.62 内容：GUI 留痕读入口（变更记录 = 流转 + 审计合并成一条时序）')
    // 标题里**不带**「重复」二字 → 只有相似度档能命中
    const hits = todos.findSimilar('1.0.62 内容：GUI 留痕读入口')
    expect(hits.length, '近逐字（dice 0.74）应被相似度档抓到').toBeGreaterThan(0)
    expect(hits[0].reason).toMatch(/相似度/)
  })

  describe('不该误报的情形（比能报更重要）', () => {
    /**
   * Bob的原始复现（1.0.70 修）—— 他用真看板数据实测驳回
   *
   * **他的复现**：建一条标题带「重复标题测试」的卡，
   * 回执给出「检出 3 条疑似重复」，其中两条标题**根本没有"重复"二字**，
   * 而三条理由文案统一写着「标题里带了「重复」字样」。
   *
   * **根因（我查到的）**：档二（标题含"重复"字样）**无条件返回最近 3 条**，
   * 不管相似度 —— 它把"意图信号"当成了"命中判定"。
   *
   * **他的判断我完全接受**：
   * 「后果比没闸更糟 —— 提醒越不准，agent 越快学会无视它。」
   *
   * 改法：**档二只影响排序（+0.15 加权），不越过 0.7 的门槛**。
   * 排序变、门槛不变 —— 降门槛换来的召回会以误报为代价。
   */
  it('标题含「重复」字样时，不该拉出毫不相干的卡（qwen 实测的误报）', () => {
    seed('MCP 工具表从 dp schema 自动生成（现在只有 8 个、收口路径断了）')
    seed('材料缺口 6 项：卡已废但缺口还在，先核哪些还欠着')
    seed('登记前去重缺闸：三方都在造重复卡')
    // Bob的探针：标题带「重复」二字，但内容与那三条无关
    const hits = todos.findSimilar('v70探针（本轮清）自撤与去重闸 重复标题测试')
    expect(
      hits.length,
      `命中 ${hits.length} 条 —— 档二越过了相似度门槛`
    ).toBe(0)
  })

  it('真重复仍能报出（修误报不能把真阳性也修掉）', () => {
    const t = seed('登记前去重缺闸：三方都在造重复卡，--search 只搜标题、产品无相似提示')
    const hits = todos.findSimilar('登记前去重缺闸：三方都在造重复卡，--search 只搜标题、产品无相似提示')
    expect(hits.length, '几乎逐字相同却报不出来 = 修过头了').toBe(1)
    expect(hits[0].todo.id).toBe(t.id)
  })

  it('理由要能回答"凭什么是它"（相似度 + 命中片段）', () => {
    seed('登记前去重缺闸：三方都在造重复卡，--search 只搜标题、产品无相似提示')
    const hits = todos.findSimilar('登记前去重缺闸：三方都在造重复卡，--search 只搜标题、产品无相似提示')
    expect(hits[0].reason, '只给百分比 = 调用方仍不知道该看哪段文字').toMatch(/共同片段/)
    expect(hits[0].reason).toMatch(/相似度/)
  })

  it('同前缀但不同事的（「主测试卡」vs「子任务」）—— 不报', () => {
      seed('【Carol体验02】主测试卡（已改名）')
      const hits = todos.findSimilar('【Carol体验02】子任务')
      expect(hits.length, '这俩共享前缀但不是重复 —— 报了就成噪音').toBe(0)
    })

    it('同类但不同事的（「操作审计视图」vs「日历视图」）—— 不报', () => {
      seed('操作审计视图（R4-4）')
      const hits = todos.findSimilar('日历视图（R4-7）')
      expect(hits.length, '共享后缀而已，不是重复').toBe(0)
    })

    it('完全不同的标题 —— 不报', () => {
      seed('把「项目」做厚：承载知识沉淀')
      const hits = todos.findSimilar('预设面板 2 个参数到不了界面')
      expect(hits.length).toBe(0)
    })

    it('太短的标题不参与判重（4 字以下判不准，噪音大于价值）', () => {
      seed('修复')
      const hits = todos.findSimilar('修')
      expect(hits.length, '2 字标题判重必然误报').toBe(0)
    })
  })

  it('只提醒不拦：命中也不影响新卡被建出来', () => {
    const first = seed('动态视图返工：改成关键节点流')
    const second = seed('动态视图返工：改成关键节点流')
    expect(second.id).not.toBe(first.id)
    // findSimilar 本身不改任何数据
    const before = todos.list().length
    todos.findSimilar('动态视图返工：改成关键节点流')
    expect(todos.list().length, 'findSimilar 是只读的').toBe(before)
  })

  it('提示里带得出可操作的信息（id 短号 + 状态 + 判据）', () => {
    seed('动态视图返工：改成关键节点流，每条写清「谁·做了什么·什么时候」')
    const hits = todos.findSimilar('动态视图返工：改成关键节点流，每条写清「谁·做了什么·什么时候」')
    expect(hits[0].todo.id).toBeTruthy()
    expect(hits[0].todo.status).toBeTruthy()
    expect(hits[0].reason, '要说清凭什么判它重复').toMatch(/相似度|重复/)
  })

  it('返回条数有上限（别一次报 20 条）', () => {
    for (let i = 0; i < 6; i++) seed('动态视图返工：改成关键节点流')
    const hits = todos.findSimilar('动态视图返工：改成关键节点流', 3)
    expect(hits.length).toBeLessThanOrEqual(3)
  })

  it('自己不会把自己当重复（对照自己查重时不该命中自己）', () => {
    const t = seed('动态视图返工：改成关键节点流')
    // ⚠️ 必须传 excludeId —— 调用方（todo add）是刚建完这张再来查的，
    // 不排除自己就会自己报自己重复。我第一版没传，红了一条。
    const hits = todos.findSimilar(t.title, 3, t.id)
    expect(hits.map((h) => h.todo.id), '自己不该被算成重复').not.toContain(t.id)
  })
})
