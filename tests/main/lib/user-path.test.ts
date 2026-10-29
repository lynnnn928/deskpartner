import { describe, it, expect } from 'vitest'
import {
  mergeUserPath,
  isDeskPartnerCliEntry,
  normalizePathEntry
} from '../../../src/main/lib/user-path'

/**
 * 用户 PATH 合并逻辑的回归测试（1.0.55）
 *
 * 背景：上一版 `ensurePathContains` 用 `fs.existsSync` 决定"哪些条目该清"，
 * 把主用户本机的 `HKCU\Environment\Path` 从 **7 项删到只剩 1 项**。
 * 这条逻辑破坏的是**用户自己的环境变量**，且要下次开终端才暴露 ——
 * 所以它必须有测试守着，不能只靠代码里写一句注释。
 *
 * 这里的 `exists` 全部是注入的假函数 —— 正好说明"文件系统是否此刻可读"
 * 与"这条 PATH 该不该留"是两件事。
 */

const exists = (present: string[]) => (p: string) =>
  present.map((x) => normalizePathEntry(x)).includes(normalizePathEntry(p))

const CLI_DIR = 'C:\\Apps\\测试应用\\DeskPartner\\resources\\cli'

describe('mergeUserPath（1.0.55：绝不误删用户 PATH）', () => {
  it('别人的条目全是"此刻读不到"，也一条都不删 —— 这是那次事故的正面回归', () => {
    const parts = [
      'C:\\Tools\\.kimi-code\\bin',
      'C:\\Tools\\AppData\\Local\\Microsoft\\WindowsApps',
      'C:\\Apps\\VSCode\\bin',
      'Z:\\网络盘\\tools', // 此刻读不到：盘没挂载
      'E:\\外接盘\\bin' // 此刻读不到：设备没插
    ]

    const { next, removed } = mergeUserPath(parts, CLI_DIR, exists([]))

    expect(removed).toBe(0)
    expect(next).toEqual([...parts, CLI_DIR])
  })

  it('清掉我们自己的失效旧条目（那是真失效）', () => {
    const stale = 'C:\\Apps\\TestApps\\DeskPartner\\resources\\cli'
    const parts = ['C:\\Windows\\System32', stale]

    const { next, removed } = mergeUserPath(parts, CLI_DIR, exists(['C:\\Windows\\System32']))

    expect(removed).toBe(1)
    expect(next).toEqual(['C:\\Windows\\System32', CLI_DIR])
  })

  it('我们自己的旧条目若还能读到，也留着（别动可能还有人用的路径）', () => {
    const other = 'C:\\Apps\\OldPlace\\DeskPartner\\resources\\cli'
    const parts = [other]

    const { next, removed } = mergeUserPath(parts, CLI_DIR, exists([other]))

    expect(removed).toBe(0)
    expect(next).toEqual([other, CLI_DIR])
  })

  it('已经在了就只补齐、不重复追加', () => {
    const parts = ['C:\\Windows', CLI_DIR]

    const { next, already, removed } = mergeUserPath(parts, CLI_DIR, exists([]))

    expect(already).toBe(true)
    expect(removed).toBe(0)
    expect(next).toEqual(parts)
    expect(next.filter((p) => normalizePathEntry(p) === normalizePathEntry(CLI_DIR))).toHaveLength(1)
  })

  it('大小写/尾斜杠不同也认成同一个目录，不做重复条目', () => {
    const parts = [CLI_DIR.toUpperCase().replace('\\CLI', '\\cli\\')]

    const { already, next } = mergeUserPath(parts, CLI_DIR, exists([]))

    expect(already).toBe(true)
    expect(next).toHaveLength(1)
  })

  it('空 PATH 时直接给出单条，不崩', () => {
    const { next, already, removed } = mergeUserPath([], CLI_DIR, exists([]))
    expect(already).toBe(false)
    expect(removed).toBe(0)
    expect(next).toEqual([CLI_DIR])
  })

  it('只认自家残骸：长得像但不是 resources\\cli 的不动', () => {
    const parts = ['D:\\Tools\\cli', 'C:\\Apps\\DeskPartner\\resources']

    const { next, removed } = mergeUserPath(parts, CLI_DIR, exists([]))

    expect(removed).toBe(0)
    expect(next).toEqual([...parts, CLI_DIR])
  })
})

describe('isDeskPartnerCliEntry', () => {
  it('正反两面都认（反斜杠 / 正斜杠都算）', () => {
    expect(isDeskPartnerCliEntry('C:\\Apps\\DeskPartner\\resources\\cli')).toBe(true)
    expect(isDeskPartnerCliEntry('C:/Apps/DeskPartner/resources/cli')).toBe(true)
    expect(isDeskPartnerCliEntry('C:\\Apps\\DeskPartner\\resources\\cli\\')).toBe(true)
  })

  it('别的目录一律不认', () => {
    expect(isDeskPartnerCliEntry('C:\\Windows\\System32')).toBe(false)
    expect(isDeskPartnerCliEntry('C:\\Apps\\DeskPartner\\resources')).toBe(false)
    expect(isDeskPartnerCliEntry('')).toBe(false)
  })
})
