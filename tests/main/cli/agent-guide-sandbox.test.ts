import { describe, it, expect, beforeAll } from 'vitest'
import { readCliChain } from './cli-chain'
import Database from 'better-sqlite3'
import { runMigrations } from '../../../src/main/database/migrations'

const db = new Database(':memory:')

/**
 * 外部 agent 不知道隔离设施存在（1.0.65 补 `cb659bce`，主用户 10-05 决策「采纳A」）
 *
 * ## 缺口是怎么发现的（不是"想到要加"，是实测撞出来的）
 *
 * 隔离设施早就有（`DESKPARTNER_DATA_DIR` + `scripts/lib/isolated-app.mjs`），
 * 主用户拍板采纳 A 方案时它已经落地。10-05 查授权账发现：
 *
 * - 我的 destructive 授权最近一条是 **09-30** → A 方案对我完全生效
 * - 库里的 `todo_deleted` 事件最近一次是**当天 04:24**，actor = **`agent:bob`**
 *   → 外部 agent 仍在真实库里删自己的探针
 *
 * **判据：能力存在 ≠ 对方知道它存在。**
 * `agent-guide` 是外部 agent 唯一的入口（它们不读我的 skill），
 * 没写在那里��能力，对它们等于不存在。
 */
describe('隔离指引必须写在 agent 唯一读得到的那个入口（cb659bce）', () => {
  // 命令表 1.0.112 起拆成多个模块（卡 bbeb1b51）：判据要读**整条命令链**
  const GUIDE = readCliChain()

  beforeAll(() => {
    // 反向验证的前提：闸门自身必须能跑通
    runMigrations(db)
    expect(typeof db.prepare).toBe('function')
  })

  it('guide 对象里有 sandbox 这一节（隔离指引的落点）', () => {
    const src = GUIDE
    expect(src, '缺少 sandbox 节 → 外部 agent 无从知道隔离怎么用').toContain('sandbox: {')
  })

  it('sandbox 写在 candidatePool 之后、ownership 之前（紧邻同类"你会踩的坑"）', () => {
    const src = GUIDE
    const pool = src.indexOf('candidatePool: {')
    const sandbox = src.indexOf('sandbox: {')
    const ownership = src.indexOf('ownership: {')
    expect(pool, 'candidatePool 不见了').toBeGreaterThan(-1)
    expect(sandbox, 'sandbox 不见了').toBeGreaterThan(-1)
    expect(ownership, 'ownership 不见了').toBeGreaterThan(-1)
    expect(
      sandbox,
      '顺序错了：sandbox 应在 candidatePool 之后、ownership 之前'
    ).toBeGreaterThan(pool)
    expect(sandbox).toBeLessThan(ownership)
  })

  it('必须同时给出 DATA_DIR 与 NO_PIPE，缺一个就等于没隔离', () => {
    const src = GUIDE
    const i = src.indexOf('sandbox: {')
    const j = src.indexOf('ownership: {', i)
    const block = src.slice(i, j)
    expect(block, '缺 DESKPARTNER_DATA_DIR → 会写进真实库').toContain('DESKPARTNER_DATA_DIR')
    expect(
      block,
      '缺 DESKPARTNER_NO_PIPE=1 → 会连上用户正在跑的实例，副本形同虚设'
    ).toContain('DESKPARTNER_NO_PIPE')
  })

  it('必须说明"删整个目录不需要授权"，否则对方仍会逐条 todo rm', () => {
    const src = GUIDE
    const i = src.indexOf('sandbox: {')
    const block = src.slice(i, src.indexOf('ownership: {', i))
    expect(
      block,
      '未说明"删目录免授权" → 对方仍会走逐条删除（实测累计 86 条销毁授权、15 条过期）'
    ).toMatch(/不需要任何删除授权|不需要任何授权|删目录不需要/)
  })

  it('必须显式禁止"用标题正则去生产库捞探针删"（那是 86 条授权的成因）', () => {
    const src = GUIDE
    const i = src.indexOf('sandbox: {')
    const block = src.slice(i, src.indexOf('ownership: {', i))
    expect(
      block,
      '未禁止标题正则捞探针 → 探针一开始就在用户看板里，删除还要另要授权'
    ).toMatch(/别用标题正则|标题正则/)
  })
})
