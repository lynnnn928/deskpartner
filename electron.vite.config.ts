import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { cspFor } from './src/shared/csp'

/**
 * 把 CSP 注入渲染层 HTML 的 `<meta http-equiv>`。
 *
 * 为什么要在构建期做、而不是运行时由主进程加响应头：
 * 打包后页面走 `file://`，Electron 的 webRequest 不拦截 file 协议，
 * `onHeadersReceived` 对生产页面不会触发 —— 那样 CSP 只是"看起来加了"。
 * meta 标签是 file:// 下唯一可靠的载体。
 *
 * 为什么在 `transformIndexHtml` 而不是直接写死在 index.html 里：
 * 开发和生产的策略必须不同（Vite HMR 需要 eval / ws，生产要最严），
 * 写死一份就得在两者间二选一，另一种模式必然白屏。
 * 这里按 Vite 的 mode 选策略，两种模式各得其所，且都经过同一处代码。
 */
function cspPlugin(): {
  name: string
  apply: (config: unknown, env: { command: string }) => boolean
  transformIndexHtml: (html: string) => string
} {
  // 由 Vite 在 resolveConfig 阶段填进来，比读 process.env.NODE_ENV 可靠 ——
  // NODE_ENV 在 `electron-vite build` 下不一定被设置成 'production'。
  let isDev = false
  return {
    name: 'deskpartner-csp',
    apply(_config, env) {
      isDev = env.command === 'serve'
      return true
    },
    transformIndexHtml(html: string): string {
      const policy = cspFor(isDev ? 'development' : 'production')
      const tag = `<meta http-equiv="Content-Security-Policy" content="${policy}" />`
      // 插在 charset 之后：charset 必须尽早声明，否则中文可能乱码
      return html.replace(/(<meta charset="UTF-8" \/>)/, `$1\n    ${tag}`)
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@main': resolve('src/main'),
        '@shared': resolve('src/renderer/types')
      }
    },
    build: {
      outDir: 'out/main',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/renderer/types')
      }
    },
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts')
        }
      }
    }
  },
  renderer: {
    plugins: [react(), cspPlugin()],
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer'),
        '@shared': resolve('src/renderer/types')
      }
    },
    root: resolve('src/renderer'),
    build: {
      outDir: resolve('out/renderer'),
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html')
        }
      }
    }
  }
})
