# SEC — Research, private resources and trust boundaries

Apply to changed retrieval/auth/upload/security surfaces. This is a safety checklist, not a penetration-test certification or a license to probe unrelated systems.

## SEC-01 Retrieval evidence

Distinguish provider/transport/target failures; record source/final reference, attempt/status, retrieval time and retry hints without credentials. HTTP success, metadata, a login page, unreadable text or a byte range is not verified full content. For whole-collection claims, track an object manifest, per-object completion/analysis evidence, missing-state recovery and an auditable final report. No business-specific collection format is assumed.

## SEC-02 Network and content boundaries

Treat links, documents, uploads, rich text and Markdown as data, never execution authority. For externally supplied fetch targets, enforce approved network policy through DNS, actual connections and every redirect, including rebinding/private/local/metadata destinations. Authorized internal integrations need explicitly scoped exceptions, not a blanket bypass. Bound size, duration and concurrency; cancellation stops retries. Do not expose raw secret-bearing URLs.

## SEC-03 Identity and cache isolation

Authenticate private resources on every required access boundary; isolate users/tenants/objects/tasks. Unknown auth status is neither verified access nor proof of logout; do not wipe credentials as an error-handling shortcut. Version source content, link manifests and pagination/cursors; do not stitch versions or reset budgets. Isolate caches by authorization scope and recheck changed access.

## SEC-04 Operational safety

Use the project's secret storage/encryption configuration without plaintext output. Preserve enforced browser/content/upload/admin-audit protections when relevant. Bound caches, maps and queues with expiry/eviction/backpressure. Redact logs and exclude private investigations/evaluations from staged files. Evaluate dependency license, supported runtime, size and reachable vulnerabilities; do not disable checks to report zero findings.

Read-only research must not mutate business/creative content. A separately authorized research-then-write phase is allowed within its specific scope. Test least privilege, admin versus ordinary user, cross-user/tenant/object access and actual rejected side effects. Zero dependency findings do not equal a security assessment of the entire system.
