/**
 * 发版链路的三步人工动作收进脚本（f6c186b8 / ae9f5fdd 的回归锁）
 *
 * ── 要锁住的现象 ──
 *
 * 1.0.73 用 release 能力发的版，自己却没登记：`npm run release` 里没有任何一处
 * 调 `release add`，登记靠人记得，于是上线第一版就忘了，`dp release list` 至今
 * 是空数组（`ae9f5fdd` 的驳回）。同一族还有两步：升 package.json version、
 * 决定跑不跑测试（`f6c186b8`）—— 三步都靠记性，而记性断过一次。
 *
 * ── 为什么一半是行为断言、一半是结构性断言 ──
 *
 * - 纯校验逻辑（缺摘要必须报错、升版本的号怎么算）直接对
 *   `scripts/lib/release-register.mjs` 的导出函数做**行为断言** —— 这是判据本身；
 * - "脚本真的把它们接进了链"只能对 `scripts/release.mjs` 的源码做**结构断言**
 *   （同 `release-clean-gate.test.ts` 的做法）：脚本顶层即执行，一 import 就真发版。
 *
 * ⚠️ 本文件**不 spawn、不碰库、不写盘** —— 绝不真发版、绝不动真登记。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  requireSummary,
  requireAgentIdentity,
  buildReleaseAddArgs,
  resolveReleaseVersion,
  applyVersionToJson,
  parseReleaseArgs
} from '../../../scripts/lib/release-register.mjs'

const src = readFileSync(join(process.cwd(), 'scripts', 'release.mjs'), 'utf8')

/**
 * 取某一步之后的一段真实代码块。锚点用步骤注释，不用会漂移的文案。
 * 不传 size 就切到下一个分节标记（\n// ── ）为止 —— 固定字符窗口会随代码演进腐：
 * 8b9abe42 的自证块插进第 9 节后，2500 字符就罩不住 release show 了。
 */
function blockFrom(anchor: string, size?: number): string {
  const i = src.indexOf(anchor)
  if (i < 0) throw new Error(`release.mjs 里找不到锚点「${anchor}」（这一步被人删了？）`)
  if (size == null) {
    const next = src.indexOf('\n// ── ', i + anchor.length)
    return src.slice(i, next < 0 ? undefined : next)
  }
  return src.slice(i, i + size)
}

describe('发版最后一步强制版本登记，缺摘要必须报错（ae9f5fdd）', () => {
  it('缺摘要必须报错：未传 / 空串 / 纯空白都抛，登记内容不能为空', () => {
    for (const bad of [undefined, null, '', '   ', '\t\n']) {
      expect(() => requireSummary(bad as never), `摘要 ${JSON.stringify(bad)} 应被拒`).toThrow(
        /缺 --summary/
      )
    }
    // 同一条判据在组装 argv 时也要成立（收尾那步就是走 buildReleaseAddArgs）
    expect(() => buildReleaseAddArgs({ project: 'DeskPartner', version: '1.0.74', summary: '' })).toThrow(/缺 --summary/)
    expect(() => buildReleaseAddArgs({ project: 'DeskPartner', version: '1.0.74' })).toThrow(/缺 --summary/)
  })

  it('缺 --project 必须报错：版本挂在项目下，登记不能没归属（a2ea95f8）', () => {
    for (const bad of [undefined, null, '', '   ']) {
      expect(() =>
        buildReleaseAddArgs({ project: bad as never, version: '1.0.76', summary: 's' }),
        `project ${JSON.stringify(bad)} 应被拒`
      ).toThrow(/缺 --project/)
    }
  })

  it('登记内容含版本号与摘要；要点可重复传，shipped-at 不传就不编造', () => {
    const args = buildReleaseAddArgs({
      project: 'DeskPartner',
      version: '1.0.74',
      summary: '这版做了什么',
      highlights: ['要点一', ' ', '要点二'],
      shippedAt: '2026-10-08T00:00:00.000Z'
    })
    expect(args).toEqual([
      'release',
      'add',
      '--project',
      'DeskPartner',
      '--version',
      '1.0.74',
      '--summary',
      '这版做了什么',
      '--highlight',
      '要点一',
      '--highlight',
      '要点二',
      '--shipped-at',
      '2026-10-08T00:00:00.000Z'
    ])
    // 不传 shippedAt → 不带 --shipped-at（产品语义：不传 = 还没发布）
    expect(
      buildReleaseAddArgs({ project: 'DeskPartner', version: '1.0.74', summary: 's' })
    ).not.toContain('--shipped-at')
  })

  it('发版脚本收尾真的调 release add，且登记失败必须中止发版', () => {
    const reg = blockFrom('// ── 9.')
    expect(reg).toContain('buildReleaseAddArgs')
    expect(reg).toContain('release add')
    // add 之后必须回读核对（登记与读取同源，show 查不到就当没登记）
    expect(reg).toContain("'release', 'show'")
    // 登记失败 = 发版失败（不是打完包才发现 release list 还是空的）
    expect(reg).toMatch(/die\(\s*\n?\s*`?版本登记失败/)
  })

  it('缺摘要在前置检查就 die（不是打完 16 分钟的包之后才报）', () => {
    const pre = blockFrom("head('前置检查')", 1200)
    expect(pre).toMatch(/try \{\s*requireSummary\(SUMMARY\)\s*\} catch \(e\) \{\s*die\(/)
  })

  /**
   * 登记身份也必须在前置检查就确认（1.0.74 发版实测踩过）：
   * 缺 DESKPARTNER_AGENT 时 CLI 报 ambiguous_identity，发版链跑完构建打包
   * 才在最后一步登记炸 —— 4 分半白跑。登记是强制步骤，身份是它的前置条件。
   */
  it('缺登记身份在前置检查就 die（不在构建打包后才 ambiguous_identity）', () => {
    // 纯函数行为：有身份返回、缺了抛（提示里必须点名环境变量，否则人不知道补什么）
    expect(requireAgentIdentity({ DESKPARTNER_AGENT: 'agent:alice' })).toBe('agent:alice')
    for (const bad of [{}, { DESKPARTNER_AGENT: '' }, { DESKPARTNER_AGENT: '   ' }]) {
      expect(() => requireAgentIdentity(bad), `${JSON.stringify(bad)} 应被拒`).toThrow(
        /DESKPARTNER_AGENT/
      )
    }
    // 墓碑防护：函数存在但没人调 = 同源缺陷（写入侧有、读取入口没接）。
    // 前置检查段必须真的调它，且与 requireSummary 同构（try/catch + die）。
    // 判据钉"调用了且失败走 die"，不钉 try 块里恰好几行（中间加日志行不该红）。
    const pre = blockFrom("head('前置检查')", 1600)
    expect(pre).toMatch(
      /try \{\s*const actor = requireAgentIdentity\(process\.env\)[\s\S]{0,200}?\} catch \(e\) \{\s*die\(/
    )
  })

  it('登记经 run() 走，--dry-run 时整条链可演练而不真登记', () => {
    const reg = blockFrom('// ── 9.')
    // 登记必须走 run()（run 在 DRY 下不执行），而不是绕开它直接起子进程。
    // 判据"没有子进程调用"要剥掉注释再看 —— 注释里解释 shell 拆参时提到过那个词，
    // 而 spawn-stdio-guard 连字符串里的调用字样都会扫（那是它的判据，不绕开）。
    expect(reg).toContain('run(process.execPath')
    const codeOnly = reg.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
    expect(codeOnly).not.toMatch(/spawnSync\s*\(/)
    const runFn = blockFrom('function run(cmd, args, label', 800)
    expect(runFn).toContain('if (DRY)')
    // DRY 分支不落到 spawn
    expect(runFn).toMatch(/if \(DRY\) \{[\s\S]*?return 0/)
  })

  it('登记命令 shell:false —— 摘要里的空格不能被 shell 拆成多个 argv', () => {
    const reg = blockFrom('// ── 9.')
    // add 与 show 两个登记 spawn 都必须 shell: false。形态随 8b9abe42 变过多行
    // （shell: false 与 env: regEnv.env 同在一个 spawn 参数对象里），所以按
    // "每个 run() 调用都带 shell: false"锁、不钉单行写法 —— 写法换了不该红，
    // 哪个登记调用漏了 shell: false 必须红。注释里提到的字样先剥掉再看。
    const codeOnly = reg.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
    const calls = codeOnly.split(/run\(/).slice(1)
    expect(calls.length).toBeGreaterThanOrEqual(2) // release add + release show
    for (const c of calls) {
      expect(c, '每个登记 run() 调用都得 shell: false（摘要空格才不被拆）').toContain('shell: false')
    }
  })
})

describe('升版本与测试默认执行收进发版脚本（f6c186b8）', () => {
  it('要发的号默认补丁位 +1，--to 显式指定（升版本不靠人记得改）', () => {
    expect(resolveReleaseVersion('1.0.73', null)).toBe('1.0.74')
    expect(resolveReleaseVersion('1.0.73', ' 1.0.80 ')).toBe('1.0.80')
    // --to 指回当前号 = 不升、按原号重打（逃生口）
    expect(resolveReleaseVersion('1.0.73', '1.0.73')).toBe('1.0.73')
    expect(() => resolveReleaseVersion('1.0.73', 'v80')).toThrow(/不是 x\.y\.z/)
  })

  it('写 package.json 只动 version 一个字段（不重排无关行）', () => {
    const raw = '{\n  "name": "desk-partner",\n  "version": "1.0.73",\n  "description": "x"\n}\n'
    const out = applyVersionToJson(raw, '1.0.74')
    expect(JSON.parse(out).version).toBe('1.0.74')
    expect(out).toContain('"name": "desk-partner"')
    expect(out.split('\n')).toHaveLength(raw.split('\n').length)
    expect(() => applyVersionToJson('{}', '1.0.74')).toThrow(/找不到 "version"/)
  })

  it('发版脚本真的写 package.json 并回读核对，--dry-run 不写', () => {
    const bump = blockFrom('// ── 2.', 1500)
    expect(bump).toContain('applyVersionToJson(raw, version)')
    expect(bump).toContain('writeFileSync(pkgPath')
    // 写后回读核对（既有习惯）：从 package.json 读回来的必须是这个号
    expect(bump).toContain('const back = packageVersion()')
    // dry-run 不写盘：写动作必须在 DRY 判断之后的 else 里
    expect(bump).toMatch(/else if \(DRY\)[\s\S]*?\} else \{[\s\S]*?writeFileSync/)
  })

  it('测试默认执行，只有 --skip-tests 才跳过（旧的 --with-tests 开关已退场）', () => {
    expect(src).toContain("argv.includes('--skip-tests')")
    expect(src).toContain('run-tests.mjs')
    // 默认执行 = 以"没跳过"为条件跑测试
    expect(src).toMatch(/if \(!SKIP_TESTS\) \{[\s\S]*?run-tests\.mjs/)
    // 反向：不该再有"要测试得显式开"的旧开关
    expect(src).not.toContain("argv.includes('--with-tests')")
  })

  it('发版脚本自己的带值 flag 与 verify-package 的关键字符串分开', () => {
    // 摘要/要点的值不带 -- 前缀，不摘走就会被当成"改动进包了吗"的检索串
    const p = parseReleaseArgs([
      '--summary',
      '这版做了什么',
      '--highlight',
      '要点一',
      '--dry-run',
      'key1'
    ])
    expect(p.summary).toBe('这版做了什么')
    expect(p.highlights).toEqual(['要点一'])
    expect(p.keys).toEqual(['key1'])
  })
})
