import { describe, it, expect, beforeAll, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { runMigrations } from '../../../src/main/database/migrations'
import { executeOne } from '../../../src/main/cli/commands'
import { sanitizeHtmlForSandbox } from '../../../src/renderer/components/project/ProjectDocsView'
import type { CliContext } from '../../../src/main/cli/command-core'

const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

const db = new Database(':memory:')
vi.mock('../../../src/main/database/index', () => ({ getDatabase: () => db }))

const { TodoRepository } = await import('../../../src/main/database/todo.repository')
const { CategoryRepository } = await import('../../../src/main/database/category.repository')
const { ProjectRepository } = await import('../../../src/main/database/project.repository')
const { MemoRepository } = await import('../../../src/main/database/memo.repository')
const { SettingsRepository } = await import('../../../src/main/database/settings.repository')
const { AgentRepository } = await import('../../../src/main/database/agent.repository')
const { ReleaseRepository } = await import('../../../src/main/database/release.repository')
const { CommentRepository } = await import('../../../src/main/database/comment.repository')
const { NotificationRepository } = await import('../../../src/main/database/notification.repository')
const { ReminderReceiptRepository } = await import('../../../src/main/database/reminder-receipt.repository')
const { RulesRepository } = await import('../../../src/main/database/rules.repository')
const { ProtocolRepository } = await import('../../../src/main/database/protocol.repository')
const { ProfileRepository } = await import('../../../src/main/database/profile.repository')

const projectRepo = new ProjectRepository()

/**
 * 静态闸门纯函数：校验 ProjectDocsView.tsx 中的 HTML 内嵌容器必须带无脚本沙箱（卡 46c7d51d）
 */
function checkHtmlSandboxGate(sourceCode: string): string[] {
  const clean = stripComments(sourceCode)
  const violations: string[] = []
  const iframeMatches = clean.match(/<iframe\b[\s\S]*?\/>/g) ?? []
  if (iframeMatches.length === 0) {
    violations.push('ProjectDocsView.tsx 缺少用于渲染 HTML 的 <iframe ... /> 容器')
    return violations
  }
  for (const tag of iframeMatches) {
    if (!/\bsandbox=""/.test(tag)) {
      violations.push(`iframe 必须显式声明空权限沙箱 sandbox=""：${tag.slice(0, 80)}`)
    }
    if (/allow-scripts|allow-same-origin|allow-top-navigation/i.test(tag)) {
      violations.push(`iframe 沙箱禁止放开脚本或同源权限：${tag.slice(0, 80)}`)
    }
  }
  return violations
}

describe('项目文档目录 HTML 支持与沙箱闸门（卡 46c7d51d）及 G8 未声明版本提醒（卡 a90464f9）', () => {
  beforeAll(() => {
    runMigrations(db)
  })

  it('1. 索引放行 .html 并标记 kind="html"，且能按名称读取 HTML 文档正文（卡 46c7d51d）', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-html-idx-'))
    try {
      fs.mkdirSync(path.join(tmpDir, 'research'), { recursive: true })
      fs.writeFileSync(
        path.join(tmpDir, 'research/sample-report.html'),
        '<!doctype html><html><head><title>架构体验报告</title></head><body><h1>正文标题</h1><p>' + '内容'.repeat(600) + '</p></body></html>',
        'utf8'
      )
      fs.writeFileSync(path.join(tmpDir, 'guide.md'), '# 指南\n\n正文', 'utf8')

      const proj = projectRepo.create({ name: 'HTML索引测试项目', docsDir: tmpDir })
      const res = projectRepo.listProjectDocs(proj.id)
      expect(res.available).toBe(true)

      const htmlDocs = res.docs.filter((d) => d.kind === 'html')
      const mdDocs = res.docs.filter((d) => d.kind === 'md')
      expect(htmlDocs.length).toBe(1)
      expect(mdDocs.length).toBe(1)

      const sampleReport = htmlDocs.find((d) => d.file.includes('sample-report.html'))
      expect(sampleReport).toBeTruthy()
      expect(sampleReport?.kind).toBe('html')
      expect(sampleReport?.title).toBe('架构体验报告')

      const readHtml = projectRepo.readProjectDoc(proj.id, sampleReport!.name)
      expect(readHtml.kind).toBe('html')
      expect(readHtml.content.length).toBeGreaterThan(1000)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('2. sanitizeHtmlForSandbox 剥离 <script> 并注入禁脚本 CSP，且静态闸门守住 sandbox=""（含反向验证）', () => {
    const dirty = '<html><head><title>报告</title><script>alert(1)</script></head><body><h1>正文</h1><script src="evil.js"></script></body></html>'
    const clean = sanitizeHtmlForSandbox(dirty)
    expect(clean).not.toContain('<script')
    expect(clean).toContain("Content-Security-Policy")
    expect(clean).toContain("default-src 'none'")
    expect(clean).toContain('<h1>正文</h1>')

    const viewPath = path.resolve(__dirname, '../../../src/renderer/components/project/ProjectDocsView.tsx')
    const src = stripComments(fs.readFileSync(viewPath, 'utf8'))
    expect(checkHtmlSandboxGate(src)).toEqual([])

    // 反向验证 1：去掉 sandbox="" 必须判红
    const mutatedNoSandbox = src.replace('sandbox=""', '')
    expect(checkHtmlSandboxGate(mutatedNoSandbox).length).toBeGreaterThan(0)

    // 反向验证 2：放开 allow-scripts 必须判红
    const mutatedAllowScripts = src.replace('sandbox=""', 'sandbox="allow-scripts"')
    expect(checkHtmlSandboxGate(mutatedAllowScripts).length).toBeGreaterThan(0)
  })

  it('3. G8 对未声明 DESKPARTNER_SKILL_VERSION 的 Agent 跑读命令回执主动提醒，doctor 同时打印声明版本与当前版本（卡 a90464f9）', async () => {
    const baseCtx: CliContext = {
      deps: {
        todoRepo: new TodoRepository(),
        categoryRepo: new CategoryRepository(),
        projectRepo,
        memoRepo: new MemoRepository(),
        settingsRepo: new SettingsRepository(),
        agentRepo: new AgentRepository(),
        releaseRepo: new ReleaseRepository(),
        commentRepo: new CommentRepository(),
        notificationRepo: new NotificationRepository(),
        reminderReceiptRepo: new ReminderReceiptRepository(),
        rulesRepo: new RulesRepository(),
        protocolRepo: new ProtocolRepository(),
        profileRepo: new ProfileRepository(),
        events: { append: () => {} },
        telemetry: { record: () => {}, stats: () => ({}), query: () => [], clear: () => 0 }
      },
      meta: {
        version: '1.0.131',
        dbPath: ':memory:',
        schemaVersion: 47,
        busyTimeoutMs: 5000,
        channels: ['headless'],
        via: 'headless',
        startedAt: Date.now()
      },
      interactive: false,
      actor: 'agent:bob'
    } as unknown as CliContext

    // (a) 未声明 skillVersion：跑任意读命令（doctor / todo list）必须带未声明提醒，且 doctor.declaredSkillVersion 为 null
    const docUndeclared = (await executeOne(baseCtx, ['doctor'])) as {
      ok: boolean
      notice?: string
      data: { version: string; skillVersion: string; declaredSkillVersion: string | null }
    }
    expect(docUndeclared.ok).toBe(true)
    expect(docUndeclared.notice).toContain('未声明说明书版本（DESKPARTNER_SKILL_VERSION）')
    // 1.0.133（卡 cb7924c2）：提醒里不能写 `dp skill` —— 本机没有这条命令，
    // 照抄就是一条跑不通的命令。给的是真实调用方式与 MCP 的正路。
    expect(docUndeclared.notice).toContain('node "$DESKPARTNER_CLI" skill')
    expect(docUndeclared.notice).toContain('get_guide')
    expect(docUndeclared.notice).not.toMatch(/\bdp (skill|todo|project)/)
    expect(docUndeclared.data.version).toBe('1.0.131')
    expect(docUndeclared.data.skillVersion).toBe('1.0.131')
    expect(docUndeclared.data.declaredSkillVersion).toBeNull()

    // (b) 声明了当前版本：不刷提醒，doctor.declaredSkillVersion 等于声明值
    const docCurrent = (await executeOne(
      { ...baseCtx, skillVersion: '1.0.131' } as unknown as CliContext,
      ['doctor']
    )) as {
      ok: boolean
      notice?: string
      data: { version: string; skillVersion: string; declaredSkillVersion: string | null }
    }
    expect(docCurrent.ok).toBe(true)
    expect(docCurrent.notice).toBeUndefined()
    expect(docCurrent.data.declaredSkillVersion).toBe('1.0.131')
  })
})
