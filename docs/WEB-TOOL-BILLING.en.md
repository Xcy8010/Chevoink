# Search / Fetch tool billing

[简体中文](./WEB-TOOL-BILLING.md)

Each tool costs a base 2 Credits multiplied by its own administrator multiplier, rounded upward once to milli-Credits. The 2026-10-20 migration initializes only platform `tool:web-search` and `tool:web-fetch` to 1.0. It preserves providers, URLs, credentials, metadata and enabled flags; exchange rules, allowances and historical charges remain unchanged. Unconfigured Fetch retains free direct reading.

A fee is retained only for usable nonempty supplier Search results or supplier Fetch body passing content quality checks. Free search fallback, direct reading, cache reuse, failures, timeouts and empty searches cost no tool fee; prepayments receive durable refund obligations. Supplier cash cost remains separate from user Credits. Model tokens used to read the results are independently settled at the selected model's price.

`web_tool_calls` binds user/run/call/kind identity, logical request hash, frozen price and outcome. The debit and dispatch permit commit atomically. Cache hits also save zero-fee receipts. Recovery checks the original receipt before caches or current configuration; it never redispatches or reprices that call. A new successful call after cache expiry is independently billed. A `dispatched` receipt without an outcome remains unresolved and cannot be automatically resent. Known failure/cancellation outcomes commit with refund intents; the existing background sweep settles them idempotently.

The migration locks the two rows inside a transaction and retains only their prior multipliers and timestamps in `web_tool_price_migration_20261020`. It saves no secrets or complete configuration rows. Schema changes are forward compatible and retain historical charges/refunds.

An independently reviewed price rollback may use this conditional update. Check the expected row count first; zero means later administrator edits require reconciliation. Lock target rows and keep the update and audit in one transaction. Never overwrite later configuration blindly:

```sql
UPDATE ai_model_configs AS c
SET multiplier_bps = b.previous_multiplier, updated_at = CURRENT_TIMESTAMP
FROM web_tool_price_migration_20261020 AS b
WHERE c.key = b.key AND c.owner_user_id IS NULL
  AND c.multiplier_bps = 10000 AND c.updated_at = b.applied_at;
```

Price restoration is distinct from application rollback. Older code cannot process `web_tool_no_billable_result`; before reverting it, settle outstanding obligations or retain a compatible settlement worker, and reconcile unfinished `web_tool_calls` without redispatching unknown requests. Preserve tables, audit, ledger and saved outcomes. No destructive down migration. Builds and simulated tests do not establish a completed rollback drill or recovery time.

Protocol reference: [DeepSeek Search / Fetch documentation](https://api-docs.deepseek.com/zh-cn/guides/search). Existing administrator configuration continues to own provider and pricing choices; this change does not switch providers or enable services.
