import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 校验中英文 README 的传播定位、排除式边界声明、标准 MCP 标识、AI 助手接入指引与开源信任链接
 * （对应卡片 #0f447950、#eacd0158、#c247dbac）。
 */
export function verifyReadmePositioning(readmeZh: string, readmeEn: string): string[] {
  const issues: string[] = []

  // 1. 首屏定位与排除式声明（不是什么 + 是什么）
  if (!readmeZh.includes('不是 AI 调度平台') || !readmeZh.includes('不内置大模型') || !readmeZh.includes('不持有 API 密钥')) {
    issues.push('README.md 缺少首屏排除式定位（「不是 AI 调度平台 / 不内置大模型 / 不持有 API 密钥」）')
  }
  if (!readmeZh.includes('标准 MCP 服务器') || !readmeZh.includes('Claude Desktop / Cursor / Codex')) {
    issues.push('README.md 缺少首屏「标准 MCP 服务器」与主流客户端标识')
  }
  if (!readmeEn.includes('Not an AI orchestration platform') || !readmeEn.includes('standard MCP server')) {
    issues.push('README.en.md 缺少首屏排除式定位与 standard MCP server 声明')
  }

  // 2. 面向 AI 读者的接入指引与 llms.txt 入口
  if (!readmeZh.includes('【AI 助手接入指引】') || !readmeZh.includes('get_guide') || !readmeZh.includes('node "$DESKPARTNER_CLI" skill')) {
    issues.push('README.md 缺少【AI 助手接入指引】（get_guide / node "$DESKPARTNER_CLI" skill）')
  }
  if (!readmeZh.includes('https://lynnnn928.github.io/deskpartner/llms.txt')) {
    issues.push('README.md 缺少 llms.txt 机器可读入口链接')
  }
  if (!readmeEn.includes('[For AI Assistants]') || !readmeEn.includes('https://lynnnn928.github.io/deskpartner/llms.txt')) {
    issues.push('README.en.md 缺少 [For AI Assistants] 指引或 llms.txt 链接')
  }

  // 3. 三角色分工、四档权限分级与可一键复制的标准开场 Prompt 代码块
  if (!readmeZh.includes('三角色分工') || !readmeZh.includes('四档权限分级')) {
    issues.push('README.md 缺少「三角色分工」或「四档权限分级」核心差异化章节')
  }
  if (!readmeZh.includes('### 标准 AI 接入开场 Prompt')) {
    issues.push('README.md 缺少独立的「标准 AI 接入开场 Prompt」代码块小节')
  }

  return issues
}

describe('README 传播定位、排除式边界与 AI 接入指引门禁（0f447950 / eacd0158 / c247dbac）', () => {
  const root = process.cwd()
  const readmeZh = fs.readFileSync(path.join(root, 'README.md'), 'utf8')
  const readmeEn = fs.readFileSync(path.join(root, 'README.en.md'), 'utf8')

  it('1. 中英 README 首屏包含排除式边界、标准 MCP 服务器定位、AI 接入指引、llms.txt 入口与四档权限说明', () => {
    expect(verifyReadmePositioning(readmeZh, readmeEn)).toEqual([])
  })

  it('2. 反向验证：摘除排除式定位、AI 接入指引或 llms.txt 链接时，门禁校验必须准确报出缺失项', () => {
    const brokenZh = readmeZh
      .replace('不是 AI 调度平台', '普通任务平台')
      .replace('【AI 助手接入指引】', '普通说明')
      .replaceAll('https://lynnnn928.github.io/deskpartner/llms.txt', '')
    const brokenEn = readmeEn.replace('Not an AI orchestration platform', 'An AI platform')

    const issues = verifyReadmePositioning(brokenZh, brokenEn)
    expect(issues.length).toBeGreaterThanOrEqual(4)
    expect(issues.some((msg) => msg.includes('排除式定位'))).toBe(true)
    expect(issues.some((msg) => msg.includes('【AI 助手接入指引】'))).toBe(true)
    expect(issues.some((msg) => msg.includes('llms.txt'))).toBe(true)
    expect(issues.some((msg) => msg.includes('README.en.md'))).toBe(true)
  })
})
