# 云枢管理员模型用量 / YunShu administrator usage

`GET /api/admin/yunshu-model-usage?period=today|week|month` requires the existing Chevoink administrator session. The server uses an existing YunShu administrator PAT with `log:read`; it neither creates permissions nor invokes a model. Configure `YUNSHU_ADMIN_ACCESS_TOKEN_FILE` as an absolute path to a private file containing only the PAT (0600 on POSIX), or use protected `YUNSHU_ADMIN_ACCESS_TOKEN`. The file takes precedence. Never place credentials in source, browser storage, URLs or logs. No `New-Api-User` header is required by the reviewed gateway source.

接口沿用墨域管理员会话。服务端使用现有云枢管理员 PAT 的 `log:read` 权限；不创建或扩大云枢权限、不调用模型。优先配置 `YUNSHU_ADMIN_ACCESS_TOKEN_FILE` 指向仅含 PAT 的绝对路径私有文件（POSIX 权限0600）；也支持受保护环境变量 `YUNSHU_ADMIN_ACCESS_TOKEN`。文件优先。凭据不得进入源码、浏览器、URL 或日志。未配置 PAT 时不发外部请求。

The fixed origin is `https://yunshu.chevolink.com`. Current enabled, unarchived platform model configurations (never user BYOK), fallback/weighted routes and applicable environment fallbacks identify candidate credentials. Each distinct generation key is sent only in an authorization header to read-only `/api/log/token`. Actual returned token IDs establish the allowlist; empty or inconsistent responses remain unresolved. Administrator `/api/log/` pages are filtered by these IDs before aggregation. Tokens may be shared with other applications, and historical replaced keys may be absent: this is **configured platform token usage**, not proof of exclusive Chevoink attribution.

固定源为 `https://yunshu.chevolink.com`。仅使用当前启用且未归档的平台配置、备用/加权线路及适用的环境兜底，不读取 BYOK。每个不同生成 key 仅通过认证头查询只读 `/api/log/token`，用真实返回的 token ID 建立允许列表；空记录或不一致来源保留未知。管理员 `/api/log/` 分页只聚合允许列表命中的记录。令牌可能与其他应用共享，历史更换 key 也可能不在当前配置内，因此范围是“平台配置令牌用量”，不宣称墨域独占。

Periods use UTC+8 calendar boundaries, Monday-start weeks, and a fixed request-time end. Reads have a 20-second timeout, 100 pages of 100 records, 4 MiB per response and 32 MiB per operation. At most three period snapshots are cached for 60 seconds; concurrent reads coalesce. Failures retain a same-scope prior snapshot marked stale; credential/configuration changes invalidate old scope. Pagination uses offsets without an upstream snapshot watermark; duplicates, missing request IDs, changing totals and truncation are disclosed. Coverage always remains partial, even when pagination completes. No retention, late correction or financial reconciliation completeness is asserted.

日、周、月按 UTC+8，自周一起算，并固定本次读取的结束时间。总读取20秒超时，最多100页、每页100条，每响应4MiB、每操作32MiB。最多缓存三个期间60秒，并发请求合并。失败保留同范围旧快照并标过期；凭据或配置变更失效旧范围。上游 offset 分页没有一致快照水位，重复、缺少请求编号、总数变化及截断均如实标识。覆盖始终为部分，分页完成不代表保留期、迟到更正或财务对账完整。

Only type 2 consumes contribute request/token totals; type 5 errors and type 6 refunds are separate counts. Missing token or cache evidence remains null. Cache reads/writes are separate from input tokens; cache creation totals are not added again to duration-specific breakdowns. Gateway quota is never converted to cash or Chevoink Credits. This endpoint does not write the local ledger or change existing integration reconciliation gates.

仅类型2消费计入请求和 Token，类型5错误、类型6退款分别计数。缺失用量/缓存证据为 null；缓存读写与输入分列，不把缓存写入总项和分时明细重复相加。不把网关 quota 转成现金或墨域 Credits，不写本地账本，不改变原有集成对账门禁。
