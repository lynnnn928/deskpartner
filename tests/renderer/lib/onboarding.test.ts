import { describe, expect, it } from 'vitest'
import {
  ONBOARDING_STEP_ORDER,
  ONBOARDING_STEP_TITLES,
  getOnboardingStatus,
  nextOnboardingStep,
  onboardingStepDone
} from '../../../src/renderer/lib/onboarding'
import { PROJECT_HANDOFF_TEMPLATE } from '../../../src/renderer/types/project'

const protocolKeys = ['roles', 'handoff', 'recording', 'communication', 'language']

describe('新用户上手清单状态', () => {
  it('不把注册当批准，也不把未确认建议当成用户事实', () => {
    const status = getOnboardingStatus(
      [{ approved: false, hasCredential: true }],
      [{ blockKey: 'basics', body: '称呼：Alex', confirmed: false }],
      protocolKeys.map((blockKey) => ({ blockKey, body: '默认内容', confirmed: false }))
    )
    expect(status).toEqual({
      hasRegisteredAgent: true,
      hasApprovedAgent: false,
      hasApprovedCredential: false,
      basicsConfirmed: false,
      globalProtocolConfirmed: false,
      projectHandoffConfirmed: false
    })
  })

  /**
   * 主用户 2026-11-13 当场抓到的错：「接入打勾不就是批准身份了吗，
   * 怎么还要批准身份呢？」
   *
   * 两件事分开了：第 1 步的勾只代表"它来了"（已登记），第 2 步只认批准。
   * 凭据（`agent credential`）是助手下次连上时自己领的，人批准完不能停在原地。
   */
  it('第 1 步叫「让助手来申请」，一登记就打勾，但不算放行', () => {
    expect(ONBOARDING_STEP_TITLES.agent).toBe('让助手来申请')
    const registered = getOnboardingStatus([{ approved: false, hasCredential: false }], [], [])
    expect(onboardingStepDone(registered)).toMatchObject({ agent: true, approved: false })
    // 下一步就是"由你决定放不放行"
    expect(nextOnboardingStep(registered)).toBe('approved')
  })

  it('批准了就勾第 2 步：凭据还没到手也不等它', () => {
    expect(ONBOARDING_STEP_TITLES.approved).toBe('批准它的身份')
    const approvedNoCredential = getOnboardingStatus([{ approved: true, hasCredential: false }], [], [])
    // 批准 = 打勾；凭据还是"没到手"（只作提示，不参与判据）
    expect(approvedNoCredential.hasApprovedAgent).toBe(true)
    expect(approvedNoCredential.hasApprovedCredential).toBe(false)
    expect(onboardingStepDone(approvedNoCredential).approved).toBe(true)
    // 清单要往前走，不能停在刚点过的那一步：批准后的下一步是档案，不是项目
    expect(nextOnboardingStep(approvedNoCredential)).toBe('basics')
  })

  it('判据表正好是五步，诊断用的字段不混进来（防计数变成 n/6）', () => {
    const status = getOnboardingStatus([{ approved: true, hasCredential: false }], [], [])
    const done = onboardingStepDone(status)
    expect(Object.keys(done)).toHaveLength(5)
    expect(Object.values(done).filter(Boolean)).toHaveLength(2)
  })

  it('只有已批准且持凭据、已确认基本档案和全部全局协议块才完成对应项', () => {
    const status = getOnboardingStatus(
      [{ approved: true, hasCredential: true }],
      [{ blockKey: 'basics', body: '称呼：Alex', confirmed: true }],
      protocolKeys.map((blockKey) => ({ blockKey, body: '已确认内容', confirmed: true })),
      [{ archived: false, handoffMarkdown: '# 项目接手说明' }]
    )
    expect(Object.values(status).every(Boolean)).toBe(true)
  })

  /**
   * 卡 `821568fa`：`project add` 建项目时默认塞一份章节骨架
   * （`src/main/cli/commands/project.ts:173`），只判"非空"会让刚建完项目
   * 就被算成"接手说明已确认"。原样骨架不算填过。
   */
  it('接手说明原样是模板时不算完成', () => {
    const status = getOnboardingStatus(
      [{ approved: true, hasCredential: true }],
      [{ blockKey: 'basics', body: '称呼：Alex', confirmed: true }],
      protocolKeys.map((blockKey) => ({ blockKey, body: '内容', confirmed: true })),
      [{ archived: false, handoffMarkdown: PROJECT_HANDOFF_TEMPLATE }]
    )
    expect(status.projectHandoffConfirmed).toBe(false)
  })

  it('接手说明在模板上补了内容就算完成', () => {
    const status = getOnboardingStatus(
      [],
      [],
      [],
      [{ archived: false, handoffMarkdown: PROJECT_HANDOFF_TEMPLATE + '\n\n# 项目目标\n把这个仓库的文档收成一本。\n' }]
    )
    expect(status.projectHandoffConfirmed).toBe(true)
  })

  /**
   * 卡 `aa5f5222`：审批页批准完要说出"下一步是哪一行"
   *
   * 那句话必须由清单当前行算出来（主用户：「文案按当前真实清单状态给，别写死」）。
   * 顺序是产品定的（2026-11-14 主用户拍板，判据出处是开场提示词）：
   * 接入 → 批准 → 写下关于我 → 确认协作约定 → 写清项目接手说明。
   * **建项目排在最后**：她原话是「审批结束之后，才看有无项目、要不要接入项目」，
   * 「而不是上来注册审批完就直接建第一个项目」。
   */
  it('清单当前行随真实状态推进，全部做完时没有下一步', () => {
    const empty = getOnboardingStatus([], [], [])
    expect(nextOnboardingStep(empty)).toBe('agent')

    const registered = getOnboardingStatus([{ approved: false, hasCredential: true }], [], [])
    expect(nextOnboardingStep(registered)).toBe('approved')

    // 批准之后是档案与约定，不是项目 —— 哪怕项目一个都还没有
    const approvedNoProfile = getOnboardingStatus(
      [{ approved: true, hasCredential: true }],
      [],
      [],
      [{ archived: false, handoffMarkdown: '# 项目接手说明 / 目标：把文档收成一本' }]
    )
    expect(nextOnboardingStep(approvedNoProfile)).toBe('basics')

    // 档案采纳后才轮到约定
    const profileDone = getOnboardingStatus(
      [{ approved: true, hasCredential: true }],
      [{ blockKey: 'basics', body: '称呼：Alex', confirmed: true }],
      protocolKeys.map((blockKey) => ({ blockKey, body: '默认内容', confirmed: false }))
    )
    expect(nextOnboardingStep(profileDone)).toBe('protocol')
    expect(ONBOARDING_STEP_TITLES.protocol).toBe('确认协作约定')

    // 约定也采纳了，才轮到项目那一步 —— 标题跟判据走（接手说明有内容才算）
    const protocolDone = getOnboardingStatus(
      [{ approved: true, hasCredential: true }],
      [{ blockKey: 'basics', body: '称呼：Alex', confirmed: true }],
      protocolKeys.map((blockKey) => ({ blockKey, body: '内容', confirmed: true }))
    )
    expect(nextOnboardingStep(protocolDone)).toBe('handoff')
    expect(ONBOARDING_STEP_TITLES.handoff).toBe('写清项目接手说明')

    const allDone = getOnboardingStatus(
      [{ approved: true, hasCredential: true }],
      [{ blockKey: 'basics', body: '称呼：Alex', confirmed: true }],
      protocolKeys.map((blockKey) => ({ blockKey, body: '内容', confirmed: true })),
      [{ archived: false, handoffMarkdown: '# 项目接手说明 / 目标：把文档收成一本' }]
    )
    expect(nextOnboardingStep(allDone)).toBeNull()
  })

  it('五步顺序是产品设计顺序：项目排在最后', () => {
    expect(ONBOARDING_STEP_ORDER).toEqual(['agent', 'approved', 'basics', 'protocol', 'handoff'])
    expect(ONBOARDING_STEP_TITLES.basics).toBe('写下关于我')
  })

  it('空基本档案和缺失的协议块不会误报完成', () => {
    const status = getOnboardingStatus(
      [{ approved: true, hasCredential: true }],
      [{ blockKey: 'basics', body: '', confirmed: true }],
      protocolKeys.slice(0, 4).map((blockKey) => ({ blockKey, body: '内容', confirmed: true }))
    )
    expect(status.basicsConfirmed).toBe(false)
    expect(status.globalProtocolConfirmed).toBe(false)
  })
})
