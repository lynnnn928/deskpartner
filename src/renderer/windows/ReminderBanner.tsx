import React from 'react'
import { invoke } from '../lib/ipc-client'
import { Icon } from '../components/ui/Icon'
import { APPROVAL_ACTION, forceConfirmLabel } from '../lib/approval-copy'

/**
 * 顶部提醒横幅
 *
 * 1.0.34 起替代 Windows 系统通知。此前用 Notification：位置固定右下角、
 * 底色跟系统主题走，代码控制不了 —— 主用户要求提醒从**屏幕上方**弹出、
 * 警告类底色用**红色**。
 *
 * 红底白字不是装饰：提醒是"需要你行动"的事，不是"顺便告诉你"的事，
 * 配色要跟普通气泡拉开差距。整条横幅就是窗口本身（透明窗口 + 内容贴满），
 * 没有多余的空白区域挡鼠标。
 *
 * 两个出口：
 * - 「去处理」：打开看板并收起横幅
 * - 「知道了」：只收起横幅（事项还在待办里，不会丢）
 *
 * ⚠️ 1.0.37 起这条通道同时承载**授权申请提醒**（type=grant）。
 * 主用户反馈"界面上没有看到任何审批提醒，或者可以去审批的地方"——
 * 而 agent 发起申请后正卡在那一步上等，人不知道就等于它一直卡着。
 * 两种提醒共用一条通道是刻意的：都是"需要你点头"的事，位置与样式也该一致；
 * 差别只在动作（去处理 → 看板；去审批 → 设置页那一屏）。
 *
 * ⚠️ 1.0.63 起还要再分出一类：**新 agent 接入**（todoId 形如 `agent:<id>`）。
 * 它同样要人点一下头（批准写入），但**不是一条卡住的命令** ——
 * 没有"允许/拒绝这条申请"可点，硬套直批那排按钮只会得到一个
 * 「没有待表态的申请了」，比不给按钮更让人困惑。所以只保留「去审批」
 * 与「知道了」，文案也换成"它刚到"而不是"它卡着"。
 *
 * 🚨 1.0.65 修：**内容必须跟随 hash 变化**（她 2026-10-01 报的缺陷）。
 *
 * 症状：桌面上弹出「Carol 已接入，等你批准写入 —— 它现在只能读，不能写」，
 * 而审批页里实际待批的是「Carol 想【改界面】ui reset --key theme」——
 * 横幅说的和真正等着处理的事**不是同一件**。
 *
 * 根因：主进程复用横幅窗口时只 `loadRoute` 改 hash（windows.ts 的
 * `if (this.reminderWin && !this.reminderWin.isDestroyed())` 分支），
 * Chromium 走**同文档导航** —— 不重载 JS、组件不重挂载。
 * 而本组件此前只在渲染时读一次 `location.hash`，于是内容停在第一次，
 * 后面每次复用都只是在"旧的截图"上换了一串没人看的 URL。
 *
 * 同一个坑本项目已经踩过两次（Kanban 的 `?view=` 深链、QuickAdd 的
 * `?todoId=` 编辑态），两处都靠监听 `hashchange` 解决 —— 这里是第三处。
 * **判据：凡是"窗口会被复用、内容靠 hash 区分"的组件，都必须监听 hashchange。**
 *
 * 🚨 1.0.117 修（卡 `21f171f1` + `0dfff6df`）：横幅必须放得下它自己说的话。
 *
 * 症状（Bob 1.0.116 验收）：高度写死 104，标题 `line-clamp-2` 截断，回执、
 * 五个按钮、目标摘要全挤在那 104px 里 —— 人被要求在一段看不见后半截的文案上点头。
 *
 * 现在三件事一起改：
 *  1. 根节点是**内容高度**（不再 `h-full`），量出来的高度上报给主进程去改窗口
 *     （`window:fitReminderBanner`）—— 透明窗口的空白也吃鼠标，所以不能猜一个大高度；
 *  2. 标题不截断，目标摘要单独一行（`detail`），发起方 / 要动什么 / 目标名三样都读得到；
 *  3. 撞守卫时横幅自己给出下一步（`canForce`）—— 补 `--force` 是**另一次点头**，
 *     不该让被挡的人去审批页重来一遍，也不该让横幅只说一句"失败了"。
 */

/** 从 hash 解析横幅要展示的一切（渲染时与 hashchange 时共用同一份逻辑） */
function readBannerRoute() {
  const qs = new URLSearchParams(window.location.hash.split('?')[1] ?? '')
  const kind = qs.get('type') ?? 'reminder'
  const title = qs.get('title') ?? '（无标题）'
  /** 第二行：授权横幅放目标摘要（"todo rm《…》"），到点提醒没有这一行 */
  const detail = qs.get('detail') ?? ''
  const category = qs.get('category') ?? ''
  const todoId = qs.get('todoId') ?? ''
  const isGrant = kind === 'grant'
  /**
   * 新 agent 接入（1.0.63）：todoId 是 `agent:<id>`，与授权申请的
   * `grant:<agentId>:<scope>` 同走 kind='grant'，靠 todoId 前缀区分。
   */
  const isAgentArrival = isGrant && todoId.startsWith('agent:')
  /** 授权横幅的 todoId 形如 grant:<agentId>:<scope>（主进程拼的，见 index.ts） */
  const grantTarget = isGrant && !isAgentArrival ? parseGrantTarget(todoId) : null
  return { title, detail, category, todoId, isGrant, isAgentArrival, grantTarget }
}

/** 一次表态的回执：能不能补 --force 再试一次，靠 `canForce` + `grantId` 决定 */
interface BannerOutcome {
  ok: boolean
  text: string
  /** 守卫明说了要补 `--force` —— 那就给一个能点的下一步（`f9cd007e`） */
  canForce?: boolean
  /** 要补 `--force` 的那条申请：失败后它仍是 granted，查不到 pending 了，得记住 id */
  grantId?: string
}

const ReminderBanner: React.FC = () => {
  /**
   * 路由状态化：hash 变了要重渲染。
   *
   * 不能写成 `const { title } = readBannerRoute()` —— 那样只在挂载时算一次，
   * 复用窗口不重挂载，内容就永远停在第一次（这就是本次缺陷）。
   * 与 useQuickAddRoute / Kanban 的深链同步同一套做法。
   */
  const [route, setRoute] = React.useState(readBannerRoute)

  const [busy, setBusy] = React.useState<string | null>(null)
  const [outcome, setOutcome] = React.useState<BannerOutcome | null>(null)

  /**
   * hash 一变就换内容，**并把上一次的回执清掉**。
   *
   * 清回执不是顺手做的：回执（"已通过并执行：…"）是**上一条**横幅的结论，
   * 窗口复用时它会留在 DOM 里，叠在新一条内容下面 ——
   * 于是又变成"横幅在说一件已经过去的事"，正是本次要修的那个缺陷的变体。
   * 换内容 = 换话题，旧结论必须一起走。
   */
  React.useEffect(() => {
    const onHashChange = () => {
      setRoute(readBannerRoute())
      setOutcome(null)
      setBusy(null)
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  const { title, detail, category, todoId, isGrant, isAgentArrival, grantTarget } = route

  /**
   * 窗口高度跟着内容走（1.0.117，卡 `21f171f1`）
   *
   * 为什么是"量了再报"而不是"让窗口够大"：这是条**透明**窗口，
   * 透明处的矩形照样接收鼠标事件 —— 多留一条空白，下面的窗口就点不到
   * （与快速新增同一课，见 windows.ts 的 resizeQuickAdd）。
   *
   * 为什么不用 requestAnimationFrame：离屏/透明窗口里它可能**永远不触发**
   * （本项目实测过），那样高度就永远停在初始值，等于没修。
   */
  const rootRef = React.useRef<HTMLDivElement | null>(null)
  React.useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const report = () => {
      const height = Math.ceil(el.getBoundingClientRect().height)
      if (height > 0) void invoke('window:fitReminderBanner', { height }).catch(() => {})
    }
    report()
    // 字体晚到、长文案换行宽度变化都可能再改一次高度，观察自身尺寸兜住
    const observer = new ResizeObserver(report)
    observer.observe(el)
    return () => observer.disconnect()
  }, [route, outcome, busy])

  const dismiss = () => void invoke('window:hideReminderBanner')

  /**
   * 稍后提醒：10 分钟后重新到点。
   * reminder:snooze 通道早就注册在 IPC 上，只是一直没有按钮 —— 本批接通（1.0.48）。
   */
  const snooze = async () => {
    if (todoId) await invoke('reminder:snooze', { todoId, minutes: 10 })
    await invoke('window:hideReminderBanner')
  }

  const openKanban = async () => {
    await invoke('window:showKanban')
    await invoke('window:hideReminderBanner')
  }

  /**
   * 去审批：打开主窗口并落到**用户页**（1.0.48 审批语义整体迁入）。
   * 多条待表态时横幅只代表最新一条，完整台面仍在审批面。
   */
  const openApproval = async () => {
    await invoke('window:showKanban', { view: 'approval' })
    await invoke('window:hideReminderBanner')
  }

  /**
   * 把一次 `agent:resolveGrant` 的结果摆到横幅上（1.0.117）
   *
   * 三条出口分开处理，因为人对它们的期待不同：
   * - 成功：给命令自己的结论（人话），看过就收；
   * - 需要补 `--force`：**不收**（见下面的定时器条件），并给一个能点的按钮 ——
   *   让她看着"还差一步"却无处可点，正是这张卡要治的病；
   * - 其它失败：说清为什么，同样停一会儿。
   */
  const applyExecution = (
    grantId: string,
    execution: { ok: boolean; message: string; canForce?: boolean } | null | undefined
  ) => {
    if (!execution) {
      setOutcome({ ok: true, text: '已通过。' })
      return true
    }
    if (execution.ok) {
      setOutcome({ ok: true, text: execution.message })
      return true
    }
    const canForce = execution.canForce === true
    setOutcome({ ok: false, text: execution.message, canForce, grantId })
    return !canForce
  }

  /**
   * 已经有 id 的表态（"允许并强制"那条重试）
   *
   * 为什么必须带 id 而不是再查一次 pending：撞守卫之后授权**仍然是 granted**
   * （执行失败不吃掉人的点头，见 ipc.ts），它已经不在 pending 列表里了。
   */
  const resolveGrantById = async (grantId: string, withForce: boolean) => {
    setBusy(withForce ? 'force' : 'once')
    try {
      const r = await invoke('agent:resolveGrant', {
        grantId,
        allow: true,
        longTerm: false,
        withForce
      })
      const keep = applyExecution(grantId, r?.execution)
      if (!keep) return
      window.setTimeout(() => void invoke('window:hideReminderBanner'), 2600)
    } catch (e) {
      setOutcome({ ok: false, text: (e as Error).message })
    } finally {
      setBusy(null)
    }
  }

  /**
   * 横幅直批（1.0.48，设计拍板 G）：允许一次 / 始终允许 / 拒绝（措辞走 approval-copy，卡 66be78f4）。
   *
   * 横幅不带 grantId —— 它本来就是"最新那条申请"的推送。
   * 表态时现拉待表态列表，取**与横幅目标匹配的最新一条**表态；
   * 批准即执行（服务端当场跑那条命令，回执直接显示在横幅上）。
   * 需要看清申请内容才能定的复杂动作仍去审批面 —— 快而准优先于全。
   */
  const resolveLatest = async (allow: boolean, longTerm: boolean) => {
    setBusy(allow ? (longTerm ? 'long' : 'once') : 'deny')
    try {
      const grants = await invoke('agent:listGrants', { status: 'pending', activeOnly: true })
      const matched = grantTarget
        ? grants.filter((g) => g.agentId === grantTarget.agentId && g.scope === grantTarget.scope)
        : []
      const target = matched[0] ?? grants[0]
      if (!target) {
        setOutcome({ ok: false, text: '该申请已处理' })
        return
      }
      if (!allow) {
        await invoke('agent:resolveGrant', { grantId: target.id, allow: false, longTerm: false })
        setOutcome({ ok: true, text: '已拒绝' })
      } else {
        const r = await invoke('agent:resolveGrant', {
          grantId: target.id,
          allow: true,
          longTerm
        })
        const keep = applyExecution(target.id, r?.execution)
        // 需要"补一次点头"时**不自动收**：按钮还在上面，收了就等于把人晾在半路
        if (!keep) return
      }
      // 回执看两眼再收：执行结果必须被人看见，不能一闪而过
      window.setTimeout(() => void invoke('window:hideReminderBanner'), 2600)
    } catch (e) {
      setOutcome({ ok: false, text: (e as Error).message })
    } finally {
      setBusy(null)
    }
  }

  return (
    <div
      ref={rootRef}
      className="w-full select-none rounded-xl bg-red-600 text-white shadow-lg px-4 py-3 flex flex-col gap-2"
      role="alert"
    >
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-label font-semibold shrink-0 opacity-90 inline-flex items-center gap-1.5">
          <Icon name={isGrant ? 'shield' : 'bell'} size={14} />
          {isAgentArrival ? '接入申请' : isGrant ? '操作申请' : '事项提醒'}
        </span>
        {category && (
          <span className="text-label shrink-0 rounded-full bg-white/20 px-2 py-0.5">
            {category}
          </span>
        )}
      </div>
      {/*
        标题不截断（1.0.117）：以前是 `line-clamp-2`，被截掉的那一截恰好是目标名，
        而"对哪一条动手"正是人点头的唯一依据。高度现在跟着内容走，不用再藏字。
      */}
      <div className="text-content font-medium leading-snug break-words" title={title}>
        {title}
      </div>
      {detail && (
        <div className="text-label leading-snug break-words text-white/85" title={detail}>
          {formatBannerDetail(detail)}
        </div>
      )}

      {/* 直批回执：批准即执行的结果必须留在横幅上给人看见（2.6s 后自动收起） */}
      {outcome && (
        <div
          className={`text-label leading-snug break-words rounded-md px-2 py-1.5 ${
            outcome.ok ? 'bg-white/10 text-white/95' : 'bg-black/25 text-yellow-100'
          }`}
          role="status"
        >
          {outcome.text}
        </div>
      )}

      {/*
        撞守卫后的下一步（1.0.117，卡 `0dfff6df`）：
        横幅此前只读 `execution.ok` / `.message`，读不到 `canForce` ——
        于是"这个删除被'还有子任务'挡下、补个 --force 就能继续"这条信息
        只在审批页有出口。横幅这条路撞上守卫就是死路。
      */}
      {outcome?.canForce && outcome.grantId && (
        <div className="flex items-center gap-2 justify-end">
          <button
            disabled={busy !== null}
            className="text-label font-semibold rounded-md px-2.5 py-1 border border-white/50 bg-red-800 hover:bg-red-900 transition-colors disabled:opacity-50"
            onClick={() => void resolveGrantById(outcome.grantId as string, true)}
          >
            {busy === 'force' ? '执行中…' : forceConfirmLabel('删除')}
          </button>
        </div>
      )}

      {/* 按钮可以换行：授权那条路有五个按钮，440 宽一行放不下就挤成一团 */}
      <div className="flex items-center gap-2 justify-end flex-wrap">
        {!isGrant && todoId && (
          <button
            className="text-label rounded-md px-2.5 py-1 hover:bg-white/15 transition-colors"
            onClick={() => void snooze()}
            title="10 分钟后再次提醒"
          >
            稍后提醒
          </button>
        )}
        <button
          className="text-label rounded-md px-2.5 py-1 hover:bg-white/15 transition-colors"
          onClick={dismiss}
        >
          {outcome?.canForce ? '取消' : '关闭'}
        </button>
        {isGrant ? (
          <>
            <button
              className="text-label rounded-md px-2.5 py-1 hover:bg-white/15 transition-colors"
              onClick={() => void openApproval()}
              title="去审批页查看与处理"
            >
              去审批
            </button>
            {/*
              直批那排按钮只属于**授权申请**：新 agent 接入没有"这一条申请"，
              套上去只会得到「没有待表态的申请了」（见文件头注释）。
              拒绝身份也不在这里给 —— 那是"要不要长期接纳它"的决定，
              值得在审批页看清它请求了什么再定，不适合横幅一秒点掉。
            */}
            {!isAgentArrival && (
              <>
                {/* 拒绝与两个允许隔开摆放（防误触） */}
                <button
                  disabled={busy !== null}
                  className="text-label rounded-md px-2.5 py-1 border border-white/40 hover:bg-white/10 transition-colors disabled:opacity-50"
                  onClick={() => void resolveLatest(false, false)}
                >
                  {busy === 'deny' ? '拒绝中…' : APPROVAL_ACTION.reject}
                </button>
                <button
                  disabled={busy !== null}
                  className="text-label font-semibold rounded-md px-2.5 py-1 bg-white text-red-700 hover:bg-red-50 transition-colors disabled:opacity-50"
                  onClick={() => void resolveLatest(true, false)}
                >
                  {busy === 'once' ? '允许中…' : APPROVAL_ACTION.allowOnce}
                </button>
                <button
                  disabled={busy !== null}
                  className="text-label font-semibold rounded-md px-2.5 py-1 bg-white text-red-700 hover:bg-red-50 transition-colors disabled:opacity-50"
                  onClick={() => void resolveLatest(true, true)}
                >
                  {busy === 'long' ? '允许中…' : APPROVAL_ACTION.allowAlways}
                </button>
              </>
            )}
          </>
        ) : (
          <button
            className="text-label font-semibold rounded-md px-2.5 py-1 bg-white text-red-700 hover:bg-red-50 transition-colors"
            onClick={() => void openKanban()}
          >
            去处理
          </button>
        )}
      </div>
    </div>
  )
}

/** grant 横幅的 todoId 是主进程拼的 `grant:<agentId>:<scope>`，解析回来做匹配 */
function parseGrantTarget(todoId: string): { agentId: string; scope: string } | null {
  if (!todoId.startsWith('grant:')) return null
  const rest = todoId.slice('grant:'.length)
  const idx = rest.indexOf(':', 'agent:'.length)
  if (idx <= 0) return null
  return { agentId: rest.slice(0, idx), scope: rest.slice(idx + 1) }
}

function formatBannerDetail(raw: string): string {
  const s = raw.trim()
  const rules: Array<[RegExp, string]> = [
    [/^todo\s+rm\s*(「.+)$/i, '删除事项$1'],
    [/^todo\s+comment-rm\s*(「.+)$/i, '删除评论$1'],
    [/^category\s+rm\s*(「.+)$/i, '删除分类$1'],
    [/^release\s+rm\s*(「.+)$/i, '删除版本$1'],
    [/^memo\s+rm\s*(「.+)$/i, '删除备忘$1'],
    [/^project\s+rm\s*(「.+)$/i, '删除项目$1']
  ]
  for (const [re, replacement] of rules) {
    if (re.test(s)) return s.replace(re, replacement)
  }
  return raw
}

export default ReminderBanner
