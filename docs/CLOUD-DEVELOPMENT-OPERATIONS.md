# 云端生产操作与恢复

此入口沿用 `scripts/deploy-production.ps1` 与 `deploy/deploy-production.sh`，目标固定为 `ubuntu@124.223.188.123` / `https://chevoink.chevolink.com`。不建立第二套部署系统；无 idle/drain 等待，无自动重放或自动回退。

## 一次性前置配置

维护者在 GitHub 仓库创建/检查 `production` environment：限制部署分支为 `main`，配置 required reviewers。在多人维护时可启用防止自我审批。工作流不仅检查环境名字，还通过只读 API 核验 required reviewers 和本次 run 的真实人工批准记录；管理员 bypass、没有审批保护或证据不可读都无法通过脚本。仓库套餐若不支持 required reviewers，该云端入口保持不可用，不能删除检查来放行。[环境保护规则](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)、[环境查询 API](https://docs.github.com/en/rest/deployments/environments#get-an-environment)、[本次运行审批历史 API](https://docs.github.com/en/rest/actions/workflow-runs#get-the-review-history-for-a-workflow-run)

仅在此环境配置 `PRODUCTION_SSH_KEY`（原生产 SSH 私钥）和 `PRODUCTION_KNOWN_HOSTS`（通过可信独立渠道核对的主机公钥行）。不要在 workflow 中动态 `ssh-keyscan` 后直接信任，不设置 `StrictHostKeyChecking=no`。入口保持现有严格主机校验和 BatchMode。需要维护者确认 GitHub runner 的 SSH 出口被现有网络策略允许；本次实现不改防火墙、账号或 SSH 权限。

密钥不进入仓库、日志或 artifacts。生产 job 只申请 contents/read 与 actions/read；内置 `github.token` 用于只读 CI/审批 API，不需要带管理员权限的 PAT。临时私钥 ACL 收紧并在 finally 中删除；使用托管 Windows runner，不复用长期共享机器。

临时私钥、Android keystore 和 properties 文件按实际 Windows 进程 SID 授予 `(R,D)`，去掉继承；finally 用直接文件删除，不依赖需要额外属性写权限的 `Remove-Item -Force`。`scripts/cloud-credential-acl.Tests.ps1` 在 Windows 上以无密钥文件执行实际创建、ACL收紧、读取及删除，覆盖三类文件；正常失败清理与托管 runner 强制销毁仍是不同保证。

## 审批与执行

入口仅监听 `main` 上 `.github/production-request.json` 的 push，普通源码 push 不申请生产任务；初始化的 `action=none` 只完成无凭据准入，不申请环境审批。请求产生 main 提交及既有 CI 用量。2026-10-19 本轮只读查询为 `main.protected=false`、rulesets 空；此实现不修改保护或凭据，不能称主分支已经受保护。维护者应单独审查禁止强推/删除等保护；它们也不等于工作流路径 ACL。

1. 已审查候选 **C** 必须通过该 SHA 原始 `CI`：实际 PostgreSQL、零skip、完整分片、原覆盖率门槛和所有静态/build/audit。只接受原 `ci.yml` 的 main push run。
2. 用唯一小写 UUID 提交独立请求 **R**。`C..R` 最多128个提交，每个均为单父且仅修改固定 JSON，除该文件外完整树必须与C一致，包括工作流与控制脚本。R必须是一次非强推、非建删分支的main push，`before` 必须为R直接父提交；请求严格采用下述规范JSON与标题。执行代码和发布归档均检出C，不能把R冒充通过原CI的源码。
3. 无生产环境/凭据的 `admit` job先检查请求、完整Git对象、原CI及当前main头。production job只有显式有效请求才排队；它检出C，必须获得真实人工环境审批。两种模式都接触原有写权限SSH身份，inspect只读由固定代码限制，不能免审批。
4. **先inspect**：审批后经stdin只读核验真实marker、已知源码摘要、固定Node/PM2/API进程、内外health和入口页。不读取app.env、作品或原始进程环境，不启动PM2、不接触数据库、不上传远端脚本。主控读回成功且5分钟内的回执取得实际基线 **B**。
5. **再deploy**：新UUID请求必须明确给出C、B、原CI以及成功inspect的run/UUID/R。准入逐项核对原始inspect请求及新鲜成功回执，手机再批准明确的“C覆盖B”。执行前再次实测必须等于B；绝不把B覆盖为现场值。候选已在线或旧journal已存在时不重放。
6. 原维护入口成功后独立postflight核对C、源码、进程、health、入口及completed journal。只有前置观察不能报告部署成功。发布源码或实际生产操作仍需用户的当前明确授权；提交inspect不授权deploy。

规范JSON由 `productionPushRequest` 生成，UTF-8、两空格、LF结尾、固定键顺序；拒绝未知键、重复键的非规范编码、任意路径/主机/命令和分支别名。例如inspect（占位值必须替换）：

```json
{
  "schemaVersion": 1,
  "action": "inspect",
  "sourceSha": "替换为40位候选C",
  "ciRunId": "替换为C原CI编号字符串",
  "requestId": "替换为唯一小写UUID"
}
```

仅对请求文件作一次普通提交/push，提交消息必须等于 `productionRequestTitle(request)`：`inspect <C> [<UUID>]`；deploy为 `deploy <C> over <B> [<UUID>]`，还必须依次提供 `expectedRevision`、`inspectionRunId`、`inspectionRequestId`、`inspectionRequestSha`。不要在请求提交夹带源码、工作流或其他文件，不自动整合远端变化。

工作流使用固定 `chevoink-production` 并发组，`cancel-in-progress: false`，不会因新请求 自动取消正在变更生产的运行。GitHub仍可能替换排队中的 pending run；不要连续点击制造重复操作。远端现有 `flock` 继续保护同时从本地入口发起的操作。不要手动取消正在切换的 job；若发生中断，其结果必须按下节核对。[GitHub 并发规则](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)

审批后脚本再次核验实际审批与 live CI，随后仅调用一次维护入口。维护入口再次读取原 CI、打包 `git archive HEAD`、校验预期生产源码/进程、在旁边准备依赖与构建，再正常切换/重启。既有 migration helper 只接受字节相同 schema 或已审查的特定兼容索引迁移；此入口不扩大迁移权限。生产目标、schema 或恢复协议变化须单独审查。

进程快照通过 `scripts/production-process-snapshot.mjs` 直接向已存在的 PM2 RPC socket 发送一次只读 `getMonitorData`，不执行 `pm2 jlist`、不导入 PM2 客户端，也不会自动启动 daemon。当前协议校验绑定实际核对的 PM2 **7.0.3**：Ubuntu身份/HOME/PM2_HOME、daemon PID/owner/runtime/命令/starttime、socket inode与daemon监听fd，在RPC前后必须一致；API还需匹配pm_id0、current路径、父daemon和固定Node。断连、超时或daemon缺失均停止，RPC最多3秒/8MiB；升级PM2需重新审查协议与身份契约。这个快照入口不负责恢复服务，原 stop/restart 顺序保持不变。

成功需维护入口退出0，远端源码/marker/固定Node/PM2/API进程、内部生产 health、公开 health 与公开 index 摘要吻合。保留工作流运行链接和实际核验结果；UI/设备验收不是脚本成功的隐含结论。日志只作脱敏证据，不上传整个远端目录或 env。

## 主控触发与回执接入

主控使用已授权的云端Git push和已连接GitHub读取工具，不新增Actions写Token、密钥或常驻服务。runner token仍只有contents/read、actions/read。没有dispatch工具时不借issue、重跑旧job或workflow_run来隐式触发。若实际工作流push被拒绝，报告准确拒绝并停止；不换通道绕过。

**独立审批前核验是硬前置。** push事件的工作流本身来自R，R中的guard不能证明自身未被恶意改写。可信云主控在给手机链接前必须重新取得远端R及具体run：独立用Git对象核对C..R每个提交仅改固定请求文件、R其余完整树=C，核对用户明确发起的UUID、C原CI、仓库/工作流/main push/head_sha=R/attempt=1和production待审批环境。deploy还须从成功inspect回执核对C/B/CI/UUID与所引用R。只提供绑定不可变R及run ID的链接，人工只批准此run，其余pending请求默认拒绝；不完整、歧义、状态未知均不提供审批链接。

main头检查用于新鲜度，不是分支原子锁。既有main写者仍是受信边界，不能声称已具备路径级ACL。防自审、环境分支限制和审核人保持原配置；身份不兼容时停止，不为打通而关闭保护。真实GitHub人工批准不能用聊天同意替代。

push响应中断或未见运行时，先核对远端HEAD、请求Git对象及受支持的仓库 `actions/runs` 集合，按完整R/工作流/main/首次attempt/精确标题和UUID定位，完整分页后才可得唯一结果。`reconcileProductionRequest` 对缺失、多匹配都保留未知且 `retryAllowed=false`，不自动重推、换UUID或点Re-run。

job只保留 `cloud-output/preflight.json`、`deployment.json`、`postflight.json`，artifact保留7天。日志有 `CHEVOINK_PRODUCTION_RECEIPT` / `CHEVOINK_DEPLOYMENT_RECEIPT` 单行脱敏JSON，无env、密钥、作品或健康正文。`readProductionRun` 接受已授权GET适配器，读取准确run、完整admit/deploy jobs与执行job解码日志；绑定R、C、CI、UUID及时间，观测只接受5分钟内证据，发布还需B、维护入口回执与completed journal。历史artifact不代表即时生产状态。

首次接入验收由云主控在C原CI成功后提交一次inspect，父级独立核对上述证据后才给用户手机审批链接，最后读回新鲜回执。inspect不能顺带部署产品。记录每个动作的实际云端工具和runner，用户未确认XCY关机时不得宣称关机实测；不要求或操作XCY关机。真实发布与关机端到端验收留待对应明确授权和实际证据。

## 失败、中断或未知结果

**不要点击 Re-run jobs，也不要原样重发整段部署。** 云端 guard 拒绝 attempt>1；新 run 也不能代替状态核对。先只读检查 `/opt/chevoink/app/.release-<候选SHA>.jsonl`、`current` / `release-<SHA>` / `previous-<基线>-for-<SHA>`、实际 PM2进程/runtime、源码摘要、release marker、内部/公开 health 和入口页。确认最后完成的 phase 与实际目录，记录未知部分后再制定最小恢复动作。

没有自动回退功能。保留旧目录不代表可安全切回：恢复前核对数据库、事件/任务恢复格式、计费/政策解析及前向兼容性。不得删用户数据、down migration、重置额度或重放未知付费请求。

对于线上仍健康但业务需要恢复旧行为的情况，优先在 `main` 制作兼容的前向修复或显式 revert 提交，保留必要的新协议支持；通过该新 SHA 的完整原 CI 和 review 后，以**实际现在线上 SHA**为基线，再走同一维护入口。原 `release-package.mjs` 要求基线是候选祖先，且维护入口拒绝重复已存在的候选 journal/目录；不能假装用旧 SHA 原样重新部署就能回退。

若进程已停止、目录已切换或外部结果未知，不属于从健康基线开始的常规部署：按实际阶段审查最小恢复操作和兼容性，必要时由维护者执行明确批准的定向修复。此文不提供绕过门禁的通用恢复开关，也不宣称已做恢复演练或达到某个RPO/RTO。
