// @vitest-environment happy-dom
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, waitFor } from '@testing-library/react'

/**
 * 「快速上手 → 复制开场提示词」必须把本机地址一起带出去（1.0.132，卡 `25caac02`）
 *
 * 纯函数那条用例只证明模板会拼地址；这一条证明**界面真的把地址喂给了模板**。
 * 两者缺一：模板对但界面传 null，用户复制到的仍是那句 `dp skill`，
 * 而它正是主用户实测里让对方 agent 判定"产品不存在"的那句。
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

import { QuickStartView } from '../../../src/renderer/components/onboarding/QuickStartView'

describe('快速上手：开场提示词自带本机接入地址', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    invokeMock.mockImplementation((channel: string) => {
      if (channel === 'cli:connectInfo') return Promise.resolve(ACCESS)
      if (channel === 'agent:list') return Promise.resolve([])
      if (channel === 'project:list') return Promise.resolve([])
      return Promise.resolve(null)
    })
  })

  it('预览原文里出现 MCP 片段与命令行绝对路径', async () => {
    const { container } = render(<QuickStartView />)

    const previewButton = Array.from(container.querySelectorAll('button')).find((b) =>
      (b.textContent ?? '').includes('预览原文')
    )
    expect(previewButton).toBeTruthy()
    fireEvent.click(previewButton!)

    await waitFor(() => {
      const text = container.textContent ?? ''
      expect(text).toContain(JSON.stringify(ACCESS.mcpCommand))
      expect(text).toContain(JSON.stringify(ACCESS.cliPath))
    })
    // 裸的 dp 命令是这次被驳回的直接原因，界面上不该再有
    expect(container.textContent ?? '').not.toMatch(/\bdp (skill|agent register)/)
  })
})
