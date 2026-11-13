import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke, on } from './ipc-client'
import { useAgentStore } from '../stores/agent.store'
import { useProjectStore } from '../stores/project.store'
import { getOnboardingStatus, type OnboardingBlockState, type OnboardingStatus } from './onboarding'

/**
 * 上手清单的状态（卡 `a19054a1`）
 *
 * 判据全部从**已保存的真实数据**推算，不另存引导进度：
 * - 助手与项目在 store 里（`agent.store` / `project.store`）
 * - 档案与协议要现拉（`profile:get` / `protocol:get`），它们没有全量 store
 *
 * 跨视图刷新：`profile:*` / `protocol:*` 改完主进程目前不发 `dataChanged`
 * （只有 todo/project/settings… 会发），所以这里在「窗口重新获得焦点」时补一次拉取 ——
 * 用户在用户页确认完协议、切回「我的工作」就能看到勾。
 * 等主进程补上广播后，这条兜底仍可保留（幂等、开销是两次只读查询）。
 */
export interface OnboardingSnapshot {
  status: OnboardingStatus
  /** 必做的三步（接入 / 批准 / 首个项目）是否全绿 —— 用来决定清单条要不要收起 */
  coreDone: boolean
  /** 已完成项数（含可选项），给进度显示用 */
  doneCount: number
  reload: () => void
}

const EMPTY: OnboardingStatus = {
  hasRegisteredAgent: false,
  hasApprovedCredential: false,
  basicsConfirmed: false,
  globalProtocolConfirmed: false,
  projectHandoffConfirmed: false
}

export function useOnboardingStatus(): OnboardingSnapshot {
  const agents = useAgentStore((s) => s.agents)
  const projects = useProjectStore((s) => s.projects)
  const [profileBlocks, setProfileBlocks] = useState<OnboardingBlockState[]>([])
  const [protocolBlocks, setProtocolBlocks] = useState<OnboardingBlockState[]>([])
  const aliveRef = useRef(true)

  const reload = useCallback(() => {
    void (async () => {
      try {
        const profile = (await invoke('profile:get')) as unknown as { blocks?: OnboardingBlockState[] } | null
        if (aliveRef.current) setProfileBlocks(profile?.blocks ?? [])
      } catch {
        /* 读不到就按"没填"处理，不打断页面 */
      }
      try {
        const protocol = (await invoke('protocol:get')) as unknown as { blocks?: OnboardingBlockState[] } | null
        if (aliveRef.current) setProtocolBlocks(protocol?.blocks ?? [])
      } catch {
        /* 同上 */
      }
    })()
  }, [])

  useEffect(() => {
    aliveRef.current = true
    reload()
    /**
     * 测试桩可能只 mock 了 invoke（很多既有用例如此），这时 on 是 undefined；
     * 订阅失败不该让整块界面挂掉 —— 少了实时刷新，还有下面的窗口聚焦兜底。
     */
    let unsubscribe: (() => void) | undefined
    try {
      unsubscribe = on('event:dataChanged', () => reload())
    } catch {
      unsubscribe = undefined
    }
    const onFocus = (): void => reload()
    window.addEventListener('focus', onFocus)
    return () => {
      aliveRef.current = false
      unsubscribe?.()
      window.removeEventListener('focus', onFocus)
    }
  }, [reload])

  const status = agents
    ? getOnboardingStatus(agents, profileBlocks, protocolBlocks, projects)
    : EMPTY
  const coreDone = status.hasRegisteredAgent && status.hasApprovedCredential && status.projectHandoffConfirmed
  /**
   * 计数只算**界面上真有那一步**的四项。
   *
   * 原来直接数 status 的五个布尔，其中 `basicsConfirmed`（主用户基本情况）
   * 只在用户页那份清单里有行 —— 于是「我的工作」里永远停在 4/5，屏上写着 x/5
   * 却只有四行可做（1.0.146 走查实测）。
   */
  const doneCount = [
    status.hasRegisteredAgent,
    status.hasApprovedCredential,
    status.globalProtocolConfirmed,
    status.projectHandoffConfirmed
  ].filter(Boolean).length

  return { status, coreDone, doneCount, reload }
}
