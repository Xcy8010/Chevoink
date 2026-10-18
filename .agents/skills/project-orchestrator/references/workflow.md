# Engineering workflow v3.5

## A. Bootstrap

For medium/large work, first collect only what the task needs:
1. effective project instructions;
2. branch / HEAD / dirty state;
3. current `CURRENT.md` when Context Guardian is enabled;
4. relevant project plan/spec and test entry points;
5. the modules touched by the request;
6. current official product/model/config facts only when they affect execution.

Do not read the entire repository or all documentation “for safety”.

## B. Routing labels

- `DECISION-M`: Astra medium
- `DECISION-H`: Astra high
- `DECISION-XH`: Astra xhigh
- `CODE-H`: Sol high bounded implementation
- `CODE-DEEP-H`: Sol high complex implementation contract
- `CODE-XH`: Sol xhigh
- `SCOUT-H`: Luna high
- `VERIFY-H`: Luna high
- `REVIEW-H`: Astra high independent review
- `RELEASE-H`: Luna high approved operations

These labels select responsibilities, not mandatory agents. The primary handles a narrow correction. Use a writer for coupled work and a separate verifier only when expensive gates or independent evidence justify the handoff. Preserve configured model/effort defaults.

## C. Standard loop

1. Establish one compact outcome/ownership/authorization/invariants/checks contract; reuse existing project state and rule packets.
2. Batch related implementation and known test-consumer updates. Do not add a separate review or validation round for each file or small assertion edit.
3. Run associated checks as a group. Classify failures by shared cause, fix the confirmed class and rerun affected checks only after new evidence or edits.
4. Inspect the coherent diff once. Independent review follows actual high-risk boundaries; repeat only for changed risks or unresolved findings, not the entire accepted source.
5. Run required final gates once per candidate. Decide early whether project-permitted same-revision controlled CI supplies full release gates; do not automatically duplicate the full local suite and CI.
6. Persist a compact stable checkpoint, then complete authorized commit/push/CI/deployment through the maintained entrypoint. CI-passed routine releases proceed directly, without another full test run or waiting for online tasks. Preserve unknown outcomes and target identity; no whole-mutation retries. One compact operation contract and one changed-risk review suffice; do not generate per-command tickets or mandatory agent relays.

Successful evidence survives unrelated fixture or documentation edits when its code, dependencies, configuration and relevant assumptions are unchanged. It cannot certify changed behavior. Local failures remain failed even when an actual same-version remote equivalent subsequently satisfies release policy.

## D. Context loop

Before accepting a new independent deliverable:
1. check current `CURRENT.md` status;
2. check observed compaction state if Context Guardian is enabled;
3. if current work is active, decide whether the new request is clarification/subtask vs independent deliverable;
4. for an independent deliverable, persist the current state and recommend a fresh task;
5. on a fresh task, recover index-first and verify against current Git/source.

## E. Debug loop

1. write one falsifiable root-cause hypothesis;
2. define the smallest discriminating test;
3. make the coherent owning changes for that failure class;
4. rerun the smallest affected evidence, not all previously green gates;
5. if the same hypothesis fails twice, record the disproved route and choose a new discriminating check. Obtain another reviewer only if unresolved risk warrants it.

## F. Concurrency

Default max: one main Astra + two subthreads. Parallelize only when ownership is disjoint and results can be independently verified. Do not have multiple code-writing agents modify the same files or shared external state in parallel.

## G. High-risk review

Use an independent reviewer for changed schema/migration/durable state, auth/permissions/billing, concurrency/idempotency/cancellation/retry, destructive operations, production release configuration, or risks hard to cover with tests. Reuse a completed review when that boundary is unchanged. An ordinary label or faithful fixture adaptation does not become high-risk merely because it lives in a high-risk module.

## H. Closeout

Before claiming completion:
- inspect real diff;
- run relevant checks;
- update CURRENT/VALIDATION/DEBUG/DECISIONS as applicable;
- state untested areas and residual risks;
- distinguish implementation from commit/push/CI/deployment/runtime verification;
- when the next work is independent and the thread is long/YELLOW/RED, generate a fresh-task handoff prompt.

## I. Local requirements and portability

Read the current project's scoped standards separately. Pass only the relevant rule/source packet to each child; never install a copy into the global skill. Confirm component/consumer boundaries with `architecture-adaptation.md`, select applicable conditional modules, and preserve local native gates. Names, remotes and old profile labels cannot select project rules. Resolve conflicts for the affected step rather than importing another project's assumptions.
