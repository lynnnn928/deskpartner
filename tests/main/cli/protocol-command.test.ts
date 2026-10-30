import { describe, expect, it } from 'vitest'
import { commands, riskOf } from '../../../src/main/cli/commands'
import { mcpToolName, toArgv } from '../../../src/cli/mcp-tools-from-schema'

describe('协作协议 CLI/MCP 出口', () => {
  it('protocol get 是只读命令，项目参数可选且能生成 MCP 工具', () => {
    const command = commands.find((item) => item.name === 'protocol get')
    expect(command).toBeDefined()
    expect(riskOf(command!)).toBe('read')
    expect(command!.args.map((arg) => arg.flag)).toEqual(['--project'])
    expect(mcpToolName('protocol get')).toBe('get_protocol')
    expect(toArgv('get_protocol', { project: 'DeskPartner' })).toEqual(['protocol', 'get', '--project=DeskPartner'])
  })

  it('profile get 是只读命令，项目参数可选且能生成 MCP 工具', () => {
    const command = commands.find((item) => item.name === 'profile get')
    expect(command).toBeDefined()
    expect(riskOf(command!)).toBe('read')
    expect(command!.args.map((arg) => arg.flag)).toEqual(['--project'])
    expect(mcpToolName('profile get')).toBe('get_profile')
    expect(toArgv('get_profile', { project: 'DeskPartner' })).toEqual(['profile', 'get', '--project=DeskPartner'])
  })

  it('profile propose 是写命令，必须明确区块和正文，并能还原 MCP 调用', () => {
    const command = commands.find((item) => item.name === 'profile propose')
    expect(command).toBeDefined()
    expect(riskOf(command!)).toBe('write')
    expect(command!.args.filter((arg) => arg.required).map((arg) => arg.flag)).toEqual(['--block', '--body'])
    expect(mcpToolName('profile propose')).toBe('propose_profile')
    expect(toArgv('propose_profile', { block: 'basics', body: '内容' })).toEqual([
      'profile',
      'propose',
      '--block=basics',
      '--body=内容'
    ])
  })

  it('protocol propose 是写命令，使用与档案提议相同的待审批语义', () => {
    const command = commands.find((item) => item.name === 'protocol propose')
    expect(command).toBeDefined()
    expect(riskOf(command!)).toBe('write')
    expect(command!.args.filter((arg) => arg.required).map((arg) => arg.flag)).toEqual(['--block', '--body'])
    expect(mcpToolName('protocol propose')).toBe('propose_protocol')
    expect(toArgv('propose_protocol', { project: 'DeskPartner', block: 'language', body: '内容' })).toEqual([
      'protocol',
      'propose',
      '--project=DeskPartner',
      '--block=language',
      '--body=内容'
    ])
  })

  it('两类提议都有只读结果查询出口，默认查待审批并可查历史', () => {
    for (const [commandName, toolName] of [
      ['profile proposals', 'list_profile_proposals'],
      ['protocol proposals', 'list_protocol_proposals'],
      ['project handoff-proposals', 'list_handoff_proposals']
    ] as const) {
      const command = commands.find((item) => item.name === commandName)
      expect(command, commandName).toBeDefined()
      expect(riskOf(command!), commandName).toBe('read')
      expect(command!.args.map((arg) => arg.flag), commandName).toEqual(['--all'])
      expect(mcpToolName(commandName), commandName).toBe(toolName)
      expect(toArgv(toolName, { all: true }), commandName).toEqual([...commandName.split(' '), '--all'])
    }
  })

  it('handoff-propose 是待审批写命令，handoff-proposals 是只读查询，并可生成 MCP 工具', () => {
    const propose = commands.find((item) => item.name === 'project handoff-propose')
    const proposals = commands.find((item) => item.name === 'project handoff-proposals')
    expect(propose).toBeDefined()
    expect(riskOf(propose!)).toBe('write')
    expect(propose!.args.map((arg) => arg.flag)).toEqual(['--body', '--body-file', '--withdraw'])
    expect(proposals).toBeDefined()
    expect(riskOf(proposals!)).toBe('read')
    expect(mcpToolName('project handoff-propose')).toBe('propose_handoff')
    expect(mcpToolName('project handoff-proposals')).toBe('list_handoff_proposals')
    expect(toArgv('propose_handoff', { id: 'p1', body: '正文' })).toEqual([
      'project', 'handoff-propose', 'p1', '--body=正文'
    ])
    expect(toArgv('list_handoff_proposals', { all: true })).toEqual([
      'project', 'handoff-proposals', '--all'
    ])
  })

  it('handoff-update 仍是写命令，但说明限定主用户直接保存', () => {
    const command = commands.find((item) => item.name === 'project handoff-update')
    expect(command).toBeDefined()
    expect(riskOf(command!)).toBe('write')
    expect(command!.args.map((arg) => arg.flag)).toEqual(['--body', '--body-file', '--expected-revision'])
    expect(command!.desc).toContain('主用户')
    expect(command!.desc).toContain('Agent 应使用 project handoff-propose')
    expect(mcpToolName('project handoff-update')).toBe('update_handoff')
    expect(toArgv('update_handoff', { id: 'p1', body: '正文', expected_revision: 2 })).toEqual([
      'project',
      'handoff-update',
      'p1',
      '--body=正文',
      '--expected-revision=2'
    ])
  })

  it('MCP 接入说明使用实际工具名并把接手说明提议引向审批页', async () => {
    const { MCP_INSTRUCTIONS } = await import('../../../src/cli/mcp-server')
    expect(MCP_INSTRUCTIONS).toContain('list_projects')
    expect(MCP_INSTRUCTIONS).not.toContain('project_list')
    expect(MCP_INSTRUCTIONS).toContain('propose_handoff')
    expect(MCP_INSTRUCTIONS).toContain('list_handoff_proposals')
    expect(MCP_INSTRUCTIONS).toContain('update_handoff 仅供主用户直接保存')
  }, 20_000)
})
