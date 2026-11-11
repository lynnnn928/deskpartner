import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

/**
 * 凭据文件在 Windows 上的权限收口（卡 `6b77c794`）
 *
 * 判据用**真实的 icacls**跑差分，不 mock：
 * 同一个目录下普通写出来的文件带着继承来的授权（`(I)`），而凭据文件写完后
 * 断开了继承、只剩当前账户 —— 那正是 `/inheritance:r` 跑过的证据。
 */
import { writeCredential, removeCredential } from '../../../src/cli/credentials'

const onlyOnWindows = process.platform === 'win32' ? describe : describe.skip

/** 读文件的 ACL 原文（latin1 保住 ASCII 标记，中文提示乱码与否不影响判据） */
function aclOf(file: string): string {
  // stdio 必须显式声明：仓库闸门 spawn-stdio-guard 拦"读 stdout 却没写 stdio"的调用
  return execFileSync('icacls', [file], { encoding: 'latin1', stdio: ['ignore', 'pipe', 'pipe'] })
}

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

  it('签发凭据后，文件上不再有继承来的授权（普通文件有）', () => {
    const control = path.join(dir, 'control.json')
    fs.writeFileSync(control, '{"control":true}')

    writeCredential('agent:x', 'tok-1')

    // 对照：同一目录里的普通文件继承着目录的授权
    expect(aclOf(control)).toContain('(I)')
    // 凭据文件：断继承之后不该再有 (I)
    expect(aclOf(file)).not.toContain('(I)')
  })

  it('收口之后凭据内容仍然完整', () => {
    writeCredential('agent:y', 'tok-2')

    const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
    expect(saved.profiles['agent:y'].token).toBe('tok-2')
    expect(saved.default).toBe('agent:y')
  })

  it('删除某份凭据后同样只剩自己的授权', () => {
    writeCredential('agent:z', 'tok-3')
    writeCredential('agent:w', 'tok-4')

    const res = removeCredential('agent:z')

    expect(res.removed).toBe(true)
    expect(aclOf(file)).not.toContain('(I)')
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).profiles).not.toHaveProperty('agent:z')
  })

  it('没有这个身份时不写文件，也不去动权限', () => {
    const res = removeCredential('agent:never-issued')

    expect(res.removed).toBe(false)
    expect(fs.existsSync(file)).toBe(false)
  })
})
