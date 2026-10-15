import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.chevoink.app',
  appName: '启创墨域',
  webDir: 'dist',
  // 远程站点通过 UA 识别自己运行在 APP 壳内（前端据此隐藏全屏弹窗/设置、接管状态栏配色）；
  // 版本号供 APP 内更新提示与线上 version.json 比对。
  // 发新壳版本必须三处一起改：这里、android/app/build.gradle 的 versionCode+versionName、
  // 线上 /download/version.json；漏改这里会导致装了新包仍被判定为旧版本、更新横幅不消失。
  appendUserAgent: 'ChevoinkApp/1.0.11',
  server: {
    // Stage 1: remote mode - load the production site directly (same-origin cookies)
    url: 'https://chevoink.chevolink.com',
    cleartext: false,
  },
  android: {
    allowMixedContent: false,
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 1500,
      launchAutoHide: true,
      backgroundColor: '#FCFAF6',
      // 无字品牌图完整显示，信箱区为纸色与背景无缝
      androidScaleType: 'FIT_CENTER',
      showSpinner: false,
    },
    StatusBar: {
      // classic layout: webview starts below the status bar, no notch overlap
      overlaysWebView: false,
      style: 'LIGHT',
      backgroundColor: '#FCFAF6',
    },
  },
}

export default config
