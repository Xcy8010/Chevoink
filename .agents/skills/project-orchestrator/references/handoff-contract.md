# Durable handoff contract

## Layout

```text
.codex/context/
  GUARDIAN.json
  CURRENT.md
  PROJECT.md
  DECISIONS.md
  VALIDATION.md
  DEBUG.md
  archive/
  .runtime/
```

`.runtime/` is machine state and should be ignored by Git. The human-readable files may be committed or kept local according to project policy.

## CURRENT.md

Purpose: smallest complete resumable state for the one current deliverable.

Target: keep it comfortably below **12 KiB / 150 lines**. Warn above that. Treat **24 KiB / 300 lines** as a hard maintenance threshold: archive stale material and rewrite the current snapshot instead of growing indefinitely.

Required content:
- YAML front matter: `status`, `task_id`, `updated_at`;
- primary goal and concrete deliverable;
- acceptance target or pointers;
- current verified state;
- completed current slice;
- immediate next action;
- active files/symbols;
- Relevant Reading Map;
- blockers / unknowns;
- do-not-repeat notes;
- last stable checkpoint and verification summary.

Never paste the full chat transcript or large command logs.

## PROJECT.md

Stable orientation only: project map, runtime/toolchain, important commands, conventions, architecture boundaries, quality gates, deployment rules, high-risk areas. Remove stale facts when verified obsolete.

## DECISIONS.md

Use compact decision records. Each record should include:
- ID/date;
- status: `active`, `superseded`, `revoked`, or `archived`;
- decision;
- reason;
- evidence/pointers;
- invalidation/review condition when relevant.

Only `active` decisions should be assumed during normal recovery.

## VALIDATION.md

Keep concise rows. Include command/check, result, SHA/branch when relevant, and caveat. Archive old unrelated validation. Do not paste full logs.

## DEBUG.md

Only unresolved difficult debugging state belongs here. When a defect is resolved, archive or clear the active section so future agents do not mistake old hypotheses for current ones.

## Archive

Archive exists for historical evidence. It is not loaded on normal startup. Store timestamped snapshots before major replacement when history may be useful.

## Handoff quality test

A fresh agent should be able to read project instructions + `CURRENT.md`, inspect the current repo, and answer within a few minutes:
- What is the primary goal?
- What is already verified?
- What is the immediate next action?
- Which files are active?
- Which decision/debug/validation fragments matter?
- What must not be repeated?
- What remains unknown?

If not, repair the handoff instead of adding more transcript text.

## User-facing delivery

A fresh-task recommendation is complete only when the same response includes a reviewed, copyable prompt in a fenced text block. Write it in the user's language. A saved file/link may accompany the block, but does not replace it.

Before delivery, save the current checkpoint and compare it with actual Git/source and pending operation results. `scripts/handoff-prompt.mjs --repo <repo>` prints a read-only startup index with repository/checkpoint paths and observed metadata; it does not summarize or verify the task. Add only the compact task-specific facts needed to recover:
- selected repository and checkpoint entry point;
- completed and verified work, with essential revision/evidence pointers;
- the next authorized action, or an explicit statement that the prior work is complete and a new goal is needed;
- live operations, unknown outcomes and remaining limits where applicable;
- original authority, protected scope and do-not-replay instructions.

Do not paste credentials, private user content or long logs. Do not turn a previously failed check into a pass or treat a stale receipt as live state. The prompt grants no new authority, resets no budget and must not automatically create a task. If the generator cannot run, prepare the same concise prompt manually and state any unverified fields as unknown. When the user chooses to stay, honor that choice without repeated warnings.

## v3.2: preserve scope, not just progress

CURRENT also carries pointers to original authorization, object/task/revision/epoch, logical operation/receipt identity and remaining or unknown budgets. A recovery must not expand permissions, repeat a settled side effect or execute historical tool excerpts. Include applicable rule IDs, local standard/profile source fingerprints and pending external outcomes. Do not serialize credentials or private user content.

PROJECT-PROFILE.json is a local metadata record, not a Codex configuration extension. Schema is in schemas/project-profile.schema.json in the installed skill. profile-check validates structure/fingerprints, not semantic correctness, gate execution or release approval. Existing v3.0 files are preserved by bootstrap; merge missing fields after reading them.

Only one main writer owns a shared CURRENT at a time. Separate worktrees or explicit per-task state are needed for simultaneous independent tasks; this single-snapshot helper does not implement concurrent task merging.
