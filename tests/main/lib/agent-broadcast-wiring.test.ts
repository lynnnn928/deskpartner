import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 身份状态变了要广播（2026-11-14，复审 round 3）
 *
 * ── 要拦的是什么 ──
 *
 * 上手清单第 2 行的判据来自 agent store（"有没有人在申请"），而这个 store 只认
 * `agent_register` 与 `grant` 两类事件。于是「批准 / 拒绝某个身份」这类动作
 * **必须广播**，否则界面会继续说自己都推翻的话：
 *
 * - 批准了：清单停在 1/5，气泡还指着审批页说"你的助手在门外"（1.0.146 走查抓到，
 *   `agent:setApproved` 那时补的广播）；
 * - 拒绝了：清单继续写「它申请写入你的项目」，而库里这个身份已经被结案
 *   —— 走查实测，第 2 行文案与事实相反，且没有任何可点的东西。
 *
 * ── 判据（结构性，不锁文案） ──
 *
 * `agent:setApproved` 与 `agent:setRejected` 的处理体里都要出现
 * `broadcastDataChanged('grant'`。少一处就红，并说清为什么这一处也要广播。
 *
 * ── 反向验证 ──
 *
 * 把 `agent:setRejected` 里那行广播删掉，本用例必须红（写完立即注入验证过）。
 */

const ROOT = path.resolve(__dirname, '../../..')
const IPC_SRC = path.join(ROOT, 'src/main/ipc.ts')

/** 从源码里抠出某个 `ipcMain.handle('xxx', ...)` 的完整调用（见 banner-dismiss-wiring 的同类注释） */
function blockOf(src: string, marker: string): string | null {
  const at = src.indexOf(marker)
  if (at < 0) return null
  const handleAt = src.lastIndexOf('ipcMain.handle', at)
  if (handleAt < 0) return null
  const open = src.indexOf('(', handleAt)
  if (open < 0) return null
  let depth = 0
  for (let i = open; i < src.length; i++) {
    const ch = src[i]
    if (ch === '(') depth++
    else if (ch === ')') {
      depth--
      if (depth === 0) return src.slice(handleAt, i + 1)
    }
  }
  return null
}

/** 剥注释：注释里写 `broadcastDataChanged('grant')` 不该算接上了线 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

describe('身份状态变化要广播给界面', () => {
  const src = stripComments(fs.readFileSync(IPC_SRC, 'utf8'))

  for (const channel of ['agent:setApproved', 'agent:setRejected']) {
    it(`${channel} 处理完要广播 grant —— 否则清单在说与事实相反的话`, () => {
      const block = blockOf(src, `'${channel}'`)
      expect(block, `ipc.ts 里找不到 ${channel}`).not.toBeNull()
      expect(
        /broadcastDataChanged\(\s*'grant'/.test(block!),
        `${channel} 没有广播：agent store 只认 agent_register / grant 两类事件，` +
          '不广播它就拿不到信号，上手清单第 2 行会继续写「它申请写入你的项目」'
      ).toBe(true)
    })
  }
})
