/**
 * 悬浮面板静态预览（F2-P0-19）
 *
 * 沙箱里连不上 CDP（127.0.0.1 被阻断），真机界面验证跑不了，
 * 但面板的**视觉与信息层级**可以先在浏览器里看。
 *
 * 结构照 MoliTodo 的悬浮面板：一句话进度 / 输入框 / 可勾列表 / 底部完成数。
 */
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import dayjs from 'dayjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

const now = dayjs()
const iso = (d) => d.toISOString()

/** 样例：人与 AI 混排，走真实结构 */
const TODOS = [
  { id: '1', title: '把面板精简到只剩四块', status: 'todo', owner: 'human',
    projectId: 'p1', createdAt: iso(now.subtract(3, 'hour')) },
  { id: '2', title: '核对 M2 审核规则覆盖率', status: 'todo', owner: 'agent:alice',
    projectId: 'p1', createdAt: iso(now.subtract(2, 'hour')) },
  { id: '3', title: '回复启衡精密的验收反馈', status: 'todo', owner: 'human',
    projectId: null, createdAt: iso(now.subtract(90, 'minute')) },
  { id: '4', title: '整理《Agent Harness》解说分镜', status: 'todo', owner: 'agent:alice',
    projectId: 'p2', createdAt: iso(now.subtract(30, 'minute')) },
  { id: '5', title: '订明天去公司的打车', status: 'todo', owner: 'human',
    projectId: null, createdAt: iso(now.subtract(10, 'minute')) }
]

const PROJECTS = [
  { id: 'p1', name: '启衡精密 POC', color: '#5388F6' },
  { id: 'p2', name: '自媒体', color: '#F5A623' }
]

const OWNER_LABEL = (o) => (o === 'human' ? '我' : o.replace('agent:', ''))

function Item({ t }) {
  const isAgent = t.owner.startsWith('agent:')
  const project = PROJECTS.find((p) => p.id === t.projectId)
  return `
  <div class="item">
    ${project ? `<span class="band" style="background:${project.color}"></span>` : ''}
    <span class="tick"></span>
    <div class="body">
      <span class="title">${t.title}</span>
      ${isAgent ? `<span class="agent">🤖 ${OWNER_LABEL(t.owner)}</span>` : ''}
    </div>
  </div>`
}

// 与 src/renderer/lib/panel-sort.ts 一致：只按记录时间正序
const visible = [...TODOS].sort(
  (a, b) => dayjs(a.createdAt).valueOf() - dayjs(b.createdAt).valueOf()
)

const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>悬浮面板预览</title>
<style>
:root{
  --c-card:#FFFFFF; --c-text:#333; --c-sub:#868E96;
  --c-border:#E5E7EB;
}
body{margin:0;padding:36px;background:#E9EDF2;font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;display:flex;gap:30px;align-items:flex-start}
.panel{width:320px;height:420px;border-radius:18px;background:var(--c-card);border:1px solid var(--c-border);box-shadow:0 12px 40px rgba(0,0,0,.13);display:flex;flex-direction:column;overflow:hidden}
.prog{padding:13px 14px 7px;font-size:16px;font-weight:600;color:var(--c-text)}
.add{padding:6px 14px 10px;display:flex;align-items:center;gap:7px}
.add .plus{color:var(--c-sub);font-size:14px}
.add input{flex:1;border:0;outline:0;font-size:14px;color:var(--c-text);background:transparent;font-family:inherit}
.add input::placeholder{color:#B8BEC6}
.list{flex:1;overflow:auto;padding:2px 8px 6px}
.item{position:relative;display:flex;align-items:center;gap:8px;padding:6px 6px;border-radius:9px}
.item:hover{background:#F2F5F9}
.band{position:absolute;left:1px;top:8px;bottom:8px;width:2px;border-radius:2px}
.tick{flex:0 0 15px;height:15px;border-radius:50%;border:1.5px solid var(--c-border)}
.body{min-width:0;flex:1;display:flex;align-items:center;gap:6px}
.title{font-size:14px;line-height:1.4;color:var(--c-text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.agent{flex:0 0 auto;font-size:11px;color:#A855F7;display:inline-flex;align-items:center;gap:2px}
.ft{padding:9px 14px;border-top:1px solid var(--c-border);display:flex;align-items:center;font-size:12px;color:var(--c-sub)}
.ft button{margin-left:auto;border:0;background:transparent;font-size:12px;color:var(--c-sub);cursor:pointer;font-family:inherit;display:inline-flex;align-items:center;gap:4px}
.note{max-width:330px;font-size:13px;line-height:1.75;color:#4A5568}
.note h3{font-size:15px;margin:0 0 10px;color:var(--c-text)}
.note b{color:var(--c-text)}
.note ul{padding-left:18px;margin:6px 0}
.note li{margin:3px 0}
.note .cut{color:#B0B6BD;text-decoration:line-through}
</style></head><body>
  <div class="panel">
    <div class="prog">${visible.length} 项待办</div>
    <div class="add">
      <span class="plus">＋</span>
      <input placeholder="记一件事，回车保存" />
    </div>
    <div class="list">${visible.map((t) => Item({ t })).join('')}</div>
    <div class="ft"><span>今天完成 0 件</span><button>▦ 看板</button></div>
  </div>
  <div class="note">
    <h3>悬浮面板（F2-P0-19）</h3>
    <p>照 MoliTodo 的悬浮面板来，就四块：</p>
    <ul>
      <li>一句话进度</li>
      <li>一个输入框</li>
      <li>一张可勾的列表</li>
      <li>底部完成数</li>
    </ul>
    <p><b>砍掉的东西</b>：<span class="cut">归属筛选（全部/我的/AI）</span>、
    <span class="cut">逾期数</span>、<span class="cut">顶部今日完成</span>、
    <span class="cut">标签</span>、<span class="cut">截止时间</span>、
    <span class="cut">显示已完成开关</span>、
    <span class="cut">「详细新增」按钮</span>。</p>
    <p>面板宽 320，它是"扫一眼 + 勾一下"的地方，不是第二个看板。
    要筛选、要整理、要看细节，都去完整看板 —— 两个入口各管一件事。</p>
    <p><b>排序只剩一条规则</b>：按记录时间正序。面板上看不见优先级和截止时间，
    一个<b>看不见依据的排序</b>只会让人觉得"这列表怎么乱跳"。</p>
    <p><b>只留了 AI 角标</b>：人机共享里"这条不是我记的"必须一眼看出。
    项目色带缩成 2px 竖线——比色块省地方，仍能表达"这伙是一起的"。</p>
    <p style="color:#868E96;font-size:12px">注：静态还原，用于确认视觉与信息层级。</p>
  </div>
</body></html>`

const out = path.join(HERE, '../../desk-partner-悬浮面板预览.html')
writeFileSync(out, html, 'utf8')
console.log('已生成:', out)
