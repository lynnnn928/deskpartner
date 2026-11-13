import { describe, expect, it } from 'vitest'
import { getOnboardingStatus } from '../../../src/renderer/lib/onboarding'
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
      hasApprovedCredential: false,
      basicsConfirmed: false,
      globalProtocolConfirmed: false,
      projectHandoffConfirmed: false
    })
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
