import { describe, it, expect } from 'vitest'
import { buildAgentGuide } from '../../../src/main/cli/agent-guide'

/**
 * 「可直接粘贴」这句话必须是真的（1.0.71，qwen 实测驳回 `4fb94740`）
 *
 * ## 他实测出的两处硬伤
 *
 * ① **那段 JSON 不是合法 JSON** —— Windows 路径 `C:/Apps/...` 直接进 JSON，
 *    `\P` 不是合法转义，`json.loads` 直接报 `Invalid \escape`。
 *    而正文写着「**可直接粘贴**」—— **那句话本身就是假的**。
 * ② **片段里没有 `env` 键** —— 正文让人"把 DESKPARTNER_AGENT 换成你的名字"，
 *    照抄的人得到一个**没有身份**的服务器，每条写操作都撞 `ambiguous_identity`。
 *    而这恰恰是"接入路径最容易死在第一步"的地方。
 *
 * ## 判据
 *
 * **凡是写着"可直接粘贴"的片段，必须在生成时真解析一遍。**
 * 写"可直接粘贴"的那一刻就该验 —— 不是等用户踩了才发现。
 */
describe('MCP 接入片段真的是可粘贴的（4fb94740）', () => {
  const doc = buildAgentGuide('C:/x/deskpartner.cjs', '1.0.71')

  /** 从说明书里取出 ```json 围栏里的那段 */
  const snippet = (): string | null => {
    const m = doc.match(/```json\n([\s\S]*?)\n```/)
    return m ? m[1] : null
  }

  it('说明书的接入片段存在', () => {
    expect(snippet(), '说明书里找不到 JSON 片段').not.toBeNull()
  })

  /**
   * 核心那条：**它必须真的是合法 JSON**。
   * 修法是路径用 `JSON.stringify` 生成（它自己会转义反斜杠）。
   */
  it('那段 JSON 能被 json.loads 解析（"可直接粘贴"必须是真的）', () => {
    const raw = snippet()!
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (e) {
      throw new Error(
        `接入片段不是合法 JSON：${(e as Error).message}\n` +
          `而说明书正写着"可直接粘贴"—— **那句话是假的**。\n` +
          `片段：\n${raw}`
      )
    }
    expect(parsed).toBeTruthy()
  })

  it('解析后结构对：mcpServers → deskpartner → command', () => {
    const raw = snippet()!
    const parsed = JSON.parse(raw) as {
      mcpServers: Record<string, { command?: string; env?: Record<string, string> }>
    }
    const entry = parsed.mcpServers?.deskpartner
    expect(entry, '没有 deskpartner 这一项').toBeTruthy()
    expect(typeof entry!.command, '没有 command（那是必填项）').toBe('string')
  })

  it('有 env 键，且带 DESKPARTNER_AGENT 占位（否则照抄的人没有身份）', () => {
    const raw = snippet()!
    const parsed = JSON.parse(raw) as {
      mcpServers: Record<string, { env?: Record<string, string> }>
    }
    const env = parsed.mcpServers.deskpartner.env
    expect(env, '缺 env 键 —— 照抄的人每条写操作都撞 ambiguous_identity').toBeTruthy()
    expect(
      env!.DESKPARTNER_AGENT,
      'env 里没有 DESKPARTNER_AGENT 占位'
    ).toMatch(/^agent:/)
  })

  it('正文提到改 env 里的身份（文案与片段对得上）', () => {
    expect(doc, '正文没让人改 DESKPARTNER_AGENT').toContain('DESKPARTNER_AGENT')
  })
})
