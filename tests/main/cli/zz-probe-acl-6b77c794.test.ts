import { describe, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { writeCredential } from '../../../src/cli/credentials'

/**
 * 临时探针（用完即删）：把"凭据文件权限收口"在**这台机器**上的现场逐步打出来。
 *
 * 为什么要它：本地（这台机器）三次写入都只留 1 条 ACE，而 CI 的 Windows runner 上
 * 删除后仍留着 3 条 —— 两种环境的"新建文件拿到什么 DACL"不一样，光看断言猜不出来。
 * 探针把目录/普通文件/凭据文件的 ACL 原文、手动 icacls 的退出码与 stderr、
 * 以及"能不能用 /remove:g 把那几条清掉"一次性打全。
 */
const acl = (t: string) => execFileSync('icacls', [t], { encoding: 'latin1', stdio: ['ignore', 'pipe', 'pipe'] })
const n = (s: string) => (s.match(/:\(/g) ?? []).length

describe('探针：收口现场', () => {
  it('逐步打印', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-acl-probe-'))
    const file = path.join(dir, 'credentials.json')
    process.env.DESKPARTNER_CREDENTIALS_FILE = file
    const user = os.userInfo().username
    console.log('[probe] username =', JSON.stringify(user))

    console.log('[probe] 目录: 条数', n(acl(dir)), '|', JSON.stringify(acl(dir)))
    execFileSync('icacls', [dir, '/grant', '*S-1-5-32-545:(OI)(CI)(R)'], { stdio: ['ignore', 'ignore', 'pipe'] })
    console.log('[probe] 加 Users 继承后 目录: 条数', n(acl(dir)), '|', JSON.stringify(acl(dir)))

    const control = path.join(dir, 'control.json')
    fs.writeFileSync(control, '{}')
    console.log('[probe] 普通文件: 条数', n(acl(control)), '|', JSON.stringify(acl(control)))

    writeCredential('agent:a', 't1')
    console.log('[probe] 凭据文件(产品写入后): 条数', n(acl(file)), '|', JSON.stringify(acl(file)))

    const cmd = [file, '/inheritance:r', '/grant:r', `${user}:F`]
    try {
      const out = execFileSync('icacls', cmd, { encoding: 'latin1', stdio: ['ignore', 'pipe', 'pipe'] })
      console.log('[probe] 手动 icacls 成功:', JSON.stringify(out))
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string }
      console.log('[probe] 手动 icacls 失败:', e.status, JSON.stringify(e.stdout), JSON.stringify(e.stderr))
    }
    console.log('[probe] 手动之后: 条数', n(acl(file)), '|', JSON.stringify(acl(file)))

    // 探路：把默认 DACL 里那几条也一并清掉，是否可行（候选修法）
    for (const spec of [
      ['/remove:g', '*S-1-5-18', '*S-1-5-32-544'],
      ['/remove', '*S-1-5-18', '*S-1-5-32-544']
    ]) {
      try {
        const out = execFileSync('icacls', [file, ...spec], { encoding: 'latin1', stdio: ['ignore', 'pipe', 'pipe'] })
        console.log(`[probe] ${spec[0]} 成功:`, JSON.stringify(out), '→ 条数', n(acl(file)))
      } catch (err) {
        const e = err as { status?: number; stdout?: string; stderr?: string }
        console.log(`[probe] ${spec[0]} 失败:`, e.status, JSON.stringify(e.stderr))
      }
      console.log(`[probe] ${spec[0]} 之后: 条数`, n(acl(file)), '|', JSON.stringify(acl(file)))
      // 复位，供下一轮试探
      try {
        execFileSync('icacls', [file, '/inheritance:r', '/grant:r', `${user}:F`], { stdio: ['ignore', 'ignore', 'pipe'] })
      } catch {
        /* 忽略 */
      }
    }

    console.log('[probe] 结束时: 条数', n(acl(file)), '|', JSON.stringify(acl(file)))
    delete process.env.DESKPARTNER_CREDENTIALS_FILE
    fs.rmSync(dir, { recursive: true, force: true })
  }, 60000)
})
