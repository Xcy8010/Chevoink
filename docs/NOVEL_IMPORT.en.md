# Novel import: implementation status and boundaries

[简体中文](./NOVEL_IMPORT.md)

2026-09-13: local work in progress, not released. This records the implementation of plan 32, **not completion or production acceptance**. The user requested code first and no server-based testing.

The shared Work/IDE/mobile import panel supports file selection, local drag/drop, durable upload/jobs, cancellation, preview editing and receipts. Deterministic TXT/Markdown/DOCX/ZIP parsing preserves source files and uses bounded parsing. Preview supports names, ordering, volume reassignment, cursor splitting and adjacent same-source merging. Parsing runs outside the API event loop with supervised converter lifecycles. A Node Worker is not an OS sandbox.

Only unpublished novels with no chapters can currently commit; existing empty volumes are retained. Ownership, source/manifest/target hashes and expiring approvals bind the short atomic transaction. Duplicate requests return the same receipt. Agent `novel_import` currently exposes read-only `prepare/status` handoffs to the human UI, not autonomous import or approval.

`NOVEL_IMPORT_ENABLED` defaults off. Overwrite verification is hardcoded false; an environment variable cannot enable it. Restore and AI execution are also off. Exact current-model routing and budget validation exist as helpers, but paid calls, reservations and settlement are not connected. Deterministic import does not invoke or charge a model.

PDF currently provides page text previews with blocking completeness warnings. The Linux Docker DOC/OCR worker is a prototype with protocol tests, not a native-tested business capability. Actual DOC conversion, OCR accuracy, sandbox enforcement and resource benchmarks remain untested. The user did not authorize borrowing a server for these checks.

Not complete: full overwrite/restore compatibility, published directory snapshots, all background-writer fencing, image/cover retention and selection, explicit source exclusion, lazy body loading, full Agent durable approval/waiting workflow, ZIP/DOC chat attachments, AI billing, outbox consumption, admin import metrics and Web/Windows/Android acceptance. These are code/verification gaps, not merely deployment steps.

Local tests use pinned Node 22.23.2 and an isolated loopback PostgreSQL 16 database with a least-privilege role and synthetic documents. The complete migration chain is verified separately from production. Module tests do not imply all repository gates passed; final handoff records the actual results.

Final local validation: 2,545/2,545 tests passed without skips; typecheck, lint, coverage thresholds and production build passed. Python protocol tests: 11/11. Two existing credit tests received explicit fixture timestamps to avoid a DB/JS clock boundary race; production billing code and monetary assertions are unchanged. This does not resolve production clock consistency. See the [validation record](../plan/evidence/32-novel-import-local-validation-2026-09-13.md).

Preview saves claim a database lease before allocating a blob, retain two revisions and have a 64-revision lifetime cap. Daily user quotas and garbage-queue backpressure are enforced. `NOVEL_IMPORT_MAINTENANCE_ENABLED` can explicitly keep cleanup enabled when new imports are disabled; when unset it follows the main flag. The checked-in Nginx template scopes 50 MiB streaming to exact authenticated source endpoints; other API routes retain 40 MiB. Real Nginx configuration validation was not run.

Source/preview files are private random-key blobs outside public uploads. Back up the private directory together with the database. Uncommitted resources expire after seven days; committed/backup references and live parsing leases are excluded from temporary cleanup. Thirty-day backup records do not imply that restore is available. Cleanup consumes exact unreferenced keys and retains failures for retry; it never recursively deletes a shared root.

The migration introduces archive fields and active-row partial unique indexes. Do not replace those indexes with `prisma db push`. Do not enable overwrite or roll back to archive-unaware code without validating published snapshots, all writing paths, derived memory state and recovery. See the Chinese status document for the remaining work and the worker README for native test prerequisites.
