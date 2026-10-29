import { describe, it, expect } from 'vitest'
import { buildDescChangeEvent } from '../../../src/main/lib/desc-audit'

/**
 * 描述变更的留痕判据（1.0.62）
 *
 * 这组用例存在的原因是：它决定"哪一次改动会被记住"。
 * 判错了不会报错，只会让某类改动**安静地没有痕迹** ——
 * 而"当时写的是什么"恰恰是事后唯一能追问的东西。
 *
 * 另一头也不能过头：追加场景若也存一份 before，同一段正文会在 events 里
 * 存两遍（原文通常很长的规格文本），事件表很快被撑大到触发清理策略，
 * 反而把真正需要留的旧记录挤掉。所以"什么时候不记 before"同样要有断言。
 */
describe('buildDescChangeEvent', () => {
  it('没提到描述就不是描述变更', () => {
    expect(buildDescChangeEvent('旧规格', undefined)).toBeNull()
  })

  it('原先没有描述时，从无到有不算"冲掉了什么"', () => {
    expect(buildDescChangeEvent(null, '第一版规格')).toBeNull()
  })

  it('一字未改不产生噪音', () => {
    expect(buildDescChangeEvent('同一个规格', '同一个规格')).toBeNull()
  })

  it('追加：判为 append，且不重复存一份原文', () => {
    const ev = buildDescChangeEvent('原文ABC', '原文ABC\n\n追加说明')
    expect(ev).not.toBeNull()
    expect(ev!.mode).toBe('append')
    expect(ev!.before).toBeNull()
    expect(ev!.after).toBe('原文ABC\n\n追加说明')
  })

  it('整体替换：把被改掉的原文完整留下（这是能找回的前提）', () => {
    const ev = buildDescChangeEvent('被覆盖的原文', '全新的规格')
    expect(ev!.mode).toBe('replace')
    expect(ev!.before).toBe('被覆盖的原文')
    expect(ev!.after).toBe('全新的规格')
  })

  it('清空也要留痕：删掉规格是最需要对证的一种改动', () => {
    const ev = buildDescChangeEvent('曾经写过的规格', null)
    expect(ev!.mode).toBe('replace')
    expect(ev!.before).toBe('曾经写过的规格')
    expect(ev!.after).toBeNull()
  })
})
