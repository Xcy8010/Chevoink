---
name: project-orchestrator
description: Coordinate substantial software work with bounded context, selective delegation, proportionate verification and safe releases. Handle narrow corrections directly; orchestrate when coupling or risk warrants it.
---

# Project Orchestrator 3.5

Optimize time and cost to the accepted result. The project owns its architecture, business rules and mandatory gates; this skill must not add a second bureaucracy. User instructions and existing authorization take precedence.

## Start cheaply

Read effective instructions, the current request, CURRENT.md when present, and actual branch/HEAD/dirty state. Follow only task-relevant source and evidence pointers; do not load archive, old conversations or the whole standards library by default. Reuse verified project knowledge unless the relevant source or assumption changed.

For an unfamiliar stack or changed architecture, use references/stack-adaptation.md and references/architecture-adaptation.md as needed. Read scoped local standards with references/local-standards.md; conditional rules are indexed in references/engineering-standards.md. Existing state does not need re-bootstrap. Inspection/profile scripts supply missing evidence, not startup rituals.

For every new Codex task in this project, set its title to `Chevoink动作丨简短主题`, for example `Chevoink修复丨任务命名` or `Chevoink优化丨CI提速`. Use the current-task title tool when available; include the suggested title in a handoff. Choose the action from the actual request and keep one clear topic. This is the Codex task title, separate from names inside the product. Do not create a new task automatically.

## Choose the smallest workflow

- **Narrow correction:** implement directly, inspect the diff and run the smallest meaningful check. No obligatory subagent, contract template, independent approval or release ticket for an ordinary reversible edit.
- **Coupled implementation:** agree on one compact contract, give a writer clear ownership, batch related implementation and test updates, then validate the affected group.
- **High-risk boundary:** use an independent reviewer for authorization, billing, migration, durable state or production mutations. Review the coherent change once; return only a changed risk or unresolved finding for another review.

Do not choose a heavier mode solely because many files exist. A necessary correction to ongoing work stays in that work. Templates supply missing structure, not mandatory forms for every edit. Omit irrelevant fields; unknown facts remain unknown.

## Deliver a coherent batch

1. Establish outcome, non-goals, current authorization, owned files, protected invariants and affected checks. Reuse the existing tracker instead of parallel plans.
2. Complete related code and known fixture/contract adaptations before running the group. Find affected test consumers up front when a shared contract changes; do not rediscover them one failing file at a time.
3. Run the smallest checks that can disprove the change. Classify failures by common cause and repair a confirmed class together. Preserve negative checks and actual failing evidence; do not weaken assertions, thresholds or timeouts to obtain green results.
4. Re-run only checks affected by new edits or unresolved evidence. A passing check is not repeated for a new filename list, receipt, summary or unchanged source. Do not rerun the whole suite after a test-only correction when affected checks and permitted same-revision CI cover it.
5. At a stable stage, consolidate review, evidence and checkpoint updates. Continue authorized commit/push/CI/release without another permission question when that authority already exists.

Read references/workflow.md only when more detail is needed. After two failures of the same hypothesis, change the diagnostic approach using new evidence; do not create unchanged retry or repeated review loops.

## Delegate only when it helps

Routing preferences remain Astra for decisions/acceptance, Sol for implementation, and Luna for scoped verification/approved operations; see references/model-routing.md. Preserve configured efforts and actual host capabilities. These preferences do not change product settings or authorize paid usage.

Default to the primary doing a narrow task. For separable work, use at most two independent subthreads, one writer per area and no recursive delegation. A writer can run its own approved associated checks; a verifier helps with expensive gates or independent evidence, not as a mandatory relay. Reuse existing agents and compact evidence instead of full logs or repeated repository reconnaissance.

## Validate and release once per relevant version

Read references/standards/verification-release.md for release or consequential quality claims. Decide the validation location early. Required gates run once on the candidate version; when project policy permits controlled same-SHA CI as an equivalent, use it for full release gates instead of automatically duplicating a slow local full run. Preserve local failures and require actual CI outcomes, environment, dependencies, required zero skips and unchanged thresholds. Equivalent evidence is a completed gate, never an omitted one.

Use clean snapshots, new environment provisioning and exhaustive artifact hashes only when they resolve a concrete isolation, reproducibility or release-identity risk. Reuse a verified test environment; do not migrate, reset or reinstall it for each slice.

Use the maintained project deployment entrypoint instead of rebuilding a one-off release framework. After the authorized candidate's CI passes, proceed directly to deployment; this project's user explicitly permits the necessary ordinary API restart without waiting for online tasks to finish. Do not add idle/drain windows, user-row snapshots, another full test run, or fresh per-command approval. Routine compatible-schema releases need a single version/target check, offline preparation, normal switch/restart and actual health/version verification. Review schema, permissions, billing or recovery changes separately when they occur.

Independent high-risk review and precise operations remain mandatory where applicable. A compact accepted operation contract covers its ordered steps; a long ticket or a different execution agent is not required. Reconcile unknown external outcomes before retrying; never retry the whole production mutation automatically. Task cancellation, data deletion, permission changes and pushed-history rewriting require their own authority. Stage exact files; exclude secrets, user content and private investigation artifacts.

Distinguish implemented, tested, committed, pushed, CI-passed, deployed and user-accepted. Record command/environment/version, result and artifact pointer once for consequential checks. A success message is not an observed postcondition.

## Keep context small and useful

The primary alone updates shared .codex/context. CURRENT.md is a compact index of authority, actual version, owners, pending outcomes and next action; logs/hashes belong in VALIDATION.md, diagnoses in DEBUG.md, decisions in DECISIONS.md. Update at meaningful state changes, before risky external actions and before recovery/handoff; do not rewrite every ledger after each small edit or poll. Reuse receipts instead of copying details into multiple documents. Soft size limits guide compaction, not repeated failed checkpoint attempts or extra approval gates.

Context Guardian thresholds remain 0 GREEN, 1 YELLOW, 2+ RED observed compactions; see references/context-lifecycle.md. At RED finish/reconcile the nearest safe slice and recommend a fresh task before independent work. Honor an explicit choice to stay without repeated warnings. Telemetry never resets authorization, budgets or task identity.

Whenever recommending a fresh task or providing a requested handoff, first verify/save the checkpoint and include the **complete copyable handoff prompt in the same response**. Include full repository/checkpoint paths, verified progress, immediate next action, pending outcomes and authorization limits in the user's language. A link or an offer to send it later is insufficient. scripts/handoff-prompt.mjs --repo <repo> is a read-only helper; use references/handoff-contract.md for the checklist. Never create a task automatically or replay a completed operation.

Use freshness/research references only for facts that affect the current decision. This skill promises neither identical model output nor a fixed saving; assess the actual accepted result.
