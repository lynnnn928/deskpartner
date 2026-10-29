import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 「本次变更」的接线闸门（1.0.73，主用户提单 `482e4b03`）
 *
 * ── 为什么需要一条扫描型闸门，而不是只测纯函数 ──
 *
 * 纯函数测试答的是"算得对不对"，答不了"**有没有人调它**"。
 * 本项目在这上面栽过三次，症状完全一致：
 *
 * - `comment_deleted` / `todo_deleted`：从 1.0.52 / 1.0.55 起一直在**如实写入**，
 *   payload 里带着完整内容，但**没有任何读入口** → 效果等同于没留痕
 *   （主用户驳回 68c7ccc1 原话：「写进去了，但没有任何地方读得出」）；
 * - `--desc-file` / `--body-file` / `--comment-file`：在同一版里声明进 args 表、
 *   却没有对应的展开或拦截实现 → 正文被**静默丢弃**还回 `ok:true`；
 * - `is_rejection`：列建好了、取值逻辑写好了，中间**漏了一个手工挑字段的映射点**
 *   → 翻译层收不到值，同一件事两个页面两种说法。
 *
 * 三次的共同点：**tsc 全绿、单测全绿、跑起来安静地说错话。**
 * 所以这里扫的是"接口两端有没有接上"，不是数值。
 *
 * ── 反向验证（已实测，不是声明）──
 *
 * 1. 删掉 `todo.repository.ts` 里 `diffFields(existing, updated)` 那一段 →
 *    "写入侧真的在记字段变更"变红；
 * 2. 把 `review-diff.ts` 里 `kind: 'field'` 那一支删掉 →
 *    "聚合层读得出字段变更"变红；
 * 3. 把 `audit-text.ts` 里 `fields_changed` 那一支删掉 →
 *    "变更记录里读得出字段变更"变红；
 * 4. 删掉 `ipc.ts` 里的 `todo:reviewDiff` handler →
 *    "IPC 通道已注册"变红。
 *
 * 这四条覆盖的是**链路四段**：写入 → 存储 → 聚合读取 → 展示入口。
 * 四段缺一段，功能都等于没做，而任何一段缺失都不会让别的测试变红。
 */
const ROOT = path.resolve(__dirname, '../../..')

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8')
}

/**
 * 剥掉注释再断言
 *
 * 本项目的代码注释里**大量引用**被讨论的标识符（这本身是好事 ——
 * 判据留在代码旁边）。直接 grep 会把"注释里提到"判成"代码里有"，
 * 于是闸门永远绿。写这类扫描闸门的通用要求，见 spawn-stdio-guard 的同类处理。
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

describe('本次变更：链路四段必须都接上（482e4b03）', () => {
  it('① 写入侧：repo 里真的在算并记字段变更', () => {
    const src = stripComments(read('src/main/database/todo.repository.ts'))
    expect(src, '没 import diffFields').toMatch(/diffFields/)
    expect(src, '没调用 diffFields（算了才算记了）').toMatch(/diffFields\s*\(\s*existing\s*,\s*updated\s*\)/)
    expect(src, "没写 fields_changed 事件").toMatch(/fields_changed/)
  })

  it('② 存储侧：字段变更走的是 events（与描述变更同一路，不被 prune 漏掉语义）', () => {
    const src = stripComments(read('src/main/database/todo.repository.ts'))
    // 用 append('todo', ...) 而不是另建一张表：字段变更是审计（会丢东西、需要对证），
    // 与描述变更同一路；而 events 的保留策略与读法都已经有现成的
    // （listForTodo 按 payload.todoId / payload.id 匹配）。
    expect(src).toMatch(/EventsRepository\(\)\.append\(\s*'todo'/)
    // 必须带 id 字段，否则 listForTodo 的 `$.id` 那条路径命不中（老坑：
    // description_changed 当初用 id 而不是 todoId，导致它从没被命中过）
    expect(src, '事件没带 id，listForTodo 会查不出来').toMatch(/action:\s*'fields_changed'[\s\S]{0,200}?id:\s*updated\.id|id:\s*updated\.id[\s\S]{0,200}?action:\s*'fields_changed'/)
  })

  it('③ 聚合读取侧：buildReviewDiff 认得三类（描述/状态/字段）', () => {
    const src = stripComments(read('src/main/lib/review-diff.ts'))
    expect(src).toMatch(/description_changed/)
    expect(src).toMatch(/fields_changed/)
    expect(src).toMatch(/awaiting_review/)
    for (const k of ["'desc'", "'status'", "'field'"]) {
      expect(src, `聚合层缺了 ${k} 这一类`).toContain(k)
    }
  })

  it('④ 变更记录侧：字段变更也要读得出（否则重犯"写了却读不出"）', () => {
    const src = stripComments(read('src/main/lib/audit-text.ts'))
    expect(src, 'audit-text 没认 fields_changed —— 它会掉进 default，只剩"某人 · todo"').toMatch(
      /fields_changed/
    )
  })

  it('⑤ 展示入口：IPC 通道已注册，且渲染层挂了「本次变更」', () => {
    const ipc = stripComments(read('src/main/ipc.ts'))
    expect(ipc, 'IPC 通道没注册').toContain("'todo:reviewDiff'")
    expect(ipc, 'IPC 里没调 buildReviewDiff').toMatch(/buildReviewDiff\s*\(/)

    // 渲染层：组件存在，且真的被挂进详情抽屉
    const comp = read('src/renderer/components/quick-add/ReviewDiff.tsx')
    expect(comp, '组件没调 todo:reviewDiff').toContain('todo:reviewDiff')
    expect(comp, '组件里没有「本次变更」这个标题').toContain('本次变更')
    const form = read('src/renderer/components/quick-add/QuickAddForm.tsx')
    expect(form, '详情抽屉没挂 ReviewDiff').toMatch(/<ReviewDiff[\s>]/)
  })

  it('⑥ 批注复用评论通道（不新造一套往来存储）', () => {
    const comp = stripComments(read('src/renderer/components/quick-add/ReviewDiff.tsx'))
    // 提单要求"人可逐条批注后通过/驳回"。批注走 todo:addComment 是关键决策：
    // 落进评论后，驳回/返工的既有通知链、todo get 的读入口、线程 UI 全部自动生效。
    expect(comp, '批注没走评论通道').toContain("invoke('todo:addComment'")
    // 且**不能**用 kind:'reject' —— 那会连带触发"驳回退回进行中"这个裁决动作，是越权
    expect(comp, "批注不该用 kind:'reject'（那是裁决，会连带退回状态）").not.toMatch(
      /kind:\s*'reject'/
    )
  })

  it('⑥ 契约两侧都有声明（IPC 传 JSON，各声明各的，缺一边 tsc 就断）', () => {
    const mainSrc = read('src/main/lib/review-diff.ts')
    const rendererTypes = read('src/renderer/types/todo.ts')
    const ipcTypes = read('src/renderer/types/ipc.ts')
    expect(mainSrc).toMatch(/export interface ReviewDiffItem/)
    expect(rendererTypes, '渲染层没声明 ReviewDiffItem').toMatch(/export interface ReviewDiffItem/)
    expect(ipcTypes, 'IPC 契约里没有这条通道').toContain("'todo:reviewDiff'")
    // 三类的取值两侧必须一致 —— 少一个 kind，渲染层会静默不渲染那类
    for (const k of ['desc', 'status', 'field']) {
      expect(mainSrc).toContain(`'${k}'`)
      expect(rendererTypes).toContain(`'${k}'`)
    }
  })

  it('⑦ 描述追加必须带 appendedFrom（否则读侧算不出"新增了哪几行"）', () => {
    const src = stripComments(read('src/main/lib/desc-audit.ts'))
    expect(src).toMatch(/appendedFrom/)
    // 且只在追加时写（替换场景不写，多一个字段就是多一处要对齐的东西）
    expect(src).toMatch(/appended\s*\?\s*\{\s*appendedFrom/)
  })

  it('⑧ 字段追踪清单不含 status / description（它们各有专门记录路径）', () => {
    const src = read('src/main/lib/field-changes.ts')
    const listMatch = src.match(/const TRACKED_FIELDS[^=]*=\s*\[([\s\S]*?)\]/)
    expect(listMatch, '没找到 TRACKED_FIELDS 清单').not.toBeNull()
    const body = stripComments(listMatch![1])
    // 判据：记两遍 = 两份真相，而且是残缺的那份
    // （events 里这份没有 actor 的流转语义、没有 append/replace 的语义）
    expect(body, 'status 不该进清单（todo_transitions 才是它的家）').not.toMatch(/'status'/)
    expect(body, 'description 不该进清单（description_changed 才是它的家）').not.toMatch(
      /'description'/
    )
    expect(body, 'updatedAt 不该进清单（每次写入都变的副产物）').not.toMatch(/'updatedAt'/)
  })
})
