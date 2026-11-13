/**
 * 就地提示（coach-mark）的选路与「看过就记」（卡 `a19054a1`）
 *
 * ── 为什么不是一条多步演示 ──
 *
 * NN/g《Onboarding Tutorials vs. Contextual Help》的结论：多步教程会被跳过，
 * 真正需要它的时候又不在手边。起作用的是 **pull 式就地提示** ——
 * 跟着真实状态出现、只讲眼前这一件事、关掉就不再打扰。
 *
 * ── 三处提示为什么长在这些地方 ──
 *
 * 全部由库里真实的东西触发，不造演示数据（假数据会让人学会点不动的按钮）：
 * ① 有助手在等我批准 → 指「审批」导航项
 * ② 列表里有一条等我拍板 → 指那一行
 * ③ 详情里开着的那条正等我拍板 → 指状态按钮
 *
 * ── 为什么记的是「关过」而不是「引导做完」 ──
 *
 * 引导进度只由 `getOnboardingStatus` 从数据推算（见 `onboarding.ts`），
 * 这里只记"这条提示关过了、别再挡路"。两件事混成一个字段，迟早互相撒谎。
 */

export type CoachMarkId = 'approval' | 'proposed' | 'decide'

export interface CoachMarkDef {
  id: CoachMarkId
  /** 在三步流程里的序号（界面上显示 `n/3`） */
  step: number
  /** 锚点选择器：锚在真实控件上，不画坐标 */
  anchor: string
  title: string
  body: string
}

export const COACH_MARKS: CoachMarkDef[] = [
  {
    id: 'approval',
    step: 1,
    anchor: '[data-coach-target="approval-nav"]',
    title: '你的助手在门外',
    body: '它已经提出接入申请。在「审批」里点一下批准，它才能写入；在你点头之前，它只能读。'
  },
  {
    id: 'proposed',
    step: 2,
    anchor: '[data-coach-target="todo-row"][data-todo-status="proposed"]',
    title: '有一条等你拍板',
    body: '助手登记了一条「待确认」事项。点开它，决定做不做 —— 它不会自己开工。'
  },
  {
    id: 'decide',
    step: 3,
    anchor: '[data-coach-target="status-actions"]',
    title: '这一下由你定',
    body: '把状态推进一步，它才会开始做；不认可就驳回，写一句原因它会照着重做。'
  }
]

export const COACH_TOTAL = COACH_MARKS.length

/** 现在有没有条件显示某一处提示 */
export interface CoachConditions {
  /** 有助手在等我批准 */
  pendingApproval: boolean
  /** 列表里有一条待确认事项 */
  firstProposed: boolean
  /** 详情里开着的那条正等我拍板 */
  decidingProposed: boolean
}

export interface CoachSeen {
  seen: Partial<Record<CoachMarkId, boolean>>
  /** 点过「跳过引导」：这一轮都不再出现（重装/清数据前一直有效） */
  skipped: boolean
}

const STORAGE_KEY = 'deskpartner.coachMarks.v1'

export const EMPTY_SEEN: CoachSeen = { seen: {}, skipped: false }

const conditionOf = (id: CoachMarkId, c: CoachConditions): boolean => {
  if (id === 'approval') return c.pendingApproval
  if (id === 'proposed') return c.firstProposed
  return c.decidingProposed
}

/**
 * 该显示哪一处提示 —— 按步骤顺序取第一条「有触发条件且没关过」的
 *
 * 为什么按顺序而不是"谁先出现显示谁"：三步本身就是一条因果链
 * （先批准 → 才有事项 → 才谈得上拍板）。条件不成立的那条会被自然跳过。
 */
export function pickCoachMark(conditions: CoachConditions, seen: CoachSeen): CoachMarkDef | null {
  if (seen.skipped) return null
  for (const mark of COACH_MARKS) {
    if (seen.seen[mark.id]) continue
    if (conditionOf(mark.id, conditions)) return mark
  }
  return null
}

export function readSeen(): CoachSeen {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return EMPTY_SEEN
    const parsed = JSON.parse(raw) as Partial<CoachSeen> | null
    return { seen: parsed?.seen ?? {}, skipped: parsed?.skipped === true }
  } catch {
    return EMPTY_SEEN
  }
}

function writeSeen(next: CoachSeen): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    /* 记不住就记不住：这次关掉、下次可能再出现一次，不影响别的功能 */
  }
}

export function rememberSeen(id: CoachMarkId): CoachSeen {
  const next: CoachSeen = { ...readSeen(), seen: { ...readSeen().seen, [id]: true } }
  writeSeen(next)
  return next
}

export function skipAllCoaches(): CoachSeen {
  const next: CoachSeen = { ...readSeen(), skipped: true }
  writeSeen(next)
  return next
}

/** 想再看一遍（换个新助手、或者当时点快了） */
export function resetCoaches(): CoachSeen {
  writeSeen(EMPTY_SEEN)
  return EMPTY_SEEN
}
