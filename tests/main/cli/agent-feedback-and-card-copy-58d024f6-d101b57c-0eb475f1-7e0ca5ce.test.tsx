// @vitest-environment happy-dom
/**
 * 看板卡片外侧复制指令与 Agent 实测反馈收口（卡 58d024f6 / d101b57c / 0eb475f1 / 7e0ca5ce）
 */
import React from 'react'
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { render, fireEvent, waitFor } from '@testing-library/react'
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { runMigrations } from '../../../src/main/database/migrations'
import { ProjectRepository } from '../../../src/main/database/project.repository'
import { TodoRepository } from '../../../src/main/database/todo.repository'
import { CategoryRepository } from '../../../src/main/database/category.repository'
import { MemoRepository } from '../../../src/main/database/memo.repository'
import { SettingsRepository } from '../../../src/main/database/settings.repository'
import { AgentRepository } from '../../../src/main/database/agent.repository'
import { ReleaseRepository } from '../../../src/main/database/release.repository'
import { CommentRepository } from '../../../src/main/database/comment.repository'
import { NotificationRepository } from '../../../src/main/database/notification.repository'
import { ReminderReceiptRepository } from '../../../src/main/database/reminder-receipt.repository'
import { RulesRepository } from '../../../src/main/database/rules.repository'
import { ProtocolRepository, PROTOCOL_BLOCK_KEYS } from '../../../src/main/database/protocol.repository'
import { ProfileRepository } from '../../../src/main/database/profile.repository'
import { executeOne, type CliContext } from '../../../src/main/cli/commands'
import { formatTodoAgentPrompt } from '../../../src/renderer/lib/utils'
import { CardActions } from '../../../src/renderer/components/kanban/CardActions'
import { QuickStartView } from '../../../src/renderer/components/onboarding/QuickStartView'

const db = new Database(':memory:')
vi.mock('../../../src/main/database/index', () => ({ getDatabase: () => db }))

const invokeMock = vi.fn()
vi.mock('../../../src/renderer/lib/ipc-client', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  on: () => () => {}
}))

const projectRepo = new ProjectRepository()
const todoRepo = new TodoRepository()
const categoryRepo = new CategoryRepository()
const memoRepo = new MemoRepository()
const settingsRepo = new SettingsRepository()
const agentRepo = new AgentRepository()
const releaseRepo = new ReleaseRepository()
const commentRepo = new CommentRepository()
const notificationRepo = new NotificationRepository()
const reminderReceiptRepo = new ReminderReceiptRepository()
const rulesRepo = new RulesRepository()
const protocolRepo = new ProtocolRepository()
const profileRepo = new ProfileRepository()

function makeCtx(): CliContext {
  return {
    deps: {
      todoRepo,
      categoryRepo,
      projectRepo,
      memoRepo,
      settingsRepo,
      agentRepo,
      releaseRepo,
      commentRepo,
      notificationRepo,
      reminderReceiptRepo,
      rulesRepo,
      protocolRepo,
      profileRepo,
      events: { append: () => {} },
      telemetry: { record: () => {}, stats: () => ({}), query: () => [], clear: () => 0 }
    },
    meta: {
      version: '1.0.136',
      dbPath: ':memory:',
      schemaVersion: 48,
      busyTimeoutMs: 5000,
      channels: ['pipe', 'headless'],
      via: 'pipe',
      startedAt: Date.now()
    },
    interactive: true
  } as unknown as CliContext
}

describe('看板卡片外侧复制与 Agent 建议卡实现（58d024f6 / d101b57c / 0eb475f1 / 7e0ca5ce）', () => {
  beforeAll(() => {
    runMigrations(db)
  })

  beforeEach(() => {
    db.exec('DELETE FROM todos; DELETE FROM projects; DELETE FROM profile_blocks; DELETE FROM profile_proposals; DELETE FROM protocol_blocks; DELETE FROM protocol_proposals;')
    invokeMock.mockReset()
  })

  it('1. [58d024f6] formatTodoAgentPrompt 与 CardActions 外侧复制按钮生成「请看下「<项目名>」项目的卡片 #<8位ID>：「<标题>」」', async () => {
    const todo = {
      id: '7e0ca5ce-9625-4ea8-ba82-bcfc25dea2ab',
      title: '安装迁移后接入路径提示不清导致 Agent 首次调用失败'
    }
    const textWithProj = formatTodoAgentPrompt(todo, '知彼')
    expect(textWithProj).toBe(
      '请看下「知彼」项目的事项 #7e0ca5ce：「安装迁移后接入路径提示不清导致 Agent 首次调用失败」'
    )

    const writeTextMock = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: writeTextMock },
      configurable: true
    })

    const { getByTestId } = render(
      <CardActions
        todoId={todo.id}
        isPinned={false}
        copyText={textWithProj}
        onEdit={() => {}}
        onDelete={() => {}}
        onPin={() => {}}
      />
    )

    const copyBtn = getByTestId('card-copy-btn-7e0ca5ce')
    expect(copyBtn.getAttribute('title')).toContain(textWithProj)
    fireEvent.click(copyBtn)

    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledWith(textWithProj)
      expect(copyBtn.getAttribute('title')).toContain('已复制')
    })
  })

  it('2. [d101b57c] profile propose 与 protocol propose 支持 --append 追加模式并在回执返回 diffSummary', async () => {
    profileRepo.save({ scope: 'global' }, 'habits', '- 偏好简洁回复\n- 先给结论', 'human', true)
    const ctx = makeCtx()

    const res = (await executeOne(ctx, [
      'profile',
      'propose',
      '--block',
      'habits',
      '--body',
      '- 不要改动未提及的文件',
      '--append'
    ])) as {
      ok: boolean
      data: {
        originalBody: string
        body: string
        diffSummary: {
          mode: string
          originalLineCount: number
          proposedLineCount: number
          addedCount: number
          removedCount: number
          addedLines: string[]
        }
      }
    }

    expect(res.ok).toBe(true)
    expect(res.data.originalBody).toBe('- 偏好简洁回复\n- 先给结论')
    expect(res.data.body).toBe('- 偏好简洁回复\n- 先给结论\n- 不要改动未提及的文件')
    expect(res.data.diffSummary.mode).toBe('append')
    expect(res.data.diffSummary.originalLineCount).toBe(2)
    expect(res.data.diffSummary.proposedLineCount).toBe(3)
    expect(res.data.diffSummary.addedCount).toBe(1)
    expect(res.data.diffSummary.removedCount).toBe(0)
    expect(res.data.diffSummary.addedLines).toEqual(['- 不要改动未提及的文件'])

    const pKey = PROTOCOL_BLOCK_KEYS[0]
    protocolRepo.save({ scope: 'global' }, pKey, '- 先读接手说明', 'human', true)
    const protoRes = (await executeOne(ctx, [
      'protocol',
      'propose',
      '--block',
      pKey,
      '--body',
      '- 收口前跑完测试',
      '--append'
    ])) as {
      ok: boolean
      data: {
        body: string
        diffSummary: { mode: string; addedCount: number; removedCount: number }
      }
    }
    expect(protoRes.ok).toBe(true)
    expect(protoRes.data.body).toBe('- 先读接手说明\n- 收口前跑完测试')
    expect(protoRes.data.diffSummary.mode).toBe('append')
    expect(protoRes.data.diffSummary.addedCount).toBe(1)
    expect(protoRes.data.diffSummary.removedCount).toBe(0)
  })

  it('3. [0eb475f1] todo list 支持 --created-by 与 --created-after 组合筛选', async () => {
    categoryRepo.create({ name: '工作', color: '#3b82f6' })
    const proj = projectRepo.create({ name: 'DeskPartner' })
    const oldTodo = todoRepo.create({
      title: '较早创建的事项',
      projectId: proj.id,
      createdBy: 'human'
    })
    const newHumanTodo = todoRepo.create({
      title: '最近由主用户创建的事项',
      projectId: proj.id,
      createdBy: 'human'
    })
    todoRepo.create({
      title: '最近由 Agent 创建的事项',
      projectId: proj.id,
      createdBy: 'agent:zcode'
    })

    // 将 oldTodo 的 created_at 改到 2026-10-01
    db.prepare('UPDATE todos SET created_at = ? WHERE id = ?').run('2026-10-01T00:00:00.000Z', oldTodo.id)
    db.prepare('UPDATE todos SET created_at = ? WHERE id = ?').run('2026-10-28T10:00:00.000Z', newHumanTodo.id)

    const ctx = makeCtx()
    const res = (await executeOne(ctx, [
      'todo',
      'list',
      '--status',
      'any',
      '--created-by',
      'human',
      '--created-after',
      '2026-10-25'
    ])) as {
      ok: boolean
      data: Array<{ id: string; title: string }>
    }

    expect(res.ok).toBe(true)
    expect(res.data.map((t) => t.id)).toEqual([newHumanTodo.id])
  })

  it('4. [7e0ca5ce] 快速上手视图与中英 README 均包含安装目录迁移恢复说明', () => {
    invokeMock.mockImplementation((channel: string) => {
      if (channel === 'cli:connectInfo') {
        return Promise.resolve({
          cliPath: 'C:/Apps/DeskPartner/resources/cli/deskpartner.cjs',
          cliEnvVar: 'DESKPARTNER_CLI',
          cliEnvAvailable: true,
          mcpCommand: 'C:/Apps/DeskPartner/resources/cli/mcp.cmd'
        })
      }
      if (channel === 'agent:list' || channel === 'project:list') return Promise.resolve([])
      return Promise.resolve(null)
    })

    const { container } = render(<QuickStartView />)
    expect(container.textContent).toContain('更换过安装目录？')
    expect(container.textContent).toContain('同目录升级无需重配')

    const readmeZh = fs.readFileSync(path.resolve(process.cwd(), 'README.md'), 'utf8')
    const readmeEn = fs.readFileSync(path.resolve(process.cwd(), 'README.en.md'), 'utf8')
    expect(readmeZh).toContain('安装目录迁移提示')
    expect(readmeEn).toContain('reinstall to a different folder')
  })
})
