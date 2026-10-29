import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ownerLabel } from '../../../src/renderer/lib/todo-filter'
import { useAgentStore } from '../../../src/renderer/stores/agent.store'

/**
 * 同一 agent 在同一屏出现两个名字（1.0.65 修 `4050942e`）
 *
 * 症状：`AGENT_LABELS` 的 key 写成 `qwen`，实际身份是 `agent:bob`
 * → 查不到就回退成裸 id，于是详情抽屉「提出者」写 `bob`、
 * 同一屏「交给 AI」写「Bob」。真实库 121 条事项的提出者是它。
 *
 * 修法不是"把 key 改对"（那是枚举候选值的反模式，下次接新 agent 照旧错），
 * 而是让 `agents` 表成为显示名的唯一权威。
 */
describe('agent 显示名只有一个权威来源（4050942e）', () => {
  beforeEach(() => {
    useAgentStore.setState({ agents: [], loading: false })
  })

  const seed = (id: string, displayName: string) =>
    useAgentStore.setState({
      agents: [
        {
          id,
          displayName,
          color: null,
          approved: true,
          rejectedAt: null,
          hasCredential: true,
          createdAt: '2026-01-01T00:00:00.000Z',
          lastSeenAt: null,
          lastWriteAt: null
        } as never
      ]
    })

  it('库里登记的名字优先于任何硬编码表（这才是"两个名字"的根因）', () => {
    // 库里叫「Bob（East）」—— 硬编码表里根本没有这个名字
    seed('agent:bob', 'Bob（East）')
    expect(ownerLabel('agent:bob')).toBe('Bob（East）')
  })

  it('库里改名后，界面跟着变（治本：不再需要改代码）', () => {
    seed('agent:alice', 'Alice')
    expect(ownerLabel('agent:alice')).toBe('Alice')
    seed('agent:alice', '小伍')
    expect(ownerLabel('agent:alice')).toBe('小伍')
  })

  it('库里没有的新 agent 也能正确显示（接新 agent 零改动）', () => {
    seed('agent:brandnew', '新来的那个')
    expect(ownerLabel('agent:brandnew')).toBe('新来的那个')
  })

  it('store 还没加载完时回退到兜底表，不显示 undefined', () => {
    useAgentStore.setState({ agents: [], loading: false })
    expect(ownerLabel('agent:alice')).toBe('Alice')
  })

  it('库里 displayName 为空时回退兜底表（注册了但没起名字的 agent）', () => {
    seed('agent:alice', '   ')
    expect(ownerLabel('agent:alice')).toBe('Alice')
  })

  it('兜底表的 key 必须是真实身份 bob（不是猜的 qwen）', () => {
    useAgentStore.setState({ agents: [], loading: false })
    // 这条就是缺陷现场：兜底表 key 写错导致回退成裸 id
    expect(ownerLabel('agent:bob')).toBe('Bob')
  })

  it('human 那条口径不变（人名没取时回退「我」，不能被 agent 逻辑带跑）', () => {
    seed('agent:bob', 'Bob')
    expect(ownerLabel('human', 'Alex')).toBe('Alex')
    expect(ownerLabel('human', '')).toBe('我')
    expect(ownerLabel('human')).toBe('我')
  })

  it('查不到时回退成去掉前缀的 id（不返回 undefined / 空串）', () => {
    useAgentStore.setState({ agents: [], loading: false })
    const r = ownerLabel('agent:从未注册过的代理')
    expect(r).toBe('从未注册过的代理')
    expect(r).not.toBe('')
  })

  it('测试可注入假查找函数（不必真连库）', () => {
    const fake = (o: string) => (o === 'agent:x' ? '注入的名字' : null)
    expect(ownerLabel('agent:x', null, fake)).toBe('注入的名字')
  })

  it('getDisplayName 查不到时返回 null（回退交给调用方，不替它决定）', () => {
    seed('agent:alice', 'Alice')
    expect(useAgentStore.getState().getDisplayName('agent:alice')).toBe('Alice')
    expect(useAgentStore.getState().getDisplayName('agent:不存在')).toBeNull()
  })
})
