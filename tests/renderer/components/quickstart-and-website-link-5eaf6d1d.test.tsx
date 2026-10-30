// @vitest-environment happy-dom
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, waitFor, cleanup } from '@testing-library/react'

/**
 * 卡 `5eaf6d1d`：快速上手改全宽单页 + 静态手册迁到官网 + 客户端新增官网 / 在线手册入口。
 *
 * 本文件钉四件事：
 *   ① `app:openExternal` 的 URL 白名单只认官网与官方仓库（其余协议、域名一律拒）——
 *      这是"渲染层给出什么就打开什么"那条路唯一的闸门；
 *   ② 快速上手不再有左侧二级章节栏，主内容是 `max-w-5xl` 全宽单页；
 *   ③ 快速上手顶部「访问产品官网」与底部「查看在线使用手册」各自发出正确的 IPC；
 *   ④ 设置·系统组的「产品官网与手册」两个按钮同样发出正确的 IPC。
 *
 * 为什么 ③④ 要渲染真组件而不是读源码：入口写错 URL（比如漏了 `#manual`）在源码断言里
 * 看不出来，只有点下去才知道打开的是哪一页。
 */

const ACCESS = {
  cliPath: 'D:\\Apps\\DeskPartner\\resources\\cli\\deskpartner.cjs',
  cliEnvVar: 'DESKPARTNER_CLI',
  cliEnvAvailable: true,
  mcpCommand: 'D:\\Apps\\DeskPartner\\resources\\cli\\mcp.cmd'
}

const invokeMock = vi.fn()

vi.mock('../../../src/renderer/lib/ipc-client', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  on: () => () => {}
}))

/**
 * `src/main/ipc.ts` 的传递依赖都会 import electron；这里给一份最小替身，
 * 只为让 `isAllowedExternalUrl` 这个纯函数能单独被 import 进来。
 */
vi.mock('electron', () => {
  const noop = (): void => undefined
  const app = {
    getVersion: () => '1.0.0',
    getName: () => 'DeskPartner',
    getPath: () => 'C:/tmp',
    setPath: noop,
    isPackaged: false,
    whenReady: () => Promise.resolve(),
    on: noop,
    once: noop,
    quit: noop
  }
  class BrowserWindow {
    static getAllWindows(): unknown[] {
      return []
    }
    static fromWebContents(): null {
      return null
    }
  }
  return {
    app,
    BrowserWindow,
    ipcMain: { handle: noop, on: noop, removeHandler: noop },
    dialog: {
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      showSaveDialog: async () => ({ canceled: true, filePath: undefined })
    },
    shell: { openExternal: async () => undefined, openPath: async () => '' },
    nativeImage: {
      createFromPath: () => ({ isEmpty: () => true, getSize: () => ({ width: 0, height: 0 }) }),
      createFromDataURL: () => ({ isEmpty: () => false, resize: () => ({ toDataURL: () => '' }) })
    },
    session: { defaultSession: { on: noop, setPermissionRequestHandler: noop } },
    globalShortcut: { register: () => true, unregister: noop, unregisterAll: noop, isRegistered: () => false },
    Tray: class {},
    Menu: { buildFromTemplate: () => ({}), setApplicationMenu: noop },
    Notification: class {
      static isSupported(): boolean {
        return false
      }
    }
  }
})

import { isAllowedExternalUrl } from '../../../src/main/ipc'
import { QuickStartView } from '../../../src/renderer/components/onboarding/QuickStartView'
import { SystemSection } from '../../../src/renderer/components/settings/sections/SystemSection'

const WEBSITE = 'https://lynnnn928.github.io/deskpartner/'
const MANUAL = 'https://lynnnn928.github.io/deskpartner/#manual'

describe('app:openExternal 白名单（卡 5eaf6d1d）', () => {
  it('放行产品官网与官方 GitHub 仓库（含子路径）', () => {
    const allowed = [
      WEBSITE,
      MANUAL,
      'https://lynnnn928.github.io/deskpartner',
      'https://github.com/lynnnn928/deskpartner',
      'https://github.com/lynnnn928/deskpartner/releases'
    ]
    for (const url of allowed) {
      expect(isAllowedExternalUrl(url), `应放行：${url}`).toBe(true)
    }
  })

  it('拦截 http / 其它域名 / javascript: / file:', () => {
    const blocked = [
      'http://lynnnn928.github.io/deskpartner/',
      'https://evil.com/deskpartner',
      'javascript:alert(1)',
      'file:///C:/Windows/win.ini',
      'https://lynnnn928.github.io/deskpartner-evil',
      'https://github.com/lynnnn928',
      'not a url',
      ''
    ]
    for (const url of blocked) {
      expect(isAllowedExternalUrl(url), `应拦截：${url}`).toBe(false)
    }
  })
})

describe('快速上手：全宽单页 + 官网 / 在线手册入口（卡 5eaf6d1d）', () => {
  beforeEach(() => {
    cleanup()
    invokeMock.mockReset()
    invokeMock.mockImplementation((channel: string) => {
      if (channel === 'cli:connectInfo') return Promise.resolve(ACCESS)
      if (channel === 'agent:list') return Promise.resolve([])
      if (channel === 'project:list') return Promise.resolve([])
      return Promise.resolve(null)
    })
  })

  it('没有左侧二级章节栏，主内容区是 max-w-5xl 全宽布局', () => {
    const { container, queryByRole, getByText } = render(<QuickStartView />)

    expect(queryByRole('navigation', { name: '帮助与产品手册目录' })).toBeNull()
    expect(container.querySelector('.max-w-5xl')).toBeTruthy()
    expect(container.querySelector('.max-w-4xl')).toBeNull()
    // 保留下来的两块本机交互内容
    expect(getByText('一张图看懂 DeskPartner 如何协同工作')).toBeTruthy()
    expect(getByText('三步接入你的 AI 助手')).toBeTruthy()
    // 迁走的那 5 章不再混在本地
    expect(container.textContent ?? '').not.toContain('2. 事项与工作流')
    expect(container.textContent ?? '').not.toContain('6. 数据安全与备份')
  })

  it('顶部「访问产品官网」与底部「查看在线使用手册」分别发出正确的 openExternal', async () => {
    const { getByTestId } = render(<QuickStartView />)

    fireEvent.click(getByTestId('quickstart-open-website-btn'))
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('app:openExternal', { url: WEBSITE })
    })

    fireEvent.click(getByTestId('quickstart-open-manual-btn'))
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('app:openExternal', { url: MANUAL })
    })
  })
})

describe('设置·系统组：产品官网与手册入口（卡 5eaf6d1d）', () => {
  beforeEach(() => {
    cleanup()
    invokeMock.mockReset()
    invokeMock.mockImplementation((channel: string) => {
      if (channel === 'app:info') return Promise.resolve({ version: '1.0.150', dataDir: 'C:\\Data' })
      if (channel === 'app:getUpdateState') {
        return Promise.resolve({
          status: 'not-available',
          currentVersion: '1.0.150',
          availableVersion: null,
          releaseDate: null,
          progressPercent: null,
          errorMessage: null,
          checkedAt: null
        })
      }
      return Promise.resolve(null)
    })
  })

  it('两个按钮各自发出对应的 openExternal', async () => {
    const { getByTestId, getByText } = render(<SystemSection />)
    await waitFor(() => expect(getByText('产品官网 ↗')).toBeTruthy())

    fireEvent.click(getByTestId('system-open-website-btn'))
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('app:openExternal', { url: WEBSITE })
    })

    fireEvent.click(getByTestId('system-open-manual-btn'))
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('app:openExternal', { url: MANUAL })
    })
  })
})
