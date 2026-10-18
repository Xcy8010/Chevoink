# BILL — Billing, credits, reservations and usage

Apply only if the affected project actually bills or accounts for usage/value. Use only the current project's pricing, units, rounding, notices and release policy.

## BILL-01 Units and precision

Choose exact integer/fixed-point/decimal arithmetic suited to the currency and runtime; define unit conversion and rounding once per logical charge. Do not mandate JS BigInt or milli wallets. Reject invalid/negative/overflow values as appropriate. Unknown usage is not zero. Verify provider accounting definitions so cached input or reasoning/output usage is not double-counted.

## BILL-02 Frozen price and clear policy

Snapshot the applicable versioned tariff/policy before the operation. Resume/restart/admin changes cannot silently reprice an existing logical charge. Define BYOK/free/platform-paid behavior explicitly; missing usage is not proof of free service and existing free features cannot silently acquire a fee. Distinguish provider cash, measured usage, assessed debit, actual debit and refund.

## BILL-03 Settlement and reconciliation

Use stable logical keys and suitable transactional/compensation boundaries for reservation, settlement, receipt and refund. Idempotent retries cannot double-charge or refund. A partial debit is not a full settlement. Preserve known usage after failure/cancel; unknown results remain pending for reconciliation. Durable refund intent refers to the actual original debit and cannot exceed it. Check owner/lease and original authorization at settlement boundaries.

## BILL-04 Pricing changes require measured review

Compare frozen candidates on matched, time-separated evidence and the project's required shadow/rollout policy. Show user/task/cohort tails as well as aggregates; similar total revenue can hide individual increases. Preserve quality, provider-cash and customer-impact measurements, notices and approval. Exceptions require current scoped approval and evidence; never fabricate an observation period or waiver.

Do not borrow numeric pricing or rollout thresholds from another project. Read and verify current local pricing policy and actual authority. Test duplicate/concurrent settlement, refund retries, cancel/restart, unknown usage, rounding/overflow and tariff snapshot preservation.
