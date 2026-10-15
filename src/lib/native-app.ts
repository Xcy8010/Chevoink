// APP 壳（Capacitor）环境识别与原生系统栏配色同步。
//
// 站点以「远程模式」被装进原生 WebView：APP 通过 capacitor.config 的
// appendUserAgent: 'ChevoinkApp' 在 UA 里打上标识，前端据此判断自己运行在 APP 壳内，
// 从而隐藏与原生冲突的网页交互（如全屏弹窗/设置）、并接管系统状态栏与导航栏配色。
//
// 普通浏览器下 isNativeApp() 恒为 false，本文件所有函数均为无副作用的空操作，
// 网页版行为零变化。

/** 当前是否运行在启创墨域 APP 壳内（Capacitor WebView）。 */
export function isNativeApp(): boolean {
  if (typeof navigator === 'undefined') return false
  return /\bChevoinkApp\b/.test(navigator.userAgent)
}

/**
 * 从 UA 解析当前 APP 壳版本号（形如 `ChevoinkApp/1.0.0`）。
 * 用于 APP 内更新提示与线上 version.json 比对；非 APP 或旧版无版本号时返回 null。
 */
export function getNativeAppVersion(): string | null {
  if (typeof navigator === 'undefined') return null
  const match = navigator.userAgent.match(/\bChevoinkApp\/(\d+(?:\.\d+)*)/)
  return match ? match[1] : null
}

/**
 * 在系统浏览器中打开链接（用于 APK 下载等必须离开壳内 WebView 的场景）。
 *
 * Capacitor 壳只会把「非同源」导航交给系统浏览器（比对 host + scheme），
 * 与站点同域的下载链接会被 WebView 当作站内导航吞掉；这里把 https 换成 http
 * 制造 scheme 差异强制外跳系统浏览器，再由 nginx 80 端口 301 回 https 完成下载。
 * 壳内外跳后当前页面不会导航，APP 停留在原处；普通浏览器下直接新开标签页。
 */
export function openExternalUrl(url: string): void {
  if (isNativeApp()) {
    window.location.href = url.replace(/^https:\/\//, 'http://')
    return
  }
  window.open(url, '_blank', 'noopener')
}

type StatusBarPlugin = {
  setBackgroundColor?: (options: { color: string }) => Promise<void>
  setStyle?: (options: { style: 'DARK' | 'LIGHT' | 'DEFAULT' }) => Promise<void>
  hide?: () => Promise<void>
  show?: () => Promise<void>
}
type NavigationBarPlugin = {
  setNavigationBarColor?: (options: { color: string; darkButtons?: boolean }) => Promise<void>
}
/**
 * 自定义原生插件（chevoink-android 的 ImmersiveModePlugin.java）：
 * 官方 @capacitor/status-bar 的 setOverlaysWebView 用的是 SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
 * 这套 legacy flag，Android 15（targetSdk 35）已忽略——真机实测 overlay 静默失败、
 * 只有 hide 生效，露出窗口黑底。自定义插件改用现代 API setDecorFitsSystemWindows，
 * enter 返回沉浸态下页面需要避让的安全区（CSS px，含挖孔）。
 */
type ImmersiveModePlugin = {
  setSystemBarAppearance?: (options: { color: string; dark: boolean }) => Promise<void>
  enter?: () => Promise<ImmersiveInsets>
  exit?: () => Promise<ImmersiveInsets | void>
  getInsets?: () => Promise<ImmersiveInsets>
  addListener?: (event: 'insetsChanged', listener: (insets: ImmersiveInsets) => void) => { remove: () => Promise<void> } | Promise<{ remove: () => Promise<void> }>
}

/** 沉浸态下页面需避让的安全区（CSS px） */
export type ImmersiveInsets = {
  top: number
  bottom: number
  left?: number
  right?: number
  immersive?: boolean
  measurement?: 'stable' | 'remaining'
}

const insetListeners = new Set<(insets: ImmersiveInsets) => void>()

function validInsets(value: unknown): value is ImmersiveInsets {
  if (!value || typeof value !== 'object') return false
  const insets = value as ImmersiveInsets
  return [insets.top, insets.bottom].every(number => typeof number === 'number' && Number.isFinite(number) && number >= 0)
    && [insets.left, insets.right].every(number => number === undefined || Number.isFinite(number) && number >= 0)
}

function publishInsets(value: unknown) {
  if (validInsets(value)) for (const listener of insetListeners) listener(value)
}

/** New shells report WebView-relative geometry; older APKs omit this capability. */
export async function refreshNativeInsets(): Promise<void> {
  if (!isNativeApp()) return
  try { publishInsets(await nativePlugins()?.ImmersiveMode?.getInsets?.()) } catch { /* Activity transition or old bridge. */ }
}

export function observeNativeInsets(listener: (insets: ImmersiveInsets) => void): () => void {
  if (!isNativeApp()) return () => {}
  let disposed = false
  let handle: { remove: () => Promise<void> } | undefined
  insetListeners.add(listener)
  const plugin = nativePlugins()?.ImmersiveMode
  if (plugin?.getInsets && plugin.addListener) {
    const addListener = plugin.addListener.bind(plugin)
    // Capacitor's injected bridge returns a synchronous handle; JS proxies may
    // return a Promise. Neither shape nor a synchronous throw may stop startup.
    void Promise.resolve().then(() => addListener('insetsChanged', publishInsets)).then(async subscription => {
      if (disposed) await subscription.remove()
      else { handle = subscription; await refreshNativeInsets() }
    }).catch(() => { if (!disposed) void refreshNativeInsets() })
  } else {
    void refreshNativeInsets()
  }
  return () => {
    disposed = true
    insetListeners.delete(listener)
    void handle?.remove().catch(() => {})
  }
}

/** 取原生桥注入的插件集合；浏览器或桥未就绪时返回 undefined。 */
function nativePlugins():
  | { StatusBar?: StatusBarPlugin; NavigationBar?: NavigationBarPlugin; ImmersiveMode?: ImmersiveModePlugin }
  | undefined {
  if (typeof window === 'undefined') return undefined
  return (window as unknown as { Capacitor?: { Plugins?: Record<string, unknown> } }).Capacitor?.Plugins as
    | { StatusBar?: StatusBarPlugin; NavigationBar?: NavigationBarPlugin; ImmersiveMode?: ImmersiveModePlugin }
    | undefined
}

/**
 * 将原生状态栏（顶部）与导航栏（底部）染成与网页当前背景一致的颜色，使安全区跟随主题。
 * 仅在 APP 壳内生效；浏览器为空操作。
 *
 * 注：安卓 15+ 默认强制 edge-to-edge 并禁用状态栏染色，本壳在主题里声明了
 * windowOptOutEdgeToEdgeEnforcement。1.0.9 外观桥按 OS、target 与 opt-out 染色；
 * 旧壳继续走 StatusBar fallback，其依赖在 Android 16+ 会跳过背景染色。
 *
 * @param backgroundColor 背景色（#RRGGBB，通常取自 CSS 变量 --app-bg）
 * @param dark 是否深色背景：深色→浅色图标；浅色→深色图标
 */
export function syncNativeSystemBars(backgroundColor: string, dark: boolean): void {
  if (!isNativeApp() || !backgroundColor) return
  queueNativeSystemSurface(() => ({ backgroundColor, dark }))
}

function queueNativeSystemSurface(resolve: () => NativeSystemSurfaceAppearance | null, force = false) {
  if (!isNativeApp()) return
  const revision = ++appearanceRevision
  void enqueueImmersive(async () => {
    if (revision !== appearanceRevision) return
    const surface = resolve()
    if (surface) {
      syncBrowserThemeColor(surface)
      await applyNativeSystemBars(surface, force)
    }
  })
}

export type NativeSystemSurfaceAppearance = { backgroundColor: string; dark: boolean }
const systemSurfaces = new Map<symbol, () => NativeSystemSurfaceAppearance | null>()
let appearanceRevision = 0
let appliedAppearance = ''
let appliedBridge: ReturnType<typeof nativePlugins>

/** Register a mounted surface; a hidden surface returns null and yields to the next owner. */
export function registerNativeSystemSurface(resolve: () => NativeSystemSurfaceAppearance | null): () => void {
  const owner = Symbol('system-surface')
  systemSurfaces.set(owner, resolve)
  restoreNativeSystemBarsToTheme()
  return () => {
    systemSurfaces.delete(owner)
    restoreNativeSystemBarsToTheme()
    // Reader canvas cleanup can restore an old meta color later in the same commit.
    // Re-read current owners after all cleanups; never replay the released owner's color.
    queueMicrotask(restoreNativeSystemBarsToTheme)
  }
}

/** CSS computed colors are RGB; native StatusBar accepts hex. Ignore translucent backgrounds. */
export function normalizeSystemSurfaceColor(value: string): string | null {
  const color = value.trim().toLowerCase()
  if (/^#[\da-f]{6}$/.test(color)) return color
  if (/^#[\da-f]{3}$/.test(color)) return `#${color.slice(1).split('').map(character => character + character).join('')}`
  const rgb = color.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/)
  if (!rgb || (rgb[4] !== undefined && Number(rgb[4]) !== 1)) return null
  const channels = rgb.slice(1, 4).map(Number)
  if (channels.some(channel => !Number.isFinite(channel) || channel < 0 || channel > 255)) return null
  return `#${channels.map(channel => Math.round(channel).toString(16).padStart(2, '0')).join('')}`
}

export function readNativeSystemSurface(element: HTMLElement): NativeSystemSurfaceAppearance | null {
  const style = getComputedStyle(element)
  const backgroundColor = normalizeSystemSurfaceColor(style.backgroundColor)
    ?? normalizeSystemSurfaceColor(style.getPropertyValue('--app-bg'))
  return backgroundColor ? { backgroundColor, dark: isDarkColor(backgroundColor) } : null
}

function currentSystemSurface(): NativeSystemSurfaceAppearance | null {
  for (const resolve of Array.from(systemSurfaces.values()).reverse()) {
    const surface = resolve()
    if (surface) return surface
  }
  return typeof document === 'undefined' ? null : readNativeSystemSurface(document.documentElement)
}

function syncBrowserThemeColor(surface: NativeSystemSurfaceAppearance) {
  if (typeof document !== 'undefined') {
    const meta = document.head.querySelector('meta[name="theme-color"]')
    if (meta?.getAttribute('content') !== surface.backgroundColor) meta?.setAttribute('content', surface.backgroundColor)
  }
}

async function applyNativeSystemBars(surface: NativeSystemSurfaceAppearance, force = false) {
  if (!isNativeApp()) return
  const plugins = nativePlugins()
  if (!plugins) return
  const capabilities = [plugins.ImmersiveMode?.setSystemBarAppearance, plugins.StatusBar?.setBackgroundColor, plugins.StatusBar?.setStyle, plugins.NavigationBar?.setNavigationBarColor]
  if (!capabilities.some(method => typeof method === 'function')) return
  const key = `${surface.backgroundColor}:${surface.dark}:${capabilities.map(method => typeof method === 'function').join(':')}`
  if (!force && appliedBridge === plugins && appliedAppearance === key) return
  if (plugins.ImmersiveMode?.setSystemBarAppearance) {
    try {
      await plugins.ImmersiveMode.setSystemBarAppearance({ color: surface.backgroundColor, dark: surface.dark })
      appliedBridge = plugins
      appliedAppearance = key
      return
    } catch { /* Old proxy shells or unsupported window policies retain the legacy path. */ }
  }
  const writes = [
    () => plugins.StatusBar?.setBackgroundColor?.({ color: surface.backgroundColor }),
    () => plugins.StatusBar?.setStyle?.({ style: surface.dark ? 'DARK' : 'LIGHT' }),
    () => plugins.NavigationBar?.setNavigationBarColor?.({ color: surface.backgroundColor, darkButtons: !surface.dark }),
  ]
  const success = await Promise.all(writes.map(async write => {
    try { await write(); return true } catch { return false }
  }))
  if (success.every(Boolean)) {
    appliedBridge = plugins
    appliedAppearance = key
  }
}

// 进入/退出沉浸走同一条串行队列：评论面板临时退出、路由卸载还原等场景可能交错触发，
// 串行化后原生侧按调用顺序生效，最后一次调用胜出，不会出现 hide/show 乱序。
let immersiveChain: Promise<unknown> = Promise.resolve()

function enqueueImmersive<T>(step: () => Promise<T>): Promise<T | null> {
  const next = immersiveChain.then(step, step).catch((): null => null)
  immersiveChain = next
  return next
}

/** 当前壳是否具备真全屏沉浸能力（自定义 ImmersiveMode 插件，旧 APK 没有）。 */
export function supportsNativeImmersive(): boolean {
  return isNativeApp() && typeof nativePlugins()?.ImmersiveMode?.enter === 'function'
}

/**
 * 进入全屏沉浸（方案 20）：原生侧 setDecorFitsSystemWindows(false) 让 WebView 铺满
 * 整屏，再隐藏系统栏。成功返回页面需避让的安全区（CSS px）；能力缺失（旧 APK）或
 * 失败返回 null，调用方保持既有「状态栏染色」形态，不做任何布局改动。
 */
export function enterNativeImmersive(): Promise<ImmersiveInsets | null> {
  if (!supportsNativeImmersive()) return Promise.resolve(null)
  return enqueueImmersive(async () => {
    const immersive = nativePlugins()?.ImmersiveMode
    if (!immersive?.enter) return null
    const insets = await immersive.enter()
    await refreshNativeInsets()
    return validInsets(insets) ? insets : null
  })
}

/** 退出全屏沉浸并把系统栏配色交回当前主题。旧 APK 下为空操作。 */
export function exitNativeImmersive(): Promise<void> {
  if (!supportsNativeImmersive()) return Promise.resolve()
  return enqueueImmersive(async () => {
    publishInsets(await nativePlugins()?.ImmersiveMode?.exit?.())
    await refreshNativeInsets()
    // Native exit restores a saved window color. Resolve the CURRENT owner after
    // that restoration, including a newer reader/studio/theme mounted while exit waited.
    const surface = currentSystemSurface()
    if (surface) {
      syncBrowserThemeColor(surface)
      await applyNativeSystemBars(surface, true)
    }
  }).then(() => {})
}

/**
 * 判断 `#RRGGBB` 是否为深色底，用于决定系统栏图标取浅色还是深色。
 * 解析失败一律按浅色底处理（图标用深色，最坏情况仍可辨认）。
 */
export function isDarkColor(color: string): boolean {
  const value = color.trim().replace(/^#/, '')
  if (value.length !== 6) return false
  const r = Number.parseInt(value.slice(0, 2), 16)
  const g = Number.parseInt(value.slice(2, 4), 16)
  const b = Number.parseInt(value.slice(4, 6), 16)
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return false
  // sRGB 加权相对亮度
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.5
}

/** Resolve the current mounted surface, then the root theme; shared by native and mobile browser chrome. */
export function restoreNativeSystemBarsToTheme(options?: { forceNative?: boolean }): void {
  const surface = currentSystemSurface()
  if (!surface) return
  syncBrowserThemeColor(surface)
  // Resolve again when this queued write runs: layout/theme can change while native exit waits.
  queueNativeSystemSurface(currentSystemSurface, options?.forceNative === true)
}
