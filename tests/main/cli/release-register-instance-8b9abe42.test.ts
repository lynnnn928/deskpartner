/**
 * 发版链登记必须由**本版产物**执行（8b9abe42 的回归锁）
 *
 * ── 要锁住的现象 ──
 *
 * CLI 启动器优先走命名管道，**管道那头是正在跑的实例** —— CLI 的行为版本
 * = 实例版本，不是磁盘产物的版本。机器上跑着旧 GUI 时，发版链每一步
 * 「用新参数调 CLI」都会被旧命令表拒收（1.0.75 发版实测：`release add 不接受
 * --tested` 发版中止，而磁盘上 --tested 明明在）。报错指向参数，人却怎么改
 * 参数都好不了 —— 失败方向是错的。
 *
 * ── 修法（选项①）──
 *
 * 登记显式走**新产物通道**：buildRegisterEnv 注入 DESKPARTNER_NO_PIPE=1
 * （绕开管道）+ DESKPARTNER_MAIN 指向刚构建的 win-unpacked 产物（无头降级才
 * 执行磁盘上那份代码），然后 doctor 自报「登记由哪个实例执行、其版本是否 =
 * 本版」，assertRegistrationInstance 对不上就地停。
 *
 * ── 判据（卡面）──
 *
 * 1. 通道构造：NO_PIPE 必注入；产物在才注入 MAIN，产物不在连继承来的旧值都
 *    删掉（指向哪份代码要说得清）；
 * 2. 实例自证：版本一致才放行；不一致的报错里必须同时说出「将由哪个版本执行」
 *    和「本该是哪个版本」（失败方向要正确），doctor 说不出版本就当不确定、拒登记；
 * 3. 接线（防"能力在、闭环断在最后一公里"）：release.mjs 第 9 节真的消费这两个
 *    函数，且 doctor / release add / release show 三个 spawn **都**走注入 env ——
 *    只自证不换通道 = 自证完又把命令发给了旧实例。
 *
 * ⚠️ 本文件**不 spawn、不碰库、不写盘** —— 绝不真发版、绝不动真登记。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildRegisterEnv,
  assertRegistrationInstance
} from '../../../scripts/lib/release-register.mjs'

const src = readFileSync(join(process.cwd(), 'scripts', 'release.mjs'), 'utf8')

/** 第 9 节（版本登记）的真实代码块：从步骤注释切到下一个分节标记，不数字符。 */
function section9(): string {
  const i = src.indexOf('// ── 9.')
  if (i < 0) throw new Error('release.mjs 里找不到第 9 节锚点（版本登记这一步被人删了？）')
  const next = src.indexOf('\n// ── ', i + 8)
  return src.slice(i, next < 0 ? undefined : next)
}

/** 剥掉注释：注释里解释机制时提到的字样不算"代码里有"。 */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

describe('登记通道构造：buildRegisterEnv（8b9abe42）', () => {
  it('DESKPARTNER_NO_PIPE 必注入 —— 绕开命名管道是无条件的', () => {
    const r = buildRegisterEnv({ FOO: '1' }, { mainPath: 'C:/x/DeskPartner.exe', mainExists: true })
    expect(r.env.DESKPARTNER_NO_PIPE).toBe('1')
    expect(r.env.FOO, '上层环境其余变量原样保留').toBe('1')
  })

  it('产物在 → 注入 DESKPARTNER_MAIN（去首尾空白），via=dist-main', () => {
    const r = buildRegisterEnv({}, { mainPath: '  C:/dist/win-unpacked/DeskPartner.exe  ', mainExists: true })
    expect(r.env.DESKPARTNER_MAIN).toBe('C:/dist/win-unpacked/DeskPartner.exe')
    expect(r.via).toBe('dist-main')
    expect(r.mainPath).toBe('C:/dist/win-unpacked/DeskPartner.exe')
  })

  it('产物不在 → 不注入 MAIN，且**删掉继承来的旧值**（指向哪份代码要说得清）', () => {
    for (const opts of [
      { mainPath: 'C:/x/DeskPartner.exe', mainExists: false },
      { mainPath: '', mainExists: true },
      { mainPath: '   ', mainExists: true },
      { mainPath: undefined, mainExists: true },
      {}
    ]) {
      const r = buildRegisterEnv({ DESKPARTNER_MAIN: 'C:/旧实例/旧路径.exe' }, opts)
      expect(r.env.DESKPARTNER_MAIN, `${JSON.stringify(opts)} 不该留 MAIN`).toBeUndefined()
      expect(r.via, `${JSON.stringify(opts)} 该走 no-pipe-only`).toBe('no-pipe-only')
      expect(r.mainPath).toBe(null)
      expect(r.env.DESKPARTNER_NO_PIPE, '产物不在也得关管道').toBe('1')
    }
  })

  it('不改动传入的 env 对象（调用方的 process.env 不许被就地写）', () => {
    const orig = { DESKPARTNER_MAIN: 'C:/old.exe' }
    buildRegisterEnv(orig, { mainPath: 'C:/new.exe', mainExists: true })
    expect(orig.DESKPARTNER_MAIN, '输入对象必须原样').toBe('C:/old.exe')
    expect('DESKPARTNER_NO_PIPE' in orig).toBe(false)
  })
})

describe('登记实例自证：assertRegistrationInstance（8b9abe42）', () => {
  it('版本一致 → 放行，回出自报的版本与通道', () => {
    const r = assertRegistrationInstance({
      expectedVersion: '1.0.76',
      doctor: { version: '1.0.76', via: 'headless' },
      via: 'dist-main'
    })
    expect(r).toEqual({ version: '1.0.76', via: 'dist-main' })
  })

  it('via 不传就退回 doctor 自报的通道，都没有就标"未知"（不编造）', () => {
    expect(
      assertRegistrationInstance({ expectedVersion: '1.0.76', doctor: { version: '1.0.76', via: 'pipe' } }).via
    ).toBe('pipe')
    expect(
      assertRegistrationInstance({ expectedVersion: '1.0.76', doctor: { version: '1.0.76' } }).via
    ).toBe('未知')
  })

  it('版本不一致 → 抛，且报错里**两个版本号都要有**（失败方向要正确）', () => {
    let msg = ''
    try {
      assertRegistrationInstance({
        expectedVersion: '1.0.76',
        doctor: { version: '1.0.75', via: 'pipe' },
        via: 'no-pipe-only'
      })
    } catch (e) {
      msg = (e as Error).message
    }
    expect(msg, '不一致必须抛').not.toBe('')
    expect(msg, '要说清"将由哪个版本执行"').toContain('1.0.75')
    expect(msg, '要说清"本该是哪个版本"').toContain('不是本版 1.0.76')
    expect(msg, '要说清走了哪条通道，人才知道去查哪段').toContain('via: no-pipe-only')
    expect(msg, '要给出出路，不是只报错').toMatch(/关掉正在运行的旧界面|确认 dist\/win-unpacked/)
  })

  it('doctor 说不出版本（缺/空/非字符串）→ 当"说不清"，一律拒登记', () => {
    for (const doctor of [{}, { version: '' }, { version: '   ' }, { version: 42 }, undefined, null]) {
      expect(
        () => assertRegistrationInstance({ expectedVersion: '1.0.76', doctor: doctor as never, via: 'dist-main' }),
        `${JSON.stringify(doctor)} 应被拒`
      ).toThrow(/doctor 没报出执行实例的版本/)
    }
  })

  it('版本号首尾空白不算差异（doctor 自报与本版同号就放行）', () => {
    expect(
      assertRegistrationInstance({ expectedVersion: ' 1.0.76 ', doctor: { version: '1.0.76' }, via: 'dist-main' })
        .version
    ).toBe('1.0.76')
  })
})

describe('release.mjs 接线：自证与通道真的进了登记步骤（8b9abe42）', () => {
  const reg = section9()
  const code = stripComments(reg)

  it('两个函数真被 import（墓碑防护：定义了没人引 = 同源缺陷）', () => {
    expect(src).toMatch(/import \{[^}]*buildRegisterEnv[^}]*\} from '\.\/lib\/release-register\.mjs'/)
    expect(src).toMatch(/import \{[^}]*assertRegistrationInstance[^}]*\} from '\.\/lib\/release-register\.mjs'/)
  })

  it('第 9 节真消费 buildRegisterEnv：产物路径来自 artifactPaths、存在性真的探过', () => {
    expect(code).toContain('buildRegisterEnv(process.env')
    expect(code).toContain('artifactPaths(version).unpackedExe')
    expect(code).toContain('mainExists: existsSync(mainPath)')
  })

  it('第 9 节真消费 assertRegistrationInstance，且比对的就是本次要发的 version', () => {
    expect(code).toContain('assertRegistrationInstance({ expectedVersion: version')
    // 自证不过必须 die 停链（机制挂在动作上：调用了且失败走 die，不是 log 完继续）。
    // 判据绑「assert 之后**最近的** catch」—— 带宽窗口的正则会跨到后面别处的 catch 上假绿
    // （反向验证抓过一回：die 改 log 全绿不红，就是窗口跳去了 buildReleaseAddArgs 的 catch）。
    const assertAt = code.indexOf('assertRegistrationInstance({ expectedVersion: version')
    const catchAt = code.indexOf('} catch (e) {', assertAt)
    expect(catchAt, 'assert 之后必须紧跟它自己的 catch').toBeGreaterThan(assertAt)
    expect(code.slice(catchAt, catchAt + 40), '自证失败必须 die 停链').toMatch(/\} catch \(e\) \{\s*die\(/)
  })

  it('doctor 自证读的是**捕获到的** stdout（输出不是 JSON 必须停，不许盲信）', () => {
    expect(code).toContain("runCapture(process.execPath, [cli, 'doctor']")
    expect(code).toContain('JSON.parse(doc.stdout)')
    expect(code).toMatch(/输出不是 JSON/)
  })

  it('doctor / release add / release show 三个 spawn 都走注入 env —— 只自证不换通道 = 白做', () => {
    const calls = code.split(/run(?:Capture)?\(/).slice(1)
    expect(calls.length, 'doctor 自证 + release add + release show').toBeGreaterThanOrEqual(3)
    calls.forEach((seg, i) => {
      expect(seg, `第 ${i + 1} 个 spawn 必须带 env: regEnv.env（不然命令还是发给旧实例）`).toContain(
        'env: regEnv.env'
      )
    })
  })

  it('自证在登记**之前**（先确认由谁执行，再真的登记）', () => {
    const assertAt = code.indexOf('assertRegistrationInstance(')
    const addAt = code.indexOf('[cli, ...addArgs]')
    expect(assertAt, '自证块必须存在').toBeGreaterThanOrEqual(0)
    expect(addAt, 'release add 必须存在').toBeGreaterThanOrEqual(0)
    expect(assertAt, '自证必须发生在 release add 之前').toBeLessThan(addAt)
  })
})
