import React, { useEffect, useState } from 'react'
import { Icon } from '../ui/Icon'
import { Button } from '../ui/Button'
import { invoke } from '../../lib/ipc-client'
import { useUIStore } from '../../stores/ui.store'
import { useAgentStore } from '../../stores/agent.store'
import { useSettingsStore } from '../../stores/settings.store'
import { useOnboardingStatus } from '../../lib/use-onboarding-status'
import { useCliAccess } from '../../lib/use-cli-access'
import { buildMigratePrompt, buildFirstProjectPrompt, buildHandoffOnlyPrompt } from '../../lib/onboarding-prompts'
import { cn } from '../../lib/utils'
import {
  ONBOARDING_STEP_ORDER,
  ONBOARDING_STEP_TITLES,
  onboardingStageKeys,
  onboardingStepDone,
  type OnboardingStepKey
} from '../../lib/onboarding'

/**
 * 首屏上手清单（卡 `a19054a1`）
 *
 * 为什么是常驻条而不是空态里的一块：
 * 空态只在"一条事项都没有"时出现，而助手一提事项空态就消失 ——
 * 引导会跟着一起消失。放在列表上方、与空态解耦，才不受数据影响。
 *
 * 为什么判据全从真实数据推算（`useOnboardingStatus`）：
 * 不另存"引导进度"，就不会出现"标记说看过、实际没做过"的假状态。
 *
 * ── 为什么每行只留一句（1.0.147，评审 `claude-opus-5-5`）──
 *
 * 1.0.146 每行写了四句（这是什么 / 为什么轮到你 / 现在点哪里 / 点完会怎样），
 * 五行共 765 字，主用户的结论是「把解释描述文案放上去不算引导」。
 * 现在的判据是：
 *
 *   「用户按一下就能往前走的步骤，只写『点哪里、点完会看到什么』；
 *     只有不知道某件事他就会点错、不敢点、或点完以为没反应时，才多加一句
 *     —— 这一句只讲后果，不讲定义。」
 *
 * 于是：当前步骤 = 一句话 + 一个按钮（≤45 字）；其余步骤只留标题（≤8 字），
 * 还没轮到的那几步收成一行灰字「接下来：…」。同屏只有一个进度数 `n/5`。
 *
 * 五步的顺序与打勾判据都**不在这里算**：顺序读 `ONBOARDING_STEP_ORDER`，
 * 判据读 `onboardingStepDone`（唯一出处，`lib/onboarding.ts`）。
 * 顺序本身就是产品设计顺序，唯一出处是开场提示词（`lib/onboarding-prompts.ts`）：
 *
 *   让助手来申请 → 批准它的身份 → 写下关于我 → 确认协作约定 → 写清项目接手说明
 *
 * 前四步不需要项目，第五步才问「要不要建第一个项目」—— 项目排在最后，
 * 是因为档案与约定要先由助手跟人聊出来、人在审批页采纳，项目才有依据。
 *
 * ── 第 1、2 步为什么这样写（主用户 2026-11-13 当场抓到）──
 *
 * 她的原话：「接入打勾不就是批准身份了吗，怎么还要批准身份呢？」
 * 第 1 步过去叫「接入 AI 助手」，却是一登记就打勾：勾说"接通了"，
 * 下一行又说"还没批准"，自相矛盾。现在第 1 步叫「让助手来申请」，
 * 勾只代表**它来敲过门**；正文最后一句把这个区别说透（这一勾不算放行）。
 * 第 2 步只认批准，凭据没到手时在那一行下面补一句说明，不影响打勾。
 *
 * ── 第 3、4 步为什么不再给「去写关于我 / 一键确认」（2026-11-14）──
 *
 * 档案与约定是**助手提议、人在审批页采纳**：这两步的动作只能指向审批页。
 * 清单还要说出当前真实状态（还没提议 / 已提议待采纳 / 已采纳），
 * 否则人点了「前往审批」，那一页可能还是空的，而清单一个字都没解释。
 * 「按默认值先确认」只在助手还没提议时作为捷径出现，且是次按钮，不抢主路径。
 */
export interface OnboardingChecklistProps {
  /** 收起状态下用户仍能看到入口（点了重新展开） */
  forceOpen?: boolean
}

type StepKey = OnboardingStepKey

interface StepRow {
  key: StepKey
  /** 标题就是这一步的名字；非当前步骤只有它，所以要短 */
  title: string
  done: boolean
  /** 当前这一步要点哪里、点完会看到什么。非当前步骤不写，也不渲染 */
  hint: string
  /** 主按钮 */
  action: { label: string; onClick: () => void } | null
  /** 次按钮：给出的不是"再点一次"，而是"换条路也走得到" */
  secondary?: { label: string; onClick: () => void }
  /** 打勾之后才出现的一句说明（不影响打勾）：目前只有"批了但凭据还没到"用 */
  note?: string
}

const ALL_KEYS: StepKey[] = ONBOARDING_STEP_ORDER

/**
 * 正文里引用的助手名截到 12 字（复审 round 2 第三节第 1 条 / round 3 重申）
 *
 * `agent register --name` 不限长度：名字超过 18 字，第 2 行就超过 35；
 * 超过 28 字，连 45 的总上限都撑破。名字是身份的一部分，显示上截断不影响识别
 * （完整名字在审批页与团队页都看得到）。
 */
const shortName = (name: string): string => {
  const text = name.trim()
  const chars = [...text]
  return chars.length <= 12 ? text : `${chars.slice(0, 12).join('')}…`
}

export const OnboardingChecklist: React.FC<OnboardingChecklistProps> = () => {
  const { status, coreDone, doneCount, proposals, hasHandoffProject, handoffProject, reload } =
    useOnboardingStatus()
  const setMainView = useUIStore((s) => s.setMainView)
  /**
   * 拒绝之后要去的地方是**用户页的「团队」**：撤销拒绝那颗按钮在那儿
   * （`AgentRosterSection` 的「撤销拒绝」）。审批页只列还在等批的身份 ——
   * 点「前往审批」过去会是一张没有这个助手、也没有任何按钮的页面
   * （复审 round 3 第 b 条实测）。
   */
  const openUserSection = useUIStore((s) => s.openUserSection)
  const dismissed = useUIStore((s) => s.onboardingChecklistDismissed)
  const reopened = useUIStore((s) => s.onboardingChecklistReopened)
  const setChecklistState = useUIStore((s) => s.setOnboardingChecklistState)
  const agents = useAgentStore((s) => s.agents)
  const settings = useSettingsStore((s) => s.settings)
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  const cliAccess = useCliAccess()
  const focusStep = useUIStore((s) => s.onboardingFocusStep)
  const setFocusStep = useUIStore((s) => s.setOnboardingFocusStep)
  /** 从审批页回来看这一行时，短暂标一下它 —— 光滚过去，人还是不知道看哪儿 */
  const [flashFocus, setFlashFocus] = useState(false)
  const [name, setName] = useState(settings?.humanName ?? '')
  /** 第 1 行复制过、但助手还没注册 —— 这一行要停在等待态，而不是弹回原样 */
  const [agentPromptCopied, setAgentPromptCopied] = useState(false)
  /** 第 5 行刚复制过：只是两秒的按钮反馈，不需要等待态 */
  const [justCopied, setJustCopied] = useState(false)

  /**
   * 有人点了「回我的工作」要看见当前这一行（1.0.148）
   *
   * 为什么用定时器而不是直接 scrollIntoView：这一下是**跨视图**来的，
   * 视图切换要等这一次渲染落地，行元素才在文档里；同一次提交里量到的位置是旧的。
   * 清空放第二次定时器：锚是给"这一次回来"的，留着会让下次进页面又跳一次。
   *
   * 这个 effect 必须在下面 `if (hidden)` 之前：收起与展开是同一组状态在切换，
   * hook 挂到提前返回之后，一收一展就会撞上"渲染的 hook 数量变了"。
   */
  useEffect(() => {
    if (!focusStep) return
    const scrollTimer = window.setTimeout(() => {
      const el = document.querySelector(`[data-testid="onboarding-row-${focusStep}"]`)
      el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
      setFlashFocus(true)
    }, 60)
    const clearTimer = window.setTimeout(() => {
      setFlashFocus(false)
      setFocusStep(null)
    }, 2600)
    return () => {
      window.clearTimeout(scrollTimer)
      window.clearTimeout(clearTimer)
    }
  }, [focusStep, setFocusStep])

  const nameMissing = !settings?.humanNameAsked
  /**
   * 全部完成才算做完 —— 五步全绿（+ 称呼已问过）。
   *
   * 1.0.146 是"前几步做完"就自动收：那时后面几步还没做，
   * 卡片就带着它们一起消失，收起后还写着「接入完成」。
   * 现在两段都不自动收起，`allDone` 之后才收（评审第 14 条）。
   */
  const done = onboardingStepDone(status)
  const allDone = coreDone && done.handoff && !nameMissing
  const hidden = dismissed || (allDone && !reopened)
  const remaining = 5 - doneCount

  const pendingAgent = agents.find((agent) => !agent.approved && !agent.rejectedAt)
  /** 已批准的助手（凭据可能还没到 —— 那是它自己的手续，见下面第 2 行的说明） */
  const approvedAgent = agents.find((agent) => agent.approved)
  /** 批准了、但凭据还没到手：只补一句说明，不打回未完成 */
  const credentialPending = agents.some((agent) => agent.approved && !agent.hasCredential)
  /** 被拒绝过的助手：这一步卡在这里时，人手上的动作是去审批页取消拒绝 */
  const rejectedAgent = agents.find((agent) => agent.rejectedAt && !agent.approved)
  const pendingAgentName = pendingAgent?.displayName?.trim() ?? ''
  const approvedAgentName = approvedAgent?.displayName?.trim() ?? ''
  /**
   * 提议接手说明的是谁 —— 用**显示名**，不是身份串（复审 round 3 第二轮）
   *
   * 上一版把 `agent:alice` 剥成 `alice` 直接显示，而助手的展示名是 `Alice`；
   * 人自己提的时候还会写出「human 建好了项目」。现在按 agents 名单解析，
   * 自己的提议就说「你」。
   */
  const handoffProposerLabel = (() => {
    const id = proposals.handoffProposer
    if (!id) return ''
    if (id === 'human') return '你'
    const agent = agents.find((item) => item.id === id)
    return shortName(agent?.displayName?.trim() || id.replace(/^agent:/, ''))
  })()

  const copyPrompt = async (key: 'agent' | 'handoff' | 'handoffOnly'): Promise<void> => {
    const text =
      key === 'handoff'
        ? buildFirstProjectPrompt(cliAccess)
        : key === 'handoffOnly'
          ? /** 项目名与 id 写进复制出去的话：库里本来就有别的项目，不说清助教会自己建一个 */
            buildHandoffOnlyPrompt(cliAccess, handoffProject)
          : buildMigratePrompt(cliAccess)
    try {
      await navigator.clipboard.writeText(text)
      if (key === 'agent') {
        setAgentPromptCopied(true)
        return
      }
      setJustCopied(true)
      window.setTimeout(() => setJustCopied(false), 2000)
    } catch {
      /* 剪贴板不可用时保持原样，用户可以用「快速上手」页的按钮 */
    }
  }

  const confirmProtocol = async (): Promise<void> => {
    try {
      const res = (await invoke('protocol:get')) as unknown as {
        blocks?: Array<{ blockKey: string; body: string }>
      } | null
      await Promise.all(
        (res?.blocks ?? []).map((block) =>
          invoke('protocol:set', { blockKey: block.blockKey, body: block.body, confirmed: true })
        )
      )
      reload()
    } catch {
      /* 失败就保持未确认，去用户页看具体报错 */
    }
  }

  const commitName = (): void => {
    const trimmed = name.trim()
    void updateSettings({ humanName: trimmed, humanNameAsked: true }).then(() => reload())
  }

  /** 档案与约定都在审批页采纳：这两步的按钮只指那一页 */
  const openApproval = (): void => {
    setMainView('approval')
  }

  if (hidden) {
    return (
      <button
        type="button"
        data-testid="onboarding-checklist-collapsed"
        onClick={() => setChecklistState({ dismissed: false, reopened: true })}
        className="self-start inline-flex items-center gap-1.5 text-caption text-text-secondary hover:text-text-primary cursor-pointer"
      >
        <Icon
          name={allDone ? 'checkCircle' : 'chevronLeft'}
          size={13}
          className={allDone ? undefined : 'rotate-180'}
        />

        {allDone
          ? '上手已完成 · 查看清单'
          : /** 五步都绿、只差称呼时不能写「还差 0 步」（评审 round 2 的 d 条） */
            remaining === 0
            ? '上手清单 · 还差称呼没填'
            : `上手清单 · 还差 ${Math.max(0, remaining)} 步`}
      </button>
    )
  }

  const rows: Record<StepKey, StepRow> = {
    agent: {
      key: 'agent',
      title: ONBOARDING_STEP_TITLES.agent,
      done: done.agent,
      /**
       * ⚠️ 别在这里承诺「名字会出现在**这一行**」（评审 round 2 第 4 条）
       *
       * 1.0.147 的这句是照评审 round 1 抄的，抄完才发现兑现不了：助手一注册，
       * 第 1 行就收成「让助手来申请」加一个勾（`doneRows` 只渲染标题），
       * 名字出现在**第 2 行**的正文里。承诺兑现不了，比不承诺更伤人。
       * 现在这句话说的是名字真正出现的地方。
       */
      hint: agentPromptCopied
        ? '已复制。发给助手后回到这里——它申请接入时，这一行会自己变。'
        : '复制这段话发给你正在用的助手。它来登记后，下一行会写上它的名字——只代表它来了。',
      action: {
        label: agentPromptCopied ? '再复制一次' : '复制开场提示词',
        onClick: () => void copyPrompt('agent')
      }
    },
    approved: {
      key: 'approved',
      title: ONBOARDING_STEP_TITLES.approved,
      /** 只认批准：凭据要等助手下次连上才领到，不该让这一行等人等不到的东西 */
      done: done.approved,
      /**
       * 兜底句按**真实状态**分支（评审 round 2 的 b 条，round 3 补正去处）
       *
       * 走到这一行、又不点名，只有一种情形：**助手全被拒了**。那会儿没有任何人
       * 在申请，「它申请写入你的项目」是假话，按钮还是 null —— 这一步就卡死。
       *
       * 被拒之后能把它放回来的按钮是用户页「团队」里的**撤销拒绝**
       * （`AgentRosterSection`）。审批页只列还在等批的身份，那里没有这个助手、
       * 也没有任何按钮 —— 所以按钮指向团队页，文案也点明那一颗按钮的名字。
       */
      hint: pendingAgentName
        ? `${shortName(pendingAgentName)} 申请写入你的项目。批准前它只能读。`
        : rejectedAgent
          ? '你拒绝了它的申请。想让它回来，去「团队」点「撤销拒绝」。'
          : '还没有助手在申请。先做上面那一步。',
      action: pendingAgent
        ? { label: '前往审批', onClick: () => setMainView('approval') }
        : rejectedAgent
          ? { label: '去团队页', onClick: () => openUserSection('team') }
          : null,
      note: credentialPending ? '凭据还没到手：它下次连上时会自己领，这一步不用等。' : undefined
    },
    basics: {
      key: 'basics',
      title: ONBOARDING_STEP_TITLES.basics,
      done: done.basics,
      /**
       * 档案是**助手提议、你在审批页采纳**，所以这里给的是"提议到哪一步了"，
       * 不是"去哪儿自己写"。人要知道现在按按钮过去会不会看到东西。
       */
      hint: proposals.profilePending
        ? '助手已提议档案，等你采纳。点「前往审批」。'
        : '还没收到档案提议：助手和你聊完会提过来，这行会自己变。',
      action: { label: '前往审批', onClick: openApproval },
      note: proposals.profileAdopted ? '已采纳助手的提议' : undefined
    },
    protocol: {
      key: 'protocol',
      title: ONBOARDING_STEP_TITLES.protocol,
      done: done.protocol,
      hint: proposals.protocolPending
        ? '助手已提议约定，等你采纳。点「前往审批」。'
        : '还没收到约定提议：助手会先和你确认，再提过来。',
      action: { label: '前往审批', onClick: openApproval },
      /**
       * 助手还没提议时，人可以先按默认值确认（这是捷径，不是主路径）：
       * 有提议待采纳时它消失 —— 那时该做的是去审批页看助手写的版本。
       */
      secondary:
        !done.protocol && !proposals.protocolPending
          ? { label: '按默认值先确认', onClick: () => void confirmProtocol() }
          : undefined,
      note: proposals.protocolAdopted ? '已采纳助手的提议' : undefined
    },
    handoff: {
      key: 'handoff',
      title: ONBOARDING_STEP_TITLES.handoff,
      done: done.handoff,
      /**
       * 这一行有三张脸，按真实状态给（评审 round 2 的 a 条）
       *
       * 判据是「接手说明被采纳了、且不是默认骨架」，而采纳发生在审批页。
       * 1.0.147 无论走到哪儿都只说「复制这段话发给助手」：助手照第 1 行那段话
       * 已经把项目建好、接手说明也提过来了，这一行却没有任何一处提到「去采纳」——
       * 人照着它再发一遍，只会多出第二个项目。
       *
       *   ① 提议排着 → 去审批页采纳（按钮也换成它）
       *   ② 项目有了、提议还没来（或提议被退回）→ 复制一段**只补齐接手说明**的话
       *   ③ 还没项目 → 建项目
       *
       * ② 的判据是「接手说明有正文」（`project add` 塞的骨架也算），不是
       * 「库里有项目」：迁移兜底建的「未分类」篮子在新库上就存在，
       * 用它当判据会让一上来就说「项目建好了」。
       *
       * ② 复制的是 `buildHandoffOnlyPrompt`，不是「建第一个项目」那段
       * （复审 round 3 第 ② 条实测）：后者的第 3 步就是 `project add`，
       * 人照着发一遍，库里就多出第二个壳 —— 正好是这一行要堵的事。
       */
      hint: proposals.handoffPending
        ? handoffProposerLabel === '你'
          ? '你建好了项目，接手说明等你采纳，去审批页。'
          : `${handoffProposerLabel || approvedAgentName || '助手'} 建好了项目，接手说明等你采纳，去审批页。`
        : hasHandoffProject
          ? '项目建好了，接手说明还没采纳：复制这段话发给助手，让它提一版给你采纳。'
          : approvedAgentName
            ? `复制这段话发给 ${shortName(approvedAgentName)}，它会建好项目，再提第一条事项等你拍板。`
            : '复制这段话发给助手，它会建好项目，再提第一条事项等你拍板。',
      action: proposals.handoffPending
        ? { label: '前往审批', onClick: openApproval }
        : hasHandoffProject
          ? {
              label: justCopied ? '已复制' : '复制补接手说明的话',
              onClick: () => void copyPrompt('handoffOnly')
            }
          : { label: justCopied ? '已复制' : '复制建项目的话', onClick: () => void copyPrompt('handoff') }
    }
  }

  /** 全部做完时（用户手动点开查看）把五行都列出来；否则只列当前这一段 */
  const stageKeys = allDone ? ALL_KEYS : onboardingStageKeys(status)
  const stageRows = stageKeys.map((key) => rows[key])
  const currentIndex = stageRows.findIndex((row) => !row.done)
  const doneRows = currentIndex < 0 ? stageRows : stageRows.slice(0, currentIndex)
  const current = currentIndex < 0 ? null : stageRows[currentIndex]
  const upcoming = currentIndex < 0 ? [] : stageRows.slice(currentIndex + 1)

  /**
   * 卡头那句跟着**当前行**走。
   *
   * 第 1 步一勾还挂着「先把你的 AI 助手接进来」，等于让这一勾白勾了：
   * 人刚被告知"它来了"，抬头又说没接进来。卡头只负责说这一段在干什么，
   * 具体这一行要点哪里，下面那一行自己会说。
   */
  const headerTitle = !current
    ? allDone
      ? '上手已完成'
      : '再花一分钟'
    : current.key === 'agent'
      ? '先把你的 AI 助手接进来'
      : current.key === 'approved'
        ? '它来了，等你批准'
        : coreDone
          ? '再花一分钟'
          : `下一步：${current.title}`

  return (
    <section
      data-testid="onboarding-checklist"
      className="rounded-card border border-border bg-bg-card shadow-sm overflow-hidden"
    >
      <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-border bg-surface-subtle">
        <div className="text-content font-semibold text-text-primary">
          {headerTitle}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-caption text-text-secondary font-mono">{doneCount}/5</span>
          <button
            type="button"
            aria-label="收起上手清单"
            data-testid="onboarding-checklist-collapse"
            onClick={() => setChecklistState({ dismissed: true })}
            className="w-6 h-6 flex items-center justify-center rounded-button text-text-secondary hover:bg-black/5 hover:text-text-primary cursor-pointer"
          >
            <Icon name="chevronLeft" size={14} className="rotate-90" />
          </button>
        </div>
      </div>

      <div className="px-4 py-2.5">
        {doneRows.map((row) => (
          <div key={row.key} data-testid={`onboarding-row-${row.key}`} className="py-1">
            <div className="flex items-center gap-2 text-label text-text-secondary">
              <span className="w-4 h-4 rounded-full bg-accent text-white flex items-center justify-center shrink-0">
                <Icon name="check" size={11} />
              </span>
              {row.title}
            </div>
            {/** 打完勾才说得上的一句（凭据还没到）：它不改变打勾，只是别让人等错东西 */}
            {row.note && (
              <p data-testid={`onboarding-note-${row.key}`} className="pl-6 text-caption text-text-secondary">
                {row.note}
              </p>
            )}
          </div>
        ))}

        {/**
         * 批准之后才问称呼：首屏唯一要做的动作是接入，多一个输入框只是分心。
         * 它属于「写下关于我」这一段 —— 助手提议档案时也会用到这个称呼。
         */}
        {status.hasApprovedAgent && nameMissing && (
          <div className="flex items-center gap-2 py-1.5" data-testid="onboarding-name-row">
            <span className="text-caption text-text-secondary shrink-0">怎么称呼你</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="用于看板归属与协作动态"
              className="h-8 flex-1 min-w-0 px-2.5 rounded-button border border-border bg-bg-card text-label text-text-primary outline-none focus:border-accent"
            />
            <Button
              variant="ghost"
              size="sm"
              className="border border-border bg-surface-subtle px-2.5"
              onClick={commitName}
            >
              保存
            </Button>
          </div>
        )}

        {current && (
          <div
            key={current.key}
            data-testid={`onboarding-row-${current.key}`}
            className={cn(
              'flex items-start gap-2 py-1 rounded-button transition-shadow',
              flashFocus && focusStep === current.key && 'ring-2 ring-accent/40 bg-accent/5 px-1.5'
            )}
          >
            <span className="mt-1 w-4 h-4 rounded-full border border-accent shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="text-label font-medium text-text-primary">{current.title}</div>
              <p
                data-testid={`onboarding-next-${current.key}`}
                className="text-caption text-text-secondary leading-relaxed"
              >
                {current.hint}
              </p>
              <div className="mt-1.5 flex items-center gap-2">
                {current.action && (
                  <Button
                    variant="ghost"
                    size="sm"
                    data-testid={`onboarding-action-${current.key}`}
                    className="border border-border bg-surface-subtle hover:bg-surface-muted px-2.5 text-text-primary"
                    onClick={current.action.onClick}
                  >
                    {current.action.label}
                  </Button>
                )}
                {current.secondary && (
                  <Button
                    variant="ghost"
                    size="sm"
                    data-testid={`onboarding-secondary-${current.key}`}
                    className="text-text-secondary hover:text-text-primary cursor-pointer"
                    onClick={current.secondary.onClick}
                  >
                    {current.secondary.label}
                  </Button>
                )}
              </div>
            </div>
          </div>
        )}

        {upcoming.length > 0 && (
          <p data-testid="onboarding-upcoming" className="pt-1.5 text-caption text-text-secondary">
            接下来：{upcoming.map((row) => row.title).join(' → ')}
          </p>
        )}
      </div>
    </section>
  )
}
