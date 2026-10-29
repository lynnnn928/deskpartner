import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { runMigrations } from '../../../src/main/database/migrations'
import { TodoRepository } from '../../../src/main/database/todo.repository'
import { CategoryRepository } from '../../../src/main/database/category.repository'
import { ProjectRepository } from '../../../src/main/database/project.repository'
import { executeOne, commands, commandUsage, riskOf } from '../../../src/main/cli/commands'
import { formatHelp, formatOutcome } from '../../../src/main/cli/output'

const db = new Database(':memory:')
vi.mock('../../../src/main/database/index', () => ({
  getDatabase: () => db
}))

/**
 * agent 面向的可编程面有缺口（1.0.65 修 `1e525804`，Carol体验 02）
 *
 * G1：readOnly 填不全，且 `--help` 用 readOnly、`schema` 用 risk，两处不一致。
 * G2：batch 没有 dry-run。
 *
 * 共同的毛病是**"给调用方的那份说明书"自身不一致或不完整**：
 * agent 要靠它自动挑出"可以放心调"的命令集，它却两套口径、还有一个空档。
 * 而这类缺陷不会让任何命令报错 —— 调用方只是**默默地**选错。
 */
function makeCtx(over: Record<string, unknown> = {}) {
  return {
    deps: {
      todoRepo: new TodoRepository(),
      categoryRepo: new CategoryRepository(),
      projectRepo: new ProjectRepository(),
      memoRepo: { list: () => [], add: () => ({ id: 'm1' }), get: () => null },
      settingsRepo: { get: () => ({}) },
      agentRepo: {
        get: () => null,
        register: () => null,
        list: () => [],
        touch: () => null,
        setApproved: () => null,
        remove: () => null,
        issueCredential: () => null,
        verifyCredential: () => false,
        requestGrant: () => ({ id: 'g1' }),
        findUsableGrant: () => null,
        findAnyUsableGrant: () => null,
        findLatestGrant: () => null,
        consumeGrant: () => null,
        listGrants: () => [],
        revokeGrants: () => 0,
        getGrant: () => null,
        markWrite: () => null
      },
      events: { append: () => {} },
      telemetry: { record: () => {}, query: () => [], stats: () => null, clear: () => 0 }
    },
    meta: {
      version: '1.0.65',
      dbPath: ':memory:',
      schemaVersion: 25,
      busyTimeoutMs: 5000,
      channels: ['pipe'],
      via: 'pipe',
      startedAt: 0
    },
    /**
     * interactive:true = 人在终端敲。
     *
     * ⚠️ 判据说明：写命令在**非交互**下会撞身份关口（exit 4
     * identity_required，报"这次动作人会被记成 human"）——
     * 那是**正确行为**，而它会盖住 dry-run 想验的东西。
     * 这里要验的是"参数校验 + 不执行"，身份不是变量，所以按人处理。
     * 顺带留一条断言：非交互下的写命令仍要被身份关口拦住（见文件末）。
     */
    interactive: true,
    actor: 'human',
    ...over
  } as never
}

describe('G1：只读标记两处口径一致且有值（1e525804）', () => {
  it('每条命令的 readOnly 都得有明确 true/false，不许留空', () => {
    const missing = commands.filter((c) => typeof commandUsage(c).readOnly !== 'boolean')
    expect(missing.map((c) => c.name), '这些命令没有可用的只读标记').toEqual([])
  })

  it('schema 的 readOnly 与 risk 必须同源（不能一处读 risk、一处读 readOnly）', () => {
    const wrong = commands.filter((c) => commandUsage(c).readOnly !== (riskOf(c) === 'read'))
    expect(wrong.map((c) => c.name), '两处口径分叉了').toEqual([])
  })

  /**
   * ⚠️ 这条断言的是**真实 schema 输出**，不是 `commandUsage` 这个辅助函数。
   *
   * 踩过的坑：先前只测了 `commandUsage`，于是把 schema 里那份 `readOnly`
   * 删掉时 12 条用例**全绿** —— 因为两份输出是各自构造的，
   * 测一份不等于测了两份。而 schema 才是 agent 真正读的那份
   * （Carol的复现步骤就是"跑 schema 看只读标记"）。
   *
   * 判据：**验"调用方拿到的东西"，不验"我们调用的那个函数"**。
   * 中间隔了一层封装时，测内层会产生一种虚假的安全感。
   */
  it('真实 schema 输出里每条命令都带 readOnly，且与 risk 一致', async () => {
    const r = (await executeOne(makeCtx(), ['schema'])) as {
      ok: boolean
      data: { commands: { name: string; risk: string; readOnly?: unknown }[] }
    }
    expect(r.ok).toBe(true)
    const list = r.data.commands
    expect(list.length).toBe(commands.length)

    const missing = list.filter((c) => typeof c.readOnly !== 'boolean')
    expect(
      missing.map((c) => c.name),
      'schema 输出的 readOnly 必须是明确的 true/false，不能缺字段'
    ).toEqual([])

    const mismatched = list.filter((c) => c.readOnly !== (c.risk === 'read'))
    expect(
      mismatched.map((c) => c.name),
      'schema 的 readOnly 与 risk 口径不一致（agent 会据此选错命令）'
    ).toEqual([])
  })

  it('help <命令> 的输出也带 readOnly（另一条说明书路径）', async () => {
    const r = (await executeOne(makeCtx(), ['help', 'todo', 'rm'])) as {
      ok: boolean
      data: { readOnly?: unknown; risk?: string }
    }
    expect(r.ok).toBe(true)
    expect(typeof r.data.readOnly).toBe('boolean')
    expect(r.data.readOnly).toBe(false)
    expect(r.data.risk).toBe('destructive')
  })

  /**
   * ⚠️ 同一个 bug 的**第三处**（1.0.72 补，Carol两次驳回都是对的）
   *
   * 1.0.65 修了 `schema`，后来修了 `help <命令名>`，
   * 而**无参数 `help` 的清单**一直是 `map(c => ({name, desc}))` —— 字段压根没有。
   * 顶层清单是 agent 最常看的那一份（先扫一眼有哪些命令），它却整份缺字段。
   *
   * 前两轮为什么都没抓到：每次只测了自己刚动过的那条路径。
   * 判据落在这里：**一份语义有几个出口，就断言几个出口，
   * 且断言的对象是"调用方真正拿到的那份数据"**（不是我们调用的那个函数）。
   */
  it('help（无参数）的顶层清单里每条命令都带 readOnly 与 risk —— 第三处出口', async () => {
    const r = (await executeOne(makeCtx(), ['help'])) as {
      ok: boolean
      data: { commands: { name: string; risk?: unknown; readOnly?: unknown }[] }
    }
    expect(r.ok).toBe(true)
    const list = r.data.commands
    expect(list.length).toBe(commands.length)

    const missing = list.filter((c) => typeof c.readOnly !== 'boolean' || typeof c.risk !== 'string')
    expect(
      missing.map((c) => c.name),
      'help 顶层清单的只读标记/风险档必须是明确的值，不能缺字段（缺失与 false 不是一回事）'
    ).toEqual([])
  })

  /**
   * 反向判据：**三个出口必须同源**，不是"各自都有"就够。
   *
   * 只断言"字段存在"仍可能漏掉一种坏法：某处自己写了一套推导，
   * 字段有值但与 `riskOf` 分叉 —— 那正是本卡最初要消灭的"两处口径"。
   * 这条把三处逐命令对齐，任何一处改了推导方式都会红。
   */
  it('三个出口（schema / help 单条 / help 清单）的只读标记逐条一致', async () => {
    const schemaOut = (await executeOne(makeCtx(), ['schema'])) as {
      data: { commands: { name: string; risk: string; readOnly: boolean }[] }
    }
    const helpList = (await executeOne(makeCtx(), ['help'])) as {
      data: { commands: { name: string; risk: string; readOnly: boolean }[] }
    }

    const byName = (xs: { name: string; risk: string; readOnly: boolean }[]) =>
      new Map(xs.map((c) => [c.name, c]))

    const s = byName(schemaOut.data.commands)
    const h = byName(helpList.data.commands)

    expect(h.size, 'help 清单条数与 schema 不一致').toBe(s.size)

    const diverged: string[] = []
    for (const [name, sc] of s) {
      const hc = h.get(name)
      if (!hc) {
        diverged.push(`${name}（help 清单里没有）`)
        continue
      }
      if (hc.readOnly !== sc.readOnly || hc.risk !== sc.risk) {
        diverged.push(`${name}（schema: ${sc.readOnly}/${sc.risk} vs help: ${hc.readOnly}/${hc.risk}）`)
      }
      // 再钉一层：三处都必须与门禁用的 riskOf 同源
      const cmd = commands.find((c) => c.name === name)
      if (!cmd) continue
      const truth = riskOf(cmd)
      if (sc.readOnly !== (truth === 'read') || hc.readOnly !== (truth === 'read')) {
        diverged.push(`${name}（与 riskOf=${truth} 不一致）`)
      }
    }
    expect(diverged, '三个出口的只读口径分叉了').toEqual([])
  })

  it('读命令为 true、写/删/改界面为 false', () => {
    const expect_: Record<string, boolean> = {
      'todo list': true,
      'project list': true,
      'agent grants': true,
      'schema': true,
      'todo add': false,
      'project rm': false,
      'ui set': false,
      'todo rm': false
    }
    for (const [name, want] of Object.entries(expect_)) {
      const cmd = commands.find((c) => c.name === name)
      expect(cmd, `命令 ${name} 不存在（测试该跟着命令表走）`).toBeTruthy()
      expect(commandUsage(cmd!).readOnly, `${name} 的只读标记`).toBe(want)
    }
  })

  it('commandUsage 同时给 risk，调用方不用再猜只读是怎么推出来的', () => {
    const cmd = commands.find((c) => c.name === 'todo rm')!
    const u = commandUsage(cmd)
    expect(u.risk).toBe('destructive')
    expect(u.readOnly).toBe(false)
  })
})

describe('G2：batch --dry-run 只校验不执行（1e525804）', () => {
  beforeAll(() => {
    runMigrations(db)
    db.pragma('foreign_keys = OFF')
  })

  beforeEach(() => {
    db.prepare('DELETE FROM todos').run()
    new CategoryRepository().create({ name: '默认分类', color: '#5388F6', sortOrder: 0 })
    new ProjectRepository().create({ name: '测试项目' })
  })

  const ndjson = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n')

  const run = async (rows: unknown[], extra: string[] = []) => {
    const ctx = makeCtx({ stdin: ndjson(rows) })
    return (await executeOne(ctx, ['batch', ...extra])) as {
      ok: boolean
      data?: { executed?: boolean; dryRun?: boolean; failed?: number; results?: unknown[] }
    }
  }

  it('dry-run 跑完不产生任何数据（这是它存在的全部意义）', async () => {
    const r = await run(
      [{ cmd: 'todo add', args: { '--title': 'dry-run 不该建出来', '--project': '测试项目' } }],
      ['--dry-run']
    )
    expect(new TodoRepository().list().filter((t) => t.title === 'dry-run 不该建出来'))
      .toHaveLength(0)
  })

  it('回执必须自报 executed:false（别让调用方误以为已经做完）', async () => {
    const r = await run(
      [{ cmd: 'todo add', args: { '--title': 'X', '--project': '测试项目' } }],
      ['--dry-run']
    )
    expect(r.data?.executed).toBe(false)
    expect(r.data?.dryRun).toBe(true)
  })

  it('参数写错照样能查出来（dry-run 的正事就是这个）', async () => {
    const r = await run([{ cmd: 'todo add', args: { '--project': '测试项目' } }], ['--dry-run'])
    expect(r.data?.failed).toBe(1)
    expect(JSON.stringify(r.data?.results)).toContain('--title')
  })

  it('不存在的命令也能查出来', async () => {
    const r = await run([{ cmd: 'todo gett' }], ['--dry-run'])
    expect(r.data?.failed).toBe(1)
  })

  it('不带 --dry-run 时照常真的执行（别把正常路径一起关掉）', async () => {
    const r = await run([{ cmd: 'todo add', args: { '--title': '真建了', '--project': '测试项目' } }])
    expect(r.ok).toBe(true)
    expect(new TodoRepository().list().filter((t) => t.title === '真建了')).toHaveLength(1)
  })

  it('dry-run 的标记不污染后续命令（同进程内不能一直"不执行"）', async () => {
    const ctx = makeCtx({
      stdin: ndjson([{ cmd: 'todo add', args: { '--title': '第一条', '--project': '测试项目' } }])
    })
    await executeOne(ctx, ['batch', '--dry-run'])
    // 同一个 ctx 再跑一条单命令：必须真的执行
    await executeOne(ctx, ['todo', 'add', '--title', '第二条', '--project', '测试项目'])
    expect(new TodoRepository().list().filter((t) => t.title === '第二条')).toHaveLength(1)
  })

  it('--doc 里要提到 dry-run，否则 agent 发现不了（能力没被写在说明书上等于没有）', async () => {
    const r = (await executeOne(makeCtx(), ['batch', '--doc'])) as {
      data: { dryRun?: string }
    }
    expect(r.data.dryRun, 'batch --doc 没提 dry-run').toBeTruthy()
    expect(r.data.dryRun).toContain('--dry-run')
  })

  /**
   * 写这组用例时撞上的事实，单独锁住 —— 它当时把 4 条用例全盖住了。
   *
   * 非交互（agent / 脚本）下的写命令会撞身份关口：exit 4
   * `identity_required`，理由是"这次动作人会被记成 human"。
   * 这是**正确行为**，但它发生在参数校验之后、dry-run 刹车点之前，
   * 于是 dry-run 在无人值守场景下先报身份、根本走不到"不执行"。
   *
   * 对 agent 来说这不是缺陷：它本来就该持证调用。
   * 但值得钉住的是"**dry-run 不放松身份关口**"——
   * 一旦有人为了"让 dry-run 更好用"而在刹车点前跳过门禁，
   * dry-run 就变成了一个"不问权限也能过"的旁路，那比不做更糟。
   */
  it('dry-run 不放松身份关口（无人值守下仍报身份，而不是放行）', async () => {
    const ctx = makeCtx({
      interactive: false,
      stdin: ndjson([{ cmd: 'todo add', args: { '--title': 'X', '--project': '测试项目' } }])
    })
    const r = (await executeOne(ctx, ['batch', '--dry-run'])) as {
      ok: boolean
      errorCode?: string
      message?: string
    }
    expect(r.ok).toBe(false)
    /**
     * ⚠️ 判据的**位置**变了，结论没变（`ce0ea82f` 之后）。
     *
     * 此前 batch 声明成只读，于是它自己先过门禁，身份关口落在那一条写行上
     * ——`batch_all_failed` + 行内 `identity_required`。
     * 现在 batch 属写档，无人值守没身份时**它自己就被拦下**，
     * 所以这里是外层的 `identity_required`。
     *
     * 这条用例要守的东西没变，而且守得更早：**dry-run 不是绕开权限的旁路**。
     * 真去掉了门禁，这里拿到的会是 `batch_all_failed`（行内报错）甚至 ok ——
     * 无论哪种都会红。
     */
    expect(r.errorCode, `实际：${r.message}`).toBe('identity_required')
    expect(new TodoRepository().list().filter((t) => t.title === 'X')).toHaveLength(0)
  })
})

/**
 * D1/D2：失败信封的形状不一致（1.0.65 修 `10fcb47f`）
 *
 * Carol实测：同一个 batch 里，走 executeOne 的失败行有 `errorCode`
 * （not_found / usage_error / grant_required），而 JSON 解析失败、缺 cmd
 * 那两行**只有数字 code、没有 errorCode**。
 *
 * 后果：调用方按 `results[i].errorCode` 过滤以分流时，
 * 解析失败的那几行**静默漏掉** —— 不报错，只是少处理一条。
 * 判据：**失败信封的形状必须一致**，否则"按 code 分流"这个动作本身
 * 就得写两遍，而漏掉的那遍不会报错。
 */
describe('失败信封形状一致（10fcb47f D1/D2）', () => {
  beforeAll(() => {
    runMigrations(db)
    db.pragma('foreign_keys = OFF')
  })

  beforeEach(() => {
    db.prepare('DELETE FROM todos').run()
    new CategoryRepository().create({ name: '默认分类', color: '#5388F6', sortOrder: 0 })
    new ProjectRepository().create({ name: '测试项目' })
  })

  const runBatch = async (stdinText: string) =>
    (await executeOne(makeCtx({ stdin: stdinText, interactive: true }), ['batch'])) as {
      ok: boolean
      data?: { results?: { ok: boolean; code?: unknown; errorCode?: unknown }[] }
    }

  it('JSON 解析失败的那一行也要带 errorCode', async () => {
    const r = await runBatch('{ 这不是 JSON\n{"cmd":"todo list"}')
    const row = r.data!.results![0]
    expect(row.ok).toBe(false)
    expect(row.errorCode, '解析失败行缺 errorCode → 按 code 分流会漏掉它').toBeTruthy()
    expect(typeof row.errorCode).toBe('string')
  })

  it('缺 cmd 的那一行也要带 errorCode', async () => {
    const r = await runBatch('{"args":{"--title":"没有 cmd"}}')
    const row = r.data!.results![0]
    expect(row.errorCode).toBeTruthy()
    expect(typeof row.errorCode).toBe('string')
  })

  it('直连与 batch 的同一失败给出同一个 errorCode（口径一致）', async () => {
    const direct = (await executeOne(
      makeCtx({ interactive: true }),
      ['todo', 'get', 'deadbeef']
    )) as { ok: boolean; errorCode?: string }

    const r = await runBatch('{"cmd":"todo get","positional":["deadbeef"]}')
    const row = r.data!.results![0]

    expect(direct.ok).toBe(false)
    expect(row.errorCode, 'batch 里的同一条失败与直连口径必须一致').toBe(direct.errorCode)
  })

  /**
   * ⚠️ 这条断言在 1.0.72 **被改了方向**（Carol两次驳回 `10fcb47f` D2）
   *
   * 原文断言 `typeof row.code === 'number'` —— 它把"行内 code 是数字退出码"
   * 当成正确形状钉死了。**那正是被驳回的形状**：
   * 一份回执里 `code` 在顶层是字符串（`not_found`）、在行内是数字（3），
   * 脚本 `if (code === 'not_found')` 在 batch 里永远不成立。
   *
   * 所以不是代码改错了、也不是这条测试写错了，
   * 而是**它固化的是旧契约**。Carol的驳回意见优先于旧断言 ——
   * 判据：测试是契约的看守人，但**契约本身被验收方改过时，看守人要跟着改**，
   * 否则闸门会把正确的实现判成错。
   *
   * 新契约（三处同一形状）：`code` 一律字符串错误码，
   * 数字退出码另存 `exitCode`（名字说清它是什么），`errorCode` 保留（1.0.65 已认可）。
   */
  it('batch 里每一行失败的 code 都是字符串错误码（不再有裸数字）', async () => {
    const r = await runBatch(
      '{ 坏 JSON\n{"args":{}}\n{"cmd":"todo get","positional":["deadbeef"]}\n{"cmd":"todo gett"}'
    )
    const rows = r.data!.results!
    for (const [i, row] of rows.entries()) {
      expect(row.ok, `第 ${i} 行应当是失败的`).toBe(false)
      expect(typeof row.code, `第 ${i} 行 code 必须是字符串错误码（与直连同构）`).toBe('string')
      expect(typeof row.errorCode, `第 ${i} 行缺 errorCode`).toBe('string')
      expect(typeof row.exitCode, `第 ${i} 行缺 exitCode（数字退出码另存这里）`).toBe('number')
      // 关键：code 与 errorCode 现在必须一致 —— 此前它们一个是数字一个是字符串
      expect(row.code, `第 ${i} 行 code 与 errorCode 不一致`).toBe(row.errorCode)
    }
  })

  /**
   * 反向判据：直连与 batch 的**同一失败**，`code` 必须逐字相同。
   *
   * 这条直接对应Carol的驳回原话「两套码，脚本无法用同一分支处理」。
   * 上面那条钉形状，这条钉**跨路径相等** —— 形状对了但值仍可能分叉。
   */
  it('直连与 batch 同一失败：code 逐字相同（不是同族，是同一个值）', async () => {
    const direct = (await executeOne(makeCtx({ interactive: true }), [
      'todo',
      'get',
      'deadbeef'
    ])) as { ok: boolean; errorCode?: string }

    const r = await runBatch('{"cmd":"todo get","positional":["deadbeef"]}')
    const row = r.data!.results![0]

    expect(direct.ok).toBe(false)
    expect(row.code, 'batch 行内的 code 与直连不是同一个值 → 按 code 分流的脚本会漏').toBe(
      direct.errorCode
    )
  })

  /**
   * 顶层信封也要能回答"第一条为什么失败"，否则只看顶层的调用方必须下钻。
   *
   * 顶层 `code` 仍是 `batch_all_failed`（这批整体失败的结论，保留）；
   * `firstFailure` 给第一条的原因。**不把顶层 code 改成第一条的原因** ——
   * 那会丢掉"整批失败、该不该重试整批"这个信息。
   */
  it('全败时顶层带 firstFailure（只看顶层也能分流）', async () => {
    const r = await runBatch('{"cmd":"todo get","positional":["deadbeef"]}')
    expect(r.ok).toBe(false)
    expect(r.errorCode).toBe('batch_all_failed')
    const ff = (r as { firstFailure?: { code?: unknown; message?: unknown } }).firstFailure
    expect(ff, '顶层缺 firstFailure').toBeTruthy()
    expect(typeof ff!.code, 'firstFailure.code 必须是字符串').toBe('string')
    expect(ff!.code).toBe('not_found')
  })
})

/**
 * G1 第四处出口：顶层 `--help` / `-h` / 无参数（1.0.75 修，Carol三次驳回同一处）
 *
 * 前三处（schema / help 单条 / help 清单）上面已锁。第四处是**顶层 `--help`** ——
 * 它不走 `help` 命令，而是两个通道各自拼一份、还拼得不一样：
 * 无头 run.ts 拼 name+desc 简表、管道 cli-server.service.ts 倒整个命令对象，
 * 于是同一个 `--help` 两种输出、readOnly/risk 残缺（Carol实测 50 条里 28 条整段缺 readOnly）。
 *
 * 判据升级：**顶层 `--help` 不许自己持有命令清单** —— 转发 `help` 取数。
 * 断言分两层：
 * 1. 源码层：两个通道都必须转发 `executeOne(…, ['help'])`，不许把命令表喂给 formatHelp
 *    （旧的两种拼法都会被这条抓住 —— 这是"某个通道又自己拼一份"的唯一可能入口）；
 * 2. 输出层：formatHelp 的机读输出与 `dp help` **逐字节一致**（同源的最强形式），
 *    TTY 输出里每条命令都带风险档。
 */
describe('G1 第四处：顶层 --help/-h 与 help 同源（1e525804）', () => {
  const ROOT = path.resolve(__dirname, '../../..')

  it('两个通道的顶层 --help 都转发 help 命令，不许各自拼清单（源码闸门）', () => {
    const targets: [string, string][] = [
      ['无头 run.ts', fs.readFileSync(path.join(ROOT, 'src/main/cli/run.ts'), 'utf8')],
      [
        '管道 cli-server.service.ts',
        fs.readFileSync(path.join(ROOT, 'src/main/services/cli-server.service.ts'), 'utf8')
      ]
    ]
    for (const [label, src] of targets) {
      expect(src, `${label} 顶层 --help 必须转发 \`help\` 命令取数据`).toMatch(
        /formatHelp\(\s*await executeOne\([^,]+,\s*\['help'\]\s*\)/
      )
      expect(
        src,
        `${label} 不许再把命令表直接喂给 formatHelp（1.0.75 修前的两种拼法都算）`
      ).not.toMatch(/formatHelp\(\s*commands/)
    }
  })

  it('顶层 --help 的机读输出与 dp help 逐字节一致（同源最强形式）', async () => {
    const outcome = await executeOne(makeCtx(), ['help'])
    expect(outcome.ok).toBe(true)
    const viaFormatHelp = formatHelp(outcome, ['--help'], false)
    const viaHelpCommand = formatOutcome(outcome, ['help'], false)
    expect(viaFormatHelp.stdout, '顶层 --help 与 dp help 的输出分叉了').toBe(viaHelpCommand.stdout)
    expect(viaFormatHelp.exitCode).toBe(viaHelpCommand.exitCode)
  })

  it('TTY 人读表里每条命令都在、都带风险档（人也要一眼看出哪条是写命令）', async () => {
    const outcome = (await executeOne(makeCtx(), ['help'])) as {
      ok: boolean
      data: { tip?: string; commands: { name: string; risk: string }[] }
    }
    const { stdout } = formatHelp(outcome as never, ['--help'], true)
    for (const c of outcome.data.commands) {
      expect(stdout, `TTY 输出缺命令 ${c.name}`).toContain(c.name)
    }
    expect(stdout, 'TTY 输出没有风险档标记').toMatch(/\[read\]/)
    expect(stdout, 'TTY 输出没有写风险档标记').toMatch(/\[(write|config|destructive)\]/)
    expect(stdout, 'TTY 输出要指向下一步（schema / help <命令名>）').toContain('schema')
  })
})
