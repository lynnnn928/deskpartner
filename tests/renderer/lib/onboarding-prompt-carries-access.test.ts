import { describe, expect, it } from 'vitest'
import {
  buildAccessBlock,
  buildFreshPrompt,
  buildMigratePrompt,
  buildProjectPrompt,
  type CliAccess
} from '../../../src/renderer/lib/onboarding-prompts'

/**
 * 开场提示词必须自带接入地址（1.0.132，卡 `25caac02`，主用户实测驳回）
 *
 * ── 要拦的是什么 ──
 *
 * 1.0.131 的提示词第一句是「读取接入说明（CLI: dp skill）」。
 * 主用户把它发给一个从没接过 DeskPartner 的本地 agent，对方的回答是
 * 「`dp` 不存在、也没有 deskpartner 的 MCP，这套接入在当前环境里并不存在」，
 * 然后按「只使用真实存在的命令」停手 —— 一步没走，还差点让她去查
 * 「来源不明的钩子注入」。
 *
 * 它没判错：**这个产品从 1.0.55 起就不写用户 PATH**（`2cc71a13` 改做 MCP Server），
 * `dp` 在别人机器上本来就不存在。错的是提示词 —— 它假设入口已经配好。
 *
 * ── 判据 ──
 *
 * 1. 三套提示词都带【本机接入地址】：MCP 片段（真实路径、JSON 可解析）+ 命令行绝对路径；
 * 2. 地址取不到（null）时退成通用说法，**绝不编绝对路径**；
 * 3. 两条都不通时要说「把片段交给主用户配」，而不是让 agent 下「产品不存在」的结论；
 * 4. 不许再出现裸的 `dp <命令>` —— 它就是这次失败的直接原因。
 *
 * ── 反向验证 ──
 *
 * 把 buildAccessBlock 的返回改成空串，前两条与「地址缺失」的用例必须变红。
 */

const ACCESS: CliAccess = {
  cliPath: 'D:\\Apps\\DeskPartner\\resources\\cli\\deskpartner.cjs',
  cliEnvVar: 'DESKPARTNER_CLI',
  cliEnvAvailable: true,
  mcpCommand: 'D:\\Apps\\DeskPartner\\resources\\cli\\mcp.cmd'
}

const ALL_PROMPTS = [buildMigratePrompt, buildFreshPrompt, buildProjectPrompt]

describe('开场提示词自带接入地址', () => {
  it('带 MCP 片段与命令行绝对路径，且 MCP 片段是可解析的 JSON', () => {
    for (const build of ALL_PROMPTS) {
      const prompt = build(ACCESS)
      expect(prompt).toContain(JSON.stringify(ACCESS.mcpCommand))
      expect(prompt).toContain(JSON.stringify(ACCESS.cliPath))

      // 片段单独占一行，整行拿去解析 —— 用正则抠 `}}}` 会切在半截上
      const jsonLine = prompt.split('\n').find((line) => line.includes('"mcpServers"'))
      expect(jsonLine, '提示词里找不到 MCP 配置片段').toBeTruthy()
      const parsed = JSON.parse(jsonLine!.trim()) as { mcpServers: Record<string, { command: string; env: Record<string, string> }> }
      // 反斜杠必须被转义成合法 JSON —— 1.0.65 在 MCP 片段上踩过同一个坑（4fb94740）
      expect(parsed.mcpServers.deskpartner.command).toBe(ACCESS.mcpCommand)
      expect(parsed.mcpServers.deskpartner.env.DESKPARTNER_AGENT).toBe('agent:<你的名字>')
    }
  })

  it('环境变量可用时才教变量写法，不可用时只给绝对路径', () => {
    const withEnv = buildMigratePrompt({ ...ACCESS, cliEnvAvailable: true })
    const withoutEnv = buildMigratePrompt({ ...ACCESS, cliEnvAvailable: false })
    expect(withEnv).toContain('"$DESKPARTNER_CLI"')
    expect(withoutEnv).not.toContain('$DESKPARTNER_CLI')
    expect(withoutEnv).toContain(JSON.stringify(ACCESS.cliPath))
  })

  it('地址取不到时退成通用说法，不编绝对路径，也不用假入口', () => {
    for (const build of ALL_PROMPTS) {
      const prompt = build(null)
      expect(prompt).toContain('resources/cli/mcp.cmd')
      expect(prompt).toContain('resources/cli/deskpartner.cjs')
      // 任何盘符路径都不该出现 —— 编一条错的比不给更糟：对方会照着跑然后报"找不到文件"
      expect(prompt).not.toMatch(/[A-Za-z]:[\\/]/)
      expect(prompt).toContain('DeskPartner 不存在')
    }
  })

  it('两条路都不通时给的是"交给主用户配置"，不是"判定产品不存在"', () => {
    const block = buildAccessBlock(ACCESS)
    expect(block).toContain('交给主用户')
    expect(block).toContain('不要据此判定 DeskPartner 不存在')
    expect(block).toContain('不要自行安装或编造命令')
  })

  it('不再出现裸的 dp 命令（这次失败的直接原因）', () => {
    for (const build of ALL_PROMPTS) {
      for (const prompt of [build(ACCESS), build(null)]) {
        expect(prompt).not.toMatch(/\bdp (skill|agent|profile|protocol|project|todo|doctor|schema)/)
      }
    }
  })
})
