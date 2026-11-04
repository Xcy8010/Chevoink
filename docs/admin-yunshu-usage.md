# 云枢管理员模型用量 / YunShu administrator usage

`GET /api/admin/yunshu-model-usage?period=today|week|month` requires the existing Chevoink administrator session. The server uses an existing YunShu administrator PAT with `log:read`; it neither creates permissions nor invokes a model. Configure `YUNSHU_ADMIN_ACCESS_TOKEN_FILE` as an absolute path to a private file containing only the PAT (0600 on POSIX), or use protected `YUNSHU_ADMIN_ACCESS_TOKEN`. The file takes precedence. Never place credentials in source, browser storage, URLs or logs. No `New-Api-User` header is required by the reviewed gateway source.

接口沿用墨域管理员会话。服务端使用现有云枢管理员 PAT 的 `log:read` 权限；不创建或扩大云枢权限、不调用模型。优先配置 `YUNSHU_ADMIN_ACCESS_TOKEN_FILE` 指向仅含 PAT 的绝对路径私有文件（POSIX 权限0600）；也支持受保护环境变量 `YUNSHU_ADMIN_ACCESS_TOKEN`。文件优先。凭据不得进入源码、浏览器、URL 或日志。未配置 PAT 时不发外部请求。

The fixed origin is `https://yunshu.chevolink.com`. Current enabled, unarchived platform model configurations (never user BYOK), fallback/weighted routes and applicable environment fallbacks identify candidate credentials. Each distinct generation key is sent only in an authorization header to read-only `/api/log/token`. Actual returned token IDs establish the allowlist; empty or inconsistent responses remain unresolved. Administrator `/api/log/` pages are filtered by these IDs before aggregation. Tokens may be shared with other applications, and historical replaced keys may be absent: this is **configured platform token usage**, not proof of exclusive Chevoink attribution.

固定源为 `https://yunshu.chevolink.com`。仅使用当前启用且未归档的平台配置、备用/加权线路及适用的环境兜底，不读取 BYOK。每个不同生成 key 仅通过认证头查询只读 `/api/log/token`，用真实返回的 token ID 建立允许列表；空记录或不一致来源保留未知。管理员 `/api/log/` 分页只聚合允许列表命中的记录。令牌可能与其他应用共享，历史更换 key 也可能不在当前配置内，因此范围是“平台配置令牌用量”，不宣称墨域独占。

Periods use UTC+8 calendar boundaries, Monday-start weeks, and a fixed request-time end. Reads have a 20-second timeout, 100 pages of 100 records, 4 MiB per response and 32 MiB per operation. At most three period snapshots are cached for 60 seconds; concurrent reads coalesce. Failures retain a same-scope prior snapshot marked stale; credential/configuration changes invalidate old scope. Pagination uses offsets without an upstream snapshot watermark; duplicates, missing request IDs, changing totals and truncation are disclosed. Coverage always remains partial, even when pagination completes. No retention, late correction or financial reconciliation completeness is asserted.

日、周、月按 UTC+8，自周一起算，并固定本次读取的结束时间。总读取20秒超时，最多100页、每页100条，每响应4MiB、每操作32MiB。最多缓存三个期间60秒，并发请求合并。失败保留同范围旧快照并标过期；凭据或配置变更失效旧范围。上游 offset 分页没有一致快照水位，重复、缺少请求编号、总数变化及截断均如实标识。覆盖始终为部分，分页完成不代表保留期、迟到更正或财务对账完整。

Only type 2 consumes contribute request/token totals; type 5 errors and type 6 refunds are separate counts. Missing token or cache evidence remains null. Cache reads/writes are separate from input tokens; cache creation totals are not added again to duration-specific breakdowns. Gateway quota is never converted to cash or Chevoink Credits. This endpoint does not write the local ledger or change existing integration reconciliation gates.

Source-token identity observations are shared across periods for 30 minutes in process memory, with concurrent discovery coalesced; unresolved identities remain unresolved. Credential or platform-source changes invalidate this identity cache. Usage snapshots still expire after 60 seconds. An upstream HTTP 429 pauses all gateway reads until its seconds-based `Retry-After` deadline and returns a safe UTC+8 recovery time; old same-scope data is marked stale, otherwise the result is an error. There is no automatic retry. 来源令牌识别快照在进程内跨期间共用30分钟，并合并并发识别；未知来源仍保持未知。凭据或平台来源变更立即使映射失效，用量快照仍为60秒。云枢返回429时按秒制 `Retry-After` 暂停所有外部读取并显示 UTC+8 恢复时间；同范围旧数据标过期，无旧数据则返回错误，不自动重试。

仅类型2消费计入请求和 Token，类型5错误、类型6退款分别计数。缺失用量/缓存证据为 null；缓存读写与输入分列，不把缓存写入总项和分时明细重复相加。不把网关 quota 转成现金或墨域 Credits，不写本地账本，不改变原有集成对账门禁。

## Records, passive health and actual gateway quota / 记录、被动健康与实际网关额度

`GET /api/admin/yunshu-operations` accepts the same `period`, plus bounded `page`/`pageSize` (maximum100), `kind=all|consume|error|refund`, and `view=records|health|cost`. Records and aggregates use the same sanitized, token-scoped log snapshot as model usage; pagination and filters reuse that snapshot within its60-second lifetime and report both the filtered total and the observed scoped total. Expired snapshots refresh through the existing shared read. At most10000 upstream scanned rows enter the existing bounded operation. Raw log content, metadata, IP, account identities, channel diagnostics and credentials are never returned. An opaque local record key is not an upstream reconciliation watermark.

新接口复用模型用量的同一份已裁剪、按平台令牌隔离的快照；记录翻页/筛选在60秒有效期内不重扫上游，过期后沿用共享读取刷新。`pageSize` 最大100，类型为全部/消费/错误/退款，视图为记录/健康/成本。响应分别报告筛选结果数与范围内已观察条数，上游仍受10000条扫描上限约束。不返回原始正文、metadata、IP、账号资料、渠道诊断或凭据。不透明本地记录键不是上游对账水位。

Passive health counts consume logs, error logs and structured stream outcomes separately. A consume log is not proof that streaming completed successfully, and task precharge/adjustment logs are not necessarily one logical request each. Missing outcomes remain unknown. Timing statistics use only positive recorded `use_time` seconds converted to milliseconds; percentiles use the nearest rank over those observed samples. They are gateway elapsed-time samples, not author-visible first text or active model availability. The health view reads public `GET /api/status` to show that interface's connectivity, never `/api/status/test` or a generation endpoint.

健康页是被动日志观测：消费、错误、退款、流式正常/异常/未知分开统计；消费不保证流正常结束，任务预扣/调整日志也不等于独立逻辑请求。耗时仅使用正数 `use_time` 秒转换的毫秒样本，百分位采用最近秩；不是作者首字或主动模型可用性验证。健康视图仅额外读取公开 `/api/status` 表示该接口是否可连接，不调用 `/api/status/test` 或生成接口。

Cost shows exact integer quota strings: type2 deductions minus positive type6 refunds; the net may be negative for the selected period. Missing/invalid quota evidence makes the corresponding total unknown, with explicit missing counts. Live `/api/status` supplies `quota_per_unit` and USD/CNY/CUSTOM/TOKENS display settings. Currency display divides by quota-per-unit and applies only the configured display rate, using integer decimal arithmetic with at most12 fractional digits; a nonzero result below that display precision remains unknown rather than silently becoming zero. TOKENS display means gateway quota units, not actual model tokens. A stale or invalid currency snapshot never supplies a current conversion; raw quota remains available.

成本保留精确额度整数字符串：类型2扣款减类型6正值退款；当前期间净额允许负数。缺失/异常金额不补零，相应合计未知并显示缺失计数。实时 `/api/status` 决定额度单位和 USD/CNY/CUSTOM/TOKENS 展示规则，以整数十进制运算换算，最多12位小数；低于精度的非零金额不悄悄显示零。TOKENS 是网关额度单位，不是真实模型 Token。过期或无效单位配置不用于当前换算，原始额度仍保留。

Only the cost view reads `GET /api/user/self` with the existing PAT's `profile:read` permission. Only `quota` and `used_quota` are retained. This is the management account's shared wallet, not a Chevoink-exclusive or supplier balance. No permission is created or expanded. Unit and wallet reads have independent60-second snapshots and concurrency coalescing, share the gateway429 deadline, and fail independently of log observations. Neither local Credits nor upstream quota is modified.

仅成本视图使用现有 PAT 的 `profile:read` 查询 `/api/user/self`，只保留 `quota` 与 `used_quota`。余额属于可能被其他应用共享的云枢管理账号，不冒充墨域专属或供应商余额，不创建/扩大权限。单位与余额各自缓存60秒、合并并发并共享429等待，辅助读取失败不抹去成功日志。没有本地 Credits 或上游额度写入。
