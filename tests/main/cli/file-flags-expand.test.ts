/**
 * 文件入参的展开逻辑（1.0.73，续做 `3c522bdb`）
 *
 * ## 为什么这条测试能防住真实事故
 *
 * `--comment-file` 那次事故之所以能逃掉，是因为**没有任何测试碰过"展开"这个动作**：
 * 声明在命令表里（于是 help/schema 都能看见它），却没有一条路径真的读过它指向的文件。
 * 「声明存在」被当成了「功能存在」——而这两件事之间隔着两个进程、两份表。
 *
 * 这里测的是**判定本身**（注入假 reader，不碰磁盘）：
 * 单条路径与 batch 路径**必须展开同一份清单**，
 * 且展开结果要能被 `parseFlags` 原样消费。
 */
import { describe, it, expect } from 'vitest'
import { expandFileFlags, expandFileFlagsInBatch, FILE_FLAGS } from '../../../src/cli/file-flags'

/** 假 reader：只认这几个"虚拟文件"，内容里故意放多行与反引号 —— 正是 shell 会吞的字符 */
const fakeFiles: Record<string, string> = {
  'a.txt': '第一行\n第二行 `x` $VAR',
  'b.txt': '正文',
  'c.txt': '收口结论：状态不能改一半'
}
const read = (f: string): string => {
  if (!(f in fakeFiles)) throw new Error(`ENOENT: no such file or directory, open '${f}'`)
  return fakeFiles[f]
}

describe('文件入参展开（3c522bdb 续）', () => {
  it('单条路径：--comment-file 展开成 --comment（多行与反引号原样保留）', () => {
    const out = expandFileFlags(
      ['todo', 'update', 'abc', '--status', 'in_progress', '--comment-file', 'c.txt'],
      read
    )
    expect(out).toEqual([
      'todo',
      'update',
      'abc',
      '--status',
      'in_progress',
      '--comment',
      '收口结论：状态不能改一半'
    ])
  })

  it('单条路径：支持 --flag=path 等号写法（与 parseFlags 的取值形态一致）', () => {
    const out = expandFileFlags(['todo', 'comment', 'x', '--body-file=b.txt'], read)
    expect(out).toEqual(['todo', 'comment', 'x', '--body', '正文'])
  })

  it('每个登记的文件参数都能展开（不遗漏清单里的任何一项）', () => {
    for (const f of FILE_FLAGS) {
      const out = expandFileFlags(['cmd', f.flag, 'b.txt'], read)
      expect(out, `${f.flag} 没有展开成 ${f.target}`).toEqual(['cmd', f.target, '正文'])
    }
  })

  /**
   * 读不到文件必须**抛错**，不能静默跳过。
   * 静默跳过 = 又回到"内容丢了但命令成功"那一类缺陷（本卡治的就是它）。
   */
  it('读不到文件时抛错，不静默跳过', () => {
    expect(() => expandFileFlags(['cmd', '--comment-file', 'missing.txt'], read)).toThrow(
      /--comment-file 读不到/
    )
  })

  it('缺文件路径时抛错（--flag 后面没值）', () => {
    expect(() => expandFileFlags(['cmd', '--comment-file'], read)).toThrow(/需要一个文件路径/)
  })

  it('不认识 --flag 时原样透传（不误伤别的参数）', () => {
    const out = expandFileFlags(['cmd', '--title', '正常标题', '--status', 'todo'], read)
    expect(out).toEqual(['cmd', '--title', '正常标题', '--status', 'todo'])
  })

  /**
   * batch 路径：这条是 1.0.41 那次事故的直接守卫 ——
   * 当时 `batch` 里的 `--desc-file` 被静默忽略，内容整段丢。
   */
  it('batch 路径：每行的文件参数都被展开（不是只处理第一条）', () => {
    const stdin = [
      JSON.stringify({ args: { title: 'A', '--desc-file': 'a.txt' } }),
      JSON.stringify({ args: { title: 'B', '--desc-file': 'b.txt' } })
    ].join('\n')
    const out = expandFileFlagsInBatch(['batch'], stdin, read)!
    const lines = out.split('\n').map((l) => JSON.parse(l) as { args: Record<string, string> })
    expect(lines[0].args['--desc']).toBe('第一行\n第二行 `x` $VAR')
    expect(lines[1].args['--desc']).toBe('正文')
    // 展开后不该留下 -file 形态（服务端收到它会明确报错）
    expect(lines[0].args['--desc-file']).toBeUndefined()
  })

  it('batch 路径：--comment-file 同样被展开（本卡新增的那一条）', () => {
    const stdin = JSON.stringify({ args: { id: 'x', '--status': 'in_progress', '--comment-file': 'c.txt' } })
    const out = expandFileFlagsInBatch(['batch'], stdin, read)!
    const obj = JSON.parse(out) as { args: Record<string, string> }
    expect(obj.args['--comment']).toBe('收口结论：状态不能改一半')
    expect(obj.args['--comment-file']).toBeUndefined()
  })

  it('batch 路径：非 batch 命令不动 stdin（单条已在上游展开）', () => {
    const stdin = JSON.stringify({ args: { '--desc-file': 'a.txt' } })
    expect(expandFileFlagsInBatch(['todo', 'add'], stdin, read)).toBe(stdin)
  })

  it('batch 路径：非 JSON 行原样透传（让服务端去报它该报的错）', () => {
    const stdin = 'not json at all'
    expect(expandFileFlagsInBatch(['batch'], stdin, read)).toBe(stdin)
  })

  it('batch 路径：读不到文件时抛错，不静默丢内容', () => {
    const stdin = JSON.stringify({ args: { '--desc-file': 'missing.txt' } })
    expect(() => expandFileFlagsInBatch(['batch'], stdin, read)).toThrow(/--desc-file 读不到/)
  })

  /**
   * 清单本身不许出现重复 flag —— 重复会让 `find` 取到哪一条变得不确定，
   * 而两条指向不同目标时，`--desc-file` 可能展开成 `--body`。
   */
  it('清单里 flag 与 target 都不重复', () => {
    const flags = FILE_FLAGS.map((f) => f.flag)
    const targets = FILE_FLAGS.map((f) => f.target)
    expect(new Set(flags).size, '有重复的 file flag').toBe(flags.length)
    expect(new Set(targets).size, '有重复的 target —— 展开结果不确定').toBe(targets.length)
  })

  it('每条 flag 都以 -file 结尾、target 都不以 -file 结尾（形态自洽）', () => {
    for (const f of FILE_FLAGS) {
      expect(f.flag, `${f.flag} 不像文件参数`).toMatch(/-file$/)
      expect(f.target, `${f.target} 不该是文件参数 —— 展开会陷入自指`).not.toMatch(/-file$/)
    }
  })
})
