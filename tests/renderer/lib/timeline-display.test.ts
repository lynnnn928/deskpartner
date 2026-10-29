import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { planStamp, humanizeActor } from '../../../src/renderer/lib/timeline-display'

/**
 * 变更记录的展示判据（1.0.62）
 *
 * ── 这两个判据是怎么来的 ──
 *
 * 不是设计稿上想出来的，是**截图看出来的**。数据接通、单测全绿之后，
 * 截下详情抽屉才看见两个问题：
 *
 * 1. 五行流水的时刻全是「10:54」—— 同一批改动常落在同一分钟里，
 *    看完等于没给时间，还把行挤碎；
 * 2. 上面「提出者」那行显示「我」，流水里却写 `human` —— 同一个主体两种叫法。
 *
 * 这两件事都是"断言全绿但体验不对"，正是本轮选 ② 要修的那一类。
 * 所以必须补上断言：否则下次有人改了组件内联逻辑，回归时无人发觉。
 *
 * ⚠️ 反向验证：把 `planStamp` 的 `showTime` 恒改成 `true`，
 * 第一组断言应当变红。
 */

describe('planStamp：同一分钟只标一次时刻，跨天才起小标题', () => {
  it('同一分钟内的后续行不重复印时刻', () => {
    const a = planStamp('2026-09-30T02:54:10.000Z', null)
    const b = planStamp('2026-09-30T02:54:40.000Z', '2026-09-30T02:54:10.000Z')

    expect(a.showTime).toBe(true) // 第一行必印
    expect(b.showTime).toBe(false) // 同一分钟的后续行不印 —— 重复的 10:54 是纯噪音
  })

  it('跨分钟要重新印时刻', () => {
    const b = planStamp('2026-09-30T02:55:01.000Z', '2026-09-30T02:54:40.000Z')
    expect(b.showTime).toBe(true)
  })

  it('跨天起小标题，且当天第一行必印时刻', () => {
    const b = planStamp('2026-10-01T01:03:00.000Z', '2026-09-30T02:54:40.000Z')

    expect(b.newDay).toBe(true)
    expect(b.showTime).toBe(true)
    expect(b.dayLabel).toBeTruthy()
  })

  it('同一天内不起新小标题', () => {
    const b = planStamp('2026-09-30T06:00:00.000Z', '2026-09-30T02:54:40.000Z')
    expect(b.newDay).toBe(false)
  })

  it('第一行一定带日期小标题（否则看不到这条是哪天的事）', () => {
    expect(planStamp('2026-09-30T02:54:10.000Z', null).newDay).toBe(true)
  })
})

describe('humanizeActor：同一个面板里主体不能有两种叫法', () => {
  it('句首的 human 换成「我」', () => {
    const out = humanizeActor('human 覆写了描述正文：旧文「A」', 'human', null)
    expect(out.startsWith('我 ')).toBe(true)
    expect(out).not.toContain('human 覆写')
  })

  it('用她自己设的名字，而不是写死「我」', () => {
    const out = humanizeActor('human 把状态从「待办」推到「进行中」', 'human', '主用户')
    expect(out.startsWith('主用户 ')).toBe(true)
  })

  it('删评论的原作者位置也要换（第二个结构位置）', () => {
    const out = humanizeActor('human 删掉了 human 的一条评论：「…」', 'human', null)
    expect(out).toBe('我 删掉了 我 的一条评论：「…」')
  })

  it('agent 的动作人也换显示名（同一 agent 不能两个入口两种叫法）', () => {
    // 走 AGENT_LABELS：agent:alice → Alice
    const out = humanizeActor('agent:alice 覆写了描述正文', 'agent:alice', null)
    expect(out).toBe('Alice 覆写了描述正文')
  })

  it('表里没有的 agent 去掉 agent: 前缀显示（全站既有回退口径）', () => {
    // `ownerLabel` 对认不出的 agent 回退成「去掉前缀的 id」，不是原样 `agent:kimi`，
    // 也不是编一个名字。变更记录必须与动态页一致地走这条回退。
    const out = humanizeActor('agent:kimi 把状态从「待办」推到「进行中」', 'agent:kimi', null)
    expect(out).toBe('kimi 把状态从「待办」推到「进行中」')
  })

  it('引号里正文的 human 不能被改（改掉就不再是原文了）', () => {
    const out = humanizeActor(
      'human 删掉了 agent:qwen 的一条评论：「human 承诺过这件事」',
      'human',
      null
    )
    expect(out).toBe('我 删掉了 agent:qwen 的一条评论：「human 承诺过这件事」')
  })

  it('未记录的动作人不动', () => {
    const out = humanizeActor('未记录 · some_event', '未记录', null)
    expect(out).toBe('未记录 · some_event')
  })
})

/**
 * 结构性闸门：人类主体的显示名只有一个来源
 *
 * ── 为什么需要这条 ──
 *
 * 上面 `humanizeActor` 的用例全绿，界面却仍然不一致：同一个面板上方
 * 「提出者」按钮硬编码「我」，下方变更记录写「Alex」。**叶子函数测不到
 * 调用方有没有用这个函数** —— 这和上一版"单测全绿但界面没接入口"是同一形态。
 *
 * 实测口径（本轮数过）：卡片徽标 / 筛选栏 / 批处理栏 / 评论线程 / 动态页 /
 * 统计 共 8 处消费方，human 一律走 `ownerLabel`。所以"硬编码「我」"是漏用，
 * 不是有意为之的口径。
 *
 * 反向验证：把 OwnerPicker 的 `{humanLabel}` 改回字面量「我」，本组变红。
 */
describe('闸门：人类主体不出现第二套叫法', () => {
  const root = resolve(__dirname, '../../..')
  const read = (rel: string): string => readFileSync(resolve(root, rel), 'utf8')

  /** 递归收集 .tsx/.ts 源码（跳过测试与声明文件） */
  const walk = (dir: string, acc: string[] = []): string[] => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = resolve(dir, e.name)
      if (e.isDirectory()) walk(full, acc)
      else if (/\.tsx?$/.test(e.name) && !/\.d\.ts$/.test(e.name)) acc.push(full)
    }
    return acc
  }

  it('提出者 / 执行者按钮走 ownerLabel，不硬编码「我」', () => {
    const src = read('src/renderer/components/quick-add/OwnerPicker.tsx')
    expect(src).toContain('ownerLabel(')
    // 渲染成 JSX 文本节点的裸「我」= 又开了一套叫法
    expect(src).not.toMatch(/>\s*我\s*<\//)
  })

  it('全渲染层没有第二处硬编码的人类主体名', () => {
    // 只查 JSX 文本节点形态的「我」，不查注释与 tooltip ——
    // tooltip 是对操作者说话（"我提出的"），指向点与按钮命名不同，不算第二套叫法。
    const offenders = walk(resolve(root, 'src/renderer'))
      .filter((f) => /(^|\n)\s*我\s*(?=\n|$)/.test(read(f)))
      .map((f) => f.slice(root.length + 1))

    expect(offenders).toEqual([])
  })

  it('变更记录与动态页共用同一份显示名判据（这是两轮反复的根因）', () => {
    // 只靠"两边各自调 ownerLabel"是不够的 —— 必须证明两边都从这一处转。
    // 变更记录经 humanizeActor、动态页直接调 ownerLabel，函数体内都得落到 ownerLabel。
    const impl = read('src/renderer/lib/timeline-display.ts')
    expect(impl).toMatch(/ownerLabel\(/)

    const timelineView = read('src/renderer/components/timeline/TimelineView.tsx')
    expect(timelineView).toMatch(/ownerLabel\(event\.actor/)
  })

  it('行为断言：agent 的动作人确实换了名（比查源码字面量可靠）', () => {
    // 反向保护：若 `humanizeActor` 退回"只换 human"，这条会红。
    // 用**行为**而不是 "源码里没有 if (actor !== 'human')" ——
    // 后者会被注释里的同一句话误伤（本轮真踩过）。
    expect(humanizeActor('agent:alice 做了事', 'agent:alice', null)).not.toContain(
      'agent:alice'
    )
    expect(humanizeActor('agent:alice 做了事', 'agent:alice', null)).toContain('Alice')
  })
})
