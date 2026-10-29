import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '../../..')
const read = (relative: string) => fs.readFileSync(path.join(ROOT, relative), 'utf8')

const sidebar = read('src/renderer/components/kanban/Sidebar.tsx')
const store = read('src/renderer/stores/project.store.ts')

/**
 * 侧栏里的项目删除（卡 `c177e466`，口径来自主用户 2026-10-09 拍板）
 *
 * **界面优先建议归档；坚持永久删除就清空整个项目数据，不保留。**
 *
 * 改之前是这样：删除对话框只问"迁到哪个项目"，`submitDelete` 把事项一条条
 * 改挂到承接项目上再删项目 —— 而落点有默认值（除自己以外的第一个项目），
 * 于是**不选承接项目也能删**（主用户 2026-10-22 复核时点出的正是这条）。
 * 顺带还有个隐形后果：本机只有这一个项目时事项的 project_id 会被置空。
 *
 * 这个文件是源码文本闸门（与 `main-navigation.test.ts` 同款）：
 * 界面上"删得安不安全"取决于这些具体写法在不在，靠人记得去点一遍不可靠。
 */
describe('侧栏项目：归档优先，永久删除必须二次确认（卡 c177e466）', () => {
  it('没有"先迁走再删"了：承接项目下拉没了，也不再逐条改事项归属', () => {
    expect(sidebar, '承接项目的 state 应删掉').not.toContain('moveTarget')
    expect(sidebar, '旧按钮文案应删掉').not.toContain('迁移并删除')
    expect(sidebar, '承接项目用的 Select 不再需要').not.toContain("from '../ui/Select'")
    expect(sidebar, '不能再逐条把事项改挂到别的项目').not.toContain('projectId: target')
    expect(sidebar, '这条旧提示属于已移除的迁移分支').not.toContain('请先创建另一个项目')
  })

  it('永久删除就是删这一个项目，直接把 id 交给数据层', () => {
    expect(sidebar).toContain('await deleteProject(deleting)')
    expect(store, '界面不参与迁移，只把 id 传下去').toContain("invoke('project:delete', { id })")
  })

  it('删除对话框要二次确认，勾选之前按钮不可用', () => {
    expect(sidebar).toContain('type="checkbox"')
    expect(sidebar).toContain('我确认永久删除该项目及其全部数据')
    expect(sidebar, '未勾选时禁用删除按钮').toContain('disabled={!deleteConfirmed}')
    expect(sidebar, '没有勾选就不该走到删除').toContain('if (!deleting || !deleteConfirmed) return')
    expect(sidebar, '不可恢复这件事要写在弹窗里').toContain('删除后不可恢复')
  })

  it('归档与取消归档都有入口（没有取消归档，"可逆"就只是句好听的话）', () => {
    expect(sidebar).toContain('归档项目</DropdownMenuItem>')
    expect(sidebar).toContain('取消归档</DropdownMenuItem>')
    expect(sidebar).toContain('void submitArchive(project.id, true)')
    expect(sidebar).toContain('void submitArchive(project.id, false)')
    expect(sidebar, '归档只置标志位，不动数据').toContain('await updateProject({ id, archived })')
  })

  it('已归档是一个可展开的分组，项目仍能点进去查（数据还在）', () => {
    expect(sidebar).toContain('已归档（')
    expect(sidebar).toContain('setShowArchived')
    // 归档分组里的项目仍走 enterProject：归档 ≠ 不能查
    // （三处：新建项目后进入、未归档列表、已归档列表）
    expect(sidebar.split('enterProject(project.id)').length - 1).toBeGreaterThanOrEqual(3)
  })
})
