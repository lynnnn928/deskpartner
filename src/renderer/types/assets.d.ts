/**
 * 静态资源模块声明
 *
 * 该文件不含顶层 import / export，因此是「全局脚本」，
 * declare module 会作用于全局（放在 global.d.ts 里会因该文件是模块而失效）。
 */

declare module '*.svg' {
  const src: string
  export default src
}

declare module '*.png' {
  const src: string
  export default src
}

declare module '*.css' {
  const content: Record<string, string>
  export default content
}
