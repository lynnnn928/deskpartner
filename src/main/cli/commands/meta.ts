/**
 * 元命令命令（1.0.112 域切，卡 d1b71d28）
 *
 * 从 `command-table.ts` 里**整块搬来**的，条目逐字节未改 —— 参数声明与 `run` 都在
 * 这里，`schema` 直接序列化它（接口文档不可能与实现脱节）。
 *
 * ⚠️ 数组**顺序是外部契约**的一部分：`dp help` 的排列、`dp schema` 的命令清单、
 * MCP `tools/list` 的工具顺序都由 `command-table.ts` 里那张表的顺序决定。
 *
 * ⚠️ 为什么这个文件导出**多段**：原表里它们被别的域隔开（不是按域连续排的），
 *    而顺序不能改。各段在 `command-table.ts` 的聚合处按原次序展开：
 *      · schemaCommands
 *      · skillCommands
 *      · helpCommands
 */

import { NotFoundError } from '../../lib/domain-errors'
import { buildAgentGuideIndex, buildAgentGuideTopic } from '../agent-guide'
import { guideTopicNames } from '../guide-topics'
import { riskOf } from '../command-core'
import type { CommandSpec } from '../command-core'
import { buildSchema } from '../command-schema'
import { commands, commandUsage } from '../command-table'

export const schemaCommands: CommandSpec[] = [
  {
    name: 'schema',
    dataShape: 'object',
    readOnly: true,
    desc: '输出全部命令、参数、枚举与退出码（供 Agent 自举）',
    args: [
      {
        /**
         * 历史上 README 一直教人写 `schema --json`，而它从未被声明 ——
         * 1.0.32 起未知参数一律拒绝，这条沿用多年的写法直接变成退出码 2。
         * 输出本来就是 JSON 信封，所以把它声明成 **no-op**（接受并忽略），
         * 收下老调用方的习惯，而不是逼它们改代码。
         */
        flag: '--json',
        type: 'boolean',
        desc: '兼容写法，可省略：输出向来就是 JSON'
      }
    ],
    run: () => buildSchema()
  },
]

export const skillCommands: CommandSpec[] = [
  {
    name: 'skill',
    readOnly: true,
    desc: '输出渐进式 AI 接入说明；默认只给入口，按主题读取详细规则',
    args: [],
    positional: { name: 'topic', required: false, desc: `主题：${guideTopicNames().join(' / ')}；dp skill list 逐行列出` },
    // 原样输出 Markdown：套上 JSON 信封对方就没法直接当 skill 文件用了
    output: 'text',
    run: (ctx, _flags, positional) => {
      const topic = positional[0]
      if (!topic) return buildAgentGuideIndex(undefined, ctx.meta.version)
      if (topic === 'list') return guideTopicNames().join('\n')
      return buildAgentGuideTopic(topic, undefined, ctx.meta.version)
    }
  },
]

export const helpCommands: CommandSpec[] = [
  {
    name: 'help',
    dataShape: 'object',
    readOnly: true,
    desc: '查看命令清单；带命令名则看该命令的完整参数（比 schema 轻得多）',
    args: [],
    /**
     * 命令名可能是**两个词**（`help todo rm`）→ 位置参数最多 2 段。
     *
     * 这里是"多给判据"（1.0.107，修 `350f9631`）落下来时**必须一起改**的地方：
     * 不写 `arity` 就按默认的 1 算，`help todo rm` 会被当成"多给了一个参数"拒掉 ——
     * 而它一直是合法的（`run` 里把各段 join 回命令名）。
     * 两个词是上限：命令名最长就是两段，三段以上一律 usage_error 更准
     * （以前是 join 出一个不存在的名字再报 not_found）。
     */
    positional: {
      name: 'command',
      arity: 2,
      desc: '要查看的命令名，如 "todo add"；不传则只列清单'
    },
    run: (_ctx, _flags, positional) => {
      // 命令名可能是两个词（"todo add"），positional 会被拆成多段，要拼回来
      const name = positional.join(' ').trim()

      if (!name) {
        /**
         * 顶层清单也必须带只读标记与风险档（1.0.72 修 `1e525804` 的**第三处**）
         *
         * ⚠️ 这是同一个 bug 的第三次出现，前两次都只修了一部分：
         *   - 1.0.65 修了 `schema` 输出；
         *   - 后来修了 `help <命令名>`（即 `commandUsage`）。
         * 而**无参数 `help` 这条清单路径**一直只是 `map(c => ({name, desc}))` ——
         * 字段根本没有，于是顶层清单里每条命令的只读标记全是"缺失"。
         *
         * 为什么连着两轮没修好：每次都只测了自己刚动过的那条路径。
         * 同一个语义有**三个出口**（schema / help 单条 / help 清单），
         * 修两处不叫修好 —— 第三处会以"字段缺失"的形式静默说错话。
         *
         * 判据：**一份语义有几个出口，就得有几个断言**，
         * 且断言要落在"调用方真正拿到的那份数据"上（与本文件既有闸门同源）。
         *
         * 修法不新造字段：直接复用 `commandUsage` 那一份派生，
         * 保证三处永远同源（真值只有门禁用的 `riskOf`）。
         */
        return {
          tip:
            '这是简表：命令名、一行说明、只读标记与风险档（readOnly / risk 与 schema 同源）。' +
            '看全部参数用 schema；看单个命令用 help <命令名>。',
          commands: commands.map((c) => ({
            name: c.name,
            desc: c.desc,
            readOnly: riskOf(c) === 'read',
            risk: riskOf(c)
          }))
        }
      }

      const hit = commands.find((c) => c.name === name)
      if (!hit) {
        throw new NotFoundError(`没有这个命令: ${name}（不带参数运行 help 看全部）`)
      }

      return commandUsage(hit)
    }
  },
]
