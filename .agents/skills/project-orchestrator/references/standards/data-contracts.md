# DATA — Contracts, persistence and identity

Apply to changed APIs, persistent state, migrations and shared data. Adapt mechanisms to the existing architecture.

## DATA-01 Contract ownership

Identify the authoritative API/schema/types/IDL or shared contract source. Adapters enforce boundary validation and authorization; business invariants live in the owning domain/service; views render. Preserve public envelopes, statuses, errors, defaults and wording unless a behavior change is authorized. Use the project's existing contract location, validation mechanism and protocol shape. Validate request framing as needed, but authorize protected data/actions before exposing them; preserve the actual threat model and avoid leaking existence through validation errors.

## DATA-02 Trust and invariants

Enforce ownership/tenant and input constraints at trusted boundaries, not only frontend controls. Recheck authorization at sensitive reads/writes; do not mistake an object ID for ownership. Use native database constraints as an additional layer. Define aggregate/transaction boundaries around business invariants. Across services use the project's proven outbox, saga, idempotency/compensation or consistency mechanism instead of demanding cross-service ACID.

## DATA-03 Atomic allocation and migrations

Design indexes from real lookup/sort/uniqueness requirements. Temporary positions/identifiers must avoid both pre-existing and newly allocated positions in the same operation. Test multi-object allocation, concurrent requests and every relevant unique constraint; gaps or ordering semantics are a business decision. Validate data/event/task protocol compatibility across forward migrations and rollback; never blindly replay a script or perform destructive down migrations.

## DATA-04 Versioned results

Bind cache entries, reads, updates and analysis receipts to owner, object, task and exact revision/hash plus required dependencies. Reject stale and cross-task references; do not guess the intended object. Test optimistic-conflict/no-side-effect paths, cache invalidation and cross-version pagination. Unknown/failed cached results cannot certify success.

## Required evidence when applicable

Contract compatibility; ownership denial; validation/error privacy; transactional or compensated failure; stale version; concurrent/duplicate request; migration/rollback compatibility. In a refactor preserve ordering and effect lifetimes, not merely matching type signatures.
