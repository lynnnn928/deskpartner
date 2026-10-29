/**
 * 主题清单**只在这里定义一处**（卡 `d3cc69a6`，2026-10-22）。
 *
 * 原先加一个主题要改四处 —— `dp skill list`、切片表、入口页的「按需阅读」、
 * schema 里的主题枚举 —— 漏掉任何一处都是**静默漂移**：命令照常成功，
 * 而 agent 手上的清单与真出口对不上。现在四处全部从这张表派生。
 *
 * - `headings` 是切片依据：标题必须与 `buildAgentGuide` 里的**逐字一致**
 *   （允许只写标题前缀）。拼错一个字母会被 `if (start < 0) continue` 静默跳过：
 *   命令成功、内容少一节，没有任何迹象 —— 用例 `fix-card-test-naming-fd428d1e` 守这条；
 * - `summary` 由入口页的「按需阅读」渲染。
 *
 * ⚠️ 本文件是**零依赖的纯数据模块**（同 `gates.ts`）。表不能放回 `agent-guide.ts`：
 * `commands.ts` 在**模块加载时**就要读它（schema 的 `skill` 主题枚举写在命令表的字面量里），
 * 而 `agent-guide.ts` 反过来 import `commands.ts` 的工具表 —— 实测会踩循环初始化：
 * `Cannot access 'GUIDE_TOPICS' before initialization`（TDZ）。见那里的循环引用备注。
 */
export const GUIDE_TOPICS: Record<string, { summary: string; headings: string[] }> = {
  core: {
    summary: '事项、状态、验收与交付闭环；日常怎么敲命令。',
    /**
     * ⚠️ 别把「规格与往来分开」「验收三态」加回来：它们**不是真源里的一节**，
     * 而是「状态关口」正文里的两个列表项（`- ### 规格与往来分开：…`）。
     * 切片按 `indexOf` 匹配，会从列表中间开始、切到下一个真标题 ——
     * 实测这两条各带来 4441 / 3174 字节的**重复文本**（与「状态关口」的切片重叠，
     * 且顺序错乱），core 因此虚高 8 KB（卡 `d3cc69a6`：32485 → 24868）。
     * 它们的内容本来就在「状态关口」那一段里，删掉不丢任何东西。
     */
    headings: [
      '## 核心纪律',
      '### 状态关口',
      '### 验收与退回',
      '### 任务同步闭环',
      '### 修一张卡，配一条以卡 id 命名的回归用例',
      '## 常用操作'
    ]
  },
  writing: {
    summary: '怎么写一条事项：记什么不记什么、标题与描述、类型与执行者、批量登记。',
    headings: [
      '### 记什么',
      '### 不记什么',
      '### 标题与描述',
      '### 类型与执行者',
      '### 先归到 story 里',
      '### 一次记多条用 batch',
      '### 更要紧的：把已登记的同类事项勾掉'
    ]
  },
  project: {
    summary: '项目接手、历史搜索和版本边界。',
    headings: [
      '### 新 agent 接手项目的开场路径',
      '### 项目是必填项',
      '### 项目工作空间与版本边界',
      '### 版本归属'
    ]
  },
  access: {
    summary: '身份、MCP、授权，与产品边界。',
    headings: [
      '## 怎么调用',
      '### 如果你是通过 MCP 接入的',
      '### 四档权限',
      '### 产品边界',
      '## 什么时候不要用'
    ]
  },
  troubleshooting: {
    summary: '输出格式、版本管道和排障。',
    headings: ['## 输出格式', '## 注意', '### id 前缀与错误码']
  }
}

/** 主题名清单（顺序即交付顺序）—— `dp skill list` 与 schema 的主题枚举都取它 */
export function guideTopicNames(): string[] {
  return Object.keys(GUIDE_TOPICS)
}
