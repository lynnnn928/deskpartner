import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = readFileSync(
  join(__dirname, '../../../src/renderer/components/notification/NotificationsView.tsx'),
  'utf-8'
)
const REPO_SRC = readFileSync(
  join(__dirname, '../../../src/main/database/todo.repository.ts'),
  'utf-8'
)

/**
 * 动态里要看得见"被驳回"（1.0.72 补，主用户看动态时指出）
 *
 * ## 实况（不是推断，是逐段核过的）
 *
 * 数据层**一直在写**驳回标记：1.0.65 起
 * `todo.repository.ts` 落一条 `type: 'review'` + `meta: { rejected: true }` 的通知。
 * 而渲染层**从来没读过它** —— 分类标签一律取 `TYPE_META[n.type].label`，
 * 那个值是「交付」。
 *
 * 于是一条被退回的卡在动态里长这样：
 *   「验收未通过，已退回：xxx」
 *    交付 · agent:bob · 10 分钟前        <- 标签自相矛盾
 *
 * 标题里有"已退回"，标签写"交付"。**最需要被看见的那个事实没有位置。**
 * 而人会照着标签读列表 —— 他扫的是分类那一列。
 *
 * ## 为什么用源码断言而不是真渲染
 *
 * 真渲染要拖进 `invoke`、settings、i18n、图标表一整套依赖，
 * 成本高且脆（改个 import 就红，而它守的只是一个标签）。
 * 本项目已有同法先例（`acceptance-wording.test.ts` / `no-emoji.test.ts`）。
 *
 * ⚠️ 但**断言语义不绑写法**：下面盯的是"读没读 `rejected` 标记"与
 * "渲染时有没有按它改标签"，不是某一行长什么样 ——
 * 源码断言最常见的坏法就是把实现细节钉死，害得下一次正当重构变成事故。
 */
describe('动态里能看见驳回（1.0.72）', () => {
  it('前置：数据层确实在写 meta.rejected —— 没有这条，界面无从判断', () => {
    expect(
      REPO_SRC,
      '数据层不再写 meta.rejected 了；若这是有意改动，本测试要一起更新'
    ).toMatch(/rejected:\s*true/)
  })

  it('渲染层读了 rejected 标记（此前是只写不读的死字段）', () => {
    expect(
      SRC,
      'NotificationsView 没有解析 meta.rejected —— 驳回通知会与"交付待验收"长得一样'
    ).toMatch(/meta\.rejected/)
  })

  it('标签按是否被驳回而不同（不是同一个 TYPE_META.label）', () => {
    // 必须存在一个"被驳回时用的另一个标签"
    expect(
      SRC,
      '没有为驳回单独给标签 —— 分类那一列仍然会写「交付」'
    ).toMatch(/label\s*=\s*rejected\s*\?/)
    expect(SRC).toMatch(/'退回'/)
  })

  /**
   * 视觉也要分开。
   *
   * 只改文字不改图标/颜色的话，那一列还是"交付"的颜色（琥珀色 = 待办类），
   * 而驳回是"要你重做"——扫一眼时颜色比文字先到。
   * 复用 `execOk === false` 那条已有的红色告警路径，不新造一套样式。
   */
  it('被驳回的条目用告警色与告警图标（扫一眼要能先认出来）', () => {
    expect(SRC).toMatch(/isRejectLook/)
    expect(SRC).toMatch(/execOk === false \|\| isRejectLook \? 'alertTriangle'/)
  })

  /**
   * 判据：数据层写了的标记，渲染层必须读。
   *
   * 钉这一条是因为本项目已经吃过一次同族亏 ——
   * `G8` 提醒在管道通道下 `process.env` 恒为空、提醒静默失效，
   * 而"机制在不在"两种情况下都成立，只有实际行为不同。
   * 只写不读的标记属于同一类：它让代码看起来有防护，实际没有。
   */
  it('反向判据：没有"只写不读"—— 解析函数真的被用上了', () => {
    const fnName = (SRC.match(/function (isRejectedNotice)\b/) ?? [])[1]
    expect(fnName, '找不到 isRejectedNotice').toBeTruthy()
    const uses = SRC.match(new RegExp(`${fnName}\\(n\\.meta\\)`, 'g'))
    expect(uses, 'isRejectedNotice 定义了却没被调用 —— 仍然是只写不读').toBeTruthy()
  })
})
