import { clsx, type ClassValue } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'
import {
  FONT_FAMILY_TOKENS,
  FONT_SIZE_TOKENS,
  LETTER_SPACING_TOKENS,
  MAX_HEIGHT_TOKENS,
  MAX_WIDTH_TOKENS,
  RADIUS_TOKENS,
  WIDTH_TOKENS
} from './design-tokens'

/**
 * 合并 Tailwind CSS 类名（去重 + 条件拼接）
 *
 * ⚠️ **必须把语义令牌名登记进来**（1.0.114，卡 2f6f8082）：
 * tailwind-merge 靠"认识的名字"判断两个类是否同组。它不认识 `text-label`、
 * `text-caption` 这类自定义字号，会把它们当成**颜色** —— 于是
 * `cn('text-caption', 'text-text-secondary')` 里字号被静默丢掉，
 * 而且丢得毫不显眼：tsc 不管、测试不管、界面上只是字大了一点。
 *
 * 这个坑已经真的踩过：Button 的 `text-label` / `text-button` 一直排在色值类前面，
 * **从来没生效过**（本轮补渲染断言时才发现）。名字清单在 `lib/design-tokens.ts`。
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [{ text: [...FONT_SIZE_TOKENS] }],
      'font-family': [{ font: [...FONT_FAMILY_TOKENS] }],
      rounded: [{ rounded: [...RADIUS_TOKENS] }],
      w: [{ w: [...WIDTH_TOKENS] }],
      'max-w': [{ 'max-w': [...MAX_WIDTH_TOKENS] }],
      'max-h': [{ 'max-h': [...MAX_HEIGHT_TOKENS] }],
      tracking: [{ tracking: [...LETTER_SPACING_TOKENS] }]
    }
  }
})

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

/**
 * 事项编号的短号（uuid 前 8 位）
 *
 * **为什么界面要显示它**：CLI 全程用 id 指称（`dp todo update 9c4f2a81`），
 * 而界面此前一个字符都不显示 —— agent 说「改一下 9c4f2a81」，人得回终端里翻；
 * 人截图问「这条为什么卡住」，agent 只能拿标题去库里模糊搜。两边没有共同的名字。
 *
 * **为什么短号够用**：`todo.repository.ts` 的 resolveId() 支持前缀匹配
 * （`WHERE id LIKE '前缀%'`，匹配到多条会明确报歧义），
 * 所以 `dp todo update 9c4f2a81 --status done` 是合法命令 ——
 * 短号在界面与 CLI 之间可以直接互通，不需要"先复制完整 id 再粘贴"。
 *
 * 不足 8 位时按实际长度返回（旧数据 / 测试桩的 id 可能不是标准 uuid）。
 */
export function shortId(id: string): string {
  return id.slice(0, 8)
}

/**
 * 生成直接粘贴给 AI 助手的一句话事项指派/查看指令（卡 `58d024f6`）
 *
 * 采用主用户拍板的方案 2（带项目名 + 8 位短号 + 标题）：
 * `请看下「<项目名>」项目的卡片 #<8位ID>：「<卡片标题>」`
 * 避免项目名恰好叫 DeskPartner 时分不清是工具名还是项目名，同时在跨项目视图下也能一眼定位所属项目。
 */
export function formatTodoAgentPrompt(
  todo: { id: string; title: string },
  projectName?: string | null
): string {
  const code = shortId(todo.id)
  const proj = projectName?.trim()
  return proj
    ? `请看下「${proj}」项目的事项 #${code}：「${todo.title}」`
    : `请看下事项 #${code}：「${todo.title}」`
}
