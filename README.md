# 启创墨域 Chevoink — 安卓壳（Capacitor）

启创墨域的安卓客户端壳工程：基于 Capacitor **远程模式**，WebView 直接加载线上站点 <https://chevoink.chevolink.com>。Web 端部署即全端生效，**只有原生层改动才需要重新打 APK**。

- 主仓库（Web 全栈，`main` 分支）：<https://github.com/Xcy8010/chevoink>
- APK 下载：[GitHub Releases](https://github.com/Xcy8010/chevoink/releases) 或官网直装 <https://chevoink.chevolink.com/download/chevoink.apk>

## 架构说明

| 部分 | 说明 |
| --- | --- |
| `capacitor.config.ts` | 壳配置：远程站点地址、`appendUserAgent`（版本标识）、SplashScreen / StatusBar 插件 |
| `android/` | 原生工程：签名配置、启动图、`ImmersiveModePlugin`（自定义全屏沉浸插件） |
| `assets/` | 图标与启动图源图（经 `@capacitor/assets` 生成各密度资源） |
| 其余 `src/ api/ prisma/ ...` | 与主仓库同步的 Web 代码快照，仅用于本地 `npm run build` 产出 `dist` 供 `cap copy` |

关键原生能力：

- **UA 版本标识**：`appendUserAgent: 'ChevoinkApp/x.y.z'`，前端据此识别壳内环境并做应用内更新比对
- **ImmersiveMode 插件**：Android 15 上官方 `StatusBar.setOverlaysWebView` 已失效，阅读区真全屏沉浸由自定义插件 `android/app/src/main/java/com/chevoink/app/ImmersiveModePlugin.java` 实现
- **应用内更新**：启动时请求线上 `/download/version.json`，比对 UA 版本后展示更新条幅

## 本地构建

```bash
# 1. Windows/PowerShell：锁定依赖、校验官方 AAR 与许可证、重建壳资源和原生生成文件
powershell -File scripts/prepare-android-source.ps1 -InstallDependencies

# 2. 需要本地 release keystore 和已发布旧 APK，测试、打包、比较签名；默认依赖离线模式
powershell -File scripts/build-android-release.ps1
```

当前版本的构建文件：`android/app/build/outputs/apk/release/chevoink-v1.0.18.apk`（code 21）；验证后复制为
`artifacts/android/chevoink-v1.0.18-<sha256前12位>.apk`。这些脚本不会上传或发布。
旧 `app-release.apk` 是签名基线，不能覆盖。完整前置条件见 `release/ANDROID-HANDOFF.md`。

1.0.8 修复阅读全屏切换的系统栏恢复，并按 WebView 实际剩余安全区处理挖孔、横竖屏及系统栏变化；
保留旧网页的 `enter` 高度字段。完整构建、签名和设备验收分别记录，不能由单元测试推定所有机型已通过。

1.0.9 增加 `ImmersiveMode.setSystemBarAppearance({color:'#RRGGBB',dark:boolean})`，仅修改系统栏外观，
修复 Android 16 设备上 target35 + opt-out 窗口被旧 StatusBar 插件跳过染色的分支。
当前仍为 target35；未来 target36 的强制 edge-to-edge 不在此颜色 API 的支持范围，调用会明确拒绝。
已发布的 1.0.8 文件与标签保持不变。新包需单独完成设备验收与发布授权。

1.0.10 将同一外观色同步到 decor 与实际 WebView 父容器的原生背景，处理阅读全屏时
WebView 外露出的主题色区域。保存独立背景快照，恢复后重应用最新页面配色；外观事务失败时回滚所有已尝试的部分。
不调整安全区、父容器 padding 策略、键盘或全屏规则。1.0.10 已发布，历史产物保留原样。

1.0.11 修复退出阅读后普通页面重复预留系统栏空间：在布局稳定后，以实际父容器
相对 decor 的外部留边扣除可确认重复的系统栏 padding。仅处理 API35+ 的 core SystemBars
CSS fallback，不改其 listener；保留自定义、IME 与相对方向 padding，不缓存机型或固定栏高。

1.0.12 支持新版网页在系统状态栏和手势栏下绘制背景，普通页面继续显示系统图标，阅读区保留沉浸模式。
新版网页通过 `ImmersiveMode.enableEdgeToEdge()` 启用当前文档；旧网页继续使用系统预留空间，完整重载会重新协商。
同一个文档中退出沉浸阅读时恢复该页面的布局。键盘占用的空间由原生窗口处理，安全区接口返回 CSS 像素。

1.0.13 让新版网页的底栏背景延伸到手势区域时使用透明系统栏，系统按钮导航仍保留对比度保护。

1.0.14 统一开屏和加载时的窗口底色与系统栏配色。网页切换到已保存的深色主题后，开屏退出时保留正确的系统栏图标颜色。

1.0.15 支持网页分别同步顶部状态栏和底部导航栏配色。边到边布局中系统手势栏保持可见并透明叠在网页底部背景上，保留三键导航对比度。

1.0.16 随线上网页更新改善 Android 底部安全区布局，调整移动端作品记忆界面。安卓壳同步应用内更新的版本标识。

1.0.17 修复边到边布局中底栏与系统导航区之间的色带。页面背景延伸到手势条和三键导航按钮下方，系统导航控件继续可见。

1.0.18 将退后台时的 Cookie 写入移出界面线程。WebView 渲染进程退出后会尝试自动恢复，短时间内再次退出时提供手动重试。断网重试只在前台执行，主页面可见后收起离线提示。

## 签名配置（不入库）

release 签名从被 gitignore 的 `android/keystore.properties` 读取，模板：

```properties
storeFile=../chevoink-release.keystore
storePassword=***
keyAlias=***
keyPassword=***
```

`*.keystore` / `keystore.properties` / `.env` / `plan/` / `cert/` 等敏感与内部文件均已被 `.gitignore` 排除。
release 缺少签名配置、必填字段或 keystore 时直接失败，禁止回退 debug；普通 debug 构建仍可使用 debug 签名。
受控发布可通过 `CHEVOINK_ANDROID_SIGNING_PROPERTIES` 指向专用签名目录中的既有 `keystore.properties`，避免把签名文件复制到源码工作树。

## 离线语音

原生 `ChevoinkSpeech` 使用官方 sherpa-onnx1.13.7 AAR 和 SenseVoice/Silero，支持60秒
单声道float32LE、16kHz输入，VAD分段并逐段限制为20秒。音频不上传、不走系统云识别。
模型由用户主动从同源 `/voice/native-sensevoice-1.13.7/` 下载；不能将该目录放入会被覆盖的Web发布根目录。

`third-party/speech/` 包含完整许可证及署名，自动进入APK的 `assets/speech/`。
模型准备脚本同时复制完整 `licenses/`；发布rawmodel时必须一起复制。
已下载WASM数据的可重复提取命令：

```powershell
node scripts/stage-native-from-wasm.mjs <已验证的sherpa-onnx-wasm-main-vad-asr.data绝对路径>
```

AAR、APK、模型二进制、生成资源和密钥均不应提交Git。

## 发版流程（版本号必须三处同步）

发布新壳版本时，以下三处**必须一起改**，漏改任意一处会导致新包仍被判定为旧版、更新横幅不消失：

1. `capacitor.config.ts` → `appendUserAgent: 'ChevoinkApp/x.y.z'`
2. `android/app/build.gradle` → `versionCode`（递增）+ `versionName`
3. 线上 `/download/version.json` → `latestVersionName` / `latestVersionCode`

然后 `npm run build && npx cap copy android` 重新同步 Web 产物，再打 release 包、上传服务器 `/download/chevoink.apk` 并附到 GitHub Release。

## License

私有项目，保留所有权利，未经授权不得使用、复制或分发。
