/**
 * 扫源码的闸门必须先剥注释（修 `82883672`）
 *
 * 【事故】给 QuickAddForm 的「本次变更」写说明注释，注释里顺手出现
 * 「怎么走过来的」几个字，audit-timeline 的扫源码闸门立刻假红 ——
 * 代码一行没动。假红比漏判更坏：它逼下一个人把注释措辞改含糊去哄闸门，
 * 而闸门要防的"翻译搬回渲染层"这件事本身一点没变。
 *
 * 【修法】扫源码的断言一律先剥注释再判定（stripComments → readCode）。
 *
 * 【本文件钉两件事】
 * 1. 判定行为：注释里的禁词不算违规，代码里的禁词仍算违规（防"剥过头"）；
 * 2. 结构：那道闸门的扫源码读取真的走剥注释通道（revert 成裸 read 会红）。
 *
 * 反向验证（判别逻辑已用 node 直接执行验证过，未跑 vitest）：
 * - 注释里放禁词 → 剥后放行；不剥则判违规（证明"剥注释"是承重的一步）；
 * - 代码里放禁词 → 剥后仍判违规（证明没有剥过头）；
 * - 结构判定喂"删掉消费/改回裸 read"的夹具 → 判违规。
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/** 与 audit-timeline.test.ts 的 stripComments 同一判据：块注释 + 行注释，避开 http:// */
const stripComments = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')

/** 闸门的判定本身：剥注释后的源码里不该出现禁词 */
const judge = (rawSrc: string, forbidden: string): boolean =>
  !stripComments(rawSrc).includes(forbidden)

/** 事故里的那句话，这里只当示例禁词用，不锁任何文案 */
const WORD = '怎么走过来的'

describe('扫源码闸门先剥注释：注释噪音不假红、真违规仍红（82883672）', () => {
  it('注释里出现禁词不判违规（假红现场：闸门认代码，不认注释）', () => {
    const noise = [
      'const el = <div>',
      `  {/* ${WORD} */}`, // JSX 块注释
      '</div>',
      `  // ${WORD}`, // 行注释
      `  /* ${WORD} */` // 块注释
    ].join('\n')
    expect(judge(noise, WORD), '注释噪音被判违规 —— 又回到"写个注释就假红"').toBe(true)
  })

  it('反向验证：不剥注释时同一夹具会被判违规（剥注释是承重的一步）', () => {
    const noise = `// ${WORD}`
    const judgeWithoutStrip = (src: string, w: string): boolean => !src.includes(w)
    // 注入违规形态（判定不剥注释）→ 必须判违规；剥了 → 必须放行。
    // 两者一对，才证明"剥注释"这步在干活：删掉它，上一条用例必红。
    expect(judgeWithoutStrip(noise, WORD), '不剥注释也放行 —— 判定根本没在看内容').toBe(false)
    expect(judge(noise, WORD), '剥了还判违规 —— 剥注释失效').toBe(true)
  })

  it('反向验证：代码里的禁词剥注释后仍判违规（防剥过头把真违规也剥没了）', () => {
    const real = `const what = '${WORD}'`
    expect(judge(real, WORD), '代码里的禁词没被判出来 —— 闸门失效').toBe(false)
  })

  it('URL 里的 // 不被当行注释剥掉（http:// 不是注释）', () => {
    const src = 'const u = "http://example.com/a" // 真注释'
    const out = stripComments(src)
    expect(out, 'URL 被行注释规则误伤').toContain('http://example.com/a')
    expect(out, '行注释没剥干净').not.toContain('真注释')
  })

  it('事故素材（QuickAddForm 里那句注释）剥注释后不进判定输入', () => {
    // 事故现场的注释还在 QuickAddForm.tsx 里 —— 它就是活的回归素材：
    // 禁词出现在注释里时必须放行；哪天它进了代码（非注释），本条就该红。
    const raw = fs.readFileSync(
      path.resolve(__dirname, '../../../src/renderer/components/quick-add/QuickAddForm.tsx'),
      'utf8'
    )
    expect(judge(raw, WORD), '禁词进了判定输入 —— 要么它进了代码，要么剥注释失效').toBe(true)
  })
})

describe('结构闸门：audit-timeline 的扫源码读取走剥注释通道（82883672）', () => {
  /**
   * 那道闸门的三个扫源码目标必须经剥注释读取。
   * 认新旧两种形状：`readCode('…')`（修后写法）与 `stripComments(read('…'))`（等价旧写法）；
   * 把消费改回裸 `read('…')` 或整段删掉，本条都会红（删掉消费照样红）。
   */
  it('三个扫源码目标都经剥注释读取（revert 成裸 read / 删掉消费都会红）', () => {
    const src = fs.readFileSync(path.resolve(__dirname, 'audit-timeline.test.ts'), 'utf8')
    for (const target of [
      'src/renderer/components/quick-add/QuickAddForm.tsx',
      'src/main/ipc.ts',
      'src/renderer/types/ipc.ts'
    ]) {
      const esc = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const strippedRead = new RegExp(`(?:readCode\\(\\s*'|stripComments\\(\\s*read\\(\\s*')${esc}'`)
      expect(
        src,
        `${target} 的读取没走剥注释 —— 注释噪音会假红（82883672 回潮）`
      ).toMatch(strippedRead)
    }
  })

  it('反向验证：改回裸 read 的夹具被判违规（闸门认得出回潮形态）', () => {
    const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const line = (read: string, target: string): string => `const src = ${read}('${target}')`
    const ok = (code: string): boolean =>
      new RegExp(`(?:readCode\\(\\s*'|stripComments\\(\\s*read\\(\\s*')${esc('src/main/ipc.ts')}'`).test(code)

    expect(ok(line("readCode", 'src/main/ipc.ts')), '修后形状被误判').toBe(true)
    expect(ok(line("stripComments(read", 'src/main/ipc.ts')), '等价旧形状被误判').toBe(true)
    expect(ok(line("read", 'src/main/ipc.ts')), '裸 read 没被判出来 —— 闸门失效').toBe(false)
    expect(ok(''), '消费删光了还是绿 —— 闸门失效').toBe(false)
  })
})
