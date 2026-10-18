# REL — Verification, release and truthful receipts

Apply the target project's actual quality gates. A CLI library/package may publish an artifact rather than run a server; a distributed deployment may have many verified units. No universal npm commands, coverage percentages or deploy style.

## REL-01 Progressive validation

For a small edit run the smallest meaningful behavioral/static checks. At a coherent stage run affected integration/contract checks. Before an authorized release run all required release gates and the appropriate same-revision CI. Inspect toolchain pins, lockfiles, CI and test config; use reproducible dependencies without updating a lockfile merely to validate. Do not run another ecosystem's commands.

Batch related changes and known fixture adaptations before validation. Select local/remote gate location early. Where project policy permits controlled same-revision CI equivalence, prefer that single full release run to duplicating an expensive local full run. A new receipt, summary or test-only correction is not itself a reason to repeat green checks; rerun affected checks and finish actual final-version gates. Preserve local failures and validate equivalent environment, dependencies, required zero skips and unchanged thresholds.

If a local gate cannot run, report not-run/blocked and the reason. Equivalent controlled remote evidence is allowed only where project policy permits, for the same revision, checks, environment assumptions and dependencies—not as an omitted gate. A no-database unit run cannot certify mandatory DB integration. Validate isolation with actual target and least-privileged credentials, not the word "test" in a name. Never mutate production user content for tests.

## REL-02 Required failure coverage follows risk

Where applicable cover task/tenant ownership, validation and no-side-effect denial, stale revisions, concurrent/duplicate delivery, late cancellation, rollback/restart, stream/format failures and accounting unknowns. Add behavior-level tests to refactors. Compilation, coverage or a green CI job alone cannot prove interaction, device, load or full security acceptance. Keep thresholds from the local project; targets are not measured achievements.

## REL-03 Evidence contract

For every consequential check record:
- exact reviewed command/check and cwd;
- permitted environment and toolchain/config identity;
- source SHA plus dirty patch/artifact fingerprint when relevant;
- exit/status, passed/failed/not-run/unavailable, missing or skipped checks;
- result artifact/log pointer with secrets redacted, timestamp and limitations.

A test report must bind to the actual implementation version. Re-run affected checks after changes, not checks unaffected by them. Keep detailed identities/log pointers in one ledger and a compact pointer in the checkpoint. Same-SHA alone may be insufficient if the artifact, dependencies or deployment configuration changed; confirm those identities too. Human/visual acceptance remains distinct.

## REL-04 Proportionate release

An independent reviewer checks changed high-risk boundaries once against the coherent diff, rules and evidence. The primary or a scoped operator can execute the maintained entrypoint under existing authorization; a mandatory reviewer/operator relay or long template ticket adds no assurance to unchanged routine steps. A compact contract binds the candidate SHA, target, authorized restart/migration and unresolved outcomes. Record implemented/tested/committed/pushed/CI-passed/deployed/user-accepted separately. Stage exact files; never force-push or include secrets/private data.

A precise accepted release ticket covers its ordered authorized operations. Do not add a fresh approval or full-source review for every unchanged step. A changed target, command, protected invariant or unreconciled outcome invalidates only the affected operation. Ordinary reversible edits and associated checks do not require this production-release ticket.

Prefer offline preparation of a committed release before replacing the running directory. This project's user permits an ordinary necessary API restart immediately after CI, even with online tasks; do not wait for task completion, add an idle/drain window or treat task/usage changes from normal recovery as deployment failure. This does not authorize task cancellation APIs, user data deletion, credits/usage reset or unknown paid request replay. Keep migrations forward-compatible and separately review changed schema/recovery. Avoid automatic replay of any whole production mutation; inspect the journal and actual target after a failed or interrupted command.

## REL-05 Verify the actual target

A success sentence is not evidence. Require exit status and the expected artifact digest/process/runtime, health/API/HTTP/version checks as relevant to the release model, plus authorized UI acceptance where needed. Record remaining risks and missing acceptance. RPO/RTO targets and measured recovery/rollback exercises are different facts. Archive only approved revision-bound materials, excluding private data.
