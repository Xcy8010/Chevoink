# Architecture adaptation for medium/large work

Use only the rows relevant to an actual change. These are planning prompts, not architecture generators or mandatory frameworks. Preserve the adopted architecture by default; a different architecture needs explicit justification and approval. Unknown is not monolith, microservices or serverless.

## Establish the affected boundary before splitting work

Identify ownership, dependencies/consumers, interfaces, state lifetime, consistency expectations, failure domains and release units from evidence. A task spanning multiple components must state how they fit together and what will prove compatibility. Split by coherent responsibilities and independent writable areas, not file count or a universal frontend/backend template.

| Actual shape / changed surface | Questions to resolve | Evidence and validation intent |
|---|---|---|
| Single-process or modular monolith | Which module owns the invariant, state and transaction? | Native module/integration checks; preserve dependency direction and in-process semantics |
| Independently deployed services | Which versions, timeouts, ownership and partial failures must interoperate? | Contract tests, failure/retry scope, compatible rollout; no invented distributed SQL requirement |
| Event-driven jobs and queues | What are ordering, duplication, replay and schema guarantees? | Versioned events, idempotency/fencing where needed, poison-message/backpressure recovery |
| Serverless/managed execution | What persists across invocations? What are retry/lifecycle and timeout constraints? | Stateless/durable boundaries, repeated invocation and external effect checks |
| SDK/library/CLI/plugin | Who are consumers? What is the API/ABI/package/exit-code contract? | Supported target/consumer compatibility and artifact tests; deployment may be not applicable |
| Desktop/mobile/offline-first | How are resources, user state, local storage and synchronization owned? | Restart/offline/reconnect/conflict and supported device checks; no assumed always-on server |
| Native/resource-constrained runtime | What lifetimes, threads, memory/resource and ABI constraints apply? | Native sanitizers/static/target tests when adopted; resource recovery and measured budgets |
| Data/analytics/ML pipeline | What dataset/schema/time window/model version is consumed or produced? | Reproducible lineage, scoped backfills, data/evaluation leakage and recovery checks |
| Infrastructure/platform configuration | Which account/environment/state and exact planned changes are authorized? | Reviewed plan, blast radius, state ownership, drift/recovery; no implicit apply |
| Hybrid, multi-repository or legacy | Which boundaries cross stacks, repositories or release units? | Per-component checks plus dependency/consumer matrix and joint acceptance evidence |

Do not declare any architecture correct solely from an inventory or this table. A monorepo is a repository organization, not a deployment topology. Performance-critical, safety-critical or regulated work requires its actual domain-specific acceptance and human authorization; a generic checklist cannot certify it.

## Minimal sufficient coordination

At intake: establish one deliverable and acceptance conditions. Choose the minimum plan sufficient for the risk and coupling; small changes inside a large repository do not need a full design review. Separate unrelated work into new tasks rather than dragging old context into a new goal.

For cross-component work: name allowed paths, interface owners, change order, baseline versions, compatibility and integration evidence. Assign at most one writer per ownership area. Parallelize only independent work or isolate approved workspaces. Do not let testing observe a moving target and report it as a stable result; coordinate a revision/patch checkpoint.

At a stage boundary: review real diffs and affected consumer behavior, update only changed evidence, and escalate when evidence reveals complexity—not merely because the repository is large. At delivery: report which component/artifact versions were checked and what remains unknown. A required downstream check cannot be replaced by a unit test in a different component.
