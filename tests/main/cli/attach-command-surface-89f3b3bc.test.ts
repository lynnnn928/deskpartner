import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * `todo attach` / `todo attachments` 的命令面（卡 `89f3b3bc`，1.0.146）
 *
 * ── 为什么另起一份，而不并进 `todo-attachments-89f3b3bc.test.ts` ──
 *
 * 那份是**行为**用例（真库、真复制），它 import 了 better-sqlite3，只有 Node 22
 * 跑得起来；而 `scripts/verify-gates-reverse.cjs` 用 `process.execPath` 起 vitest
 * （本机裸 `node` 是 24，ABI 137）—— 挂上去基线就是红的，反向验证整轮判失败。
 * 所以**反向验证打的这几条判据要住在源码闸门里**：读文件、断言字，不碰原生模块。
 * 行为层的表现由那份用例在全量 `run-tests`（Node 22）里守。
 */
const ROOT = path.resolve(__dirname, '../../..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n')

describe('agent 用附件的命令面（卡 89f3b3bc）', () => {
  const todo = read('src/main/cli/commands/todo.ts')
  const sliceFrom = (start: string, end: string) => {
    const a = todo.indexOf(start)
    const b = todo.indexOf(end, a + 1)
    return todo.slice(a, b)
  }
  const attach = sliceFrom("name: 'todo attach',", "name: 'todo set-owner'")
  const list = sliceFrom("name: 'todo attachments',", "name: 'todo attach',")

  it('挂附件是**日常写入**档（2026-11-12 主用户拍板：凭身份直通，不逐条审批）', () => {
    expect(attach).toContain("risk: 'write'")
    expect(attach).not.toContain("risk: 'destructive'")
    // 那条读命令是只读：不该进写档、也不该要授权
    expect(list).toContain('readOnly: true')
    expect(list).not.toContain('risk:')
  })

  it('参数叫 --path，不叫 --file', () => {
    /**
     * `-file` 在这个仓库里是**内容展开**那一族的命名（`--desc-file` → 读文件、
     * 把内容塞进 `--desc`，单源表在 `src/cli/file-flags.ts`）。挂附件要的是
     * **路径本身**，名字撞上那一族会被参数接线闸门拦下（实测拦过一次）。
     */
    expect(attach).toContain("flag: '--path'")
    expect(attach).not.toContain("flag: '--file'")
  })

  it('两条命令都真的落到附件仓储上（读元数据 / 写一份）', () => {
    expect(list).toContain('ctx.deps.attachmentRepo.list(id)')
    expect(list).toContain('ctx.deps.attachmentRepo.totalBytes(id)')
    expect(attach).toContain('ctx.deps.attachmentRepo.add({')
    // 写之前过身份这道闸（未注册的自称只能读）
    expect(attach).toContain('assertRegisteredActor(ctx, actor)')
  })

  it('失败原因是照实抛出去的一句话（超限 / 不是文件 / 读不到），不吞成 ok', () => {
    expect(attach).toContain('if (bad) {')
    expect(attach).toContain('throw new UsageError(bad.reason)')
  })

  it('回执形状在命令面清单里登记了（漏登记由 write-receipt-shapes 那条闸门兜住）', () => {
    const inv = read('src/main/cli/surface-inventory.ts')
    expect(inv).toContain("'todo attach': {")
    expect(inv).toContain("'createdBy'")
  })

  it('两条真跑闸门的夹具都给了**真的** --path（否则命令在 fixture 上跑不动）', () => {
    for (const f of [
      'tests/main/cli/write-receipt-shapes-cd5f3832.test.ts',
      'tests/main/cli/receipt-contract-self-report.test.ts'
    ]) {
      const src = read(f)
      expect(src, `${f} 没给 todo attach 备一个真文件`).toContain("'todo attach': { '--path'")
      expect(src, `${f} 的 deps 缺 attachmentRepo`).toMatch(/attachmentRepo/)
    }
  })
})
