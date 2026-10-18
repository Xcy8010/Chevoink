# 云端生产操作与恢复

此入口沿用 `scripts/deploy-production.ps1` 与 `deploy/deploy-production.sh`，目标固定为 `ubuntu@124.223.188.123` / `https://chevoink.chevolink.com`。不建立第二套部署系统；无 idle/drain 等待，无自动重放或自动回退。

## 一次性前置配置

维护者在 GitHub 仓库创建/检查 `production` environment：限制部署分支为 `main`，配置 required reviewers。在多人维护时可启用防止自我审批。工作流不仅检查环境名字，还通过只读 API 核验 required reviewers 和本次 run 的真实人工批准记录；管理员 bypass、没有审批保护或证据不可读都无法通过脚本。仓库套餐若不支持 required reviewers，该云端入口保持不可用，不能删除检查来放行。[环境保护规则](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)、[环境查询 API](https://docs.github.com/en/rest/deployments/environments#get-an-environment)、[本次运行审批历史 API](https://docs.github.com/en/rest/actions/workflow-runs#get-the-review-history-for-a-workflow-run)

仅在此环境配置 `PRODUCTION_SSH_KEY`（原生产 SSH 私钥）和 `PRODUCTION_KNOWN_HOSTS`（通过可信独立渠道核对的主机公钥行）。不要在 workflow 中动态 `ssh-keyscan` 后直接信任，不设置 `StrictHostKeyChecking=no`。入口保持现有严格主机校验和 BatchMode。需要维护者确认 GitHub runner 的 SSH 出口被现有网络策略允许；本次实现不改防火墙、账号或 SSH 权限。

密钥不进入仓库、日志或 artifacts。生产 job 只申请 contents/read 与 actions/read；内置 `github.token` 用于只读 CI/审批 API，不需要带管理员权限的 PAT。临时私钥 ACL 收紧并在 finally 中删除；使用托管 Windows runner，不复用长期共享机器。

临时私钥、Android keystore 和 properties 文件按实际 Windows 进程 SID 授予 `(R,D)`，去掉继承；finally 用直接文件删除，不依赖需要额外属性写权限的 `Remove-Item -Force`。`scripts/cloud-credential-acl.Tests.ps1` 在 Windows 上以无密钥文件执行实际创建、ACL收紧、读取及删除，覆盖三类文件；正常失败清理与托管 runner 强制销毁仍是不同保证。

## 审批与执行

1. 确认候选 main 完整 SHA 及该 SHA 原始 `CI` 已全部成功：实际 PostgreSQL、零skip、完整分片、原覆盖率门槛与所有静态/build/audit。只接受原 `ci.yml` 的 main push run，不接受 PR、同名替代 workflow 或本地成功覆盖。
2. 只读核对生产当前源码、release marker 与实际 Node/PM2 进程，记录其完整 SHA 为 `expected_production_sha`。健康接口正常不能单独证明线上版本。
3. 手动触发并在 `production` 环境审批页面核对候选 SHA、当前 SHA、CI编号和影响：普通 API停止/切换/重启，现有任务由原恢复逻辑处理，无额外取消或数据修改。

```powershell
$candidate = '替换为40位main完整SHA'
$active = '替换为实际生产40位完整SHA'
$ci = '替换为候选原始CI运行编号'
gh workflow run cloud-deploy.yml --repo Xcy8010/Chevoink --ref main -f source_sha=$candidate -f expected_production_sha=$active -f ci_run_id=$ci
```

工作流使用固定 `chevoink-production` 并发组，`cancel-in-progress: false`，不会因新 dispatch 自动取消正在变更生产的运行。GitHub仍可能替换排队中的 pending run；不要连续点击制造重复操作。远端现有 `flock` 继续保护同时从本地入口发起的操作。不要手动取消正在切换的 job；若发生中断，其结果必须按下节核对。[GitHub 并发规则](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)

审批后脚本再次核验实际审批与 live CI，随后仅调用一次维护入口。维护入口再次读取原 CI、打包 `git archive HEAD`、校验预期生产源码/进程、在旁边准备依赖与构建，再正常切换/重启。既有 migration helper 只接受字节相同 schema 或已审查的特定兼容索引迁移；此入口不扩大迁移权限。生产目标、schema 或恢复协议变化须单独审查。

进程快照通过 `scripts/production-process-snapshot.mjs` 直接向已存在的 PM2 RPC socket 发送一次只读 `getMonitorData`，不执行 `pm2 jlist`、不导入 PM2 客户端，也不会自动启动 daemon。当前协议校验绑定实际核对的 PM2 **7.0.3**：Ubuntu身份/HOME/PM2_HOME、daemon PID/owner/runtime/命令/starttime、socket inode与daemon监听fd，在RPC前后必须一致；API还需匹配pm_id0、current路径、父daemon和固定Node。断连、超时或daemon缺失均停止，RPC最多3秒/8MiB；升级PM2需重新审查协议与身份契约。这个快照入口不负责恢复服务，原 stop/restart 顺序保持不变。

成功需维护入口退出0，远端源码/marker/固定Node/PM2/API进程、内部生产 health、公开 health 与公开 index 摘要吻合。保留工作流运行链接和实际核验结果；UI/设备验收不是脚本成功的隐含结论。日志只作脱敏证据，不上传整个远端目录或 env。

## 失败、中断或未知结果

**不要点击 Re-run jobs，也不要原样重发整段部署。** 云端 guard 拒绝 attempt>1；新 run 也不能代替状态核对。先只读检查 `/opt/chevoink/app/.release-<候选SHA>.jsonl`、`current` / `release-<SHA>` / `previous-<基线>-for-<SHA>`、实际 PM2进程/runtime、源码摘要、release marker、内部/公开 health 和入口页。确认最后完成的 phase 与实际目录，记录未知部分后再制定最小恢复动作。

没有自动回退功能。保留旧目录不代表可安全切回：恢复前核对数据库、事件/任务恢复格式、计费/政策解析及前向兼容性。不得删用户数据、down migration、重置额度或重放未知付费请求。

对于线上仍健康但业务需要恢复旧行为的情况，优先在 `main` 制作兼容的前向修复或显式 revert 提交，保留必要的新协议支持；通过该新 SHA 的完整原 CI 和 review 后，以**实际现在线上 SHA**为基线，再走同一维护入口。原 `release-package.mjs` 要求基线是候选祖先，且维护入口拒绝重复已存在的候选 journal/目录；不能假装用旧 SHA 原样重新部署就能回退。

若进程已停止、目录已切换或外部结果未知，不属于从健康基线开始的常规部署：按实际阶段审查最小恢复操作和兼容性，必要时由维护者执行明确批准的定向修复。此文不提供绕过门禁的通用恢复开关，也不宣称已做恢复演练或达到某个RPO/RTO。
