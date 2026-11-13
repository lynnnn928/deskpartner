import { describe, expect, it } from 'vitest'
import { buildFreshPrompt, buildMigratePrompt } from '../../../src/renderer/lib/onboarding-prompts'
import {
  ONBOARDING_STEP_ORDER,
  nextOnboardingStep,
  type OnboardingStatus,
  type OnboardingStepKey
} from '../../../src/renderer/lib/onboarding'

/**
 * 清单顺序 = 开场提示词顺序（2026-11-14 主用户拍板，卡 `a19054a1`）
 *
 * ── 要拦的是什么 ──
 *
 * 清单原来把「建第一个项目」排在第三位，写在「写下关于我」「确认协作约定」之前。
 * 主用户的业务流程不是这样：「注册进来之后查看说明文档……作为第一个注册的 Agent
 * 它有责任跟用户沟通，把『我的档案』登记上去，并介绍协作方式 → 沟通确认后提交档案
 * 与约定的确认信息，由用户到审批页审批 → 审批结束之后，才看有无项目、要不要接入项目」。
 * 她的判据原话：**「而不是上来注册审批完就直接建第一个项目」**。
 *
 * 产品设计顺序的**唯一出处**是开场提示词（`lib/onboarding-prompts.ts`）：
 * 助手拿到的就是那一份，它照着走的顺序，就是清单该列的顺序。
 *
 * ── 上一版为什么是空闸门（2026-11-14，fable-5.2 复核抓到）──
 *
 * 上一版用 `readFileSync` 读提示词的**源码**、在整份文件里找命令名的首次出现位置。
 * 三个后果，每一个都让闸门失去意义：
 *
 *  ① `project add` 在两版全流程提示词里**根本不存在**（它只出现在
 *     `buildFirstProjectPrompt` / `buildProjectPrompt` 里），所以「顺序对上了」
 *     其实是拿另外两个函数的正文凑出来的；
 *  ② 在提示词里真挪一步（把第 6 步搬到第 4 步前面）闸门照样绿；
 *  ③ 只把 `buildFirstProjectPrompt` 的定义搬到 `buildMigratePrompt` 前面
 *     —— 提示词一个字没改 —— 闸门反而红。**判的是文件排版，不是产品行为。**
 *
 * ── 现在怎么判 ──
 *
 * 只读**成品文本**：`buildMigratePrompt(null)` / `buildFreshPrompt(null)` 的输出，
 * 就用户/助手真拿到的那一份。从「请按以下顺序工作：」到「【硬要求】」之间逐行取
 * 编号步骤（行首 `n.`），再让每一步用自己的锚点命中**恰好一个**编号步骤 ——
 * 0 个或 ≥2 个都算闸门失败（0 个说明这一步在产品流程里没位置了；≥2 个说明
 * 同一件事被写了两遍，顺序也就无从判起）。
 *
 * 顺序 = 命中步骤的编号（同步内按锚点在步骤正文里的先后），再要求
 * 它等于清单的 `ONBOARDING_STEP_ORDER`，并且 `nextOnboardingStep` 循着同一顺序
 * 一步一步往前指、最后落到 null（不跳步、不停在错的行）。
 *
 * 这里**不手写一份顺序**、也不正则剥源码：挪一步就是挪真的一行，闸门只有一种
 * 变红的理由 —— 提示词里说的顺序变了。
 */

/** 步骤段落的起止标记（两版提示词共用） */
const STEPS_HEADER = '请按以下顺序工作'
const STEPS_END = '【硬要求】'

/**
 * 每一步在提示词里的锚点 —— 意思是「这一步在这份流程里怎么被说出来」。
 *
 * 选的时候对着两版提示词一个字一个字核过：每个锚点在两版里都**只出现在**
 * 该出现的那一步。改文案时锚点跟着改，闸门会点名是哪一个锚点失配。
 */
const STEP_ANCHOR: Record<OnboardingStepKey, string> = {
  /** 第 2 步「办理身份注册与凭据手续（agent register → agent credential）」 */
  agent: 'agent register',
  /** 第 2 步「等待主用户在「审批」页批准」 */
  approved: '「审批」页批准',
  /** 第 4 步「起草档案修改提议（profile propose）」 */
  basics: 'profile propose',
  /** 第 5 步「再起草提议（protocol propose）交主用户在审批页采纳」 */
  protocol: 'protocol propose',
  /** 第 6 步「逐个建项目、提议接手说明」 —— 清单第 5 步要的是接手说明被采纳 */
  handoff: '接手说明'
}

interface NumberedStep {
  /** 步骤编号（提示词里印给助手看的那个数字） */
  n: number
  text: string
}

/** 抽出「请按以下顺序工作：」到「【硬要求】」之间的编号步骤 */
function numberedSteps(prompt: string, label: string): NumberedStep[] {
  const start = prompt.indexOf(STEPS_HEADER)
  expect(start, `${label} 里找不到「${STEPS_HEADER}」`).toBeGreaterThan(-1)
  const afterHeader = prompt.slice(start + STEPS_HEADER.length)
  const end = afterHeader.indexOf(STEPS_END)
  const section = end >= 0 ? afterHeader.slice(0, end) : afterHeader
  const steps: NumberedStep[] = []
  for (const line of section.split('\n')) {
    const matched = line.trim().match(/^(\d+)\.\s+(\S.*)$/)
    if (!matched) continue
    steps.push({ n: Number(matched[1]), text: matched[2] })
  }
  expect(steps.length, `${label} 的编号步骤一行都没解析出来`).toBeGreaterThan(0)
  return steps
}

/**
 * 从成品提示词推出清单顺序
 *
 * 抛错（而不是返回一份残缺的顺序）是刻意的：闸门要变红，理由要指名道姓。
 */
function orderOf(prompt: string, label: string): OnboardingStepKey[] {
  const steps = numberedSteps(prompt, label)
  assertNumbering(steps, label)
  const hits = (ONBOARDING_STEP_ORDER).map((key) => {
    const anchor = STEP_ANCHOR[key]
    const matched = steps
      .map((step, position) => ({ step, position }))
      .filter(({ step }) => step.text.includes(anchor))
    if (matched.length !== 1) {
      throw new Error(
        `${label} 第 ${key} 步的锚点「${anchor}」命中了 ${matched.length} 个编号步骤` +
          (matched.length === 0
            ? '：这一步在提示词里没有位置了'
            : `（第 ${matched.map((m) => m.step.n).join('、')} 步）：同一件事被写了两遍，顺序判不出来`) +
          `。锚点表见 tests/renderer/lib/onboarding-order-matches-prompt.test.ts`
      )
    }
    const { step, position } = matched[0]
    /** 编号相同（两件事写在同一编号里）时，按锚点在步骤正文里的先后 —— 步骤正文自己说了先后 */
    const offset = step.text.indexOf(anchor)
    return { key, n: step.n, position, offset }
  })
  return hits
    .sort((a, b) => a.n - b.n || a.offset - b.offset || a.position - b.position)
    .map((hit) => hit.key)
}

/**
 * 编号必须从 1 开始、连续、不重号，行的先后也要与编号一致
 *
 * 复审 round 3 第 2 节：编号没动、只是把行挪到别处，读提示词的助手看到的仍是
 * 行的先后 —— 「编号没动就是顺序没动」这个说法不成立。重号（两个 `4.`）同理：
 * 助手会照行读，闸门却按编号排，两边说的不是一回事。
 */
function assertNumbering(steps: NumberedStep[], label: string): void {
  steps.forEach((step, index) => {
    expect(step.n, `${label} 的编号必须从 1 开始连续：第 ${index + 1} 行是「${step.n}.」`).toBe(
      index + 1
    )
  })
}

/**
 * 「建项目」这件事在提示词里占了哪几步
 *
 * 复审 round 3 第 2 节给的漏法（P1/P3）：新插一步只写「先 project add 建第一个项目」，
 * 或者在第 3 步末尾补一句「若还没有项目，先 project add」—— 因为清单第 5 步的锚点是
 * 「接手说明」，这两处都命不中锚点，顺序看起来没变，闸门照样绿。
 * 而它们正是主用户否掉的顺序：「注册审批完就直接建第一个项目」。
 *
 * 所以另立一条：凡提到"建项目"这件事的编号步骤，必须排在**档案与约定之后**。
 * 现在两版提示词里只有第 6 步提到它，这条是绿的；P1/P3 会红。
 */
const PROJECT_STEP_PATTERN = /project add|建(第一个|出)?项目|创建第一个项目|逐个建项目/

function assertProjectAfterBasics(steps: NumberedStep[], order: OnboardingStepKey[], label: string): void {
  const stepOf = (key: OnboardingStepKey): number => {
    const anchor = STEP_ANCHOR[key]
    const hit = steps.find((step) => step.text.includes(anchor))
    expect(hit, `${label} 里找不到「${anchor}」`).toBeTruthy()
    return (hit as NumberedStep).n
  }
  const basicsAt = stepOf('basics')
  const protocolAt = stepOf('protocol')
  const projectSteps = steps.filter((step) => PROJECT_STEP_PATTERN.test(step.text))
  expect(projectSteps.length, `${label} 里一条都没提到建项目 —— 这一步是产品流程的一部分`).toBeGreaterThan(0)
  for (const step of projectSteps) {
    expect(
      step.n,
      `${label} 第 ${step.n} 步在讲建项目，却排在档案（第 ${basicsAt} 步）或约定（第 ${protocolAt} 步）之前`
    ).toBeGreaterThan(Math.max(basicsAt, protocolAt))
  }
}

/**
 * 【硬要求】段里也不许出现"建项目"
 *
 * 复审 round 3 的 P4：把「注册审批完先 project add 建第一个项目」写进【硬要求】，
 * 那一段不在编号步骤里，上面所有断言都看不见它，但助手照样会照做。
 */
function hardRulesOf(prompt: string): string {
  const at = prompt.indexOf(STEPS_END)
  return at >= 0 ? prompt.slice(at) : ''
}

/** 只把某几步做完的清单状态 */
function statusWith(doneKeys: OnboardingStepKey[]): OnboardingStatus {
  const done = new Set(doneKeys)
  return {
    hasRegisteredAgent: done.has('agent'),
    hasApprovedAgent: done.has('approved'),
    hasApprovedCredential: done.has('approved'),
    basicsConfirmed: done.has('basics'),
    globalProtocolConfirmed: done.has('protocol'),
    projectHandoffConfirmed: done.has('handoff')
  }
}

/** 两版全流程提示词（用户真拿到的那两份成品） */
const PROMPTS: Array<[string, string]> = [
  ['整理迁入版 buildMigratePrompt', buildMigratePrompt(null)],
  ['从零开始版 buildFreshPrompt', buildFreshPrompt(null)]
]

describe('清单顺序 = 开场提示词顺序（读成品文本）', () => {
  for (const [label, prompt] of PROMPTS) {
    it(`${label}：编号步骤里推出来的顺序就是清单顺序`, () => {
      expect(orderOf(prompt, label)).toEqual(ONBOARDING_STEP_ORDER)
    })

    it(`${label}：nextOnboardingStep 循着同一顺序一步步往前指，最后落到 null`, () => {
      const derived = orderOf(prompt, label)
      /** 从「什么都没做」开始，每做一步问一次「下一步是哪一步」 */
      const progression: Array<OnboardingStepKey | null> = []
      const done: OnboardingStepKey[] = []
      for (let i = 0; i <= derived.length; i += 1) {
        progression.push(nextOnboardingStep(statusWith(done)))
        if (i < derived.length) done.push(derived[i])
      }
      expect(progression).toEqual([...derived, null])
    })
  }

  for (const [label, prompt] of PROMPTS) {
    it(`${label}：讲建项目的那一步在档案与约定之后（不在之前、也不在硬要求里）`, () => {
      const order = orderOf(prompt, label)
      assertProjectAfterBasics(numberedSteps(prompt, label), order, label)
      expect(
        PROJECT_STEP_PATTERN.test(hardRulesOf(prompt)),
        `${label} 的【硬要求】里出现了建项目：那一段不在编号步骤里，助手照样会照做`
      ).toBe(false)
    })
  }

  it('每个锚点在两版提示词里都恰好命中一个编号步骤', () => {
    for (const key of ONBOARDING_STEP_ORDER) {
      for (const [label, prompt] of PROMPTS) {
        const steps = numberedSteps(prompt, label)
        const hits = steps.filter((step) => step.text.includes(STEP_ANCHOR[key]))
        expect(hits.length, `${label} 里「${STEP_ANCHOR[key]}」应当恰好命中一步（${key}）`).toBe(1)
      }
    }
  })
})

/**
 * 闸门本身认不认得出违规 —— 在内存里拿**真实的提示词**做，不另写一句作者设想的反例
 *
 * 真实的一行 = `buildMigratePrompt(null)` 里真有的那一行。挪它、删它、复制它，
 * 都是"改产品流程"这件事的替身；解析结果必须跟着变（或者直接判红）。
 */
describe('闸门认得出「提示词里真的挪了一步」', () => {
  const migrate = buildMigratePrompt(null)

  /** 找出某个编号步骤在原文里的那一行（真实的一行） */
  const lineOf = (n: number): string => {
    const line = migrate.split('\n').find((l) => l.trim().startsWith(`${n}. `))
    expect(line, `提示词里没有第 ${n} 步`).toBeTruthy()
    return line as string
  }

  /**
   * 把步骤段里某一步整行删掉、编号往后收一格 —— 作者真删一步时会做的事
   *
   * 只动「请按以下顺序工作：」到「【硬要求】」之间：接入地址段里也有 `1. 2. 3.`
   * 的编号，整份文本重编号会把它一起改掉（第一次写就是这么错的）。
   */
  const dropStep = (n: number): string => {
    const lines = migrate.split('\n')
    const headerAt = lines.findIndex((line) => line.includes('请按以下顺序工作'))
    const endAt = lines.findIndex((line) => line.startsWith('【硬要求】'))
    expect(headerAt).toBeGreaterThan(-1)
    expect(endAt).toBeGreaterThan(headerAt)
    const section = lines.slice(headerAt + 1, endAt).filter((line) => !line.trim().startsWith(`${n}. `))
    let cursor = 0
    const renumbered = section.map((line) => {
      const matched = line.trim().match(/^(\d+)\.\s+(.*)$/)
      if (!matched) return line
      cursor += 1
      return `${cursor}. ${line.trim().replace(/^\d+\.\s+/, '')}`
    })
    return [...lines.slice(0, headerAt + 1), ...renumbered, ...lines.slice(endAt)].join('\n')
  }

  /**
   * 把真实的那几行按新顺序重排、编号按**物理位置**重新编 —— 一次真的「挪一步」
   *
   * 只交换行、不改编号是**不算**挪的：提示词是有编号的清单，助手照它读，
   * 行的先后和编号对不上时闸门应当直接判红（见下面「编号必须连续」那条与
   * `verify-gates-reverse` 的 P2 用例）。真正的挪步是"内容换了位置、编号跟着重编"，
   * 这正是作者把第 6 步剪到第 4 步前面之后会做的事。
   */
  const renumber = (order: number[]): string => {
    const lines = migrate.split('\n')
    const slotOf = (n: number): number => {
      const at = lines.findIndex((line) => line.trim().startsWith(`${n}. `))
      expect(at, `提示词里没有第 ${n} 步`).toBeGreaterThan(-1)
      return at
    }
    const bodyOf = (n: number): string => lineOf(n).trim().replace(/^\d+\.\s+/, '')
    /** 物理位置从小到大排（编号写在这一格上） */
    const slots = order.map((n) => slotOf(n)).sort((a, b) => a - b)
    /** 正文按 order 给的先后依次填进上面那几格 —— 这才是"内容换了位置" */
    const bodies = order.map((n) => bodyOf(n))
    const firstNumber = Number((lines[slots[0]].trim().match(/^\d+/) ?? ['0'])[0])
    slots.forEach((slot, k) => {
      lines[slot] = `${firstNumber + k}. ${bodies[k]}`
    })
    return lines.join('\n')
  }

  it('把真实的「接手说明」那一步挪到档案之前（编号跟着重编）→ 顺序变了，闸门红', () => {
    const moved = renumber([6, 4, 5])
    expect(orderOf(moved, '项目挪到档案之前的提示词')).toEqual([
      'agent',
      'approved',
      'handoff',
      'basics',
      'protocol'
    ])
  })

  it('把真实的「接手说明」那一步删掉（编号跟着收）→ 锚点命中 0 个编号步骤，闸门红', () => {
    expect(() => orderOf(dropStep(6), '删掉第 6 步的提示词')).toThrow(/命中了 0 个编号步骤/)
  })

  /** 同一件事被写了两遍：把第 5 步的正文又抄进第 6 步（真实文本、编号合法） */
  it('把真实的一步正文抄进另一步 → 锚点命中 2 个编号步骤，闸门红', () => {
    const fifthBody = lineOf(5).trim().replace(/^\d+\.\s+/, '')
    const sixth = lineOf(6)
    const duplicated = migrate.replace(sixth, `${sixth}${fifthBody}`)
    expect(() => orderOf(duplicated, '把第 5 步抄进第 6 步的提示词')).toThrow(/命中了 2 个编号步骤/)
  })

  /** 只交换行、编号不动 —— 助手看到的是行的先后，闸门必须红（复审 round 3 的 P2） */
  it('只把第 6 行挪到第 4 行前面、编号不动 → 编号与行的先后对不上，闸门红', () => {
    const lines = migrate.split('\n')
    const at4 = lines.findIndex((line) => line.trim().startsWith('4. '))
    const at6 = lines.findIndex((line) => line.trim().startsWith('6. '))
    const moved = [...lines.slice(0, at4), lines[at6], ...lines.slice(at4, at6), ...lines.slice(at6 + 1)]
    expect(() => orderOf(moved.join('\n'), '只挪行不动编号的提示词')).toThrow(/编号必须从 1 开始连续/)
  })
})
