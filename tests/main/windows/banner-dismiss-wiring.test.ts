import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 「这件事处理完了，横幅就得收」的结构性闸门（1.0.65）
 *
 * ── 要拦的是什么 ──
 *
 * 主用户 2026-10-01 截图：桌面上挂着「Carol 已接入，等你批准写入」，
 * 而审批页里实际待批的是「Carol 想【改界面】ui reset」。
 * 上半句是**内容对不上**（已由 hash-driven-window.test.ts 那条管），
 * 这条管的是下半句：**那条横幅根本收不掉**。
 *
 * 顶部横幅是 `alwaysOnTop` 的 `screen-saver` 层、还 `skipTaskbar`，
 * 而它**没有任何自动收起机制**（windows.ts 里没有定时器；组件只有
 * 直批回执那条路会在 2.6s 后自己收）。也就是说：
 * **它弹着的时候，每一个"事情已经处理了"的出口都必须主动收它**，
 * 忘掉一个，横幅就永久钉在屏幕最上层，看起来像"我批完了它还说我没批"。
 *
 * 实测缺陷：授权申请那条路（`agent:resolveGrant`）早就收了，
 * **批准身份这条路（`agent:setApproved` / `agent:setRejected`）没收** ——
 * 于是新 agent 接入的横幅，无论点「批准写入」还是「我不想批准它」，
 * 都一直挂在屏幕顶上。这正是截图里那条横幅的状态。
 *
 * ── 判据（结构性，不锁文案） ──
 *
 * ipc.ts 里这几个 handle 的处理体，都必须调用收横幅的函数。
 * 少一个就红，并在报错里说清"为什么这个出口也要收"。
 *
 * ── 反向验证 ──
 *
 * 把 `agent:setApproved` 里的 `hideReminderBanners()` 删掉，本测试必须变红。
 * 写完立即用注入故障的方式验证过一次。
 */

const ROOT = path.resolve(__dirname, '../../..')
const IPC_SRC = path.join(ROOT, 'src/main/ipc.ts')

/**
 * 每个必须收横幅的 IPC 出口，以及"为什么它也要收"。
 *
 * 判据是**语义**而不是命令名：凡是"人在这里做完了关于某条横幅的决定"的出口，
 * 横幅就过期了。以后新增同类出口（比如再给某个申请加一个"稍后处理"），
 * 一并加进这个表 —— 表本身就是"哪些出口要收"的规格。
 */
const MUST_DISMISS: { channel: string; why: string }[] = [
  {
    channel: 'agent:resolveGrant',
    why: '人对授权申请表态（允许/拒绝）= 那条申请横幅的结论已出'
  },
  {
    channel: 'agent:setApproved',
    why: '人批准/取消批准一个身份 = 「它刚到，等你批准写入」的横幅已经过期'
  },
  {
    channel: 'agent:setRejected',
    why: '人明确拒绝一个身份 = 同样过期（这是"我不想批准它"的出口）'
  }
]

/** 收横幅的函数名（抽出来是为了让三处共用一份实现，不各写一遍） */
const DISMISS_FN = 'hideReminderBanners'

/**
 * 从源码里抠出某个 `ipcMain.handle('xxx', ...)` 的完整调用。
 *
 * 两个坑，都踩过：
 * ①不能从 marker（`'agent:setApproved'`）往后找第一个 `(` 就配平 ——
 *   那抓到的是**参数列表** `(e, {…})`，函数体在箭头后面，压根不含在内，
 *   于是"明明接了线"却报没接线。要从外层 `ipcMain.handle(` 开始配平。
 * ②不能按固定长度截窗口 —— handle 内部有嵌套回调，截短了漏、截长了
 *   会把邻居 handle 里的调用算到自己头上（假绿）。
 */
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

/**
 * 剥掉注释再断言：**注释里提到的字面量不该被判成"内联实现"**。
 * （这条是实测踩出来的：实现注释里写了一句"不是按 `includes(...)` 找"，
 *   结果被自己的闸门当成"内联实现还在"报红。注释写得越详细越容易违规，
 *   这种闸门只会逼人删注释。）
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

describe('横幅收起接线（1.0.65）', () => {
  const raw = fs.readFileSync(IPC_SRC, 'utf8')
  const src = stripComments(raw)

  it('收横幅的实现存在，且只此一份（三处共用，不各写一遍）', () => {
    const defs = src.match(new RegExp(`function\\s+${DISMISS_FN}\\s*\\(`, 'g')) ?? []
    expect(defs.length, `应当只有一个 ${DISMISS_FN} 定义`).toBe(1)
    // 内联的按子串遍历写法不该再出现 —— 那是"第二份实现"的味道
    const inline = /webContents\.getURL\(\)[^)]*\)[^\n]*includes\(/.test(src)
    expect(inline, '不该再有内联的"按子串找横幅"实现').toBe(false)
  })

  for (const { channel, why } of MUST_DISMISS) {
    it(`${channel} 处理完要收横幅 —— ${why}`, () => {
      const block = blockOf(src, `'${channel}'`)
      expect(block, `ipc.ts 里找不到 ${channel}`).not.toBeNull()
      /**
       * 认两种写法：`hideReminderBanners()` 直接调，以及
       * `setTimeout(hideReminderBanners, 2600)` 传引用（授权申请那条路
       * 要延迟 2.6s，先让人看见回执 —— 传引用是**正确**写法，
       * 断言只认括号会把它误判成"没接线"）。
       * 判据是这个函数**出现在该 handle 的处理体里**，不管怎么被调。
       */
      const wired = new RegExp(`\\b${DISMISS_FN}\\b`).test(block!)
      expect(
        wired,
        `${channel} 没有调用 ${DISMISS_FN}()：${why}。\n` +
          '横幅无自动收起且是置顶窗口，不收就永久钉在屏幕最上层 —— ' +
          '看起来像"处理完了它还说没处理"。'
      ).toBe(true)
    })
  }
})
