# Cost and quality evaluation

Evaluate cost per task that passes the same acceptance gate.

Track when available:
- Astra / Sol / Luna calls;
- model/effort escalations and reasons;
- approximate usage shown by the host (`unknown` when not visible);
- retries and whether they produced new evidence;
- implementation rejections and causes;
- deterministic verification results;
- number of compactions and fresh-task handoffs;
- regressions, rollbacks, or hotfixes after release.

## Useful comparison

Compare similar task samples under the same quality gates. A workflow that consumes fewer tokens but creates more rework, regressions, or context recovery failures is not cheaper in the sense this skill optimizes.

## Anti-patterns

- multiple agents rereading the whole repo;
- copying full logs into the main thread;
- multiple writers editing the same ownership area;
- continuing unrelated deliverables in one heavily compacted thread;
- escalating reasoning because information is missing rather than because reasoning is hard;
- calling build success proof of behavioral correctness;
- claiming deployment without exact-SHA verification.


## Real-host acceptance scenarios — planned, not reported as executed

After script tests, verify these in the actual Codex installation:

1. Confirm the skill is discovered once, po_* roles are registered, and requested model/effort is truly selected by the host.
2. Use representative different project shapes; read each project's local standards separately and verify it does not inherit another project's commands, architecture or rules. Fixture inventories do not prove this semantic behavior.
3. Changing a local standard/CI manifest causes affected assumptions to be revalidated; a hash pass never means tests passed.
4. A normal correction stays in the same task; an unrelated deliverable gets one useful boundary suggestion, honoring the user's choice to remain.
5. A real trusted compaction event produces bounded telemetry; fresh recovery preserves original authority/targets/revision/budget and does not replay a completed external effect.
6. Luna cannot turn a missing/failed verification into approval; Astra inspects actual diff and evidence on the checked revision.
7. Optional modules are skipped when unrelated. A library need not deploy a server; an offline system need not acquire a database, cloud service or billing mechanism.
8. Cross-session concurrent work does not overwrite another primary task's checkpoint.

Record host/version, model evidence, artifact revision, scenario outcome and untested caveats. Script tests cannot certify these model behaviors or a fixed savings percentage.
