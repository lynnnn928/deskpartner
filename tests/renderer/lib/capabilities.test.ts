import { describe, it, expect } from 'vitest'
import { CAPABILITIES, MCP_EXCLUDED } from '../../../src/renderer/lib/capabilities'
import { mcpToolName, shouldExpose } from '../../../src/cli/mcp-tools-from-schema'

/**
 * 能力对照表契约测试（1.0.100，M4）
 *
 * 判据：CAPABILITIES 是三端对照的唯一登记处。
 * 1. 每条 cmd 在 MCP 工具映射里能查到一致的工具名
 * 2. mcp 为 null 的命令必须在 MCP_EXCLUDED 里，反之亦然
 * 3. shouldExpose() 与 MCP_EXCLUDED 口径一致
 * 4. 不允许重复登记同一命令
 */
describe('能力对照表契约', () => {
  it('每条能力的 MCP 工具名与 mcpToolName() 一致', () => {
    const mismatches: string[] = []
    for (const row of CAPABILITIES) {
      const expected = shouldExpose(row.cmd) ? mcpToolName(row.cmd) : null
      if (row.mcp !== expected) {
        mismatches.push(`${row.cmd}: 对照表=${row.mcp}，mcpToolName()=${expected}`)
      }
    }
    expect(mismatches, `以下能力的 MCP 工具名对不上：\n${mismatches.join('\n')}`).toEqual([])
  })

  it('mcp 为 null 的命令必须在 MCP_EXCLUDED 里，反之必有工具名', () => {
    const errors: string[] = []
    for (const row of CAPABILITIES) {
      const isExcluded = MCP_EXCLUDED.includes(row.cmd)
      if (row.mcp === null && !isExcluded) errors.push(`${row.cmd}：mcp=null 但不在 MCP_EXCLUDED`)
      if (row.mcp !== null && isExcluded) errors.push(`${row.cmd}：有工具名但在 MCP_EXCLUDED 里`)
    }
    expect(errors, errors.join('\n')).toEqual([])
  })

  it('shouldExpose() 与 MCP_EXCLUDED 口径一致', () => {
    for (const cmd of MCP_EXCLUDED) {
      expect(shouldExpose(cmd), `${cmd} 应被 MCP 排除`).toBe(false)
    }
  })

  it('不允许重复登记同一命令', () => {
    const seen = new Set<string>()
    const dupes: string[] = []
    for (const row of CAPABILITIES) {
      if (seen.has(row.cmd)) dupes.push(row.cmd)
      seen.add(row.cmd)
    }
    expect(dupes, `重复登记：${dupes.join(', ')}`).toEqual([])
  })

  it('MCP_EXCLUDED 中的每条都在对照表里登记', () => {
    const cmds = new Set(CAPABILITIES.map((r) => r.cmd))
    const missing = MCP_EXCLUDED.filter((cmd) => !cmds.has(cmd))
    expect(missing, `MCP_EXCLUDED 里有未登记的命令：${missing.join(', ')}`).toEqual([])
  })
})
