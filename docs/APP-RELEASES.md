# 应用版本与测试分流

此功能使用一个已部署的 API 二进制和不同的不可变前端产物，不运行两套 API，也不改变 Agent 环境开关、原生更新器或已接纳任务的模型、价格、版本绑定。以下说明应用版本机制与受控维护步骤；部署及通道激活状态以主任务的实际回执为准。

## 存储与入口

- `/opt/chevoink/app/current` 继续由现有 `scripts/deploy-production.ps1` 管理后端源码和运行时。
- `/srv/chevoink-data/beta-releases/<releaseId>` 保存不可变前端、每文件 SHA256 和受保护的 `manifest.json`。提升到稳定版只改变数据库通道，不移动、重建或覆盖这些字节；旧产物一直保留。
- `/srv/chevoink-data/release-archives` 是既有完整应用历史归档，独立于新前端产物；本功能不默认复制第二份，也不修改旧归档、数据库或原生安装包。
- `/api/app-releases/bootstrap` 使用已验证会话、服务端测试员资格与通道记录选版本。URL、请求头和客户端布尔值都不能授予资格。
- `/api/app-releases/artifacts/<id>/...` 每次检查当前分配，文件必须出现在不可变清单并通过 SHA256；清单和 CI 诊断不作为公共资源提供。响应为 `private, no-store`。
- 产物用其专属路径作为 Vite base。哈希化的外部 `release-entry.js` 在模块启动前恢复经过检查的原始站内路由，兼容旧 BrowserRouter，遵守现有 `script-src 'self'`，不放宽 CSP。当前入口在选择完成后才导入应用代码。
- `/admin/app-releases` 与其他页面一样先按服务端资格选择版本，不允许通过控制台路径绕过分流；所有版本操作仍重新验证超级管理员。必要的维护恢复使用受限维护入口。公共 `/version` 和 bootstrap 只展示版本标签与新增、改进、修复，不展示源码 SHA、供应商或工程诊断。

已加载界面发现版本变化时显示刷新入口，不自动丢弃正在编辑的内容。新的功能 API 请求使用当时的服务端资格；已经接纳的任务不经版本能力闸口重新定价或取消。

## 准备和登记

只在当前候选已提交、工作区干净、Node22.23.2/npm10.9.8 和既有原始同 SHA CI 完整通过后准备正式产物。准备工具复用 `release-ci-read.mjs` / `release-ci.mjs`，另核验 `run_attempt=1`；不接受上传的“已验证”布尔值或本地伪造 CI 成功覆盖。未取得证据可加 `--draft true`，会明确登记为未验证草稿，不能启用。

以下命令仅示例，不授予生产文件写入、通道切换、提交或部署权限：

```powershell
node scripts/prepare-app-release.mjs prepare --revision <40位候选SHA> --id <唯一版本编号> --label <公开版本名> --notes <仅公开更新说明JSON> --capabilities siteContent,testerManagement,imageQuality,modelPromotions,imageWeightedRoutes,publicModelDetails --out <不存在的输出目录>
node scripts/prepare-app-release.mjs verify --source <已准备目录>
```

公开说明 JSON 形如 `{"features":["具体新增功能"],"fixes":[],"changes":[]}`，不能放入私人调查、用户正文、凭据或内部供应商诊断。构建只从精确当前候选生成前端，不打包 `.env`、`.codex`、日志、签名材料或数据库。

在另行授权的维护环境中，将已准备产物按同一清单安装到受保护根目录：

```sh
node scripts/prepare-app-release.mjs install --source <已准备目录>
```

安装拒绝任何同名目标，不覆盖历史。中断后先用 `verify` 核对实际产物，不重跑整段部署。安装不迁移数据库、重启 API、改变源码目录或切换通道。后台只接收 `releaseId`，自行读取受保护清单、核验文件和证据；不能从请求提供路径、SHA、兼容性或验证结果。

如果原始 CI 尚未完成，后续需要用新的唯一编号准备正式产物；已登记草稿和历史证据不改写。现有生产 API 的部署继续走原入口与同 SHA 门禁，本工具不替代发布框架。

## 兼容性与激活前提

清单声明 API / 加法数据库结构 / 已接纳任务协议，并绑定精确源码、产物和原始 CI。工具检查候选注册界面是否提交当前条款和隐私版本；真实运行兼容性仍需原同 SHA 回归与浏览器验收。旧前端若缺少该提交界面，会被明确标为不兼容，而不是作为灰度成功接受。

版本分流要求前端兼容当前政策同意协议；不以正式政策正文是否齐全阻止现有用户的版本切换。注册仍要求服务条款和隐私政策是同一内容库中已发布且已生效的正式版本，缺任一正文继续关闭注册，不制造政策或历史同意。预览分别绑定当前两份政策的版本身份，缺一份时另一份变化也使旧预览失效。`/api/auth/legal-policies` 始终读取同一内容库的当前政策对，现有登录保持。

服务端能力映射：`siteContent` 控制公告/站点资料/帮助的公开与管理接口；`testerManagement` 控制新测试员管理接口；`imageQuality`、`modelPromotions`、`imageWeightedRoutes`、`publicModelDetails` 控制实际模型配置键，公开模型详情只返回对应允许字段。既有文本权重和已运行 Agent 请求不经过这些增量配置闸口。价格计算依然遵守全局模型、活动与冻结价格合同，不宣称有两套计费 API。

没有配置通道时保留现有应用；一旦配置，缺失、损坏、未验证或不兼容的产物明确报错，不悄悄回落其他版本。首次需要显式登记并全量启用一个经过验证的兼容稳定产物，之后才允许分配测试版，确保稳定与测试身份真实明确。

## 操作与恢复

所有变更先预览具体版本、公开变更、影响、产物身份和阻塞项，再输入版本编号确认。执行重新核验超级管理员、两个通道状态、`expectedRevision`、预览摘要、资格规则与当前政策；操作编号、回执、通道和审计在同一事务中提交。

- 分配测试版：仅有效测试员和超级管理员进入指定测试产物；其他账号继续稳定版。
- 全量发布：稳定版指向指定已验证兼容产物，并原子停用测试分流，使所有账号使用此稳定版；保留测试指针、两个修订和历史。
- 回退应用版本：只允许已发布过的兼容稳定产物；预览明确说明现有测试分流是否继续。不会恢复数据库、重建旧源码或修改任务绑定。
- 撤回测试分流：仅停用测试通道，核验稳定版作为回退入口；即使测试产物已损坏也可恢复分流。此操作与应用回退独立。

请求断开后，保留原操作编号并调用 `/api/admin/app-releases/operations/<operationId>` 核对。明确为 `applied` 才算已完成；数据库不可读保持结果待核，不重试整个部署。明确未提交后才能重新预览。相同编号的不同内容拒绝，相同编号的已提交请求返回原回执。

本说明不构成部署或验收回执。真实 PostgreSQL、原同 SHA CI、生产部署、浏览器及真机验收由主任务分别记录，不能用编译或单元测试冒充。


## 有界 SSH 维护入口

`scripts/app-release-maintenance.ts` 仅包装既有登记、预览、执行和结果核对服务，不进行 HTTP 登录，不直接写通道或 SQL。它不是 CI、产物准备或 API 部署入口。每次调用必须另给一个尚不存在的 JSONL 回执路径；`started` 先落盘，后续追加结果，不覆盖历史。服务仍复核显式 `actorId` 的超级管理员权限，审计 `ip=null`；本地回执记录真实 OS 用户、主机名、SSH 连接环境存在与否、候选/产物身份、预览摘要、修订与操作编号，不记录密钥或连接 URL。

只在原始同 SHA 完整 CI 已通过之后，从该候选归档建立独立 `/opt/chevoink/app/maintenance-<candidateSHA>` 目录。构建方从同一干净精确 checkout 生成 checked-file JSON：`{"revision":"<candidateSHA>","files":[{"path":"api/...","sha256":"..."}]}`，并独立固定此 JSON 的 SHA256。清单必须完整涵盖 `api/`、`shared/`、`prisma/`、维护 CLI 自身、`.node-version`、`package.json`、`package-lock.json` 和 `ecosystem.config.cjs`；不得含 `.env`、私人上下文或日志。CLI 逐项核对实际目录和清单完整性，不能拿手填的 40 位 SHA 冒充 Git 或 CI 证据。

生产凭据仅由远端原有 `/opt/chevoink/shared/app.env` 提供；显式设置 `APP_ENV=production`、`DOTENV_PATH=/opt/chevoink/shared/app.env`，使用 `/opt/chevoink/runtime/node-v22.23.2-linux-x64/bin/node --import tsx scripts/app-release-maintenance.ts`。配置与实际数据库身份必须匹配已观察的 `127.0.0.1:5432/chevoink_prod` 和 `public` schema，URL 和凭据不输出。当前版本从 `/opt/chevoink/app/current/.chevoink-release.json` 观察，不能凭调用参数替代。

四个命令为 `register`、`preview`、`execute`、`reconcile`。共同参数为 `--mode initialize_stable|assign_test --actor-id <明确账号ID> --candidate-sha <候选SHA> --candidate-proof <checked-file绝对路径> --candidate-proof-sha256 <摘要> --release-id <版本ID> --artifact-sha256 <已安装清单摘要> --receipt-path <新回执绝对路径> --operation-id <UUID>`。`register` 只登记受保护目录中的既有产物，`preview` 不登记或切换；`execute` 另须显式传入已查看的 `--preview-hash <摘要> --expected-revision <修订>`。

- `initialize_stable` 的唯一目标是已观察部署 `07da47b79586185538fd644b0c0540453287a32f` 的同源码产物，且稳定/测试及其他通道均不存在；仅此特例调用既有 `full_release` 服务初始化旧稳定入口。
- `assign_test` 只允许把当前候选放到测试通道，要求稳定通道已启用且目标与稳定入口不同。CLI 不提供任意新版本全量、回退或撤回操作；后续全量由超级管理员界面手动执行。
- `execute` 先核对操作编号。编号已有结果或结果未知时拒绝重新执行；使用 `reconcile` 只读核对，即使产物文件损坏也不阻止查操作结果。数据库不可读或执行响应不明记为 `unknown`，不自动重试。确认 `not_applied` 后才重新预览；不要重放整个部署。

此入口只承诺上述校验和服务调用边界。候选 CI、远端安装、首次稳定初始化、测试灰度及浏览器验收各有独立实际回执；新增 CLI 或单元测试通过不代表生产已执行。
