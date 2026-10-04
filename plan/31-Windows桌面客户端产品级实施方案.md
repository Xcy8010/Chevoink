# 31 · Windows 桌面客户端产品级实施方案

> 状态（2026-09-10 更新）：壳工程与网页适配已实现；1.0.2 未签名候选包的 Win11 核心交互已获用户确认。正式签名、完整故障/设备验收、跨版本更新和稳定 Release 尚未完成，详见 §15。
> 调查日期：2026-09-09；代码基线：`0dff3441f1e1409fd0eff15a6d4391cc5479653a`。
> 目标：像现有安卓壳一样复用 Chevoink，同时达到可安装、可更新、可恢复、可维护的 Windows 产品标准。
> 不变约束：不重做界面、不移植业务、不改变 Agent/正文/审查/Credits 语义；网页版和安卓端不退化。明确允许的网页新增项是电脑设置内的 Windows 下载入口，复用手机端现有样式。下述新增路径都是待实施项，不是现有能力。

## 0. 给执行代理的交付约定

本文是后续执行依据，不再另写方案、重做选型或安排人工团队逐项接手。用户启动实施后，由 Codex 在已准备的 `chevoink-windows` worktree 连续完成实现、定向验证、集中审查、四闸、Windows 打包、中文提交、推送、GitHub Release 上传和网页入口部署。阶段进展只发过程消息；构建运行中等待同一进程或处理独立工作，不用阶段性总结提前收尾。

最终交付必须同时包含：

1. 可安装的 Windows x64 `.exe`，不是源码 ZIP、开发启动器或只留在 CI 的临时 artifact。
2. `Xcy8010/chevoink` 的 Windows 专属 Release，含安装包、签名/摘要、中文说明、对应提交与验收结果；最终回复给出 Release 页及安装包直链。
3. 电脑网页设置中的客户端下载入口，弹窗**只提供 Windows**；手机端原有入口、选项与行为不变。下载的是本次通过验证的最新 Windows 稳定安装包。
4. 独立 Windows 更新清单与可恢复的更新链路；README/工程说明按实际完成状态更新。
5. 真实验证结果与尚未覆盖的边界。证书、权限、实体设备不凭空假设；不将未签名包、模拟测试或未公开的草稿 Release 宣称为正式交付。

效率原则：先一次预检发现硬阻塞，集中完成主体改动，最后统一完整审查；只对高风险原生能力做必要的提前探针。独立检查和构建可并行，不并行修改同一文件，不通过省略安全/功能验证缩短时间。未经另行授权不购买证书、开通付费服务或绕过分支/发布审批。

## 1. 结论与上线范围

**推荐：Tauri 2 + WebView2 Evergreen + 远程同源站点 + 少量 Windows 宿主适配。**

用一个独立构建的 Windows 壳加载 `https://chevoink.chevolink.com`，继续使用当前 React 页面与 Express API。Windows 本地不启动 Node 服务、数据库或 Agent，不复制整套前端、不维护桌面专用业务分支。Tauri/Rust 只负责窗口、权限、下载、生命周期和壳更新。

这是基于当前项目的选型，不是“Tauri 在所有项目都优于 Electron”的结论。项目已经有成熟的桌面 Work/IDE 布局，现阶段需求主要是 Windows 安装分发及宿主能力，而非本地 AI、插件市场或本地文件工程。

**可以实现高质量适配，但不能承诺所有 Windows 设备“无需测试、百分之百完美”。** 合格标准是本文支持矩阵与关键链路全部通过，而不是打开首页便算完成。WebView2 的版本、显卡驱动、DPI、系统权限与网络环境仍有差异；Evergreen 负责更新内核，不代表所有设备同一时刻使用同一版本。[WebView2 分发说明](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution)

首版交付：

- Windows 11 当前受支持版本的 x64 安装包；兼容 Windows 10 22H2 x64，单独标注系统安全支持边界。
- 单实例、单主窗口；应用内部现有多个任务窗口/分支/队列照常使用，不新增第二套标签系统。
- 原界面、原实时字数/工具动画、原待办/变更、原审查操作、原 Work/IDE 布局。
- 登录保留、任务草稿与布局保留、正常关闭前处理未保存编辑、网络恢复后重接 SSE。
- 上传/拖入、复制粘贴、作品导出、原有本机语音输入及听书的 Windows 适配。
- 签名安装包、受验证的壳更新、启动故障兜底、诊断版本信息及卸载策略。
- GitHub Release 内可直接下载的最新 Windows `.exe`；电脑网页设置复用原客户端下载弹窗，仅展示 Windows 选项。

不纳入首版：离线编辑同步引擎、本地数据库/模型服务、多个独立顶层创作窗口、全局快捷键、开机自启、常驻托盘、深链接协议、微软商店、macOS/Linux、ARM64 原生包。后者不是技术上不能做，而是不为本次套壳增加范围。

## 2. 已核实的项目事实

| 当前证据 | 对 Windows 方案的影响 |
| --- | --- |
| 安卓独立工程 `C:/Users/Xcy24/Desktop/chevoink-android/capacitor.config.ts`：`server.url` 指向生产域名，UA 为 `ChevoinkApp/1.0.6` | 可复用“远程同源”的原理，不能把安卓插件和 UA 原封不动搬来 |
| `src/lib/native-app.ts` 按 `ChevoinkApp` 识别；原生操作依赖 Capacitor | Windows 使用独立标识 `ChevoinkDesktop/<version>`，不令 `isNativeApp()` 的现有安卓分支误命中 |
| `src/lib/app-update.ts`、`src/components/ui/UpdateBanner.tsx` 读取 `/download/version.json`、分发 APK | Windows 更新有独立清单/安装包/签名链，不接入 APK 更新通道 |
| `src/app/api-base.ts` 默认相对 API；`api/lib/auth-session.ts` 设置 HttpOnly、SameSite=Lax Cookie | 远程同源保留当前路由与 Cookie/CORS 关系，不为套壳改成跨站 Cookie |
| `src/lib/auth-token.ts` 的 localStorage Bearer 兜底，实际由 `useShellStore.setAuthenticated` 无平台判断地写入 | 不能声称当前只有安卓才存令牌；桌面应有定向的不落明文令牌策略，见 §5 |
| `src/features/studio/agent/composer-drafts.ts` 按作用域保存草稿，`components/use-workspace-layout.ts` 管理布局 | 保留现有数据键与任务隔离；Windows WebView 的数据目录必须稳定 |
| `components/use-chapter-persistence.ts` 存在编辑器防抖、保存并发与待审查保护 | 关闭/更新前必须等待原保存链路，不把“窗口已关闭”当成“正文已保存” |
| `agent/useAgentStream.ts`、服务端 `agent/run-service.ts`/`events.ts` 负责流与重放 | 恢复显示必须走原 run/seq 协议，不在壳里重发用户提示词 |
| `studio/lib/export-download.ts` 使用 fetch + Blob，安卓另用导出链接；`native-app.ts` 有 https 改 http 的安卓外跳兼容逻辑 | Windows 原生处理下载与外链，不复用降为 http 的绕行 |
| `agent/voice/speech-engine.ts`、`docs/VOICE_INPUT.md`：浏览器 Worker + WASM、CacheStorage、本机转写；安卓插件单独判断平台 | Windows 优先复用浏览器转写链路，不误调用 Android 插件；不新增云端 ASR 或 Credits |
| `src/app/routes/settings/client-os.tsx`、`SettingsPage.tsx` 已有客户端下载入口 | Windows 包通过验收后才开放入口，不先挂一个不可安装的下载按钮 |

安卓 19 号方案是历史规划，不是当前版本事实。其中“全机型统一内核”“装壳即完美”等表述不能作为 Windows 验收依据；也不沿用复制整个含后端的工作目录做壳工程的方式。本文不改写该历史文件。

## 3. 方案比较

| 路线 | 与本项目的匹配度 | 主要代价/边界 | 决策 |
| --- | --- | --- | --- |
| **Tauri 2 + WebView2，远程加载** | 复用线上 SPA；可做安装、窗口、下载和签名更新 | 小量 Rust/Windows 宿主代码；需验证 WebView2 权限/版本 | **首选** |
| Electron，远程加载 | TypeScript 团队上手直接，自带 Chromium，桌面生态丰富 | 安装与更新携带 Chromium/Node；持续跟进内核安全；远程页与 Node 必须隔离 | Tauri 核心兼容探针失败且修补不划算时的备选，不双线实现 |
| C# WPF/WinUI + WebView2 | Windows 原生控制直接 | 新增 C# 技术栈；更新、协议与原生适配需更多自行整合 | 无现有 C# 桌面基础，不作为首选 |
| PWA/Edge 安装站点 | 最快获得独立窗口，便于先验证布局 | 浏览器安装/更新/策略决定能力，不能替代独立安装器与发布合同 | 可作体验基线，不作正式 Windows 客户端方案 |
| 本地打包现有 dist | 页面资源可随安装包加载 | 本地 origin 引出认证/CORS、版本兼容和更新问题；不自动获得离线写作 | 暂不采用 |
| React Native/Flutter 重写 | 可做原生 UI | 改动大、双份业务维护、回归面大 | 排除 |

Electron 不是不安全，而是不能让远程页面获得 Node 能力；官方要求远程内容关闭 Node integration，并进行上下文隔离、权限和导航控制。[Electron 安全指南](https://www.electronjs.org/docs/latest/tutorial/security)

不在方案里写未经实测的“内存少几倍、启动快几倍、安装包必然几 MB”。实际包体需区分壳、WebView2 安装器和约252MB的可选语音资源。

## 4. 结构与改动边界

```text
Windows 原生窗口（标准标题栏，单实例）
  ├─ Tauri/Rust：窗口状态、导航/权限、下载、更新、启动故障处理
  ├─ 本地内置兜底页：仅用于初次加载失败/宿主故障，不替代创作区
  └─ WebView2：HTTPS 线上 Chevoink，复用现有 React UI
       ├─ 同源 /api → 当前 Express/PostgreSQL/Agent/Credits
       ├─ SSE → 当前 run/seq 重放链路
       └─ 同源 /voice → 现有本机语音资源

壳安装/更新：独立 /download/windows/ 通道 → 签名校验 → 用户确认安装
```

建议放在**同一仓库的 `desktop/windows/`**，有独立 package/lock、Cargo/lock、构建和发布流水线。远程页面仍只使用根目录现有前端。这样审查和版本关联统一，又不把桌面工具链混入生产 API 安装依赖。

工作区准备（2026-09-09）：用户指定 `C:/Users/Xcy24/Desktop/chevoink-windows`，已从上述代码基线创建同一仓库的本地 `chevoink-windows` 分支及 Git worktree。后续壳工程的完整路径为 `C:/Users/Xcy24/Desktop/chevoink-windows/desktop/windows/`。该目录是独立工作区，不是第二套业务仓库；不重新 `git init`，不将当前主工作区的其他未提交内容带入。此时仅完成版本管理准备，尚未创建壳代码、安装依赖或推送远端分支。

- 不复制 `.env`、`cert`、数据库、用户上传、日志、私有 plan、整个 `node_modules`；脚手架按文件白名单创建。
- 根 Node/npm 固定版本政策继续遵循。Rust/MSVC/Tauri/插件在首次可行性验证后固定经过验证的稳定组合及锁文件，不使用浮动 `latest` 做发布。
- 生产 Linux 部署保持原流程，不依赖 Rust/Windows SDK；Windows CI 在 Windows runner 编译，不拿 Linux 交叉编译作为首版主路径。
- 线上业务部署与壳升级分别发布；不部署未验证的桌面入口，不因出 Windows 包中断生产 Agent。
- 不给 `StudioWorkspace`、`AgentPanel` 新增一堆平台判断；集中在小型宿主适配与已有保存/生命周期接口。

## 5. 登录、数据与任务生命周期

### 5.1 登录与私有数据

1. 保持精确生产 origin。Windows 与默认浏览器使用不同 Cookie/存储容器，首次需要在客户端登录；不能承诺自动继承 Chrome/Edge 登录。
2. WebView2 使用固定、可写的当前 Windows 用户私有数据目录，建议 `%LOCALAPPDATA%/Chevoink/Desktop/WebView2`；不放安装目录、临时目录、公共目录或网盘，不因版本升级换路径。[WebView2 用户数据目录](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/user-data-folder)
3. 继续使用服务端 HttpOnly Cookie；Windows 平台定向跳过 `auth-token.ts` 的 localStorage Bearer 写入/读取，不复制 Cookie/令牌到 Rust 配置、日志或系统浏览器。平台标识只控制兼容路径，**不能作为服务器授权凭证**。
4. 当前登录响应仍包含 tokens。停止桌面 localStorage 兜底不等于全站已实现 HttpOnly-only；本次不顺带重构全站认证。`useShellStore` 本身的持久化白名单不含 authTokens，要保留这一约束。
5. 已有窗口启动后，确认 Cookie 会话有效再清理桌面数据容器内旧的 `chevoink-session-token`；只动这一键，不清草稿、审查记录和其他端的资料。会话失效走正常重登，不偷偷补本地长期令牌。
6. 官网域名不随意迁移。域名变化会影响 Cookie/草稿存储，必须另做迁移，不当成普通壳版本变更。
7. 账号 A/B 切换继续按用户/作品/任务隔离。开发版与正式版使用不同 appId、数据目录、更新通道，开发版不能加载生产账号数据。

### 5.2 草稿、审查、布局

- 保留现有任务草稿键与右栏/查看器作用域；左侧栏仍按既有共享规则。不因桌面封装改作用域或默认布局。
- 新建作品不接受/拒绝旧作品待审查内容；壳重启、升级、网络恢复均不改审查状态。
- 应用窗口的位置、尺寸、最大化状态单独持久化；不混入任务内分栏宽度。
- 首版不创建多个独立创作 WebView，避免共用 localStorage 时新增跨窗口写入竞争。已有应用内任务窗口不是被砍掉的功能。
- 正常关闭/安装更新前，先请求页面 flush 当前编辑器与原保存队列，等待“已持久化/尚未保存”的明确回执；不假设失焦或 beforeunload 能完成异步保存。
- 未保存/网络断开时默认留在当前窗口，提供取消关闭或明确放弃本次未保存编辑的选择；不能自动采纳待审查内容来促成关闭。
- 操作系统断电/强杀无法保证最后未持久化按键零丢失。首版承诺已持久化草稿/已保存正文可恢复，并对正常退出做保存握手；不宣称已实现离线正文数据库。

### 5.3 Agent 与连接

| 动作 | 必须保持的语义 |
| --- | --- |
| 最小化 | 不调用暂停/取消 API；恢复后从原 run/seq 补进度 |
| 关闭桌面窗口 | 关闭客户端连接，不默认停止云端 Agent；有未保存编辑先处理 |
| 重新打开 | 查询服务端真实运行状态、恢复旧消息/事件；不能自动再发送“继续” |
| 用户明确点暂停 | 使用当前暂停协议，收到结果后收尾动画，不由壳伪造已暂停 |
| 睡眠/断网/换网 | 连接重建、按序去重；不重复创建 run、写入正文或结算 Credits |
| 页面/宿主崩溃 | 恢复最近安全路由和已持久化状态；不把旧“运行中”无限转圈 |
| 壳升级 | 不以升级为由重启生产后端；只在用户确认且本地保存安全时退出客户端 |

套壳不能修好服务端所有长任务问题，也不增加“后台 Agent 永不停止”的保证。服务器的运行限制、取消、授权与计费仍由现有协议决定。

## 6. Windows 适配清单：保留原 UI，而非重做

### 6.1 窗口、缩放、输入

- 标准 Windows 标题栏、最小化/最大化/关闭、拖动与贴靠；首版不自画无边框标题栏，不搬动网页顶部菜单。
- 初始内容尺寸建议1280×800 DIP，限制在当前屏幕工作区内；最小尺寸候选640×480 DIP，同样按实际工作区缩小，不能在高 DPI 小屏上开出屏外窗口。
- 窗口变窄时走现有响应式布局；不伪造 UA、固定 viewport 或 CSS zoom 强制塞桌面三栏。
- DPI 用逻辑像素；100%、125%、150%、200%及不同 DPI 双显示器之间拖动均验证。恢复几何位置时检测屏幕是否仍存在，必要时移回可见区域。
- 保留编辑器、IME、Enter/Shift+Enter、Ctrl+C/V/Z、原保存快捷键；IME composition 期间不得误发消息。系统级快捷键不全局抢占。
- F11/网页全屏与宿主全屏做单一映射，Esc逐级退出；不触发安卓系统栏/软键盘逻辑。
- 原工具卡动画、实时字数、胶囊、审查按钮、窄查看器图标行为全部保留。动画尊重系统减少动态效果设置。

### 6.2 上传、导出、复制与外链

- 文件选择优先复用标准 input，拖入文件只进入原上传链路；阻止拖入文件导致顶层导航到本机 file URL。
- 导出先验证现有 fetch→Blob→下载在真实 WebView2 上的表现。宿主处理下载事件、保存对话框和完成/失败状态，不将 Blob 正文通过 IPC 反复复制成大 JSON。[Tauri WebviewWindowBuilder 下载事件](https://docs.rs/tauri/latest/tauri/webview/struct.WebviewWindowBuilder.html)
- 保存路径由用户的系统对话框选择；清洗建议文件名中的目录穿越、Windows 保留名、控制字符。重名覆盖需确认，不自动打开下载的可执行文件。
- 必须覆盖 TXT、DOCX/EPUB（以现有导出入口为准）、ZIP、中文长文件名、取消、磁盘空间不足和下载途中退出。
- 如果当前内核的 Blob 下载兼容性不通过，在原下载辅助函数加入 Windows 定向分支，复用已有临时导出链接 API；不新增第二套导出服务、不将登录令牌拼到 URL、不记录带票据的下载链接。
- 外部 HTTPS 链接交系统默认浏览器；应用 origin 内的路由仍在当前窗口。外跳必须为用户动作，禁止远程页面无限拉起浏览器。
- 不复用安卓 `https → http` 的外跳兼容逻辑；Windows 不开放任意 scheme 的系统执行。
- 复制优先现有 Clipboard API/原兜底。除非真实内核验证证明需要，不新增通用原生剪贴板读取权限。

### 6.3 语音与听书

- Windows 使用现有 Web Worker + WASM 设备端识别，不调用 Android `ChevoinkSpeech`。语音模型仍按用户确认下载、独立缓存，不塞入主安装包。
- 在 WebView2 权限回调中仅对精确主站 origin、前台用户发起的麦克风请求弹出允许/拒绝；地理位置、摄像头等未使用能力默认拒绝。系统隐私设置拒绝时给出操作指引，不绕过系统权限。[WebView2 权限请求](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2permissionrequestedeventargs)
- 验证 Worker、AudioWorklet、WASM SIMD、CacheStorage、HTTPS/CSP；不为了识别放开全站 unsafe-eval 或关闭安全隔离。
- 保留切任务/切后台取消录音、转写填草稿不自动发送、不上传音频、不收 ASR Credits 等当前行为。
- TTS测试最小化、锁屏、音频设备切换、连续切章；系统睡眠不能承诺继续播放。不擅自增加阻止休眠或常驻服务。

### 6.4 启动、弱网和崩溃

- 初次页面尚未加载，出现 DNS/TLS/超时等故障时，显示包内兜底页：原因分类、重试、在浏览器打开、版本信息。
- **已有页面在写作时断网，不把它导航到兜底页**，否则会丢内存编辑状态。保留当前页面，沿用网络提示和原连接恢复。
- 顶层导航失败与 API 业务失败分开。401走登录、403走原权限提示、服务器维护如实说明；不把所有错误都标成“网络断开”。
- TLS 证书错误不点穿、不忽略。重试限次/退避，自动重试只用于幂等读取/连接，不用于新建 Agent 或写操作。
- 渲染进程崩溃后自动恢复最多一次，重复崩溃显示故障页，不进行重载死循环。

### 6.5 电脑网页设置：仅 Windows 下载

当前 `SettingsPage.tsx` 用 `!isNativeApp() && isMobile` 限制入口，弹窗固定遍历 `CLIENT_OS_OPTIONS` 的三个移动系统。这次定向解除电脑网页入口限制，不重做设置页。

| 使用环境 | 要求 |
| --- | --- |
| 电脑网页 | 设置内增加“下载客户端”入口，复用现有设置行/下载图标/弹窗/主题/动效；只显示一个 Windows 选项，按钮为“下载 Windows 客户端” |
| 手机网页 | 保留安卓、苹果、鸿蒙原有选项与各自当前行为，不因 Windows 上线改动 APK 地址或添加桌面选项 |
| Windows 壳 | 不重复展示安装自己的网页入口；检查更新使用原生菜单与 §8 更新链路 |
| Android 壳 | 保留现有原生更新逻辑，不进入 Windows 下载/更新分支 |

- 在 `settings/client-os.tsx` 分开移动与桌面选项，补 Windows 图标/类型；复用现有视觉规范。单选项布局自适应，不保留三个空占位，不顺带改手机卡片宽度。
- 平台判定与布局宽度分开：缩窄电脑浏览器仍是 Windows 下载选项，不能因为响应式断点变成 APK；核对现有设备检测后只加必要判断与测试。Mac/Linux 电脑网页也只提供 Windows，并说明“适用于 Windows x64”，不假装已有其他平台客户端。
- 弹窗重开/平台选项变化时清理无效选择；下载按钮文案与实际平台选项一致。键盘操作、焦点返回、关闭、亮暗主题保持原体验。
- 从独立 Windows 稳定通道获取版本和真实安装包 URL，复用官方 updater 清单中的版本/平台 URL 或轻量解析，不新增数据库/下载服务。只接受约定 HTTPS 分发源；不从 GitHub 全仓 latest 推测 Windows 包。
- 国内镜像与 Release 必须是同一份最终产物、相同 SHA256。优先官网可达下载源；失败明确提示并提供对应 Release，不自动连续重试或自动运行安装器。
- 没有已验收稳定包时不开放可点击的假下载入口；先验证产物和清单，再部署入口。清单超时、无平台项、404、错误 URL 均有失败反馈，不能显示虚假的下载成功。

## 7. 原生安全边界

远程页面可能包含用户内容，不能因为来自本域就认为永远可信。Rust 原生进程权限更高，必须缩小页面能够触及的范围。[WebView2 安全指导](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/security)

1. 主窗口顶层只允许精确生产 origin；解析 scheme/host/port，不使用 `startsWith`，不放行 `*.chevolink.com`。本地兜底页面单独列入允许项，开发 origin 不进入正式包。
2. 所有新窗口、重定向、外跳、下载都在宿主判断；拒绝 javascript/file/data 顶层导航及任意命令协议，Blob仅限本页实际下载用途。
3. 不向远程页开放通用 shell、进程启动、任意 HTTP、任意文件读写、任意路径打开、updater-install 或创建特权窗口权限。
4. 远程页仅在必要时开放两条窄命令：`desktop_get_info`（版本/能力）和 `desktop_report_state`（dirty/saving/recording/运行显示状态及退出握手 nonce）。不携带正文、令牌、任意URL或文件路径，不产生付费/保存/安装副作用。
5. 将自定义命令纳入 `AppManifest::commands` 和显式 capabilities/permissions；不要误以为自定义 `invoke_handler` 命令天然受默认插件 ACL 限制。限制主窗口label、精确远程origin，验证发送者实际页面/frame及载荷schema，防止本地兜底与远程窗口权限合并。[Tauri capabilities 与自定义命令默认行为](https://v2.tauri.app/security/capabilities/)
6. 宿主发出的退出/保存请求带一次性 nonce；回执只作为退出体验信息，不作为授权或更新签名依据。状态未知时默认不自动退出，保留原生用户确认。
7. 更新检查和安装由 Rust 原生菜单/原生确认框触发。网页 XSS 不能通过传一个“安装地址”获得本地执行能力。
8. 包内兜底页不开远程脚本，只有有限重试/打开固定官网能力。不得为了方便调试把任意 eval/原生对象长期注入线上页面。
9. 日志只记录错误分类、壳版本、WebView2版本、Windows版本和脱敏诊断ID；不记录正文、Cookie、Authorization、完整带查询参数URL。用户主动导出诊断，默认不上传。
10. 标准用户运行，不要求关闭 Defender、SmartScreen、UAC、系统沙箱或 TLS 检查。对宿主新增原生调用做定向攻击测试，而非只跑依赖扫描。

Tauri API未覆盖的 Windows 权限/浏览器进程故障回调，集中在一个 `windows_webview.rs` 适配模块，使用受支持 WebView2 API；不散布 unsafe/私有内核补丁。§10 的可行性阶段首先验证这里能否小范围完成。

## 8. 安装、更新与分发

### 8.1 安装包和运行时

- 官网先发 x64 NSIS `-setup.exe`，按当前用户安装；首版不同时维护 MSI、MSIX和便携版。公司部署或商店渠道后续另立需求。Tauri支持NSIS/WiX安装器，但要在Windows构建/验证。[Tauri Windows 安装器](https://v2.tauri.app/distribute/windows-installer/)
- 默认 WebView2 Evergreen：安装时检测，缺失则安装；网络条件一般的用户提供带官方 WebView2 离线安装器的增强包。两种包功能相同，不能把可离线安装宣传成可离线使用整站。
- 不采用 `skip` 假定每台电脑都有内核。运行时版本不足或被企业策略禁止更新时明确阻断不支持的能力，给出诊断，不静默失败。
- 不默认打包固定 WebView2：固定内核意味着自行承担安全更新和较大的分发体积。只有可行性探针确认必要才调整选型。
- appId、安装路径、数据目录、签名主体固定；升级安装保留资料。卸载默认保留本地草稿/配置，用户显式勾选后只清本应用数据目录，不删导出文件或共享 WebView2 Runtime。

### 8.2 签名与更新安全

两类签名不能混为一谈：

- **Windows Authenticode**：给应用/安装包签名并加可信时间戳，用于发布者身份与完整性；正式外部分发前办理。签名不能保证新应用立即没有 SmartScreen/杀软告警，不能让用户关闭防护。[Windows 代码签名](https://v2.tauri.app/distribute/sign/windows/)
- **Tauri updater 签名**：用于客户端验证更新包；公钥随客户端发布，私钥仅进入受控 CI 签名环境。HTTPS和SHA256不能代替这条验证链。[Tauri updater](https://v2.tauri.app/plugin/updater/)

更新约定：

1. 独立通道建议 `/download/windows/stable/latest.json`、`/download/windows/beta/latest.json`；版本产物放不可覆盖的 `/download/windows/<version>/`。不复用安卓清单。
2. 优先官方 updater 的签名包/manifest格式，不自创安装器协议。清单按架构选择，禁止把 x64/ARM64 包混发；仅HTTPS及固定分发源，每次重定向重新验证。
3. 先完成Windows文件签名，再对最终安装产物生成updater签名和摘要，最后发布manifest；不能签完后重新打包导致验签失败。更新包也可复制到国内HTTPS分发源，不要求中国用户一定能访问GitHub。
4. 启动后延迟检查、人工可主动检查；自动检查至多每24小时一次，失败退避，不每次路由切换检查。没有更新不打扰。
5. 普通更新只提示，不在编辑/录音/下载/任务操作时强制重启。安装前走保存握手和用户确认；未知保存状态宁可稍后安装。
6. 下载断开、签名错误、安装失败时保留现有可运行版与用户数据。不得在校验前卸载旧版或执行下载文件。
7. 有问题先撤下更新manifest并停止扩大分发；默认不绕过版本比较强制降级。发布一个更高版本的已知良好代码作为前滚恢复，并验证用户数据格式兼容。
8. 保留至少当前和前一稳定安装包、签名、构建SHA、测试报告；签名密钥轮换/丢失有恢复预案，私钥不进入仓库、安装包或普通构建日志。

### 8.3 网页与壳双版本兼容

- 远程网页更新不必重发壳，但**不能在用户编辑时自动强刷网页**；使用原站点加载/更新机制。
- 页面通过宿主能力检测使用桌面功能；旧壳没有某能力时保留普通Web路径，不能一更新网页就令旧客户端白屏。
- 首版没有桌面专属API合同，先复用现有接口。若未来需要最低壳版本，单独发布兼容元数据，不把业务登录失败伪装成强制升级。
- 测试“当前网页+旧壳”“旧网页缓存+新壳”“当前网页+新壳”；出包记录网页验收SHA和壳SHA，不能只记录一个产品版本号。

### 8.4 GitHub Release：代理必须完成的最后一公里

- 仓库固定为当前 origin 对应的 `Xcy8010/chevoink`，不另建仓库。标签用 `windows-v<semver>`，标题用 `Chevoink Windows <version>`，安装资产用 `Chevoink_<version>_x64-setup.exe`；实施时先查询现有标签，确定首个未占用版本，禁止覆盖已发布版本。
- 先将中文提交推送到 `chevoink-windows` 并通过对应 SHA 的 CI；网页变更经正常 PR/合并流程进入主线，不强推、不把过期 worktree 快照覆盖主线、不带入主工作区无关未提交文件。记录壳构建 SHA 与最终网页部署 SHA，合并后有变动必须重新验证相关产物。
- Windows 流水线先构建/测试，发布作业才获得最小 `contents: write` 和受保护签名环境。未受信任 PR 不接触密钥；禁止带密钥的 `pull_request_target` 检出运行 PR 代码。
- 固定完整提交 SHA 打标签并推送，确认标签在远端且指向已通过验证的提交；使用 `gh release create --verify-tag --draft --latest=false` 或等价受控 API 建草稿。版本/标签参数必须取自已核实值，不依赖默认分支 HEAD 自动造标签。[GitHub CLI Release 创建约定](https://cli.github.com/manual/gh_release_create)
- 上传最终 `.exe`、对应 updater `.sig`、`SHA256SUMS`、脱敏构建/验收摘要及可用的 SBOM；本地路径、测试账号、正文、密钥不进入说明或资产。中文说明写清系统/架构、安装和更新方法、真实限制。
- 上传后从 Release 下载同一资产，核对大小、SHA256、Authenticode 发布者和 updater 签名；安装冒烟使用这份下载件或已证实逐字节相同的产物。不能“本地包测试过”但线上上传另一份。
- 全部正式门禁通过后公开 Release，再发布官网版本目录与 Windows 稳定清单，最后开放网页入口。公开后匿名验证 Release 资产和官网下载；任何一项失败暂停扩大分发，保留旧稳定版本。
- **同仓安卓/Windows 不争用 GitHub 全局 Latest。** Windows Release 明确 `--latest=false`，客户端和网页使用平台独立清单选择最新稳定 Windows 版本；不改安卓 Release 标记，不使用 `/releases/latest/download/...`，不把预发布包混入稳定通道。
- 后续新版本沿用同一流程，更新 Windows 清单即可让设置入口指向最新包。正式版本不可覆盖；发布失败可续传缺失资产，但不得替换已公开且验收过的版本内容。

## 9. 文件级实施清单

### 9.1 新增壳工程：目标约20–28个手工维护文件

以下按职责创建，不把每个回调拆成一个文件。锁文件、生成的图标尺寸和编译产物不用于凑工程拆分数量。

| 建议路径 | 内容 |
| --- | --- |
| `desktop/windows/package.json`、`package-lock.json` | 独立Tauri CLI与兜底页工具链、构建/测试命令 |
| `desktop/windows/rust-toolchain.toml` | 固定Rust工具链 |
| `desktop/windows/src-tauri/Cargo.toml`、`Cargo.lock`、`build.rs` | 固定Tauri/插件、生成能力清单、自定义命令受控注册 |
| `desktop/windows/src-tauri/tauri.conf.json` | 标识、主窗口、远程URL、资源、安装及更新配置 |
| `desktop/windows/src-tauri/capabilities/{main,fallback}.json`、`permissions/desktop.toml` | 主窗口/兜底权限边界，只列实际使用权限 |
| `desktop/windows/src-tauri/src/{main,lib}.rs` | 平台入口与薄编排 |
| `desktop/windows/src-tauri/src/window.rs` | 单实例、标准窗口、几何状态与退出握手 |
| `desktop/windows/src-tauri/src/navigation.rs` | 精确origin、外链、popup、下载与文件名策略 |
| `desktop/windows/src-tauri/src/windows_webview.rs` | Windows权限/故障事件的有限平台适配 |
| `desktop/windows/src-tauri/src/update.rs` | 原生更新菜单、验证、重启前状态处理 |
| `desktop/windows/shell-ui/{index.html,main.ts,style.css}` | 包内启动/故障兜底，不包含业务页面副本 |
| `desktop/windows/src-tauri/tests/{policy,update}.rs` | 导航/权限/恶意参数、签名/中断/回退测试，位于Cargo默认集成测试目录 |
| `desktop/windows/tests/e2e/desktop.spec.ts`、`wdio.conf.ts` | 真实WebView2关键流程自动化 |
| `desktop/windows/README.md` | 本机开发、支持范围、打包、签名、排障 |
| `.github/workflows/windows-desktop.yml` | Windows独立测试/构建；签名发布需受保护环境 |
| `.github/workflows/ci.yml`（按需修改） | 确保 `chevoink-windows` 推送或对应 PR 触发根四闸；不能只有 main 推送通过便宣称桌面提交通过 |
| `docs/WINDOWS_DESKTOP.md` | 用户说明、发布与验收证据；实现后再写“已支持” |

图标复用品牌源资产生成ICO，不重新设计图标。若Tauri生成的配置要求另有文件，限于实际构建所需并说明；不新增与本次无关的runtime治理框架。

### 9.2 现有主项目：目标5–9个业务/入口文件，另有对应测试

| 路径 | 操作与限制 |
| --- | --- |
| `src/lib/desktop-app.ts`（新增） | Windows检测与两条窄桥接包装；非Windows恒为无副作用回退 |
| 根 `package.json`、`package-lock.json` | 如窄桥接需要SDK，仅引入官方 `@tauri-apps/api` 所需模块并按平台动态加载；不引入桌面CLI/打包依赖，不依赖 `__TAURI_INTERNALS__` 等私有对象 |
| `src/features/studio/platform-capabilities.ts` | 独立区分Android/Windows宿主能力，不将原Android native含义扩大 |
| `src/lib/auth-token.ts`、`src/store/useShellStore.ts` | Windows定向不落localStorage令牌；不改变Web/Android当前登录兼容逻辑 |
| `src/features/studio/components/use-chapter-persistence.ts` | 仅复用/暴露现有flush保存结果供退出握手；不改正文提交和审查规则 |
| `src/features/studio/agent/composer-drafts.ts` | 优先不改；确需退出确认时只暴露当前作用域是否已持久化，保留已有键 |
| `src/features/studio/lib/export-download.ts`、`src/lib/native-app.ts` | 仅在原生下载探针需要时加Windows外链/下载分支；不改安卓兼容分支 |
| `src/app/routes/SettingsPage.tsx`、`settings/client-os.tsx` | 按 §6.5 开放电脑网页入口/仅Windows选项；移动选项不变，复用原样式，壳内不重复下载自己 |
| `src/lib/windows-download.ts`、`tests/unit/windows-download.test.ts`（按需新增） | 小型清单解析/平台链接校验和失败测试；能在现有辅助模块内清楚实现则不另拆文件 |
| `tests/unit/settings-client-download.test.tsx`（新增或扩展现有设置测试） | 电脑/手机/两类壳、窄电脑窗口、选项切换、清单失败与准确下载地址 |
| `src/components/ui/UpdateBanner.tsx`、`src/lib/app-update.ts` | 原则上不改；以测试确保Windows不进入APK更新，而不是合并两套更新协议 |
| `src/features/studio/agent/useAgentStream.ts` | 原则上不改；仅真实WebView复现恢复缺陷时做范围明确的修复 |
| `tests/unit/task-drafts.test.ts`、`workspace-layout.test.tsx`、`agent-review-lifecycle.test.ts`、语音相关测试 | 扩展桌面宿主回归；新增desktop桥接/auth-token测试，不削减原用例 |
| `README.md`、`docs/ENGINEERING.md`及英文对应文件 | 通过验收后添加真实支持说明，不提前标Windows已上线 |

如果上述有条件修改全部触发，现有业务文件可能增至约12个，需在阶段结束说明实际原因。正常不修改数据库schema、Credits公式、模型、Agent执行工具、生产鉴权/CORS协议。

**总量预估：约30–40个手工代码/配置/测试/文档文件；真正涉及现有业务的改动保持在小范围。** 这不是40个大模块，主要是完整桌面安装、权限、发布与测试所需的小型文件。

## 10. Codex 独立执行顺序与时间控制

不再采用“工程师开发一周、交给测试再排期”的组织方式。执行主体是当前代理，按以下顺序一轮推进；时间用于预期管理，不作为跳过验收的理由。

| 阶段 | 代理直接完成的工作 | 阶段产物/结束条件 |
| --- | --- | --- |
| W0 一次预检与关键探针 | 核对 worktree/主线差异、项目规范、现有壳/设置能力；检查 Node/Rust/MSVC/WebView2、Windows CI、GitHub 写入权限、签名渠道和测试设备；最小壳集中验证登录、Blob、麦克风/WASM、IME、导航及 SSE | 一次列清真正阻塞；沿用本文选型和范围，给出环境实测后的剩余时间估计 |
| W1 集中实现 | 壳生命周期/权限/下载/保存握手/更新；网页平台检测及 Windows 下载入口；同时补针对性回归用例和构建流水线 | 完整可构建代码，不将登录/导出/语音等核心适配留作“后续再做”；不逐文件全仓审查 |
| W2 一次完整审查与验收 | 对照 §5–8/§11 审查全体差异；修发现的问题；根四闸与独立 Windows 检查在允许环境并行；实际 WebView2、安装更新、原网页和安卓回归 | 每项有结果/证据；失败修复后复跑相关验证，公共链路变动重跑受影响门禁，不反复跑无关检查 |
| W3 打包、推送与发布 | 中文提交推送；同 SHA CI；签名打包；Draft Release 上传并下载复核；公开 Release/官网 Windows 清单；网页变更进入主线、验证并部署下载入口 | 可安装 exe 的公开 Release 和可用网页下载按钮；线上抽检、文档及一次最终交付 |

**时间策略：**W0 目标在30–60分钟内完成首轮预检和关键探针；编译冷启动与设备准备单独报告。环境、证书、权限和设备齐备且无核心兼容故障时，以当天约6–12小时完成集中实现至发布为排程目标，W0后依据实际构建速度修正，不承诺未经验证的固定截止时间。外部审批/证书签发/缺失真机不计入可压缩的编码时间，也不被假装完成。

- 首次依赖下载/构建期间处理设置入口与测试；后续复用锁文件和 CI 缓存，签名始终针对最终产物。不得为赶时间跳过依赖固定、签名、保存退出或权限检查。
- 普通技术决策由代理在本文边界内完成，不逐项询问；必要外部条件一次汇总。阶段性进度只发过程消息，测试未结束继续等待同一进程。
- 不要求无依据的7天等待或额外长期 beta 排期；按真实验收证据决定发布，不以“等待结束”替代测试。首次版可在隔离环境生成较低测试版本验证升级，不能伪造已有线上旧版。
- 若真实探针证明 Tauri 必须依赖私有内核补丁或改变核心用户功能才能适配，停止扩大该实现，集中报告失败证据及 Electron 替代代价；选型改变属于有意义的范围调整，确认后只保留一个实现。不为跑分重新选型。

## 11. 产品级验收矩阵

### 11.1 设备与场景

至少2台真实设备：一台Windows 11常规电脑，一台Windows 10 22H2低配/8GB设备；干净安装/缺WebView2可用隔离VM补充。覆盖1366×768、1920×1080、2560×1440，100–200%DPI，双显示器切换、触控板与鼠标。

Windows 10兼容不等于系统继续享有完整安全支持。微软目前说明Edge/WebView2在Windows 10 22H2至少更新至2028年10月，这与Windows自身安全补丁资格是两回事；官网推荐受支持且更新的Windows 11，Windows 10用户单独提示其系统风险。[Microsoft Edge 生命周期](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-support-lifecycle)

| 验收项 | 必须通过 |
| --- | --- |
| 安装 | 标准用户首次安装；缺内核的在线/离线安装；中文/空格用户名；安装失败有可恢复提示 |
| 原界面 | 同CSS视口的Edge与桌面壳截图对照；业务按钮、计数、工具动画、胶囊、折叠逻辑一致；除授权的电脑设置下载入口外，差异仅原生窗口外框/系统对话框 |
| 设置下载 | 电脑网页仅 Windows，窄窗口仍正确；手机原选项与 APK 不变；壳不重复安装自己；最新稳定版本、直链、错误反馈正确 |
| Release | 标签对应已验证 SHA；公开下载 exe 与验收件摘要相同、签名有效；Windows 更新不依赖全仓 Latest，不影响 Android |
| 登录 | 登录、重开、杀进程重开、Cookie续期、过期重登、注销；无桌面新增明文长期令牌 |
| 草稿/审查 | 同作品A→B→A、跨作品、分栏宽度、关闭重开、更新后恢复；待审查状态不被自动处理 |
| 编辑保存 | 防抖最后输入、保存进行中退出、网络失败取消退出；不将未保存报告为已保存 |
| Agent | 正文参数流开始即见原工具卡及原进度；执行/结果同一卡；暂停有反馈；重连不重复事件/执行/扣费 |
| 前后台 | 最小化10分钟、睡眠恢复、网络断开/恢复；重开后恢复同一run，不能暗发“继续” |
| 输入 | 中文IME候选、换行、选择/剪切/粘贴、引用/附件、语音插入撤销，均不误发送 |
| 布局 | 贴靠半屏、高DPI、多屏拖动、缩到窄窗口，输入框/菜单/查看器按钮不溢出、不在屏外恢复 |
| 导出 | 当前支持的正文/作品格式、Blob与临时链接、中文长文件名、取消/重名/磁盘不足，文件完整且可找到 |
| 声音 | 首次麦克风同意/拒绝、系统禁麦、模型下载中断/删除、切任务取消、本机转写；TTS最小化/锁屏/连续切章 |
| 安全 | 外域/子域欺骗、非HTTPS导航、恶意popup/协议、文件路径穿越、伪造IPC及frame来源均失败；无任意原生权限 |
| 更新 | 旧→新、当前网页+旧壳、错架构/坏签名/下载中断/安装失败、用户稍后安装；原版/资料仍可恢复 |
| 不退化 | 网页与Android的登录、下载、APK检测更新、录音/阅读沉浸、原任务UI通过原回归 |

### 11.2 性能目标（待实测，不是现有成绩）

固定设备、网络、WebView2版本与测试任务后分别测量，进程资源统计包含宿主和所有WebView2子进程：

- 本地启动/故障UI可见P95目标≤1秒；标准网络（20Mbps、100ms RTT、服务端正常）下主页面可交互P95目标≤4秒。区分壳耗时和网站/网络耗时。
- 不录音、不播放、不跑任务时空闲CPU中位数目标≤1%；空白壳/首页/大型创作区/语音模型分别记录内存，不将语音模型占用算成壳基础占用。
- 与同机同内核Edge、同工作区对照，输入和分栏拖动P95目标不回退超过10%；可见输入延迟目标≤50ms。达不到时定位宿主回调/页面/驱动原因，不为了过线删功能或关闭动画。
- 参数流/消息输出连续30分钟，无随每次重连不断增长的监听器/窗口/Worker数量；录音取消释放资源。
- 至少30次冷热启动取样、10轮窗口缩放/任务切换、一次60分钟Agent/听书耐久测试。AI生成耗时和服务端模型Token不计作壳性能收益。

自动化采用真实Windows程序 + tauri-driver/匹配的Edge Driver；浏览器Playwright/DOM测试只作补充，不能替代Windows宿主、安装器、权限与多屏人工验收。[Tauri WebDriver 测试](https://v2.tauri.app/develop/tests/webdriver/)

## 12. 门禁、发布和运维

实施完成后统一审查，再按顺序执行：

1. 对照本文检查原界面/功能、任务作用域、原生权限和敏感资料无回归；业务修改集中复查。
2. 根项目四闸：`npm run check` → `npm run lint` → `npx vitest run --coverage` → `npm run build`。集成测试只用经校验的隔离数据库，遵守用户指定的执行环境。
3. Windows独立闸：锁文件安装、前端兜底页检查；在 `desktop/windows/src-tauri/` 执行 `cargo fmt --all -- --check`、`cargo clippy --locked --all-targets -- -D warnings`、`cargo test --locked`；再做依赖/许可证审计、release构建、真实WebView2 E2E。root四闸不代表Rust已测。
4. 安装/更新/签名/权限人工场景验收与故障复测。Windows代码签名和updater验签均可验证，扫描无高危可达漏洞；例外必须书面评估，不能关闭检查。
5. 使用简短中文commit，例如“新增Windows客户端与桌面下载入口”；推送后同SHA CI成功。按 §8.4 签名、创建平台标签、上传 Draft Release、重新下载验证；密钥只在受保护环境可用。生成版本/摘要/签名/SBOM/测试证据。
6. 验收通过后公开 Windows Release，先上传官网不可变产物、最后更新manifest。网页适配按正常合并/主线CI与授权部署流程发布，确认包可用才开放下载入口；不能只上传 CI artifact 就收尾。**仅发壳包不重启后端**；若网站部署流程确需中断线上任务，遵守该次部署的有效授权，不把历史中断许可视为无限授权。
7. 从公开入口下载抽检，复核签名、壳版本、WebView2版本、升级及手机APK入口。README/工程文档和发布说明记录真实支持范围；文档提交亦使用中文，不把未提交的描述当作已发布文件。
8. 最终回复一次给出 Release 页、exe直链、版本/提交、四闸和Windows验收结果、网页入口部署状态、剩余边界。只有全部合同完成或确需外部输入才能收尾；不要要求用户自行编译/上传原本由代理可完成的步骤。

运维最低要求：记录兼容WebView2范围并定期用最新Evergreen验证；关注Tauri/WebView2/安装器的安全公告，安全修复安排重发壳。签名/域名/CDN证书临期提醒；更新失败率、首启失败率和崩溃记录须脱敏且有用户隐私说明。原生问题不能只看后端API健康检查。

## 13. 自主执行与真正的外部阻塞

W0 先自行检查已有配置、工具和授权，只检查凭据可用性/证书元数据，不打印私钥、token 或生产正文。能用现有工具、Windows CI 和隔离测试环境完成的步骤不转交用户；不能为“独立完成”假设拥有不存在的证书或测试设备。

- 已有 GitHub 发布权限、服务器部署权限、受保护签名环境可用时，用户明确启动本方案的实现/发布后直接按流程执行，不为普通命令反复确认，也不绕过环境审批或分支保护。
- 缺 Authenticode 主体/证书、updater 密钥或发布权限时一次汇总所缺输入；不自行购买、不弱化验签。先继续不依赖该条件的实现和验证。未签名包只能作为清楚标记的内部构建或草稿资产；对外发布未签名测试版需另获明确同意，不自动冒充正式版。
- 真机/权限交互可由可用的受控 Windows 环境验证；不能拿 Chrome 测试或 CI 虚拟机结果冒充两台真实设备。如果 §11 设备条件无法满足，列出具体缺口，不能声称已完成全部兼容验收。
- 下载路径默认按 §8、首版 x64、标准标题栏、当前官网域名，不把这些已确定事项重新变成选择题。增强安装包复用同一构建配置，不另做离线业务。
- 测试使用隔离账号/数据；不拿真实作者正文做破坏性测试，不在生产数据库跑测试。遵守用户指定的本地/CI执行限制；必要新权限一次说明，不私自修改安全策略。

真正受阻时清楚交代“已完成、缺什么、阻塞哪一步”；可以保留已验证构建和草稿 Release，但最终正式发布合同仍未完成。本文准备阶段不实际安装工具链、创建 Release 或部署。

## 14. 最终执行原则

由 Codex 一次预检、集中实现、统一审查、双侧门禁、签名打包、推送发布、公开下载复核，连续完成。**复用网页不等于只写一个loadURL；产品级也不等于重造桌面平台。** 最终交付是保持原Chevoink体验的Windows客户端、Release里的可安装exe，以及电脑网页设置中仅Windows的可用下载入口，而不是停在方案、源码或“请自行打包”。

## 15. 2026-09-10 对照复核与剩余交付

### 已确认

用户确认本机 1.0.2：首次启动前新快捷图标、无错误断网/全屏询问、空闲关闭、重开登录/草稿/待审保留均通过；写作、上传导出、语音、听书无异常。按用户验收记录，不等同于所有故障场景或性能测试。

本轮实查两种 1.0.2 CI 安装包摘要与工程记录相符，Authenticode 均为 NotSigned；GitHub 只有 Windows 1.0.0 撤回草稿，没有正式稳定 Release。壳构建 f82e423a1193c061972b2b6869bb90a1154f6bb6 的 Windows CI 成功。主线已有壳与网页能力，不需要重新初始化仓库或重做客户端。

### 本轮补齐

- 主线与 Windows worktree 的工程记录更新为准确版本和上述用户验收，保留历史调查，不将历史失败作为当前未测。
- 增加只读 verify-installer.ps1：检查约定安装包名称、产品版本、可信 SHA256、预期签名证书指纹、有效 Authenticode 及时间戳；未签名/错误摘要/错误版本三条拒绝路径已用内部包验证。尚无正式签名包，成功签名路径未验收；该脚本不代替完整发布流水线或 updater 验签。
- Windows 下载、设置平台分流、退出保存、启动故障页共 4 文件 41 项定向回归通过。未运行本轮完整四闸/新提交 CI，不将定向测试当作正式发布通过。
- 明确首个签名版升级路径：现有无 updater 公钥的 1.0.2 必须手动安装新版本一次，再验收自动更新。

### 尚未完成，不能标绿

| 顺序 | 剩余项 | 条件/下一步 |
| --- | --- | --- |
| 1 | Authenticode 与 updater 密钥 | SignPath 要求补公开声誉/使用材料，未获批准；先确认签名渠道与受保护密钥配置，不传私钥到聊天 |
| 2 | 正式签名构建/发布作业、完整 SBOM | 渠道确定后接入受保护 CI，对最终字节签名；使用新版本，不覆盖候选产物 |
| 3 | 真 WebView2 E2E、更新故障/宿主攻击/卸载清理 | 补隔离场景，不能用网页 DOM 或 30 秒窗口存活替代 |
| 4 | Win10 22H2、DPI/多屏、缺内核安装 | 当前只有 Win11；Win10 兼容结论等待真实设备，不自行删掉方案验收要求 |
| 5 | 启动/输入性能、60 分钟耐久 | 尚无完整量化样本，维持原目标，不宣称达标 |
| 6 | 正式 Release、官网镜像与稳定清单 | 前置签名/验收完成后草稿回下载核验，发布时 latest=false，最后开放可用下载入口 |

本轮没有重新构建、推送、公开安装包、部署或改动线上任务。正式交付仍受以上条件限制；原 UI、Agent、计费、Android 分支/下载均未修改。详细证据及执行命令见 docs/WINDOWS_DESKTOP.md。

## 16. 用户调整：先发布未签名手动更新测试版

用户明确暂缓 SignPath 批准、签名配置及自动更新，要求完成其它可执行工作后推送部署并创建 Windows 安装包 Release。该授权允许未签名预发布，不等同于正式签名验收或自动更新验收。

当前版本推进到 1.0.3；网页使用独立 manual 清单，标识 preview/signed=false/SHA256，下载前提示限制；原生 stable 签名通道不写入未签名包。无公钥不启动后台检查。发布 ordinary/offline-runtime 两包、SHA256SUMS、目标范围 SBOM 和验证说明，以 prerelease、latest=false 发布，不干扰 Android。

根四闸、Windows fmt/clippy/test/audit、安装路径/图标/已安装 WebView2 故障页与导航/关闭回归均作为本轮门禁。缺少设备的 Win10、多屏完整矩阵、缺内核真机及完整耐久/攻击/卸载验收仍明确未覆盖，不用 CI 模拟冒充真机通过。部署只改前端与下载静态资产，不重启业务 API。

交付结果：windows-v1.0.3 已公开为未签名 prerelease，构建 SHA 为 820334074b638ce54638b911d8ca37b850f1f424；根 CI 34466772785（2074 项零跳过）、Windows CI 34466772814 均成功。普通/增强安装包、SHA256SUMS、许可证清单、目标范围 CycloneDX SBOM 已上传并从 Release 回下载核对。官网同摘要版本目录与 manual/latest.json 已启用；普通包 GitHub/官网匿名全量下载摘要匹配。前端同 SHA 部署成功、API 进程不变；Android 与全仓 Latest v1.51 保留。文档交付记录另以 ad3307f 推送主线，不改变发布包构建 SHA。

Release：https://github.com/Xcy8010/chevoink/releases/tag/windows-v1.0.3 。未覆盖设备/故障/耐久场景和本阶段暂缓的签名/自动更新仍保留，不将本预发布当作原方案正式稳定版全部完成。
