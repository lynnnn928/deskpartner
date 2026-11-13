import React, { useState } from 'react'
import { Icon } from '../ui/Icon'
import { Button } from '../ui/Button'
import { invoke } from '../../lib/ipc-client'
import { useUIStore } from '../../stores/ui.store'
import { useSettingsStore } from '../../stores/settings.store'
import { useOnboardingStatus } from '../../lib/use-onboarding-status'
import { useCliAccess } from '../../lib/use-cli-access'
import { buildMigratePrompt } from '../../lib/onboarding-prompts'
import { cn } from '../../lib/utils'

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
 * 为什么一行要写四句：主用户 2026-11-13 的原话是「这 5 件事你现在默认用户
 * 已经都知道具体内容了，只给一句话简述，这不对」。第一次装的人要能读出来：
 * 这是什么 → 跟我有什么关系 → 现在点哪里 → 点完会发生什么。
 * 前两句（`what` / `why`）是常文；后两句（`next`）跟着状态走 ——
 * 每行只给此刻最该做的那一个动作，做完就改口说"已经怎样了"。
 *
 * 五步与 `getOnboardingStatus` 的五个布尔一一对应：
 * 接入 → 批准 → 关于我 → 协作约定 → 第一个项目。
 * 第 3 步曾经因为"只在用户页有行"而被计数排除，屏上成了 x/4；
 * 那反而让人不知道还有一份关于自己的档案要填，所以补回这一行。
 */
export interface OnboardingChecklistProps {
  /** 收起状态下用户仍能看到入口（点了重新展开） */
  forceOpen?: boolean
}

export const OnboardingChecklist: React.FC<OnboardingChecklistProps> = () => {
  const { status, coreDone, doneCount, reload } = useOnboardingStatus()
  const setMainView = useUIStore((s) => s.setMainView)
  const openUserSection = useUIStore((s) => s.openUserSection)
  const settings = useSettingsStore((s) => s.settings)
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  const cliAccess = useCliAccess()
  /** 用户主动收起；与"全绿后自动收起"分开记，否则自动收起之后再也点不开 */
  const [dismissed, setDismissed] = useState(false)
  const [reopened, setReopened] = useState(false)
  const [name, setName] = useState(settings?.humanName ?? '')
  /** 刚复制过提示词的那一行；两行都复制同一段，得分开记，否则两处一起变「已复制」 */
  const [copiedKey, setCopiedKey] = useState<string | null>(null)

  const nameMissing = !settings?.humanNameAsked
  const autoHidden = coreDone && !nameMissing
  const hidden = dismissed || (autoHidden && !reopened)

  const copyPrompt = async (key: string): Promise<void> => {
    const text = buildMigratePrompt(cliAccess)
    try {
      await navigator.clipboard.writeText(text)
      setCopiedKey(key)
      window.setTimeout(() => setCopiedKey((current) => (current === key ? null : current)), 2000)
    } catch {
      /* 剪贴板不可用时保持原样，用户可以用「快速上手」页的按钮 */
    }
  }

  const confirmProtocol = async (): Promise<void> => {
    try {
      const res = (await invoke('protocol:get')) as unknown as { blocks?: Array<{ blockKey: string; body: string }> } | null
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

  if (hidden) {
    return (
      <button
        type="button"
        data-testid="onboarding-checklist-collapsed"
        onClick={() => {
          setReopened(true)
          setDismissed(false)
        }}
        className="self-start inline-flex items-center gap-1.5 text-caption text-text-secondary hover:text-text-primary cursor-pointer"
      >
        <Icon name="checkCircle" size={13} />
        接入完成 · 查看上手清单（{doneCount}/5）
      </button>
    )
  }

  const rows: Array<{
    key: string
    title: string
    /** 这是什么 */
    what: string
    /** 为什么轮到你了 */
    why: string
    /** 现在点哪里、点完会发生什么；做完了就说"已经怎样了" */
    next: string
    done: boolean
    action: { label: string; onClick: () => void } | null
  }> = [
    {
      key: 'agent',
      title: '接入你的 AI 助手',
      what: '把你正在用的 AI 助手连到这个工作台，它就能读到项目资料，也能把做完的事登记回来。',
      why: '没有它，这里只有你一个人；接进来之后，读资料、登记、执行都由它做，你只定方向和验收。',
      next: status.hasApprovedCredential
        ? '已经接入并批准，后面几步由它和你一起走。'
        : status.hasRegisteredAgent
          ? '已经接入，它的名字在上方可见；下一步是批准它。'
          : '现在点「复制开场提示词」，粘给你在用的助手发出去。它会读到本机接入地址、自己申请接入；回到这里就能看见它的名字。',
      done: status.hasRegisteredAgent,
      action: { label: copiedKey === 'agent' ? '已复制' : '复制开场提示词', onClick: () => void copyPrompt('agent') }
    },
    {
      key: 'approved',
      title: '批准它的身份',
      what: '助手申请接入之后要你点头：审批页里列着它是谁、想动你的哪些东西。',
      why: '批准之后它才能写入项目资料、登记事项；在你点头之前，它只能读。',
      next: status.hasApprovedCredential
        ? '已批准，它可以写入你交给它的项目了。'
        : status.hasRegisteredAgent
          ? '现在点「前往审批」打开审批页，在它的申请上点「批准」。批完回来这里会打勾，它也能开始干活。'
          : '现在还没有助手申请；先做上面第 1 步，它申请之后这里才会出现「前往审批」。',
      done: status.hasApprovedCredential,
      action: status.hasRegisteredAgent
        ? { label: '前往审批', onClick: () => setMainView('approval') }
        : null
    },
    {
      key: 'basics',
      title: '在「关于我」里写下自己',
      what: '「关于我」是用户页里的一份档案：怎么称呼你、你习惯怎么沟通、哪些事要先问你、什么算做完。',
      why: '助手每次动手前先读它；没写清的地方它会先问你的偏好，再把准备怎么做交给你拍板。',
      next: status.basicsConfirmed
        ? '已经填好，助手会先读这份档案再动手。'
        : '现在点「去写关于我」打开用户页的「关于我」，在「基本情况」里填上怎么称呼你，点「保存并确认」。保存后这里打勾，它下次动手前就照着来。',
      done: status.basicsConfirmed,
      action: { label: '去写关于我', onClick: () => openUserSection('about') }
    },
    {
      key: 'protocol',
      title: '确认协作约定',
      what: '约定是五条写好的规则：各自干什么、怎么交接、怎么留痕、怎么沟通、用什么语言。',
      why: '它做事前按这份约定来；先看一遍再确认，以后不用每次从头交代。',
      next: status.globalProtocolConfirmed
        ? '已确认，助手会按这份约定跟你配合；想改随时去用户页逐条编辑。'
        : '现在点「一键确认」，这五条就按当前内容生效。之后想改，去用户页逐条编辑，改完再确认一次。',
      done: status.globalProtocolConfirmed,
      action: status.globalProtocolConfirmed ? null : { label: '一键确认', onClick: () => void confirmProtocol() }
    },
    {
      key: 'handoff',
      title: '让助手建第一个项目',
      what: '项目是一摊事的边界：背景、目标、做到什么算完，都落在它的接手说明里。',
      why: '助手只能把事项挂到项目下；有了项目和已确认的接手说明，它才知道从哪儿开始、做到哪儿停。',
      next: status.projectHandoffConfirmed
        ? '项目和接手说明都在了；助手可以在这摊事里提事项、接着做。'
        : '现在点「让助手建项目」会复制一段开场白。粘给助手后，它会建项目、写接手说明、登记第一条事项，等你拍板。',
      done: status.projectHandoffConfirmed,
      action: {
        label: copiedKey === 'handoff' ? '已复制' : '让助手建项目',
        onClick: () => void copyPrompt('handoff')
      }
    }
  ]

  return (
    <section
      data-testid="onboarding-checklist"
      className="rounded-card border border-border bg-bg-card shadow-sm overflow-hidden"
    >
      <div className="flex items-start justify-between gap-3 px-4 py-3 border-b border-border bg-surface-subtle">
        <div className="min-w-0">
          <div className="text-content font-semibold text-text-primary">
            {coreDone ? '接入完成' : '先把助手接进来'}
          </div>
          <p className="text-caption text-text-secondary mt-0.5">
            DeskPartner 是你和 AI 助手共用的工作台：你定方向、拍板、验收，它读项目背景、执行、留痕交付。
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-caption text-text-secondary font-mono">{doneCount}/5</span>
          <button
            type="button"
            aria-label="收起上手清单"
            data-testid="onboarding-checklist-collapse"
            onClick={() => setDismissed(true)}
            className="w-6 h-6 flex items-center justify-center rounded-button text-text-secondary hover:bg-black/5 hover:text-text-primary cursor-pointer"
          >
            <Icon name="chevronLeft" size={14} className="rotate-90" />
          </button>
        </div>
      </div>

      <div className="divide-y divide-border/60">
        {nameMissing && (
          <div className="flex items-center gap-2 px-4 py-2.5" data-testid="onboarding-name-row">
            <span className="text-caption text-text-secondary shrink-0">怎么称呼你</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="用于看板归属与协作动态"
              className="h-8 flex-1 min-w-0 px-2.5 rounded-button border border-border bg-bg-card text-label text-text-primary outline-none focus:border-accent"
            />
            <Button variant="ghost" size="sm" className="border border-border bg-surface-subtle px-2.5" onClick={commitName}>
              保存
            </Button>
          </div>
        )}
        {rows.map((row) => (
          <div key={row.key} className="flex items-start gap-3 px-4 py-2.5" data-testid={`onboarding-row-${row.key}`}>
            <span
              className={cn(
                'mt-0.5 w-4 h-4 rounded-full flex items-center justify-center shrink-0',
                row.done ? 'bg-accent text-white' : 'border border-border text-transparent'
              )}
            >
              <Icon name="check" size={11} />
            </span>
            <div className="min-w-0 flex-1">
              <div className={cn('text-label font-medium', row.done ? 'text-text-secondary' : 'text-text-primary')}>
                {row.title}
              </div>
              <p className="text-caption text-text-secondary leading-relaxed">{row.what}</p>
              <p className="text-caption text-text-secondary leading-relaxed">{row.why}</p>
              <p
                data-testid={`onboarding-next-${row.key}`}
                className={cn('text-caption leading-relaxed', row.done ? 'text-text-secondary' : 'text-text-primary')}
              >
                {row.next}
              </p>
            </div>
            {row.action && !row.done && (
              <Button
                variant="ghost"
                size="sm"
                data-testid={`onboarding-action-${row.key}`}
                className="shrink-0 border border-border bg-surface-subtle hover:bg-surface-muted px-2.5 text-text-primary"
                onClick={row.action.onClick}
              >
                {row.action.label}
              </Button>
            )}
          </div>
        ))}
      </div>
    </section>
  )
}
