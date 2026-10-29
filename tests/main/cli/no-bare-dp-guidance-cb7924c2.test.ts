import { describe, it, expect } from 'vitest'
import { buildAgentGuideIndex, buildAgentGuideTopic } from '../../../src/main/cli/agent-guide'
import { DEGRADED_NOTE } from '../../../src/cli/mcp-server'

/**
 * 说明书与 MCP 提示不再教一条不存在的命令（卡 `cb7924c2`，1.0.133）
 *
 * ── 要拦的是什么 ──
 *
 * 1.0.132 修掉了**入口**（开场提示词自带地址），但产品内部仍到处写 `dp xxx` ——
 * 而本机从来没有 `dp` 这条命令（产品从 1.0.55 起不写用户 PATH，`2cc71a13`）。
 * 最刺眼的是 MCP 的降级提示：它让人「用 CLI 的 `dp help` / `dp schema` 核对」，
 * 而 MCP 用户恰恰没有命令行，正路是 `get_guide`。
 *
 * ── 判据 ──
 *
 * 1. 说明书里必须有一句「本机没有 `dp` 这条命令」的简写说明，并给出真实调用方式 —
 *    正文几十处 `dp <命令>` 靠这一句兜住，不再逐条改写（改全了会撑爆 60 KB 出口）；
 * 2. MCP 降级提示指向 `get_guide` / `schema`，不含 `dp help` 这种跑不通的写法。
 *
 * ── 反向验证 ──
 *
 * 把说明书的简写说明删掉、或把 DEGRADED_NOTE 改回 `dp help`，本文件必须变红。
 */
describe('说明书与 MCP 提示不再教不存在的 dp 命令（cb7924c2）', () => {
  it('入口页说明 dp 只是简写（也是 agent 最先读到的那一页）', () => {
    const index = buildAgentGuideIndex(undefined, '1.0.133')
    expect(index).toContain('本页示例一律用 `dp` 代替完整调用')
    expect(index).toContain('`dp` = `node <启动器路径>`')
  })

  it('「怎么调用」那一册补了简写说明：本机没有 dp，执行时换成启动器', () => {
    const access = buildAgentGuideTopic('access', undefined, '1.0.133')
    expect(access).toContain('本机没有 `dp` 这条命令')
    expect(access).toContain('执行时换成上面')
  })

  it('MCP 降级提示指向 get_guide / schema，而不是 dp help', () => {
    expect(DEGRADED_NOTE).toContain('get_guide')
    expect(DEGRADED_NOTE).not.toMatch(/\bdp (help|schema|skill|todo|project)/)
  })
})
