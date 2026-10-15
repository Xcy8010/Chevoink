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

当前候选：`android/app/build/outputs/apk/release/chevoink-v1.0.9.apk`（code 12）；验证后复制为
`artifacts/android/chevoink-v1.0.9-<sha256前12位>.apk`。这些脚本不会上传或发布。
旧 `app-release.apk` 是签名基线，不能覆盖。完整前置条件见 `release/ANDROID-HANDOFF.md`。

1.0.8 修复阅读全屏切换的系统栏恢复，并按 WebView 实际剩余安全区处理挖孔、横竖屏及系统栏变化；
保留旧网页的 `enter` 高度字段。完整构建、签名和设备验收分别记录，不能由单元测试推定所有机型已通过。

1.0.9 增加 `ImmersiveMode.setSystemBarAppearance({color:'#RRGGBB',dark:boolean})`，仅修改系统栏外观，
修复 Android 16 设备上 target35 + opt-out 窗口被旧 StatusBar 插件跳过染色的分支。
当前仍为 target35；未来 target36 的强制 edge-to-edge 不在此颜色 API 的支持范围，调用会明确拒绝。
已发布的 1.0.8 文件与标签保持不变。新包需单独完成设备验收与发布授权。

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
