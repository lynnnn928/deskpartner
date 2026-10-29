/**
 * 当前产品事实闸门（卡 `5cc426b9` 修的两个毛病）
 *
 * ## 毛病一：它没有调用方 —— 现在有了
 *
 * 「入口文档数字漂了」以前只靠人手跑这一条命令发现，于是 1.0.107 实测就漂了一整版
 * （`package.json` 已是 1.0.107，README/AGENTS 还写 1.0.106，而没有任何一步因此变红）。
 * 现在文档侧的判据住在 `scripts/lib/current-facts.mjs`，**`npm test` 里有一份源码侧用例**
 * （`tests/main/cli/entry-docs-current-facts-5cc426b9.test.ts`）盯同一份判据 ——
 * 它直接 import 命令表，不需要构建产物、也不需要跑着的应用，所以没有"缺产物就假绿"的坑；
 * 而 `scripts/release.mjs` 第 1 步就跑 `npm test`，于是"文档不同步 = 发不出包"。
 *
 * 本脚本是**运行时**那一侧：命令表问跑着的应用，另外还负责改写入口文档与生成事实文件。
 *
 * ## 毛病二：两条一致性检查永不触发 —— 换成来源自证
 *
 * 旧代码里有：
 *
 *     if (schemaData.version && schemaData.version !== facts.version) throw …
 *     if (schemaData.schemaVersion && Number(schemaData.schemaVersion) !== facts.schemaVersion) throw …
 *
 * 而 `dp schema` **不回** `version` / `schemaVersion`（源码 `buildSchema()` 的键是
 * `cli, alias, output, exitCodes, gates, errorCodes, enums, timeFormats, onboarding,
 * agentGuide, riskTiers, commands`），两个条件永远短路 —— 等于没写。
 * 而本脚本取命令数的方式是 spawn 启动器 → 命名管道 → **跑着的那个应用**：
 * 它比的是"正在运行的那一版"，不是源码。那两条检查的本意正是拦住这种错位。
 *
 * 现在改成 `dp doctor` 自证（`data.version` / `data.schemaVersion` 是有的）：
 * 与 `package.json` / `DB_VERSION` 不一致就**红**，因为那种局面下闸门会拿旧版命令表
 * 核出"通过"。取不到这两个字段也红 —— 不能自证就不许放行。
 *
 * ## 三种跑法
 *
 * - 无参数：只核不改（默认），要求跑着的应用与源码同版本（来源自证）。
 * - `--fix`：按**运行时**事实把两份入口文档的当前态字段改写对，再核一遍。
 *   边界要说清：命令数来自跑着的应用，所以它保证的是"文档与**正在运行的那一版**一致"；
 *   源码改了命令表却还没构建安装时，判据在源码侧用例那边（`npm test`）。
 * - `--fix-source`：只改**源码文本就能定**的版本类字段（产品版本、schema 版本），
 *   不碰命令数、也不碰跑着的应用。`scripts/release.mjs` 升完版本号就调它 ——
 *   那一刻 package.json 已经往前一版、装着的应用还落后一版，全量核对必然真红，
 *   而两行版本号必须有人同步，同步它就是那一跳的职责。
 *   它也不动 `docs/generated/current-facts.md`：那份文件记的是**运行时**事实（含命令数），
 *   与跑着的应用同源 —— 跟着新装的应用一起跟上（本脚本全量跑时会重写它）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  applyFactsToDocs,
  checkCapabilityBaseline,
  checkDocFacts,
  renderGeneratedFacts
} from './lib/current-facts.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const FIX_ALL = argv.includes('--fix')
const FIX_SOURCE = argv.includes('--fix-source')
if (FIX_ALL && FIX_SOURCE) {
  throw new Error(
    '--fix 与 --fix-source 不能同时用：前者按运行时事实改全部字段，后者只按源码文本改版本类字段'
  )
}

const readmePath = path.join(root, 'README.md')
const agentsPath = path.join(root, 'AGENTS.md')
const generatedPath = path.join(root, 'docs/generated/current-facts.md')

const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const constants = fs.readFileSync(path.join(root, 'src/renderer/lib/constants.ts'), 'utf8')
const schemaMatch = constants.match(/export const DB_VERSION\s*=\s*(\d+)/)
if (!schemaMatch) throw new Error('无法从 constants.ts 读取 DB_VERSION')
const schemaVersion = Number(schemaMatch[1])

/**
 * 跑着的应用回的 JSON（`dp schema` / `dp doctor` 同一个来源：命名管道那一端）
 *
 * 先查产物在不在：缺 `out/cli/deskpartner.cjs` 时必须**大声报错**，不许跳过 ——
 * 跳过就是新的假闸门。
 */
const launcher = path.join(root, 'out/cli/deskpartner.cjs')

function readCli(command, hint) {
  if (!fs.existsSync(launcher)) {
    throw new Error(
      '缺少 out/cli/deskpartner.cjs；请先运行 node scripts/build-cli.mjs，再执行当前事实校验'
    )
  }
  try {
    const output = execFileSync(process.execPath, [launcher, command], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const parsed = JSON.parse(output)
    return parsed.data ?? parsed
  } catch (error) {
    throw new Error(`${hint}：${error instanceof Error ? error.message : String(error)}`)
  }
}

if (FIX_SOURCE) {
  // ── 只按源码文本同步版本类字段（发版升号那一跳）──
  const facts = { version: packageJson.version, schemaVersion }
  const fixed = applyFactsToDocs({
    readme: fs.readFileSync(readmePath, 'utf8'),
    agents: fs.readFileSync(agentsPath, 'utf8'),
    facts,
    scope: 'source'
  })
  for (const item of fixed.changed) console.log(`  改写 ${item}`)
  if (fixed.changed.some((item) => item.startsWith('README.md'))) fs.writeFileSync(readmePath, fixed.readme)
  if (fixed.changed.some((item) => item.startsWith('AGENTS.md'))) fs.writeFileSync(agentsPath, fixed.agents)

  // 改完必须复核：改不动（措辞变了、位置没了）时这里变红，而不是静默放过
  const problems = checkDocFacts({ ...fixed, facts, scope: 'source' })
  if (problems.length) {
    throw new Error(
      '入口文档的版本类字段没有同步成当前源码事实：\n' + problems.map((p) => `  ${p}`).join('\n')
    )
  }
  console.log(JSON.stringify({ mode: 'fix-source', ...facts }))
  console.log(`entry doc version fields synced: ${path.relative(root, readmePath)}, ${path.relative(root, agentsPath)}`)
} else {
  /**
   * 命令表的真实公开形状以 `dp schema` 为准。
   * 不要扫描 commands.ts 的 `name:` 文本：该文件同时包含类型、示例、别名和内部声明，
   * 文本出现次数不是调用方实际看到的命令数（曾因此把 67 误报成 98）。
   */
  const schemaData = readCli('schema', '无法读取 dp schema')
  const commandNames = (schemaData.commands ?? []).map((command) => command.name)
  if (!commandNames.every((name) => typeof name === 'string' && name.length > 0)) {
    throw new Error('dp schema 返回了无效的命令名')
  }

  // MCP 工具表由同一份 schema 派生；排除项只从唯一的 EXCLUDE 声明读取。
  const mcpSource = fs.readFileSync(path.join(root, 'src/cli/mcp-tools-from-schema.ts'), 'utf8')
  const excluded = [...mcpSource.matchAll(/^\s*'([^']+)'\s*,?\s*$/gm)].map((match) => match[1])
  const uniqueExcluded = [...new Set(excluded)].filter((name) => commandNames.includes(name))
  const facts = {
    version: packageJson.version,
    schemaVersion,
    cliCommands: commandNames.length,
    mcpTools: commandNames.length - uniqueExcluded.length,
    excludedMcpCommands: uniqueExcluded.length
  }

  /**
   * 来源自证：这次核文档用的命令表，真是当前源码那一版吗？
   *
   * `dp doctor` 同时回报 `version` 与 `schemaVersion`（`dp schema` 不回），
   * 于是可以问一句"正在跑的是谁"，答案与源码不符就**红**：
   * 那种局面下闸门会拿旧版命令表核出"通过"，而"通过"是假的。
   */
  const doctor = readCli('doctor', '无法读取 dp doctor')
  const runtimeVersion = doctor.version
  const runtimeSchemaVersion = doctor.schemaVersion
  if (typeof runtimeVersion !== 'string' || runtimeVersion.length === 0) {
    throw new Error('dp doctor 没有回报 version —— 来源自证做不了，闸门不许因此放行')
  }
  if (typeof runtimeSchemaVersion !== 'number') {
    throw new Error('dp doctor 没有回报 schemaVersion —— 来源自证做不了，闸门不许因此放行')
  }
  if (runtimeVersion !== facts.version) {
    throw new Error(
      `正在运行的应用是 ${runtimeVersion}，源码是 ${facts.version}：闸门会拿**旧版**命令表核入口文档，` +
        `结论不可信。装上 ${facts.version} 再跑全量校验；只想同步入口文档的版本号用 --fix-source`
    )
  }
  if (runtimeSchemaVersion !== facts.schemaVersion) {
    throw new Error(
      `正在运行的应用 schema 是 v${runtimeSchemaVersion}，源码 DB_VERSION 是 v${facts.schemaVersion}：` +
        '同样拿的是旧版命令表，结论不可信'
    )
  }

  const baselineProblems = checkCapabilityBaseline(facts)
  if (baselineProblems.length) {
    throw new Error(
      [
        ...baselineProblems,
        '若命令表是有意变化：先核对 schema 与 MCP 排除表，再同步入口文档与 scripts/lib/current-facts.mjs 的 CAPABILITY_BASELINE'
      ].join('\n')
    )
  }

  let readme = fs.readFileSync(readmePath, 'utf8')
  let agents = fs.readFileSync(agentsPath, 'utf8')

  if (FIX_ALL) {
    const fixed = applyFactsToDocs({ readme, agents, facts })
    readme = fixed.readme
    agents = fixed.agents
    for (const item of fixed.changed) console.log(`  改写 ${item}`)
    if (fixed.changed.some((item) => item.startsWith('README.md'))) fs.writeFileSync(readmePath, readme)
    if (fixed.changed.some((item) => item.startsWith('AGENTS.md'))) fs.writeFileSync(agentsPath, agents)
  }

  const problems = checkDocFacts({ readme, agents, facts })
  if (problems.length) {
    throw new Error(
      '入口文档里的当前态事实与运行时事实不一致（改数字没用，得让它跟事实同源；`--fix` 可按事实改写）：\n' +
        problems.map((problem) => `  ${problem}`).join('\n')
    )
  }

  fs.mkdirSync(path.dirname(generatedPath), { recursive: true })
  fs.writeFileSync(generatedPath, renderGeneratedFacts(facts))

  console.log(JSON.stringify(facts))
  console.log(`current facts verified: ${generatedPath}`)
}
