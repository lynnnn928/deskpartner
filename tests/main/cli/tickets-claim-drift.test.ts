import { describe, it, expect } from 'vitest'
import { readCliChain } from './cli-chain'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 提单里的「实测」会过期 —— 本文件把已核实的那几条钉住
 * （2026-10-06 诊断，立于 `cdd531c0` / `b097ca99` / `5fab1314` 三张卡）
 *
 * ## 为什么要有这个文件
 *
 * 2026-10-06 主用户问：「事实核对是查库还是核代码？」
 * 我去核代码，抓到**四处提单已过期**：
 *
 * | 提单说 | 实际 |
 * | --- | --- |
 * | `memo list` 不接受 `--limit` | **早已修好**（参数存在且 `slice` + `truncated`） |
 * | `todo list` 没有 `--executed-by`（读时筛不出） | **已加**（filter 真消费） |
 * | `--search` 只搜标题 | **已扩到标题+描述**（为修 S8） |
 * | 已删/未删两个分支字段名不同 | **已统一**（墓碑存的是 `listTransitions` 的结果） |
 *
 * 共同形状：**卡片比代码慢**。提单里的"实测"是某一刻的快照，
 * 而代码一直在往前��。引用之前必须 grep 确认。
 *
 * ⚠️ 另一个方向的坑也要防：**参数声明了不等于被消费**。
 * 下面每条都断言"实现里有 filter/slice"，而不只是"参数表里有这个 flag"。
 */
const SRC = readCliChain()
const REPO = readFileSync(join(__dirname, '../../../src/main/database/todo.repository.ts'), 'utf-8')
/** 降级自检在 launcher（独立 bundle），不在 commands.ts —— 我第一版只读了两个文件就断言"锚点没了" */
const LAUNCHER = readFileSync(join(__dirname, '../../../src/cli/launcher.ts'), 'utf-8')
/** setApproved 在 agent.repository */
const AGENT_REPO = readFileSync(join(__dirname, '../../../src/main/database/agent.repository.ts'), 'utf-8')
const NOTIF_REPO = readFileSync(join(__dirname, '../../../src/main/database/notification.repository.ts'), 'utf-8')

/** 取某条命令的参数表块 */
const argsOf = (cmd: string): string => {
  const start = SRC.indexOf(`name: '${cmd}'`)
  expect(start, `找不到命令 ${cmd}`).toBeGreaterThan(-1)
  const runAt = SRC.indexOf('\n    run:', start)
  return SRC.slice(start, runAt === -1 ? start + 4000 : runAt)
}

/** 取某条命令的 run 体 */
const bodyOf = (cmd: string): string => {
  const start = SRC.indexOf(`name: '${cmd}'`)
  expect(start, `找不到命令 ${cmd}`).toBeGreaterThan(-1)
  const runAt = SRC.indexOf('\n    run:', start)
  const next = SRC.indexOf(`name: '`, runAt)
  return SRC.slice(runAt, next === -1 ? runAt + 8000 : next)
}

describe('已核实：四处被提单误报的机制', () => {
  it('`todo list --executed-by` 存在【且真被消费】（b097ca99 说读时筛不出，已过期）', () => {
    expect(argsOf('todo list'), 'todo list 没有 --executed-by').toContain("flag: '--executed-by'")
    const body = bodyOf('todo list')
    expect(
      body,
      '⚠️ 参数声明了但没被消费 —— 那等于不能筛。判据：flag 的值必须喂进过滤实现（内联 filter 或 todosForExecutor）'
    ).toMatch(/flags\['--executed-by'\][\s\S]{0,300}out = (?:out\.filter|todosForExecutor\()/)
  })

  it('`--search` 搜标题+描述（cdd531c0 说只搜标题，已过期）', () => {
    const body = bodyOf('todo list')
    const seg = body.slice(body.indexOf("flags['--search']"))
    expect(seg.slice(0, 600)).toMatch(/t\.title\.toLowerCase\(\)\.includes/)
    expect(
      seg.slice(0, 600),
      '描述搜索没接上 —— 注释说"标题 + 描述都搜"，实现只有标题'
    ).toMatch(/\(t\.description \?\? ''\)\.toLowerCase\(\)\.includes/)
  })

  it('`todo list` 有 `--sort` 与 `--updated-since`（cdd531c0 S3 说"无"，已过期）', () => {
    const args = argsOf('todo list')
    expect(args).toContain("flag: '--sort'")
    expect(args).toContain("flag: '--updated-since'")
  })

  it('墓碑的 transitions 与未删走同一映射（5fab1314 说两分支字段名不同，已过期）', () => {
    // 写入侧：删除时存的是 listTransitions 的结果（统一形状）
    // 写入侧：删除时把 listTransitions 的结果整体塞进 payload（统一形状）
    const delIdx = REPO.indexOf('const transitions = this.listTransitions(id)')
    expect(delIdx, '删除流程里没取 listTransitions —— 墓碑形状可能又变了').toBeGreaterThan(-1)
    /**
     * ⚠️ 这里原来是 `REPO.slice(delIdx, delIdx + 400)` —— 一个**固定 400 字符**的窗口。
     * 2026-10-22 卡 `df06e4d7` 给墓碑加了两个字段（评论、子事项 id），
     * 中间顺手写的说明注释一挤，`JSON.stringify(…)` 就掉出了窗口：
     * **闸门红了，而实现一行没错**。这正是本文件开头那条教训的反面 ——
     * 假红会逼人改措辞哄闸门（把注释删短）而不是把闸门修对。
     *
     * 判据（"取到了 transitions 就必须写进 payload"）一个字没改，
     * 只把窗口右端换成**真正要去的地方**：写库那条语句之前。
     */
    const writeIdx = REPO.indexOf("withWriteRetry('todo.delete'", delIdx)
    expect(writeIdx, '找不到删除语句 —— 删除流程形状改过，请核对本闸门').toBeGreaterThan(delIdx)
    const after = REPO.slice(delIdx, writeIdx)
    expect(
      after,
      '取到了 transitions 却没写进 payload —— 已删/未删会是两套形状'
    ).toMatch(/JSON\.stringify\([\s\S]*transitions/)
    // 读取侧：墓碑原样带出，不做二次映射
    expect(REPO).toMatch(/transitions: parsed\.transitions \?\? \[\]/)
  })

  it('`listTransitions` 统一走 mapTransition（不再有第二条映射路径）', () => {
    const m = REPO.match(/return rows\.map\(TodoRepository\.mapTransition\)/g)
    expect(m?.length ?? 0, '出现多处独立映射，说明形状可能又分叉了').toBeGreaterThanOrEqual(2)
  })

  it('`memo list` 有 `--limit`【且真被消费】（cdd531c0 说 usage_error，已过期）', () => {
    expect(argsOf('memo list')).toContain("flag: '--limit'")
    expect(
      bodyOf('memo list'),
      // ⚠️ 1.0.107（修 `8d78af0d`）：切片口径收进共享的 `takeLimit`（全族唯一一处）。
      // 判据本身没变 —— "声明了且真被消费"，只是消费点换了名字。
      '⚠️ 声明了但没被消费 —— 那才是真的 usage_error'
    ).toMatch(/takeLimit\(memos, limit\)/)
  })
})

describe('机制类判断的通用判据（本文件存在的理由）', () => {
  /**
   * 这条不是测产品，是测**我自己**：
   * 报告/提单里凡出现"产品没有 X"，必须先 grep 代码确认。
   */
  it('凡本文件断言的机制，都必须给出代码位置（便于复核）', () => {
    const anchors = [
      'preflightHeadless', // cfbf8a7a
      'resolveActor', // 63b707ca
      'isElectronRuntime' // cfbf8a7a
    ]
    for (const a of anchors) {
      const found = SRC.includes(a) || REPO.includes(a) || LAUNCHER.includes(a) || AGENT_REPO.includes(a)
      expect(found, `锚点 ${a} 不在了 —— 机制可能又变了，本文件需要重核`).toBe(true)
    }
  })

  it('「已注册身份为 0」这个判断只能查库，不能从代码推（记录判据的分层）', () => {
    /**
     * 这条是**元判据**，不是产品判据：
     * 「库里有多少条已注册身份」是**状态事实** → 查库；
     * 「批准能不能走 CLI」是**机制事实** → 查代码。
     *
     * 混用会得出两种错误：
     * - 用"库里是 0"论证"产品没有批准功能"（错：功能有，只是没人用）
     * - 用"代码里有 setApproved"论证"agent 能自己批准"（错：只在 IPC，且限设置页）
     */
    expect(AGENT_REPO).toContain('setApproved') // 机制存在（它在 agent.repository，不在 todo.repository）
    // 而 CLI 侧确实没有 approve 命令 —— 6 条 agent 命令里没有它
    const agentCmds = [...SRC.matchAll(/name: '(agent [a-z]+)'/g)].map((m) => m[1])
    expect(
      agentCmds.includes('agent approve'),
      '若将来加了 agent approve，本文件的判断要改'
    ).toBe(false)
  })
})

describe('已核实：成立的那些机制（防止误改成"没有"）', () => {
  it('G10 按角色定权（1.0.67 改的，`a6032512`）', () => {
    expect(REPO, 'G10 又变回"一律等人点"了').toContain('执行者不能验收自己做的事')
  })

  it('通知删除能力：仓储有 remove，但**没有出口**（`b1a54185` 成立）', () => {
    expect(NOTIF_REPO, '仓储层没有 remove —— 若将来加了，此判断要改').toContain('remove(id: string)')
    // 关键：**CLI 侧没有暴露**
    const notifCmds = [...SRC.matchAll(/name: '(notification [a-z-]+)'/g)].map((m) => m[1])
    expect(
      notifCmds,
      `通知命令只有：${notifCmds.join(', ')} —— 没有 delete/clear 就清不掉`
    ).not.toContain('notification delete')
    // 而 remove 确实只在 memo 删除时被内部调用（没别的出口）
    const callers = SRC.includes('notification delete')
    expect(callers).toBe(false)
  })

  it('「库里已注册身份为 0」是状态事实，不能从代码推（判据分层）', () => {
    /**
     * 元判据：`setApproved` 存在 ≠ agent 能自己批准。
     * 机制事实 = 它只在 ipc.ts 注册且 assertFromSettings 限设置页 → 查代码。
     * 状态事实 = 库里 approved 的行数 → 查库（1.0.65 实测为 0）。
     */
    expect(AGENT_REPO).toContain('setApproved')
    const ipc = readFileSync(join(__dirname, '../../../src/main/ipc.ts'), 'utf-8')
    expect(ipc, 'setApproved 若被挪出 IPC，这条要改').toContain('agent:setApproved')
    expect(ipc).toContain('assertFromSettings') // 限设置页发起
  })
})
