# Search / Fetch 工具计费

[English](./WEB-TOOL-BILLING.en.md)

两项工具分别使用基础 2 Credits × 后台工具倍率，向上取整一次至 milli-Credit。2026-10-20 迁移仅将平台 `tool:web-search`、`tool:web-fetch` 的倍率初始化为 1.0；不修改供应商、URL、密钥、元数据或启用状态，不改变兑换规则、免费额度，也不追补历史账单。Fetch 未配置时继续网页直读，工具费为零。

只有供应商 Search 返回可用非空结果、供应商 Fetch 返回通过质量检查的正文才保留工具费。免费搜索 fallback、网页直读、缓存、失败、超时及空搜索免费；已预扣的金额通过持久退款义务退回。供应商现金成本与用户 Credits 分开，不能因为用户退款便认定供应商没有成本。模型阅读结果的 Token 按所选模型独立结算。

`web_tool_calls` 将 user/run/call/kind 身份、逻辑参数哈希、冻结金额及结果绑定。预扣和派发许可原子提交；缓存命中也保存零费用结果收据。同调用恢复先核对收据再读缓存或配置，不重派、不改价；新调用缓存过期后按新成功请求计费。`dispatched` 而没有结果的调用保持待核，禁止自动重发。已知失败/取消的结果与退款意图原子提交，原有后台 sweep 幂等偿付。

迁移在事务内锁定两行，将原倍率与时间保存在 `web_tool_price_migration_20261020`；不保存凭证或整行。数据库迁移是前向兼容的，不删除旧收费/退款记录。

经另行审核的价格回退可使用以下条件更新；应先查看预期匹配数量，零行表示管理员已作后续修改，必须停止并核对。执行前锁定目标行，更新与审计须在同一事务中完成，不盲目覆盖之后的配置：

```sql
UPDATE ai_model_configs AS c
SET multiplier_bps = b.previous_multiplier, updated_at = CURRENT_TIMESTAMP
FROM web_tool_price_migration_20261020 AS b
WHERE c.key = b.key AND c.owner_user_id IS NULL
  AND c.multiplier_bps = 10000 AND c.updated_at = b.applied_at;
```

这段价格回退不是整版应用回滚。旧版本不认识 `web_tool_no_billable_result`；回退旧代码前须清偿或保留兼容结算程序处理本版本生成的待退款意图，同时核对尚未完成的 `web_tool_calls`，不得重派未知请求。保留新增表、审计、原账本及已保存结果；不要执行破坏性 down migration。实际回滚演练与恢复时间不由构建或模拟测试代替。

供应商协议依据：[DeepSeek 官方 Search / Fetch 文档](https://api-docs.deepseek.com/zh-cn/guides/search)。供应商及收费配置仍由后台原有配置拥有；适配计费不代表切换供应商或启用服务。
