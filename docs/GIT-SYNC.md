# 安全 Git 同步 / Safe Git synchronization

本规则适用于 Windows 本地与 Linux 云端任务；中英文含义一致。它是 agent 读取后执行的开发约定，不是已安装的强制 hook，也不保证永不冲突。同步检查不授予无关提交、推送、合并、原生发布或部署权限。

## 中文

可使用一次性的[开工同步与离线检查入口](./START-WORK.md)：`node scripts/start-work.mjs`。入口实现下面的保守快进检查；明确离线使用 `--offline`，仅查本地准备使用 `node scripts/offline-readiness.mjs`。它不会自动安装为 hook、后台服务或操作另一台电脑，也不代替当前操作授权。

### 开工与交付前检查

1. 每次实质开发前，在**当前任务实际工作目录**确认仓库根目录、Git 目录、HEAD、分支、上游及对应 GitHub 远端。核对仓库身份，区分任务分支、开发基线和发布目标；不使用另一台机器的绝对路径，不把另一个 checkout 当作当前任务。输出远端信息时隐去 URL 中的凭据。
2. 检查已暂存、未暂存、未跟踪文件与未合并项，并检查 Git 目录中的 `MERGE_HEAD`、`rebase-merge`、`rebase-apply`；未完成的 cherry-pick/revert 也视为阻塞。未跟踪项不能省略；不能为了得到“干净”状态自动忽略、暂存、删除或搬走私人文件。
3. 确认远端及分支后 fetch 对应 GitHub 远端，成功后比较当前 HEAD 与目标上游的 ahead/behind。fetch 只更新 Git 元数据，不等于合并，也不证明工作区或其他设备已同步。fetch 失败时停止自动同步，不能把旧跟踪引用当作最新结果，不修改凭据、主机校验或系统安全设置来强行通过。
4. 只有**工作区干净、无未完成 Git 操作、目标上游明确、刚刚 fetch 成功、当前分支仅落后且能 fast-forward**时，才可对该上游执行 `git merge --ff-only`，随后重新核对 HEAD、分支和状态。相同提交不更新；仅领先不自动推送。存在本地改动、分叉、冲突、detached HEAD、未知上游或任何检查失败时，停止自动更新并报告；不自动 stash、reset、clean、强推、rebase 或解决冲突。快进失败后也不得改用普通 merge/pull 重试。
5. 停止的是自动同步；可以继续与同步无关且已获授权的工作，但必须说明哪些远端事实尚未核实，保留原有改动。报告实际目录/分支/HEAD、上游、改动和操作状态、fetch 结果、已确认的差异及下一步；不上传秘密、私人上下文、日志或用户内容。
6. 每个独立任务优先使用从正确基线建立的独立工作分支，不复用其他任务的脏工作区。新分支尚无上游时明确报告，不能擅设另一个业务分支为上游来绕过检查。实际提交、推送或合并前，重新检查状态、fetch 并比较远端变化；检查不能代替该操作的授权。对本任务待提交改动只按授权暂存具体文件，不用自动同步清理它们。若远端已前进或分叉，先报告并明确整合方案，不自动变基、合并或解决冲突。

### 分支与设备边界

- Web/API 和当前 Windows 源码以 `main` 为基线；Windows 位于 `desktop/windows/`。Android 以同仓库 `android-shell` 为基线。历史 `chevoink-windows` 不作为当前 Windows 开发基线。不得把这三个分支视为可以互相直接合并；复用改动需单独审查来源、范围、兼容性并有相应授权。
- 不同云任务的工作区独立，GitHub 是交换点。只声称检查了当前可访问 checkout 和已成功获取的远端状态；家中电脑离线时，不能声称检查过其未推送提交、未提交改动、未跟踪文件或旧任务状态。
- 本地 `.codex/`、凭据、签名文件和用户内容保持私有，不上传到 Git 或云任务提示词。规则生效需要任务实际读取包含它的 checkout；旧任务须重新读取，云端须取得含规则的已推送提交。不得把文档更新、环境草稿或工作流定义称为云端已可用。

### Windows / Linux 通用命令示例

先在当前任务目录执行以下只读检查；没有上游时命令失败，按上述规则报告，不猜测：

```sh
git rev-parse --show-toplevel
git rev-parse --absolute-git-dir
git rev-parse HEAD
git branch --show-current
git rev-parse --abbrev-ref --symbolic-full-name "@{upstream}"
git remote
git --no-optional-locks status --short --branch --untracked-files=all
git ls-files --unmerged
```

另用当前平台的文件存在检查核对上述 Git 操作标记。以下示例**仅适用于已确认当前上游属于 `origin`**的情形；其他远端使用核实后的实际名称。每步确认退出码，失败即停止自动同步：

```sh
git fetch --no-tags --recurse-submodules=no origin
git rev-list --left-right --count "HEAD...@{upstream}"
```

计数顺序为领先、落后。只有满足全部快进条件且结果为 `0 N`（N > 0）时才执行：

```sh
git merge --ff-only "@{upstream}"
git --no-optional-locks status --short --branch --untracked-files=all
git rev-parse HEAD
```

这些是有前置条件的单步示例，不能整段无判断执行；不要用无条件 `git pull` 代替。

## English

This policy applies to local Windows and cloud Linux tasks. It is an agent instruction, not an installed enforcing hook or a promise of conflict-free work. It grants no unrelated commit, push, merge, native publication or deployment authority.

The one-shot [opening sync and offline checker](./START-WORK.md), `node scripts/start-work.mjs`, implements the conservative checks below. Choose `--offline` explicitly, or run `node scripts/offline-readiness.mjs` for local prerequisites only. It installs no hook/background service, operates no other computer and grants no additional authority.

1. Before substantive development, inspect the actual task directory, repository root, Git directory, HEAD, branch, upstream and corresponding GitHub remote. Distinguish task branch, development baseline and release target; use the current checkout and redact credentials in remote URLs.
2. Inspect staged, unstaged, untracked and unmerged changes, plus `MERGE_HEAD`, `rebase-merge`, `rebase-apply` and unfinished cherry-pick/revert operations in the resolved Git directory. Do not hide, stage, delete or move private files merely to claim a clean workspace.
3. Fetch the verified GitHub remote and check its exit status before comparing ahead/behind. Fetch updates metadata, not the working tree or another device. On failure, stop automatic synchronization, report the failure and do not treat stale tracking refs as fresh evidence. Do not change credentials, host verification or system security settings to force success.
4. Only a clean workspace with no unfinished operation, a known target upstream, a successful fresh fetch and a strictly behind, fast-forwardable branch permits `git merge --ff-only` against that upstream. Recheck HEAD, branch and status afterwards. Equal needs no update; ahead-only never implies an automatic push. Local changes, divergence, conflicts, detached HEAD, unknown upstream or any failed check stop automatic updating. Never automatically stash, reset, clean, force-push, rebase or resolve conflicts; do not retry a failed fast-forward as an ordinary merge/pull.
5. Independently authorized work that does not depend on synchronization may continue, with unverified remote facts identified and existing changes preserved. Report directory/branch/HEAD, upstream, dirty/operation state, fetch result, verified differences and the next step without exposing secrets, private context, logs or user content.
6. Prefer a separate work branch from the correct baseline for each independent task. Do not reuse another task's dirty checkout or assign an unrelated upstream to bypass a new branch's missing-upstream check. Before any actual commit, push or merge, repeat inspection, fetch and comparison; obtain the operation's own authority. Stage only the authorized task files. If the remote has advanced or diverged, report and establish the integration plan instead of automatically rebasing, merging or resolving conflicts.
7. Web/API and current Windows source use `main`, with Windows under `desktop/windows/`; Android uses `android-shell`. Historical `chevoink-windows` is not the current Windows baseline. Never merge these business branches into one another as a synchronization shortcut; separately review and authorize any shared change.
8. Cloud task workspaces are independent; GitHub is the exchange point. Claim only checks of accessible checkouts and successfully fetched remote state. An offline home computer's unpushed commits, dirty/untracked files and old tasks are not inspected. Keep local `.codex/`, credentials, signing files and user content private. Tasks must actually read the updated checkout; old tasks must reload it and cloud tasks need the pushed revision. Documentation, an environment draft or a workflow file does not establish cloud availability.

The commands above work in PowerShell and a Linux shell. Resolve Git-operation marker paths and check their existence using the current platform. The fetch example assumes the verified upstream belongs to `origin`; use the actual verified remote otherwise. Compare counts are ahead, then behind; run the fast-forward command only for `0 N` (N > 0) after every other condition passes. Check every command's exit status; these are conditional examples, not an unconditional script or a substitute for authorization.
