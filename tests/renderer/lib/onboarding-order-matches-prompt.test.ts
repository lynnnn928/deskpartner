import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ONBOARDING_STEP_ORDER, type OnboardingStepKey } from '../../../src/renderer/lib/onboarding'

/**
 * 清单顺序 = 开场提示词顺序（2026-11-14 主用户拍板）
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
 * 两处各写一份顺序，迟早一处改了另一处还在念旧步骤 —— 这个闸门就是钉这一点。
 *
 * ── 判据 ──
 *
 * 1. 提示词里 `profile propose` → `protocol propose` → `project add` 的出现顺序，
 *    必须与清单第三步到第五步一致（`ONBOARDING_STEP_ORDER` 里对应那三步）；
 * 2. 每一个提示词内部，凡出现两个以上这些命令，顺序也得一致 ——
 *    否则整份文件的首次出现顺序还可能靠另几段碰巧对上。
 *
 * 注释不算：说明里提到命令名不该把闸门惹红（`verify-gates-reverse` 的 NOISE 用例）。
 *
 * ── 反向验证 ──
 *
 * `scripts/verify-gates-reverse.cjs` 里注入了「先 project add 建项目」这一句
 * （正是主用户否掉的那个顺序），闸门必须变红；在注释里写反序命令，闸门必须仍绿。
 */
const HERE = dirname(fileURLToPath(import.meta.url))
const PROMPT_FILE = resolve(HERE, '../../../src/renderer/lib/onboarding-prompts.ts')
const GATE_MESSAGE = '清单顺序必须与开场提示词一致（产品设计顺序的唯一出处）'

/** 第三步到第五步各自的命令：档案、约定由助手提议，项目由助手建 */
const STEP_COMMAND: Partial<Record<OnboardingStepKey, string>> = {
  basics: 'profile propose',
  protocol: 'protocol propose',
  handoff: 'project add'
}

/** 只看提示词正文：注释（行注释 + 块注释）全摘掉 */
function promptSource(): string {
  const raw = readFileSync(PROMPT_FILE, 'utf8')
  return raw
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
}

/** 清单里这几步的顺序（其余两步没有对应命令） */
const CHECKLIST_ORDER: OnboardingStepKey[] = ONBOARDING_STEP_ORDER.filter((key) => STEP_COMMAND[key])

/** 把一段文本里这几条命令按出现位置排成步骤序列；缺一条就是解析失败 */
function orderIn(text: string, keys: OnboardingStepKey[], label: string): OnboardingStepKey[] {
  const found = keys.map((key) => {
    const index = text.indexOf(STEP_COMMAND[key] as string)
    expect(index, `${label}里找不到 ${STEP_COMMAND[key]}`).toBeGreaterThan(-1)
    return { key, index }
  })
  return found.sort((a, b) => a.index - b.index).map((item) => item.key)
}

describe('上手清单顺序与开场提示词一致', () => {
  it('整份提示词里 profile propose → protocol propose → project add 的顺序与清单一致', () => {
    expect(orderIn(promptSource(), CHECKLIST_ORDER, '开场提示词'), GATE_MESSAGE).toEqual(CHECKLIST_ORDER)
  })

  it('每个提示词内部，凡同时出现这些命令，顺序也得与清单一致', () => {
    const blocks = promptSource().split(/(?=export function build)/)
    for (const block of blocks) {
      const present = CHECKLIST_ORDER.filter((key) => block.includes(STEP_COMMAND[key] as string))
      if (present.length < 2) continue
      const label = block.match(/export function (build\w+)/)?.[1] ?? '某段提示词'
      expect(orderIn(block, present, label), `${label}：${GATE_MESSAGE}`).toEqual(present)
    }
  })
})
