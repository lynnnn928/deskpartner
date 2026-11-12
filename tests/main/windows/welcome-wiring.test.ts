import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 首次见面引导（1.0.64）结构性闸门
 *
 * 这一版真正的风险不在"字段能不能写"（那有 repository 测试），
 * 而在**接线漏了一处**：引导窗建好了、但启动时没人唤起它，
 * 或者两个引导窗同时弹出**叠在一起**。这类缺陷 tsc / lint / 单测全绿也查不出来。
 *
 * 所以这里读源码、断言关系 —— 闸门测试的价值就在它能抓"东西都在、就是没接上"。
 */
const ROOT = join(__dirname, '../../..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

describe('Welcome 引导接线（1.0.64）', () => {
  const windowsTs = read('src/main/windows.ts')
  const indexTs = read('src/main/index.ts')
  const appTs = read('src/renderer/App.tsx')

  it('windows.ts 真的把窗口加载到 /welcome 路由', () => {
    expect(windowsTs).toContain("loadRoute(this.welcomeWin, '/welcome')")
  })

  it('App.tsx 有 /welcome 路由，且指向 Welcome 组件', () => {
    expect(appTs).toContain("case 'welcome':")
    expect(appTs).toContain('<Welcome />')
    // 光有 case 不够 —— 组件要真的被 import
    expect(appTs).toContain("import Welcome from './windows/Welcome'")
  })

  it('index.ts 在没弹名字窗时会唤起引导', () => {
    // 锚点用完整表达式：裸 'showWelcome' 在 windows.ts 里到处都是
    expect(indexTs).toContain('windowManager.showWelcome()')
  })

  /**
   * 最容易被写错的一处：两个引导窗都是 alwaysOnTop 的居中弹窗，
   * 同时弹会叠在一起（用户只看得见上面那个，关掉又冒一个，像是弹了两遍）。
   * 所以 index.ts 里第二条分支必须是 else if，而名字窗的 closed 回调要接上引导。
   */
  it('两个引导窗串行：名字窗关闭后才接引导，不同时弹', () => {
    expect(indexTs).toContain('} else if (!settings.welcomeShown) {')

    // 名字窗 closed 回调里必须接引导（否则走"先弹名字"这条路的人永远看不到引导）
    const onboardingIdx = windowsTs.indexOf('this.onboardingWin.on(\'closed\'')
    expect(onboardingIdx).toBeGreaterThan(-1)
    const afterOnboardingClosed = windowsTs.slice(onboardingIdx, onboardingIdx + 900)
    expect(afterOnboardingClosed).toContain('welcomeShown')
    expect(afterOnboardingClosed).toContain('this.showWelcome()')
  })

  it('关窗即置 welcomeShown=true（否则每次启动都弹）', () => {
    const welcomeTs = read('src/renderer/windows/Welcome.tsx')
    expect(welcomeTs).toContain('welcomeShown: true')
    // 写失败不能静默关窗：标记没写成、窗口却不见了 = 下次还弹，而用户以为关过了
    expect(welcomeTs).toContain('catch')
  })

  /**
   * 1.0.146 评审后：Welcome 的复制按钮不再复制整本说明（那是用户页「AI 助手接入」的事），
   * 改为与快速上手**同源**的 buildMigratePrompt(useCliAccess()) —— 两个入口递出去的
   * 必须是同一份带本机地址的提示词，否则首启窗口又会退回"找不到命令"。
   */
  it('复制按钮与快速上手同源（不各写一份提示词）', () => {
    const welcomeTs = read('src/renderer/windows/Welcome.tsx')
    expect(welcomeTs).toContain('buildMigratePrompt(access)')
    expect(welcomeTs).toContain('useCliAccess()')
    expect(welcomeTs).not.toContain("invoke('cli:agentGuide')")
  })

  it('三步演示使用静态示例，不创建真实 agent、提议或审批记录', () => {
    const welcomeTs = read('src/renderer/windows/Welcome.tsx')
    expect(welcomeTs).toContain('const WELCOME_STEPS = [')
    expect(welcomeTs.match(/title: '[①②③]/g) ?? []).toHaveLength(3)
    expect(welcomeTs).toContain('重播')
    expect(welcomeTs).toContain('跳过')
    expect(welcomeTs).not.toContain("invoke('agent:register'")
    expect(welcomeTs).not.toContain("invoke('profile:propose'")
    expect(welcomeTs).not.toContain("invoke('protocol:propose'")
  })

  /**
   * 开场指令的顺序：注册 → 等批准 → 读档案/协议 → 提议 → 登记项目。
   *
   * 1.0.146 起这份正文不再硬编码在 Welcome 里（旧那份没有本机绝对路径，正是
   * `25caac02` 的病），改成模板 `buildMigratePrompt`；所以顺序去模板里核 ——
   * 模板才是唯一出处。
   */
  it('开场指令先教身份批准、用户档案与协作协议，再接手项目', () => {
    const welcomeTs = read('src/renderer/windows/Welcome.tsx')
    expect(welcomeTs).toContain('buildMigratePrompt(access)')
    expect(welcomeTs).not.toContain('const OPENING_INSTRUCTION')

    const prompts = read('src/renderer/lib/onboarding-prompts.ts')
    // 只在「整理迁入」这份模板里查顺序：HARD_RULES 是公共头，也提到过 profile get
    const migrate = prompts.slice(
      prompts.indexOf('export function buildMigratePrompt'),
      prompts.indexOf('export function buildFreshPrompt')
    )
    const order = [
      'agent register → agent credential',
      '等待主用户在「审批」页批准',
      'profile get',
      'profile propose',
      'protocol propose',
      '登记到 DeskPartner'
    ]
    let last = -1
    for (const step of order) {
      const at = migrate.indexOf(step)
      expect(at, `模板里找不到「${step}」`).toBeGreaterThan(-1)
      expect(at, `「${step}」出现在上一步之前`).toBeGreaterThan(last)
      last = at
    }
    // 1.0.132：模板不能再只教 `dp skill`（产品不写 PATH），并且要写明"注册 ≠ 获准写入"
    expect(prompts).toContain('注册成功不等于获准写入')
    // 注释里会解释当年的写法，剥掉注释再看正文
    const promptsBody = prompts.replace(/\/\*[\s\S]*?\*\//g, '')
    expect(promptsBody).not.toContain('dp skill')
  })

  it('用户页将 agent 修改提议的审批入口统一指向审批页', () => {
    const userTs = read('src/renderer/components/user/UserView.tsx')
    expect(userTs).toContain("setMainView('approval')")
    expect(userTs).not.toContain("invoke('profile:decide'")
    expect(userTs).not.toContain("invoke('protocol:decide'")
  })
})
