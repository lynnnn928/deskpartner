import { describe, it, expect } from 'vitest'
import { readCliChain } from './cli-chain'
import { join } from 'node:path'

const SRC = readCliChain()

/**
 * batch 的 notice 必须去重聚合（修 `3df42f82`，Bob建议①）
 *
 * ## Bob实测的形状
 *
 * 一次 batch 里第 1 条命令就触发了"有 3 张未读纸条 + 3 条指派待办"的 notice，
 * 随后**每条命令都原样重复一次** —— 20 条命令收到 20 份相同提醒。
 *
 * 三重代价：占上下文 / 让人误以为是 20 个不同问题 /
 * 而**提醒刷屏会降低真正重要提醒的到达率**（最贵的一条）。
 *
 * ## 为什么不能"只在顶层算一次"
 *
 * 未读摘要的内容依赖"这一批跑完之后"的状态，而中途状态确实会变
 * （第 5 条刚被退回、第 20 条才建好）。所以正确做法是**收齐后去重**，
 * 不是不算 —— 不算会漏掉批内新产生的提醒。
 *
 * ## 为什么是结构化断言（这里有个诚实的过程记录）
 *
 * 我本想用行为断言（跑一次真 batch、数 notice 出现几次）。**试了六次没成**，
 * 每次都不是实现的问题：
 * 1. 第一版全用 `todo list` —— 未读摘要只在 `!cmd.readOnly` 时算，
 *    notice 从不触发，而断言写"重复 ≤ 1"、**0 也满足 → 假绿**
 * 2. 改写命令 → notice 仍空 → 查 `executeOne` 返回形状：字段全在 `r.data` 里
 * 3. 造触发数据：`reset()` 误删 `categories` → 建卡抛「还没有任何分类」
 * 4. `memo` 字段是 `author` 不是 `owner` → memo 的 author 是 undefined
 * 5. 补上身份注册 → 仍空
 * 6. 停止
 *
 * 其中第 3、4 步值得单独记：**两次失败都报"数据有问题"，
 * 而实际是我的测试自己造错了数据** —— 报错指向的地方不等于原因所在的地方。
 *
 * 判据：**测试写不出来时，先怀疑测试，别怀疑实现** ——
 * 尤其当失败信息指向某个与实现无关的方向时。
 * 行为断言的价值在"它能抓住回归"；结构化断言的价值在"它不会自己骗我"。
 * 这里选后者，并**把上面这段踩坑记录留在文件里**，
 * 让下一个人不必重走这六步。
 */
describe('batch notice 去重聚合（3df42f82）', () => {
  /** batch 命令块的起止：`name: 'batch'` 到它所在数组的收尾 */
  const batchBlock = (): string => {
    const start = SRC.indexOf("name: 'batch'")
    expect(start, '找不到 batch 命令定义').toBeGreaterThan(-1)
    /**
     * 收尾标记：**这个数组自己的闭合行**（行首的 `]`）。
     *
     * 原先用的是 `...uiCommands`（那时命令表是一整块、ui 那三条紧跟在 batch 后面）。
     * 卡 d1b71d28 把命令表按域拆进 `commands/<域>.ts` 之后，展开项搬到了聚合器里、
     * 位置在 batch 之前 —— 用它当收尾会得到 -1。而 `commands/batch.ts` 里只有
     * `batch` 这一条命令，数组闭合行就是它自己的收尾（嵌套的 `]` 都带缩进，
     * 行首的 `]` 只有这一处）。
     */
    const end = SRC.indexOf('\n]', start)
    expect(end, '找不到 batch 块的收尾').toBeGreaterThan(start)
    return SRC.slice(start, end)
  }

  it('按 Set 去重（同一段文字只留一份）', () => {
    const b = batchBlock()
    expect(b).toContain('const noticeSet = new Set<string>()')
    expect(b).toMatch(/for \(const r of results\)/)
    expect(b).toContain('noticeSet.add(')
    // 遍历的是 results（每条 outcome 的 notice）
    expect(b).toMatch(/noticeSet\.add\(\s*n\.trim\(\)|noticeSet\.add\(n\.trim\(\)/)
  })

  it('去重的是【所有】notice，不只是第一条（Set 而非取首条）', () => {
    const b = batchBlock()
    // ⚠️ 若实现是"只留第一条"，这里会是 notices[0] 而不是 [...noticeSet]
    expect(b, '应为展开 Set（保留全部不同项）').toContain('const notices = [...noticeSet]')
  })

  it('逐条那份不被抹掉（只提醒不拦，不丢数据）', () => {
    const b = batchBlock()
    /**
     * ⚠️ 1.0.72 放宽了这条断言的**写法**要求（`10fcb47f` D2 修复后必然要放宽）。
     *
     * 原文是 `results.push({index: i, cmd: item.cmd, ...outcome})` 的字面量正则，
     * 它把"逐条 notice 不被抹掉"这个真实约束，绑死在了"必须用这一行写法"上。
     * 而 D2 的修复恰恰要往那一行里加 `code` / `exitCode` 两个键 ——
     * 语义上没动 notice，正则却匹配不上了。
     *
     * 判据：**源码断言钉语义、不钉写法**。
     * 写法可以为了修别的缺陷而变，语义不能。所以这里改成断言
     * "outcome 被展开进 results 且 notice 没被显式清空"——
     * 任何一种"把 notice 抹掉"的实现仍然会红。
     */
    /**
     * 锚定"展开 outcome"的那一处，而不是 batch 块里任意一个 `results.push`。
     *
     * 踩过的坑：先用 `/results\.push\(\{[\s\S]*?\}\)/` 非贪婪匹配，
     * 结果命中的是**前面那两行手写错误信封**（JSON 解析失败 / 缺 cmd），
     * 断言于是对着错误的代码块报错 —— 报错指向的地方不等于要验的地方。
     * 判据：**断言要锚定它要验的那个东西**，不能靠"块里有没有这种形状"。
     */
    const spreadPush = b.match(/results\.push\(\{[\s\S]*?\.\.\.outcome(?:Rest)?[\s\S]*?\}\)/)
    expect(spreadPush, '找不到展开 outcome 的那个 results.push').toBeTruthy()
    // 不许有"清空逐条 notice"的语句
    expect(b, '不该抹掉 results[i].notice —— 要逐条看的调用方就没得看了').not.toMatch(
      /delete .*notice|\.notice = undefined|notice: null/
    )
  })

  it('三个返回点都带聚合后的 notice（最容易漏的是 dry-run 与全失败）', () => {
    const b = batchBlock()
    const count = (b.match(/notices\.length \? \{ __notice: notices\.join\('\\n'\) \}/g) ?? []).length
    expect(
      count,
      `只有 ${count} 处带聚合 notice；应为 3 —— 正常 / 全失败 / dry-run`
    ).toBe(3)
  })

  it('无 notice 时不加空字段（别往信封里塞噪声）', () => {
    const b = batchBlock()
    // 条件展开而不是无条件给值
    expect(b.match(/notices\.length \?/g)?.length).toBe(3)
  })

  it('聚合发生在循环【之后】（中途状态会变，所以要收齐再算）', () => {
    const b = batchBlock()
    const loopEnd = b.indexOf('const noticeSet')
    const pushInside = b.indexOf('results.push')
    expect(
      loopEnd,
      '去重必须在所有结果收齐之后；放循环里等于每条各算一次（原缺陷）'
    ).toBeGreaterThan(pushInside)
  })

  it('去重结果用 join 合成一份（不是数组塞进信封）', () => {
    const b = batchBlock()
    expect(b).toMatch(/__notice: notices\.join\('\\n'\)/)
  })
})
