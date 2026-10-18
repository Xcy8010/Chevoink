# Model routing and reasoning effort

The following are the user's chosen routing defaults, not a claim of a universal best model or an exhaustive supported-effort list. Verify actual account/host capabilities before use; do not silently substitute a different model or billing path.

| Responsibility | Requested model | Default effort |
|---|---|---|
| Main decisions, planning, acceptance | `gpt-6-astra` | `medium` |
| Implementation | `gpt-6.1-sol` | `high` |
| Scoped reconnaissance, verification, approved operations | `gpt-6-luna` | `high` |

These preferences coordinate the development agents only. They do not change models/providers/configuration inside the product under development. Missing model support is reported rather than simulated through roleplay. Host permissions and user authorization still bound every profile.

Routing is selective. The primary handles narrow corrections directly, without an obligatory implementation/verification/review relay. Delegate for separable ownership or a high-risk independent decision. Writers may run approved associated checks. Keep one writer per area, at most two independent subthreads and no recursive delegation; reuse agents and accepted rule packets. Configured model/effort defaults stay unchanged.

Checked against OpenAI documentation on 2026-10-02: `gpt-6.1-sol` supports `low`, `medium`, `high`, `xhigh`, and `max` reasoning effort; `none`/`minimal` are not supported. This package requests only `high` and `xhigh`. Treat this as release-time evidence, not permanent truth: verify runtime availability and current model docs before execution when it matters.

## Profiles

- `po_astra_deep`: Astra high, read-only deep decision review.
- `po_astra_critical`: Astra xhigh, read-only high-impact tie-breaker.
- `po_astra_reviewer`: Astra high, independent read-only review.
- `po_sol_coder`: Sol high, normal bounded implementation.
- `po_sol_deep`: Sol high, complex cross-module/stateful implementation with a stricter contract.
- `po_sol_critical`: Sol xhigh, critical/evidence-escalated implementation.
- `po_luna_scout`: Luna high, read-only search and evidence extraction.
- `po_luna_verify`: Luna high, deterministic verification.
- `po_luna_ops`: Luna high, approved operations only.

`po_sol_coder` and `po_sol_deep` intentionally use the same reasoning effort. Their difference is task contract, scope analysis, invariants, and validation expectations. Do not spend xhigh merely because a task has many files.

## Escalation

### Astra medium -> high
Escalate when at least one is evidenced:
- multiple modules/protocols/state machines are tightly coupled and boundary decisions are unclear;
- an evidence-producing attempt shows initial complexity was underestimated;
- current docs, tests, and runtime behavior conflict;
- several plausible root causes remain after deterministic checks.

### Astra high -> xhigh
Escalate only when:
- high effort has key evidence but cannot reliably separate high-impact options;
- the decision touches irreversible migration, critical data integrity, permissions/billing, or production incident response;
- the high-level plan failed validation after environmental causes were ruled out.

### Sol high -> xhigh
Escalate only when:
- a high-effort implementation has completed one evidence-producing retry with new evidence and still cannot converge;
- the implementation itself is clearly critical (irreversible migration, critical consistency, authorization/billing, severe production failure mode);
- a high-effort implementation was deterministically disproven and missing files/permissions/dependencies/network/environment were ruled out.

### Do not escalate for
- missing files/logs/permissions;
- unclear user requirements;
- dependency or network failures;
- repeated execution of the same command or hypothesis;
- questions answerable by deterministic tests or static analysis.

## Official sources to verify at execution

- https://developers.openai.com/api/docs/models/gpt-6-astra
- https://developers.openai.com/api/docs/models/gpt-6.1-sol
- https://developers.openai.com/api/docs/models/gpt-6-luna
- https://developers.openai.com/api/docs/guides/reasoning
- https://developers.openai.com/api/docs/guides/model-selection

Do not hard-code account quotas, reset-card rules, or assumptions about which product surface shares a usage pool. Verify those at execution time.
