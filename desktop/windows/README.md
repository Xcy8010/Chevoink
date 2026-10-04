# Chevoink Windows 客户端

2026-09-10 验收补充：用户确认本机 1.0.2 在 Win11 下新图标、启动、空闲退出、重开登录/草稿/待审状态保留通过，写作、上传导出、语音与听书无异常。下方“完整验收未完成”仅指剩余故障矩阵和设备/更新验证，不再代表上述五项未测。

未内置 updater 公钥的候选包需要手动安装首个带公钥的签名新版本，不能只靠服务器清单升级。`verify-installer.ps1` 为只读的版本/摘要/预期发布者/Authenticode/时间戳预检，不代替 updater 签名与真实跨版本更新验收。

当前为 **1.0.2 开发候选版**，不是已完成正式签名与真机验收的稳定版。内部 CI 安装包不能替代公开 Release。发布状态与验收边界见 [Windows 工程说明](../../docs/WINDOWS_DESKTOP.md)。

1.0.2 已通过普通/增强安装包构建、CI 安装路径和首次启动前快捷图标校验、实际进程启动检查。修复首启网络误报、首次全屏询问及退出确认返回值；安装器使用安装目录中的版本化 Logo 文件。网页保存握手适配已合入 main 并部署。完整 Win11 交互验收、签名及更新实包验证仍未完成，不能以构建通过代替。

1.0.0 在本机发现 updater 配置缺失导致启动退出，已撤回公开测试包。1.0.1 补充配置反序列化回归、实际 EXE 启动检查和启动失败提示。没有签名公钥时仍禁止检查/安装更新，空配置不是占位签名。安装器遇到 Codex 包缓存内的旧安装位置时改用当前用户的 `AppData/Local/Programs/Chevoink`，不删除旧数据。

## 架构

Tauri 2 / WebView2 Evergreen 加载 `https://chevoink.chevolink.com`。不复制创作业务，不在本地运行后端、数据库或 Agent。标准标题栏之外继续使用网站界面；关闭客户端不暂停云端任务，重新打开不自动发送“继续”。

Windows 保存握手通过根项目 `src/lib/desktop-lifecycle.ts` 接入原编辑保存与草稿逻辑。网页适配未部署时，宿主不会把无回执认定为已保存；会提示保留窗口或明确放弃未保存内容。

## 开发和构建

需要根仓库固定的 Node 22.23.2 / npm 10.9.8、`rust-toolchain.toml` 指定的 Rust 1.94.0，以及 MSVC C++ Build Tools、Windows SDK 和 WebView2。不得通过关闭系统防护解决安装问题。

在本目录执行：

```sh
npm ci
npm run dev
cargo fmt --all --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --locked --manifest-path src-tauri/Cargo.toml
npm run build -- --ci
npm run build:offline -- --ci
```

开发启动使用 `com.chevoink.desktop.dev`，正式配置使用 `com.chevoink.desktop`。二者 WebView2 数据目录独立；开发配置禁止使用正式更新通道。即使数据隔离，开发壳仍连接官网，不得用真实作品做破坏性测试。

安装包生成在 `src-tauri/target/release/bundle/nsis/`。当前未配置正式签名时仅供内部测试。`build:offline` 仅用 Tauri 官方 `offlineInstaller` 模式内嵌 Evergreen 安装器，不内嵌固定版本内核，不提供离线创作。两种构建保持相同 appId、版本、代码与数据目录。

本地两条构建命令使用同一个输出文件名，顺序执行会替换上一种构建产物；需保留两种时先复制普通包到独立目录。CI 先上传普通包，再构建增强包并加 `-webview2-offline` 名称单独上传，避免混淆。正式更新仍使用标准安装包及独立稳定通道。增强包在缺内核的干净系统上的安装、正式发布流水线与更新实包验证尚未验收。

## 安全与退出

- 页面仅有版本查询和带一次性 nonce 的保存回执能力；没有任意 shell、文件路径或安装指令桥接。
- 主站 origin 精确校验。外部 HTTPS 用户点击交给浏览器；其他协议拒绝。
- 导出用系统保存对话框。WebView2 下载 deferral 留在 UI apartment，选择文件的对话框不阻塞下载事件回调；完成、取消、失败分别处理。
- 正常退出等待原保存链路。保存失败、录音/下载未结束或用户在等待期间继续输入，不自动关闭。不会自动接受/拒绝审查。
- 不记录账号凭据或正文。Windows 停止 localStorage Bearer 兜底，Cookie 会话仍由原服务管理。

## 发布约束

Windows 标签为 `windows-v<version>`，安装包为 `Chevoink_<version>_x64-setup.exe`。Windows Release 必须设置 `latest=false`，不得抢占 Android 使用的全仓 Latest。

正式分发必须先完成 Authenticode 签名，再对最终安装包生成 Tauri updater 签名与 SHA256。编译时的 `CHEVOINK_UPDATER_PUBLIC_KEY` 仅放公钥；私钥不得进入仓库、普通构建或日志。未配置公钥时不安装更新。

版本目录：`/download/windows/<version>/`；稳定清单：`/download/windows/stable/latest.json`。先发布并核验不可变安装包，最后更新稳定清单。电脑网页设置仅在合法 Windows 稳定清单可读取时显示入口；手机 APK 通道不变。

SignPath Foundation 目前只是申请候选渠道，未获批、未配置，不能标注“已提供免费签名”。仓库的商业授权安排是否符合其条件，需先得到对方确认。
