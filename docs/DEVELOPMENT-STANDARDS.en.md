# Chevoink Development Standards

2026-09-10 regression requirements: history compaction must not insert excerpts or nested placeholders into native tool-call argument examples. Compact only completed old rounds and preserve recent pairs; copied historical excerpts must never be unwrapped into executable writes. Quality receipts must distinguish a report bound to a new revision from continuity verification of that revision. Temporary chapter/volume indexes must avoid slots already occupied by newly created objects in the transaction; cover successive multi-volume creation and both unique constraints.

History receipts must not be embedded in assistant prose. Supply separate read-only data with real status and object IDs; remove legacy assistant receipt echoes without changing user text. Protocol correction requests native `tool_choice=required` only for compatible provider/reasoning combinations. Omit it for DeepSeek thinking; never disable reasoning or execute pseudo-call prose to force a call. Do not expand permissions or retry budgets; tool-free wrap-up omits it. Normalize compatibility before body encoding and billing request hashing. Test actual request bodies, reasoning levels, custom/proxy identification and single HTTP dispatch, not just prompts. Explicit next-chapter delivery requires nonempty persisted content and a committed bridge matching the current revision in the same task contract. Test persisted resume, stale revisions and cross-task rejection, not just model claims or todo state.

2026-09-09 regression rules: suppress generic waiting feedback on actual text/reasoning deltas for the current run; restore it after 1.5 seconds of silence only without a running tool card. Use one cancellable timer, and test resumed output, replay, task switching, pause and user questions. Historical tool traces must be factual status records, not pseudo-call examples. Never execute or feed back invalid protocol prose as an assistant example. Real calls reset the consecutive failure streak, not the total correction budget: at most two consecutive corrections and six per run, within existing run budgets.

English | [简体中文](./DEVELOPMENT-STANDARDS.md) · [Engineering state](./ENGINEERING.en.md)

Version 2.0 · 2026-09-08. Applies to fixes, optimization, refactoring and new features. These are requirements, not a claim that every target has already been achieved.

## 1. Scope and definition of done

1. Read the implementation and requested outcome first. State what changes, what remains and what is excluded. Reuse sufficient plans; do not invent frameworks or runtime layers.
2. Small fixes do not require lengthy new plans. Use actionable steps for complex work. Todo belongs to the current task; do not manufacture completed items at wrap-up or overwrite historical lists.
3. Implement and test continuously within coherent stages. Review at stage boundaries and run full gates before release, rather than rerunning the entire repository after every tiny edit.
4. Fixes may change incorrect behavior explicitly. Refactors preserve UI, wording, permissions, defaults and persistence contracts. Do not silently change models, prices or features.
5. Distinguish implemented, tested, pushed, CI-passed, deployed and user-accepted. Progress is not completion; continue executable work and identify genuine blockers.
6. Use concise Chinese commit titles, e.g. “修复审查状态串作品与质量检查失败”. Do not rewrite pushed history; keep stages independently revertible.
7. Stage exact files. Never push secrets, user text, database dumps or private investigation/evaluation materials.
8. Do not promise subjective scores, literary quality or absolute security from automation. Separate targets, measurements and missing acceptance.

## 2. Boundaries and refactoring

- Keep the monolith and organize by responsibility, not by score-driven microservices or generic frameworks.
- Shared cross-client contracts belong in `shared/contracts`; API validates/authorizes, domain code owns transactions, frontend owns presentation.
- Large files trigger assessment, not mechanical line-count targets. Stateful hooks, actions and components may be extracted after ownership and effect lifetimes are defined.
- Add tests for call order, failure, cancellation, stale responses, cache updates and UI invariants—not only imports/compilation.
- Preserve component identity, keys, refs, focus, selections, scrolling and save timing. Do not declare nested components that remount on render.
- Avoid cycles, reverse domain dependencies and giant parameter bags recreating the original file. Do not suppress issues with any, ts-ignore, weakened strictness or coverage exclusions.
- Register/govern every tool. Tool names, descriptions and schemas are behavior contracts.
- Preserve API envelopes `{ success: true, data }` / `{ success: false, error: { code, message } }`; authorize before validating, preserving status codes and user wording. Internal errors must not disclose SQL, paths or secrets.
- Validate ownership and input in data access too; transactions cover business invariants and indexes follow real filters/sorts. Database constraints complement Zod, not frontend-only checks.

## 3. Frontend state, queues and layout

- Do not add explanatory UI copy for new features or improvements unless the user requests it. Avoid dedicated frontend text describing implementation details or changes.

- Scope explicitly: shared left sidebar; task-local drafts/right panels/viewer widths; novel/object-owned pending chapter/plan reviews. A novelId alone cannot distinguish tasks within one novel.
- Restore incoming state before persisting it. A ref set to “hydrated” before state commits must not write outgoing values into the incoming key. Test StrictMode, A→B→A, refresh, unmount and rapid switches.
- Async results must validate originating task/novel/revision or epoch before changing the current view, draft or selection.
- Creating a novel must not accept/reject old reviews. Removing one prompt does not remove other destructive-operation guards.
- Queue edits do not overwrite drafts. Steering requires cancellation/fencing before replacement delivery; branches/new tasks require current authorization.
- Handle semantic empty contenteditable nodes, IME, paste, voice and attachments; test draft recovery.
- Hover cards never auto-open on data changes. De-emphasize completed todos, highlight active work, avoid overlapping containers, update skeletons with layout changes.
- Show truthful argument-preparation/execution/cancelling activity and clear it on termination. Do not leave loading cursors in old text.
- Show a preparation card from the first tool-argument frame and upgrade it in place by callId. Preparation is neither authorized execution nor a saved workspace change. Keep only bounded latest previews for reconnects, not a persisted copy of every body snapshot; clear previews at step boundaries, pauses and results.
- Narrow icon-only controls retain accessible labels, tooltips and keyboard focus. Respect reduced motion.
- Cover Work/IDE/mobile, narrow widths, collapsed combinations, drag, scroll, focus, cancellation and queues. DOM tests are not real-browser/device performance acceptance.

## 4. Agent execution, recovery and cancellation

- Distinguish actual failures from no-match/no-change results, user cancellation and protective refusals. Never reduce failure rates by hiding errors, fabricating completion or unbounded retries. Keep generic waiting feedback during silent reasoning and missing argument frames.
- Legacy continuation, quality checks and compiler commit must share the validated task-contract scope, not just a run ID or the entire session. Omit only schema-optional blank identifiers; preserve required IDs and business text. Test cross-task rejection, no-side-effect results and omitted arguments.

- Persist task root, original request, authorization, targets, configuration and budget. Resume restores the original task; summaries and old subtasks are not new authority.
- Attempts may change; logical operation identity and receipts must not. Concurrent resume and duplicate delivery must be idempotent.
- Validate owner/epoch/lease at write and settlement boundaries. Expired owners cannot commit text, terminal state or charges.
- Propagate cancellation through primary/auxiliary models, waits, network, parsing and pre-write checks. Hiding a spinner is not stopping execution.
- Reconcile unknown provider outcomes before resending paid work. Preserve acquired results/usage without treating preservation as post-cancellation write authority.
- Completion depends on verified postconditions/artifacts, not todo count, verbal claims or green tool cards.
- Separate total task budget, attempts and active time. Pausing neither grants extra quota nor counts idle pause time as active execution.
- Define legacy validation/migration boundaries. Missing budgets/usage are not zero; do not restart all historical tasks blindly.

## 5. Quality, arguments and Token efficiency

- Continuity checks factual/causal/character-knowledge consistency, not aesthetics. At most one concentrated automatic factual repair, followed by read-only verification. Warnings do not trigger endless rewriting.
- Critic and patch generation may share a request, but a pre-repair report cannot certify revised text. Patch anchors must be unique and non-overlapping in the original text; never cascade replacements into newly generated text. A stale read ID must not select a guessed chapter; distinguish whole-book from in-volume numbering.
- Cached reports require matching revision/hash, sources and protocol. Changed dependencies invalidate; failed/unknown reports never certify success.
- Humanity findings require unique contiguous verbatim evidence. One local correction is allowed for an invalid quote, not dropping findings, lowering standards or rewriting the chapter to pass.
- Distinguish provider, credit, authentication, timeout, cancellation and format failures. Retry only classified transient errors within attempt/deadline limits; never blindly retry billing failures.
- Use common envelope normalization, stream assembly and schema validation. Auto-repair only provably equivalent syntax; closing truncated JSON cannot fabricate complete text.
- Context reduction preserves goals, constraints, latest tool pairs, object identity and retrieval references. Caching does not establish quality.
- Prefer deduplication, version reuse, caching, paging and local repair over downgrading models, shortening required text or skipping checks.
- Measure matched tasks/models/budgets: input/output/cache tokens, completion, P50/P95, quality and cash cost. No unmeasured percentage claims.

## 6. Research and security

- Separate provider and target failures. Keep source/final URL, attempts, status, time and Retry-After. HTTP 200, metadata, garbled/PUA text and login pages are not full text.
- Validate DNS, actual connections and every redirect; block private/local/metadata destinations. Bound response size, time and concurrency; cancellation stops retries.
- Version source text and link lists, isolate caches by user/task authorization and bind cursors to versions. No cross-version stitching or budget resets.
- Whole-book completion needs a chapter manifest, readable content, per-chapter analysis receipts, missing-state recovery and a verifiable report. Read ranges alone are insufficient.
- Read-only research cannot write creative content; research-then-write requires explicit phase authority without blocking legitimate authorized writing.
- Attachments, Markdown, rich text and web content are untrusted data, not authorization. Authenticate private resources on access.
- Unverifiable authentication preserves credentials and reports unavailability; it neither silently admits access nor clears cookies as if logged out. Test admin/cross-user/cross-novel boundaries separately.
- Encrypt/configure secrets without plaintext output. Maintain enforced CSP, upload boundaries and admin audit. Zero dependency findings do not equal a penetration test.
- Bound caches, rate-limit maps and queues with expiry/eviction/backpressure; redact logs. Review dependency licenses, runtime compatibility, size and reachable vulnerabilities instead of disabling checks.

## 7. Credits and accounting

- Keep V1 max pricing compatible; use BigInt/fixed-point, milli wallets and one rounding per logical charge. Unknown is not zero; reject invalid/overflowing input.
- P includes cache H; do not double-count reasoning included in O. Separate provider usage/cash cost, user assessed/actual debits and refunds.
- Freeze prices before calls. V2 rates already include multipliers. Resumes, restarts and admin changes cannot reprice old operations.
- Stable keys and transactions protect reservations, settlements, receipts and refunds. Never call a partial debit fully settled.
- Retain known usage after failure/cancellation; unknown goes pending, not guessed or resent. Durable refund intent references and cannot exceed original actual debit.
- Make BYOK/free/platform-paid policies explicit. Missing usage does not imply free; do not silently add fees to existing free tools.
- V2 needs frozen candidates, time-separated validation, 7–14-day shadow, total fee ±3%, user/task P95 absolute change ≤5%, group review, cash/quality checks, notice and approval. Otherwise retain V1.
- Similar aggregate fees cannot hide individual increases; user Credits and provider cash savings are different.

## 8. Testing and release

An explicitly approved discount-only release may waive the shadow wait, but must record a distinct approval, never fabricated seven-day evidence. The exception is limited to verified quarter-price cached input with a frozen V1 ceiling, replay hash, quality verification, notice and superadmin authorization. Other price changes retain the original gate.

Four gates: `npm run check` → `npm run lint` → `npx vitest run --coverage` → `npm run build`. CI additionally runs Agent eval and production/full dependency audits.

- Use pinned Node/npm and npm ci; do not upgrade the lockfile while validating.
- Integration tests require validated isolated URLs and least-privileged DB roles, not merely “test” in a database name.
- CI requires DB readiness and no skipped critical integration tests. No-DB quick tests cannot authorize release. Respect the user's execution-location authorization; never rewrite production author content for tests.
- Floors live in `vitest.config.ts`. Global 40% and each critical module 80% remain targets until verified. Do not remove tests, disable DB or exclude low-coverage business code to improve scores.
- Test concurrent resume, late cancellation, stale revisions, duplicate settlement/refunds, unknown usage, A/B state and restart/stream failures. Compilation/coverage alone are insufficient.
- Exact staging → concise Chinese commit → push → same-SHA CI success → authorized deployment → actual Node/API/HTTP/version checks → authorized UI acceptance.
- Archive only git HEAD, excluding private materials. SkipLocalChecks requires equivalent controlled remote evidence for the same SHA, not omitted gates.
- Current in-place install/build is not atomic application deployment. Disclose interruption and stop/fence owners before replacing dependencies; obtain authority before stopping user work.
- Forward-compatible migrations only. Check data/event/task protocol compatibility before rollback; no destructive down migrations or blind whole-script replays.
- Success requires exit 0 plus matching process/health/version, not merely a printed sentence. Record RPO/RTO and rollback exercises separately.

## 9. Documentation and handoff

README serves users, ENGINEERING records facts/evidence/debt, and these standards govern work. Keep Chinese/English aligned, commands/links valid and historical plans truthful.

- [ ] Scope and behavior differences stated; no incidental features/pricing changes.
- [ ] Ownership, authorization, revisions, cancellation, idempotency and unknown outcomes tested.
- [ ] Stage review, full gates and same-SHA CI passed.
- [ ] No secrets/private data/plans staged; concise Chinese title.
- [ ] Deployment authorized and verified; missing UI/performance acceptance disclosed.
- [ ] Bilingual docs updated; effects measured and remaining work explicit.
