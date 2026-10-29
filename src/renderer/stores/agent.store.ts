import { create } from 'zustand'
import type { Agent } from '../types/todo'
import { invoke, on } from '../lib/ipc-client'

/**
 * 已注册 agent 名单（显示名的**唯一权威来源**）
 *
 * ## 为什么要有这个 store（1.0.65 修 `4050942e`）
 *
 * 此前 `ownerLabel` 靠一张硬编码表 `AGENT_LABELS` 翻译显示名，而那张表
 * **key 写错了**（`qwen` 而实际是 `bob`）→ 查不到就回退成去掉前缀的
 * 原始 id，于是同一个 agent 在同一屏出现两个名字：
 * 详情抽屉「提出者」写 `bob`、「交给 AI」写「Bob」。
 * 真实库有 121 条事项的提出者是 `agent:bob`。
 *
 * ## 为什么不"改对那一个 key"了事
 *
 * 那是**枚举候选值的反模式**：每接一个新 agent 都要有人记得来改这张表，
 * 忘了就复现同一个缺陷。真正的判据是"显示名只有一个来源"——
 * `agents` 表本来就是权威（显示名可编辑），前端另存一份必然对不上。
 *
 * 所以这里不修表，而是让 `ownerLabel` 改成**查 store**，硬编码表降级成
 * "store 还没加载出来"时的兜底。新接一个 agent 零改动。
 */
interface AgentState {
  agents: Agent[]
  loading: boolean

  fetchAgents: () => Promise<void>

  /**
   * 按身份取显示名（`agent:bob` → Bob）
   *
   * 查不到返回 null —— **由调用方决定回退成什么**。
   * 这里刻意不返回 `agent:xxx` 这种原始 id：那是"猜不出名字"的表现，
   * 由消费方按各自场景回退（有的地方该显示 id，有的该显示「未知」），
   * 在这一层替它们决定会把两种语义混在一起。
   */
  getDisplayName: (owner: string) => string | null
}

export const useAgentStore = create<AgentState>()((set, get) => ({
  agents: [],
  loading: false,

  fetchAgents: async () => {
    // 已在加载就别重复发：这张表在启动早期会被多个组件同时要
    if (get().loading) return
    set({ loading: true })
    try {
      const agents = await invoke('agent:list')
      set({ agents, loading: false })
    } catch {
      set({ loading: false })
    }
  },

  getDisplayName: (owner) => {
    const hit = get().agents.find((a) => a.id === owner)
    if (!hit) return null
    // 注册时没给名字、或名字被清空 → 当作"没名字"，交回调用方回退
    const name = hit.displayName?.trim()
    return name ? name : null
  }
}))

if (typeof window !== 'undefined' && window.api) {
  on('event:dataChanged', (data) => {
    /**
     * 只认 `agent_register`（注册/改名/撤销批准走这一类）与 `grant`。
     *
     * ⚠️ 别写 `data.type === 'agent'` —— 那不是事件类型里的名字，
     * 写错了编译器会报 TS2367（两个联合类型无交集），
     * 而如果当初写成 `as any` 绕过去，运行时就永远不匹配、静默不刷新。
     * 事件类型的真值在 `renderer/types/ipc.ts` 的 DataChangeType。
     */
    if (data.type === 'agent_register' || data.type === 'grant') {
      useAgentStore.getState().fetchAgents()
    }
  })
}
