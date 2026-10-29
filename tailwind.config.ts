import type { Config } from 'tailwindcss'

const config: Config = {
  content: ['./src/renderer/**/*.{ts,tsx,html}'],
  theme: {
    extend: {
      colors: {
        /*
         * 颜色一律写成 `rgb(var(--x-rgb) / <alpha-value>)`（1.0.114，卡 5fdf9b6d 第一步）
         *
         * ⚠️ 这个形态是**唯一**能让 `/10`、`/70` 这类透明度修饰符产出 CSS 的写法。
         * Tailwind 3 只认 `rgb(var(--x) / <alpha-value>)`；颜色变量若是完整色值时，
         * `bg-accent/10`、`text-text-secondary/70`、`border-success/30` 全部**静默丢弃** ——
         * 此前 154 处 / 45 文件都是这样空写的（徽章只剩文字有颜色，底色与描边是空的）。
         * 变量在 variables.css 里存 R G B 三段通道，完整色值由 :root 派生。
         *
         * 这里**不写十六进制兜底**：颜色值的唯一来源是 variables.css，
         * 在配置里再写一份等于给同一个效果留了第二条来源（1.0.48 就是这么丢的配色）。
         */
        accent: 'rgb(var(--color-accent-rgb) / <alpha-value>)',
        success: 'rgb(var(--color-success-rgb) / <alpha-value>)',
        danger: 'rgb(var(--color-danger-rgb) / <alpha-value>)',
        warning: 'rgb(var(--status-warning-rgb) / <alpha-value>)',
        'reminder-glow': 'rgb(var(--color-reminder-glow-rgb) / <alpha-value>)',
        'bg-primary': 'rgb(var(--color-bg-primary-rgb) / <alpha-value>)',
        'bg-secondary': 'rgb(var(--color-bg-secondary-rgb) / <alpha-value>)',
        'bg-card': 'rgb(var(--color-bg-card-rgb) / <alpha-value>)',
        'text-primary': 'rgb(var(--color-text-primary-rgb) / <alpha-value>)',
        'text-secondary': 'rgb(var(--color-text-secondary-rgb) / <alpha-value>)',
        'text-done': 'rgb(var(--color-text-done-rgb) / <alpha-value>)',
        border: 'rgb(var(--color-border-rgb) / <alpha-value>)',
        'column-surface': 'rgb(var(--color-column-surface-rgb) / <alpha-value>)',
        'status-proposed': 'rgb(var(--color-status-proposed-rgb) / <alpha-value>)',
        'status-todo': 'rgb(var(--color-status-todo-rgb) / <alpha-value>)',
        'status-in-progress': 'rgb(var(--color-status-in-progress-rgb) / <alpha-value>)',
        'status-suspended': 'rgb(var(--color-status-suspended-rgb) / <alpha-value>)',
        'status-awaiting-review': 'rgb(var(--color-status-awaiting-review-rgb) / <alpha-value>)',
        'status-done': 'rgb(var(--color-status-done-rgb) / <alpha-value>)',
        'status-unread': 'rgb(var(--status-unread-rgb) / <alpha-value>)',
      },
      /**
       * 派生面（令牌 1.0.114 就有，1.0.115 才接进工具类 —— 卡 5fdf9b6d 第二步）
       *
       * `--surface-subtle` / `--surface-muted` 是**由颜色通道 color-mix 出来的面**
       * （见 variables.css），不是通道三元组，所以不进上面的 colors ——
       * 进 colors 就得满足"每个键都是 `rgb(var(--x-rgb) / <alpha-value>)`"那条判据
       * （tests/renderer/styles/color-channel-tokens-5fdf9b6d.test.ts）。
       *
       * ⚠️ 代价说清楚：它们**没有透明度过体**。写 `bg-surface-muted/50` 与 1.0.113 之前
       * 的 `bg-accent/10` 是同一类静默失效（一条 CSS 都不产出）。要一层半透明的面，
       * 用通道色的 alpha（`bg-text-primary/5`），别给派生的面加 alpha ——
       * 这条由 tests/renderer/styles/token-utilities-5fdf9b6d.test.ts 盯着。
       */
      backgroundColor: {
        'surface-subtle': 'var(--surface-subtle)',
        'surface-muted': 'var(--surface-muted)'
      },
      borderRadius: {
        card: 'var(--radius-card, 14px)',
        button: 'var(--radius-button, 8px)',
        input: 'var(--radius-input, 8px)',
        // `kanban`（var(--radius-kanban)）于 1.0.55 删除：工具类 rounded-kanban
        // 全仓无人使用，变量声明的值从未到达界面。看板圆角由设置项
        // `kanbanBorderRadius` 以行内值提供（Kanban.tsx / KanbanBoard.tsx）。
        'quick-add': 'var(--radius-quick-add, 18px)',
        tag: 'var(--radius-tag, 11px)',
        // 1.0.114（卡 2f6f8082）：补两档，替掉散在组件里的 rounded-[4px] / rounded-[20px]
        xs: 'var(--radius-xs, 4px)',
        panel: 'var(--radius-panel, 20px)'
      },
      /* 2026-09-24 补（一致性 B4）：此前漏扩 boxShadow，
         `shadow-card / shadow-float / shadow-drag / shadow-card-hover`
         全是没有对应工具类的死类 —— 卡片、悬浮面板的阴影从未渲染过。
         变量在 variables.css 里一直有定义，只是没人接。 */
      boxShadow: {
        card: 'var(--shadow-card)',
        'card-hover': 'var(--shadow-card-hover)',
        drag: 'var(--shadow-drag)',
        float: 'var(--shadow-float)',
        // 1.0.114（卡 2f6f8082）：onboarding 里那三处把颜色写进任意值的阴影，收进令牌
        soft: 'var(--shadow-soft)',
        'soft-hover': 'var(--shadow-soft-hover)',
        hero: 'var(--shadow-hero)',
        // 1.0.116：悬浮球未读光晕。此前是组件里一行内联 `boxShadow: '0 0 12px 3px rgba(130,177,255,0.4)'`
        // —— 几何是 magic number、颜色是硬编码 rgba，绕开令牌体系（闸门只扫 class 串，扫不到内联样式）
        glow: 'var(--shadow-glow)'
      },
      fontSize: {
        title: 'var(--font-title, 22px)',
        body: 'var(--font-body, 16px)',
        'column-title': 'var(--font-column-title, 16px)',
        content: 'var(--font-content, 14px)',
        label: 'var(--font-label, 12px)',
        button: 'var(--font-button, 13px)',
        // 1.0.114（卡 2f6f8082）：补两档，替掉 15 处 text-[11px] / text-[10px] 与 1 处 text-[26px]
        caption: 'var(--font-caption, 11px)',
        display: 'var(--font-display, 26px)'
      },
      letterSpacing: {
        // 1.0.114：此前 11 处 tracking-[…] 任意值，归并成"全大写小标题 / 大标题"两档
        label: 'var(--tracking-label, 0.12em)',
        title: 'var(--tracking-title, -0.02em)'
      },
      fontFamily: {
        // 1.0.114：--font-mono 一直有定义，却没接进 tailwind —— 于是 14 处只能写
        // `[font-family:var(--font-mono)]` 这种任意值，另有 4 处 font-mono 走了 Tailwind 默认字体栈，
        // 同一件事两个来源。现在只有一个。
        mono: 'var(--font-mono, ui-monospace, Consolas, monospace)'
      },
      spacing: {
        card: 'var(--spacing-card, 12px)',
        'card-gap': 'var(--spacing-card-gap, 8px)',
        // 1.0.114：组件里真实在用、而默认刻度没有的半档（值一个没变）
        '0.75': '3px',
        '1.75': '7px',
        '3.75': '15px',
        '4.5': '18px',
        '5.5': '22px',
        // tailwind 默认刻度从 80 直接跳到 96，跳过了 88（=22rem=352px）——
        // 对话框基准宽 352px 正好落在这里，补一格而不是把对话框改宽 24px
        '88': '22rem'
      },
      borderWidth: {
        // 1.0.114：完成圆点那圈 1.5px 边框
        '1.5': '1.5px'
      },
      width: {
        'float-ball': 'var(--float-ball-size, 48px)',
        // 1.0.114：结构尺寸。min(…, 92vw) 写进变量值里 —— 窄窗口留 8vw 边只写一次
        sidebar: 'var(--size-sidebar, 248px)',
        drawer: 'var(--size-drawer, min(480px, 92vw))',
        'dialog-sm': 'var(--size-dialog-sm, min(420px, 92vw))',
        'dialog-md': 'var(--size-dialog-md, min(560px, 92vw))',
        'dialog-lg': 'var(--size-dialog-lg, min(720px, 92vw))'
      },
      maxWidth: {
        dialog: 'var(--size-dialog, 480px)',
        'dialog-sm': 'var(--size-dialog-sm, min(420px, 92vw))',
        'dialog-md': 'var(--size-dialog-md, min(560px, 92vw))',
        'dialog-lg': 'var(--size-dialog-lg, min(720px, 92vw))',
        page: 'var(--size-page, 1100px)',
        // 三条"别撑满"的上限：撤销条 70vw、看板提示条 80%、面板 toast 60%
        snackbar: 'var(--size-snackbar-max, 70vw)',
        notice: 'var(--size-notice-max, 80%)',
        toast: 'var(--size-toast-max, 60%)'
      },
      maxHeight: {
        dialog: 'var(--size-dialog-max-h, 90vh)',
        'scroll-md': 'var(--size-scroll-md, 70vh)',
        'scroll-sm': 'var(--size-scroll-sm, 60vh)'
      },
      height: {
        'float-ball': 'var(--float-ball-size, 48px)'
      },
      transitionDuration: {
        DEFAULT: 'var(--animation-duration, 200ms)'
      },
      transitionTimingFunction: {
        DEFAULT: 'var(--animation-easing, cubic-bezier(0.4, 0, 0.2, 1))'
      }
    }
  },
  plugins: []
}

export default config
