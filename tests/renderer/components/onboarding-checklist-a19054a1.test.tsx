// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import React from 'react'
import { OnboardingChecklist } from '../../../src/renderer/components/workbench/OnboardingChecklist'
import { useAgentStore } from '../../../src/renderer/stores/agent.store'
import { useProjectStore } from '../../../src/renderer/stores/project.store'
import { useSettingsStore } from '../../../src/renderer/stores/settings.store'
import { useUIStore } from '../../../src/renderer/stores/ui.store'

/**
 * 首屏上手清单（卡 `a19054a1`）
 *
 * 1.0.147 按评审（`claude-opus-5-5`）重写，钉的是新的判据：
 *
 *   「用户按一下就能往前走的步骤，只写『点哪里、点完会看到什么』；
 *     只有不知道某件事他就会点错、不敢点、或点完以为没反应时，才多加一句
 *     —— 这一句只讲后果，不讲定义。」
 *
 * ① 当前步骤 ≤45 字、其余步骤只留 ≤8 字的标题（1.0.146 每行 120 字，765 字一屏）；
 * ② 同屏只有一个进度数 `n/5`，且当前行是第一件没做完的事；
 * ③ 第 1 行复制之后进等待态，不弹回原样；
 * ④ 第 3、4 行等主线三步（接入/批准/建项目）做完才出现；
 * ⑤ 五步全完成才自动收起，收起后的那行按钮不再写「接入完成」；
 * ⑥ 复制出去的两段话不是同一段。
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

/** 字数按字符数算（评审的上限就是这么给的） */
const chars = (text: string | null | undefined): number => [...(text ?? '')].length

const PROJECT = {
  id: 'p1',
  name: '示例项目',
  archived: false,
  handoffMarkdown: '# 项目接手说明\n把文档收成一本',
  color: '#123456'
}

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
  useUIStore.setState({
    mainView: 'board',
    userEntryTarget: null,
    selectedTodoId: null,
    onboardingChecklistDismissed: false,
    onboardingChecklistReopened: false
  })
  useSettingsStore.setState({
    settings: { humanName: '', humanNameAsked: true, appName: 'DeskPartner', appIcon: null } as never
  })
  window.sessionStorage.clear()
})

afterEach(() => {
  cleanup()
})

describe('首屏上手清单：只展开当前一行', () => {
  it('没有任何助手时，第 1 行是当前行：一句话 + 一个按钮', async () => {
    render(<OnboardingChecklist />)
    await waitFor(() => expect(screen.getByTestId('onboarding-checklist')).toBeTruthy())
    expect(screen.getByTestId('onboarding-row-agent').textContent).toContain('接入 AI 助手')
    expect(screen.getByTestId('onboarding-next-agent').textContent).toContain('发给你正在用的 AI 助手')
    expect(screen.getByTestId('onboarding-action-agent').textContent).toContain('复制开场提示词')
    // 它还停在"先做第 1 步"，指向审批页等于让人去看一张空列表
    expect(screen.queryByTestId('onboarding-action-approved')).toBeNull()
    expect(screen.getByText('0/5', { exact: false })).toBeTruthy()
  })

  it('当前步骤一句话不超过 45 字，其余步骤只有不超过 8 字的标题', async () => {
    useAgentStore.setState({ agents: [agentOf(false)] as never, loading: false })
    render(<OnboardingChecklist />)
    await waitFor(() => expect(screen.getByTestId('onboarding-next-approved')).toBeTruthy())
    expect(chars(screen.getByTestId('onboarding-next-approved').textContent)).toBeLessThanOrEqual(45)

    // 「接入」已经做完，只留标题：没有正文，标题短
    const doneRow = screen.getByTestId('onboarding-row-agent')
    expect(doneRow.textContent).toBe('接入 AI 助手')
    expect(chars(doneRow.textContent)).toBeLessThanOrEqual(8)

    // 还没轮到的那几步收成一行灰字路线，不再各占一段
    expect(screen.getByTestId('onboarding-upcoming').textContent).toBe('接下来：建第一个项目')
    expect(screen.queryByTestId('onboarding-next-handoff')).toBeNull()
  })

  it('第 3、4 行要等主线三步做完才出现', async () => {
    useAgentStore.setState({ agents: [agentOf(true)] as never, loading: false })
    render(<OnboardingChecklist />)
    await waitFor(() => expect(screen.getByTestId('onboarding-checklist')).toBeTruthy())
    // 助手已批准、项目还没建：这一段只有建项目那一行
    expect(screen.getByTestId('onboarding-row-handoff')).toBeTruthy()
    expect(screen.queryByTestId('onboarding-row-basics')).toBeNull()
    expect(screen.queryByTestId('onboarding-row-protocol')).toBeNull()

    cleanup()
    useProjectStore.setState({ projects: [PROJECT] as never })
    render(<OnboardingChecklist />)
    await waitFor(() => expect(screen.getByTestId('onboarding-checklist')).toBeTruthy())
    expect(screen.getByText('再花一分钟')).toBeTruthy()
    expect(screen.getByTestId('onboarding-row-basics')).toBeTruthy()
    expect(screen.getByTestId('onboarding-next-basics')).toBeTruthy()
    expect(screen.getByTestId('onboarding-upcoming').textContent).toBe('接下来：确认协作约定')
    expect(screen.queryByTestId('onboarding-row-handoff')).toBeNull()
  })

  it('第 1 行复制过之后停在等待态，并留一个「再复制一次」', async () => {
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
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('cli:connectInfo'))
    await new Promise((r) => setTimeout(r, 30))
    fireEvent.click(button)

    await waitFor(() => expect(written).toHaveLength(1))
    const next = await waitFor(() => screen.getByTestId('onboarding-next-agent'))
    expect(next.textContent).toContain('已复制')
    expect(next.textContent).toContain('这一行会自己变')
    expect(chars(next.textContent)).toBeLessThanOrEqual(45)
    expect(screen.getByTestId('onboarding-action-agent').textContent).toContain('再复制一次')
    // 等待态不会两秒后弹回原样：助手没注册就一直是它
    await new Promise((r) => setTimeout(r, 2200))
    expect(screen.getByTestId('onboarding-next-agent').textContent).toContain('已复制')
  })
})

describe('首屏上手清单：每一步指到真控件', () => {
  it('未批准的助手在申请：批准那一步给「前往审批」，正文说明批准前只能读', async () => {
    useAgentStore.setState({ agents: [agentOf(false)] as never, loading: false })
    render(<OnboardingChecklist />)
    const button = await waitFor(() => screen.getByTestId('onboarding-action-approved'))
    expect(button.textContent).toContain('前往审批')
    const hint = screen.getByTestId('onboarding-next-approved').textContent ?? ''
    expect(hint).toContain('Bob')
    expect(hint).toContain('只能读')
    fireEvent.click(button)
    expect(useUIStore.getState().mainView).toBe('approval')
  })

  it('「关于我」那一行动作用户页分区，并留下"从清单跳过来"的会话标记', async () => {
    useAgentStore.setState({ agents: [agentOf(true)] as never, loading: false })
    useProjectStore.setState({ projects: [PROJECT] as never })
    render(<OnboardingChecklist />)
    const button = await waitFor(() => screen.getByTestId('onboarding-action-basics'))
    expect(button.textContent).toContain('去写关于我')
    fireEvent.click(button)
    expect(useUIStore.getState().mainView).toBe('user')
    expect(useUIStore.getState().userEntryTarget).toMatchObject({ section: 'about' })
    expect(window.sessionStorage.getItem('deskpartner.onboardingJump.v1')).toBe('about')
  })

  it('「先看看」把用户送到协作协议分区，确认按钮才在那一页', async () => {
    useAgentStore.setState({ agents: [agentOf(true)] as never, loading: false })
    useProjectStore.setState({ projects: [PROJECT] as never })
    invokeMock.mockImplementation(async (channel: string) => {
      // 「关于我」已经写完：当前行才是第 4 步
      if (channel === 'profile:get') return { scope: 'global', blocks: [{ blockKey: 'basics', body: '称呼：Alex', confirmed: true }] }
      if (channel === 'protocol:get') return { scope: 'global', blocks: protocolBlocks, gates: {} }
      if (channel === 'cli:connectInfo') return null
      return null
    })
    render(<OnboardingChecklist />)
    const secondary = await waitFor(() => screen.getByTestId('onboarding-secondary-protocol'))
    expect(secondary.textContent).toContain('先看看')
    fireEvent.click(secondary)
    expect(useUIStore.getState().userEntryTarget).toMatchObject({ section: 'protocol' })
    expect(window.sessionStorage.getItem('deskpartner.onboardingJump.v1')).toBe('protocol')
  })

  it('一键确认按块调 protocol:set，确认后刷新成已确认', async () => {
    useAgentStore.setState({ agents: [agentOf(true)] as never, loading: false })
    useProjectStore.setState({ projects: [PROJECT] as never })
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === 'profile:get') return { scope: 'global', blocks: [{ blockKey: 'basics', body: '称呼：Alex', confirmed: true }] }
      if (channel === 'protocol:get') return { scope: 'global', blocks: protocolBlocks, gates: {} }
      if (channel === 'cli:connectInfo') return null
      if (channel === 'protocol:set') return { ok: true }
      return null
    })
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

  /**
   * 评审第 10 条：第 1 行和第 5 行复制的是同一段话，用户分不清这两步。
   * 现在第 5 行只要建项目那一件事 —— 不含注册手续，也不再问"要不要登记现有项目"。
   */
  it('第 5 行复制的是另一段话：只要建项目，不含注册手续', async () => {
    const written: string[] = []
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          written.push(text)
        }
      }
    })
    useAgentStore.setState({ agents: [agentOf(true)] as never, loading: false })
    render(<OnboardingChecklist />)
    const button = await waitFor(() => screen.getByTestId('onboarding-action-handoff'))
    expect(button.textContent).toContain('复制建项目的话')
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('cli:connectInfo'))
    await new Promise((r) => setTimeout(r, 30))
    fireEvent.click(button)

    await waitFor(() => expect(written).toHaveLength(1))
    expect(written[0]).toContain(JSON.stringify('C:/dp/deskpartner.cjs'))
    expect(written[0]).toContain('第一个项目')
    // 第 1 行那段话里才有的事，第 5 行不该再让助手做一遍
    expect(written[0]).not.toContain('办理身份注册与凭据手续')
    expect(written[0]).not.toContain('是否要把现有项目登记')
  })
})

describe('首屏上手清单：收起与复位', () => {
  it('没全做完就收起时，按钮写还差几步，不写接入完成', async () => {
    useAgentStore.setState({ agents: [agentOf(true)] as never, loading: false })
    useUIStore.setState({ onboardingChecklistDismissed: true })
    render(<OnboardingChecklist />)
    const collapsed = await waitFor(() => screen.getByTestId('onboarding-checklist-collapsed'))
    expect(collapsed.textContent).toContain('上手清单 · 还差 3 步')
    expect(collapsed.textContent).not.toContain('接入完成')
    fireEvent.click(collapsed)
    await waitFor(() => expect(screen.getByTestId('onboarding-checklist')).toBeTruthy())
  })

  it('五步全绿后才自动收起成「上手已完成 · 查看清单」', async () => {
    useAgentStore.setState({ agents: [agentOf(true)] as never, loading: false })
    useProjectStore.setState({ projects: [PROJECT] as never })
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === 'profile:get') return { scope: 'global', blocks: [{ blockKey: 'basics', body: '称呼：Alex', confirmed: true }] }
      if (channel === 'protocol:get') return { scope: 'global', blocks: protocolBlocks.map((b) => ({ ...b, confirmed: true })), gates: {} }
      if (channel === 'cli:connectInfo') return null
      return null
    })
    render(<OnboardingChecklist />)
    const collapsed = await waitFor(() => screen.getByTestId('onboarding-checklist-collapsed'))
    expect(collapsed.textContent).toContain('上手已完成 · 查看清单')
    fireEvent.click(collapsed)
    await waitFor(() => expect(screen.getByTestId('onboarding-checklist')).toBeTruthy())
    // 全做完就不该再写「再花一分钟」
    expect(screen.getByText('上手已完成')).toBeTruthy()
    // 点开查看时五行都在，但都只剩标题
    for (const key of ['agent', 'approved', 'basics', 'protocol', 'handoff']) {
      expect(screen.getByTestId(`onboarding-row-${key}`).textContent).not.toContain('点')
    }
  })

  it('主线三步做完、第 3 行没做也不自动收起', async () => {
    useAgentStore.setState({ agents: [agentOf(true)] as never, loading: false })
    useProjectStore.setState({ projects: [PROJECT] as never })
    render(<OnboardingChecklist />)
    await waitFor(() => expect(screen.getByTestId('onboarding-checklist')).toBeTruthy())
    expect(screen.queryByTestId('onboarding-checklist-collapsed')).toBeNull()
  })

  it('没填名字时，称呼输入行在第二阶段出现，保存走 settings:update', async () => {
    useSettingsStore.setState({
      settings: { humanName: '', humanNameAsked: false, appName: 'DeskPartner', appIcon: null } as never
    })
    render(<OnboardingChecklist />)
    await waitFor(() => expect(screen.getByTestId('onboarding-checklist')).toBeTruthy())
    // 首屏只有一个动作：接入。称呼不在这里分心
    expect(screen.queryByTestId('onboarding-name-row')).toBeNull()

    cleanup()
    useAgentStore.setState({ agents: [agentOf(true)] as never, loading: false })
    useProjectStore.setState({ projects: [PROJECT] as never })
    render(<OnboardingChecklist />)
    const row = await waitFor(() => screen.getByTestId('onboarding-name-row'))
    const input = row.querySelector('input') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'Alex' } })
    fireEvent.click(screen.getByText('保存'))
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith('settings:update', expect.objectContaining({ humanName: 'Alex', humanNameAsked: true }))
    )
  })
})
