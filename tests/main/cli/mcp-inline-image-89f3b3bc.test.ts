import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

const { createMcpServer } = await import('../../../src/cli/mcp-server')
const { mcpToolName } = await import('../../../src/cli/mcp-tools-from-schema')

/**
 * MCP 把图片附件变成 `image` 内容块 —— 卡 `89f3b3bc`，1.0.146
 *
 * 这条盯的是**通道差异**：同一个 `todo attachment` 回执，CLI 直连给的是 JSON
 * （里面有本机路径），而 MCP 侧必须把文件读成 base64 塞进 `image` 块 ——
 * 只有那种块会进模型视觉。放一段 base64 文本过去，模型只能念、看不见像素，
 * 主用户挂的 bug 截图仍然白挂。
 *
 * 用内存传输 + 假 invoke：验的是「回执 → 内容块」这一跳，不启动真进程。
 */
const SCHEMA = [
  {
    name: 'todo attachment',
    desc: '读一份附件的内容',
    risk: 'read',
    readOnly: true,
    positional: { name: 'id', required: true },
    args: [{ flag: '--seq', type: 'string', required: true }]
  }
]

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

async function connect(reply: Record<string, unknown>) {
  const server = await createMcpServer('0', async (argv) => {
    if (argv[0] === 'schema') return { ok: true, data: { commands: SCHEMA } }
    return { ok: true, data: reply }
  })
  const [clientT, serverT] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'probe', version: '0' }, { capabilities: {} })
  await Promise.all([server.connect(serverT), client.connect(clientT)])
  return client
}

describe('MCP 读图片附件（卡 89f3b3bc）', () => {
  it('图片回执：第一块是 image（base64 能还原成原文件），第二块是文字回执', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-mcp-image-'))
    const file = path.join(dir, '截图.png')
    fs.writeFileSync(file, PNG)

    const client = await connect({
      todoId: 'abc',
      seq: 1,
      name: '截图.png',
      kind: 'image',
      mime: 'image/png',
      bytes: PNG.length,
      absPath: file,
      view: 'image',
      message: '这是图片'
    })
    const res = (await client.callTool({
      name: mcpToolName('todo attachment'),
      arguments: { id: 'abc', seq: '1' }
    })) as unknown as { content: Array<Record<string, unknown>> }

    expect(res.content).toHaveLength(2)
    expect(res.content[0].type).toBe('image')
    expect(res.content[0].mimeType).toBe('image/png')
    // base64 解回来必须与原文件逐字节相同 —— 不是"带了个 data 字段"就算数
    expect(Buffer.from(String(res.content[0].data), 'base64').equals(PNG)).toBe(true)
    expect(res.content[1].type).toBe('text')
    expect(JSON.parse(String(res.content[1].text)).data.view).toBe('image')
    await client.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('文本回执不变：不是图片就还是一条 JSON 文本，不多出内容块', async () => {
    const client = await connect({
      todoId: 'abc',
      seq: 2,
      name: '日志.log',
      kind: 'file',
      mime: 'text/plain',
      bytes: 3,
      absPath: 'D:/不存在的.log',
      view: 'text',
      text: 'abc',
      truncated: false
    })
    const res = (await client.callTool({
      name: mcpToolName('todo attachment'),
      arguments: { id: 'abc', seq: '2' }
    })) as unknown as { content: Array<Record<string, unknown>> }
    expect(res.content).toHaveLength(1)
    expect(res.content[0].type).toBe('text')
    expect(JSON.parse(String(res.content[0].text)).data.text).toBe('abc')
    await client.close()
  })

  it('图片文件读不到时退回文本回执（不抛，也别让整个工具失败）', async () => {
    const client = await connect({
      todoId: 'abc',
      seq: 3,
      kind: 'image',
      mime: 'image/png',
      absPath: path.join(os.tmpdir(), 'dp-mcp-image-从未存在过.png'),
      view: 'image'
    })
    const res = (await client.callTool({
      name: mcpToolName('todo attachment'),
      arguments: { id: 'abc', seq: '3' }
    })) as unknown as { content: Array<Record<string, unknown>> }
    expect(res.content).toHaveLength(1)
    expect(res.content[0].type).toBe('text')
    await client.close()
  })
})
