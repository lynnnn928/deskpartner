// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import React from 'react'
import { OnboardingChecklist } from '../../../src/renderer/components/workbench/OnboardingChecklist'
import { useAgentStore } from '../../../src/renderer/stores/agent.store'
import { useProjectStore } from '../../../src/renderer/stores/project.store'
import { useSettingsStore } from '../../../src/renderer/stores/settings.store'

/**
 * 首屏上手清单（卡 `a19054a1`）
 *
 * 钉四件事：
 * ① 判据来自真实数据：没助手时 ①② 打叉，有已批准助手时打勾；
 * ② 协议"一键确认"真的逐块调 `protocol:set`，不是只改本地状态；
 * ③ 没填名字时首屏就能填（名字不再单独占一个弹窗）；
 * ④ 必做三步全绿后自动收起成一行入口，点开还能看。
 */
const invokeMock = vi.fn()

vi.mock('../../../src/renderer/lib/ipc-client', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  on: () => () => {}
}))

const protocolBlocks = [
  { blockKey: 'roles', body: '角色约定', confirmed: false },
  { blockKey: 'handoff', body: '交接约定', confirmed: false },
  { blockKey: 'recording', body: '留痕约定', confirmed: false },
  { blockKey: 'communication', body: '沟通约定', confirmed: false },
  { blockKey: 'language', body: '语言约定', confirmed: false }
]

const agentOf = (approved: boolean) => ({
  id: 'bob',
  displayName: 'Bob',
  color: null,
  approved,
  rejectedAt: null,
  hasCredential: approved,
  createdAt: '2026-11-13T00:00:00.000Z',
  lastSeenAt: null,
  lastWriteAt: approved ? '2026-11-13T00:10:00.000Z' : null,
  lastWriteCommand: null
})

beforeEach(() => {
  invokeMock.mockReset()
  invokeMock.mockImplementation(async (channel: string) => {
    if (channel === 'profile:get') return { scope: 'global', blocks: [{ blockKey: 'basics', body: '', confirmed: false }] }
    if (channel === 'protocol:get') return { scope: 'global', blocks: protocolBlocks, gates: {} }
    if (channel === 'cli:connectInfo') return { cliPath: 'C:/dp/deskpartner.cjs', cliEnvVar: 'DESKPARTNER_CLI', cliEnvAvailable: false, mcpCommand: 'C:/dp/mcp.cmd' }
    if (channel === 'protocol:set') return { ok: true }
    if (channel === 'settings:update') return {}
    return null
  })
  useAgentStore.setState({ agents: [], loading: false })
  useProjectStore.setState({ projects: [] })
  useSettingsStore.setState({
    settings: { humanName: '', humanNameAsked: true, appName: 'DeskPartner', appIcon: null } as never
  })
})

afterEach(() => {
  cleanup()
})

describe('首屏上手清单', () => {
  it('没有任何助手时：接入与批准两步未完成，并给出复制提示词与前往审批', async () => {
    render(<OnboardingChecklist />)
    await waitFor(() => expect(screen.getByTestId('onboarding-checklist')).toBeTruthy())
    expect(screen.getByTestId('onboarding-row-agent').textContent).toContain('接入你的 AI 助手')
    expect(screen.getByTestId('onboarding-action-agent').textContent).toContain('复制开场提示词')
    expect(screen.getByTestId('onboarding-action-approved').textContent).toContain('前往审批')
    expect(screen.getByText('0/4', { exact: false })).toBeTruthy()
  })

  it('已批准且持凭据的助手：批准那一步打勾、动作按钮消失', async () => {
    useAgentStore.setState({ agents: [agentOf(true)] as never, loading: false })
    render(<OnboardingChecklist />)
    await waitFor(() => expect(screen.getByTestId('onboarding-row-approved')).toBeTruthy())
    expect(screen.queryByTestId('onboarding-action-approved')).toBeNull()
  })

  it('一键确认按块调 protocol:set，确认后刷新成已确认', async () => {
    render(<OnboardingChecklist />)
    await waitFor(() => expect(screen.getByTestId('onboarding-action-protocol')).toBeTruthy())
    fireEvent.click(screen.getByTestId('onboarding-action-protocol'))
    await waitFor(() => {
      const calls = invokeMock.mock.calls.filter((c) => c[0] === 'protocol:set')
      expect(calls.length).toBe(protocolBlocks.length)
    })
    const first = invokeMock.mock.calls.find((c) => c[0] === 'protocol:set')
    expect(first?.[1]).toMatchObject({ blockKey: 'roles', confirmed: true })
  })

  it('没填名字时首屏就有输入行，保存走 settings:update', async () => {
    useSettingsStore.setState({
      settings: { humanName: '', humanNameAsked: false, appName: 'DeskPartner', appIcon: null } as never
    })
    render(<OnboardingChecklist />)
    const row = await waitFor(() => screen.getByTestId('onboarding-name-row'))
    expect(row).toBeTruthy()
    const input = row.querySelector('input') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'Alex' } })
    fireEvent.click(screen.getByText('保存'))
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith('settings:update', expect.objectContaining({ humanName: 'Alex', humanNameAsked: true }))
    )
  })

  /**
   * 这条是从退役的首启窗口搬过来的（`25caac02` 的残留）：
   * 那段提示词曾经只写"安装目录下的 resources/cli/deskpartner.cjs"，
   * 没有本机绝对路径 —— 没接过 DeskPartner 的 agent 第一步就是 `dp: command not found`。
   * 窗口没了，但"复制出去的那份必须带地址"这条判据不能跟着没。
   */
  it('复制出去的开场提示词带本机绝对路径', async () => {
    const written: string[] = []
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          written.push(text)
        }
      }
    })
    render(<OnboardingChecklist />)
    const button = await waitFor(() => screen.getByTestId('onboarding-action-agent'))
    // 地址是异步取的：等它落地再点，否则复制到的是不含绝对路径的兜底说法
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('cli:connectInfo'))
    await new Promise((r) => setTimeout(r, 30))
    fireEvent.click(button)

    await waitFor(() => expect(written).toHaveLength(1))
    expect(written[0]).toContain(JSON.stringify('C:/dp/deskpartner.cjs'))
    expect(written[0]).toContain(JSON.stringify('C:/dp/mcp.cmd'))
    expect(written[0]).not.toMatch(/\bdp (skill|agent register)/)
  })

  it('必做三步全绿后收成一行入口，点开还能看', async () => {
    useAgentStore.setState({ agents: [agentOf(true)] as never, loading: false })
    useProjectStore.setState({
      projects: [{ id: 'p1', name: '示例项目', archived: false, handoffMarkdown: '# 项目接手说明\n把文档收成一本', color: '#123456' }] as never
    })
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === 'profile:get') return { scope: 'global', blocks: [{ blockKey: 'basics', body: '称呼：Alex', confirmed: true }] }
      if (channel === 'protocol:get') return { scope: 'global', blocks: protocolBlocks.map((b) => ({ ...b, confirmed: true })), gates: {} }
      if (channel === 'cli:connectInfo') return null
      return null
    })
    render(<OnboardingChecklist />)
    const collapsed = await waitFor(() => screen.getByTestId('onboarding-checklist-collapsed'))
    expect(collapsed.textContent).toContain('接入完成')
    fireEvent.click(collapsed)
    await waitFor(() => expect(screen.getByTestId('onboarding-checklist')).toBeTruthy())
  })
})
