/**
 * 错误码清单是唯一真相（1.0.73，续做 `3c522bdb` 第 2 点）
 *
 * ## 它治的病
 *
 * `errorCode` 是**调用方唯一能可靠分流的信号**：数字退出码只有 0~5 六档，
 * 而"守卫拒绝"（4）底下有七八种含义完全不同的事 ——
 * `identity_pending`（等批准）与 `identity_unregistered`（去注册）都是 4，
 * 但该做的事完全相反。它此前**只以字符串字面量散在代码各处**，schema 里一个都没有，
 * 于是 agent 只能按字面猜。
 *
 * ## 这份测试盯的是"会不会又漂"
 *
 * 抄一份到别处必然过期，而过期不会报错 —— 所以这里做的是**源码扫描**：
 * 凡是代码里真用了 `errorCode: 'x'` 而清单里没有的，当场失败。
 * 并且**做了反向验证**：证明这条闸门认得出违规，不是假绿。
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { ERROR_CODES, errorCodeById } from '../../../src/main/cli/error-codes'

const CLI_DIR = path.resolve(__dirname, '../../../src/main/cli')

/**
 * 剥掉注释与字符串模板里的"举例"文本 —— 否则文档注释里提到
 * `errorCode: 'xxx'` 也会被判成违规（本项目已踩过这个坑：
 * spawn-stdio 闸门第一版就是被自己的文档注释判红的）。
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

/** 扫出源码里所有 `errorCode: '<值>'` 的字面量 */
function collectUsedErrorCodes(): Map<string, string[]> {
  const used = new Map<string, string[]>()
  for (const f of fs.readdirSync(CLI_DIR)) {
    if (!f.endsWith('.ts')) continue
    // 清单本身与测试不算"使用方"（它就是在声明这些值）
    if (f === 'error-codes.ts') continue
    const src = stripComments(fs.readFileSync(path.join(CLI_DIR, f), 'utf8'))
    for (const m of src.matchAll(/errorCode:\s*'([a-z_]+)'/g)) {
      const code = m[1]
      if (!used.has(code)) used.set(code, [])
      used.get(code)!.push(f)
    }
  }
  return used
}

describe('错误码清单唯一真相（3c522bdb #2）', () => {
  it('schema 里带 errorCodes，且与清单条数一致', async () => {
    const { executeOne } = await import('../../../src/main/cli/commands')
    /**
     * 这里不 mock db：`schema` 命令在取元信息之前就返回了，
     * 但保险起见仍用最小 ctx（与 gates-single-source 同一手法）。
     */
    const r = (await executeOne({ deps: {}, meta: {}, flags: {} } as never, ['schema'])) as {
      ok: boolean
      data: { errorCodes?: { code: string }[] }
    }
    expect(r.ok).toBe(true)
    expect(
      Array.isArray(r.data.errorCodes),
      'schema 里没有 errorCodes 键 —— agent 拿到错误码时无从查证它是什么意思'
    ).toBe(true)
    expect(r.data.errorCodes!.length).toBe(ERROR_CODES.length)
  })

  /**
   * 🚨 核心闸门：代码里用到的每个 errorCode 都必须在清单里。
   *
   * 漏一个的后果不是报错，而是 agent 拿到一个 schema 里查不到的信号 ——
   * 它只能按字面猜，而猜错的方向往往正好是"重试还是别重试"。
   */
  it('源码里用到的每个 errorCode 都在清单里（扫描 + 剥注释）', () => {
    const used = collectUsedErrorCodes()
    expect(used.size, '一个 errorCode 都没扫到 —— 扫描逻辑坏了，这条闸门等于没跑').toBeGreaterThan(
      5
    )

    const declared = new Set(ERROR_CODES.map((e) => e.code))
    const missing = [...used.entries()]
      .filter(([code]) => !declared.has(code))
      .map(([code, files]) => `${code}（出现在 ${[...new Set(files)].join(', ')}）`)

    expect(
      missing,
      '这些 errorCode 在代码里用了、却不在 error-codes.ts 清单里 —— ' +
        'agent 拿到它会查不到含义，只能猜。请补进清单。'
    ).toEqual([])
  })

  /**
   * 反向验证：证明上面那条闸门**认得出违规**，而不是永远返回绿。
   *
   * 手法：喂一个假源码片段给同一套判定逻辑（把"扫描目录"换成"扫字符串"），
   * 含一个不在清单里的代号 → 必须判违规。
   * 不做这一步的话，闸门可能因为正则写错而静默失效（本项目已发生多次）。
   */
  it('反向验证：闸门认得出"用了但没声明"的 errorCode', () => {
    const fakeSrc = stripComments(`
      // 这是个注释，里面的 errorCode: 'it_is_a_comment' 不该被算进去
      return { errorCode: 'totally_made_up', message: 'x' }
    `)
    const found = [...fakeSrc.matchAll(/errorCode:\s*'([a-z_]+)'/g)].map((m) => m[1])
    expect(found).toEqual(['totally_made_up'])
    const declared = new Set(ERROR_CODES.map((e) => e.code))
    expect(declared.has('totally_made_up'), '假代号竟然在清单里 —— 反向验证失效').toBe(false)
  })

  it('剥注释确实有效（否则文档里提到 errorCode 会假违规）', () => {
    const withComment = stripComments(`
      /* 文档里举例：errorCode: 'xxx_from_doc' */
      // 同样：errorCode: 'yyy_from_line_comment'
      const a = 1
    `)
    expect(withComment).not.toContain('xxx_from_doc')
    expect(withComment).not.toContain('yyy_from_line_comment')
  })

  it('每条都有可编程信号：退出码 / 能不能重试 / 该怎么做', () => {
    for (const e of ERROR_CODES) {
      expect(typeof e.exitCode, `${e.code} 缺 exitCode`).toBe('number')
      expect(
        [true, false, 'read'],
        `${e.code} 的 retry 非法 —— 调用方靠它决定"重试还是换路"`
      ).toContain(e.retry)
      expect(e.fix.trim().length, `${e.code} 没写"该怎么做"`).toBeGreaterThan(0)
      expect(e.what.trim().length, `${e.code} 没写"是什么意思"`).toBeGreaterThan(0)
    }
  })

  it('errorCode 不重复（重复会让按码分流的脚本行为不确定）', () => {
    const codes = ERROR_CODES.map((e) => e.code)
    expect(new Set(codes).size).toBe(codes.length)
  })

  it('errorCodeById 能按代号取到', () => {
    expect(errorCodeById('conflict')?.exitCode).toBe(5)
    expect(errorCodeById('conflict')?.retry).toBe('read')
    expect(errorCodeById('guard_blocked')?.exitCode).toBe(4)
    expect(errorCodeById('nope')).toBeUndefined()
  })

  /**
   * 与 `gates.ts` 的档位必须自洽：同一个语义在两处报出不同退出码，
   * 会让"按退出码分流"和"按错误码分流"的两拨脚本行为不一致。
   */
  it('与关口清单的退出码口径不冲突（4 = 守卫/身份，5 = 冲突）', () => {
    const guardish = ['guard_blocked', 'identity_required', 'identity_pending', 'grant_required']
    for (const c of guardish) {
      expect(errorCodeById(c)?.exitCode, `${c} 该是 4（守卫/身份档）`).toBe(4)
    }
    expect(errorCodeById('conflict')?.exitCode).toBe(5)
    expect(errorCodeById('usage_error')?.exitCode).toBe(2)
    expect(errorCodeById('not_found')?.exitCode).toBe(3)
  })
})
