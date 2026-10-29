import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 零 emoji 规范覆盖 CLI（1.0.49，修 c3a798c8）
 *
 * ── 为什么 CLI 也要管 ──
 *
 * 产品原则第七条写「全界面禁 emoji（硬规范）」，设计原则又写明
 * 「**CLI 是第二用户界面**」（1.0.48 专门同步过 6 处 CLI 指路文案，
 * 理由正是这句）。两句合起来，规范本应覆盖 CLI —— 但实测漏了 9 处，
 * 全在 CLI 输出层。
 *
 * 其中 `output.ts` 的 notice 前缀最不该留：它是 agent 读 CLI 输出时
 * **最先看到**的位置，而 `⚠` 是双宽字符，终端里宽度不稳定，
 * 对按列对齐解析的调用方也不友好。
 *
 * ── 判据为什么按"行是不是注释"分 ──
 *
 * 源码注释里的 emoji（约 53 处）**不影响任何人**：它们只出现在开发者
 * 读代码时，不进入任何输出通道。把它们一并清掉是纯噪音改动，
 * 还会让"这条注释在强调什么"的视觉线索消失。
 * 真正要守的是**用户可见**：CLI 输出、错误文案、schema 描述。
 *
 * 所以这道闸门只扫非注释行。
 */

const SRC = path.resolve(__dirname, '../../../src')

/** 命令链上的文件：`src/main/cli` 下的 `command-*.ts` 与 `commands/` 下的域文件（按目录派生） */
const CHAIN_FILES = [
  ...fs
    .readdirSync(path.join(SRC, 'main/cli'))
    .filter((f) => f.startsWith('command-') && f.endsWith('.ts'))
    .map((f) => `main/cli/${f}`),
  ...fs
    .readdirSync(path.join(SRC, 'main/cli/commands'))
    .filter((f) => f.endsWith('.ts'))
    .map((f) => `main/cli/commands/${f}`)
]

/** 输出层的文件 —— CLI 是第二用户界面，这些文件里的字面量会直接给人/agent 看 */
const CLI_FILES = [
  'main/cli/output.ts',
  'main/cli/agent-guide.ts',
  'main/cli/commands.ts',
  // 命令链上的模块同样是"输出层"：里面的字面量会随 schema / help / 错误文案
  // 直接给人或 agent 看。1.0.112（卡 bbeb1b51）按内聚区拆成 6 个模块，之后
  // （卡 d1b71d28）命令表又按业务域拆进 `commands/` —— **按目录派生**，再拆一层
  // 这里自动跟上。手写清单迟早会漏一个，而漏掉那个文件里的 emoji 就没人管了
  // （"少读只会让闸门变绿"，比变红坏）。
  ...CHAIN_FILES,
  'main/cli/run.ts',
  // 数据表也在输出层：`gates: GATES` / `errorCodes: ERROR_CODES` 会整段进 `dp schema`
  // （c3a798c8 之后的实际回归点：G10 的 notes 里混进过 ⚠️，当时这份清单没扫到 gates.ts）
  'main/cli/gates.ts',
  'main/cli/error-codes.ts'
]

const EMOJI =
  /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2705}\u{274C}\u{26A0}\u{2139}\u{2714}\u{2716}]/gu

/** 是不是注释行：整行以 `*`（块注释续行）/ `//` / `/*` 开头 */
const isCommentLine = (line: string): boolean => {
  const t = line.trim()
  return t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')
}

describe('零 emoji 规范覆盖 CLI 输出层', () => {
  it('CLI 输出层不得出现用户可见的 emoji', () => {
    const hits: string[] = []
    const missing: string[] = []
    for (const rel of CLI_FILES) {
      const full = path.join(SRC, rel)
      // 路径写错 / 文件被改名时必须报出来 —— 静默 continue 会让闸门变成永远绿的假闸门
      if (!fs.existsSync(full)) {
        missing.push(rel)
        continue
      }
      fs.readFileSync(full, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (isCommentLine(line)) return
          if (EMOJI.test(line)) hits.push(`${rel}:${i + 1}  ${line.trim().slice(0, 80)}`)
        })
    }
    expect(missing, `清单里的文件不存在 —— 扫不到文件等于没扫：\n${missing.join('\n')}`).toEqual([])
    expect(
      hits,
      `CLI 输出层出现了用户可见的 emoji：\n${hits.join('\n')}\n\n` +
        `产品原则第七条是「全界面禁 emoji」，而设计原则写明「CLI 是第二用户界面」——\n` +
        `规范覆盖 CLI。请改用 ASCII 标记（\`[!]\`）或直接写文字（\`注意：\`）。`
    ).toEqual([])
  })

  it('闸门本身有效：能识别出被塞进输出层的 emoji（防止正则失效假通过）', () => {
    /**
     * 这道自检很重要：如果哪天正则写错、或文件路径变了导致扫不到文件，
     * 上面那条断言会**静默变成永远通过** —— 闸门存在但没用。
     * 这里用一行已知含 emoji 的字符串验证判据真的能命中。
     */
    expect(EMOJI.test("const x = '⚠ 提醒'")).toBe(true)
    expect(EMOJI.test("const x = '[!] 提醒'")).toBe(false)
    expect(isCommentLine(' * ⚠️ 注释里的不管')).toBe(true)
    expect(isCommentLine("const a = '⚠'")).toBe(false)
  })
})
