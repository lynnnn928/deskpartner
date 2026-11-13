import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke, on } from './ipc-client'
import { useAgentStore } from '../stores/agent.store'
import { useProjectStore } from '../stores/project.store'
import {
  ONBOARDING_STEP_ORDER,
  getOnboardingStatus,
  isOnboardingCoreDone,
  onboardingStepDone,
  type OnboardingAgentState,
  type OnboardingBlockState,
  type OnboardingStatus
} from './onboarding'

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
/**
 * 第三、四步的「提议到哪一步了」
 *
 * 这两步不是人自己去写：助手先跟你聊，把档案 / 约定用 `profile propose`、
 * `protocol propose` 提到审批页，人再到那一页**采纳**。所以清单要能说出
 * 当前真实状态 —— 无提议（等它提）、有提议待采纳（去审批页）、已采纳（打勾）。
 */
export interface OnboardingProposalState {
  /** 有还没处理的档案提议 */
  profilePending: boolean
  /** 有还没处理的约定提议 */
  protocolPending: boolean
  /** 采纳过助手的档案提议 */
  profileAdopted: boolean
  /** 采纳过助手的约定提议 */
  protocolAdopted: boolean
}

export interface OnboardingSnapshot {
  status: OnboardingStatus
  /** 项目之前那四步（接入 / 批准 / 关于我 / 约定）是否全绿 —— 决定清单条要不要收起 */
  coreDone: boolean
  /** 已完成项数（含可选项），给进度显示用 */
  doneCount: number
  /** 助手提议的状态（第三、四步的当前真实状态从这里读） */
  proposals: OnboardingProposalState
  reload: () => void
}

const EMPTY: OnboardingStatus = {
  hasRegisteredAgent: false,
  hasApprovedAgent: false,
  hasApprovedCredential: false,
  basicsConfirmed: false,
  globalProtocolConfirmed: false,
  projectHandoffConfirmed: false
}

const NO_PROPOSALS: OnboardingProposalState = {
  profilePending: false,
  protocolPending: false,
  profileAdopted: false,
  protocolAdopted: false
}

/** 提案行只关心这几格（`profile:proposals` / `protocol:proposals` 的形状） */
interface ProposalRow {
  status?: string
  scope?: string
  projectId?: string | null
}

/**
 * 从提案清单里读「有没有待采纳 / 采纳过没有」
 *
 * 只认**全局**那一层（`projectId` 为空）：清单第三、四步说的就是全局档案与全局约定，
 * 项目层覆盖是另一个页面的事，混进来会让一项目级提议把上手清单点绿。
 */
function proposalStateOf(rows: ProposalRow[] | null | undefined): {
  pending: boolean
  adopted: boolean
} {
  const global = (rows ?? []).filter((row) => !row.projectId && (row.scope ?? 'global') === 'global')
  return {
    pending: global.some((row) => row.status === 'pending'),
    adopted: global.some((row) => row.status === 'approved')
  }
}

/**
 * @param freshAgents 调用方手里更新鲜的身份清单（审批页刚批准完就是这种情况）
 *
 * 判据仍从真实数据推算，但"哪一份数据"要让调用方选：审批页的 `agent:list`
 * 是刚拉回来的，全局 store 可能要等下一轮广播 —— 用旧的那份算，回执会指着
 * 「批准它的身份」，而人一秒钟前刚点过那颗按钮。
 */
export function useOnboardingStatus(freshAgents?: OnboardingAgentState[]): OnboardingSnapshot {
  const agents = useAgentStore((s) => s.agents)
  const projects = useProjectStore((s) => s.projects)
  const [profileBlocks, setProfileBlocks] = useState<OnboardingBlockState[]>([])
  const [protocolBlocks, setProtocolBlocks] = useState<OnboardingBlockState[]>([])
  const [proposals, setProposals] = useState<OnboardingProposalState>(NO_PROPOSALS)
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
      /** 第三、四步要说出「无提议 / 有提议待采纳 / 已采纳」，所以连提案一起读 */
      try {
        const [profileProposals, protocolProposals] = (await Promise.all([
          invoke('profile:proposals'),
          invoke('protocol:proposals')
        ])) as unknown as [ProposalRow[] | null, ProposalRow[] | null]
        if (!aliveRef.current) return
        const profile = proposalStateOf(profileProposals)
        const protocol = proposalStateOf(protocolProposals)
        setProposals({
          profilePending: profile.pending,
          protocolPending: protocol.pending,
          profileAdopted: profile.adopted,
          protocolAdopted: protocol.adopted
        })
      } catch {
        /* 读不到提案就按"无提议"说，不打断页面 */
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

  const statusAgents = freshAgents ?? agents
  const status = statusAgents
    ? getOnboardingStatus(statusAgents, profileBlocks, protocolBlocks, projects)
    : EMPTY
  const coreDone = isOnboardingCoreDone(status)
  /**
   * 计数算**界面上真有那一步**的五项，判据取自 `onboardingStepDone`。
   *
   * 1.0.146 走查时，`basicsConfirmed`（主用户基本情况）只在用户页那份清单里有行，
   * 「我的工作」停在 4/5 却只有四行可做，于是计数被砍到四步。主用户否掉了那个做法：
   * 屏上少一行不是修法，是把「还有一份关于自己的档案要填」这件事藏起来了。
   * 现在清单补回「关于我」那一行，计数按五个布尔数。
   *
   * ⚠️ 别改回 `Object.values(status).length`：`status` 里还有诊断用的
   * `hasApprovedCredential`（用户页的设置清单要它），数它会把 5 步算成 6 步。
   */
  const done = onboardingStepDone(status)
  const doneCount = ONBOARDING_STEP_ORDER.filter((key) => done[key]).length

  return { status, coreDone, doneCount, proposals, reload }
}
