import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { APPROVAL_ACTION, allowLabel, forceConfirmLabel, grantBadgeLabel } from '../../../src/renderer/lib/approval-copy'

/**
 * 卡 `66be78f4`：审批动作的命名规范（同一个动作三套叫法、两个入口用词不同）。
 *
 * ## 病
 *
 * 同一个"我同意让它跑"的动作，审批页叫「允许并执行」、横幅叫「允许一次」；
 * 二次确认那步叫「确认删除」，而 1.0.119 特意改成的「仍然执行」正是为了把
 * "我知道会解绑子任务、仍然要删"这层意思留在字面上。按钮改过三次名，三次各说一次话。
 *
 * ## 本文件钉三件事
 *
 * ① **词只有一个来源**：两个入口（横幅 / 审批页）+ 团队卡的授权状态都从
 *    `approval-copy.ts` 取字，代码里不许再出现那几个旧字面量（去注释后静态可判）；
 * ② **档位决定后缀**：一次性授权 = 「允许一次」、界面配置 = 「允许本次会话」、
 *    长期写入 = 「允许」；二次确认那步 = 「仍然 + 动词」，不是「确认删除」；
 * ③ **副作用不写进按钮名**：「允许并执行」这类把结果塞进动词的写法不许回潮。
 *
 * ⚠️ 三个组件的**渲染**另有覆盖：`approval-view-redesign.test.tsx` 断言待审批卡片
 * 出现「允许一次 / 仍然删除 / 放弃 / 需二次确认」，`reminder-banner-21f171f1` 断言横幅那条。
 */
const ROOT = path.resolve(__dirname, '../../..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n')
/** 注释里会引用旧词解释历史（那是该留的），闸门只扫代码 */
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/^\s*\{\/\*[\s\S]*?\*\/\}/gm, '')

const BANNED_LITERALS = ['允许并执行', '确认删除', '长期允许', '待二次确认']
const COMPONENTS = [
  'src/renderer/components/approval/ApprovalView.tsx',
  'src/renderer/windows/ReminderBanner.tsx',
  'src/renderer/components/user/AgentRosterSection.tsx'
]

describe('审批动作命名（卡 66be78f4）', () => {
  it('首次同意：档位决定后缀 —— 一次性 / 本次会话 / 长期', () => {
    expect(allowLabel('destructive')).toBe('允许一次')
    expect(allowLabel('config')).toBe('允许本次会话')
    expect(allowLabel('write')).toBe('允许')
    // 缺省按最保守的长期写入理解，而不是猜成一次性
    expect(allowLabel(undefined)).toBe('允许')
    expect(allowLabel(null)).toBe('允许')
  })

  it('覆盖警告那一步是「仍然 + 动词」—— 不是「确认删除」', () => {
    expect(forceConfirmLabel()).toBe('仍然删除')
    expect(forceConfirmLabel('执行')).toBe('仍然执行')
    expect(forceConfirmLabel()).not.toContain('确认')
  })

  it('待审批徽标：待补确认优先于档位 —— 它才是人判断"按下去是哪一步"的依据', () => {
    expect(grantBadgeLabel('destructive', true)).toBe(APPROVAL_ACTION.badgeForceConfirm)
    expect(grantBadgeLabel('config', true)).toBe(APPROVAL_ACTION.badgeForceConfirm)
    expect(grantBadgeLabel('config', false)).toBe(APPROVAL_ACTION.badgeConfig)
    expect(grantBadgeLabel('destructive', false)).toBe(APPROVAL_ACTION.badgeOperation)
    expect(grantBadgeLabel('write', false)).toBe(APPROVAL_ACTION.badgeOperation)
  })

  it('任何按钮文字都不许把副作用塞进动词（「并执行」已废弃）', () => {
    const words = [
      APPROVAL_ACTION.allow,
      APPROVAL_ACTION.allowOnce,
      APPROVAL_ACTION.allowSession,
      APPROVAL_ACTION.allowAlways,
      APPROVAL_ACTION.withdraw,
      APPROVAL_ACTION.reject,
      forceConfirmLabel(),
      forceConfirmLabel('执行'),
      allowLabel('write'),
      allowLabel('config'),
      allowLabel('destructive')
    ]
    for (const w of words) {
      expect(w, `${w} 把副作用写进了按钮名`).not.toContain('并执行')
      expect(w, `${w} 还在用「确认…」把警告读成第一步`).not.toContain('确认')
    }
  })

  it('两个入口与团队卡都从同一处取字 —— 代码里不再有那四个旧字面量', () => {
    for (const rel of COMPONENTS) {
      const src = stripComments(read(rel))
      expect(/from '(\.\.\/)+lib\/approval-copy'/.test(src), `${rel} 没引用 approval-copy`).toBe(true)
      for (const word of BANNED_LITERALS) {
        expect(src.includes(`'${word}'`), `${rel} 里还有字面量「${word}」`).toBe(false)
        expect(src.includes(`>${word}<`), `${rel} 里还有裸文本「${word}」`).toBe(false)
      }
    }
  })

  it('设计文档里有这条规范，且写明旧词不许回潮', () => {
    const doc = read('docs/DESIGN.md')
    expect(doc).toContain('审批动作命名契约')
    expect(doc).toContain('仍然 + 动词')
    expect(doc).toContain('approval-copy.ts')
  })
})
