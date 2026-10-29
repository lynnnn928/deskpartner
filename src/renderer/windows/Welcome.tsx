import React, { useEffect, useState } from 'react'
import { useSettingsStore } from '../stores/settings.store'
import { invoke } from '../lib/ipc-client'

/**
 * 首次见面：装完之后我拿它干嘛？（1.0.64）
 *
 * ── 这一屏补的是什么洞 ──
 *
 * 产品最独特的地方是"AI 能接进来一起用"，但此前**没人领新用户进门**：
 * 他下载、安装、打开，看到一个空看板，不知道还有个 AI 接入层。
 * 接入说明是给 AI 看的，可第一步（去复制、去贴）必须由人来启动 ——
 * 而没有任何一处告诉过他这件事。于是最值钱的卖点成了唯一没人带他看的部分。
 *
 * ── 为什么只看一次，不做「下次不再弹出」勾选框 ──
 *
 * 设计过带勾选框、不勾就反复弹的版本，否掉了：用户点 X 表达的是
 * "我现在不想看"（这次），不等于"我永远不需要"（永远）。让一个 X 承担两件事，
 * 必然错一个 —— 而错了的那半会让软件显得烦人。
 * 反复弹的收益（极少人想看第二次）远小于代价（每个新用户被骚扰）。
 *
 * 敢做成"只看一次"的底气在于：**入口是常驻的**。
 * 用户页「AI 助手接入」随时能拿到同一份说明，"再弹一次"根本不需要存在。
 *
 * ── 与「问名字」那个引导怎么共存 ──
 *
 * 两个都是首次启动弹窗，会叠在一起。顺序由主进程控制：
 * 先问名字（老机制），关掉之后才接这一个（见 windows.ts showOnboarding 的 closed 回调）。
 * 用户真正看到的是一次一个，不打架。
 */
const WELCOME_STEPS = [
  { title: '① 接入一个 AI 助手', text: '复制接入说明给你的 agent。它按说明办理身份注册和凭据；注册并不等于获准写入。' },
  { title: '② 在审批页批准接入', text: 'agent 登记后会出现在「审批」页。你在这里确认身份与请求；正式档案和协议内容仍在用户页查看、编辑。' },
  { title: '③ 让 agent 了解你，再了解项目', text: 'agent 可以起草基本档案或协作协议修改，必须由你在审批页审核后才生效；之后再读取项目接手说明和事项。' }
] as const

const OPENING_INSTRUCTION = `请先阅读 DeskPartner 接入说明：若通过 MCP，先读 initialize.instructions 和工具说明；若通过命令行，用 node 调用 DeskPartner 安装目录下的 resources/cli/deskpartner.cjs（环境变量 DESKPARTNER_CLI 指向它）跑 skill。两种入口都找不到时向主用户索取 DeskPartner 的接入配置，不要据此判定产品不存在。不要猜测主用户的身份、习惯或授权边界。按所用接口办理 agent 身份注册与凭据手续，然后等待主用户在「审批」页批准；批准前只进行允许的只读操作。获批后先读取用户档案和协作协议，再根据主用户提供的信息提出必要修改建议，未经审批不得把建议当成事实或正式协议。随后读取指定项目的接手说明、历史决定和当前事项；不确定时说明依据并询问。`

const Welcome: React.FC = () => {
  const { settings, updateSettings } = useSettingsStore()
  const [copied, setCopied] = useState(false)
  const [instructionCopied, setInstructionCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [step, setStep] = useState(0)
  const [playing, setPlaying] = useState(true)

  useEffect(() => {
    if (!playing) return
    const timer = window.setInterval(() => {
      setStep((current) => {
        if (current >= WELCOME_STEPS.length - 1) {
          setPlaying(false)
          return current
        }
        return current + 1
      })
    }, 4200)
    return () => window.clearInterval(timer)
  }, [playing])

  const replay = () => { setStep(0); setPlaying(true) }
  const copyOpeningInstruction = async () => {
    try {
      await navigator.clipboard.writeText(OPENING_INSTRUCTION)
      setInstructionCopied(true)
      window.setTimeout(() => setInstructionCopied(false), 2200)
    } catch {
      setError('无法复制开场指令，请检查系统剪贴板权限')
    }
  }

  /**
   * 关窗即置 welcomeShown=true，之后不再打扰。
   *
   * 与 Onboarding 同一个理由走 window:control：这个窗口只出现一次，
   * 不值得为此新开一条 IPC 契约（每加一条都要在类型、闸门、主进程三处同步）。
   *
   * ⚠️ 写失败就不关（与 Onboarding 一致）：静默关掉等于"标记没写成、
   * 窗口也不见了"，下次启动会再弹一遍而用户以为自己关过了 —— 那种不一致最难查。
   */
  const finish = async () => {
    try {
      await updateSettings({ welcomeShown: true })
      await invoke('window:control', { action: 'close' })
    } catch {
      setError('没能保存状态，请再点一次「知道了」')
    }
  }

  // Esc = 知道了（与点按钮等价，都记为已看过）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') void finish()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** 复制这份说明，交给用户的 AI 助手 —— 内容与用户页「AI 助手接入」同源 */
  const handleCopy = async () => {
    setError(null)
    try {
      const text = await invoke('cli:agentGuide')
      if (typeof text !== 'string' || !text.trim()) {
        throw new Error('未取到说明内容')
      }
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <div className="window-frame bg-bg-primary h-full w-full flex flex-col min-h-0 px-6 py-5 select-none">
      <div className="flex-1 min-h-0 flex flex-col justify-center gap-3 max-w-3xl w-full mx-auto">
        <h1 className="text-title">欢迎使用 DeskPartner</h1>
        <p className="text-label text-text-secondary leading-relaxed">
          DeskPartner 是人和 AI 共用的工作台。你负责确认身份与约定；agent 读取同一份用户档案、协作协议和项目记录。
        </p>

        <div className="rounded-card border border-border bg-bg-card p-4 min-h-44" aria-live="polite">
          <div className="flex items-center justify-between gap-3">
            <span className="text-label text-accent font-medium">第 {step + 1} 步 / {WELCOME_STEPS.length}</span>
            <span className="text-label text-text-tertiary">{playing ? '演示播放中' : '演示已暂停'}</span>
          </div>
          <h2 className="mt-2 text-body font-medium text-text-primary">{WELCOME_STEPS[step].title}</h2>
          <p className="mt-1 text-label text-text-secondary leading-relaxed">{WELCOME_STEPS[step].text}</p>
          <div className="mt-4 min-h-16 flex items-center justify-center rounded-input bg-bg-secondary p-3">
            {step === 0 && (
              <div className="flex flex-wrap items-center justify-center gap-3 text-label">
                <span className="rounded-input border border-border bg-bg-card px-3 py-2">你：复制接入说明</span>
                <span className="text-accent animate-pulse">→</span>
                <span className="rounded-input border border-accent/40 bg-bg-card px-3 py-2">Agent：注册身份 · 领取凭据</span>
              </div>
            )}
            {step === 1 && (
              <div className="w-full max-w-md rounded-input border border-accent/40 bg-bg-card p-3 flex items-center justify-between gap-3">
                <div><div className="text-label font-medium text-text-primary">审批页 · Agent 接入</div><div className="text-label text-text-secondary mt-1">新助手正在等待主用户批准</div></div>
                <span className="rounded-input bg-accent px-3 py-1.5 text-label text-white">批准接入</span>
              </div>
            )}
            {step === 2 && (
              <div className="w-full max-w-md rounded-input border border-warning/40 bg-bg-card p-3">
                <div className="text-label font-medium text-text-primary">审批页 · 档案 / 协议修改提议</div>
                <div className="mt-2 flex items-center gap-2 text-label"><span className="flex-1 rounded-input bg-bg-secondary px-2 py-2 text-text-secondary">Agent 提议，尚未生效</span><span className="text-accent animate-pulse">→</span><span className="rounded-input bg-accent px-3 py-2 text-white">你审核后采纳</span></div>
              </div>
            )}
          </div>
          <div className="mt-3 flex items-center justify-between gap-2">
            <div className="flex gap-1" aria-label="演示步骤">
              {WELCOME_STEPS.map((item, index) => <span key={item.title} className={`w-2 h-2 rounded-full ${index === step ? 'bg-accent' : 'bg-border'}`} />)}
            </div>
            <div className="flex gap-2">
              <button type="button" onClick={replay} className="text-label text-accent hover:underline">重播</button>
              <button type="button" onClick={() => void finish()} className="text-label text-text-secondary hover:text-text-primary">跳过</button>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 mt-1">
          <button onClick={() => void copyOpeningInstruction()} className="h-9 px-4 rounded-input bg-accent text-white text-label transition-opacity hover:opacity-90">
            {instructionCopied ? '开场指令已复制' : '复制给 Agent 的开场指令'}
          </button>
          <button onClick={() => void handleCopy()} className="h-9 px-3 rounded-input border border-border text-label text-text-primary hover:bg-bg-secondary">
            {copied ? '接入说明已复制' : '复制完整接入说明'}
          </button>
          <button onClick={() => void finish()} className="h-9 px-3 rounded-input text-label text-text-secondary hover:text-text-primary">开始使用</button>
        </div>

        {error && <p className="text-label text-danger" role="alert">{error}</p>}
      </div>
    </div>
  )
}

export default Welcome
