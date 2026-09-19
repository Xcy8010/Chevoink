# Built-in model routes and task recovery

[简体中文](./MODEL-ROUTING-AND-TASK-RECOVERY.md)

## Provider routes

Edit a built-in text model in Model Management to add up to seven provider routes alongside its primary configuration. Each route has its own provider, model, encrypted account key and enabled state. Existing primary settings remain usable. API responses and audit records never expose keys.

Enabled routes must support the tier's declared reasoning levels, context window and image capability. Administrators must enter actual provider capabilities; configuration does not make paid capability probes. User pricing stays attached to the built-in tier, while usage records retain the actual provider and model.

The public Agent loop and auxiliary text calls rotate enabled routes. HTTP 429/500/502/503/504 rejections without positive or partially observed usage can move to another route in the same tier. Each call has at most three attempts and a 360-second total deadline, also respecting the caller's shorter deadline and cancellation. Rejected routes cool down for at least 30 seconds, honoring Retry-After up to five minutes. Streaming failures, uncertain transport outcomes, truncated output and BYOK are not automatically replayed.

Failure accounting remains honest: existing rejection rules handle 429, while unknown 5xx usage retains reconciliation state and reservations. Insufficient credits or unresolved usage safeguards may stop further failover. Exhausted routes preserve progress and surface failure. Durable protocol v1 retains its frozen route and receipt identity; this pool does not bypass that boundary.

## Resume and writing pace

Resume continues the current interrupted run in the current conversation without adding a synthetic user message. It uses the original request, persisted replies, tool receipts and bounded saved reasoning. Work memory and other tasks do not grant new authority. Missing legacy contracts are reconstructed from that run's own original request.

Automatic continuation keeps the cumulative budget ceiling. Explicit manual continuation can grant the existing bounded budget slice; restoration no longer truncates that previously granted slice. Cumulative consumption, continuation count and time limits remain effective.

Broad whole-book requests first deliver a direction, outline and proposed initial chapter range, awaiting an explicit writing instruction. Tool execution permissions enforce this planning phase, including restrictions on delegated writing. Explicit chapter requests and explicitly authorized autonomous writing retain their authorized scope. Greetings and informational questions grant no manuscript writes.

## Tool checks

Auxiliary requests explicitly send the same output limit used for their reservation. Truncation and broken streams have distinct failure codes; partial checks are never accepted as complete. Quality prompts bound report size. Durable quality checks permit one exact-quote correction, never deleting judgments or rewriting prose to pass.

Approval timeouts, missing quality reports and continuity checks invalidated by edits remain protective failures rather than fabricated successes.

This document describes implementation behavior. Consult the release record for actual checks, CI and deployment status.
