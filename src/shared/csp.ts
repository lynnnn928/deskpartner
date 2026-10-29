/**
 * 内容安全策略（CSP）—— **单一真相**。
 *
 * 谁在用：`electron.vite.config.ts` 的 cspPlugin 在构建期把这里的结果
 * 写进渲染层 HTML 的 `<meta http-equiv="Content-Security-Policy">`。
 *
 * 为什么走 meta 而不是主进程的 `session.webRequest.onHeadersReceived`：
 * 打包后页面走 `file://`，而 Electron 的 webRequest **不拦截 file 协议** ——
 * 那个监听器对生产页面根本不会触发，装了等于没装，却会让人以为已经加固过。
 * "看起来做了"比明确不做更危险，所以换实现。
 *
 * 为什么开发/生产两套：渲染层是 React + 本地 SQLite，**没有远程内容**，
 * 生产用最严的就够。但开发时页面由 Vite dev server 提供，它要内联注入
 * HMR 客户端、要用 eval 做模块热替换、要连 ws 端口 —— 把生产那套套上去
 * 会白屏，然后就会有人"临时注释掉"，最后 CSP 变成摆设。
 * 所以开发那套只放宽到 Vite 必需的项，其余照旧收紧。
 *
 * 生产策略里 `style-src` 留了 `'unsafe-inline'`：Tailwind 与若干组件
 * （Radix）会写内联 style 属性，去掉它会大面积掉样式。
 * 这是**有意的取舍**，不是漏了 —— 在无远程内容的本地应用里，
 * 内联样式带来的风险远低于"样式全乱导致功能不可用"。
 *
 * `connect-src` 生产只允许 self：这个应用不发任何外部请求
 * （埋点是本地库、更新走 electron-updater 主进程侧），
 * 一旦渲染层被注入代码想外传数据，这一步会被拦下。
 */

/** 开发模式（Vite dev server 提供页面）用的策略 */
const DEV_CSP = [
  "default-src 'self'",
  // Vite HMR 需要 eval / inline，且 dev server 与 ws 端口同源
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' ws: http://localhost:* http://127.0.0.1:*"
].join('; ')

/**
 * 生产模式（file:// 加载静态产物）用的策略。
 *
 * ⚠️ 这里**故意没有 `frame-ancestors`**。
 *
 * CSP 规范规定 `frame-ancestors`（以及 `report-uri` / `sandbox`）
 * **只在 HTTP 响应头里生效**，写在 `<meta>` 里会被 Chromium 忽略，
 * 并在控制台报 error —— 实测确认过（CDP 抓到
 * "The Content Security Policy directive 'frame-ancestors' is ignored
 * when delivered via a <meta> element."）。
 *
 * 而本应用生产走 file://，**拿不到响应头**，所以写了等于没写，
 * 还平白多一条控制台噪音 —— 正是"看起来加固了、实际没有"的那种假象。
 * 防嵌套改由主进程的 `setWindowOpenHandler` + `will-navigate` 承担
 * （见 src/main/index.ts）。
 */
const PROD_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  // 生产不发外部请求；electron-updater 在主进程侧走，不受这里约束
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'"
].join('; ')

/** 按模式取策略。构建期由 cspPlugin 传入 mode 决定，不依赖运行时环境变量。 */
export function cspFor(mode: 'development' | 'production'): string {
  return mode === 'development' ? DEV_CSP : PROD_CSP
}
