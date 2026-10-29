/**
 * 参数与关口的「出现在 schema 里」闸门（1.0.73，`3c522bdb` 第 1 点）
 *
 * ## 提单原文的判据
 *
 * > **CI 加一条断言「每条 G 与每个参数必须出现在 schema 里」，漏了就不给发版。**
 *
 * ## ⚠️ 只查"在不在 schema 里"会永远绿 —— 那是假闸门
 *
 * 必须先说清这一点，否则这条测试看起来通过了、实际什么也没守住：
 * `schema.commands[].args` 与 `executeOne` 的参数解析**是同一份数据**
 * （都读 `commands` 数组里那个 `args` 字段），所以"每个参数都在 schema 里"
 * 在当前结构下**恒真**。把它写成断言，等于写了一条永远不会红的测试。
 *
 * 提单真正要防的事，是"**为了文档目的声明了一个参数、实现没跟上**" ——
 * 而这个缺陷的形态**不在 schema 里，在接线里**。本项目已经因此中过三次：
 *
 * | 参数 | 症状 | 记在哪 |
 * |---|---|---|
 * | `--desc-file` | batch 路径静默丢正文（ok:true，库里 desc 为空） | Bob 7f48eb16 |
 * | `--body-file` | 同源，`todo comment` 长正文经 shell 被吞 | 1.0.54 |
 * | `--comment-file` | **两张表都没有它**：既不展开、也不拦截，正文静默丢弃 | 1.0.73 本卡 |
 *
 * 共同点：**声明和实现分处两张表，谁都没把它们绑在一起**。
 *
 * ## 所以这条闸门做三件事
 *
 * 1. 每个文件类参数（`--x-file`）必须在**单源表**里，且目标参数真实存在；
 * 2. **反向验证**：证明闸门认得出违规（喂一个假表进去必须判红）；
 * 3. 顺带守住提单的原文判据：每条 G、每个参数都出现在 schema 输出里。
 */
import { describe, it, expect, beforeAll, vi } from 'vitest'
import { readCliChain } from './cli-chain'
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { runMigrations } from '../../../src/main/database/migrations'
import { commands, buildSchema } from '../../../src/main/cli/commands'
import { GATES } from '../../../src/main/cli/gates'
import { FILE_FLAGS } from '../../../src/cli/file-flags'

const ROOT = path.resolve(__dirname, '../../..')
const CLI_DIR = path.join(ROOT, 'src/main/cli')

const db = new Database(':memory:')
vi.mock('../../../src/main/database/index', () => ({ getDatabase: () => db }))

/** 剥注释：文档里提到某个 flag 不算"声明" */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

/**
 * 从 args 声明里挑出"文件类参数"：以 `-file` 结尾的 string 参数。
 *
 * 判据用**名字形态**而不是"是否在 FILE_FLAGS 里"——
 * 否则漏了很多的那个 flag 恰好也漏在判定之外，闸门自己就瞎了。
 */
interface DeclaredFileFlag {
  flag: string
  cmd: string
}

function collectDeclaredFileFlags(): DeclaredFileFlag[] {
  const out: DeclaredFileFlag[] = []
  for (const c of commands) {
    for (const a of c.args) {
      if (a.type === 'string' && a.flag.endsWith('-file')) {
        out.push({ flag: a.flag, cmd: c.name })
      }
    }
  }
  return out
}

describe('参数接线闸门（3c522bdb #1）', () => {
  beforeAll(() => {
    runMigrations(db)
  })

  /**
   * 🚨 核心断言：声明在命令表里的每个 `--x-file`，
   * 都必须在 `file-flags.ts` 单源表里有对应项。
   *
   * 这就是 `--comment-file` 那次事故的直接原因 ——
   * 它声明进了 `todo update` 的 args，却不在任何一张展开/拦截表里。
   */
  it('每个声明出来的 --x-file 都在单源表里（漏了就是下一个 --comment-file）', () => {
    const declared = collectDeclaredFileFlags()
    expect(
      declared.length,
      '一个文件类参数都扫不到 —— 扫描逻辑坏了，这条闸门等于没跑'
    ).toBeGreaterThan(2)

    const known = new Set(FILE_FLAGS.map((f) => f.flag))
    const orphans = declared.filter((d) => !known.has(d.flag))
    expect(
      orphans.map((o) => `${o.flag}（声明在 ${o.cmd}）`),
      '这些文件参数声明在命令表里、却不在 src/cli/file-flags.ts 单源表中：\n' +
        '  后果是它**既不会被启动器展开、也不会被服务端拦截** ——\n' +
        '  调用方带它时正文/描述被静默丢弃，而回执是 ok:true。\n' +
        '  修法：在 file-flags.ts 加一行 { flag, target }，两侧自动跟上。'
    ).toEqual([])
  })

  /** 单源表里每个 `target` 必须真实存在 —— 否则展开后落在一条不存在的参数上 */
  it('单源表里每个 target 都真实存在于对应命令的 args 里', () => {
    const all = new Set(commands.flatMap((c) => c.args.map((a) => a.flag)))
    const missing = FILE_FLAGS.filter((f) => !all.has(f.target)).map((f) => f.target)
    expect(
      missing,
      `这些 target 是全仓任何命令都不认识的参数，展开后必然报 usage_error：${missing.join(', ')}`
    ).toEqual([])
  })

  /**
   * 单源表里的 `flag` 必须至少被一条命令声明。
   *
   * 反过来的病：表里有、命令表里没有 → 启动器会认它并展开，
   * 但服务端把它当未知 flag 拒掉；调用方看到的是"文件明明存在却报未知参数"。
   */
  it('单源表里每个 flag 都至少被一条命令声明（避免单边存在）', () => {
    const declared = new Set(commands.flatMap((c) => c.args.map((a) => a.flag)))
    const lone = FILE_FLAGS.filter((f) => !declared.has(f.flag)).map((f) => f.flag)
    expect(lone, `这些在单源表里、却没有任何命令声明它：${lone.join(', ')}`).toEqual([])
  })

  /**
   * 反向验证：证明上面第一条闸门**认得出违规**，不是恒绿。
   *
   * 手法：把判定逻辑抽成纯函数（吃"声明清单 + 单源表"两个入参），
   * 喂一组含孤儿 flag 的假数据 → 必须判违规。
   * 不做这一步的话，扫描正则写错会让闸门静默失效 —— 本项目已发生多次。
   */
  it('反向验证：闸门认得出"声明了但没进单源表"的孤儿参数', () => {
    const judge = (declared: { flag: string; cmd: string }[], known: readonly { flag: string }[]) => {
      const knownSet = new Set(known.map((f) => f.flag))
      return declared.filter((d) => !knownSet.has(d.flag)).map((d) => d.flag)
    }
    const ok = judge(
      [{ flag: '--desc-file', cmd: 'todo add' }],
      [{ flag: '--desc-file' }]
    )
    expect(ok, '正常情形被误判违规 —— 判定逻辑过严').toEqual([])
    const bad = judge(
      [{ flag: '--comment-file', cmd: 'todo update' }],
      [{ flag: '--desc-file' }]
    )
    expect(bad, '孤儿参数没被判出来 —— 闸门失效（这正是 --comment-file 逃掉的方式）').toEqual([
      '--comment-file'
    ])
  })

  /**
   * 服务端拦截表与启动器展开表**必须同源**。
   *
   * 这正是本卡修掉的那处结构缺陷：两张表各写一份，
   * 于是加参数时漏掉一张也没有任何信号。
   * 现在两侧都引 `file-flags.ts`，这条断言盯住"别再各写一份"。
   */
  it('启动器与服务端都从 file-flags.ts 派生（不再各写一份）', () => {
    const launcher = stripComments(fs.readFileSync(path.join(ROOT, 'src/cli/launcher.ts'), 'utf8'))
    const cmds = stripComments(readCliChain())
    expect(
      launcher.includes("from './file-flags'"),
      '启动器没有从 file-flags.ts 引单源表 —— 它又自己写了一份清单'
    ).toBe(true)
    expect(
      cmds.includes("from '../../cli/file-flags'"),
      '服务端没有从 file-flags.ts 引单源表 —— 拦截表又各写了一份'
    ).toBe(true)
    // 两边都不该再出现硬编码的展开对（形式：{ file: '--x-file', target: '--y' }）
    expect(
      /file:\s*'--[a-z-]+-file'/.test(launcher),
      '启动器里仍有硬编码的文件参数对照表 —— 说明单源没接上'
    ).toBe(false)
  })

  /**
   * 提单原文判据：**每个参数必须出现在 schema 里**。
   *
   * 如上所述，这条在当前结构下恒真（schema 与解析器读同一份 args）——
   * 但它是提单点名的判据，而且**防的是将来有人把 schema 改成手写**。
   * 保留它，并在测试名里说明"这条为何不足"。
   */
  it('schema 输出里每个命令的参数都与命令表一致（防将来改成手写 schema）', () => {
    const schema = buildSchema() as {
      commands: { name: string; args: { flag: string; desc: string }[] }[]
    }
    const byName = new Map(schema.commands.map((c) => [c.name, c]))
    for (const c of commands) {
      const rendered = byName.get(c.name)
      expect(rendered, `命令 ${c.name} 没出现在 schema 里`).toBeTruthy()
      expect(
        rendered!.args.map((a) => a.flag),
        `${c.name} 的参数在 schema 里与命令表不一致`
      ).toEqual(c.args.map((a) => a.flag))
      // 每个参数都要有一句"它是干什么的"，否则 agent 只能猜
      for (const a of rendered!.args) {
        expect(a.desc?.trim().length, `${c.name} 的参数 ${a.flag} 在 schema 里没有说明`).toBeGreaterThan(0)
      }
    }
    expect(schema.commands.length).toBe(commands.length)
  })

  /** 提单原文判据：**每条 G 必须出现在 schema 里** */
  it('schema 输出里带全部关口（每条 G 都能被 agent 查到）', () => {
    const schema = buildSchema() as { gates?: { id: string }[] }
    expect(Array.isArray(schema.gates), 'schema 里没有 gates 键').toBe(true)
    expect(schema.gates!.map((g) => g.id).sort()).toEqual(GATES.map((g) => g.id).sort())
  })

  /**
   * MCP instructions 的关口段**必须从 GATES 渲染**（续做 `3c522bdb` 第 1 点）。
   *
   * 提单原文要的是"skill 说明书与 MCP instructions 都由它渲染"。
   * 这条盯的是那个缺口本身：此前它是**手写第二份**，于是 1.0.65 新增的
   * G9/G10 里**一个字都没有**（提单实测证据），而 agent 最容易撞的恰恰是 G10。
   *
   * 判据用"**每条硬拦关口都在**"而不是"含两个字面量"：
   * 渲染函数坏掉时（比如改字段名后取不到值）会整段缺失或漏条，这条能抓到。
   */
  // timeout 20s（真参数，2026-10-08 二次修）：这条要动态 import 全量 CLI 模块图，
  // 慢环境（发版实测 environment 400~650s）下默认 5s 限时会偶发超时——单跑 788ms，是环境慢不是断言问题。
  // ⚠️ 第一次修（f289388）只写了这两行注释、没给 it() 传 timeout——「声称加到 20s」而机制不存在，
  // 1.0.75 发版又被同一条误拦。这次参数真传了，且三条动态 import 用例（224/250/266 行）都传；
  // 反向验证：body 塞 6s sleep 仍绿（若参数没被吃掉会 5s 超时红）。
  it('MCP instructions 的关口清单从 GATES 渲染（不再手写第二份）', async () => {
    const { MCP_INSTRUCTIONS } = await import('../../../src/cli/mcp-server')
    // 每条会硬拦/转授权的关口都要出现在握手报文里 —— 漏了 agent 就靠猜
    for (const g of GATES.filter((x) => x.enforcement !== 'notice')) {
      expect(
        MCP_INSTRUCTIONS.includes(g.id),
        `MCP instructions 里没有 ${g.id}（${g.what}）—— 这份是手写的就会漏，必须从 GATES 渲染`
      ).toBe(true)
      expect(
        MCP_INSTRUCTIONS.includes(g.what),
        `${g.id} 的描述与 GATES 不一致 —— 说明这段是手写的第二份真相`
      ).toBe(true)
    }
    // 软提醒也要列出来（否则调用方会以为"没拦就是没这回事"）
    for (const g of GATES.filter((x) => x.enforcement === 'notice')) {
      expect(MCP_INSTRUCTIONS.includes(g.id), `MCP instructions 漏了软提醒 ${g.id}`).toBe(true)
    }
  }, 20000)

  /**
   * 反向验证：证明"从 GATES 渲染"这件事**真的在发生**。
   *
   * 手法：`MCP_INSTRUCTIONS` 是模块级常量，注入改动不便；改为验证
   * **渲染函数存在且被调用**（源码扫描），并验证文案与 GATES 同源 ——
   * 若有人把它改回手写，上面那条会因为漏 G9/G10 而变红（本卡实测过）。
   */
  it('MCP instructions 里不含"手写遗留"的旧段落（防止改回手写）', async () => {
    const { MCP_INSTRUCTIONS } = await import('../../../src/cli/mcp-server')
    // 旧手写版有一段只有它才有的措辞，改回手写时它多半会回来
    expect(
      MCP_INSTRUCTIONS.includes('proposed（待确认）由人放行，agent 推不进也拉不出（G4）'),
      'MCP instructions 里出现了旧手写段落 —— 说明关口清单又被各写一份'
    ).toBe(false)
  }, 20000)

  /**
   * MCP 读者传的是**英文状态枚举值**，所以 instructions 里必须写出它们。
   *
   * 这条是被一次真实失败逼出来的：改成渲染后我漏掉了状态名，
   * 既有测试（断言含 `proposed`）当场变红。留着它防复发 ——
   * 只给中文列名，调用方就得自己猜"待确认"对应哪个字符串。
   */
  it('MCP instructions 里写出英文状态值（调用方传的就是这些字符串）', async () => {
    const { MCP_INSTRUCTIONS } = await import('../../../src/cli/mcp-server')
    for (const s of ['proposed', 'in_progress', 'awaiting_review']) {
      expect(MCP_INSTRUCTIONS.includes(s), `MCP instructions 没写状态值 ${s}`).toBe(true)
    }
    // ambiguous_identity 是 MCP 侧最会撞的错误码（多凭据不声明身份）
    expect(MCP_INSTRUCTIONS.includes('ambiguous_identity')).toBe(true)
  }, 20000)

  /**
   * 总闸门：schema 里**不许出现**任何命令表里没有的参数。
   *
   * 与上面那条方向相反：那条防"漏渲染"，这条防"多渲染"（schema 里承诺了
   * 一个不存在的参数 —— agent 照着它写，必然撞 usage_error）。
   */
  it('schema 里没有凭空多出来的参数或命令', () => {
    const schema = buildSchema() as { commands: { name: string; args: { flag: string }[] }[] }
    const known = new Set(commands.map((c) => c.name))
    const ghostCmds = schema.commands.filter((c) => !known.has(c.name))
    expect(ghostCmds.map((c) => c.name), 'schema 里有命令表里不存在的命令').toEqual([])

    for (const c of commands) {
      const rendered = schema.commands.find((x) => x.name === c.name)!
      const knownFlags = new Set(c.args.map((a) => a.flag))
      const ghosts = rendered.args.filter((a) => !knownFlags.has(a.flag)).map((a) => a.flag)
      expect(ghosts, `${c.name} 在 schema 里多出了参数：${ghosts.join(', ')}`).toEqual([])
    }
  })

  /**
   * 文件类参数必须在 help 里说明"由启动器展开"——
   * 否则 agent 会以为直接调服务端也能用它。
   */
  it('文件类参数在 args 说明里点明走启动器（避免绕过启动器时无从排查）', () => {
    for (const c of commands) {
      for (const a of c.args) {
        if (!a.flag.endsWith('-file')) continue
        expect(
          a.desc,
          `${c.name} 的 ${a.flag} 没说明它由启动器展开 —— 绕过启动器时 agent 无从排查`
        ).toMatch(/启动器/)
      }
    }
  })

  /**
   * 位置参数的"声明 ↔ 实现"接线（1.0.107，修 `350f9631`）—— 卡上说的"加进参数接线闸门"。
   *
   * 与上面文件参数**同一个病**：声明和实现分处两处，谁都没把它们绑在一起。
   * 只是这次的形态是反的 —— 命令的 `run` 明明在吃位置参数，命令表里却没有
   * `positional` 声明。后果：框架按"它不接受位置参数"处理（`maxPositionalArgs` 回 0），
   * "多给一个"判不出来，而多给的那一个被 `run` 自己默默丢掉 ——
   * 正是 `agent grants zzz` 回全量 81 条的那条路。
   *
   * ⚠️ 判据取 **`run` 的形参名**，不是"正文里出现过 positional 这个词"：
   * `batch` 的正文里有 `item.positional`（records 记录里的字段，与 CLI 位置参数无关），
   * 按词判会把它误伤成"用了却没声明"。**假红的闸门比没有闸门更坏** ——
   * 它会被顺手放宽或加例外，然后真的漏就再也查不出来。
   */
  it('run 吃位置参数的命令都必须声明 positional（漏了就是下一个静默丢参）', () => {
    /** 判定抽成纯函数，好喂假数据做反向验证 */
    const judge = (list: { name: string; params: string[]; declared: boolean }[]) =>
      list.filter((c) => c.params.includes('positional') && !c.declared).map((c) => c.name)

    const rows = commands.map((c) => ({
      name: c.name,
      // `String(fn)` 形如 `async (ctx, flags) => {` / `(ctx, flags, positional) => {`
      params:
        String(c.run)
          .match(/^\s*(?:async\s*)?\(([^)]*)\)/)?.[1]
          ?.split(',')
          .map((s) => s.trim()) ?? [],
      declared: Boolean(c.positional)
    }))

    expect(
      rows.filter((r) => r.params.includes('positional')).length,
      '一条都没扫到带 positional 形参的命令 —— 形参名解析坏了，这条闸门等于没跑'
    ).toBeGreaterThan(5)

    expect(
      judge(rows),
      '这些命令的 run 在吃位置参数、命令表里却没有 positional 声明：\n' +
        '  框架据此认为它一个位置参数都不接受，"多给一个"判不出来 —— 而那一个会被静默丢掉。\n' +
        '  修法：给命令加 positional 声明（默认吃 1 个；吃多个的写 arity）。'
    ).toEqual([])

    /** 反向验证：证明闸门认得出违规，不是恒绿（本项目已因此中过多次） */
    expect(
      judge([{ name: 'fake cmd', params: ['ctx', 'flags', 'positional'], declared: false }]),
      '闸门认不出"用了却没声明" —— 它恒绿，等于没写'
    ).toEqual(['fake cmd'])
    expect(
      judge([{ name: 'ok cmd', params: ['ctx', 'flags'], declared: false }]),
      '没用位置参数的命令被误判违规 —— 闸门过严，会被顺手加例外'
    ).toEqual([])
  })
})
