import { describe, it, expect } from 'vitest'
import { diffLines, diffStats } from '../../../src/renderer/lib/line-diff'

const types = (a: string, b: string) => diffLines(a, b).map((l) => `${l.type}:${l.text}`)

describe('diffLines 行级差异', () => {
  it('完全相同：全是 same，零增删', () => {
    const d = diffLines('a\nb\nc', 'a\nb\nc')
    expect(d.every((l) => l.type === 'same')).toBe(true)
    expect(diffStats(d)).toEqual({ added: 0, removed: 0 })
  })

  it('新增一行（绿）/ 删除一行（红）', () => {
    expect(types('a\nc', 'a\nb\nc')).toEqual(['same:a', 'add:b', 'same:c'])
    expect(types('a\nb\nc', 'a\nc')).toEqual(['same:a', 'del:b', 'same:c'])
  })

  it('修改一行 = 先删旧后加新', () => {
    expect(types('a\nOLD\nc', 'a\nNEW\nc')).toEqual(['same:a', 'del:OLD', 'add:NEW', 'same:c'])
  })

  it('空串视为 0 行：从无到有全是新增，清空全是删除', () => {
    expect(types('', 'x\ny')).toEqual(['add:x', 'add:y'])
    expect(types('x\ny', '')).toEqual(['del:x', 'del:y'])
    expect(diffLines('', '')).toEqual([])
  })

  it('CRLF 与 LF 不造成整篇改动', () => {
    const d = diffLines('a\r\nb\r\n', 'a\nb\n')
    expect(diffStats(d)).toEqual({ added: 0, removed: 0 })
  })

  it('重复行与移动：增删数量正确，还原得回两端文本', () => {
    const a = 'x\ny\nx\nz'
    const b = 'z\nx\ny\nx\nw'
    const d = diffLines(a, b)
    const rebuiltA = d.filter((l) => l.type !== 'add').map((l) => l.text).join('\n')
    const rebuiltB = d.filter((l) => l.type !== 'del').map((l) => l.text).join('\n')
    expect(rebuiltA).toBe(a)
    expect(rebuiltB).toBe(b)
  })

  it('统计：多处改动分别计数', () => {
    const d = diffLines('1\n2\n3\n4', '1\nTWO\n3\n4\n5')
    expect(diffStats(d)).toEqual({ added: 2, removed: 1 })
  })

  it('大文本性能：2000 行里改 3 行也能瞬时完成（公共前后缀不进 DP）', () => {
    const base = Array.from({ length: 2000 }, (_, i) => `line ${i}`)
    const changed = [...base]
    changed[1000] = 'changed'
    changed.splice(1500, 0, 'inserted')
    changed.splice(10, 1)
    const t0 = Date.now()
    const d = diffLines(base.join('\n'), changed.join('\n'))
    expect(Date.now() - t0).toBeLessThan(2000)
    expect(diffStats(d)).toEqual({ added: 2, removed: 2 })
  })
})
