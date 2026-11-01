# 云枢只读集成边界 / Read-only gateway integration

本批交付独立契约、状态面板、显式映射预览、mock 适配边界和安全聚合 CSV。默认服务没有真实适配器、只读授权或专属来源证明，不会出网，也不会生成内容或修改本地数据。它不是已接通云枢、完成对账或已上线的证明。

This increment provides contracts, a status panel, explicit mapping previews, an injectable mock boundary and aggregate CSV export. The default service has no live adapter or verified read authority and makes no outbound request. It does not prove a live connection, reconciliation or deployment.

## 当前源码事实 / Current source

- `api/routes/admin.ts` 已有本人密码/手机号、Credits 政策、模型、业务记录、统计与审计；未发现通用站点品牌、公告、帮助发布或管理员异常通知的持久化与权限契约。
- `api/app.ts` 的既有健康接口只返回基础应用字段，没有可核公开运行版本。本批新状态只显示已知产品名称与未知版本，不继承环境、主机、路径、凭据或数据库信息。
- `api/lib/data/supplier-cost.ts` 是部分公开价重估；`api/lib/supplier-balances.ts` 的自动余额查询限定官方供应商端点。两者不能变成云枢扣款或通用网关余额。
- 普通用户互动/未读计数不代表管理员异常通知。站点、公告、帮助、通知仅列为 `contract_only`，未增加空导航、发布操作、任意 HTML 编辑器或新的认证体系。

Existing admin capabilities cover personal security, Credits policy, models, records, analytics and audit. General site/announcement/help publication and administrator alert policies remain contract-only. Existing public-price estimates and supplier balances are separate from gateway deductions. No environment or host details are added to the new status DTO.

## 接入点 / Integration points

契约位于 `shared/contracts/admin-integrations.ts`；服务位于 `api/lib/admin-integrations.ts`。根路由必须保留管理员鉴权，并在入口解析请求 schema：

- `getAdminIntegrationStatus()`：纯本地状态，无外部读取；适合 `GET /api/admin/integrations/status`。
- `readAdminIntegrationSnapshot(request, signal?)`：默认返回明确阻塞；未来仅可由受控只读适配器提供资料、用量、扣款或性能快照。没有自动重试或后台同步。
- `exportAdminIntegrationAggregates(request)`：只导出已取得快照的显式安全聚合列；没有快照时拒绝。根路由可在后续接入实际下载与权限审计。
- `AdminIntegrationStatus` 可嵌入现有成本页。挂载只读取本地状态；外部只读按钮要求 `canRead` 和明确期间。导出 UI 仅在根任务提供 `onExport` 后可用。

The root controller retains authorization and parses shared request schemas once. Mounting the panel reads local status only. A future explicit read requires both server readiness and a selected window; export delivery is optional and must be wired by the root controller.

## 明确映射与来源 / Identity and scope

映射键是本地配置 ID、不可变配置版本、云枢模型 ID 和分组。显示名称始终保留，来源名称仅是建议。多个写作档位可以显式映射同一上游模型，但此模块没有把网关数量分配给作者、任务或档位的算法。名称相同、时间接近和档位旧用量均不能替代请求标识贯通。

用量和扣款读取还要求最小只读权限、墨域专属来源证明、请求标识，以及分页水位、保留期、迟到更正和退款覆盖确认。浏览器请求不能自行声明这些证明。整个网关范围的性能只能标参考；不能改成墨域专属健康，不能推导写作完成、质量、首字、P50/P95 或输出速度。

Mappings use local configuration ID/version, gateway model ID and group; names never establish attribution. Multiple explicit mappings may share an upstream model. Usage/deduction reads also require exclusive-source and reconciliation proofs supplied by trusted server configuration. Gateway-wide performance remains gateway-wide reference data.

## 快照与导出 / Snapshots and export

规范化适配 DTO 严格限制字段和数量，拒绝附带密钥、用户、请求体或正文等额外字段。它不是已核实的云枢 wire schema；真实实现仍需核接口权限、字段映射、分页/限流和每类能力覆盖。原始凭据只能留在保护的服务端存储，不能进入该 DTO 或前端。

快照显示来源范围、分组、期间、采样时间、覆盖、计价版本与最近成功读取。失败保留上次成功数据并标过期；未知不补零。当前只有至多四类来源的进程内快照，十分钟后或来源时钟超前时标过期，服务重启后不声称保留了数据；持久同步、水位及差异人工应用尚未实现。

CSV 仅允许来源、范围、期间、采样时间、指标、值和单位，按明确选列导出；未知值写“未核定”。不导 provider/modelName、URL、密钥、用户资料、正文或原始快照。所有单元格先防护前导空白/控制字符后的 `= + - @`（含 tab、CR、LF），再按 CSV 标准转义引号。扣款与退款分别保留币种和未知项，不与本地账或不同币种相加。

Normalized responses are allowlisted and bounded, not a verified upstream wire contract. Four process-memory snapshot slots retain prior success on failure; stale/unknown values remain explicit. CSV contains explicitly selected aggregate columns only, preserves unknown values and neutralizes spreadsheet formulas before standard quoting. No local ledger, pricing or author content is changed.

## 验证边界 / Validation limits

本批只运行 mock/unit 与 scoped lint；没有执行真实云枢请求、真实模型调用、数据库迁移、生产操作或发布。真实权限、专属标识、对账关联、保留期、退款口径、持久同步、站点内容发布与通知策略仍需独立确认。

Validation is limited to mocks/unit checks and scoped lint. Live permissions, exclusive identity, reconciliation, retention/refunds, persistent sync, content publication and notification policies remain external prerequisites.
