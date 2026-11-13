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
  /** 第 1 步：有助手来登过记（它来敲门，不代表你放行了） */
  hasRegisteredAgent: boolean
  /** 第 2 步：已经有助手被你批准 —— 凭据是助手侧的手续，不参与这一步打勾 */
  hasApprovedAgent: boolean
  /**
   * 诊断用，**不是任何一步的判据**：已有助手被批准、且凭据已到手。
   *
   * 只给用户页那份设置清单用（那一行本来就写着「已获批准并持有凭据」）。
   * 别拿它给上手清单打勾 —— 主用户 2026-11-13 抓到的正是这个：
   * 人点了批准，凭据却要等助手下次连上才领，于是清单停在第 2 行不动，
   * 看着像"批准没用"。
   */
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
 *
 * ── 每一步的「完成」是什么意思（主用户 2026-11-13 当场抓到的错）──
 *
 * 她的原话：「接入打勾不就是批准身份了吗，怎么还要批准身份呢？」
 * 第 1 步过去叫「接入 AI 助手」，判据却是**已登记**：助手一登记就勾上，
 * 而下一行还写着「批准它的身份」—— 一个勾说"已经接通"，下一步又说"还没放行"。
 * 现在两步各说一件事，标题跟着判据走：
 *
 *   让助手来申请 = 有助手来敲过门（已登记）。它来了，不代表你放行了。
 *   批准它的身份 = 你亲手点了批准（它能写你的项目了）。凭据是它自己的手续，这一步不等它。
 *   建第一个项目 = 有个项目的接手说明真填了内容（只建出空壳不算）。
 *   写下关于我   = 基本档案有内容、且你确认过。
 *   确认协作约定 = 五条约定的块全部由你确认。
 */
export type OnboardingStepKey = 'agent' | 'approved' | 'basics' | 'protocol' | 'handoff'

export const ONBOARDING_STEP_TITLES: Record<OnboardingStepKey, string> = {
  agent: '让助手来申请',
  approved: '批准它的身份',
  basics: '写下关于我',
  protocol: '确认协作约定',
  handoff: '建第一个项目'
}

/**
 * 五步各自的完成判据 —— **唯一出处**：计数、当前行、清单那五行都读它
 *
 * 单列一张表是为了让"第几步算完成"只有一处说法。写在数组里数一遍、
 * 组件里再写一遍，就会重演这次的事：判据带了 `hasCredential`，标题却写着
 * 「批准它的身份」。
 */
export function onboardingStepDone(status: OnboardingStatus): Record<OnboardingStepKey, boolean> {
  return {
    agent: status.hasRegisteredAgent,
    approved: status.hasApprovedAgent,
    basics: status.basicsConfirmed,
    protocol: status.globalProtocolConfirmed,
    handoff: status.projectHandoffConfirmed
  }
}

/** 主线三步（没有项目接手说明之前，后两步都还不该出现） */
const STAGE_MAIN: OnboardingStepKey[] = ['agent', 'approved', 'handoff']
/** 第二阶段：主线走完后才问关于我、协作约定 */
const STAGE_REST: OnboardingStepKey[] = ['basics', 'protocol']

/** 五步全表（全部做完、用户又点开清单看一遍时按这个顺序列） */
export const ONBOARDING_STEP_ORDER: OnboardingStepKey[] = [...STAGE_MAIN, ...STAGE_REST]

/** 主线的三步是否全绿 —— 决定清单停在第一段还是第二段 */
export function isOnboardingCoreDone(status: OnboardingStatus): boolean {
  return status.hasRegisteredAgent && status.hasApprovedAgent && status.projectHandoffConfirmed
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
  const done = onboardingStepDone(status)
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
    /**
     * 已批准就打勾 —— **不看凭据**。
     *
     * 凭据（`agent credential`）是助手自己的手续，要等它下一次连上才领到；
     * 人这一侧能做的只有批准。用 `approved && hasCredential` 当判据，
     * 人点完批准会看到清单原地不动（主用户 2026-11-13 实测）。
     */
    hasApprovedAgent: agents.some((agent) => agent.approved),
    /** 诊断用的那一格（用户页的设置清单读它），不参与上手清单打勾 */
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
