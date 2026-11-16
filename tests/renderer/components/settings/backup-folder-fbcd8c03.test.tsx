// @vitest-environment happy-dom
/**
 * 备份改成文件夹后，设置页要说清"附件文件到底带没带上"（卡 fbcd8c03）
 *
 * ── 缺陷 ──
 * 导出按钮给的是一份 JSON：附件**行**在里面，文件本体不在。回执也只说
 * "导入结果：N 项"。换机之后卡片上的附件点开全是"文件不存在"，
 * 而界面上从头到尾没有一句提示 —— 这是这次改动要堵的那条路。
 *
 * ── 这里钉住什么 ──
 * ① 三个出口都在：导出文件夹（主）/ 导入备份文件夹 / 导入旧版 JSON（备用）；
 * ② 导出回执说清"导出到哪个目录、附件复制了几个、缺几个、缺的是哪几个"；
 * ③ 导入回执有附件文件那一段（复制/跳过/缺失/校验不符 + 文件名），
 *    以及 v6 那四张新表的计数（通知/附件/文档快照/协议修订）；
 * ④ 取消选目录不出回执。
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, waitFor } from '@testing-library/react'

const invokeMock = vi.fn()
vi.mock('../../../../src/renderer/lib/ipc-client', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  on: () => () => {}
}))

import { BackupSection } from '../../../../src/renderer/components/settings/sections/BackupSection'

const receiptText = (el: HTMLElement): string => el.textContent ?? ''

describe('备份文件夹的界面出口与回执（fbcd8c03）', () => {
  beforeEach(() => {
    invokeMock.mockReset()
  })

  it('三个出口都在：导出文件夹 / 导入备份文件夹 / 导入旧版 JSON', () => {
    const { getByTestId } = render(<BackupSection />)

    expect(getByTestId('backup-export-folder').textContent).toContain('导出文件夹')
    expect(getByTestId('backup-import-folder').textContent).toContain('导入备份文件夹')
    expect(getByTestId('backup-import-legacy').textContent).toContain('导入旧版 JSON')
  })

  it('导出回执：目录、附件复制数、缺的文件名都要看见', async () => {
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === 'backup:exportFolder') {
        return {
          canceled: false,
          dir: 'D:/备份/desk-partner-backup-2026-11-16',
          attachmentFiles: { copied: 3, missing: ['attachments/t1/lost.png'] }
        }
      }
      return {}
    })

    const { getByTestId } = render(<BackupSection />)
    fireEvent.click(getByTestId('backup-export-folder'))

    const receipt = await waitFor(() => getByTestId('backup-receipt'))
    const text = receiptText(receipt)
    expect(text).toContain('desk-partner-backup-2026-11-16')
    expect(text).toContain('复制 3 个')
    expect(text).toContain('缺 1 个')
    // 缺的是哪一份 —— 只说"缺 1 个"等于没说
    expect(text).toContain('lost.png')
  })

  it('导入回执：附件文件那段（复制/跳过/缺失/校验不符）与 v6 四张表的计数', async () => {
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === 'backup:importFolder') {
        return {
          canceled: false,
          imported: 12,
          skipped: 2,
          detail: {
            projects: 1,
            categories: 4,
            todos: 3,
            agents: 1,
            memos: 1,
            comments: 1,
            transitions: 1,
            profileBlocks: 0,
            profileProposals: 0,
            profileRevisions: 0,
            protocolBlocks: 0,
            protocolProposals: 0,
            handoffRevisions: 0,
            handoffProposals: 0,
            releases: 0,
            collaborationRules: 0,
            permissionMatrix: 0,
            ruleProposals: 0,
            ruleRevisions: 0,
            agentApprovalEvents: 0,
            notifications: 5,
            todoAttachments: 4,
            projectDocRevisions: 2,
            protocolRevisions: 1
          },
          attachmentFiles: {
            copied: 2,
            skipped: 1,
            missing: ['attachments/t9/gone.pdf'],
            mismatched: ['attachments/t9/bad.png']
          }
        }
      }
      return {}
    })

    const { getByTestId } = render(<BackupSection />)
    fireEvent.click(getByTestId('backup-import-folder'))

    const receipt = await waitFor(() => getByTestId('backup-receipt'))
    const text = receiptText(receipt)
    expect(text).toContain('复制 2 个')
    expect(text).toContain('跳过 1 个')
    expect(text).toContain('缺失 1 个')
    expect(text).toContain('校验不符 1 个')
    expect(text).toContain('gone.pdf')
    expect(text).toContain('bad.png')
    // v6 那四张表：缺了它们，回执就看不出"通知/附件/快照/协议修订"有没有进来
    expect(text).toContain('通知 5')
    expect(text).toContain('附件 4')
    expect(text).toContain('文档快照 2')
    expect(text).toContain('协议修订 1')
  })

  it('取消选目录：不出回执', async () => {
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === 'backup:exportFolder') return { canceled: true }
      if (channel === 'backup:importFolder') return { canceled: true }
      return {}
    })

    const { getByTestId, queryByTestId } = render(<BackupSection />)
    fireEvent.click(getByTestId('backup-export-folder'))
    fireEvent.click(getByTestId('backup-import-folder'))

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('backup:importFolder')
    })
    expect(queryByTestId('backup-receipt')).toBeNull()
  })
})
