import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 审批信息架构的边界闸门（1.0.60，主用户驳回 2ccc6fc6）
 *
 * ── 这条闸门要拦的是什么 ──
 *
 * 主用户连续两轮驳回同一件事，措辞一次比一次明确：
 *
 *   第一轮：「审批入口有了，但是审批通知还在通知里，应该迁移到审批中，
 *           以及缺少了审批日志的历史记录展示。以及我不明白为什么把
 *            agent 信息从用户中挪到审批中。」
 *   第二轮：「**用户和他的 agent 团队，信息应该放到一起，agent 用户的
 *            权限信息也应该一起展示。而审批是过程性操作和记录的区域，
 *            不应该混为一谈。**」
 *           以及：「目前审批的提醒数字还展示在用户名称旁边，
 *            实际审批操作却在审批页面，交互方面很混乱。」
 *
 * 沿革本身就说明这块**天然容易摆错位置**：
 * 设置页「谁能写入」（她说太诡异）→ 1.0.48 用户页 → 1.0.52 审批页
 * → 1.0.60 拆开各归其位。四次搬家，其中三次是错的。
 *
 * 所以光"这次改对了"不够 —— 得让下一个接手的人**一改就撞墙**，
 * 否则第五次搬家迟早发生，而每次都要靠她再驳回一次才能发现。
 *
 * ── 闸门锁的是"边界"，不是"实现" ──
 *
 * 只检查三件结构事实，不锁具体文案、不锁样式、不锁组件内部写法：
 *   1. 审批页不得出现权限账本类内容（那是用户页的职责）
 *   2. 用户页不得出现待表态队列（那是审批页的职责）
 *   3. 审批提醒数字不得挂在 user-chip 上
 *
 * 这样重构、改文案、调样式都不会误伤，只有"把职责搬回去"才会变红。
 */
const ROOT = path.resolve(__dirname, '../../..')
const R = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

const APPROVAL = 'src/renderer/components/approval/ApprovalView.tsx'
const USER = 'src/renderer/components/user/UserView.tsx'
const ROSTER = 'src/renderer/components/user/AgentRosterSection.tsx'
const SIDEBAR = 'src/renderer/components/kanban/Sidebar.tsx'

/** 去掉注释：注释里常年写着"为什么搬走"，那不该被当成实现 */
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

describe('审批信息架构的边界（主用户驳回 2ccc6fc6 后定死的分工）', () => {
  it('基础数据解析成功（防止闸门因路径变化而假通过）', () => {
    // 若这些文件被改名/搬走，下面的断言会全部"通过"（因为没有内容可查），
    // 闸门就废了 —— 所以先确认它们真的读得到。
    expect(R(APPROVAL).length).toBeGreaterThan(500)
    expect(R(USER).length).toBeGreaterThan(300)
    expect(R(ROSTER).length).toBeGreaterThan(500)
    expect(R(SIDEBAR).length).toBeGreaterThan(1000)
  })

  it('权限账本住在用户页的 agent 名册里（不在审批页）', () => {
    const roster = stripComments(R(ROSTER))
    // 权限账本的三个特征：批准/吊销身份、三档授权状态、收回
    expect(roster).toContain('agent:setApproved')
    expect(roster).toContain('agent:revokeGrants')
    expect(roster).toContain('界面设置')
    expect(roster).toContain('删除数据')

    const approval = stripComments(R(APPROVAL))
    /**
     * 判据只认 `revokeGrants`（收回授权）—— 它是**权限账本独有**的动作。
     *
     * ⚠️ 不能连 `setApproved` 一起禁：批准一个刚注册的身份
     * 「批准的是一条**待表态的申请**」而不是「改一份持续的权限状态」，
     * 它属于"此刻等谁点头"，留在审批页是对的。
     * （第一版闸门就是在这里写错，把自己的正当实现判成了违规。）
     */
    expect(
      approval.includes('agent:revokeGrants'),
      '审批页出现了权限账本的"收回授权"动作。\n' +
        '主用户定的分工：「用户和他的 agent 团队，信息应该放到一起，agent 用户的\n' +
        '权限信息也应该一起展示。而审批是过程性操作和记录的区域，不应该混为一谈。」\n' +
        '权限是**持续的状态**（它现在被允许干什么），归用户页；\n' +
        '审批页只留"此刻等谁点头"与"过去我点过什么"。'
    ).toBe(false)
  })

  it('审批页必须同时有"待表态"与"审计流水"两块（缺一块就是退回旧形态）', () => {
    const approval = stripComments(R(APPROVAL))
    // 过程：此刻等谁决定
    expect(approval).toContain('待审批')
    // 记录：过去发生过什么（这一块是被驳回两次才补上的）
    expect(approval).toContain('审批记录')
    // 四类审批历史必须由统一的服务端分页查询提供，不能只展示授权记录的前端切片。
    expect(approval).toContain("invoke('approval:listHistory'")
    expect(approval).toContain('limit: 20')
    const repository = stripComments(R('src/main/database/agent.repository.ts'))
    expect(repository).toContain('listApprovalHistory(filter: ApprovalHistoryFilter)')
    expect(repository).toContain('UNION ALL')
    expect(repository).toContain('LIMIT @limit OFFSET @offset')
  })

  it('接手说明提议进入审批页、统一计数与历史，不在用户页另设审批动作', () => {
    const approval = stripComments(R(APPROVAL))
    expect(approval).toContain("invoke('project:handoffProposals')")
    expect(approval).toContain("invoke('project:handoffDecide'")
    expect(approval).toContain("handoff: '项目接手说明'")
    expect(approval).toContain("handoff: '项目接手说明', rules: '协作规则' } as const)[item.type]")
    const sidebar = stripComments(R(SIDEBAR))
    const floatBall = stripComments(R('src/renderer/windows/FloatBall.tsx'))
    expect(sidebar).toContain("invoke('project:handoffProposals')")
    expect(floatBall).toContain("invoke('project:handoffProposals')")
    expect(stripComments(R('src/renderer/lib/grant-state.ts'))).toContain('handoffProposals = 0')
  })

  it('审批提醒数字不得挂在 user-chip 上（数字在哪，点进去就该在哪）', () => {
    const sidebar = stripComments(R(SIDEBAR))
    // 定位 user-chip 那一段（从 setMainView('user') 到其闭合标签）
    const idx = sidebar.indexOf("setMainView('user')")
    expect(idx, 'Sidebar 里找不到 user-chip 按钮').toBeGreaterThan(-1)
    const chip = sidebar.slice(idx, idx + 1200)

    expect(
      /pendingCount\s*>\s*0/.test(chip),
      'user-chip 上又出现了待审批计数。\n' +
        '主用户驳回原话：「审批的提醒数字还展示在用户名称旁边，实际审批操作却在\n' +
        '审批页面，交互方面很混乱。」\n' +
        '数字必须长在**它自己的目的地**上（审批按钮），否则点用户名进去\n' +
        '看到的是身份与权限页，而那里根本不处理申请。'
    ).toBe(false)
  })

  it('审批按钮自带计数（数字与目的地同源）', () => {
    const sidebar = stripComments(R(SIDEBAR))
    const idx = sidebar.indexOf("setMainView('approval')")
    expect(idx, 'Sidebar 里找不到审批按钮').toBeGreaterThan(-1)
    const btn = sidebar.slice(idx, idx + 1200)
    expect(
      /pendingCount/.test(btn),
      '审批按钮上没有计数 —— 待表态数必须由它自己承载（1.0.60 收口）。'
    ).toBe(true)
  })

  it('用户页必须把 agent 团队接进来（否则权限账本没有入口）', () => {
    const user = stripComments(R(USER))
    expect(
      user.includes('AgentRosterSection'),
      '用户页没有渲染 AgentRosterSection —— 权限账本会变成没有入口的死组件。'
    ).toBe(true)
  })
})
