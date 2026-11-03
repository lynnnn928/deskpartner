import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, within, cleanup } from '@testing-library/react'
import fs from 'node:fs'
import { CommentThread } from '../../../src/renderer/components/quick-add/CommentThread'

/**
 * 评论行的排版（卡 `35fa2cbc`）
 *
 * 主用户对着一张窄右栏的截图指出两件事：
 * ① 时间是名字那一行的 `ml-auto`（被推到最右），回复/删除又是正文右侧一个
 *    `shrink-0` 的独立列 —— 那条列 hover 前是全透明的，但照样占宽，
 *    一条窄评论右侧会空出五六十像素；
 * ② 她要的是「时间、回复、删除都排到评论下方」，正文自己吃满宽度。
 *
 * 这里量的是结构，不是像素：happy-dom 没有布局，能钉住的只有"谁在谁下面、
 * 有没有多出来一列"。实测正文宽度从 278px 涨到 338px 是在真窗口上用 CDP 量的。
 */
vi.mock('../../../src/renderer/lib/ipc-client', () => ({
  invoke: vi.fn(async (channel: string) => {
    if (channel === 'todo:comments') {
      return [
        {
          id: 'c1',
          todoId: 't1',
          parentId: null,
          authorType: 'agent',
          authorId: 'agent:penguin',
          body: '第一条评论的正文',
          kind: 'comment',
          createdAt: '2026-10-27T07:04:00.000Z'
        },
        {
          id: 'c2',
          todoId: 't1',
          parentId: 'c1',
          authorType: 'human',
          authorId: 'human',
          body: '楼中楼回复的正文',
          kind: 'comment',
          createdAt: '2026-10-29T07:37:00.000Z'
        }
      ]
    }
    return null
  })
}))

afterEach(() => cleanup())

describe('评论行排版（卡 35fa2cbc）', () => {
  it('时间、回复、删除都排在正文下面，正文占满这一列', async () => {
    render(<CommentThread todoId="t1" />)
    await screen.findByText('第一条评论的正文')

    const row = document.querySelector('[data-comment-id="c1"]') as HTMLElement
    expect(row, '找不到那条顶层评论').toBeTruthy()

    // 一行只该有两块：作者图标 + 内容列。多出来的那块就是右侧那条常驻操作列
    expect(row.children.length, '正文右侧又多出来一列').toBe(2)

    const body = within(row).getByText('第一条评论的正文')
    const meta = within(row).getByTestId('comment-meta')
    expect(body.nextElementSibling, '时间与操作要紧跟在正文下面').toBe(meta)

    // 元信息一行里三样都在：时间、回复、删除
    expect(within(meta).getByText(/\d\d-\d\d \d\d:\d\d/), '时间不在下面这一行').toBeTruthy()
    expect(within(meta).getByText('回复')).toBeTruthy()
    expect(within(meta).getByText('删除')).toBeTruthy()

    // 名字那一行不该再留时间（那是"跑到最右边"的旧位置）
    const nameRow = body.previousElementSibling as HTMLElement
    expect(nameRow.textContent).not.toMatch(/\d\d-\d\d \d\d:\d\d/)
  })

  it('挪到下面之后，回复与删除照样能点', async () => {
    render(<CommentThread todoId="t1" />)
    await screen.findByText('第一条评论的正文')

    const meta = within(document.querySelector('[data-comment-id="c1"]') as HTMLElement).getByTestId(
      'comment-meta'
    )
    fireEvent.click(within(meta).getByText('回复'))
    expect(await screen.findByText(/正在回复/), '点了回复没有进入回复态').toBeTruthy()

    fireEvent.click(within(meta).getByText('删除'))
    expect(await screen.findByText('删除这条评论？'), '点了删除没有弹确认').toBeTruthy()
  })

  it('源码闸门：底部操作栏与卡片头部同质感，且待在滚动层外面（35fa2cbc）', () => {
    // 注释里会解释"原来是灰底"，会假红 —— 先摘掉注释，只看真的那几行
    const s = fs
      .readFileSync('src/renderer/components/quick-add/QuickAddForm.tsx', 'utf8')
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    const saveAt = s.indexOf('提交保存')
    const footAt = s.lastIndexOf('flex justify-end gap-2 shrink-0', saveAt)
    expect(footAt, '没找到底部操作栏').toBeGreaterThan(0)
    const foot = s.slice(footAt, saveAt)

    expect(foot, '底部栏要和卡片同底色').toContain('bg-bg-card')
    expect(foot, '灰底那条就是"跟头部质感不一样"的来源').not.toContain('bg-bg-primary')
    expect(foot, '底部栏要留在滚动层外面，否则上边线会被滚动条沟截断').not.toContain('sticky')

    // 滚动交给内层，操作栏是它的兄弟
    const scroller = s.indexOf("editingTodoId && 'flex-1 min-h-0 overflow-y-auto'")
    expect(scroller, '没找到滚动层').toBeGreaterThan(0)
    expect(scroller, '滚动层要排在操作栏之前').toBeLessThan(footAt)
  })
})
