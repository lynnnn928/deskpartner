import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

/**
 * 凭据文件在 Windows 上的权限收口（卡 `6b77c794`）
 *
 * 判据用**真实的 icacls**跑差分，不 mock：同一目录里刚写出来的普通文件会带上
 * 环境给的授权，而凭据文件写完后断开了继承 —— 那正是 `/inheritance:r` 跑过的证据。
 *
 * ## 判据为什么要写成"集合差分"，不能数条数、更不能找 `(I)`（2026-11-11 CI 两次红）
 *
 * GitHub 的 Windows runner 上，普通文件列出来是
 *
 *   `control.json NT AUTHORITY\SYSTEM:(F) / BUILTIN\Administrators:(F) / runneradmin:(F)`
 *
 * —— 有授权、一个 `(I)` 都不带（那台机器上新建文件拿到的是**令牌默认 DACL**：
 * 属主 + SYSTEM + Administrators，作为显式 ACE，不是继承来的）。
 * 于是两种写法都会假红：
 *   - `toContain('(I)')` → 那台机器永远没有 `(I)`；
 *   - `aceCount(file) === 1` → 断继承只去掉**继承来的**那几条，默认 DACL 那几条留着。
 *
 * 现在只问一件事：**同一目录里，普通文件是不是带着凭据文件没有的授权**。
 * 主体名按系统语言走，所以只做集合比较、不做名字匹配；"别人也能读"那条授权
 * 由用例自己加到目录上（Users 的 SID，免受语言与令牌默认 DACL 影响），
 * 免得某台机器恰好什么都没给、断言变成空转。
 */
import { writeCredential, removeCredential } from '../../../src/cli/credentials'

const onlyOnWindows = process.platform === 'win32' ? describe : describe.skip

/** 读文件的 ACL 原文（latin1 保住 ASCII 标记，中文提示乱码与否不影响判据） */
function aclOf(target: string): string {
  // stdio 必须显式声明：仓库闸门 spawn-stdio-guard 拦"读 stdout 却没写 stdio"的调用
  return execFileSync('icacls', [target], { encoding: 'latin1', stdio: ['ignore', 'pipe', 'pipe'] })
}

/** 输出里每个授权的主体的原始写法（`主体:(权限)`，名字随系统语言，只用来做集合比较） */
function principals(acl: string): Set<string> {
  return new Set((acl.match(/[^\s:]+:\s*\(/g) ?? []).map((m) => m.replace(/\s+/g, '')))
}

/** 给目录加一条可继承的授权：这就是"别人也能读"的来源（Users 的 SID，不受语言影响） */
function grantOthersInherit(dir: string): void {
  execFileSync('icacls', [dir, '/grant', '*S-1-5-32-545:(OI)(CI)(R)'], {
    stdio: ['ignore', 'ignore', 'pipe']
  })
}

onlyOnWindows('凭据文件的 Windows 权限收口（卡 6b77c794）', () => {
  let dir = ''
  let file = ''
  const cleanups: string[] = []

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-cred-acl-'))
    cleanups.push(dir)
    file = path.join(dir, 'credentials.json')
    process.env.DESKPARTNER_CREDENTIALS_FILE = file
  })

  afterEach(() => {
    delete process.env.DESKPARTNER_CREDENTIALS_FILE
    for (const d of cleanups.splice(0)) {
      try {
        fs.rmSync(d, { recursive: true, force: true })
      } catch {
        /* 清理失败不影响断言 */
      }
    }
  })

  /** 普通文件与凭据文件的授权集合差：差别就是"继承被断掉"这件事 */
  const diffAgainstControl = () => {
    grantOthersInherit(dir)
    const control = path.join(dir, 'control.json')
    fs.writeFileSync(control, '{"control":true}')
    const controlPrincipals = principals(aclOf(control))
    const filePrincipals = principals(aclOf(file))
    const onlyOnControl = [...controlPrincipals].filter((p) => !filePrincipals.has(p))
    return { control, controlPrincipals, filePrincipals, onlyOnControl }
  }

  it('签发凭据后只剩自己的授权（同一目录的普通文件会带上别人）', () => {
    writeCredential('agent:x', 'tok-1')

    const { control, filePrincipals, onlyOnControl } = diffAgainstControl()
    // 凭据文件上留着的是自己
    expect([...filePrincipals].some((p) => p.includes(os.userInfo().username)), aclOf(file)).toBe(true)
    // 普通文件带着凭据文件没有的授权 —— 差别为空就说明继承根本没被断掉
    expect(onlyOnControl, `control=${aclOf(control)}\nfile=${aclOf(file)}`).not.toEqual([])
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
    const { control, filePrincipals, onlyOnControl } = diffAgainstControl()
    expect([...filePrincipals].some((p) => p.includes(os.userInfo().username)), aclOf(file)).toBe(true)
    expect(onlyOnControl, `control=${aclOf(control)}\nfile=${aclOf(file)}`).not.toEqual([])
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).profiles).not.toHaveProperty('agent:b')
  })

  it('没有这个身份时不写文件，也不去动权限', () => {
    const res = removeCredential('agent:never-registered')

    expect(res.removed).toBe(false)
    expect(fs.existsSync(file)).toBe(false)
  })
})
