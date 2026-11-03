import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { ProjectDocsView } from '../../../src/renderer/components/project/ProjectDocsView'
import { useProjectStore } from '../../../src/renderer/stores/project.store'

/**
 * 文档侧栏的层级（卡 `5665baf5`）
 *
 * 主用户对着截图说「目录的层级结构看不出来，看起来像都是接手文档」：
 * 分组标题和文档行同号同色、左缘又对齐，读起来是一整列平级条目。
 * 这里钉住"组头是组头、文档挂在组头下面"这个结构，不钉像素
 * （缩进 18px 是在真窗口上用 CDP 量的：组头左缘 256 / 文档行 274）。
 */

vi.mock('../../../src/renderer/lib/ipc-client', () => ({
  invoke: vi.fn(async (channel: string) => {
    if (channel === 'project:listDocs') {
      return {
        projectId: 'p1',
        projectName: '空瓶控',
        docsDir: 'D:/docs',
        available: true,
        docs: [
          { file: 'design/token.md', name: 'token.md', kind: 'md', title: '设计 token 与应用规范', bytes: 6500, updatedAt: '2026-11-03T00:00:00.000Z' },
          { file: 'design/roadmap.md', name: 'roadmap.md', kind: 'md', title: '路线图', bytes: 3200, updatedAt: '2026-11-02T00:00:00.000Z' },
          { file: 'README.md', name: 'README.md', kind: 'md', title: '总览', bytes: 1200, updatedAt: '2026-11-01T00:00:00.000Z' }
        ]
      }
    }
    if (channel === 'project:readDoc') {
      return { file: 'design/token.md', name: 'token.md', kind: 'md', title: '设计 token 与应用规范', bytes: 6500, updatedAt: '', content: '# 标题' }
    }
    return null
  }),
  on: vi.fn(() => () => undefined)
}))

beforeEach(() => {
  useProjectStore.setState({
    projects: [
      {
        id: 'p1',
        name: '空瓶控',
        color: '#22c55e',
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

describe('文档侧栏分组（5665baf5）', () => {
  it('组头是独立的行：带文件夹图标、目录名与条数', async () => {
    render(<ProjectDocsView projectId="p1" />)
    const head = await screen.findByTestId('project-doc-group-design')
    expect(head.querySelector('svg'), '组头没有文件夹图标').not.toBeNull()
    expect(head.textContent).toContain('design')
    expect(head.textContent).toContain('2')
  })

  it('文档行挂在组头下面的缩进容器里（不是与组头平级）', async () => {
    render(<ProjectDocsView projectId="p1" />)
    const body = await screen.findByTestId('project-doc-group-body-design')
    expect(body.className, '组内容器要有缩进与左竖线').toContain('ml-3')
    expect(body.className).toContain('border-l')
    expect(body.contains(screen.getByTestId('project-doc-item-design/token.md'))).toBe(true)
    expect(body.contains(screen.getByTestId('project-doc-item-design/roadmap.md'))).toBe(true)
    // 根目录的文档不在 design 组里
    expect(body.contains(screen.getByTestId('project-doc-item-README.md'))).toBe(false)
  })

  it('根目录单独成组，不与子目录混在一起', async () => {
    render(<ProjectDocsView projectId="p1" />)
    const rootHead = await screen.findByTestId('project-doc-group-根目录')
    expect(rootHead.textContent).toContain('1')
    const rootBody = screen.getByTestId('project-doc-group-body-根目录')
    expect(rootBody.contains(screen.getByTestId('project-doc-item-README.md'))).toBe(true)
  })

  it('「项目接手说明（库内）」仍是独立一条，不属于任何文件夹组', async () => {
    render(<ProjectDocsView projectId="p1" />)
    const handoff = await screen.findByTestId('project-doc-item-handoff')
    expect(handoff.closest('[data-testid^="project-doc-group-body-"]')).toBeNull()
  })
})

