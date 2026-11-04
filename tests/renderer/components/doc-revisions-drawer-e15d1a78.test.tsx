import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { DocRevisionsDrawer } from '../../../src/renderer/components/project/DocRevisionsDrawer'
import { ProjectDocsView } from '../../../src/renderer/components/project/ProjectDocsView'
import { useProjectStore } from '../../../src/renderer/stores/project.store'

/**
 * 关联目录文档的历史抽屉（卡 `e15d1a78`）
 *
 * 判据是**人能从抽屉里读出什么**：
 * 1. 列表给时间 · 体积，与磁盘当前内容一致的那一版标「当前」；
 * 2. 默认看到的是选中那一版的**全文**（要回答的是"改之前写的是什么"）；
 * 3. 切一下能看它与上一版的行级差异（新增/删除行各有标记）；
 * 4. 非当前版明说只读（不会写回磁盘），不给人"能回滚"的错觉；
 * 5. 一版都没有时不摆空抽屉，给一句可行动的说明；
 * 6. HTML 文档的历史按源码显示（不重渲染）；
 * 7. 文档页工具栏的「版本历史」真的接上了这条通道，并带上当前文档的路径。
 *
 * 像素不在这里钉：真窗口上的排版另用隔离实例 + CDP 量过（`scripts/isolated-app.mjs`）。
 */

const invokeMock = vi.fn()

vi.mock('../../../src/renderer/lib/ipc-client', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  on: () => () => undefined
}))

const DOC_FILE = 'design/token.md'

const mdRevisions = () => ({
  projectId: 'p1',
  file: DOC_FILE,
  title: '设计 token 与应用规范',
  kind: 'md',
  currentSha256: 'sha-2',
  revisions: [
    {
      id: 'r2',
      seq: 2,
      sha256: 'sha-2',
      bytes: 2048,
      body: '# 说明\n\n第二版\n新加的一行\n',
      createdAt: '2026-11-04T02:30:00.000Z',
      isCurrent: true
    },
    {
      id: 'r1',
      seq: 1,
      sha256: 'sha-1',
      bytes: 1024,
      body: '# 说明\n\n第一版\n',
      createdAt: '2026-11-03T02:30:00.000Z',
      isCurrent: false
    }
  ]
})

beforeEach(() => {
  invokeMock.mockReset()
  invokeMock.mockImplementation(async (channel: string) => {
    if (channel === 'project:docRevisions') return mdRevisions()
    if (channel === 'project:listDocs') {
      return {
        projectId: 'p1',
        projectName: 'DeskPartner',
        docsDir: 'D:/docs',
        available: true,
        docs: [
          {
            file: DOC_FILE,
            name: 'token.md',
            kind: 'md',
            title: '设计 token 与应用规范',
            bytes: 2048,
            updatedAt: '2026-11-04T02:30:00.000Z',
            sha256: 'sha-2'
          }
        ]
      }
    }
    if (channel === 'project:readDoc') {
      return {
        file: DOC_FILE,
        name: 'token.md',
        kind: 'md',
        title: '设计 token 与应用规范',
        bytes: 2048,
        updatedAt: '2026-11-04T02:30:00.000Z',
        sha256: 'sha-2',
        projectId: 'p1',
        projectName: 'DeskPartner',
        docsDir: 'D:/docs',
        content: '# 说明\n\n第二版\n新加的一行\n'
      }
    }
    return null
  })
  useProjectStore.setState({
    projects: [
      {
        id: 'p1',
        name: 'DeskPartner',
        color: '#5388F6',
        archived: false,
        sortOrder: 0,
        createdAt: '',
        handoffMarkdown: '',
        docsDir: 'D:/docs'
      } as never
    ]
  })
})

afterEach(() => cleanup())

const renderDrawer = (): void => {
  render(<DocRevisionsDrawer projectId="p1" file={DOC_FILE} open onClose={() => undefined} />)
}

describe('文档历史抽屉（e15d1a78）', () => {
  it('1. 列表给时间与体积，磁盘上当前内容那一版标「当前」', async () => {
    renderDrawer()
    const options = await screen.findAllByRole('option')
    expect(options).toHaveLength(2)
    expect(options[0].textContent).toContain('2.0 KB')
    expect(options[0].textContent).toContain('当前')
    expect(options[0].textContent).toContain('第 2 版')
    expect(options[1].textContent).toContain('1.0 KB')
    expect(options[1].textContent).not.toContain('当前')
    // 时间看得见（具体格式随系统区域，钉"这一版有日期"就够）
    expect(options[1].textContent).toMatch(/2026/)
  })

  it('2. 默认看选中那一版的全文（Markdown 渲染），不是差异视图', async () => {
    renderDrawer()
    const content = await screen.findByTestId('doc-revision-content')
    expect(content.textContent).toContain('第二版')
    expect(content.textContent).toContain('新加的一行')
    expect(content.textContent).not.toContain('第一版')
    expect(screen.queryByTestId('doc-revision-diff')).toBeNull()
  })

  it('3. 切到「与上一版的差异」：新增行与删掉的行各有标记', async () => {
    renderDrawer()
    await screen.findAllByRole('option')
    fireEvent.click(screen.getByRole('button', { name: '与上一版的差异' }))
    const diff = await screen.findByTestId('doc-revision-diff')
    const added = [...diff.querySelectorAll('[data-diff="add"]')].map((el) => el.textContent ?? '')
    const removed = [...diff.querySelectorAll('[data-diff="del"]')].map((el) => el.textContent ?? '')
    expect(added.some((t) => t.includes('新加的一行'))).toBe(true)
    expect(removed.some((t) => t.includes('第一版'))).toBe(true)
    // 差异条数也要看得见（这一版相对上一版：2 行新增、1 行删除）
    expect(screen.getByText('+2')).toBeTruthy()
    expect(screen.getByText('-1')).toBeTruthy()
  })

  it('4. 选旧版时明说只读：不会把这一版写回磁盘', async () => {
    renderDrawer()
    const options = await screen.findAllByRole('option')
    fireEvent.click(options[1])
    await waitFor(() =>
      expect(screen.getByText('只读历史：不会把这一版写回磁盘上的文件。')).toBeTruthy()
    )
    expect(screen.getByTestId('doc-revision-content').textContent).toContain('第一版')
    // 抽屉里不提供回滚这类写动作
    expect(screen.queryByRole('button', { name: /回滚/ })).toBeNull()
  })

  it('5. 一版都没有时给一句可行动的说明，不摆空抽屉', async () => {
    invokeMock.mockImplementation(async (channel: string) =>
      channel === 'project:docRevisions' ? { ...mdRevisions(), revisions: [] } : null
    )
    renderDrawer()
    expect(await screen.findByText(/还没有记录/)).toBeTruthy()
    expect(screen.queryAllByRole('option')).toHaveLength(0)
  })

  it('6. HTML 文档的历史按源码显示（不重渲染）', async () => {
    invokeMock.mockImplementation(async (channel: string) =>
      channel === 'project:docRevisions'
        ? {
            projectId: 'p1',
            file: 'site/index.html',
            title: '说明页',
            kind: 'html',
            currentSha256: 'sha-9',
            revisions: [
              {
                id: 'h1',
                seq: 1,
                sha256: 'sha-9',
                bytes: 120,
                body: '<h1>旧版说明页</h1>',
                createdAt: '2026-11-04T02:30:00.000Z',
                isCurrent: true
              }
            ]
          }
        : null
    )
    render(<DocRevisionsDrawer projectId="p1" file="site/index.html" open onClose={() => undefined} />)
    const content = await screen.findByTestId('doc-revision-content')
    expect(content.textContent).toContain('<h1>旧版说明页</h1>')
    expect(content.querySelector('h1')).toBeNull()
    expect(screen.getByText(/HTML 文档按源码显示/)).toBeTruthy()
  })

  it('7. 文档页工具栏的「版本历史」接上了通道，且带上当前文档的路径', async () => {
    render(<ProjectDocsView projectId="p1" />)
    // 默认停在库内接手说明；先打开一篇关联目录文档
    fireEvent.click(await screen.findByTestId(`project-doc-item-${DOC_FILE}`))
    const historyButton = await screen.findByRole('button', { name: '版本历史' })
    fireEvent.click(historyButton)
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith('project:docRevisions', { id: 'p1', file: DOC_FILE })
    )
    expect(await screen.findByRole('dialog', { name: '文档历史' })).toBeTruthy()
    expect((await screen.findAllByRole('option')).length).toBe(2)
  })
})
