import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

const CLI_DIR = path.resolve(__dirname, '../../../src/main/cli')
const DOMAIN_DIR = path.join(CLI_DIR, 'commands')

/**
 * 「命令链」的源码 = `commands.ts`（门面）**加上它递归引用到的、`src/main/cli/` 下的模块**。
 *
 * ── 为什么要有这个 helper（1.0.112，拆分卡 bbeb1b51）──
 *
 * 仓库里有一批闸门是"扫源码"型的：读某个文件，断言某个写法必须/不许出现
 * （"这句承诺不许再写死第二份"、"全族只有一处解析"、"启动器与服务端都从
 * file-flags.ts 派生"……）。它们此前只读 `commands.ts` 一个文件就够 ——
 * 那时六种职责都挤在里面。
 *
 * 那张 9600 行的文件按内聚区拆成六个模块之后，**继续只读门面会让这些闸门
 * 全部静默变绿**：判据要盯的代码搬到了隔壁文件，闸门却看不见它。
 * 这比"假红"更坏 —— 假红会被当成噪音忽略，假绿是"防线没了却没人知道"。
 * （`scripts/verify-docs.mjs` 里记过同一类教训的反面：主题表一搬家，
 * 四条 grep 检查全红。那次是假红，这次的方向是假绿。）
 *
 * ── 1.0.112 之后（卡 d1b71d28）：从"读一层"改成"跟着引用递归" ──
 *
 * 命令表又被按业务域切进了 `src/main/cli/commands/<域>.ts`。此时"门面再导出了
 * 哪些模块"已经**不等于**"命令链有哪些文件"：域文件挂在 `command-table.ts`
 * 底下，门面一行都不会提到它们。所以清单改由**引用关系**推出来：
 * 从门面出发，跟着 `from './x'`（import 与再导出）与 `import('./x')` 递归，
 * 只跟 `src/main/cli/` 里的文件（`../database/*` 那些不属于命令链）。
 *
 * ⚠️ **`commands/` 下的每个 .ts 都必须在链里，少一个就抛错** ——
 * 少读只会让闸门变绿，那是这条 helper 唯一必须防住的事。
 * 目录扫描 + 引用递归两条一起上：新加一个域文件却忘了接进命令表，
 * 这里会当场报出来（而那本来就是个真缺陷：写了域文件却不接，它一条命令都不会生效）。
 */
export function readCliChain(): string {
  const barrel = path.join(CLI_DIR, 'commands.ts')
  const seen = new Set<string>()
  const texts: string[] = []

  const walk = (file: string): void => {
    const abs = path.resolve(file)
    // 只跟命令链自己的文件：`../database/...` / `../../renderer/...` 一概不跟
    if (seen.has(abs) || !abs.startsWith(CLI_DIR + path.sep)) return
    let src: string
    try {
      src = readFileSync(abs, 'utf8')
    } catch {
      return // 目录、`.js` 后缀之类解析不中的一律跳过
    }
    seen.add(abs)
    texts.push(src)
    // `from './x'`（import / 再导出）与 `import('./x')`（内联类型表达式）都跟
    for (const m of src.matchAll(/(?:from|import)\s*\(?\s*'(\.[^']*)'/g)) {
      const resolved = path.resolve(path.dirname(abs), m[1])
      walk(resolved.endsWith('.ts') ? resolved : `${resolved}.ts`)
    }
  }

  walk(barrel)

  if (seen.size < 10) {
    throw new Error(
      `命令链只读到 ${seen.size} 个文件（至少该有 10 个）—— 门面或引用写法变了？` +
        '此时 readCliChain() 少读了源码，所有"扫源码"的闸门都会静默变绿。'
    )
  }
  const missing = readdirSync(DOMAIN_DIR)
    .filter((f) => f.endsWith('.ts'))
    .filter((f) => !seen.has(path.join(DOMAIN_DIR, f)))
  if (missing.length) {
    throw new Error(
      `命令链没读到 ${missing.join(' / ')} —— 域文件必须接进命令表（` +
        '`command-table.ts` 里 import 它、并把它 spread 进 `commands`），' +
        '否则那些命令根本不会生效，而扫源码的闸门也会漏读它。'
    )
  }
  return texts.join('\n')
}
