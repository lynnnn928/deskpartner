import { describe, it, expect } from 'vitest'
import { pickExecSummary } from '../../../src/main/lib/exec-summary'

/**
 * 成功回执摘要的取值（1.0.62，收 10f0a5d6 最后一段）
 *
 * 这里锁住的是一条边界：**宁可交白卷，也不许编一句像回执的话**。
 * `requestArgv`（被批准的命令原文）是现成可用的字符串，把它当回执最省事 ——
 * 但它回答的是"批准了什么请求"，而不是"跑完之后发生了什么"。
 * 一旦两者混为一谈，流水里那些成功记录会长得一模一样
 * （"已执行：todo delete-comment xxx"），看上去有回执、实则什么都没说。
 */
describe('pickExecSummary', () => {
  it('优先取命令自带的那句人话 message', () => {
    expect(pickExecSummary({ ok: true, message: '评论已删除，连带清掉 2 条回复。' })).toBe(
      '评论已删除，连带清掉 2 条回复。'
    )
  })

  it('顶层 message 空缺时，退到结构化结果里的 message', () => {
    expect(pickExecSummary({ ok: true, data: { message: '已归档 3 条' } })).toBe('已归档 3 条')
  })

  /**
   * ⚠️ 这条断言在 1.0.65 **被反转过**（`10fcb47f` D3），不是改口味。
   *
   * 原断言："最后退到 notice —— 成功了但有话要说，那句话本身就是回执"。
   * 它把 notice 当成了"实在没话说时的兜底"，但 notice 的语义是
   * "**另有一件事**要告诉你"，而那件事通常是**跨命令**的：
   * 执行链路会在成功时附带未读摘要（"你有 1 条事项被退回…[未读] 有 2 张未读纸条…"）。
   *
   * 后果不是"摘要写得不够准"，而是**审批流水不可读**：
   * 授权记录 `exec_summary` 里，一条 `todo rm` 的回执写着"你有 2 张未读纸条"，
   * 实测至少 6 条完全一样（0a2db2d7 / 7a2a690c / 6c26b3be / 1e1ca300 / a3671756 / df934133）。
   * 它回答的是"未读有几条"，而这一列要回答的是"批准后删掉了什么"。
   *
   * 判据：**回执只回答"这次动作的结果"；跨命令的旁支消息有它自己的去处。**
   */
  it('不拿 notice 兜底：旁支消息不是这次动作的结果（10fcb47f D3）', () => {
    expect(
      pickExecSummary({
        ok: true,
        notice: 'G3：该项目下还有 2 条未标注版本'
      }),
      'notice 是"另一件事"，不是回执'
    ).toBeNull()
  })

  it('真实故障形状：执行链路附带的未读摘要不得写进回执', () => {
    // 这就是 6 条授权记录里存着的那个形状
    const polluted = pickExecSummary({
      ok: true,
      notice: '你有 1 条事项被验收方退回，还在「进行中」：[未读] 有 2 张未读纸条（…）'
    })
    expect(polluted, '未读摘要混进回执 = 审批流水答非所问').toBeNull()
  })

  it('message 在时仍然用它（notice 不参与，但真回执不会被丢掉）', () => {
    expect(
      pickExecSummary({ ok: true, message: '已删除 1 条事项', notice: '你有 2 张未读纸条' })
    ).toBe('已删除 1 条事项')
  })

  it('三者都没有时返回 null，不把命令原文伪装成回执', () => {
    expect(pickExecSummary({ ok: true, data: { ok: true }, code: 0 })).toBeNull()
  })

  it('空白与空串等同没有，不输出空白回执', () => {
    expect(pickExecSummary({ ok: true, message: '   ', data: { message: '' } })).toBeNull()
  })

  it('data 不是对象时不炸，按没有摘要处理', () => {
    expect(pickExecSummary({ ok: true, data: 'plain text' })).toBeNull()
    expect(pickExecSummary({ ok: true, data: null })).toBeNull()
  })
})
