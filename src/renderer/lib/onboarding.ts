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

/**
 * 清单的五步及其名字 —— **唯一出处**（卡 `a19054a1`）
 *
 * 为什么从组件里提出来：1.0.148 起审批页批准完要说「下一步是什么」，
 * 那句话必须是清单当前行（主用户的原话：「文案按当前真实清单状态给，别写死」）。
 * 两处各留一份顺序或一份标题，迟早一处改了另一处还在念旧步骤名。
 */
export type OnboardingStepKey = 'agent' | 'approved' | 'basics' | 'protocol' | 'handoff'

export const ONBOARDING_STEP_TITLES: Record<OnboardingStepKey, string> = {
  agent: '接入 AI 助手',
  approved: '批准它的身份',
  basics: '写下关于我',
  protocol: '确认协作约定',
  handoff: '建第一个项目'
}

/** 主线三步（没有项目接手说明之前，后两步都还不该出现） */
const STAGE_MAIN: OnboardingStepKey[] = ['agent', 'approved', 'handoff']
/** 第二阶段：主线走完后才问关于我、协作约定 */
const STAGE_REST: OnboardingStepKey[] = ['basics', 'protocol']

/** 五步全表（全部做完、用户又点开清单看一遍时按这个顺序列） */
export const ONBOARDING_STEP_ORDER: OnboardingStepKey[] = [...STAGE_MAIN, ...STAGE_REST]

/** 主线的三步是否全绿 —— 决定清单停在第一段还是第二段 */
export function isOnboardingCoreDone(status: OnboardingStatus): boolean {
  return status.hasRegisteredAgent && status.hasApprovedCredential && status.projectHandoffConfirmed
}

/** 清单此刻列出的那几行（按显示顺序） */
export function onboardingStageKeys(status: OnboardingStatus): OnboardingStepKey[] {
  return isOnboardingCoreDone(status) ? STAGE_REST : STAGE_MAIN
}

/**
 * 清单当前行 —— 也就是「下一步做什么」的唯一答案
 *
 * 全部做完时返回 null：那时清单不再指路，页面该说"都做完了"而不是编一步出来。
 */
export function nextOnboardingStep(status: OnboardingStatus): OnboardingStepKey | null {
  const done: Record<OnboardingStepKey, boolean> = {
    agent: status.hasRegisteredAgent,
    approved: status.hasApprovedCredential,
    basics: status.basicsConfirmed,
    protocol: status.globalProtocolConfirmed,
    handoff: status.projectHandoffConfirmed
  }
  return onboardingStageKeys(status).find((key) => !done[key]) ?? null
}

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
