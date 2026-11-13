import { PROJECT_HANDOFF_TEMPLATE } from '../types/project'

export interface OnboardingAgentState {
  approved: boolean
  hasCredential: boolean
}

export interface OnboardingBlockState {
  blockKey: string
  body: string
  confirmed: boolean
}

export interface OnboardingProjectState {
  archived?: boolean
  handoffMarkdown?: string | null
}

export interface OnboardingStatus {
  hasRegisteredAgent: boolean
  hasApprovedCredential: boolean
  basicsConfirmed: boolean
  globalProtocolConfirmed: boolean
  projectHandoffConfirmed: boolean
}

const REQUIRED_PROTOCOL_BLOCKS = ['roles', 'handoff', 'recording', 'communication', 'language'] as const

/** Five transparent onboarding checks, derived only from persisted product state. */
export function getOnboardingStatus(
  agents: OnboardingAgentState[],
  profileBlocks: OnboardingBlockState[],
  globalProtocolBlocks: OnboardingBlockState[],
  projects: OnboardingProjectState[] = []
): OnboardingStatus {
  const basics = profileBlocks.find((block) => block.blockKey === 'basics')
  return {
    hasRegisteredAgent: agents.length > 0,
    hasApprovedCredential: agents.some((agent) => agent.approved && agent.hasCredential),
    basicsConfirmed: Boolean(basics?.body.trim()) && Boolean(basics?.confirmed),
    globalProtocolConfirmed: REQUIRED_PROTOCOL_BLOCKS.every((key) =>
      globalProtocolBlocks.some((block) => block.blockKey === key && block.confirmed)
    ),
    /**
     * 通过正式项目资料判断：接手说明只有在保存/采纳后才进入 projects。
     *
     * ⚠️ `project add` 建项目时会**默认塞进一份章节骨架**
     * （`src/main/cli/commands/project.ts:173` 写 `PROJECT_HANDOFF_TEMPLATE`），
     * 只判"非空"会让"刚建完项目"就被算成"接手说明已确认"——
     * 清单上一项假绿，用户也没被提醒去填目标、边界和下一步。
     * 所以原样的骨架不算填过（卡 `821568fa`）。
     */
    projectHandoffConfirmed: projects.some(
      (project) =>
        !project.archived &&
        Boolean(project.handoffMarkdown?.trim()) &&
        project.handoffMarkdown!.trim() !== PROJECT_HANDOFF_TEMPLATE.trim()
    )
  }
}
