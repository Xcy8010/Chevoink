# Novel import: implementation status and boundaries

[简体中文](./NOVEL_IMPORT.md)

2026-09-14: this describes the current implementation of [plan 32](../plan/32-作品一键导入与文档解析产品级实施方案.md), **not release, production enablement or complete acceptance**. Additional local testing has stopped; remote CI is next. Same-SHA native CI remains unverified, and Web/Windows/Android real-device interaction acceptance is outstanding. No production or server QA was performed. The release owner will add deployment and acceptance evidence.

## Implemented workflow

- Work/IDE and mobile menus open the shared panel for upload, durable job lookup, cancellation, preview editing, commit and restore receipts, including source filename and size.
- Deterministic TXT/Markdown/DOCX/ZIP parsing and PDF page-text reports support encoding selection, renaming, ordering, volume reassignment, splitting and lossless adjacent same-source merging.
- Reports retain stable page, block, member and image identifiers. Completeness issues must be resolved or explicitly excluded with reasons where supported. Partial imports remain marked in receipts with a retained report, not described as complete-book success.
- Private sources, previews and normalized images are durable and hash-checked. Long bodies load by chapter and preview revision; saving structure must not overwrite unloaded text with empty strings.
- Parsing runs outside the API event loop with resource, content-size, deadline and cancellation bounds. A Node Worker is resource isolation, not an OS sandbox. DOC/offline OCR use a separate constrained Docker native worker.

## Overwrite, public snapshots and restore

Import is no longer limited to empty novels. The main flag allows empty-novel import; replacing existing chapters additionally requires the overwrite flag, shared human double confirmation and approval of the exact preview. Existing empty volumes are retained when there are no chapters, with new volumes appended.

A short transaction validates ownership, source hash, preview revision/hash, target version and expiring approval. Novel locks, active-row predicates, revisions and affected-row counts protect writes. Original chapters/volumes retain their IDs and are archived; new chapters are **private drafts**, never automatically published. Existing public snapshots, reading IDs, ordering and progress must remain available: blindly adding active filters to public snapshot queries would hide published content. Author structure, editing, ordering, export and creative counts use active rows; published statistics/dates remain separate.

Import advances manuscript generation and invalidates old source-derived state. Concurrent writers and stale Agent/background results must not write back to archived sources. These protections are implemented, not evidence that every historical write path has passed remote acceptance.

Each commit stores a unique backup and durable receipt; identical approval/idempotency-key replay does not duplicate chapters. Restore offers a separate impact preview, human confirmation and persistent available/restored/expired/conflict status, with a 30-day backup window. It checks the post-import baseline and retained records, archives imported rows and restores original IDs. Subsequent edits, publication or original-version drift block restore; there is no force-overwrite recovery. Restore receipts remain separate from the original import receipt. Disabling new imports does not disable authenticated access, cancellation or recovery of existing jobs.

## Agent and chat attachments

`novel_import` now registers durable `prepare/status/commit`, not just prepare. Prepare accepts a real attachment from the current user turn and persists an event linking to the shared human panel. Commit waits for actual database-backed human approval, rechecks origin, current operation, lease, policy and target version, then calls the core service.

**Model parameters, generic allow decisions and ordinary tool approvals cannot replace human double confirmation or mint import approval.** Waiting state, the panel link and receipts survive replay; restart must not duplicate commits. Success, cancellation or timeout ends the old waiting chain and requires subsequent input. Closing the panel alone is not cancellation. Non-durable execution rejects prepare/commit instead of falling back to unguarded writes.

Chat now accepts DOC/ZIP with extension and signature checks. Upload does not extract archives or invoke native converters; `read_file` directs these files to the dedicated import flow. Chat limits remain PDF 10 MiB and DOC/ZIP/other non-PDF documents 5 MiB, separate from the import panel's 50 MiB source limit.

## Optional, budgeted AI structure suggestions

Deterministic parsing does not invoke AI or charge model quota. Optional AI suggestions are connected: the user reviews the model and budget before confirming. Each request analyzes one selected chapter of at most 7,000 characters, without truncating text or automatically rewriting/applying manuscript content. Basic routing uses low reasoning; custom routing uses only the explicitly selected model for this import. Configuration or pricing fingerprint changes require renewed confirmation, with no silent fallback.

Each job permits at most **four** durable suggestion requests, each capped at **8,000 input / 2,000 output tokens**. The budget validator additionally defines job ceilings of 40,000 input / 8,000 output tokens; the four-request and per-request limits still apply. Failed or uncertain requests do not gain extra attempts through replay. The same request reuses its record; process loss or an unknown provider outcome does not automatically retry a potentially paid call. Basic calls use existing quota reservation and usage settlement. Custom models do not consume platform model quota, but the external provider may charge. Cancellation or preview changes abort requests; late results are never automatically applied.

## Private resources, public covers and outbox

Sources, previews, reports and extracted images use owner-authenticated routes and private storage, by default in `private-novel-imports` outside the project. They are not mapped to static public/uploads, and internal paths are not exposed.

**Explicitly selecting an image as the novel cover makes it a public asset.** Once selected and confirmed, the normalized cover enters the existing public cover channel after commit. Do not promise that it remains a private attachment. Unselected sources and extracted images are not published with it. Candidates must belong to the current job and pass hash, type and size checks.

Commit/restore and side effects are separate. A bounded durable outbox consumer records unique events, projects directory/metadata/memory/search refresh state, promotes covers and refreshes reading-record metadata. Failures remain pending for later maintenance retries. It does not repeat manuscript mutations, start paid memory extraction or overwrite a newer user-selected cover. `effects.status = published` means the side-effect event was delivered, **not chapter publication or product deployment**. The UI refreshes through receipt or status replay.

## Deployment and operations

| Configuration | Boundary |
| --- | --- |
| `NOVEL_IMPORT_ENABLED=true` | New-import flag; defaults off, explicitly enabled by the deployment owner |
| `NOVEL_IMPORT_OVERWRITE_ENABLED=true` | Requires the main flag to replace existing chapters; never bypasses confirmation or transaction guards |
| `NOVEL_IMPORT_NATIVE_ENABLED=true` | Explicit native opt-in; currently remains off pending acceptance |
| `DOCUMENT_IMPORT_WORKER_IMAGE` / `DOCUMENT_IMPORT_WORKER_STAGING_ROOT` | Native image and isolated staging configuration; real readiness must also pass |
| `NOVEL_IMPORT_MAINTENANCE_ENABLED` | Follows the main flag when unset; explicitly configure it to continue cleanup/outbox while new imports are disabled |

DOC depends on real worker readiness. PDF text extraction does not require native; scanned/OCR processing does. An enabled but unhealthy native path fails closed instead of presenting incomplete fallback as success. Readiness is not quality or isolation acceptance. Same-SHA native CI (`.github/workflows/document-import-native.yml`) is still unverified; this documentation does not enable any flag.

Back up the database and private storage together. Uncommitted sources/previews normally expire after seven days; committed/backup references and valid parsing leases are excluded from temporary cleanup. Cleanup consumes exact unreferenced keys, keeps failures for retry and never recursively deletes a shared root.

Initial limits include ten jobs per user per rolling 24 hours and 250 MiB uploaded, reserving 50 MiB for active uploads. Each job permits 64 preview revisions and retains the latest two; a garbage backlog of 100 blocks new previews. These are protective limits, not throughput benchmarks. The Nginx template limits 50 MiB streaming to exact source routes; other API routes retain 40 MiB. Actual server configuration is unverified; no server QA is being run here.

Deploy the complete migration chain, including archive fields, active-row partial unique indexes, approvals, receipts and outbox. Do not replace migrations/indexes with `prisma db push`, or roll back to archive-unaware services. Migrations, private-storage permissions, maintenance consumers and flags are separate deployment checks; implemented code does not establish that production configuration is active.

## Outstanding acceptance evidence

Historical isolated local PostgreSQL, least-privilege-role and synthetic-fixture results are in the [phase validation record](../plan/evidence/32-novel-import-local-validation-2026-09-13.md). Historical totals are not evidence for the final SHA. No further local tests are being started or added under the latest instruction; remote same-SHA CI is next.

Outstanding evidence includes complete remote checks, same-SHA native CI, native DOC/OCR quality and resource results, Web/Windows/Android real-device interaction, actual deployment/flag state, and release validation of overwrite/restore with public-reading retention. Do not use production files or servers for unauthorized verification. Until evidence is complete, do not claim release or full plan-32 acceptance.
