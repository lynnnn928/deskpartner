import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { classifyError, formatUncaughtFailure } from '../../../src/main/cli/error-codes'
import { GuardError, NotFoundError, UsageError, ConflictError } from '../../../src/main/lib/domain-errors'
import { executeOne } from '../../../src/main/cli/commands'
import { expandFileFlags, expandFileFlagsInBatch } from '../../../src/cli/file-flags'
import { toArgv } from '../../../src/cli/mcp-tools-from-schema'

/**
 * 非 CLI 出口的裸抛 Error 只落 exit 1（1.0.110，收 `7a6ac97e`）
 *
 * ## 病是什么
 *
 * 分类此前只写在 `executeOne` 的 catch 里 —— 于是**只有走命令执行那条路的错误**才有分类。
 * 启动器自己抛的错落到 `main().catch`，那里无条件写 `code: 'error'` + exit 1：
 *
 *   直连（无头通道）  `--desc-file` 读不到文件 → 启动器出口 → `error` / exit 1
 *   启动器出口        `dp skill <未知主题>`   → executeOne   → `error` / exit 1
 *
 * 两件事都报同一个形状，而**"我参数写错了"与"环境坏了"该做的事完全相反**
 * （改命令 / 看日志换台机器）。判据：**报错要能分流**，不是"报一个错就行"。
 *
 * ## 这一版做了什么
 *
 * 1. 分类收到**一处**：`classifyError`（`error-codes.ts`），出口只负责套信封；
 * 2. 启动器的失败出口照它出码（`formatUncaughtFailure`），不再写死 `error` / exit 1；
 * 3. 出口层的裸 `throw new Error` 换成域错误类型 —— 静态闸门盯着，带注解的例外放行。
 *
 * ⚠️ 本文件**不用源码正则替行为断言**：能真跑的都真跑（`executeOne` / `expandFileFlags`
 * / `toArgv` / 信封格式化），只有"启动器的 catch 有没有接上分类"这一处用源码判定 ——
 * 理由是启动器不在任何 tsconfig 的 include 里、且沙箱里 spawn 子进程拿不到输出
 * （见 `preflight-before-spawn.test.ts` 的头注释），从外面验不了。
 */

const ROOT = path.resolve(__dirname, '../../..')
/** 出口层：CLI 客户端（启动器 + 通道）+ 服务端命令层 */
const EXIT_DIRS = ['src/cli', 'src/main/cli']

/** 留给人判过的例外：这条注释出现在裸抛前后 6 行内即放行 */
const ANNOTATION = '出口注解'

/** 剥注释（`code: 'error'` 会出现在讲解它的注释里，不剥就会假违规） */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

/**
 * 扫出"没归类就抛"的位置（1 基行号）。
 *
 * 判据：出口层的抛错必须是**域错误类型**（用法 / 未找到 / 守卫 / 冲突），
 * 否则调用方拿到的是 `error` / exit 1 —— 那等于"我不知道出了什么事"。
 * 真判不出类别的，写 `出口注解` 说明为什么它只可能落 exit 1。
 */
function bareThrowLines(src: string): number[] {
  const lines = src.split('\n')
  const bad: number[] = []
  lines.forEach((line, i) => {
    if (!/throw\s+new\s+Error\(/.test(line)) return
    const window = lines.slice(Math.max(0, i - 6), i + 1).join('\n')
    if (window.includes(ANNOTATION)) return
    bad.push(i + 1)
  })
  return bad
}

/** 启动器的失败出口必须接上分类，而不是写死 error / exit 1 */
function launcherClassifies(src: string): boolean {
  const code = stripComments(src)
  return (
    code.includes('formatUncaughtFailure(') &&
    !/code:\s*'error'/.test(code) &&
    !/process\.exit\(1\)/.test(code)
  )
}

describe('分类只有一个出处（7a6ac97e）', () => {
  it.each([
    [new UsageError('参数写错'), 'usage_error', 2],
    [new NotFoundError('目标没找到'), 'not_found', 3],
    [new GuardError('关口拒绝'), 'guard_blocked', 4],
    [new ConflictError('乐观锁冲突'), 'conflict', 5],
    [new Error('数据层异常'), 'error', 1]
  ])('按类型归类 %s → %s / exit %i', (err, errorCode, exitCode) => {
    expect(classifyError(err)).toEqual({ errorCode, exitCode })
  })

  it('认类型不认文案：文案里写着"不存在 / G10"也改不了判定', () => {
    expect(classifyError(new Error('目标不存在（G10）'))).toEqual({
      errorCode: 'error',
      exitCode: 1
    })
  })

  it('退出码与错误码清单同源（不是第二张表）', () => {
    // 同一套值：清单改了这里不跟着改，就会出现"按码分流"与"按退出码分流"两拨脚本不一致
    for (const [err, , exitCode] of [
      [new UsageError('x'), '', 2],
      [new NotFoundError('x'), '', 3],
      [new GuardError('x'), '', 4],
      [new ConflictError('x'), '', 5]
    ] as [Error, string, number][]) {
      expect(classifyError(err).exitCode).toBe(exitCode)
    }
  })
})

describe('启动器的失败出口照分类出码（7a6ac97e）', () => {
  it('非 TTY：用法错误给 usage_error / exit 2（不是写死的 error / exit 1）', () => {
    const f = formatUncaughtFailure(new UsageError('--desc-file 读不到「x.txt」'), false)
    expect(JSON.parse(f.stdout)).toEqual({
      ok: false,
      code: 'usage_error',
      message: '--desc-file 读不到「x.txt」'
    })
    expect(f.exitCode).toBe(2)
    expect(f.stderr).toBe('')
  })

  it('环境错仍是 error / exit 1 —— 1 从此只表示"真的预期外"', () => {
    const f = formatUncaughtFailure(new Error('无头通道起不来：已知缺陷'), false)
    expect(JSON.parse(f.stdout).code).toBe('error')
    expect(f.exitCode).toBe(1)
  })

  it('TTY：给人读一行，退出码照样按分类给', () => {
    const f = formatUncaughtFailure(new UsageError('主题写错'), true)
    expect(f.stdout).toBe('')
    expect(f.stderr).toBe('错误: 主题写错\n')
    expect(f.exitCode).toBe(2)
  })

  it('启动器源码：接上分类器，且不再写死 code/退出码', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/cli/launcher.ts'), 'utf8')
    expect(
      launcherClassifies(src),
      '启动器的 main().catch 必须用 formatUncaughtFailure 出码 —— ' +
        '写死 \'error\'/exit 1 会让"参数写错"与"环境坏了"长得一样'
    ).toBe(true)
  })

  it('反向验证：改回写死 error + exit 1 的写法，上面那条判据当场变红', () => {
    const before = `main().catch((err) => {
  process.stdout.write(JSON.stringify({ ok: false, code: 'error', message }, null, 2) + '\\n')
  process.exit(1)
})`
    expect(launcherClassifies(before), '反向验证失效：旧写法竟然被判通过').toBe(false)
  })
})

/** 最小 ctx：这几条命令的 run 不碰数据库（见 error-codes-single-source 同一手法） */
const ctx = () =>
  ({
    deps: {},
    meta: { version: '1.0.73', schemaVersion: 25, dbPath: ':memory:', via: 'pipe' }
  }) as never

describe('出口层的裸抛换成域错误类型（7a6ac97e）', () => {
  it('`dp skill <未知主题>` 是用法错误：usage_error / exit 2（此前是 error / exit 1）', async () => {
    const r = (await executeOne(ctx(), ['skill', '不存在的主题'])) as {
      ok: boolean
      code: number
      errorCode: string
      message: string
    }
    expect(r.ok).toBe(false)
    expect(r.errorCode).toBe('usage_error')
    expect(r.code).toBe(2)
    expect(r.message).toContain('可用主题')
  })

  it('`dp skill core` 照常出正文（换成 UsageError 没伤到正常路径）', async () => {
    const r = (await executeOne(ctx(), ['skill', 'core'])) as { ok: boolean; data: string }
    expect(r.ok).toBe(true)
    // 正文是 Markdown 原样输出（output: 'text'）：frontmatter 的主题名 + 真实章节标题
    expect(String(r.data)).toContain('name: desk-partner-todos-core')
    expect(String(r.data)).toContain('## 核心纪律')
  })

  it('`--desc-file` 读不到文件：抛 UsageError（启动器出口据此给 exit 2）', () => {
    const read = () => {
      throw new Error('ENOENT: no such file or directory')
    }
    let caught: unknown
    try {
      expandFileFlags(['todo', 'create', '--desc-file', 'missing.txt'], read)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(UsageError)
    expect(classifyError(caught)).toEqual({ errorCode: 'usage_error', exitCode: 2 })
  })

  it('batch 行里的 `--desc-file` 读不到文件：同样抛 UsageError', () => {
    const read = () => {
      throw new Error('ENOENT')
    }
    const stdin = JSON.stringify({ cmd: 'todo create', args: { '--desc-file': 'missing.txt' } })
    let caught: unknown
    try {
      expandFileFlagsInBatch(['batch'], stdin, read)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(UsageError)
    expect(classifyError(caught).exitCode).toBe(2)
  })

  it('MCP 侧还原不出工具名：抛 UsageError（接住它的 caller 本就是 usage_error）', () => {
    let caught: unknown
    try {
      toArgv('totally_bogus_tool', {})
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(UsageError)
    expect(classifyError(caught)).toEqual({ errorCode: 'usage_error', exitCode: 2 })
  })
})

describe('静态闸门：出口层不许"没归类就抛"', () => {
  const files = EXIT_DIRS.flatMap((dir) =>
    fs
      .readdirSync(path.join(ROOT, dir))
      .filter((f) => f.endsWith('.ts'))
      .map((f) => path.join(dir, f))
  )

  it('扫到足够多的文件（否则这条闸门等于没跑）', () => {
    expect(files.length).toBeGreaterThan(10)
  })

  it('每个裸抛都换成域错误类型，或带「出口注解」说清为什么', () => {
    const bad = files
      .map((f) => ({ f, lines: bareThrowLines(fs.readFileSync(path.join(ROOT, f), 'utf8')) }))
      .filter((x) => x.lines.length > 0)
      .map((x) => `${x.f}:${x.lines.join(',')}`)
    expect(
      bad,
      '出口层的裸 throw new Error 只会落成 error / exit 1 —— 调用方分不出"用法错"与"环境错"。' +
        '改成 UsageError / NotFoundError / GuardError / ConflictError，或写「出口注解」说明原因'
    ).toEqual([])
  })

  it('反向验证：裸抛会被判红，带注解才放行', () => {
    expect(bareThrowLines("  throw new Error('没归类')")).toEqual([1])
    expect(bareThrowLines("  // 出口注解：这里只可能是 exit 1，因为 xxx\n  throw new Error('没归类')")).toEqual(
      []
    )
    // 域错误类型不算裸抛
    expect(bareThrowLines("  throw new UsageError('参数写错')")).toEqual([])
  })
})
