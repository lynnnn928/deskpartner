// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import React from 'react'
import { OnboardingChecklist } from '../../../src/renderer/components/workbench/OnboardingChecklist'
import { useAgentStore } from '../../../src/renderer/stores/agent.store'
import { useProjectStore } from '../../../src/renderer/stores/project.store'
import { useSettingsStore } from '../../../src/renderer/stores/settings.store'
import { useUIStore } from '../../../src/renderer/stores/ui.store'
import { PROJECT_HANDOFF_TEMPLATE } from '../../../src/renderer/types/project'

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
 * ④ 顺序是产品设计顺序（2026-11-14）：接入 → 批准 → 写下关于我 → 确认协作约定 →
 *    写清项目接手说明；第 5 行（项目）等前四步做完才出现；
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

const agentOf = (approved: boolean, hasCredential = approved) => ({
  id: 'bob',
  displayName: 'Bob',
  color: null,
  approved,
  rejectedAt: null,
  hasCredential,
  createdAt: '2026-11-13T00:00:00.000Z',
  lastSeenAt: null,
  lastWriteAt: approved ? '2026-11-13T00:10:00.000Z' : null,
  lastWriteCommand: null
})

/** 被拒绝的助手：`rejectedAt` 有值，且 approved=false（审批页「取消拒绝」能把它放回来） */
const rejectedAgentOf = () => ({
  ...agentOf(false, false),
  rejectedAt: '2026-11-13T00:20:00.000Z'
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
    expect(screen.getByTestId('onboarding-row-agent').textContent).toContain('让助手来申请')
    const hint = screen.getByTestId('onboarding-next-agent').textContent ?? ''
    expect(hint).toContain('发给你正在用的助手')
    // 这一勾的含义必须写在正文里：它来了 ≠ 你放行了（主用户 2026-11-13 抓到的错）
    expect(hint).toContain('只代表它来了')
    /**
     * 名字的落点必须说对（评审 round 2 第 4 条）：助手一注册，第 1 行就收成
     * 「让助手来申请」加一个勾，名字出现在**第 2 行**。上一版写的是
     * 「下一行会出现它的名字」的兄弟说法「这一行会勾上」，承诺不了名字——
     * 现在这句说的是名字真正出现的地方，下面就逐字核对它兑现了。
     */
    expect(hint).toContain('下一行会写上它的名字')
    expect(screen.getByTestId('onboarding-action-agent').textContent).toContain('复制开场提示词')
    // 它还停在"先做第 1 步"，指向审批页等于让人去看一张空列表
    expect(screen.queryByTestId('onboarding-action-approved')).toBeNull()
    expect(screen.getByText('0/5', { exact: false })).toBeTruthy()
  })

  /**
   * 第 1 行那句承诺的**反向核对**：它说「下一行会写上它的名字」，
   * 那就得真写上 —— 否则这一句只是换个说法继续骗人。
   */
  it('助手一登记，下一行（第 2 步）真的写上它的名字', async () => {
    useAgentStore.setState({ agents: [agentOf(false, false)] as never, loading: false })
    render(<OnboardingChecklist />)
    const approvedHint = await waitFor(() => screen.getByTestId('onboarding-next-approved'))
    expect(approvedHint.textContent).toContain('Bob')
  })

  /** 主用户 2026-11-13：「接入打勾不就是批准身份了吗，怎么还要批准身份呢？」 */
  it('第 1 步一勾只说明它来了：卡头改口、第 2 步仍等着人批准', async () => {
    useAgentStore.setState({ agents: [agentOf(false, false)] as never, loading: false })
    render(<OnboardingChecklist />)
    await waitFor(() => expect(screen.getByTestId('onboarding-row-approved')).toBeTruthy())
    // 第 1 行已经打勾，卡头不能还说"先把助手接进来"
    expect(screen.getByTestId('onboarding-row-agent').textContent).toBe('让助手来申请')
    expect(screen.queryByText('先把你的 AI 助手接进来')).toBeNull()
    expect(screen.getByText('它来了，等你批准')).toBeTruthy()
    // 第 2 步是当前行：一句话 + 「前往审批」，还没有勾
    expect(screen.getByTestId('onboarding-action-approved').textContent).toContain('前往审批')
    expect(screen.getByText('1/5', { exact: false })).toBeTruthy()
  })

  /**
   * 批准之后清单必须往前走 —— 凭据（`agent credential`）是助手下次连上时
   * 自己领的，人这一侧没有可点的东西，不该让第 2 行等人等不到的东西。
   */
  it('批准了就勾第 2 行、计数 2/5；凭据没到手只补一句说明，不打回未完成', async () => {
    useAgentStore.setState({ agents: [agentOf(true, false)] as never, loading: false })
    render(<OnboardingChecklist />)
    await waitFor(() => expect(screen.getByTestId('onboarding-row-approved')).toBeTruthy())
    expect(screen.getByText('2/5', { exact: false })).toBeTruthy()
    // 第 2 行在"已完成"那一段里，只剩标题
    expect(screen.getByTestId('onboarding-row-approved').textContent).toContain('批准它的身份')
    // 凭据没到手：勾照打，说明挂在它下面
    const note = screen.getByTestId('onboarding-note-approved')
    expect(note.textContent).toContain('凭据还没到手')
    expect(note.textContent).toContain('自己领')
    // 当前行已经是「写下关于我」，不是项目：项目排在档案与约定之后
    expect(screen.queryByTestId('onboarding-action-approved')).toBeNull()
    expect(screen.getByTestId('onboarding-row-basics')).toBeTruthy()
    expect(screen.queryByTestId('onboarding-row-handoff')).toBeNull()
  })

  it('当前步骤一句话不超过 45 字，其余步骤只有不超过 8 字的标题', async () => {
    useAgentStore.setState({ agents: [agentOf(false)] as never, loading: false })
    render(<OnboardingChecklist />)
    await waitFor(() => expect(screen.getByTestId('onboarding-next-approved')).toBeTruthy())
    expect(chars(screen.getByTestId('onboarding-next-approved').textContent)).toBeLessThanOrEqual(45)

    // 「接入」已经做完，只留标题：没有正文，标题短
    const doneRow = screen.getByTestId('onboarding-row-agent')
    expect(doneRow.textContent).toBe('让助手来申请')
    expect(chars(doneRow.textContent)).toBeLessThanOrEqual(8)

    // 还没轮到的那几步收成一行灰字路线，不再各占一段（顺序 = 产品设计顺序；
    // 项目那一步要等前四步做完才出现，所以这一行现在只列到约定）
    expect(screen.getByTestId('onboarding-upcoming').textContent).toBe('接下来：写下关于我 → 确认协作约定')
    expect(screen.queryByTestId('onboarding-next-handoff')).toBeNull()
  })

  /**
   * 第 2 行的兜底句按真实状态分支（评审 round 2 的 b 条）
   *
   * 走到这一行、又不点名的情形只有一种：**助手全被拒了**。那会儿没有任何人在申请，
   * 旧文案「它申请写入你的项目」是假话，按钮还是 null —— 这一步就卡死在那儿。
   *
   * 去处是**用户页的「团队」**（复审 round 3 实测）：撤销拒绝那颗按钮在
   * `AgentRosterSection` 里，审批页只列还在等批的身份 —— 那里过去什么都没有。
   */
  it('助手被拒绝时，第 2 行说实话并送到「团队」页的「撤销拒绝」', async () => {
    useAgentStore.setState({ agents: [rejectedAgentOf()] as never, loading: false })
    render(<OnboardingChecklist />)
    const hint = await waitFor(() => screen.getByTestId('onboarding-next-approved'))
    expect(hint.textContent).toContain('你拒绝了它的申请')
    expect(hint.textContent).toContain('撤销拒绝')
    // 没有人在申请，就不能再写"它在申请"
    expect(hint.textContent).not.toContain('它申请写入你的项目')
    expect(chars(hint.textContent)).toBeLessThanOrEqual(45)
    const button = screen.getByTestId('onboarding-action-approved')
    expect(button.textContent).toContain('去团队页')
    fireEvent.click(button)
    // 去的必须是用户页的「团队」分区 —— 不是审批页（那儿没有这个助手）
    expect(useUIStore.getState().mainView).toBe('user')
    expect(useUIStore.getState().userEntryTarget).toMatchObject({ section: 'team' })
  })

  /** 「撤销拒绝」这颗按钮真的在团队页里（去处不能只写在文案上） */
  it('用户页的团队分区里确实有「撤销拒绝」这颗按钮', () => {
    const roster = readFileSync(
      join(__dirname, '../../../src/renderer/components/user/AgentRosterSection.tsx'),
      'utf8'
    )
    expect(roster).toContain('撤销拒绝')
    const userView = readFileSync(
      join(__dirname, '../../../src/renderer/components/user/UserView.tsx'),
      'utf8'
    )
    expect(userView).toContain('AgentRosterSection')
  })

  /** 长名字不能把那一行撑破（复审 round 2 第三节第 1 条） */
  it('名字超过 12 字时正文里截断加省略号', async () => {
    const longName = '一个特别特别特别长的助手展示名字'
    useAgentStore.setState({
      agents: [{ ...agentOf(false, false), displayName: longName }] as never,
      loading: false
    })
    render(<OnboardingChecklist />)
    const hint = await waitFor(() => screen.getByTestId('onboarding-next-approved'))
    expect(hint.textContent).toContain('…')
    expect(hint.textContent).not.toContain(longName)
    expect(chars(hint.textContent)).toBeLessThanOrEqual(45)
  })

  /**
   * 批准了、凭据还没到：这一行已经打勾，凭据之说挂在勾下面（不打回未完成），
   * 所以它不会再变成"当前行"去说一句没人听的话。
   */
  it('已批准但凭据没到手：第 2 行照常打勾，只在勾下补一句', async () => {
    useAgentStore.setState({ agents: [agentOf(true, false)] as never, loading: false })
    render(<OnboardingChecklist />)
    await waitFor(() => expect(screen.getByTestId('onboarding-note-approved')).toBeTruthy())
    expect(screen.queryByTestId('onboarding-next-approved')).toBeNull()
    expect(screen.getByText('2/5', { exact: false })).toBeTruthy()
  })

  /** 评审 round 2 第 10 条：项目排在最后 */
  it('第 5 行（项目）要等前四步做完才出现', async () => {
    useAgentStore.setState({ agents: [agentOf(true)] as never, loading: false })
    render(<OnboardingChecklist />)
    await waitFor(() => expect(screen.getByTestId('onboarding-checklist')).toBeTruthy())
    // 批准完、档案与约定还没做：这一段演到档案与约定，没有项目
    expect(screen.getByTestId('onboarding-row-basics')).toBeTruthy()
    expect(screen.queryByTestId('onboarding-row-handoff')).toBeNull()
    expect(screen.getByTestId('onboarding-upcoming').textContent).toBe('接下来：确认协作约定')

    cleanup()
    // 档案与约定都采纳了，项目还没建：第 5 行这时才出现
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === 'profile:get') return { scope: 'global', blocks: [{ blockKey: 'basics', body: '称呼：Alex', confirmed: true }] }
      if (channel === 'protocol:get') return { scope: 'global', blocks: protocolBlocks.map((b) => ({ ...b, confirmed: true })), gates: {} }
      if (channel === 'profile:proposals') return [{ id: 'pp1', scope: 'global', projectId: null, status: 'approved' }]
      if (channel === 'protocol:proposals') return [{ id: 'pc1', scope: 'global', projectId: null, status: 'approved' }]
      if (channel === 'cli:connectInfo') return null
      return null
    })
    render(<OnboardingChecklist />)
    await waitFor(() => expect(screen.getByTestId('onboarding-row-handoff')).toBeTruthy())
    expect(screen.getByText('再花一分钟')).toBeTruthy()
    expect(screen.getByTestId('onboarding-next-handoff')).toBeTruthy()
    expect(screen.getByText('4/5', { exact: false })).toBeTruthy()
  })

  /**
   * 第 5 行的三张脸（评审 round 2 的 a 条）
   *
   * 助手照第 1 行那段话建了项目、接手说明也提到审批页了，可这一行还在叫
   * 「复制这段话发给助手」—— 人照着再发一遍，只会多出第二个项目。
   */
  describe('第 5 行按真实状态改口', () => {
    /** 前四步全绿的桩：档案与约定都采纳过 */
    const coreDoneMock = (): void => {
      invokeMock.mockImplementation(async (channel: string) => {
        if (channel === 'profile:get') return { scope: 'global', blocks: [{ blockKey: 'basics', body: '称呼：Alex', confirmed: true }] }
        if (channel === 'protocol:get') return { scope: 'global', blocks: protocolBlocks.map((b) => ({ ...b, confirmed: true })), gates: {} }
        if (channel === 'profile:proposals') return [{ id: 'pp1', scope: 'global', projectId: null, status: 'approved' }]
        if (channel === 'protocol:proposals') return [{ id: 'pc1', scope: 'global', projectId: null, status: 'approved' }]
        if (channel === 'cli:connectInfo') return null
        return null
      })
    }

    /** `project add` 建出来的空壳：接手说明还是空的（所以这一步没打勾） */
    const shellProject = { id: 'p1', name: '示例项目', archived: false, handoffMarkdown: '', color: '#123456' }
    /**
     * `project add` 真建出来的样子：接手说明里已经有一份**章节骨架**
     * （主进程塞的就是 `PROJECT_HANDOFF_TEMPLATE`）。原样骨架不算"填过"，
     * 所以这一步仍然没打勾 —— 正好是「项目建好了、提议还没来」那一格。
     */
    const skeletonProject = { ...shellProject, handoffMarkdown: PROJECT_HANDOFF_TEMPLATE }

    it('接手说明在审批页排着 → 说「去采纳」，按钮也换成「前往审批」', async () => {
      useAgentStore.setState({ agents: [agentOf(true)] as never, loading: false })
      useProjectStore.setState({ projects: [shellProject] as never })
      coreDoneMock()
      invokeMock.mockImplementation(async (channel: string) => {
        if (channel === 'project:handoffProposals') return [{ id: 'h1', projectId: 'p1', status: 'pending' }]
        if (channel === 'profile:get') return { scope: 'global', blocks: [{ blockKey: 'basics', body: '称呼：Alex', confirmed: true }] }
        if (channel === 'protocol:get') return { scope: 'global', blocks: protocolBlocks.map((b) => ({ ...b, confirmed: true })), gates: {} }
        return null
      })
      render(<OnboardingChecklist />)
      const hint = await waitFor(() => screen.getByTestId('onboarding-next-handoff'))
      expect(hint.textContent).toContain('接手说明等你采纳')
      expect(hint.textContent).toContain('去审批页')
      const button = screen.getByTestId('onboarding-action-handoff')
      expect(button.textContent).toContain('前往审批')
      fireEvent.click(button)
      expect(useUIStore.getState().mainView).toBe('approval')
    })

    it('项目有了、提议还没来 → 复制的话只补接手说明，不许再建项目', async () => {
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
      useProjectStore.setState({ projects: [skeletonProject] as never })
      coreDoneMock()
      invokeMock.mockImplementation(async (channel: string) => {
        if (channel === 'cli:connectInfo') return { cliPath: 'C:/dp/deskpartner.cjs', cliEnvVar: 'DESKPARTNER_CLI', cliEnvAvailable: false, mcpCommand: 'C:/dp/mcp.cmd' }
        if (channel === 'profile:get') return { scope: 'global', blocks: [{ blockKey: 'basics', body: '称呼：Alex', confirmed: true }] }
        if (channel === 'protocol:get') return { scope: 'global', blocks: protocolBlocks.map((b) => ({ ...b, confirmed: true })), gates: {} }
        return null
      })
      render(<OnboardingChecklist />)
      const hint = await waitFor(() => screen.getByTestId('onboarding-next-handoff'))
      expect(hint.textContent).toContain('接手说明还没采纳')
      expect(chars(hint.textContent)).toBeLessThanOrEqual(45)
      const button = screen.getByTestId('onboarding-action-handoff')
      expect(button.textContent).toContain('复制补接手说明的话')
      await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('cli:connectInfo'))
      await new Promise((r) => setTimeout(r, 30))
      fireEvent.click(button)

      await waitFor(() => expect(written).toHaveLength(1))
      /**
       * 复审 round 3 第 ② 条：这一段话如果是「建第一个项目」那段，
       * 它的第 3 步就是 `project add` —— 人照着发一遍就多出第二个壳。
       */
      expect(written[0]).not.toMatch(/建项目（project add）/)
      expect(written[0]).toContain('不要新建项目')
      expect(written[0]).toContain('handoff-propose')
      expect(written[0]).toContain('已经有这个项目')
    })

    /**
     * 迁移兜底建的「未分类」篮子在新库上就存在，它**不是**「助手建好了项目」。
     * 拿"库里有项目"当判据，一装上就会说「项目建好了」，那是假话。
     */
    it('库里只有「未分类」篮子 → 仍说「它会建好项目」', async () => {
      useAgentStore.setState({ agents: [agentOf(true)] as never, loading: false })
      useProjectStore.setState({
        projects: [{ id: 'migrated-default-project', name: '未分类', archived: false, handoffMarkdown: '', color: '#8E8E93' }] as never
      })
      coreDoneMock()
      render(<OnboardingChecklist />)
      const hint = await waitFor(() => screen.getByTestId('onboarding-next-handoff'))
      expect(hint.textContent).toContain('它会建好项目')
      expect(hint.textContent).not.toContain('项目建好了')
    })

    it('还没项目 → 仍是「复制这段话，它会建好项目」', async () => {
      useAgentStore.setState({ agents: [agentOf(true)] as never, loading: false })
      coreDoneMock()
      render(<OnboardingChecklist />)
      const hint = await waitFor(() => screen.getByTestId('onboarding-next-handoff'))
      expect(hint.textContent).toContain('它会建好项目')
      expect(hint.textContent).toContain('Bob')
      expect(screen.getByTestId('onboarding-action-handoff').textContent).toContain('复制建项目的话')
    })
  })

  /**
   * 第三、四步要说出**当前真实状态**：还没提议 / 已提议待采纳 / 已采纳。
   * 前两种在"当前这一行"的正文里说，最后一种挂在打完勾的那一行下面。
   */
  it('档案与约定的三种状态各说各的：还没提议、已提议待采纳、已采纳', async () => {
    // ① 还没提议：批准完、助手一条提议都还没提
    useAgentStore.setState({ agents: [agentOf(true)] as never, loading: false })
    render(<OnboardingChecklist />)
    const waitHint = await waitFor(() => screen.getByTestId('onboarding-next-basics'))
    expect(waitHint.textContent).toContain('还没收到档案提议')
    expect(screen.getByTestId('onboarding-action-basics').textContent).toContain('前往审批')

    // ② 已提议待采纳：正文说"等你采纳"，按钮还是指审批页
    cleanup()
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === 'profile:get') return { scope: 'global', blocks: [{ blockKey: 'basics', body: '', confirmed: false }] }
      if (channel === 'protocol:get') return { scope: 'global', blocks: protocolBlocks, gates: {} }
      if (channel === 'profile:proposals') return [{ id: 'pp1', scope: 'global', projectId: null, status: 'pending' }]
      if (channel === 'protocol:proposals') return [{ id: 'pc1', scope: 'global', projectId: null, status: 'pending' }]
      if (channel === 'cli:connectInfo') return null
      return null
    })
    render(<OnboardingChecklist />)
    const pendingHint = await waitFor(() => screen.getByTestId('onboarding-next-basics'))
    expect(pendingHint.textContent).toContain('已提议档案')
    expect(pendingHint.textContent).toContain('等你采纳')
    expect(screen.getByTestId('onboarding-action-basics').textContent).toContain('前往审批')

    // ③ 已采纳：五步全绿后点开看，勾过的那两行各留一句"已采纳助手的提议"
    cleanup()
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === 'profile:get') return { scope: 'global', blocks: [{ blockKey: 'basics', body: '称呼：Alex', confirmed: true }] }
      if (channel === 'protocol:get') return { scope: 'global', blocks: protocolBlocks.map((b) => ({ ...b, confirmed: true })), gates: {} }
      if (channel === 'profile:proposals') return [{ id: 'pp1', scope: 'global', projectId: null, status: 'approved' }]
      if (channel === 'protocol:proposals') return [{ id: 'pc1', scope: 'global', projectId: null, status: 'approved' }]
      if (channel === 'cli:connectInfo') return null
      return null
    })
    useProjectStore.setState({ projects: [PROJECT] as never })
    render(<OnboardingChecklist />)
    fireEvent.click(await waitFor(() => screen.getByTestId('onboarding-checklist-collapsed')))
    await waitFor(() => expect(screen.getByTestId('onboarding-note-basics')).toBeTruthy())
    expect(screen.getByTestId('onboarding-note-basics').textContent).toContain('已采纳助手的提议')
    expect(screen.getByTestId('onboarding-note-protocol').textContent).toContain('已采纳助手的提议')
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

  /**
   * 档案与约定都是**助手提议、人在审批页采纳**：清单这两步的按钮只能指审批页
   * （主用户 2026-11-14：「第 3、4 步的动作要指向审批页的采纳，不是『去写关于我』」）。
   */
  it('「写下关于我」那一行的动作是「前往审批」，不是跳去用户页自己写', async () => {
    useAgentStore.setState({ agents: [agentOf(true)] as never, loading: false })
    render(<OnboardingChecklist />)
    const button = await waitFor(() => screen.getByTestId('onboarding-action-basics'))
    expect(button.textContent).toContain('前往审批')
    fireEvent.click(button)
    expect(useUIStore.getState().mainView).toBe('approval')
  })

  it('「确认协作约定」同样指审批页；「按默认值先确认」只是助手还没提议时的捷径', async () => {
    useAgentStore.setState({ agents: [agentOf(true)] as never, loading: false })
    invokeMock.mockImplementation(async (channel: string) => {
      // 档案已采纳：当前行才是第 4 步（约定），且助手还没提约定
      if (channel === 'profile:get') return { scope: 'global', blocks: [{ blockKey: 'basics', body: '称呼：Alex', confirmed: true }] }
      if (channel === 'protocol:get') return { scope: 'global', blocks: protocolBlocks, gates: {} }
      if (channel === 'profile:proposals') return [{ id: 'pp1', scope: 'global', projectId: null, status: 'approved' }]
      if (channel === 'protocol:proposals') return []
      if (channel === 'cli:connectInfo') return null
      return null
    })
    render(<OnboardingChecklist />)
    const primary = await waitFor(() => screen.getByTestId('onboarding-action-protocol'))
    expect(primary.textContent).toContain('前往审批')
    // 捷径在次按钮上：文案说的是"助手还没提，我先按默认确认"
    const shortcut = screen.getByTestId('onboarding-secondary-protocol')
    expect(shortcut.textContent).toContain('按默认值先确认')
    fireEvent.click(primary)
    expect(useUIStore.getState().mainView).toBe('approval')
  })

  it('一键确认按块调 protocol:set，确认后刷新成已确认', async () => {
    useAgentStore.setState({ agents: [agentOf(true)] as never, loading: false })
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === 'profile:get') return { scope: 'global', blocks: [{ blockKey: 'basics', body: '称呼：Alex', confirmed: true }] }
      if (channel === 'protocol:get') return { scope: 'global', blocks: protocolBlocks, gates: {} }
      if (channel === 'cli:connectInfo') return null
      if (channel === 'protocol:set') return { ok: true }
      return null
    })
    render(<OnboardingChecklist />)
    await waitFor(() => expect(screen.getByTestId('onboarding-secondary-protocol')).toBeTruthy())
    fireEvent.click(screen.getByTestId('onboarding-secondary-protocol'))
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
    // 项目是最后一步：档案与约定都采纳了，这一行才轮得到
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === 'profile:get') return { scope: 'global', blocks: [{ blockKey: 'basics', body: '称呼：Alex', confirmed: true }] }
      if (channel === 'protocol:get') return { scope: 'global', blocks: protocolBlocks.map((b) => ({ ...b, confirmed: true })), gates: {} }
      if (channel === 'cli:connectInfo') return { cliPath: 'C:/dp/deskpartner.cjs', cliEnvVar: 'DESKPARTNER_CLI', cliEnvAvailable: false, mcpCommand: 'C:/dp/mcp.cmd' }
      return null
    })
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

  it('只有项目做完、前四步没做也不自动收起', async () => {
    useAgentStore.setState({ agents: [agentOf(true)] as never, loading: false })
    useProjectStore.setState({ projects: [PROJECT] as never })
    render(<OnboardingChecklist />)
    await waitFor(() => expect(screen.getByTestId('onboarding-checklist')).toBeTruthy())
    expect(screen.queryByTestId('onboarding-checklist-collapsed')).toBeNull()
  })

  /**
   * 五步全绿、只差称呼时，收起那行不能写「还差 0 步」（评审 round 2 的 d 条）
   *
   * 计数按五个布尔走，称呼不在里面；可 `allDone` 又要求称呼问过。
   * 于是五个布尔全真时 `remaining` 是 0、卡片却不收，收起后那行写着「还差 0 步」。
   */
  it('五步全绿只差称呼时，收起那行写「还差称呼没填」，不写「还差 0 步」', async () => {
    useAgentStore.setState({ agents: [agentOf(true)] as never, loading: false })
    useProjectStore.setState({ projects: [PROJECT] as never })
    useSettingsStore.setState({
      settings: { humanName: '', humanNameAsked: false, appName: 'DeskPartner', appIcon: null } as never
    })
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === 'profile:get') return { scope: 'global', blocks: [{ blockKey: 'basics', body: '称呼：Alex', confirmed: true }] }
      if (channel === 'protocol:get') return { scope: 'global', blocks: protocolBlocks.map((b) => ({ ...b, confirmed: true })), gates: {} }
      if (channel === 'cli:connectInfo') return null
      return null
    })
    useUIStore.setState({ onboardingChecklistDismissed: true })
    render(<OnboardingChecklist />)
    const collapsed = await waitFor(() => screen.getByTestId('onboarding-checklist-collapsed'))
    expect(collapsed.textContent).toContain('还差称呼没填')
    expect(collapsed.textContent).not.toContain('0 步')
    // 点开就能填：称呼那一行在展开后看得见
    fireEvent.click(collapsed)
    await waitFor(() => expect(screen.getByTestId('onboarding-name-row')).toBeTruthy())
  })

  it('没填名字时，称呼输入行在批准之后出现，保存走 settings:update', async () => {
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
