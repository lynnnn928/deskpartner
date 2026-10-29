import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const guide = fs.readFileSync(path.join(root, 'src/main/cli/agent-guide.ts'), 'utf8')
/**
 * **命令链**的源码 = `commands.ts`（门面）加上它**递归引用**到的、`src/main/cli/` 下的模块。
 *
 * 1.0.112（卡 bbeb1b51）把那张 9600 行的命令表按内聚区拆成了六个模块。
 * 这里若继续只读门面，凡"命令表里必须有 X"的检查都会**静默失效** ——
 * 正是下面这条注释里记过的同一类教训（那次是假红，这次的方向是假绿，
 * 而假绿更坏：没人会去修一条永远绿的闸门）。
 *
 * 1.0.112 之后（卡 d1b71d28）命令表又按业务域切进了 `src/main/cli/commands/<域>.ts`，
 * 而域文件挂在 `command-table.ts` 底下、门面一行都不会提到它们 ——
 * 于是清单改由**引用关系**推出来：跟着 `from './x'` 与 `import('./x')` 递归。
 * 硬约束与 `tests/main/cli/cli-chain.ts` 一致：`commands/` 下每个 .ts 都必须在链里，
 * 少一个就抛错（少读只会让判据静默失效）。
 */
function readCommandChain() {
  const CLI = path.join(root, 'src/main/cli')
  const seen = new Set()
  const texts = []
  const walk = (file) => {
    const abs = path.resolve(file)
    if (seen.has(abs) || !abs.startsWith(CLI + path.sep)) return
    let src
    try {
      src = fs.readFileSync(abs, 'utf8')
    } catch {
      return
    }
    seen.add(abs)
    texts.push(src)
    for (const m of src.matchAll(/(?:from|import)\s*\(?\s*'(\.[^']*)'/g)) {
      const resolved = path.resolve(path.dirname(abs), m[1])
      walk(resolved.endsWith('.ts') ? resolved : `${resolved}.ts`)
    }
  }
  walk(path.join(CLI, 'commands.ts'))
  if (seen.size < 10)
    throw new Error(
      `命令链只读到 ${seen.size} 个文件（至少该有 10 个）—— ` +
        '门面或引用写法变了？此时这条检查少读了源码，判据会静默失效。'
    )
  const domainDir = path.join(CLI, 'commands')
  const missing = fs
    .readdirSync(domainDir)
    .filter((f) => f.endsWith('.ts'))
    .filter((f) => !seen.has(path.join(domainDir, f)))
  if (missing.length)
    throw new Error(
      `命令链没读到 ${missing.join(' / ')} —— 域文件必须接进命令表（import 它并 spread 进 commands），` +
        '否则那些命令不会生效，而这条检查也会漏读它。'
    )
  return texts.join('\n')
}

const commands = readCommandChain()
/**
 * 主题清单的**唯一出处**是 `guide-topics.ts`（卡 `d3cc69a6`，2026-10-22）。
 *
 * 此前这张表写在 `agent-guide.ts` 里，本脚本按 `core: [` 这种字面量去 grep ——
 * 表一搬家，四条检查全红，而四个主题其实都好着（`dp skill core|…` 实测正常）。
 * 那是**假红**：它教人的是"这个闸门红了就忽略"，而这几版辛苦建立的正是"红 = 真有事"。
 * 所以：**主题名从表里派生**（不再手写第二遍），并且逐个核对
 * 表里的小节**真的在 `agent-guide.ts` 里**（少了就红 —— 那才是"主题正文被删"）。
 */
const topicsSrc = fs.readFileSync(path.join(root, 'src/main/cli/guide-topics.ts'), 'utf8')
const topics = [...topicsSrc.matchAll(/^ {2}([A-Za-z][\w-]*): \{/gm)].map((m) => m[1])
const errors = []

if (!topics.length) errors.push('主题表里解析不出任何主题（guide-topics.ts 的写法变了？）')
if (topics.length < 4) errors.push(`主题只有 ${topics.length} 个 —— 少了主题就会有一批 agent 读不到内容`)
if (!guide.includes('buildAgentGuideIndex')) errors.push('缺少 L0 guide 生成器')
if (!guide.includes('buildAgentGuideTopic')) errors.push('缺少 L1 topic guide 生成器')
if (!commands.includes('guideTopicNames()'))
  errors.push('skill 的主题枚举没有从 guide-topics.ts 派生（又变成手写第二遍）')

/** 取某个主题在源文件里的那一块（到下一个 `},` 为止） */
function blockOf(topic) {
  const start = topicsSrc.indexOf(`\n  ${topic}: {`)
  if (start < 0) return ''
  const next = topicsSrc.indexOf('\n  },', start)
  return topicsSrc.slice(start, next < 0 ? topicsSrc.length : next)
}

for (const topic of topics) {
  const heads = [...blockOf(topic).matchAll(/'((?:#+) [^']+)'/g)].map((m) => m[1])
  if (!heads.length) errors.push(`主题 ${topic} 没有列出任何小节（dp skill ${topic} 会是空的）`)
  for (const h of heads) {
    if (!guide.includes(h))
      errors.push(`主题 ${topic} 的小节「${h}」在 agent-guide.ts 里不存在（dp skill ${topic} 会静默少一节）`)
  }
}
if (!commands.includes("name: 'skill'")) errors.push('命令表缺少 skill')
if (!commands.includes("name: 'topic'")) errors.push('skill 未声明 topic positional 参数')
const l0 = guide.slice(guide.indexOf('export function buildAgentGuideIndex'))
for (const forbidden of ['qwen', '驳回']) {
  if (l0.includes(forbidden)) errors.push(`L0 Guide 不应包含开发历史词：${forbidden}`)
}
const sourceCommands = [...commands.matchAll(/name:\s*'([^']+)'/g)].map((m) => m[1])
for (const required of ['help', 'schema', 'doctor', 'skill', 'project get', 'project search']) {
  if (!sourceCommands.includes(required)) errors.push(`文档校验所需命令不在命令表：${required}`)
}
if (errors.length) {
  console.error(errors.map((x) => `[FAIL] ${x}`).join('\n'))
  process.exit(1)
}
const report = {
  generatedAt: new Date().toISOString(),
  guideSource: 'src/main/cli/agent-guide.ts + src/main/cli/guide-topics.ts',
  topics,
  commandCount: sourceCommands.length,
  checks: [
    'L0/L1 generator',
    'topic table single source',
    'topic headings exist in guide',
    'topic positional schema',
    'historical wording ban',
    'required command names'
  ]
}
console.log(`docs verified: ${report.commandCount} commands, ${topics.length} topics (${report.generatedAt})`)
