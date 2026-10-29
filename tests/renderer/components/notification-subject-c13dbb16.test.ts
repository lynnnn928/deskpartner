import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  GUI_READER,
  isKnownTo,
  isUnreadFor,
  readUsers,
  withReader
} from '../../../src/renderer/lib/notification-subject'

/**
 * GUI 的通知未读/已知晓按**主体**算（卡 `c13dbb16`）
 *
 * ## 要拦的是什么
 *
 * 界面（侧栏铃铛角标 / 通知列表）此前一律按全局 `status` 算未读 —— 而那个位**只有一份**：
 * 谁先把它翻过去，别人的未读就一起没了。实测那条链路：agent `memo ack` →
 * `markReadByRef` 写全局位 → 主用户铃铛上那条当场消失。
 *
 * 数据层 1.0.68（schema 28）起就有"谁读过"这个集合（`notifications.read_by`），
 * agent 侧早就在按它算（`notification list --to-me`）；GUI 侧一直没接上 ——
 * 卡上点的就是这三处：`NotificationsView.tsx` 的 `:156`（点开）、`:230`（全部已读）、
 * `:435-448`（行内未读样式）。
 *
 * ## 主体是谁（本卡最要紧的判断）
 *
 * **主用户 `human`**，不是"当前 agent"。出处：
 * - PRD 2.1：主用户「主要通道 = **GUI**」，agent「主要通道 = CLI / MCP」；
 * - 同一份 PRD 的实体表：通知「未读 / 已读（**按主体分别记**）」；
 * - 渲染层**没有**"当前 agent"这个身份（`DESKPARTNER_AGENT` 只走 CLI/MCP，
 *   `settings` 里也没有这一项），`matchesViewScope` 把 `mine` 映射成 `human` 同源。
 *
 * ## 判据（卡上四条验收）
 *
 * ① 同一批通知：人视角与 agent 视角的未读**不同**；
 * ② 各自"已知晓"独立（一个读过的，不该让另一个也变成已读）；
 * ③ 界面读主体字段、写主体字段（三处 `n.status` 判读退场）；
 * ④ 反：把主体接线拿掉、或退回 `n.status`，本文件必须红。
 *
 * ⚠️ 数据侧那半（人/agent 未读各自可清、角标与页头同源、存量回填）在
 * `tests/main/database/notification-subject-c13dbb16.test.ts`。
 * ⚠️ **真机界面没跑**（本批次驱动不了 Electron 真机）：本文件验的是判据与接线，
 * 不是"真窗口里看起来对不对"—— 那部分要主用户手动过一遍。
 */
const ROOT = path.resolve(__dirname, '../../..')
/**
 * 读源码时把行尾统一成 LF：工作树是 CRLF、仓库里是 LF（autocrlf=true），
 * 断言里写的是 `\n` —— 不归一化的话"改对了"会被行尾判成红。
 */
const read = (rel: string): string =>
  fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\r\n').join('\n')

/** 通知里与"谁读过"有关的最小形状（纯判据只吃这一个字段） */
const n = (readBy: string | null) => ({ readBy })

/**
 * 通知列表的接线判据写成**函数**：真源码必须 0 问题，改动过的副本必须被认出来。
 * 只写 `expect(x).toContain(...)` 的闸门没法自证"它认得出违规"。
 */
function viewProblems(view: string): string[] {
  const problems: string[] = []
  // 全局位那份判读必须整条退场：留着它就还是"谁先读都算读过"
  if (view.includes("n.status === 'unread'")) problems.push('仍有按全局 status 判未读的地方')
  if (!view.includes('isUnreadFor(n, GUI_READER)')) problems.push('没有按主体判未读')
  // 四个通道都得带上主体，缺一个就会有一半的读数还走全局口径
  for (const channel of [
    'notification:listWithProject',
    'notification:markRead',
    'notification:markProjectRead',
    'notification:markAllRead'
  ]) {
    const at = view.indexOf(`invoke('${channel}'`)
    if (at < 0) {
      problems.push(`找不到 invoke('${channel}')`)
      continue
    }
    // 调用点后面一段里必须有 reader（listWithProject 中间隔着一段说明注释）
    if (!view.slice(at, at + 600).includes('reader: GUI_READER')) {
      problems.push(`invoke('${channel}') 没带 reader —— 这条读数还是全局口径`)
    }
  }
  return problems
}

function sidebarProblems(sidebar: string): string[] {
  const at = sidebar.indexOf("invoke('notification:unreadCount'")
  if (at < 0) return ['找不到 notification:unreadCount 调用点']
  return sidebar.slice(at, at + 200).includes('reader: GUI_READER')
    ? []
    : ['角标没带 reader —— 别的写方翻了全局位就会把主用户的未读吃掉']
}

describe('GUI 通知未读/已知晓按主体算（卡 c13dbb16）', () => {
  /** 闸门先自证活着：路径写错时它会安静地"全绿"，那是最难查的失效形态 */
  it('闸门自证：读得到那两个源文件（路径变了会假绿）', () => {
    const view = read('src/renderer/components/notification/NotificationsView.tsx')
    const sidebar = read('src/renderer/components/kanban/Sidebar.tsx')
    expect(view.length).toBeGreaterThan(10000)
    expect(sidebar.length).toBeGreaterThan(10000)
    expect(view).toContain('<FilterChip')
    expect(sidebar).toContain('我的工作')
  })

  // ───────── 判据①②：人 vs agent 的未读与"已知晓"各自独立（真跑） ─────────

  it('①同一批通知：人视角与 agent 视角的未读各不相同（agent 读过 ≠ 我读过）', () => {
    const 谁都没读 = n('')
    expect(isUnreadFor(谁都没读, GUI_READER)).toBe(true)
    expect(isUnreadFor(谁都没读, 'agent:bob')).toBe(true)

    const qwen读过 = n('agent:bob')
    expect(isUnreadFor(qwen读过, 'agent:bob'), 'qwen 自己读过了').toBe(false)
    expect(
      isUnreadFor(qwen读过, GUI_READER),
      '⚠️ qwen 读过不该算主用户读过 —— 这一条不过等于没做'
    ).toBe(true)

    const 我读过 = n('human')
    expect(isUnreadFor(我读过, GUI_READER)).toBe(false)
    expect(isUnreadFor(我读过, 'agent:bob'), '我读过也不该让 qwen 的未读少一个').toBe(true)
  })

  it('①存量：`read_by` 为 null（1.0.68 前的历史行）算"没人读过"，不是"人人读过"', () => {
    expect(readUsers(n(null))).toEqual([])
    expect(isUnreadFor(n(null), GUI_READER)).toBe(true)
  })

  it('①集合判据不做子串匹配：agent:me 与 agent:me2 不互相命中（LIKE 那种写法会）', () => {
    expect(isKnownTo(n('agent:me2'), 'agent:me')).toBe(false)
    expect(isKnownTo(n('agent:me,agent:other'), 'agent:me')).toBe(true)
    expect(readUsers(n('agent:a,human'))).toEqual(['agent:a', 'human'])
  })

  /**
   * ②是整张卡的核心：界面上的"我已知晓"在这一侧产生，写到 `read_by` 里去。
   * 反向验证：把 `withReader` 改成覆盖（`return reader`）→ 第一条断言红。
   */
  it('②各自已知晓独立：记我读过是**追加**，幂等，且不覆盖别人', () => {
    expect(withReader('agent:bob', GUI_READER)).toBe('agent:bob,human')
    expect(withReader('agent:bob,human', GUI_READER), '重复读不该把集合越写越长').toBe(
      'agent:bob,human'
    )
    expect(withReader(null, GUI_READER), '历史行（null）与空串都从"就我一个读者"开始').toBe('human')
    expect(withReader('', GUI_READER)).toBe('human')
  })

  // ───────── 判据③④：接线（源码闸门） + 闸门自证认得出违规 ─────────

  it('③通知列表：三处全局判读退场，读一页/点开/全部已读都带上主体', () => {
    const view = read('src/renderer/components/notification/NotificationsView.tsx')
    expect(viewProblems(view)).toEqual([])
    expect(view, '行内未读样式按主体算').toContain('const unreadForMe = isUnreadFor(n, GUI_READER)')
    expect(view, '读一页时把主体给主进程').toContain('reader: GUI_READER')
  })

  it('③侧栏角标带上主体（它与通知页页头同一个口径）', () => {
    const sidebar = read('src/renderer/components/kanban/Sidebar.tsx')
    expect(sidebarProblems(sidebar)).toEqual([])
  })

  /**
   * 主进程那半的轻量接线：`inboxPage` 只把 `unreadFor` 喂给"未读那几个数"。
   * 混进列表那一趟的话，已经读过的行（"我已知晓"）会整批从界面上消失 ——
   * 这条判据的行为证明在 `tests/main/database/notification-subject-c13dbb16.test.ts`。
   */
  it('③主进程：主体只进"未读"那几个数，列表那一趟不收窄', () => {
    const repo = read('src/main/database/notification.repository.ts')
    expect(repo).toContain('const { unreadFor, ...listQuery } = query')
    expect(repo).toContain('this.listWithProjectPage(listQuery)')
    expect(repo, '列表那一趟不许吃主体筛选').not.toContain('this.listWithProjectPage(query)')
    expect(repo, '未读计数吃主体').toContain("...(unreadFor !== undefined ? { unreadFor } : { unreadOnly: true })")
    expect(repo, '范围清理按主体追加 read_by').toContain('APPEND_READER')
  })

  /**
   * 闸门自证（卡上"④反"）：三种"看起来改完了"的写法都必须被认出来。
   * 只验真源码的闸门是恒真的 —— 本项目为此吃过 `verify-gates-reverse` 那次假闸门。
   */
  it('④反：退回全局判读 / 拿掉 reader / 角标不带主体，都会被认出来', () => {
    const view = read('src/renderer/components/notification/NotificationsView.tsx')
    const sidebar = read('src/renderer/components/kanban/Sidebar.tsx')

    // 退回全局 status 判读
    const 退回全局 = view.replace('isUnreadFor(n, GUI_READER)', "n.status === 'unread'")
    expect(退回全局).not.toBe(view)
    expect(viewProblems(退回全局).length).toBeGreaterThan(0)

    // 拿掉主体（通道还在，但读数走全局口径）
    const 丢掉主体 = view.replace(/reader: GUI_READER/g, 'reader: undefined')
    expect(丢掉主体).not.toBe(view)
    expect(viewProblems(丢掉主体).length).toBe(4)

    // 角标退回不带主体
    const 角标退回 = sidebar.replace('{ reader: GUI_READER }', '')
    expect(sidebarProblems(角标退回).length).toBe(1)
    expect(sidebarProblems(sidebar)).toEqual([])
  })
})
