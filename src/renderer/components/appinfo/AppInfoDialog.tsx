import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Dialog } from '../ui/Dialog'
import { Button } from '../ui/Button'
import { Icon } from '../ui/Icon'
import { invoke } from '../../lib/ipc-client'
import { formatChangelogDate, parseChangelog, type ChangelogEntry } from '../../lib/changelog'
import type { UpdateStatus } from '../../types/ipc'
import partnerBadge from '../../assets/partner-badge.svg'

/**
 * 应用信息（按成熟桌面产品的「应用信息」面板复刻）
 *
 * 它回答的是"我用的是哪个版本、有没有新的、上一个版本改了什么"这三件事，
 * 所以顺序照搬：身份 → 软件更新 → 更新日志 → 版权。
 *
 * 几处与设置页「系统」tab 的重叠要守住：
 * - **更新状态只有一个真源**（主进程的 `autoUpdateService`），这里每次打开都重新读，
 *   不自己缓存"已是最新"；下载/安装也都走同一条 IPC，不另建状态机。
 * - 更新日志读的是随包发布的 `CHANGELOG.md`，界面不改写文案 —— 用户看到的
 *   就是 changelog 里写的原话。
 */

const HOMEPAGE_URL = 'https://lynnnn928.github.io/deskpartner/'
const GITHUB_URL = 'https://github.com/lynnnn928/deskpartner'
const RELEASES_URL = 'https://github.com/lynnnn928/deskpartner/releases'
const LICENSE_NOTE = '© 2026 LiLin (lynnnn928) · 基于 MIT 协议开源'

export interface AppInfoDialogProps {
  open: boolean
  onClose: () => void
}

const openExternal = (url: string): void => {
  void invoke('app:openExternal', { url }).catch(() => undefined)
}

/** 一行「标签 + 链接」：外链统一走主进程白名单，点完不留在应用里 */
const LinkRow: React.FC<{ label: string; href: string; text: string }> = ({ label, href, text }) => (
  <div className="flex items-center gap-3 text-caption">
    <span className="w-12 shrink-0 text-text-secondary">{label}</span>
    <button
      type="button"
      onClick={() => openExternal(href)}
      title={href}
      className="inline-flex items-center gap-1 text-accent hover:underline decoration-accent/40 underline-offset-2 break-all cursor-pointer"
    >
      {text}
      <Icon name="externalLink" size={12} />
    </button>
  </div>
)

const SectionTitle: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="text-caption font-semibold text-text-secondary">{children}</div>
)

/** 一版日志：版本号 + 当前版本标 + 日期，下面一句话与要点 */
const ChangelogBlock: React.FC<{ entry: ChangelogEntry; current: boolean }> = ({ entry, current }) => (
  <div className="flex flex-col gap-1.5">
    <div className="flex items-center gap-2">
      <span className="text-label font-semibold text-text-primary">v{entry.version}</span>
      {current && (
        <span className="px-1.5 py-0.5 rounded-full bg-surface-subtle border border-border/70 text-caption text-text-secondary">
          当前版本
        </span>
      )}
      {entry.date && (
        <span className="ml-auto text-caption text-text-secondary">{formatChangelogDate(entry.date)}</span>
      )}
    </div>
    {entry.summary && <p className="text-caption text-text-secondary leading-relaxed">{entry.summary}</p>}
    {entry.bullets.length > 0 && (
      <ul className="flex flex-col gap-1 pl-4 list-disc marker:text-text-secondary">
        {entry.bullets.map((b, i) => (
          <li key={i} className="text-caption text-text-primary leading-relaxed">
            {b}
          </li>
        ))}
      </ul>
    )}
  </div>
)

export const AppInfoDialog: React.FC<AppInfoDialogProps> = ({ open, onClose }) => {
  const [version, setVersion] = useState<string>('')
  const [appIcon, setAppIcon] = useState<string | null>(null)
  const [appName, setAppName] = useState<string>('DeskPartner')
  const [update, setUpdate] = useState<UpdateStatus | null>(null)
  const [markdown, setMarkdown] = useState<string>('')
  const [loadError, setLoadError] = useState<string | null>(null)

  /**
   * 每次打开都重读：版本号与更新状态都可能在这期间变了（用户在设置页点过检查）。
   * 失败不弹窗，只在面板里留一句 —— 这是个"看一眼就走"的面板，不该拦住人。
   */
  const load = useCallback(async () => {
    setLoadError(null)
    try {
      const info = (await invoke('app:info')) as { version: string; dataDir: string } | null
      if (info?.version) setVersion(info.version)
    } catch {
      setLoadError('读不到版本信息')
    }
    try {
      const settings = (await invoke('settings:get')) as { appName?: string; appIcon?: string | null } | null
      if (settings?.appName?.trim()) setAppName(settings.appName.trim())
      setAppIcon(settings?.appIcon ?? null)
    } catch {
      /* 品牌自定义读不到就用默认名字与图标 */
    }
    try {
      setUpdate((await invoke('app:getUpdateState')) as UpdateStatus)
    } catch {
      setUpdate(null)
    }
    try {
      const res = (await invoke('app:changelog')) as { markdown: string } | null
      setMarkdown(res?.markdown ?? '')
    } catch {
      setMarkdown('')
    }
  }, [])

  useEffect(() => {
    if (open) void load()
  }, [open, load])

  const entries = useMemo(() => parseChangelog(markdown), [markdown])
  const currentEntry = useMemo(
    () => entries.find((e) => e.version === version.replace(/^v/i, '')) ?? entries[0] ?? null,
    [entries, version]
  )
  const olderEntries = useMemo(
    () => entries.filter((e) => e !== currentEntry),
    [entries, currentEntry]
  )

  const installing = update?.status === 'downloaded'
  const downloading = update?.status === 'downloading'
  const checking = update?.status === 'checking'
  const available = update?.status === 'available' && !!update.availableVersion

  const onCheck = useCallback(() => {
    setUpdate((prev) =>
      prev
        ? { ...prev, status: 'checking', errorMessage: null }
        : {
            status: 'checking',
            currentVersion: version,
            availableVersion: null,
            releaseDate: null,
            progressPercent: null,
            errorMessage: null,
            checkedAt: null
          }
    )
    void invoke('app:checkForUpdates')
      .then((next) => setUpdate(next as UpdateStatus))
      .catch((err) =>
        setUpdate((prev) =>
          prev
            ? { ...prev, status: 'error', errorMessage: err instanceof Error ? err.message : String(err) }
            : prev
        )
      )
  }, [version])

  const onDownload = useCallback(() => {
    /**
     * 点下去先本地切「下载中」，与设置页同一个理由：从点下去到主进程真正开始下
     * 之间界面不能一动不动，否则看起来就是"点了没反应"。
     */
    setUpdate((prev) => (prev ? { ...prev, status: 'downloading', progressPercent: 0, errorMessage: null } : prev))
    void invoke('app:downloadUpdate')
      .then((next) => setUpdate(next as UpdateStatus))
      .catch((err) =>
        setUpdate((prev) =>
          prev
            ? { ...prev, status: 'error', errorMessage: err instanceof Error ? err.message : String(err) }
            : prev
        )
      )
  }, [])

  return (
    <Dialog open={open} onClose={onClose} className="w-full max-w-dialog-md flex flex-col gap-4 max-h-dialog overflow-y-auto">
      <div className="flex items-start justify-between gap-3">
        <h2 className="text-column-title font-semibold text-text-primary">应用信息</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭"
          data-testid="app-info-close"
          className="w-7 h-7 -mt-1 -mr-1 flex items-center justify-center rounded-button text-text-secondary hover:bg-black/5 hover:text-text-primary cursor-pointer"
        >
          <Icon name="x" size={15} />
        </button>
      </div>

      {/* 身份 */}
      <div className="flex items-start gap-3">
        <div className="w-12 h-12 rounded-button bg-surface-subtle border border-border/70 flex items-center justify-center overflow-hidden shrink-0">
          {appIcon ? (
            <img src={appIcon} alt="" draggable={false} className="w-full h-full object-contain" />
          ) : (
            <img src={partnerBadge} alt="" draggable={false} className="w-7 h-7 object-contain" />
          )}
        </div>
        <div className="flex flex-col gap-1.5 min-w-0">
          <div className="text-column-title font-semibold text-text-primary">{appName}</div>
          <div className="text-caption text-text-secondary">
            v{version || '—'}
            {currentEntry?.date ? ` · 最近更新 ${formatChangelogDate(currentEntry.date)}` : ''}
          </div>
          <div className="flex flex-col gap-1 mt-1">
            <LinkRow label="主页" href={HOMEPAGE_URL} text="DeskPartner 官网" />
            <LinkRow label="GitHub" href={GITHUB_URL} text="github.com/lynnnn928/deskpartner" />
          </div>
        </div>
      </div>

      <div className="border-t border-border" />

      {/* 软件更新 */}
      <div className="flex flex-col gap-2">
        <SectionTitle>软件更新</SectionTitle>
        {available && update.availableVersion ? (
          <div className="flex items-center gap-3">
            <div className="text-label text-text-primary font-medium">新版本 v{update.availableVersion} 可用</div>
            <Button variant="primary" size="sm" data-testid="app-info-download-btn" className="ml-auto" onClick={onDownload}>
              下载并更新
            </Button>
          </div>
        ) : installing ? (
          <div className="flex items-center gap-3">
            <div className="text-label text-text-primary font-medium">v{update?.availableVersion ?? ''} 已下载完成</div>
            <Button
              variant="primary"
              size="sm"
              data-testid="app-info-install-btn"
              className="ml-auto"
              onClick={() => void invoke('app:quitAndInstallUpdate')}
            >
              重启并安装
            </Button>
          </div>
        ) : downloading ? (
          <div className="text-label text-text-primary">正在下载 {update?.progressPercent ?? 0}%…</div>
        ) : (
          <div className="flex items-center gap-3">
            <div className="text-label text-text-primary font-medium">
              {update?.status === 'error'
                ? '检查更新失败'
                : update?.status === 'not-available'
                  ? '已是最新版本'
                  : '检查是否有新版本'}
            </div>
            <Button
              variant="ghost"
              size="sm"
              data-testid="app-info-check-btn"
              disabled={checking}
              className="ml-auto border border-border bg-surface-subtle hover:bg-surface-muted text-text-primary"
              onClick={onCheck}
            >
              {checking ? '检查中…' : '检查更新'}
            </Button>
          </div>
        )}
        {available && update.availableVersion && (
          <button
            type="button"
            onClick={() => openExternal(`${RELEASES_URL}/tag/v${update.availableVersion}`)}
            className="self-start inline-flex items-center gap-1 text-caption text-accent hover:underline decoration-accent/40 underline-offset-2 cursor-pointer"
          >
            更新说明
            <Icon name="externalLink" size={12} />
          </button>
        )}
        <p className="text-caption text-text-secondary leading-relaxed">
          {available
            ? '将下载新版本。下载期间可以关闭本窗口继续使用，下载完成后重启应用即可完成更新。'
            : '应用启动时会自动检查一次新版本；这里只访问 GitHub Releases，不上传任何数据。'}
        </p>
        {update?.status === 'error' && update.errorMessage && (
          <p className="text-caption text-danger leading-relaxed">{update.errorMessage}</p>
        )}
        {loadError && <p className="text-caption text-danger leading-relaxed">{loadError}</p>}
      </div>

      <div className="border-t border-border" />

      {/* 更新日志 */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <SectionTitle>更新日志</SectionTitle>
          {entries.length > 0 && (
            <span className="px-1.5 py-0.5 rounded-full bg-surface-subtle border border-border/70 text-caption text-text-secondary">
              {entries.length}
            </span>
          )}
        </div>
        {currentEntry ? (
          <div data-testid="app-info-changelog-current">
            <ChangelogBlock entry={currentEntry} current />
          </div>
        ) : (
          <p className="text-caption text-text-secondary">读不到更新日志。</p>
        )}
        {olderEntries.length > 0 && (
          <details className="rounded-button border border-border/70 bg-surface-subtle px-3 py-2">
            <summary className="text-caption text-text-primary cursor-pointer select-none">
              更早的版本（{olderEntries.length}）
            </summary>
            <div className="flex flex-col gap-3 pt-3">
              {olderEntries.map((entry) => (
                <ChangelogBlock key={entry.version} entry={entry} current={false} />
              ))}
            </div>
          </details>
        )}
      </div>

      <div className="border-t border-border" />

      {/* 版权 */}
      <div className="flex flex-col gap-2">
        <SectionTitle>版权信息</SectionTitle>
        <p className="text-caption text-text-secondary">{LICENSE_NOTE}</p>
        <details className="rounded-button border border-border/70 bg-surface-subtle px-3 py-2">
          <summary className="text-caption text-text-primary cursor-pointer select-none">字体与图标许可</summary>
          <div className="flex flex-col gap-1 pt-2 text-caption text-text-secondary leading-relaxed">
            <p>字体：使用系统默认字体，不随安装包分发字体文件。</p>
            <p>图标：内置 SVG 线性图标（Lucide 风格路径），随 MIT 协议使用。</p>
          </div>
        </details>
      </div>
    </Dialog>
  )
}
