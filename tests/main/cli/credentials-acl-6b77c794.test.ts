import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

/**
 * 凭据文件在 Windows 上的权限收口（卡 `6b77c794`）
 *
 * 判据用**真实的 icacls**跑差分，不 mock：同一目录里刚写出来的普通文件带着环境给的授权，
 * 而凭据文件写完后只剩当前账户 —— 那正是 `/inheritance:r` 跑过的证据。
 *
 * ⚠️ **不能拿 `(I)` 标记当判据**（2026-11-11 CI 实测）：GitHub 的 Windows runner 上，
 * 临时目录里的普通文件列出来是
 *   `control.json NT AUTHORITY\SYSTEM:(F) / BUILTIN\Administrators:(F) / …`
 * —— 有授权、但一个 `(I)` 都没有，于是"普通文件含 (I)"这条断言在 CI 上恒红。
 * 换成不依赖标记的判据：**数 ACE 条数**（`X:(perms)` 出现几次），
 * 并且那条"别人也有"的授权由用例自己加到临时目录上（SYSTEM 的 SID，免受语言影响），
 * 免得这台机器恰好什么都没给、用例变成空转。
 */
import { writeCredential, removeCredential } from '../../../src/cli/credentials'

const onlyOnWindows = process.platform === 'win32' ? describe : describe.skip

/** 读文件的 ACL 原文（latin1 保住 ASCII 标记，中文提示乱码与否不影响判据） */
function aclOf(file: string): string {
  // stdio 必须显式声明：仓库闸门 spawn-stdio-guard 拦"读 stdout 却没写 stdio"的调用
  return execFileSync('icacls', [file], { encoding: 'latin1', stdio: ['ignore', 'pipe', 'pipe'] })
}

function grantEveryoneInherit(dir: string): void {
  // `*S-1-5-18` 是 NT AUTHORITY\SYSTEM 的 SID：写 SID 就不受系统语言影响
  execFileSync('icacls', [dir, '/grant', '*S-1-5-18:(OI)(CI)(F)'], {
    stdio: ['ignore', 'ignore', 'pipe']
  })
}

/** icacls 的输出里每个授权一条 `主体:(权限)` —— 数它，比找标记稳 */
const aceCount = (acl: string) => (acl.match(/:\(/g) ?? []).length

onlyOnWindows('凭据文件的 Windows 权限收口（卡 6b77c794）', () => {
  let dir = ''
  let file = ''

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-cred-acl-'))
    file = path.join(dir, 'credentials.json')
    process.env.DESKPARTNER_CREDENTIALS_FILE = file
  })

  afterEach(() => {
    delete process.env.DESKPARTNER_CREDENTIALS_FILE
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* 清理失败不影响断言 */
    }
  })

  it('签发凭据后只剩当前账户的授权（同一目录的普通文件会带上别人）', () => {
    // 差别由用例自己造出来，不赌运行机器的临时目录怎么配
    grantEveryoneInherit(dir)
    const control = path.join(dir, 'control.json')
    fs.writeFileSync(control, '{"control":true}')

    writeCredential('agent:x', 'tok-1')

    const controlAces = aceCount(aclOf(control))
    const fileAces = aceCount(aclOf(file))
    // 对照：普通文件继承了目录给的授权（SYSTEM + 当前账户…）
    expect(controlAces, aclOf(control)).toBeGreaterThan(1)
    // 凭据文件：断继承之后只剩一条，给自己
    expect(fileAces, aclOf(file)).toBe(1)
    expect(controlAces).toBeGreaterThan(fileAces)
  })

  it('收口之后凭据内容仍然完整', () => {
    writeCredential('agent:a', 'tok-2')

    const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
    expect(saved.profiles['agent:a'].token).toBe('tok-2')
    expect(saved.default).toBe('agent:a')
  })

  it('删除某份凭据后同样只剩自己的授权', () => {
    writeCredential('agent:b', 'tok-3')
    writeCredential('agent:c', 'tok-4')

    const res = removeCredential('agent:b')

    expect(res.removed).toBe(true)
    expect(aceCount(aclOf(file)), aclOf(file)).toBe(1)
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).profiles).not.toHaveProperty('agent:b')
  })

  it('没有这个身份时不写文件，也不去动权限', () => {
    const res = removeCredential('agent:never-registered')

    expect(res.removed).toBe(false)
    expect(fs.existsSync(file)).toBe(false)
  })
})
