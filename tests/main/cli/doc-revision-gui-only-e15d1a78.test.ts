import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 「文档历史只给界面」这道结构性闸门（卡 `e15d1a78`）
 *
 * ── 要拦的是什么 ──
 *
 * 主用户 2026-11-04 定口径：这版**只给界面，不新增 CLI 出口**。
 * 而"记录一版"这个动作很容易被顺手加到别处，两种加错都悄悄坏掉：
 *
 * 1. 加进仓储的 `readProjectDoc`（看着最顺手）—— 于是 CLI 的 `doc show`
 *    也开始写库，而这条命令**声明着 `readOnly`**（宿主据此决定要不要弹确认）。
 *    行为用例在 `tests/main/database/project-doc-revisions-e15d1a78.test.ts`
 *    里已经钉住"仓储的读不写库"，这条再钉一次**记录点只有一处**。
 * 2. 把界面那处的记录删掉/挪走 —— 于是历史永远空白，而没有任何一处报错。
 *
 * ── 判据（可判别，不是永远绿） ──
 *
 * - `src/main/ipc.ts` 的 `project:readDoc` 处理体里必须有记录调用（界面的唯一记录点）；
 * - `recordDocRevision` 在仓储里只出现一次（它自己的定义），在 CLI 命令文件里 0 次；
 * - 命令表里没有 `docRevision` / `doc-revision` 这类出口，且 `doc show` 仍是只读；
 * - 抽屉文案里的版本上限与仓储常量 `DOC_REVISION_LIMIT` 同值（改常量忘改文案会红）。
 *
 * ── 反向验证（写完立即逐个做过，三种注入都真变红） ──
 *
 * - 把 `ipc.ts` 里那句记录调用注释掉 → 第 1 条红
 *   （判据是**行首的真调用**：只在注释里提到这个名字不算数，第一版判据栽在这里）；
 * - 在 `src/main/cli/commands/doc.ts` 里加一句 `recordDocRevision` → 第 2 条红；
 * - 把抽屉里的「保留最近 20 版」改成 30 → 第 4 条红。
 */
vi.mock('../../../src/main/database/index', () => ({
  getDatabase: () => {
    throw new Error('这道闸门只读源码，不碰库')
  }
}))

const { DOC_REVISION_LIMIT } = await import('../../../src/main/database/project.repository')
const { commands, commandUsage } = await import('../../../src/main/cli/commands')

const ROOT = path.resolve(__dirname, '../../..')
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8')

const countOf = (src: string, needle: string): number => src.split(needle).length - 1

/** 取某个 `ipcMain.handle('通道')` 的处理体（到下一个 handle 之前） */
function handlerBody(src: string, channel: string): string {
  const at = src.indexOf(`ipcMain.handle('${channel}'`)
  expect(at, `src/main/ipc.ts 里没有注册 ${channel}`).toBeGreaterThanOrEqual(0)
  const next = src.indexOf('ipcMain.handle(', at + 1)
  return src.slice(at, next < 0 ? undefined : next)
}

describe('文档历史只给界面', () => {
  it('1. 界面那条读出口里记一版快照（IPC project:readDoc）', () => {
    const ipc = read('src/main/ipc.ts')
    const body = handlerBody(ipc, 'project:readDoc')
    expect(body).toMatch(/^\s*const doc = projectRepo\.readProjectDoc\(/m)
    // 判据要能区分"注释里的名字"：必须是真调用（行首就是调用，没有被注释掉）
    expect(body, '界面读文档的地方必须真记一版，否则历史永远是空的').toMatch(
      /^\s*projectRepo\.recordDocRevision\(/m
    )
    // 历史读取通道也要在（渲染层声明与主进程注册两侧一致由 scripts/check-ipc-channels.mjs 管）
    expect(handlerBody(ipc, 'project:docRevisions')).toContain('listProjectDocRevisions(')
  })

  it('2. 记录点只有一处：仓储与 CLI 都不写（读命令声明着 readOnly）', () => {
    const repo = read('src/main/database/project.repository.ts')
    expect(
      countOf(repo, 'recordDocRevision'),
      '仓储里只该有 recordDocRevision 自己的定义；多出来的调用点多半加在了 readProjectDoc 上'
    ).toBe(1)
    expect(countOf(read('src/main/ipc.ts'), 'recordDocRevision')).toBe(1)
    expect(countOf(read('src/main/cli/commands/doc.ts'), 'recordDocRevision')).toBe(0)
    // 侧重不合的读命令还有 archive.ts / ops.ts 之类也要干净：全仓 CLI 命令层一处不许有
    const cliDir = path.join(ROOT, 'src/main/cli/commands')
    const offenders = fs
      .readdirSync(cliDir)
      .filter((f) => f.endsWith('.ts'))
      .filter((f) => read(path.join('src/main/cli/commands', f)).includes('recordDocRevision'))
    expect(offenders).toEqual([])
  })

  it('3. 没有 CLI 出口，且 doc show 仍是只读命令', () => {
    const names = commands.map((c) => c.name)
    expect(names.filter((n) => /docRevision|doc-revision/i.test(n))).toEqual([])
    const docRead = commands.find((c) => c.name === 'doc show')
    expect(docRead, '命令表里该有 doc show').toBeTruthy()
    expect(commandUsage(docRead!).readOnly, 'doc show 一旦变成写命令，它就该被重新讨论').toBe(true)
  })

  it('4. 抽屉写的版本上限与仓储常量同值', () => {
    const drawer = read('src/renderer/components/project/DocRevisionsDrawer.tsx')
    const hit = drawer.match(/保留最近\s*(\d+)\s*版/)
    expect(hit, '抽屉里应写明保留多少版').toBeTruthy()
    expect(Number(hit![1])).toBe(DOC_REVISION_LIMIT)
  })
})
