import { describe, expect, it } from 'vitest'
import { getOnboardingStatus } from '../../../src/renderer/lib/onboarding'

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
