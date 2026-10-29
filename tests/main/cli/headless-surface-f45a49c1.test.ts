import { describe, it, expect } from 'vitest'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSurfaceInventoryMarkdown, SURFACE_DOC_PATH } from '../../../src/main/cli/surface-inventory'
import { commands } from '../../../src/main/cli/command-table'
import { riskOf } from '../../../src/main/cli/command-core'
import { GATES } from '../../../src/main/cli/gates'
import { mcpToolName, shouldExpose } from '../../../src/cli/mcp-tools-from-schema'

/**
 * 卡 `f45a49c1`：Headless 基线第一件事 —— 行为清点 / 返回形状清单。
 *
 * ## 治的是什么
 *
 * 验收方（Bob）在这个产品上误报过五次以上，根因全是**拿旧契约读新返回**：
 * `todo get` 对已删事项回墓碑结构，按老形状读成 `status=undefined`。
 * 当时没有任何一份"命令 / 工具 / 权限档 / 返回形状"能逐项对照的清单 ——
 * 只能翻源码、跑 `dp help`、或者问人。
 *
 * ## 本文件钉四件事
 *
 * ① **生成文件与源码一致**：契约变了而没刷新文档 = 红（文档漂移是安静故障，
 *    它不会报错，只会让人照着旧形状读新返回）；
 * ② **空缺被点名**：每个信封类命令都必须声明 `dataShape`，没有就红 ——
 *    "清单里没写"和"产品没有"是两件事，前者必须能被执行者看见；
 * ③ **MCP 映射是派生的**：暴露数 = 命令数 − 排除表，工具名由 `mcpToolName` 推，
 *    本文件不另存一张名单；
 * ④ **产物是一份真文件**（`docs/generated/headless-surface.md`）：别的 agent
 *    读得到，不依赖跑测试才能看。
 *
 * ⚠️ 本文件**不要求**任何人手工维护那份文档 —— 更新入口只有一个：
 * `node scripts/update-surface-inventory.mjs`（与 `829ad776` 的命令面基线同规矩：
 * 刷新动作要留在命令历史里，评审看 diff 才有得看）。
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const DOC = join(ROOT, SURFACE_DOC_PATH)

describe('Headless 能力清点（卡 f45a49c1）', () => {
  it('生成文件与当前源码逐字一致（契约变了就得刷新，别让文档漂）', () => {
    const rendered = buildSurfaceInventoryMarkdown()
    if (process.env.UPDATE_SURFACE_INVENTORY === '1') {
      writeFileSync(DOC, rendered, 'utf8')
      return
    }
    expect(
      existsSync(DOC),
      `缺少 ${SURFACE_DOC_PATH} —— 跑 node scripts/update-surface-inventory.mjs 生成`
    ).toBe(true)
    const committed = readFileSync(DOC, 'utf8').replace(/\r\n/g, '\n')
    if (committed !== rendered) {
      /**
       * 差异要**说得出差在哪一行**，否则执行者只能整份重生成然后祈祷没漏掉真问题。
       * 这里只点第一处差异的行号与两侧内容 —— 够定位，也不会把整份文档刷进日志。
       */
      const a = committed.split('\n')
      const b = rendered.split('\n')
      const at = a.findIndex((line, i) => line !== b[i])
      throw new Error(
        `${SURFACE_DOC_PATH} 与源码不一致（第一处差异在第 ${at + 1} 行）：\n` +
          `  文件里：${a[at] ?? '（文件更短）'}\n` +
          `  源码里：${b[at] ?? '（源码更短）'}\n` +
          '确认契约确实变了之后，跑 node scripts/update-surface-inventory.mjs，并把 diff 带进评审。'
      )
    }
  })

  it('信封类命令都声明了 dataShape —— 空缺只有被点名才算盘点过', () => {
    const envelope = commands.filter((c) => (c.output ?? 'json') === 'json')
    const missing = envelope.filter((c) => !c.dataShape).map((c) => c.name)
    expect(missing, `这些命令没声明 dataShape：${missing.join('、')}`).toEqual([])
  })

  it('命令名不重复 —— 重名会让 MCP 工具表出现两条还原到同一条命令的项', () => {
    const names = commands.map((c) => c.name)
    expect(new Set(names).size, '命令表里有重名').toBe(names.length)
  })

  it('MCP 工具名在暴露的命令里也不重复', () => {
    const toolNames = commands.filter((c) => shouldExpose(c.name)).map((c) => mcpToolName(c.name))
    const dup = toolNames.filter((n, i) => toolNames.indexOf(n) !== i)
    expect(dup, `MCP 工具名重复：${dup.join('、')}`).toEqual([])
  })

  it('每个关口都写清了强度、退出码与实装位置（否则它就是一句假承诺）', () => {
    for (const gate of GATES) {
      expect(['block', 'authorize', 'notice'], `${gate.id} 的 enforcement 非法`).toContain(
        gate.enforcement
      )
      expect([0, 2, 4], `${gate.id} 的退出码不是真实档位`).toContain(gate.exitCode)
      // implemented: false 的关口必须写明为什么 —— 这一条靠 notes 承载
      if (!gate.implementedAt) {
        expect(gate.notes, `${gate.id} 未实装却没说为什么`).toBeTruthy()
      }
    }
  })

  it('风险档只有四档 —— 出现第五种取值说明有人漏了 riskOf 的约定', () => {
    const tiers = new Set(commands.map((c) => riskOf(c)))
    for (const tier of tiers) {
      expect(['read', 'write', 'config', 'destructive'], `未知风险档 ${tier}`).toContain(tier)
    }
  })
})
