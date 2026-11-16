import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * `--created-by` 到底能不能挑到凭据（卡 `7c347b4b`，第 3 条）
 *
 * ── 缺陷本体 ──
 *
 * 启动器把 `--created-by agent:x` / `--owner agent:x` 当成"这次是谁在调用"的声明，
 * 再据此去凭据文件里挑那一份（1.0.37 给 bob 补的兼容）。但这段求值写在
 * **模块顶层**，而 `argv` 要到 `main()` 里才赋值 —— 求值时它还是空数组，
 * 于是声明恒为空：
 *
 * - 本机有多份凭据时，一条凭据也挑不到 → 门禁按 `ambiguous_identity` 拦下；
 * - 而 `command-core` 的报错文案还在教人「也可以在命令里带 --created-by
 *   （启动器会据此选凭据）」—— **报错教的那条路从来没生效过**。
 *
 * ── 判据 ──
 *
 * 给定"本机有多份凭据、没设 DESKPARTNER_AGENT、参数里带 `--created-by agent:x`"，
 * 解析结果必须是 x 自己的那份凭据。凭据文件走真实实现（只把路径指到临时目录），
 * 不 mock —— 这条 bug 就长在"读文件 + 读 argv"的接缝上。
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-cred-7c347b4b-'))
const credFile = path.join(dir, 'credentials.json')
const prevCredFile = process.env.DESKPARTNER_CREDENTIALS_FILE

/** 直接写凭据文件：版本 2 的形状（v1 的 default 字段已不再参与选身份） */
function writeProfiles(ids: string[]): void {
  const profiles: Record<string, { token: string; issuedAt: string }> = {}
  for (const id of ids) profiles[id] = { token: `tok-${id}`, issuedAt: '2026-11-16T00:00:00.000Z' }
  fs.writeFileSync(credFile, JSON.stringify({ version: 2, profiles }, null, 2))
}

const { resolveCallerIdentity } = await import('../../../src/cli/launcher')
const LAUNCHER_SRC = fs.readFileSync(path.resolve(__dirname, '../../../src/cli/launcher.ts'), 'utf8')

beforeAll(() => {
  process.env.DESKPARTNER_CREDENTIALS_FILE = credFile
})

afterAll(() => {
  if (prevCredFile === undefined) delete process.env.DESKPARTNER_CREDENTIALS_FILE
  else process.env.DESKPARTNER_CREDENTIALS_FILE = prevCredFile
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('--created-by 挑凭据（7c347b4b）', () => {
  it('多份凭据 + 没设环境变量 + --created-by agent:bob → 选中 bob 的凭据', () => {
    writeProfiles(['agent:alice', 'agent:bob'])
    const identity = resolveCallerIdentity(
      ['todo', 'add', '--title', 'x', '--created-by', 'agent:bob'],
      { tty: false }
    )
    expect(identity.declaredActor).toBe('agent:bob')
    expect(identity.callerActor).toBe('agent:bob')
    expect(identity.callerCredential).toBe('tok-agent:bob')
    // 声明生效了，就不该再报"你有两个身份我分不清"
    expect(identity.ambiguousIds).toBeUndefined()
  })

  it('内联写法 --created-by=agent:alice 同样生效', () => {
    writeProfiles(['agent:alice', 'agent:bob'])
    const identity = resolveCallerIdentity(['todo', 'list', '--created-by=agent:alice'], {
      tty: false
    })
    expect(identity.callerActor).toBe('agent:alice')
    expect(identity.callerCredential).toBe('tok-agent:alice')
  })

  it('旧形态：argv 还是空的时候求值，一条凭据都挑不到（这就是缺陷）', () => {
    writeProfiles(['agent:alice', 'agent:bob'])
    const identity = resolveCallerIdentity([], { tty: false })
    expect(identity.declaredActor).toBeUndefined()
    expect(identity.callerCredential).toBeUndefined()
    // 只剩"你有多份凭据、我分不清"这一条路 —— 而参数里其实已经声明过了
    expect(identity.ambiguousIds).toEqual(['agent:alice', 'agent:bob'])
  })

  it('声明了本机没有凭据的身份 → 留空，不借别人的', () => {
    writeProfiles(['agent:alice'])
    const identity = resolveCallerIdentity(['todo', 'add', '--created-by', 'agent:carol'], {
      tty: false
    })
    expect(identity.declaredActor).toBe('agent:carol')
    expect(identity.callerCredential).toBeUndefined()
    // 仍记成 carol 自己的身份：门禁会用 credential_missing 指路，而不是冒用 alice
    expect(identity.callerActor).toBe('agent:carol')
  })

  it('本机只有一份凭据 → 不声明也自动带上（1.0.35 的零摩擦路径不变）', () => {
    writeProfiles(['agent:alice'])
    const identity = resolveCallerIdentity(['todo', 'list'], { tty: false })
    expect(identity.declaredActor).toBeUndefined()
    expect(identity.callerActor).toBe('agent:alice')
    expect(identity.callerCredential).toBe('tok-agent:alice')
  })

  it('环境变量优先于参数里的声明（显式 export 是更强的那份声明）', () => {
    writeProfiles(['agent:alice', 'agent:bob'])
    const identity = resolveCallerIdentity(['todo', 'list', '--created-by', 'agent:bob'], {
      tty: false,
      envActor: 'agent:alice'
    })
    expect(identity.callerActor).toBe('agent:alice')
    expect(identity.callerCredential).toBe('tok-agent:alice')
  })

  /**
   * 结构闸门：纯函数对了还不够 —— 求值点必须真的在**参数就绪之后**。
   * 否则函数写得再对，模块顶层调用一次就还是拿空 argv（这正是原来的病）。
   */
  it('main() 里 argv 先赋值、再求身份（反着就还是那条老 bug）', () => {
    const assign = LAUNCHER_SRC.indexOf('argv = expandDescFile(process.argv.slice(2))')
    const resolve = LAUNCHER_SRC.indexOf('resolveCallerIdentity(argv')
    expect(assign, '找不到 argv 赋值').toBeGreaterThan(-1)
    expect(resolve, '找不到身份求值点').toBeGreaterThan(-1)
    expect(resolve).toBeGreaterThan(assign)
  })
})
