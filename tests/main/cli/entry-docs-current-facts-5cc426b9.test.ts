/**
 * 入口文档的当前态数字必须与**源码事实**对齐（卡 `5cc426b9`）
 *
 * ## 它治的病
 *
 * `scripts/verify-current-facts.mjs` 是当前唯一能发现"入口文档数字漂了"的机制，
 * 但它在修复前**没有任何调用方**：`npm test`、`release.mjs` 的前置、`npm run verify`
 * 都不跑它 —— 于是"跑不跑"全靠自觉，而 1.0.107 实测就是这样漂了一整版
 * （`package.json` 已升到 1.0.107，README / AGENTS 还写 1.0.106，没有任何一步因此变红）。
 *
 * 这个用例把同一份判据挂进 `npm test`，而事实取自**源码**：
 * `commands.length`、`commands.filter(shouldExpose).length`、`DB_VERSION`、
 * `package.json` 的版本 —— 不需要构建产物、也不需要跑着的应用。
 *
 * ## 为什么不直接调那条脚本
 *
 * 因为它的事实来自**正在运行的那一版应用**（spawn 启动器 → 命名管道 → 跑着的进程），
 * 而"应用比源码旧"时它会拿旧命令表核出"通过"；再叠上"缺 `out/` 就跳过"，
 * 就是本项目反复写过的**假闸门**。源码侧天生没有这个错位，`npm test` 也在
 * `release.mjs` 第 1 步里，所以"文档不同源 = 发不出包"。
 *
 * 判据住在 `scripts/lib/current-facts.mjs`，与运行时脚本共用一份 ——
 * 避免"同一个事实两套判据"（`251eb399` 的教训）。
 *
 * ## 边界：`docs/generated/current-facts.md` 不在这里
 *
 * 那个文件记的是**运行时**事实（含命令数），与跑着的应用同源 —— 由运行时脚本
 * 全量跑时重写，也就是说它跟着**新装的应用**一起跟上。发版升号那一刻应用还没换，
 * 源码侧拿不到新的命令数，硬把它拉进来就会变成"改了命令表却要先重装应用才能跑测试"的陷阱。
 * 这里管的是**入口文档**（README / AGENTS），它们才是 agent 接入的第一手材料。
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { commands } from '../../../src/main/cli/commands'
import { shouldExpose } from '../../../src/cli/mcp-tools-from-schema'
import { DB_VERSION } from '../../../src/renderer/lib/constants'
import {
  applyFactsToDocs,
  checkCapabilityBaseline,
  checkDocFacts
} from '../../../scripts/lib/current-facts.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8')

const readme = read('README.md')
const agents = read('AGENTS.md')

/** 源码事实：命令表直接数出来的，不经运行时、不经构建产物 */
const exposed = commands.filter((c) => shouldExpose(c.name))
const facts = {
  version: (JSON.parse(read('package.json')) as { version: string }).version,
  schemaVersion: DB_VERSION,
  cliCommands: commands.length,
  mcpTools: exposed.length,
  excludedMcpCommands: commands.length - exposed.length
}

/** 断言通过时把问题列表整段带出来 —— 失败时看得见"哪一格、写的是什么、应为多少" */
const expectNoProblems = (problems: string[], what: string): void => {
  expect(problems, `${what}：\n${problems.map((p) => `  - ${p}`).join('\n')}`).toEqual([])
}

describe('入口文档当前态与源码事实对齐（5cc426b9）', () => {
  it('README / AGENTS 的当前态字段与源码事实一致（曾漂了一整版而没人被拦）', () => {
    expectNoProblems(checkDocFacts({ readme, agents, facts }), '入口文档当前态漂移')
  })

  it('能力基线与源码事实一致（命令表有意变化时要一起改）', () => {
    expectNoProblems(checkCapabilityBaseline(facts), '能力基线漂移')
  })

  /**
   * 反向验证：证明上面那条主断言**认得出违规**，不是判据坏了永远绿。
   * 手法：拿两份真文档改成"落后一版 / 计数写错"，同一套判据必须判出漂移。
   */
  it('反向验证：文档落后一版或计数写错会被判出漂移', () => {
    // 更贴近真实故障的构造：整份文档的当前态落后一版（1.0.107 → 1.0.106）
    const stale = {
      readme: readme.replace(`**${facts.version}**`, '**1.0.106**'),
      agents: agents.replace(`版本 **${facts.version}**`, '版本 **1.0.106**')
    }
    expect(stale.readme).not.toBe(readme)
    expect(stale.agents).not.toBe(agents)
    const versionProblems = checkDocFacts({ readme: stale.readme, agents: stale.agents, facts })
    expect(versionProblems.some((p) => p.includes('代码版本'))).toBe(true)

    const miscounted = { readme: readme.replace(`**${facts.cliCommands} 条命令**`, '**43 条命令**'), agents }
    expect(miscounted.readme).not.toBe(readme)
    expect(checkDocFacts({ ...miscounted, facts }).some((p) => p.includes('43 条命令'))).toBe(true)

    // 措辞被改掉（当前态那一行整行重写）时也必须红，不能静默失守
    const reworded = { readme, agents: agents.replace('（本地 main）', '（main 分支）') }
    expect(checkDocFacts({ ...reworded, facts }).some((p) => p.includes('没写成当前态'))).toBe(true)
  })

  /**
   * 反向验证的另一半：`applyFactsToDocs` 必须**能把漂移改回一致**，
   * 而且只动该动的那几处 —— 否则发版那一跳就会把文档改坏。
   */
  it('反向验证：applyFactsToDocs 能把漂移改回一致，且不多动一行', () => {
    const drifted = {
      readme: readme
        .replace(`**${facts.version}**`, '**1.0.106**')
        .replace(`**${facts.cliCommands} 条命令**`, '**43 条命令**'),
      agents: agents.replace(`版本 **${facts.version}**`, '版本 **1.0.106**')
    }
    expect(checkDocFacts({ ...drifted, facts }).length).toBeGreaterThan(0)

    const fixed = applyFactsToDocs({ ...drifted, facts })
    expectNoProblems(checkDocFacts({ readme: fixed.readme, agents: fixed.agents, facts }), '改写后仍然漂移')
    expect(fixed.readme).toBe(readme)
    expect(fixed.agents).toBe(agents)
    expect(fixed.changed.length).toBe(3) // 版本两处 + 计数一处
  })

  /**
   * `--fix-source` 那一档（发版升号同一步用的）：只按源码文本改版本类字段。
   * 它必须**不碰命令数** —— 那一刻跑着的应用还是上一版，拿它改写会把文档改坏。
   */
  it('反向验证：source 档只改版本类字段，命令数原样不动', () => {
    const drifted = {
      readme: readme
        .replace(`**${facts.version}**`, '**1.0.106**')
        .replace(`**${facts.cliCommands} 条命令**`, '**43 条命令**'),
      agents
    }
    const fixed = applyFactsToDocs({ ...drifted, facts, scope: 'source' })
    // 版本类字段被改对；命令数**原样不动**（source 档拿不到运行时的命令表，也不该去猜）
    expect(fixed.readme).toBe(drifted.readme.replace('**1.0.106**', `**${facts.version}**`))
    expect(fixed.readme).toContain('**43 条命令**')
    expect(fixed.changed).toEqual([`README.md 「代码版本」1.0.106 → ${facts.version}`])

    // source 档的判据不看命令数：错的计数它不管（那由源码侧主断言管）
    expect(checkDocFacts({ readme: fixed.readme, agents, facts, scope: 'source' }).length).toBe(0)
    expect(checkDocFacts({ readme: fixed.readme, agents, facts }).length).toBeGreaterThan(0)
  })
})
