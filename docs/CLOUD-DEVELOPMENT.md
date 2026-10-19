# 云端开发与交付

这些入口把开发、Android 构建和已测试 Web 提交的部署移到远程机器。它们不创建账号、上传密钥、发布 APK、修改生产权限或自动购买资源。代码落地不等于云端已经配置或上线。

## 开工与交付前的 Git 同步

Windows 本地与 Linux 云端遵循同一份[安全 Git 同步规则](./GIT-SYNC.md)，由仓库 `AGENTS.md` 和开发规范引导读取。检查当前 checkout、上游、全部未提交/未跟踪改动及未完成 merge/rebase 后，fetch 对应远端；仅干净且仅落后时按规则快进，不自动整合分叉或跨业务分支合并。不同任务的工作区彼此独立；GitHub 是交换点，电脑离线时无法检查其未推送工作。

此约定通过任务读取规范生效，未安装强制 hook，不保证永不冲突。只更新这些文档不需要修改 `scripts/cloud-setup.mjs` 或交付工作流；setup 仍只准备依赖。云端需要取得含规则的已推送提交，旧任务需重新读取当前 checkout 的入口和规则。若环境的启动指令、固定源提交或缓存仍绑定旧规范，先核查实际配置和安装结果，再按授权刷新或重新发布；本规范不触发 setup、环境重新发布或另建任务。

## 开发环境

ChatGPT 网页的当前入口是[设置 → Codex 云端 → 环境](https://chatgpt.com/settings/codex-cloud)中的“创建环境”；本次在 Edge 已实际定位该页面，GitHub 已连接，只选择 `Xcy8010/Chevoink`。旧 `/codex/settings/environments` 和 `/codex/cloud/settings/environments` 在本次账号中会跳回首页，不作为推荐入口。当前[官方云环境指南](https://learn.chatgpt.com/docs/environments/cloud-environments)说明创建、安装报告审查和发布流程；旧的单数 `cloud-environment` 文档适用于 Legacy 的 Code Review / Linear / GitHub 集成。

本次用户已明确批准仅用于环境配置的“设置 Chevoink”会话（`01a14e41-339d-71b1-8e47-8a042e1c8031`）；环境已保留草稿，尚未发布。Prisma 下载域名 `binaries.prisma.sh` 的 HTTP403 由该配置会话处理，需应用网络配置后再验证安装结果；这不授权配置、重置或迁移数据库，也不授权自动另建开发任务。

配置时指定默认开发分支 `main`，先读取仓库 `AGENTS.md`；Android 原生工作明确选择 `android-shell`，不把另一分支的原生代码混入 Web main。要求安装固定 Node **22.23.2 / npm 10.9.8**，执行下列维护 setup，生成 Prisma Client，禁止自动配置、重置或迁移数据库。安装过程中不提供生产 SSH、签名证书或作者模型凭证。发布环境前审查实际安装命令、结果、配置和未完成项；环境发布、创建开发任务和代码发布是不同操作，不自动另建任务。

后续由用户在 GitHub 触发并批准构建/部署，生产和签名凭据留在受保护 GitHub environment，云端开发 agent 无需取得它们。完整真实 PostgreSQL 发布检查继续由原 CI 提供，安装报告不能替代同 SHA 发布证据。

在自己的远程开发机克隆 `Xcy8010/Chevoink` 的 `main`，通过远程编辑器或 SSH 编辑。使用仓库 `.node-version` 与 `package.json` 固定的 Node **22.23.2 / npm 10.9.8**；不要复制本机 `node_modules`、`.env`、`.ssh`、Android keystore 或生产数据库。Windows、Linux、macOS 都可运行：

```sh
node scripts/cloud-setup.mjs
node scripts/cloud-setup.mjs --install
```

第一条只校验版本；第二条执行 `npm ci`、原 `runtime:verify` 和已安装 Prisma CLI 的 `generate`。入口不会升级锁文件、配置数据库、迁移、重置或导入数据。安装依赖仍会运行仓库原有 npm 生命周期脚本，应仅对已审查来源执行。应用运行环境按仓库 `.env.example` 配置自己的开发凭证；不要把生产 env 复制进云端开发环境。

完整数据库测试必须提供**明确隔离的 PostgreSQL** 和 `TEST_DATABASE_REQUIRED=true`，并按 `tests/.env.test.example`、`npm run test:db:verify` 的约束准备账号。迁移属于显式开发步骤，不由 setup 自动执行。不提供数据库时只能做限定检查，不能把缺失或跳过的集成测试记为发布通过。

发布仍以原始 `.github/workflows/ci.yml` 对完整提交的结果为准：固定 Node/npm、实际 PostgreSQL、最小权限测试角色、全部动态分片与零跳过回执、原覆盖率门槛 statements/lines 30、branches 73、functions 52，以及类型、lint、build、eval 和双 audit。云端脚本不替换这些门禁。

## Windows 与 Android 构建

Windows 继续使用主仓库已有 `Windows Desktop` 工作流（`desktop/windows/` 的当前 1.0.4 实现）。不要为云构建合并另一个旧的 Windows 1.0.2 分支，也不要把内部未签名安装包当作公开签名发布。

Android 使用新增 `Cloud Android Build`，GitHub 托管的 `windows-2022`、Node 22.23.2、JDK21、Android36/build-tools36.0.0。两处分支保留相同工作流定义，但入口仅接受 `main` dispatch；构建源另用完整 `source_sha` 指定。只在 `android-shell` 增加 dispatch 文件不足以保证默认分支上的入口可发现。[GitHub 手动工作流规则](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_dispatch)

SDK 初始化显式设置 `setup-android` 的 `packages: platform-tools`，随后单独安装 `platforms;android-36` 与 `build-tools;36.0.0`。该 action 的默认包列表包含 `tools`；首次云构建 `39112766527` 已在安装此不可用包时失败，尚未进入签名。此修正不改变许可证、审批、签名或重试策略。[官方 packages 输入](https://github.com/android-actions/setup-android/blob/v3/action.yml)

先将 Android helper/工作流提交到 `android-shell`，再将主仓库的入口提交到 `main`；维护者审查后分别推送。两处工作流文件保持一致。通过 GitHub Actions 页面选择 `main`，输入包含 helper 的已审查 Android 完整 SHA；也可以显式执行：

```powershell
$androidSha = '替换为40位android-shell提交SHA'
gh workflow run cloud-android.yml --repo Xcy8010/Chevoink --ref main -f source_sha=$androidSha
```

这会申请 `android-signing` 环境批准。工作流先将本次 `github.sha` 的可信 main 控制代码检出到 `controller/`；其中 `cloud-android-guard.mjs` 核验控制代码 HEAD、首次 main dispatch、环境 required reviewers 和本次实际人工审批，再通过官方仓库 branch / compare API 将候选完整 SHA 绑定到 `android-shell` 的固定头 SHA，要求候选就是 merge base、无落后提交。API 不可读、来源/审批不符或重跑 attempt 都会拒绝。[GitHub 提交比较 API](https://docs.github.com/en/rest/commits/commits#compare-two-commits)

只有该独立校验通过后，才把精确候选检出到另一目录 `android/`，再次核对 checkout HEAD，再执行候选测试与构建脚本。候选 helper 的自检只是附加保护，不能证明自身可信。审批人需审查输入候选及签名构建代码；官方分支归属不能代替代码审查。构建继续复用 `prepare-android-source.ps1 -InstallDependencies` 与 `build-android-release.ps1 -AllowDependencyNetwork`。不修改原生源码/版本，不创建替代签名证书。

维护者需预先配置 `android-signing` 环境，只允许 `main`，设置 required reviewers，再在该环境中存放以下 **environment secrets**：

| 名称 | 内容 |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | 既有发布 keystore 的 Base64；编码不等于加密 |
| `ANDROID_STORE_PASSWORD` | 原 store password |
| `ANDROID_KEY_ALIAS` | 原 alias |
| `ANDROID_KEY_PASSWORD` | 原 key password |

环境变量 `ANDROID_BASELINE_APK_URL` 默认建议设置为 `https://chevoink.chevolink.com/download/chevoink-v1.0.5.1.apk`。2026-10-18 已只读核验生产历史文件 `/var/www/chevoink/download/chevoink-v1.0.5.1.apk` 的 SHA256，精确为 `9b2f2f8505c330dca2ea1801bed359843b75ba60895e03ab9c95d1926bbfc1fc`，与维护构建脚本要求一致；GitHub runner 对该公开 URL 的实际下载尚未执行。白名单仅允许这个精确官网地址，或本仓库官方 GitHub Release 的 APK 地址，不接受任意官网路径、查询参数或片段。下载后仍强制核对该原始摘要和发布证书，不能用最新版 APK 替代；若 runner 无法取得基线，先解决前置条件，不能关闭校验。

临时 keystore / properties 使用限制 ACL，正常成功或失败时删除；runner 的强制终止仍依赖 GitHub 托管临时机器销毁。不能改成长期共享 runner 而不另行审查清理与隔离。构建强制比对发布证书 `558a98608deab1e68ee26c9188821766516b4aee59186a9beb371212787fb21d`、包名/版本/UA、zipalign，并运行现有 JVM 测试。上传白名单只有最终 APK 与无密钥 `build-receipt.json`，保留7天；不上传整个工作区、日志、Gradle 缓存或 signing 配置。

构建不会创建 Release、标签、更新网站下载文件或发布版本。当前 1.0.11 已发布并获用户验收；重新构建相同源码不代表再次发布。真机/OEM验收仍独立于 JVM 测试和签名成功。

## 精确 SHA 的生产 Web 部署

`Cloud Production Deployment` 监听main固定 `.github/production-request.json` 的push；普通源码push不会进入生产流程。已测候选C与请求提交R分离：C..R只能改变请求文件，执行与归档均使用通过原完整CI的C。先人工批准inspect获得实际B，再用新的明确C/B请求人工批准deploy；准入与执行均严格核对B，不自动覆盖基线。详见[生产操作与恢复](./CLOUD-DEVELOPMENT-OPERATIONS.md)中的独立审批前核验与未知结果规则。

开始前需完成生产环境保护、严格 known_hosts 和原 SSH key 的配置；本次实现未执行这些账号操作，也未运行任何生产部署。

## 本地确定性检查

```powershell
node --test scripts/cloud-delivery.test.mjs
# 在 Android checkout 中执行
./scripts/cloud-build-android.Tests.ps1
```

它们覆盖版本漂移、错误 SHA/来源/事件、重复 attempt、缺失/绕过/错误环境审批、原 CI 身份和签名 properties 序列化；不连接数据库、不签名、不部署。云端实际构建、真实环境审批、SSH网络可达性和完整CI需在配置完成后分别留证。
