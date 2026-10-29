import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { findHandoffMatches, handoffMatchLine, revealHandoffMatch } from '../../../src/renderer/lib/handoff-locate'

/**
 * 搜索命中项目接手说明后要定位到那一段（卡 `c9dfbc87`）
 *
 * 卡上把这条拆成三件：①点结果只 onOpenProject、不定位；②打开后没有滚动 / 选中 /
 * 高亮；③关键词已不再匹配时没有反馈。另一件「入口可发现」卡上说已经解决 ——
 * **实测属实**：接手说明是概览页里那块常驻的「项目接手说明」（Kanban 的项目页签有
 * "概览"，ProjectOverviewView 里就是它，不是弹窗），所以这张卡只做落点。
 *
 * 按本仓既有做法分两半：
 * - 定位规则（找全部命中、算行号、把命中那段选中）**逐条真跑** —— 那是"点进去到底
 *   选中了哪几个字"的实际判据；
 * - 组件与落点的接线走**源码闸门**（与 `main-navigation.test.ts`、`6a595ad0` 同款）：
 *   "点一下有没有定位"这种事不报错、tsc 也绿，跑起来才看得见，靠人记得点一遍不可靠。
 *
 * ⚠️ 真机界面没跑（本批次驱动不了 Electron 真机）。**没验证过的**是"真窗口里点开、
 * 看起来对不对"：选区在真机上是否可见、长说明里那一段有没有真的滚进视野、原生选区
 * 点一下别处就消失这件事主用户能不能接受。需要手动过一遍的部分写在卡的评论里。
 */
const ROOT = path.resolve(__dirname, '../../..')
/**
 * 读源码时把行尾统一成 LF：工作树是 CRLF、仓库里是 LF（autocrlf=true），
 * 断言里写的是 `\n` —— 不归一化的话"改对了"会被行尾判成红（本项目踩过）。
 */
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\r\n').join('\n')
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

/** 一份"只在说明里出现"的说明：两处 README，第二处在第二行 */
const HANDOFF = '接手说明：先读 README，再跑测试。\nREADME 第二处。\n'

describe('接手说明搜索命中后定位（卡 c9dfbc87）', () => {
  /** 闸门自己先证明活着：路径写错时它会安静地"全绿"，那是最难查的失效形态 */
  it('基础数据解析成功（防止闸门因路径变化而假通过）', () => {
    const search = read('src/renderer/components/workbench/GlobalSearchView.tsx')
    const kanban = read('src/renderer/windows/Kanban.tsx')
    const overview = read('src/renderer/components/project/ProjectOverviewView.tsx')
    expect(search.length).toBeGreaterThan(4000)
    expect(kanban.length).toBeGreaterThan(10000)
    expect(overview.length).toBeGreaterThan(8000)
    expect(search).toContain("invoke('project:searchAll'")
    expect(kanban).toContain('openGlobalSearchProject')
    expect(overview).toContain('项目接手说明')
  })

  // ───────────── 判据①：命中位置算得对（真跑，不是读源码） ─────────────

  it('①一份说明里的全部命中都找得出来，口径与仓储层一致（大小写不敏感、按字面匹配）', () => {
    expect(findHandoffMatches(HANDOFF, 'README')).toEqual([8, 21])
    // 仓储层是 instr(lower(handoff_markdown), lower(?))：大小写不敏感
    expect(findHandoffMatches('Readme 和 readme', 'README')).toEqual([0, 9])
    // 字面匹配：关键词里有正则元字符也不能拿它当模式（'a+' 只匹配 'a+' 本身）
    expect(findHandoffMatches('正则 a+ 不是 aa', 'a+')).toEqual([3])
    // 不重叠：'aa' 在 'aaa' 里算一处（逐处前进，与 instr 同口径），也不会死循环
    expect(findHandoffMatches('aaa', 'aa')).toEqual([0])
    // 空关键词不算命中：空串在每一个位置都命中，放进去会当场返回一堆假位置
    expect(findHandoffMatches(HANDOFF, '')).toEqual([])
  })

  it('①报得出命中在第几行；CRLF / 单独 CR / LF 都只算一次换行', () => {
    expect(handoffMatchLine(HANDOFF, 8), '第一行的命中').toBe(1)
    expect(handoffMatchLine(HANDOFF, 21), '第二行的命中').toBe(2)
    expect(handoffMatchLine('a\r\nb\r\nREADME', 6), 'Windows 行尾的说明').toBe(3)
    expect(handoffMatchLine('a\rb\rREADME', 4), '只有 CR 也照样算一次换行').toBe(3)
    expect(handoffMatchLine(HANDOFF, 0), '行号 1 起算').toBe(1)
  })

  it('①打开后真的选中命中那一段并让它进视野（textarea 里没有别的"高亮"可用）', () => {
    const textarea = document.createElement('textarea')
    textarea.value = HANDOFF
    document.body.appendChild(textarea)
    const second = findHandoffMatches(HANDOFF, 'README')[1]
    revealHandoffMatch(textarea, second, second + 'README'.length)
    expect(textarea.selectionStart, '选中的起点就是命中的起点').toBe(21)
    expect(textarea.selectionEnd, '选中的长度就是关键词的长度').toBe(27)
    expect(textarea.value.slice(textarea.selectionStart, textarea.selectionEnd)).toBe('README')
    expect(document.activeElement, '不聚焦就没有可见的选区').toBe(textarea)
    textarea.remove()
  })

  // ───────────── 判据①：关键词要跟着结果一起走到概览页 ─────────────

  it('①点开接手说明的结果要带上关键词（不带就只剩"打开项目"，定位无从谈起）', () => {
    const search = stripComments(read('src/renderer/components/workbench/GlobalSearchView.tsx'))
    expect(search, '打开项目要多收一个关键词').toContain(
      'onOpenProject: (projectId: string, handoffQuery?: string) => void'
    )
    expect(search, '要记住这批结果是哪个词搜出来的').toContain("const [searchedTerm, setSearchedTerm] = useState('')")
    expect(search, '每次搜索都要更新它').toContain('setSearchedTerm(term)')
    expect(search, '接手说明的命中把关键词一起交给打开项目').toContain(
      "result.source === 'handoff_markdown' ? searchedTerm : undefined"
    )
    expect(search, '结果行要说清点下去会发生什么').toContain('并选中「{searchedTerm}」所在的那一段')
    // 反向验证：把第二参去掉（回到 `onOpenProject(result.projectId)`）→ 本条红。
  })

  it('①点开落到概览页，关键词交给概览组件；换项目后不再沿用旧落点', () => {
    const kanban = stripComments(read('src/renderer/windows/Kanban.tsx'))
    const start = kanban.indexOf('const openGlobalSearchProject')
    expect(start, '找不到打开项目那个函数').toBeGreaterThan(-1)
    const fn = kanban.slice(start, start + 800)
    expect(fn, '关键词要存成"哪个项目 + 哪个词"').toContain(
      'setHandoffFocus(handoffQuery ? { projectId, query: handoffQuery } : null)'
    )
    expect(
      fn,
      '这里不许直接写页签：换项目那个 effect 排在点击处理之后，会把这里的写法拨回事项页（最小复现实测）'
    ).not.toContain("setProjectTab('overview')")
    expect(kanban, '落页在那个 effect 里一次算清：带落点就落概览页').toContain(
      "setProjectTab(handoffFocus && handoffFocus.projectId === filterProject ? 'overview' : projectEntryTab)"
    )
    expect(kanban, '关键词要真的传到概览组件（且只对得上项目时）').toContain(
      "focusHandoffQuery={handoffFocus && handoffFocus.projectId === selectedProject.id ? handoffFocus.query : ''}"
    )
    expect(kanban, '换了项目就把落点丢掉').toContain(
      'setHandoffFocus((focus) => (focus && focus.projectId !== filterProject ? null : focus))'
    )
    expect(kanban, '落点要在 effect 依赖里，否则设置它的那一次不会重算落页').toMatch(
      /\}, \[filterProject, workspaceMode, projectEntryTab, setProjectEntryTab, handoffFocus\]\)/
    )
    // 反向验证：删掉 focusHandoffQuery 那一行 → 概览页收到空词，本卡等于没做；
    //           把落页那一句换回 setProjectTab(projectEntryTab) → 带落点进来落事项页；
    //           在 openGlobalSearchProject 里补一句 setProjectTab('overview') → 第二条断言红
    //           （那正是被驳回来的写法，实测最终仍是 items）。
  })

  // ───────────── 判据②③：概览页的落点与"已不再匹配" ─────────────

  it('②③概览页：只落一次、选中并滚进视野，词不在了就明说', () => {
    const overview = stripComments(read('src/renderer/components/project/ProjectOverviewView.tsx'))
    expect(overview, '命中位置按屏幕上这一版草稿实时算').toContain('findHandoffMatches(draft, focusTerm)')
    expect(overview, '选中 + 滚进视野').toContain('revealHandoffMatch(textarea, offset, offset + focusTerm.length)')
    expect(overview, '落点只做一次（跟着 draft 每次重设选区就没法编辑了）').toContain("const landedRef = useRef('')")
    expect(overview).toContain('if (landedRef.current === key) return')
    expect(
      overview,
      '装载中的空草稿不等于"说明里没这个词"，否则打开一瞬间会误报'
    ).toContain("if (draft === '' && (detail.project.handoffMarkdown ?? '') !== '') return")
    expect(overview, '②定位成功的提示条').toContain('已定位「{focusTerm}」')
    expect(overview, '③已不再匹配的提示条').toContain('未在接手说明中找到「{focusTerm}」')
    expect(overview, '多处命中要能往下走（一份说明在结果里只有一行）').toContain('下一处')
    expect(overview, '接手说明仍是那一个可编辑的 textarea，没有为高亮另造一套预览').toContain(
      'aria-label="项目接手说明 Markdown"'
    )
    // 反向验证：删掉提示条那两段 JSX → 本条红；把 ref 锁去掉（每次 draft 变化都重设选区）
    //            → 用户一编辑就被拽回选区。
  })
})
