import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { buildExecReceipt } from '../../../src/main/lib/exec-receipt'

/**
 * 批准回执要说人话（1.0.117，卡 `0dfff6df`）
 *
 * ── 缺陷 ──
 *
 * 人点了「允许」，回执是命令原文：「已执行：todo rm 3f2a… --yes --force」。
 * 那句话回答的是"批准了哪条命令"，而人要的是"删掉了什么、孩子怎么办"。
 * 失败侧同样：把守卫原文整段端上来，而它写的是给 agent 看的"请加 --force"。
 *
 * ── 判据 ──
 *
 * 三个出口（落库的 exec_summary / 通知 / 界面回执）取**同一个** message，
 * 所以判据只能落在这一个纯函数上：
 *  1. 命令自己给了结论 → 用它（最具体的真相，别拼话稀释）；
 *  2. 删除类没给结论 → 说清删的是哪一条、子任务怎么了（人能对上号）；
 *  3. 失败且补 `--force` 能继续 → 直接给"再点一次"的下一步，而不是教人敲命令；
 *  4. `details` 永远是命令行原文（审计要原文，但不该占回执主位）。
 *
 * ⚠️ 反向验证：把 `isRm` 那段删掉、让成功侧退回 `argv.join(' ')`，
 * 本文件前四条必红。
 */
describe('buildExecReceipt：批准之后那句话', () => {
  it('命令自己给了结论就用它（不额外拼话）', () => {
    const r = buildExecReceipt({
      ok: true,
      summary: '评论已删除，连带清掉 2 条回复',
      argv: ['todo', 'comment-rm', 'abc', '--yes'],
      target: null,
      canForce: false
    })
    expect(r.message).toBe('评论已删除，连带清掉 2 条回复')
    expect(r.details).toBe('todo comment-rm abc --yes')
  })

  it('删除父任务：说清删了哪条 + 子任务保留（不出现 uuid）', () => {
    const r = buildExecReceipt({
      ok: true,
      summary: null,
      argv: ['todo', 'rm', '3f2a9c11-aaaa-bbbb-cccc-0000', '--yes', '--force'],
      target: { title: '重构发版脚本', childCount: 3 },
      canForce: false
    })
    expect(r.message).toBe('已删除「重构发版脚本」（3 个子任务已保留）')
    expect(r.message).not.toContain('3f2a9c11')
    expect(r.details).toContain('todo rm')
  })

  it('删除一条没有子任务的事项：只说删了什么', () => {
    const r = buildExecReceipt({
      ok: true,
      summary: null,
      argv: ['todo', 'rm', 'x', '--yes'],
      target: { title: '测试残留', childCount: 0 },
      canForce: false
    })
    expect(r.message).toBe('已删除「测试残留」')
  })

  it('其它成功动作：只说已执行，不编细节', () => {
    const r = buildExecReceipt({
      ok: true,
      summary: null,
      argv: ['memo', 'add', '--title', 'x'],
      target: null,
      canForce: false
    })
    expect(r.message).toBe('已执行')
  })

  /**
   * 定稿是方案 A（主用户 2026-10-27 拍板）：
   * 只说删哪条 + 子任务将保留为独立事项，不提守卫、不提 flag、不劝也不拦。
   */
  it('补 --force 的那一屏读起来是一次确认，不是一段机制说明', () => {
    const r = buildExecReceipt({
      ok: false,
      summary: null,
      argv: ['todo', 'rm', 'x', '--yes'],
      target: { title: '重构发版脚本', childCount: 2 },
      guardMessage: '这条还有 2 个子任务，删除会让它们解绑。确认要删请加 --force',
      canForce: true
    })
    expect(r.message).toBe('删除「重构发版脚本」？其下 2 个子任务将保留为独立事项。')
    /**
     * 反面清单（两轮反馈都在这）：
     *  - "没有执行：…" 那版是在解释状态机（1.0.119 被否）；
     *  - "再点一次""执行完毕""允许并强制"是在推人（1.0.118 被否）；
     *  - "--force""守卫""解绑"是内部机制，用户不需要知道。
     */
    expect(r.message).not.toContain('没有执行')
    expect(r.message).not.toContain('再点一次')
    expect(r.message).not.toContain('执行完毕')
    expect(r.message).not.toContain('允许并强制')
    expect(r.message).not.toContain('仍然执行')
    expect(r.message).not.toContain('--force')
    expect(r.message).not.toContain('守卫')
    expect(r.message).not.toContain('解绑')
    /** 子任务是不是真留着，是她点头的唯一依据 —— 这句不能丢 */
    expect(r.message).toContain('子任务将保留为独立事项')
  })

  it('拿不出目标名字时，退回一句同样没有机制词的确认', () => {
    const r = buildExecReceipt({
      ok: false,
      summary: null,
      argv: ['todo', 'rm', 'x', '--yes'],
      target: null,
      guardMessage: '这条还有 2 个子任务，删除会让它们解绑。确认要删请加 --force',
      canForce: true
    })
    expect(r.message).toBe('这条事项还需要你确认一次。')
    expect(r.message).not.toContain('--force')
  })

  it('失败但不能补 flag：只说第一句原因，不带开发者标签', () => {
    const r = buildExecReceipt({
      ok: false,
      summary: null,
      argv: ['todo', 'rm', 'x', '--yes'],
      target: null,
      guardMessage: '[TodoRepository] 这条事项不存在，可能已被删除。别的细节',
      canForce: false
    })
    expect(r.message).toBe('执行失败：这条事项不存在，可能已被删除')
    expect(r.message).not.toContain('[TodoRepository]')
  })

  it('失败且守卫没给话：也要有一句能读的回执', () => {
    const r = buildExecReceipt({
      ok: false,
      summary: null,
      argv: ['todo', 'rm', 'x', '--yes'],
      target: null,
      guardMessage: null,
      canForce: false
    })
    expect(r.message).toBe('执行失败')
  })

  it('details 恒为回放用的命令行（含补过的 --force）', () => {
    const r = buildExecReceipt({
      ok: true,
      summary: null,
      argv: ['todo', 'rm', 'x', '--yes', '--force'],
      target: { title: 't', childCount: 1 },
      canForce: false
    })
    expect(r.details).toBe('todo rm x --yes --force')
  })
})

/**
 * 三处出口必须取**同一句**（落库 / 通知中心 / 回给界面）
 *
 * 这条是源码闸门而不是行为用例：三处各写一遍就会出现"通知里是人话、
 * 流水里是命令原文"，而错位的那一侧恰好是唯一被留下来的那一侧。
 * 判据：ipc.ts 里这三处都引用 `receipt.message`，且不再有拼命令原文的兜底。
 *
 * ⚠️ 反向验证：把通知那条改回 `outcome.message`，本用例必红。
 */
describe('exec-receipt 的接线（0dfff6df）', () => {
  const IPC_SRC = fs.readFileSync(
    path.resolve(__dirname, '../../../src/main/ipc.ts'),
    'utf8'
  )

  it('落库 / 通知 / 界面三处都取 receipt.message', () => {
    const record = IPC_SRC.slice(IPC_SRC.indexOf('agentRepo.recordGrantExecution('))
    expect(record.slice(0, 200), '落库侧没用人话').toContain('receipt.message')
    expect(IPC_SRC, '通知侧没用人话').toContain('summary: receipt.message')
    expect(IPC_SRC, '回给界面的回执没用人话').toContain('message: receipt.message')
    expect(IPC_SRC, '命令行原文没带给界面的"详情"位').toContain('details: receipt.details')
  })

  it('不再有"已执行：<命令行>"这种兜底回执', () => {
    expect(IPC_SRC).not.toContain('已执行：${replayArgv.join')
    /**
     * 审批页那一侧也要看：它曾把回执再包一层「已执行：」，
     * 而 message 现在本来就不带前缀 —— 留着就会变成「已执行：已删除《…》」。
     * （这条一度写成了只查 ipc.ts，恒真，反向验证时逮到。）
     */
    const approval = fs.readFileSync(
      path.resolve(__dirname, '../../../src/renderer/components/approval/ApprovalView.tsx'),
      'utf8'
    )
    expect(approval, '审批页又把 message 包一层"已执行"').not.toContain('已执行：${')
  })

  /**
   * 目标事项必须按**命令自己的解析法**找（1.0.119）。
   *
   * 实测（主用户 2026-10-27 点的那次）：申请里记的 argv 是 `todo rm c02a327c --yes`
   * ——8 位前缀。直接用 `getById` 只认完整 uuid，于是查不到目标，
   * 回执里既没有"删的是哪条"、也没有"还有几条子任务"，
   * 只剩一句"再点一次就完成了"，读起来就是在催人删。
   *
   * ⚠️ 反向验证：把 `todoRepo.resolveId(arg)` 改回 `getById(arg)`，本用例必红。
   */
  it('目标事项按 resolveId 找（短 id 也要认，否则回执什么都没有）', () => {
    const at = IPC_SRC.indexOf('const executionTodo')
    expect(at, 'executionTodo 不见了').toBeGreaterThan(-1)
    const block = IPC_SRC.slice(at, at + 600)
    expect(block, '短 id 又解析不出来了').toContain('todoRepo.resolveId(arg)')
  })

  it('子任务数在执行前取（删完就查不到了）', () => {
    const at = IPC_SRC.indexOf('const executionChildCount')
    expect(at, '没看到执行前的子任务数快照').toBeGreaterThan(-1)
    const exec = IPC_SRC.indexOf('const outcome = await executeApproved(', at)
    expect(exec, '快照不在执行之前 —— 那数字永远是 0').toBeGreaterThan(at)
  })

  /**
   * 主进程那条 2.6 秒收横幅的定时器也要看（1.0.118，卡 `0dfff6df` 的续）。
   *
   * 渲染侧做到"需要补一次点头就自己不收"是不够的：`agent:resolveGrant` 原先
   * **无条件**排 `setTimeout(hideReminderBanners, 2600)`，横幅照样在 2.6 秒后消失，
   * 「允许并强制」按钮刚出现就没了 —— 而渲染测试只看得到自己没排定时器。
   *
   * ⚠️ 反向验证：把 `if (!canForce) scheduleBannerHide()` 改回无条件调用，本用例必红。
   */
  it('需要补 --force 时主进程也不收横幅', () => {
    const raw = IPC_SRC.split('setTimeout(hideReminderBanners, 2600)').length - 1
    expect(raw, '又出现了一处无条件的收横幅定时器').toBe(1)
    expect(IPC_SRC, '收横幅没有按结论分支').toContain('if (!canForce) scheduleBannerHide()')
    // 拒绝 / 无 argv / 正常执行完 —— 三条出口都要收（加上 helper 内部的定时器共三处调用）
    const calls = IPC_SRC.split('scheduleBannerHide()').length - 1
    expect(calls, '收横幅的出口少了（拒绝 / 历史申请 / 正常执行完）').toBeGreaterThanOrEqual(3)
  })
})
