# EXEC — Jobs, recovery, cancellation and external effects

Apply to asynchronous jobs, queues, durable agent workflows, remote calls and other side-effecting operations.

## EXEC-01 Scope and logical identity

Persist original authorized request, task root/contract, owner, targets, configuration and remaining/unknown budgets as required by the product. Resume restores that task, not permissions implied by a summary. Attempt IDs can change; the logical operation/receipt identity must remain stable for duplicate delivery and concurrent resumes. Do not equate session/run ID with authorized task scope.

## EXEC-02 Fencing at side-effect boundaries

Validate current owner/generation/lease and authorization before committing data, terminal state, settlement or external effect. Expired workers must not commit. Choose the project's concurrency primitive; do not add leases where unnecessary. Forward cancellation to primary/auxiliary work, waits, network, parsing and pre-write checks. Capture already acquired evidence/usage without treating preservation as permission to write cancelled business content.

## EXEC-03 Classified retries and unknown outcomes

Separate no-match/no-change, cancellation, protective refusal, invalid input, auth/credit, transient provider and infrastructure failures. Retry only classified transient/idempotent work within both attempt and deadline limits. An unknown remote result must be reconciled via operation ID/status/receipt before a new paid or destructive attempt; a timeout is not proof that nothing happened. Escalate uncertainty instead of silently resetting budgets.

## EXEC-04 Budgets and completion

Track total task allowance, per-attempt limits, consecutive corrective failures and active time separately. A real success may reset consecutive failures but not the total task/run budget. Pausing does not grant more allowance or count idle time as active work. Missing legacy values are unknown, not zero or infinity. Migrations/restarts must not restart all historical tasks indiscriminately.

Completion requires verified persisted/postcondition artifacts. "Done" prose, checklist length and green activity cards are not evidence. Tool-free wrap-up cannot authorize more work.

## Failure matrix

Concurrent resume; duplicate delivery; stale generation; cancel-before-call/during-stream/after-result/before-commit; process restart; unknown remote outcome; exhausted budget; cross-task replay; partial settlement/side effect. Use minimal reproductions and bounded retries. Host advisory counters are not durable business idempotency guarantees.
