# 开工同步与离线检查 / Opening sync and offline checks

在当前 Chevoink checkout 的仓库根目录运行。先按 `.node-version` 与 `package.json` 使用 **Node 22.23.2 / npm 10.9.8**，并确保当前 checkout 的规则和脚本来自已审查版本。入口只执行一次检查，随后退出；不安装后台服务，也不在断网恢复后自行重试。agent 开工仍须读取 `AGENTS.md` 和 [Git 同步规则](./GIT-SYNC.md)。

```sh
node scripts/start-work.mjs
node scripts/start-work.mjs --offline
node scripts/offline-readiness.mjs
```

依次是：联网核对并在安全条件下快进、明确离线开工、仅检查本地准备情况。等价 npm 入口为 `npm run work:start`、`npm run work:offline`、`npm run work:check`。

Windows PowerShell 在仓库根目录也可运行 `node .\scripts\start-work.mjs` 或 `node .\scripts\start-work.mjs --offline`。可选包装入口为 `.\scripts\start-work.ps1` 和 `.\scripts\start-work.ps1 -Offline`；如果现有执行策略阻止 `.ps1`，使用直接 Node 入口，不修改执行策略。Linux/macOS 使用上面的正斜线路径。脚本从自身位置确定 checkout，不依赖另一台机器的绝对路径。

## 联网时的行为

- 先检查固定 Node/npm；版本不匹配时不进入 Git 同步。快进后重新检查本地准备，避免把更新前的依赖或 schema 状态当作更新后的结果。
- 检查实际根目录、HEAD、分支、上游、暂存/未暂存/未跟踪及未合并状态，并通过 Git 解析未完成操作和锁文件路径，兼容 linked worktree。
- 默认只接受 `Xcy8010/Chevoink` 的 GitHub HTTPS/SSH 远端，以及与当前本地分支**同名**的明确跟踪分支；不自动修改 origin 或上游。脏状态、冲突、detached HEAD、操作未结束或未知来源均停止自动同步，通常不执行 fetch。
- 只 fetch 一次，不递归获取 submodule、不获取 tag、不强制覆盖改写的跟踪引用。成功后比较本地 HEAD 与本次取得的精确 SHA；相同则退出，仅领先或分叉则报告人工处理。只有干净且严格落后才执行一次 `merge --ff-only --no-autostash`，并重新检查结果。
- 检测到配置的 clean/smudge/process 过滤器、`post-merge` 或 `reference-transaction` hook 时，先停止，避免状态检查、fetch 或快进执行这些命令；保留现有配置。此时 `dirty: null` 表示没有执行内容状态检查，不能解读为干净。
- fetch 前后以及快进前后检查工作区和远端配置变化。每个子命令默认限时 15 秒，并限制输出；超时、认证/权限失败或网络不可达均不声称最新。原始远端错误、凭据和文件内容不写入报告。
- 快进失败或超时返回 `merge_outcome_needs_review`，仅观察当前状态，不重放、不自动回滚。fetch 超时后也须在下一次操作前核对实际 Git 状态。不要同时在同一个 checkout 运行编辑器同步、其他 Git 写操作或第二个开工入口；前后检查不能提供跨进程的原子锁保证。

不会自动 stash/reset/clean/rebase、解决冲突、提交或推送。不会合并 `main`、`android-shell` 和历史 Windows 分支，也不会启动应用、数据库或模型。同步只覆盖当前可访问 checkout 与 fetch 时点的远端，不能核对离线 XCY 的未推送工作。

## 离线准备与限制

首次准备须在联网、来源已审查且依赖安装已获授权时，在**目标电脑本身**运行已有入口：

```sh
node scripts/cloud-setup.mjs --install
```

这会执行锁定的 `npm ci`、运行时核验和 Prisma Client 生成；安装会运行仓库原有生命周期脚本。准备应在断网前完成。不要跨操作系统复制 `node_modules`，也不要为此复制生产 `.env`、密钥、数据库或用户作品。离线入口不尝试安装、下载、修复或生成文件；如果代码、锁文件、运行时或依赖发生变化，需要联网另行准备。

本地检查只读源码入口、版本文件、锁文件、现有依赖安装元数据及 `npm ls --offline --ignore-scripts` 的依赖树，并静态比对已生成 Prisma schema、入口和当前操作系统的引擎文件。`readyForLocalChecks: true` 仅表示这些限定条件满足；它不执行原生引擎、不验证 ABI/架构兼容、不运行应用，也不代表完整测试、Windows 真机或发布验收通过。

数据库始终返回 `verified: false`、`readyForDatabaseWork: false`。配置存在不等于隔离已验证。需要数据库的工作须另行明确配置隔离 PostgreSQL，再按 `tests/.env.test.example` 和现有 `npm run test:db:verify` 的 URL/角色限制核验；该核验会连接指定数据库，开工入口不会替你执行。不得用生产库、真实小说数据或复制的生产凭据补足前置条件，不自动 reset/migrate/provision。

`--offline` 完全跳过 fetch/merge，明确报告“未确认最新：本地快照”，并继续本地准备检查。联网入口失败不会假装同步成功或自动切换离线；若选择继续不依赖最新远端的本地工作，再明确运行离线入口。离线准备不使 ChatGPT 云任务、GitHub、云模型、联网功能或依赖数据库的完整网站在断网时可用。

| 退出码 | 含义 |
| --- | --- |
| `0` | 联网核对成功，且限定本地检查通过；数据库仍未验证 |
| `1` | 同步被阻塞、失败或本地准备不足；查看报告，不自动修复 |
| `2` | 明确离线，只能使用未确认新旧的本地快照；同时查看准备检查中的问题 |

仅检查入口 `offline-readiness.mjs` 通过返回 `0`，不足返回 `1`；它从不证明远端同步。这里提供操作入口，不会自动安装到 XCY 的开机、终端配置或旧任务中。

## English

Run the three commands above from the actual reviewed checkout using pinned Node **22.23.2 / npm 10.9.8**. `start-work.mjs` performs one online opening check; `--offline` explicitly skips fetch/merge; `offline-readiness.mjs` only inspects local prerequisites. The npm aliases are `work:start`, `work:offline` and `work:check`. On Windows, direct Node commands work without changing PowerShell policy; the optional `.ps1` wrapper accepts `-Offline`. No background service, reconnect retry or automatic XCY configuration is installed.

The online path requires matching pinned Node/npm before Git synchronization and repeats readiness after a fast-forward. It checks checkout identity, branch/upstream, staged/unstaged/untracked/unmerged work and resolved Git operation markers/locks, including linked worktrees. It accepts only this project's GitHub HTTPS/SSH remote and an explicit same-name upstream. Dirty, conflicted, detached, unfinished or unknown state blocks synchronization. Configured clean/smudge/process filters and post-merge/reference-transaction hooks block before status/fetch/merge can execute them; existing settings are preserved and `dirty: null` means content status was not inspected.

It fetches once without tags, recursive submodules or a force refspec. Equal needs no merge; ahead/diverged requires manual handling. Only clean, strictly behind state permits one `merge --ff-only --no-autostash` to the exact fetched SHA, followed by verification. It rechecks checkout/remote configuration around the operation. Commands have a default 15-second timeout and bounded output; authentication, access and network failures never establish freshness. Raw remote diagnostics, credentials and file contents are omitted. A failed/timed-out merge needs manual outcome review and is never replayed or rolled back automatically; inspect actual Git state before retrying a timed-out fetch too. Avoid concurrent Git writers: these checks are not an atomic interprocess lock.

There is no automatic stash/reset/clean/rebase, conflict resolution, commit, push, business-branch merge, app startup, database operation or model call. A fresh fetch is time-bound evidence for this accessible checkout, not proof of another offline computer's state.

Prepare the target computer while online, only with authorized installation of reviewed code, using the existing `node scripts/cloud-setup.mjs --install`. This installs locked dependencies (including existing lifecycle scripts), checks runtime and generates Prisma; it does not provision/migrate a database. Do not copy cross-platform `node_modules`, production env/secrets/databases or user content. Changed code, locks, runtime or dependencies can require fresh authorized online preparation.

Readiness inspects source/version/lock metadata, the installed lock and offline npm dependency tree, and static generated Prisma schema/entry/platform-engine files. It does not import the app or Prisma, execute the engine, read env files, connect to a database, download, install or start anything. `readyForLocalChecks` is limited prerequisite evidence, not ABI/architecture, app, full-test, device or release acceptance. Database verification always remains false. Database work requires separately authorized isolated PostgreSQL configuration and the existing URL/role guard in `npm run test:db:verify`, which connects only when explicitly invoked. No production or real manuscript data may substitute for this isolation.

Online success plus limited local readiness returns `0`; blocked/failed/not-ready returns `1`; explicit offline snapshot returns `2`, even if its readiness report contains problems. Check-only returns `0`/`1` without establishing remote freshness. A failed online check offers `--offline` as a deliberate choice, never silently marks cached refs current. Offline prerequisites do not make ChatGPT cloud tasks, GitHub, cloud models, network features or the complete database-dependent website available offline.
