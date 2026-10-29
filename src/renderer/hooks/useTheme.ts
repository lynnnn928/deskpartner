import { useEffect } from 'react'
import { useSettingsStore } from '../stores/settings.store'
import { pruneThemeInline, applyBgOpacityOverride, applyCustomColors, CSS_OWNED_THEME_VARS } from '../lib/theme-inline'

/** 主题切换 Hook */
export function useTheme() {
  const { settings, updateSettings } = useSettingsStore()

  useEffect(() => {
    // 应用主题到 HTML 根元素
    document.documentElement.setAttribute('data-theme', settings.theme)
    document.documentElement.setAttribute('data-preset', settings.stylePreset)

    /**
     * 先抹掉"上一版由 JS 写下的、其实该由 CSS 主题文件负责"的行内变量
     * （1.0.55，修一致性 B3）。
     *
     * 行内样式优先级永远高于 `[data-preset]` 规则，所以这类变量一旦被
     * JS 写过一次，主题文件里的值就再也读不到。详见 lib/theme-inline.ts。
     */
    /**
     * 只保留 `--font-scale`：`--frosted-bg-opacity` 由**本次是否覆盖**决定
     * （见下面那段），因此这里一律先抹掉，避免上一次的覆盖残留压住新值。
     */
    pruneThemeInline(document.documentElement, ['--font-scale'], CSS_OWNED_THEME_VARS)

    // 应用字号缩放
    const scaleMap = { small: '0.875', normal: '1', large: '1.125' }
    document.documentElement.style.setProperty('--font-scale', scaleMap[settings.fontSizeScale])

    /**
     * 磨砂底色不透明度：只有用户**显式调过**才写行内（1.0.59）
     *
     * `bgOpacityOverride === null` → **什么都不写**，值由 `themes/*.css` 的
     * 风格预设决定。这是关键：不写行内，预设才是唯一来源，
     * 就不会出现 1.0.57 那种"预设里改了值、界面上却读不到"的静默失效。
     *
     * 非 null 时才写，此时行内优先级最高正是用户拖滑块想要的效果 ——
     * 覆盖是**显式的**，不是两条来源互相掩护。
     *
     * 界面上的「跟随预设」就是把值置回 null：覆盖消失，回到纯预设。
     */
    applyBgOpacityOverride(document.documentElement, settings.bgOpacityOverride)

    /**
     * 自定义颜色（1.0.114 改）：**只写通道变量** `--color-x-rgb`。
     *
     * 颜色层现在存 R G B 三段通道（卡 5fdf9b6d 第一步），工具类生成的是
     * `rgb(var(--color-x-rgb) / <alpha-value>)` —— 只写完整色值 `--color-x` 时，
     * `bg-accent`（主按钮底色）、`bg-accent/10` 全都读的是通道变量，
     * 于是"在设置里改了主题色、按钮却不变"。`applyCustomColors` 同时负责
     * 抹掉上一次的行内值（含已重置的项），避免又变成"两条来源"。
     */
    applyCustomColors(document.documentElement, settings.customColors)
  }, [
    settings.theme,
    settings.stylePreset,
    settings.fontSizeScale,
    settings.customColors,
    settings.bgOpacityOverride
  ])

  const setTheme = (theme: 'light' | 'dark') => updateSettings({ theme })

  /**
   * 说明（1.0.55，修一致性 B3）：
   *
   * 1.0.50 曾在这里放了一个 `setPreset`，把预设当成"一组设置值的快照"
   * （切预设时把三个圆角一并写进 settings）。**那个函数从未被调用** ——
   * 设置面板走的是 `updateSettings({ stylePreset })`，于是圆角依旧由
   * 独立的细项设置提供，预设里那三个参数还是没生效。函数死、修复也死。
   *
   * 现在把它删掉：同一个效果**不留两条来源**（这正是 B3 的根因）。
   * 圆角归细项设置（行内值），预设负责模糊/饱和/描边/底色/阴影 ——
   * 各自有明确的唯一来源，不再互相盖。
   *
   * 「预设要不要顺手改圆角」曾与「界面不透明度那个设置项要不要留」并列为
   * 同一条产品决策（273b451f）。两条都已在 1.0.56 收口：预设不管圆角；
   * 界面不透明度**设置项与滑块一并删除**，`--frosted-bg-opacity` 完全交给
   * 主题文件（frosted 0.88 / japanese 0.88）。
   *
   * ⚠️ 1.0.57 补记：这个设置项一删，行内值（用户当年拉满的 1）随之消失，
   * frosted.css 里 1.0.48 漏改的 0.72 立刻变成生效值 —— 界面当场变透明。
   * 已补齐为 0.88 并上闸门（theme-vars.test.ts 锁"默认预设 == :root"）。
   * 教训：删掉一条来源之前，先确认另一条来源的值是对的。
   *
   * ⚠️ 1.0.59 再改：主用户要这个能力回来（"我以为这一版至少解决了透明度可以
   * 在设置里调节"），但按她拍板的**「显式调过才覆盖预设」**语义实现 ——
   * 默认 `bgOpacityOverride = null`，行内不写、由预设单独负责；
   * 只有拖过滑块才写行内覆盖。与 1.0.56 之前"总有一个行内值"的写法不同：
   * 那时两条来源并存，预设的值永远读不到（也永远没人核对），
   * 1.0.57 的回归正是这个结构的代价。
   */
  const toggleTheme = () => setTheme(settings.theme === 'light' ? 'dark' : 'light')

  return { theme: settings.theme, preset: settings.stylePreset, setTheme, toggleTheme }
}
