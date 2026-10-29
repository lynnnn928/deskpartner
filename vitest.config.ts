/**
 * 1.0.111 发版踩到的一类假红：
 * 全量跑（177 个文件并发）时，几条"逐条 spawn CLI / 逐个工具拼 argv"的集成型闸门
 * 被拖到 5s 默认超时之上 —— 发版那次 3 条同时超时（1998 passed / 3 failed，全是
 * "Test timed out in 5000ms"），单独复跑每个文件都 < 1s。防护 5s 的代价是
 * 让**负载冒充缺陷**：发版链上被迫重跑一次才知道没事。
 *
 * 抬到 20s：判据一条没变，只是别用 5s 去卡"要起子进程"的闸门。
 * 真卡死的用例仍然会失败，只是晚 15s 报出来。
 * 需要更细的预算时，仓库里既有的写法是给单条用例第三个参数（如 `}, 20000)`）。
 */
import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  /**
   * 渲染断言的地基（1.0.114，卡 935ea1e9）
   *
   * 此前 tests/renderer 37 个文件全是纯逻辑/字符串断言，改一个组件的 class 或
   * DOM 结构一条测试都不会红。补上增量门槛需要两样东西：
   * ① 用例能写 `.tsx`（下面 include 收 tsx；JSX 由 vitest 自带的转换处理，
   *    不需要再挂 @vitejs/plugin-react —— 实测直接写 JSX 即可跑）；
   * ② 环境用已在依赖里的 happy-dom（不另引 jsdom）。
   * @testing-library/react 见 devDependencies。
   */
  test: {
    environment: 'happy-dom',
    include: ['tests/**/*.test.{ts,tsx}'],
    globals: true,
    testTimeout: 20_000,
  },
  resolve: {
    alias: {
      '@renderer': path.resolve(__dirname, 'src/renderer'),
      '@main': path.resolve(__dirname, 'src/main'),
    }
  }
})
