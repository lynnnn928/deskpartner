import React, { useEffect, useRef, useState } from 'react'
import { Section, Row } from '../Section'
import { ShortcutInput } from '../ShortcutInput'
import { Switch } from '../../ui/Switch'
import { Button } from '../../ui/Button'
import { useSettingsStore } from '../../../stores/settings.store'
import { invoke } from '../../../lib/ipc-client'
import type { UpdateStatus } from '../../../types/ipc'
import partnerBadge from '../../../assets/partner-badge.svg'

/**
 * 系统设置：应用名称与图标、开机自启、全局快捷键、数据存储目录与版本信息。
 *
 * 「快速上手」常驻在左侧边栏底部 `?` 按钮，「AI 助手接入资料」归属「用户与团队 -> 接入资料」，
 * 此处不再重复堆放入口。
 */
export const SystemSection: React.FC = () => {
  const { settings, updateSettings, warning } = useSettingsStore()
  const [info, setInfo] = useState<{ version: string; dataDir: string } | null>(null)
  const [updateState, setUpdateState] = useState<UpdateStatus | null>(null)
  const [pickingDir, setPickingDir] = useState(false)
  const [migrating, setMigrating] = useState(false)
  const [migrateMsg, setMigrateMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [appNameDraft, setAppNameDraft] = useState(settings.appName ?? '')
  const [pickingIcon, setPickingIcon] = useState(false)
  const [iconError, setIconError] = useState<string | null>(null)
  /**
   * 用户点过「立即更新」之后，下载一完成就自动重启安装（卡 `99870984`）。
   *
   * 为什么用 ref 而不是 state：它记的是"**这一次**下载是用户主动发起的"，
   * 详情页轮询把 status 从 downloading 翻到 downloaded 时才用得上，
   * 而它本身不参与渲染 —— 放 state 只会多一轮无意义的渲染。
   * 手动点「重启并安装」那条路（ref 为 false）保持原样，两者都能走。
   */
  const autoInstallPendingRef = useRef(false)

  useEffect(() => {
    setAppNameDraft(settings.appName ?? '')
  }, [settings.appName])

  useEffect(() => {
    let alive = true
    invoke('app:info')
      .then((r) => {
        if (alive) setInfo(r)
      })
      .catch(() => undefined)
    invoke('app:getUpdateState')
      .then((u) => {
        if (alive) setUpdateState(u)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    if (updateState?.status !== 'checking' && updateState?.status !== 'downloading') {
      return
    }
    let alive = true
    const timer = setInterval(() => {
      invoke('app:getUpdateState')
        .then((u) => {
          if (alive) setUpdateState(u)
        })
        .catch(() => undefined)
    }, 800)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [updateState?.status])

  /**
   * 点了「立即更新」就走完：下载完成 → 直接重启安装，不用再点第二次（卡 `99870984`）。
   *
   * 仍然保留「重启并安装」按钮：一来用户可能自己看着包下载完、想先干完手上的事再重启，
   * 二来"下载"和"安装"是两件事，把它们焊死成不能分开并不更好。
   */
  useEffect(() => {
    if (updateState?.status !== 'downloaded' || !autoInstallPendingRef.current) return
    autoInstallPendingRef.current = false
    void invoke('app:quitAndInstallUpdate').catch(() => undefined)
  }, [updateState?.status])

  const saveAppName = async () => {
    const trimmed = appNameDraft.trim()
    if (trimmed === (settings.appName ?? '')) return
    await updateSettings({ appName: trimmed })
  }

  const pickAppIcon = async () => {
    if (pickingIcon) return
    setPickingIcon(true)
    setIconError(null)
    try {
      const res = await invoke('app:pickAppIcon')
      if (res && !res.canceled && res.dataUrl) {
        await updateSettings({ appIcon: res.dataUrl })
      }
    } catch (err) {
      setIconError(err instanceof Error ? err.message : '更换应用图标失败')
    } finally {
      setPickingIcon(false)
    }
  }

  const changeDataDir = async () => {
    if (!info?.dataDir || pickingDir || migrating) return
    setPickingDir(true)
    setMigrateMsg(null)
    let targetDir: string | null = null
    try {
      const picked = await invoke('app:pickDataDir')
      if (!picked || picked.canceled || !picked.targetDir) {
        return
      }
      targetDir = picked.targetDir
    } catch (err) {
      setMigrateMsg({ ok: false, text: err instanceof Error ? err.message : '选择数据目录失败' })
      return
    } finally {
      setPickingDir(false)
    }

    setMigrating(true)
    try {
      const res = await invoke('app:changeDataDir', { targetDir })
      if (res.changed) {
        setInfo((prev) => (prev ? { ...prev, dataDir: res.dataDir } : prev))
        setMigrateMsg({ ok: true, text: `已迁移至 ${res.dataDir}` })
      }
    } catch (err) {
      setMigrateMsg({ ok: false, text: err instanceof Error ? err.message : '迁移数据目录失败' })
    } finally {
      setMigrating(false)
    }
  }

  const nameChanged = appNameDraft.trim() !== (settings.appName ?? '')

  return (
    <Section title="系统设置" desc="配置应用名称与图标、桌面启动行为、全局唤起快捷键及本地数据存储路径。">
      <Row label="应用名称" hint="显示在侧边栏顶部、窗口标题与系统托盘提示中，留空使用默认名称 DeskPartner">
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={appNameDraft}
            onChange={(e) => setAppNameDraft(e.target.value)}
            onBlur={() => void saveAppName()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void saveAppName()
            }}
            placeholder="DeskPartner"
            maxLength={32}
            data-testid="app-name-input"
            className="h-8 w-44 px-2.5 rounded-button border border-border bg-bg-card text-label text-text-primary placeholder:text-text-secondary/50 outline-none focus:border-accent transition-colors"
          />
          {nameChanged && (
            <Button
              variant="ghost"
              size="sm"
              className="border border-border bg-surface-subtle hover:bg-surface-muted px-2.5 text-text-primary cursor-pointer"
              onClick={() => void saveAppName()}
            >
              保存
            </Button>
          )}
          {Boolean(settings.appName?.trim()) && (
            <Button
              variant="ghost"
              size="sm"
              className="border border-border bg-surface-subtle hover:bg-surface-muted px-2.5 text-text-secondary hover:text-text-primary cursor-pointer"
              onClick={() => {
                setAppNameDraft('')
                void updateSettings({ appName: '' })
              }}
            >
              恢复默认
            </Button>
          )}
        </div>
      </Row>

      <Row label="应用图标" hint="作用于悬浮球、侧边栏、窗口图标与系统托盘（支持 PNG / ICO / JPG）">
        <div className="flex items-center gap-2">
          <div
            data-testid="app-icon-preview"
            className="w-8 h-8 rounded-full border border-border/70 bg-white flex items-center justify-center overflow-hidden shrink-0"
          >
            <img
              src={settings.appIcon || partnerBadge}
              alt=""
              draggable={false}
              className="w-full h-full object-contain"
            />
          </div>
          <Button
            variant="ghost"
            size="sm"
            disabled={pickingIcon}
            className="border border-border bg-surface-subtle hover:bg-surface-muted px-2.5 text-text-primary cursor-pointer"
            onClick={() => void pickAppIcon()}
          >
            更换图标
          </Button>
          {Boolean(settings.appIcon) && (
            <Button
              variant="ghost"
              size="sm"
              className="border border-border bg-surface-subtle hover:bg-surface-muted px-2.5 text-text-secondary hover:text-text-primary cursor-pointer"
              onClick={() => void updateSettings({ appIcon: null })}
            >
              恢复默认
            </Button>
          )}
        </div>
      </Row>
      {iconError && <p className="text-label text-danger -mt-1 pl-1">{iconError}</p>}

      <Row label="开机自启" hint="随系统启动，登录后自动驻留托盘">
        <Switch
          checked={settings.autoStart}
          onChange={(v) => updateSettings({ autoStart: v })}
        />
      </Row>
      <Row label="自动检查更新" hint="启动时仅访问 GitHub Releases 检查新版本，不上传任何数据">
        <Switch
          checked={settings.autoCheckUpdate ?? true}
          onChange={(v) => updateSettings({ autoCheckUpdate: v })}
        />
      </Row>
      <Row label="全局快捷键" hint="任意界面下唤起速记弹窗，需包含 Ctrl / Alt / Shift">
        <ShortcutInput
          value={settings.globalShortcut}
          onChange={(v) => updateSettings({ globalShortcut: v })}
        />
      </Row>

      {warning && <p className="text-label text-danger -mt-1 pl-1">{warning}</p>}

      <Row
        label="数据存储目录"
        hint="本地 SQLite 数据库（user.db）及自动快照备份的存储位置"
      >
        <div className="flex items-center gap-2">
          <span className="px-2.5 py-1 rounded-xs bg-surface-subtle border border-border/70 font-mono text-caption text-text-secondary max-w-72 truncate" title={info?.dataDir}>
            {info?.dataDir ?? '读取中…'}
          </span>
          {info?.dataDir && (
            <>
              <Button
                variant="ghost"
                size="sm"
                className="border border-border bg-surface-subtle hover:bg-surface-muted px-2.5 text-text-primary cursor-pointer"
                onClick={() => void invoke('app:openDataDir')}
              >
                打开目录
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={pickingDir || migrating}
                className="border border-border bg-surface-subtle hover:bg-surface-muted px-2.5 text-text-primary cursor-pointer"
                onClick={() => void changeDataDir()}
              >
                {migrating ? '迁移中…' : '变更目录'}
              </Button>
            </>
          )}
        </div>
      </Row>
      {migrateMsg && (
        <p className={migrateMsg.ok ? 'text-label text-text-secondary -mt-1 pl-1' : 'text-label text-danger -mt-1 pl-1'}>
          {migrateMsg.text}
        </p>
      )}

      <Row label="当前版本" hint="客户端程序与内置 CLI / MCP 服务版本">
        <div className="flex flex-wrap items-center gap-2">
          <span className="px-2.5 py-0.5 rounded-full bg-surface-subtle border border-border/70 text-caption text-text-primary font-mono font-medium">
            v{info?.version ?? '—'}
          </span>
          {updateState?.status === 'available' && updateState.availableVersion ? (
            <Button
              variant="primary"
              size="sm"
              data-testid="download-update-btn"
              onClick={() => {
                autoInstallPendingRef.current = true
                void invoke('app:downloadUpdate').then(setUpdateState).catch(() => undefined)
              }}
            >
              立即更新 v{updateState.availableVersion}
            </Button>
          ) : updateState?.status === 'downloading' ? (
            <span className="text-caption text-text-secondary">
              下载中 {updateState.progressPercent ?? 0}%…
            </span>
          ) : updateState?.status === 'downloaded' ? (
            <Button
              variant="primary"
              size="sm"
              data-testid="install-update-btn"
              onClick={() => {
                void invoke('app:quitAndInstallUpdate')
              }}
            >
              重启并安装 v{updateState.availableVersion ?? ''}
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              disabled={updateState?.status === 'checking'}
              data-testid="check-update-btn"
              className="border border-border bg-surface-subtle hover:bg-surface-muted px-2.5 text-text-primary cursor-pointer"
              onClick={() => {
                setUpdateState((prev) =>
                  prev
                    ? { ...prev, status: 'checking', errorMessage: null }
                    : {
                        status: 'checking',
                        currentVersion: info?.version ?? '',
                        availableVersion: null,
                        releaseDate: null,
                        progressPercent: null,
                        errorMessage: null,
                        checkedAt: null
                      }
                )
                void invoke('app:checkForUpdates').then(setUpdateState).catch(() => undefined)
              }}
            >
              {updateState?.status === 'checking' ? '检查中…' : '检查更新'}
            </Button>
          )}
          {updateState?.status === 'not-available' && updateState.checkedAt && (
            <span className="text-caption text-text-secondary">已是最新</span>
          )}
          {updateState?.status === 'error' && updateState.errorMessage && (
            <span className="text-caption text-danger" title={updateState.errorMessage}>
              {/* 检查失败与下载失败是两件事，别都说成"检查失败"（卡 `99870984`）：主进程给下载错误加了「下载更新失败：」前缀 */}
              {updateState.errorMessage.includes('下载') ? '下载失败' : '检查失败'}
            </span>
          )}
        </div>
      </Row>

      {(pickingDir || pickingIcon || migrating) && (
        <div
          data-testid="system-modal-lock"
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 bg-black/25 flex items-center justify-center select-none"
        >
          <div className="rounded-card border border-border bg-bg-card px-5 py-4 shadow-float flex flex-col gap-1.5 max-w-sm text-center">
            <span className="text-body font-medium text-text-primary">
              {migrating
                ? '正在迁移数据存储目录…'
                : pickingDir
                  ? '请在弹出的系统窗口中选择目标目录'
                  : '请在弹出的系统窗口中选择应用图标'}
            </span>
            <span className="text-caption text-text-secondary">
              {migrating
                ? '正在同步复制数据库与历史快照备份，完成前请勿进行其他操作'
                : '完成选择或取消后即可继续操作'}
            </span>
          </div>
        </div>
      )}
    </Section>
  )
}
