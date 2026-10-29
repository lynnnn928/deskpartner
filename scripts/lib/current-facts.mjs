/**
 * 入口文档「当前态事实」的唯一判据（卡 `5cc426b9`）
 *
 * ## 为什么判据要单独一份
 *
 * 同一件事（README / AGENTS 的当前态数字对不对）现在有两个闸门要看：
 *
 * - `scripts/verify-current-facts.mjs` —— **运行时**事实：命令表问跑着的应用（`dp schema`）
 * - `tests/main/cli/entry-docs-current-facts-5cc426b9.test.ts` —— **源码**事实：
 *   直接 import `commands` / `shouldExpose`，不需要构建产物，也不需要跑着的应用
 *
 * 两边的**事实来源**天生不同（一个在运行时、一个在源码，环境决定，统一不了），
 * 但**判据只有一份** —— 这个仓库已经吃过"同一个事实两套判据"的亏
 * （`251eb399`：前向名表与反向名表打架，60 个工具里 9 个还原不出命令）。
 *
 * ## 判据的形状
 *
 * 1. **位置已知的四格 + 一行**：README 的 `| 代码版本 |` / `| schema |` /
 *    `| CLI |` / `| MCP |` 四格，加 AGENTS 的「当前状态」一行。逐格核**且要求它还在**
 *    —— 有人把整行改写成别的措辞时这里必须红，不能静默失守。
 * 2. **加粗的当前态计数**：两份文档陈述当前态时一律加粗（`**67 条命令**`），
 *    而"手跑 8 条命令"这类叙述不带加粗 —— 拿裸数字去匹配会把它们一并误伤
 *    （假闸门比没闸门更糟）。
 * 3. **引用块与代码块跳过**：历史发版记录在入口文档里都写成引用块，
 *    那里允许保留历史数字 —— 见 `docs/generated/current-facts.md` 的使用规则。
 * 4. **唯一来源声明**：两份文档都必须写着 `RUNTIME_SOURCE_NOTE` 那一句。
 */

/**
 * 入口文档（两份，一起核）
 *
 * AGENTS.md 是 CRLF、README.md 是 LF —— 下面一律 `split('\n')` / `join('\n')`，
 * 不去动行尾（`\r` 留在行末当普通字符，正则都不带 `$`，不受影响）。
 */
export const DOC_FILES = ['README.md', 'AGENTS.md']

/**
 * 能力基线：命令表与 MCP 工具表的当前规模
 *
 * 有意改动命令表时（加一条命令、调 MCP 排除表），这三条要一起改 ——
 * 改完还得同步入口文档，否则源码侧用例会红。**别只改这里。**
 */
export const CAPABILITY_BASELINE = {
  cliCommands: 76,
  mcpTools: 69,
  excludedMcpCommands: 7
}

/** CLI 当前事实的唯一运行时来源声明：两份入口文档都必须写着这一句 */
export const RUNTIME_SOURCE_NOTE = '以 `node out/cli/deskpartner.cjs schema` 的 `data.commands` 为准'

/**
 * 入口文档里「当前态字段」的位置
 *
 * `scope` 分两档，判据是**这个事实由谁定**：
 *
 * - `source`：源码文本就能定（`package.json` 的 version、`constants.ts` 的 `DB_VERSION`）
 * - `runtime`：得问跑着的应用（命令表）—— 应用比源码旧时，不能拿它改写文档
 *
 * 每条给两份正则（README 的表格格 / AGENTS 的「当前状态」一行），形状统一：
 * **组 1 前缀、组 2 数字、组 3 后缀** —— 核与改用同一组边界，
 * 免得落进"核的时候认得出、改的时候改不动"。
 */
const FIELDS = [
  {
    key: 'version',
    label: '代码版本',
    scope: 'source',
    re: {
      'README.md': /^(\| 代码版本 \| \*\*)(\d+\.\d+\.\d+)(\*\*)/m,
      'AGENTS.md': /(版本 \*\*)(\d+\.\d+\.\d+)(\*\*（本地 main）)/
    }
  },
  {
    key: 'schemaVersion',
    label: 'schema 版本',
    scope: 'source',
    re: {
      'README.md': /^(\| schema \| \*\*v)(\d+)(\*\*)/m,
      'AGENTS.md': /(，schema \*\*v)(\d+)(\*\*，CLI)/
    }
  },
  {
    key: 'cliCommands',
    label: 'CLI 命令数',
    scope: 'runtime',
    re: {
      'README.md': /^(\| CLI \| \*\*)(\d+)( 条命令\*\*)/m,
      'AGENTS.md': /(，CLI \*\*)(\d+)( 条命令\*\*)/
    }
  },
  {
    key: 'mcpTools',
    label: 'MCP 工具数',
    scope: 'runtime',
    re: {
      'README.md': /^(\| MCP \| \*\*)(\d+)( 个工具\*\*)/m,
      'AGENTS.md': /(，MCP 工具 \*\*)(\d+)( 个\*\*)/
    }
  }
]

/** 两份文档里"加粗的当前态计数"的三种写法（与正文陈述当前态的习惯一致） */
const CLAIM_PATTERNS = [
  { key: 'cliCommands', re: /\*\*(\d+)\s*条命令\*\*/g },
  { key: 'mcpTools', re: /\*\*(\d+)\s*个工具\*\*/g },
  { key: 'mcpTools', re: /MCP 工具\s*\*\*(\d+)\s*个\*\*/g }
]

/**
 * 逐行给出「允许承载当前态数字」的行（代码块与引用块之外），可以返回改写后的行
 *
 * 收集与改写共用这一遍扫描：同一个"哪里算当前态"的判据，不写第二份。
 */
function mapClaimLines(text, rewrite) {
  let inFence = false
  const lines = text.split('\n').map((line, index) => {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      return line
    }
    if (inFence) return line
    if (/^\s*>/.test(line)) return line // 历史记录：允许历史数字
    return rewrite(line, index + 1)
  })
  return lines
}

/** 文档里加粗的当前态计数，逐条列出 */
export function collectDocClaims(text, file) {
  const claims = []
  mapClaimLines(text, (line, lineNumber) => {
    for (const { key, re } of CLAIM_PATTERNS) {
      re.lastIndex = 0
      let m
      while ((m = re.exec(line)) !== null) {
        claims.push({ file, line: lineNumber, text: m[0], key, value: Number(m[1]) })
      }
    }
    return line
  })
  return claims
}

/** 读一个字段：在不在、现在写的是什么 */
function readField(text, re) {
  const m = text.match(re)
  return m ? { found: true, value: m[2] } : { found: false, value: null }
}

/** 改一个字段：只换数字，前缀后缀原样保留（不改措辞、不重排行） */
function writeField(text, re, value) {
  return text.replace(re, (_match, prefix, _old, suffix) => `${prefix}${value}${suffix}`)
}

/** 期望写法，只用来写报错信息 */
function expectation(field, facts) {
  return field.key === 'schemaVersion' ? `**v${facts[field.key]}**` : `**${facts[field.key]}**`
}

/**
 * 核：两份入口文档的当前态事实对不对
 *
 * @returns 问题列表（空数组 = 通过）。**不抛异常** —— 调用方决定怎么报
 *          （脚本 throw 成一条命令的失败，用例断言成一条测试的失败）。
 */
export function checkDocFacts({ readme, agents, facts, scope = 'all' }) {
  const docs = { 'README.md': readme, 'AGENTS.md': agents }
  const problems = []

  for (const field of FIELDS) {
    if (scope === 'source' && field.scope !== 'source') continue
    for (const file of DOC_FILES) {
      const where = `${file} 的「${field.label}」`
      const seen = readField(docs[file], field.re[file])
      if (!seen.found) {
        problems.push(
          `${where}没写成当前态（期望 ${expectation(field, facts)}）—— 措辞被改掉时这里必须红，不能静默失守`
        )
      } else if (seen.value !== String(facts[field.key])) {
        problems.push(`${where}写的是 ${seen.value}，当前事实是 ${facts[field.key]}`)
      }
    }
  }

  if (scope === 'all') {
    for (const file of DOC_FILES) {
      for (const claim of collectDocClaims(docs[file], file)) {
        if (claim.value !== facts[claim.key]) {
          problems.push(`${file}:${claim.line} 「${claim.text}」应为 ${facts[claim.key]}`)
        }
      }
    }
    for (const file of DOC_FILES) {
      if (!docs[file].includes(RUNTIME_SOURCE_NOTE)) {
        problems.push(`${file} 未声明 CLI 当前事实的唯一运行时来源（缺「${RUNTIME_SOURCE_NOTE}」）`)
      }
    }
  }

  return problems
}

/**
 * 改：按事实改写两份入口文档的当前态字段
 *
 * `scope: 'source'` 只改版本类字段（发版升号那一刻只能改这些 —— 命令数得问跑着的应用，
 * 而那一刻应用必然落后一版）。
 *
 * @returns `{ readme, agents, changed }`；`changed` 是"改了哪几处"的人话列表
 */
export function applyFactsToDocs({ readme, agents, facts, scope = 'all' }) {
  const docs = { 'README.md': readme, 'AGENTS.md': agents }
  const changed = []

  for (const field of FIELDS) {
    if (scope === 'source' && field.scope !== 'source') continue
    for (const file of DOC_FILES) {
      const want = String(facts[field.key])
      const seen = readField(docs[file], field.re[file])
      if (!seen.found || seen.value === want) continue
      docs[file] = writeField(docs[file], field.re[file], want)
      changed.push(`${file} 「${field.label}」${seen.value} → ${want}`)
    }
  }

  if (scope === 'all') {
    for (const file of DOC_FILES) {
      const lines = mapClaimLines(docs[file], (line, lineNumber) => {
        let next = line
        for (const { key, re } of CLAIM_PATTERNS) {
          const before = next
          // 只换捕获到的数字：`replace` 的字符串模式按字面量替换首次出现，不会碰前缀后缀
          next = next.replace(re, (match, digits) => match.replace(digits, String(facts[key])))
          if (next !== before) changed.push(`${file}:${lineNumber} 当前态计数 ${digits} → ${facts[key]}`)
        }
        return next
      })
      docs[file] = lines.join('\n')
    }
  }

  return { readme: docs['README.md'], agents: docs['AGENTS.md'], changed }
}

/**
 * 核：能力基线（命令表与 MCP 工具表的规模）
 *
 * 单独一条：命令表有意变化时，变化点**不止**文档 —— MCP 排除表与这里的基线也要跟着对。
 */
export function checkCapabilityBaseline(facts) {
  const problems = []
  if (facts.cliCommands !== CAPABILITY_BASELINE.cliCommands) {
    problems.push(`CLI 命令数 ${facts.cliCommands} 与能力基线 ${CAPABILITY_BASELINE.cliCommands} 不一致`)
  }
  if (facts.mcpTools !== CAPABILITY_BASELINE.mcpTools) {
    problems.push(`MCP 工具数 ${facts.mcpTools} 与能力基线 ${CAPABILITY_BASELINE.mcpTools} 不一致`)
  }
  if (facts.excludedMcpCommands !== CAPABILITY_BASELINE.excludedMcpCommands) {
    problems.push(
      `MCP 排除项 ${facts.excludedMcpCommands} 个与能力基线 ${CAPABILITY_BASELINE.excludedMcpCommands} 个不一致`
    )
  }
  if (facts.cliCommands - facts.excludedMcpCommands !== facts.mcpTools) {
    problems.push('MCP 工具数无法由 CLI 命令表与唯一排除表复算')
  }
  return problems
}

/** `docs/generated/current-facts.md` 的全部内容（唯一生成处） */
export function renderGeneratedFacts(facts) {
  return [
    '# 当前产品事实（生成文件）',
    '',
    '> 本文件由 `node scripts/verify-current-facts.mjs` 生成。禁止手工编辑；它只记录当前源码事实，不记录历史版本。',
    '',
    '| 项目 | 当前值 | 唯一来源 |',
    '|---|---:|---|',
    `| 产品版本 | **${facts.version}** | \`package.json\` |`,
    `| schema | **v${facts.schemaVersion}** | \`src/renderer/lib/constants.ts:DB_VERSION\` |`,
    `| CLI 命令 | **${facts.cliCommands}** | \`src/main/cli/commands.ts\` / \`schema\` |`,
    `| MCP 工具 | **${facts.mcpTools}** | CLI 命令表 − MCP 排除表（${facts.excludedMcpCommands}） |`,
    '',
    '## 使用规则',
    '',
    '- README、AGENTS.md、Skill 和发布报告不得自行维护另一套当前数字。',
    '- 历史发布记录可以保留历史数字，但必须明确属于历史版本。',
    '- 若本脚本失败，说明入口文档可能已经漂移；不得把失败当成“文档问题以后再修”。',
    ''
  ].join('\n')
}
