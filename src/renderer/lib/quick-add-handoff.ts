/**
 * 跨窗口交接一句话（卡 `4ad4f68d`）
 *
 * 悬浮球面板那一行只收一句话，多字段登记在速记那张**完整卡片**上（另一个 BrowserWindow）。
 * 用户已经敲进去的那一句必须跟着走 —— 不然"点了展开，字没了"。
 *
 * 为什么用 localStorage 而不是路由参数：两个窗口同源（`file://` 渲染产物），
 * localStorage 是共享的；而路由参数只能进 hash 的 query，把用户正文塞进 URL
 * 又丑又有长度上限。旁边 `deskpartner.quickAdd.lastProjectId` 早就是这么传的。
 *
 * **一次性**：读完就清。留着的下场是几天后打开速记卡片，标题框里躺着上次那句。
 */
const KEY = 'deskpartner.quickAdd.stagedTitle'

/** 把这一句交接给速记卡片（空字符串不留痕，免得白占一个键） */
export const stageQuickAddTitle = (title: string): void => {
  try {
    const trimmed = title.trim()
    if (trimmed) window.localStorage.setItem(KEY, trimmed)
  } catch {
    /* 隐私模式/配额：交接失败只是少带一句，不该拦下"打开卡片"这个动作 */
  }
}

/** 取走交接来的那一句（取过即清） */
export const takeStagedQuickAddTitle = (): string => {
  try {
    const staged = window.localStorage.getItem(KEY) ?? ''
    if (staged) window.localStorage.removeItem(KEY)
    return staged
  } catch {
    return ''
  }
}
