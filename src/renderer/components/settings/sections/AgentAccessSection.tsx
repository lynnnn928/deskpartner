import React, { useEffect, useState } from 'react'
import { Section, Row } from '../Section'
import { Button } from '../../ui/Button'
import { MarkdownContent } from '../../ui/MarkdownContent'
import { useUIStore } from '../../../stores/ui.store'
import { useSettingsStore } from '../../../stores/settings.store'
import { invoke } from '../../../lib/ipc-client'

/** 剥离仅供机器读取的顶部 YAML frontmatter，让页面阅读预览直接展示正文 */
function stripYamlFrontmatter(text: string): string {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n+/, '').trim()
}

function formatShortDate(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * AI 助手接入资料（用户与团队 -> 接入资料分区）
 *
 * 说明文本由主进程按本机真实调用路径动态生成，直接在页内完整展示结构化阅读预览，
 * 支持一键复制或导出 `.md` 文件交给任意 AI 助手，并提供前往「快速上手」的引导入口。
 *
 * 卡 `3559c27d`（选项②）：记录上次复制/导出的版本与时间，应用升级后若发现曾导出过旧版，
 * 在同位置温和提醒主用户刷新外部 AI 助手里的本地 Skill 副本（绝不扫描或直写第三方配置目录）。
 */
export const AgentAccessSection: React.FC = () => {
  const setMainView = useUIStore((s) => s.setMainView)
  const { settings, updateSettings } = useSettingsStore()
  const [copied, setCopied] = useState(false)
  const [exported, setExported] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [guideText, setGuideText] = useState<string>('')
  const [currentVersion, setCurrentVersion] = useState<string>('')

  const loadGuide = async () => {
    const text = await invoke('cli:agentGuide')
    if (typeof text !== 'string' || !text.trim()) {
      throw new Error('未取到说明内容')
    }
    return text
  }

  useEffect(() => {
    let alive = true
    void loadGuide()
      .then((text) => {
        if (alive) setGuideText(text)
      })
      .catch(() => undefined)
    void invoke('app:info')
      .then((info) => {
        if (alive && info?.version) setCurrentVersion(info.version)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])

  const recordSkillExport = async (text: string) => {
    const verMatch = text.match(/^skill_version:\s*["']?([^"'\r\n]+)["']?/m)
    const ver = currentVersion || verMatch?.[1]?.trim() || null
    if (!ver) return
    try {
      await updateSettings({
        lastSkillExportedVersion: ver,
        lastSkillExportedAt: new Date().toISOString()
      })
    } catch {
      /* 记录导出状态失败不阻断复制/导出动作 */
    }
  }

  const handleCopy = async () => {
    setError(null)
    try {
      const text = guideText || (await loadGuide())
      if (!guideText) setGuideText(text)
      await navigator.clipboard.writeText(text)
      await recordSkillExport(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const handleSave = async () => {
    setError(null)
    try {
      const text = guideText || (await loadGuide())
      if (!guideText) setGuideText(text)
      const blob = new Blob([text], { type: 'text/markdown' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'desk-partner-todos-SKILL.md'
      a.click()
      URL.revokeObjectURL(url)
      await recordSkillExport(text)
      setExported(true)
      setTimeout(() => setExported(false), 2500)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const lastVer = settings.lastSkillExportedVersion
  const lastAt = formatShortDate(settings.lastSkillExportedAt)
  const isStale = Boolean(lastVer && currentVersion && lastVer !== currentVersion)

  return (
    <Section
      title="AI 助手接入资料"
      desc="将以下接入说明发给你的 AI 助手（Claude Desktop、Cursor、Codex 等），它即可按本机真实路径读写事项与项目。"
    >
      <div className="rounded-button border border-accent/25 bg-accent/5 px-3.5 py-2.5 flex flex-wrap items-center justify-between gap-3">
        <span className="text-label text-text-primary">
          首次配置或需要一步步引导？可前往「快速上手」直接复制开场提示词发给 AI 助手。
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="border border-border bg-bg-card hover:bg-surface-subtle px-2.5 text-text-primary shrink-0 cursor-pointer"
          onClick={() => setMainView('quickstart')}
        >
          前往快速上手 →
        </Button>
      </div>

      <Row label="接入说明文档" hint="已自动填入本机 CLI 与 MCP 真实调用路径">
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="border border-border bg-surface-subtle hover:bg-surface-muted px-2.5 text-text-primary cursor-pointer"
            onClick={() => void handleSave()}
          >
            {exported ? '已导出 .md' : '导出 .md'}
          </Button>
          <Button variant="primary" size="sm" onClick={() => void handleCopy()}>
            {copied ? '已复制说明' : '复制接入说明'}
          </Button>
        </div>
      </Row>

      {isStale && (
        <div
          data-testid="skill-stale-notice"
          className="rounded-button border border-warning/40 bg-warning/10 px-3.5 py-2.5 text-label text-text-primary"
        >
          上次复制/导出的说明版本为 <span className="font-mono font-medium">v{lastVer}</span>
          {lastAt ? `（${lastAt}）` : ''}，当前应用已升级至{' '}
          <span className="font-mono font-medium">v{currentVersion}</span>。若曾将说明保存为外部 AI 助手的本地 Skill 副本，建议重新复制或导出替换旧文件。
        </div>
      )}

      {!isStale && lastVer && (
        <p data-testid="skill-export-record" className="text-caption text-text-secondary -mt-1 pl-1">
          最近复制/导出：<span className="font-mono">v{lastVer}</span>
          {lastAt ? `（${lastAt}）` : ''} · 若外部 AI 助手存有本地 Skill 副本，升级版本后请重新导出替换。
        </p>
      )}

      {error && <p className="text-label text-danger">{error}</p>}

      {guideText && (
        <div className="rounded-card border border-border bg-surface-subtle p-5">
          <MarkdownContent content={stripYamlFrontmatter(guideText)} />
        </div>
      )}
    </Section>
  )
}
