/**
 * 说明书事实性文字与源表逐条对齐（9d0df867）
 *
 * ## 它治的病
 *
 * `dp skill` 说明书里三处事实是手写第二遍的，全部漂了（1.0.73 实测）：
 * - 错误码表只列 `2`/`3`/`4`，而 ERROR_CODES 里退出码 1 与 5 早有定义；
 *   尾部自检行列到 `4` 为止，`conflict`（5）整档缺席；
 * - 标题写「五道关口」，而 GATES 实数 15 条；
 * - 「工具面」枚举 8 个工具，而命令表扣掉 EXCLUDE 后实际暴露 42 个。
 *
 * 修法是把这三处改成由源表渲染（renderErrorCodesTable / renderExitCodesLine /
 * GATES.length / 命令表派生）。本测试盯的是**渲染这个动作**：
 * 任何人把其中一处改回手写、或数字与源表不一致，这里当场变红。
 *
 * ## 判据
 *
 * - **逐条对齐**：ERROR_CODES 每条的行都要在说明书里（不是"大概有这张表"）。
 * - **集合对齐**：表格/尾行出现的退出码集合 = 源表派生的集合（0 + ERROR_CODES）。
 * - **反向验证**：喂旧的手写文本给同一套提取逻辑，必须判出与源表不符 ——
 *   否则闸门可能是提取正则坏了而永远绿（本项目已多次踩"假绿"）。
 */
import { describe, it, expect } from 'vitest'
import { buildAgentGuide } from '../../../src/main/cli/agent-guide'
import { ERROR_CODES } from '../../../src/main/cli/error-codes'
import { GATES } from '../../../src/main/cli/gates'
import { commands, riskOf } from '../../../src/main/cli/commands'
import { shouldExpose, mcpToolName } from '../../../src/cli/mcp-tools-from-schema'

/** 渲染层可能把反引号转义成 \` —— 比对文案前先归一，两套口径都能查 */
const normalize = (s: string): string => s.replace(/\\`/g, '`')

const guide = normalize(buildAgentGuide('C:/x/deskpartner.cjs', '9.9.9'))

/** 源表派生的期望事实（独立于说明书的渲染结果） */
const expectedExitCodes = [...new Set(ERROR_CODES.map((e) => e.exitCode))].sort((a, b) => a - b)
const expectedGateCount = GATES.length
const exposed = commands.filter((c) => shouldExpose(c.name))
const expectedReadTools = exposed.filter((c) => riskOf(c) === 'read').map((c) => mcpToolName(c.name))
const expectedWriteTools = exposed.filter((c) => riskOf(c) !== 'read').map((c) => mcpToolName(c.name))

/** 取「id 前缀与错误码」那一节 */
function errorSection(g: string): string {
  const start = g.indexOf('### id 前缀与错误码')
  const end = g.indexOf('\n### ', start)
  return g.slice(start, end === -1 ? undefined : end)
}

/** 表格行里出现过的退出码（去重升序） */
function tableExitCodes(section: string): number[] {
  return [...new Set([...section.matchAll(/^\| `(\d+)` \| `([a-z_]+)` \|/gm)].map((m) => Number(m[1])))].sort(
    (a, b) => a - b
  )
}

/** 尾部自检行里被反引号包住的退出码（去重升序） */
function lineExitCodes(line: string): number[] {
  return [...new Set([...line.matchAll(/`(\d+)`/g)].map((m) => Number(m[1])))].sort((a, b) => a - b)
}

/** 「N 道关口」里的 N；写死成「五道」这类中文数字时取不到 —— 判据正是如此 */
function gateCountOf(text: string): number | null {
  const m = text.match(/(\d+)\s*道关口/)
  return m ? Number(m[1]) : null
}

/** 提取「工具面」项目符号里（读）/（写）两组的工具名 */
function toolGroups(text: string): { read: string[]; write: string[] } {
  const start = text.indexOf('- **工具面**')
  const rawEnd = text.indexOf('\n- ', start)
  const bullet = text.slice(start, rawEnd === -1 ? undefined : rawEnd)
  const readSeg = bullet.slice(bullet.indexOf('：') + 1, bullet.indexOf('（读）'))
  const writeSeg = bullet.slice(bullet.indexOf('（读）'), bullet.indexOf('（写）'))
  const names = (s: string): string[] => [...s.matchAll(/`([^`]+)`/g)].map((m) => m[1])
  return { read: names(readSeg), write: names(writeSeg) }
}

describe('说明书事实性文字与源表逐条对齐（9d0df867）', () => {
  it('错误码表逐条来自 ERROR_CODES，且退出码集合与源表一致（曾只列 2/3/4，缺 1 与 5）', () => {
    const section = errorSection(guide)
    expect(section, '说明书缺「id 前缀与错误码」一节').not.toBe('')
    for (const e of ERROR_CODES) {
      const row = `| \`${e.exitCode}\` | \`${e.code}\` | ${e.what} | ${e.fix} |`
      expect(section.includes(row), `错误码表缺 ${e.code} 这一行（或文案与 ERROR_CODES 不一致）`).toBe(
        true
      )
    }
    expect(
      tableExitCodes(section),
      `表格退出码集合与 ERROR_CODES 不一致 —— 1 与 5 曾整行缺席`
    ).toEqual(expectedExitCodes)
  })

  it('尾部退出码自检行覆盖 0 与 ERROR_CODES 全部退出码（曾缺 5）', () => {
    const line = guide.split('\n').find((l) => l.startsWith('退出码：'))
    expect(line, '说明书尾部缺「退出码：」自检行').toBeTruthy()
    expect(lineExitCodes(line!), `自检行档位与源表不一致 —— 5 曾缺席`).toEqual([
      0,
      ...expectedExitCodes
    ])
  })

  it('关口数取自 GATES.length（曾写死「五道关口」，实际 15 条）', () => {
    expect(gateCountOf(guide), '取不到「N 道关口」—— 数字被写死成中文数字就取不到').toBe(
      expectedGateCount
    )
  })

  it('工具面枚举逐条来自工具表（曾写死 8 个）', () => {
    const { read, write } = toolGroups(guide)
    expect(read, '（读）组工具名与命令表派生结果不一致').toEqual(expectedReadTools)
    expect(write, '（写）组工具名与命令表派生结果不一致').toEqual(expectedWriteTools)
    expect(read.length + write.length, '工具面枚举总数对不上工具表').toBe(exposed.length)
  })

  /**
   * 反向验证：证明上面几条**认得出违规**，不是提取逻辑坏了永远绿。
   * 手法：把 9d0df867 之前的手写旧文喂给同一套提取函数，
   * 提取出的事实必须与源表派生的期望**不符**（即：主断言遇到它会红）。
   */
  it('反向验证：旧的手写版本会被判为漂移', () => {
    // 旧错误码表（只有 2/3/4）+ 旧尾行（列到 4）+ 旧「五道关口」+ 旧 8 工具枚举
    const oldTable = [
      '| 退出码 | 含义 | 该做什么 |',
      '| --- | --- | --- |',
      '| `2` | 用法错误（参数缺失/取值非法） | 照提示改参数 |',
      '| `3` | 目标不存在（含**身份未注册**、父需求 id 对不上） | 换 id，或先 `agent register` 注册身份 |',
      '| `4` | 守卫拒绝（G1/G2/G4/G6 候选池规则） | 重试无用，等人操作或换合法路径 |'
    ].join('\n')
    expect(tableExitCodes(oldTable)).not.toEqual(expectedExitCodes)

    const oldTail = '退出码：`0` 成功 / `1` 一般错误 / `2` 用法错误 / `3` 目标不存在 / `4` 守卫拒绝。'
    expect(lineExitCodes(oldTail)).not.toEqual([0, ...expectedExitCodes])

    expect(gateCountOf('**五道关口强度不同，别把提醒读成拦截：**')).toBeNull()

    const oldBullet =
      '- **工具面**：`list_todos` / `get_todo` / `list_projects` / `list_agents`（读），\n' +
      '  `add_todo` / `update_todo` / `comment_todo` / `create_project`（写）。'
    const old = toolGroups(oldBullet)
    expect(old.read.length + old.write.length).toBe(8)
    expect([...old.read, ...old.write]).not.toEqual([...expectedReadTools, ...expectedWriteTools])
  })
})
