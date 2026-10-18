# 云端开发与交付

这些入口把开发、Android 构建和已测试 Web 提交的部署移到远程机器。它们不创建账号、上传密钥、发布 APK、修改生产权限或自动购买资源。代码落地不等于云端已经配置或上线。

## 开发环境

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

新增 `Cloud Production Deployment` 为手动入口，参见 [生产操作与恢复](./CLOUD-DEVELOPMENT-OPERATIONS.md)。只能从 `main` 首次 dispatch，`source_sha` 必须等于本次工作流源 SHA；不能用一个工作流提交部署另一个未经绑定的源目录。若 main 已前进，重新确认目标提交与相应 CI，或对 main 做经过审查的前向修复/回退提交并等待其完整 CI。

开始前需完成生产环境保护、严格 known_hosts 和原 SSH key 的配置；本次实现未执行这些账号操作，也未运行任何生产部署。

## 本地确定性检查

```powershell
node --test scripts/cloud-delivery.test.mjs
# 在 Android checkout 中执行
./scripts/cloud-build-android.Tests.ps1
```

它们覆盖版本漂移、错误 SHA/来源/事件、重复 attempt、缺失/绕过/错误环境审批、原 CI 身份和签名 properties 序列化；不连接数据库、不签名、不部署。云端实际构建、真实环境审批、SSH网络可达性和完整CI需在配置完成后分别留证。
