// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, waitFor } from '@testing-library/react'
import React from 'react'
import Welcome from '../../../src/renderer/windows/Welcome'
import { useSettingsStore } from '../../../src/renderer/stores/settings.store'

/**
 * 首启窗口复制出去的提示词必须带本机接入地址（1.0.146，评审后修）
 *
 * 这里曾经是一段硬编码字符串：只写"安装目录下的 resources/cli/deskpartner.cjs"，
 * 没有本机绝对路径 —— 而卡 `25caac02` 的教训正是：没接过 DeskPartner 的 agent
 * 拿到这种提示词，第一步就是 `dp: command not found`，然后合理判定"产品不存在"。
 * 快速上手页早已改成 `buildMigratePrompt(useCliAccess())`，首启窗却漏了。
 *
 * 这条用例盯的是**界面真的把地址喂给了模板**（不是模板函数本身对不对）。
 */
const ACCESS = {
  cliPath: 'D:\\Apps\\DeskPartner\\resources\\cli\\deskpartner.cjs',
  cliEnvVar: 'DESKPARTNER_CLI',
  cliEnvAvailable: true,
  mcpCommand: 'D:\\Apps\\DeskPartner\\resources\\cli\\mcp.cmd'
}

const invokeMock = vi.fn()
vi.mock('../../../src/renderer/lib/ipc-client', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  on: () => () => {}
}))

const written: string[] = []
Object.defineProperty(navigator, 'clipboard', {
  configurable: true,
  value: {
    writeText: async (text: string) => {
      written.push(text)
    }
  }
})

beforeEach(() => {
  written.length = 0
  invokeMock.mockReset()
  invokeMock.mockImplementation(async (channel: string) => {
    if (channel === 'cli:connectInfo') return ACCESS
    if (channel === 'cli:agentGuide') return '整本接入说明'
    return null
  })
  useSettingsStore.setState({ settings: { humanName: 'Alex' } as never })
})

describe('首启窗口：开场提示词自带本机地址（25caac02 的残留）', () => {
  it('复制出去的是带绝对路径的模板，不是那句"安装目录下"', async () => {
    const { getByText } = render(<Welcome />)
    // 本机地址是异步取的：等它落地再点，否则复制到的是不含绝对路径的兜底说法
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('cli:connectInfo'))
    await new Promise((r) => setTimeout(r, 30))
    fireEvent.click(getByText('复制开场提示词'))

    await waitFor(() => expect(written).toHaveLength(1))
    const text = written[0]
    expect(text).toContain(JSON.stringify(ACCESS.cliPath))
    expect(text).toContain(JSON.stringify(ACCESS.mcpCommand))
    // 裸的 dp 命令是当年被驳回的直接原因
    expect(text).not.toMatch(/\bdp (skill|agent register)/)
  })

  it('窗口里仍然说清「注册 ≠ 获准写入」', () => {
    const { container } = render(<Welcome />)
    expect(container.textContent ?? '').toContain('注册并不等于获准写入')
  })
})
