import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveMcpPath, resolveLauncherPath } from '../../../src/main/cli/agent-guide'

/**
 * 产品不写入用户的第三方应用配置（1.0.65，主用户 10-05 定）
 *
 * 她的原话：「不要直接 写入别人的配置文件，这种注入是高风险操作，
 * 产品只给指引规范和方法，不直接操作。」
 *
 * ## 为什么要有这道闸门
 *
 * 这条边界**是"要不要做"的问题，不是"做没做对"的问题** ——
 * 而那类问题最容易被"补一个功能"悄悄推翻：
 * 有人会想"用户点一下按钮省事得多"，然后加一个写入函数 + 备份 + 回滚。
 * 评审时每一步都合理，**合起来却越过了那条线**。
 *
 * 判据：**产品可以生成内容让用户自己决定用不用，不能替用户落到别人的盘上。**
 * 与 `2cc71a13`「产品不写用户 PATH」同源 ——
 * 上次是不往用户环境变量里塞东西，这次是不往第三方应用配置里塞东西。
 *
 * 本文件就是让"想做这件事"的人必须先撞到这条。
 */
describe('产品边界：不碰用户的第三方配置（4fb94740）', () => {
  const GUIDE = join(__dirname, '../../../src/main/cli/agent-guide.ts')

  it('❌ 源码里不得出现任何"写配置文件"的实现', () => {
    const src = readFileSync(GUIDE, 'utf-8')
    /**
     * 这些是"把内容落到别人配置文件"的典型动作。
     * 说明书写 JSON 片段用的是纯字符串拼接（`"command": "..."`），
     * 不该出现任何 fs 写入 —— 出现即越界。
     */
    const forbidden = [
      /writeFileSync/,
      /appendFileSync/,
      /copyFileSync/,
      /renameSync/,
      /mkdirSync/,
      /rmSync/,
      /unlinkSync/
    ]
    const hits = forbidden.filter((re) => re.test(src))
    expect(
      hits.map(String),
      'agent-guide 里出现文件系统写入 → 越过了"不碰用户配置"这条线'
    ).toEqual([])
  })

  it('❌ 不得把宿主配置路径当成已知事实写死', () => {
    const src = readFileSync(GUIDE, 'utf-8')
    /**
     * 逐个宿主给路径是**猜**出来的：那是它们各自的约定，会随版本变。
     * 猜错的后果是用户照着去改一个不存在的文件 —— 那比不给路径更糟。
     */
    for (const p of [
      'claude_desktop_config.json',
      '.cursor/mcp.json',
      'globalStorage/mcp.json',
      'mcp_settings.json'
    ]) {
      expect(
        src.includes(p),
        `写死了宿主配置路径「${p}」→ 会过期，且会让用户去改不存在的文件`
      ).toBe(false)
    }
  })

  it('✅ 必须提供可复制的配置片段（"给方法"的那一半）', () => {
    const src = readFileSync(GUIDE, 'utf-8')
    expect(
      src.includes('可直接粘贴的配置片段'),
      '产品只给指引 —— 那"指引"必须真的有可粘贴的内容，否则这条边界等于什么都不给'
    ).toBe(true)
  })

  it('✅ 片段里的 command 必须是主进程推导出来的真实路径', () => {
    const mcp = resolveMcpPath()
    const cli = resolveLauncherPath()
    // 两者同目录，只是文件名不同
    expect(mcp.endsWith('mcp.cmd')).toBe(true)
    expect(mcp.replace(/mcp\.cmd$/, '')).toBe(cli.replace(/deskpartner\.cjs$/, ''))
    // 必须是绝对路径：相对路径在不同 cwd 下会失效
    expect(/^[A-Za-z]:[\\/]/.test(mcp), `路径不是绝对路径：${mcp}`).toBe(true)
  })

  it('✅ 说明书里必须写明"不会替你写这个文件"', () => {
    const src = readFileSync(GUIDE, 'utf-8')
    expect(
      src.includes('不会替你写这个文件') || src.includes('只生成内容，不落盘'),
      '必须明确告诉用户"要自己动手" —— 否则他会等一个永远不会来的自动配置'
    ).toBe(true)
  })

  it('✅ 边界判据本身要写进说明书（下次想做这件事的人先撞到它）', () => {
    const src = readFileSync(GUIDE, 'utf-8')
    expect(src.includes('产品边界')).toBe(true)
    expect(
      src.includes('可以生成内容让用户自己决定用不用') ||
        src.includes('不能替用户落到别人的盘上'),
      '判据要写成可引用的句子，不能只是一段代码注释'
    ).toBe(true)
  })
})
