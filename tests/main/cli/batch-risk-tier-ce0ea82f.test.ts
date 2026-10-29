/**
 * `batch` 的风险档必须说真话（`ce0ea82f`）
 *
 * ## 它治的病
 *
 * `batch` 从 stdin 读 NDJSON 并**执行**其中的命令 —— 那些命令可以是一条
 * `todo add`。而它此前声明的是 `readOnly: true`（1.0.97 报到 1.0.107 一直在），
 * 于是 MCP `tools/list` 给宿主的是 `readOnlyHint: true`。
 *
 * 那个注解的全部意义就是**宿主据此决定要不要在动手前问用户**：
 * 宿主信了"这是只读"，就不会弹确认 —— 而这次调用可以写进多条数据。
 * 这不是"档位标得保守一点"，是**同一个字段的语义被反过来用了**。
 *
 * ## 这份测试钉住什么
 *
 * 1. **不变量（源码扫描）**：凡是 `run` 里调用 `executeOne(` 的命令，
 *    一律不得是 read 档 —— 治的是"将来再加一个批量容器又忘了改档位"。
 *    逐个补 `batch` 一条改不动这个模式，那是 142d0420 刚学过的教训
 *    （漏掉的分支是静默的，没人能从报错里看出来）。
 * 2. **四个出口同源**：`schema` / `help` 简表 / `--help`（用法）/ MCP 生成的工具注解
 *    对 batch 给出同一个、非只读的结论。`1e525804` 修了三轮的正是"四出口不同源"。
 * 3. **拦在入口**：无人值守且没声明身份时，`batch` 在**读 stdin 之前**就被拦下 ——
 *    判据是"这个入口能不能写"，与这一行长什么样无关。
 */
import { describe, it, expect } from 'vitest'
import { readCliChain } from './cli-chain'
import { z } from 'zod'
import { buildSchema, commands, executeOne, riskOf } from '../../../src/main/cli/commands'
import { generateMcpTools } from '../../../src/cli/mcp-tools-from-schema'

const COMMANDS_SRC = readCliChain()

/** 剥掉注释，免得文档注释里提到 `executeOne(` 被当成"真在调它" */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

/**
 * 按命令表的书写形状切片：每个命令条目以 `^  {$` 开头，
 * 于是 `name: '...'` + `run` 体落在同一片里。
 *
 * 卡 d1b71d28 把命令表按业务域切进了 `commands/<域>.ts` —— 聚合器里只剩
 * `...xxxCommands` 的展开，所以**得把所有域数组的数组体拼起来**再切片。
 * 少拼一个数组，闸门就会少看几条命令（恒真风险），所以先数数组个数、
 * 数不对就直接抛错。实测拼出来正好 70 片，与 `commands.length` 相等 ——
 * 切片错了这里会先红（见下面那条 `size` 断言），不会静默切出空集合让闸门恒真。
 *
 * 最后一条命令曾经把数组闭合之后的模块级代码一起吞进来（实测 `agent revoke`
 * 因此被当成容器：它后面几百行处有 `executeOne(...)` 的真实调用，那是调度层、
 * 不是命令的 run），所以每片都只取到**该数组自己的闭合行**为止。
 */
function commandBlocks(): { name: string; body: string }[] {
  const src = stripComments(COMMANDS_SRC.replace(/\r\n/g, '\n'))

  const arrays = [...src.matchAll(/^export const (\w+): CommandSpec\[\] = \[$/gm)]
    .filter((m) => m[1].endsWith('Commands'))
    .map((m) => m.index)
  if (arrays.length < 20) {
    throw new Error(
      `只找到 ${arrays.length} 个命令数组（至少该有 20 个）—— 域文件或数组名改了？` +
        '此时切片会漏读，闸门会假绿。'
    )
  }

  const bodies = arrays.map((from, i) => {
    const to = i + 1 < arrays.length ? arrays[i + 1] : src.length
    const seg = src.slice(from, to)
    const close = seg.indexOf('\n]')
    return close < 0 ? seg : seg.slice(0, close)
  })

  return bodies
    .join('\n')
    .split(/^  \{$/m)
    .map((part) => {
      const m = /^\s{4}name: '([^']+)',/m.exec(part)
      return m ? { name: m[1], body: part } : null
    })
    .filter((b): b is { name: string; body: string } => b !== null)
}

describe('batch 的风险档（ce0ea82f）', () => {
  it('源码扫描：能执行别的命令的入口，不得声明成只读', () => {
    const blocks = commandBlocks()
    expect(blocks.length, '切片一个命令都没切出来 —— 闸门会恒真，先修切法').toBeGreaterThan(50)

    const containers = blocks.filter((b) => /executeOne\(/.test(b.body))
    expect(
      containers.map((c) => c.name),
      '一个批量执行容器都没扫到？那这条闸门现在是恒真的，别当它绿'
    ).toEqual(['batch'])

    const readTier = containers.filter((c) => {
      const spec = commands.find((x) => x.name === c.name)
      return !spec || riskOf(spec) === 'read'
    })
    expect(
      readTier.map((c) => c.name),
      '这些入口能执行写命令却是 read 档：宿主不会弹确认，而它能改数据'
    ).toEqual([])
  })

  it('batch 在真实命令表里是 write 档', () => {
    const spec = commands.find((c) => c.name === 'batch')
    expect(spec, '命令表里没有 batch？名字变了就同步这条').toBeTruthy()
    expect(riskOf(spec!)).toBe('write')
    /**
     * 光改 `risk` 而留着 `readOnly: true` 是**最糟的一种修法**：
     * `riskOf` 认 risk、别的读 `cmd.readOnly` 的地方认 readOnly ——
     * 两个字段打架，调用方各看各的。所以两个都钉。
     */
    expect(spec!.readOnly, '声明里不许再留 readOnly: true —— 那是第二套判据').not.toBe(true)
  })

  it('四个出口同源：schema / help 简表 / 用法 / MCP 注解都说"不是只读"', async () => {
    // ① schema（机器读的那份契约）
    const schemaBatch = buildSchema().commands.find((c) => c.name === 'batch')!
    expect(schemaBatch.risk).toBe('write')
    expect(schemaBatch.readOnly).toBe(false)

    // ② help 简表（顶层清单）
    const help = (await executeOne({ deps: {}, meta: {} } as never, ['help'])) as {
      data: { commands: { name: string; readOnly: boolean; risk: string }[] }
    }
    const helpBatch = help.data.commands.find((c) => c.name === 'batch')!
    expect(helpBatch.risk).toBe('write')
    expect(helpBatch.readOnly).toBe(false)

    // ③ 用法（`dp batch --help`；`--help` 先答、不过门禁，所以空 deps 够用）
    const usage = (await executeOne({ deps: {}, meta: {} } as never, ['batch', '--help'])) as {
      data: { readOnly: boolean; risk: string }
    }
    expect(usage.data.risk).toBe('write')
    expect(usage.data.readOnly).toBe(false)

    /**
     * ④ MCP 生成的工具注解 —— 宿主真正据以决定"要不要弹确认"的那一份。
     *
     * `readOnlyHint: false` 只是不再谎报；还必须有 `actor`：
     * 这个入口要身份，而宿主只有通过 `actor` 入参才能指定"这次是谁"。
     */
    const tools = generateMcpTools(
      buildSchema().commands.map((c) => ({ ...c, args: c.args ?? [] })) as never,
      z
    )
    const batchTool = tools.find((t) => t.name === 'batch')!
    expect(batchTool, 'MCP 工具表里没有 batch').toBeTruthy()
    expect(batchTool.annotations.readOnlyHint, '宿主据此判断"不必问用户"').toBe(false)
    expect(batchTool.annotations.idempotentHint).toBe(false)
    expect(batchTool.actor, '写工具要给宿主一个指定身份的办法').toBe(true)
  })

  it('拦在入口：无人值守 + 没声明身份时，batch 在读 stdin 之前就被拒', async () => {
    /**
     * `deps` 故意留空：判据是**门禁**在不碰任何数据层的情况下就把它拦下。
     * 若它还落在 `stdin 为空`（usage_error）上，说明它越过了门禁去读 stdin ——
     * 那正是"标只读 → 免批 → 内容照跑"的老路。
     *
     * `stdin: ''` 是给这条用例兜底：档位一旦被改回只读，`run` 会走到读 stdin 那一步 ——
     * 那里空串只是报用法错（fast fail），不传则会去读进程 stdin 而**挂住**，
     * 让"闸门变红"退化成"跑不完"。闸门自己必须先能稳定地红。
     */
    const res = (await executeOne(
      { deps: {}, meta: {}, interactive: false, stdin: '' } as never,
      ['batch']
    )) as { ok: boolean; errorCode?: string; message?: string }
    expect(res.ok).toBe(false)
    expect(res.errorCode, `实际：${res.message}`).toBe('identity_required')
  })
})
