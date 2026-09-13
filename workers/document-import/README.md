# Isolated document import worker and business parser

[简体中文](./README.zh-CN.md)

Scope: plan32 DOC conversion, offline PDF/image OCR and the API-side isolated parsing pipeline. Authentication, private persistence, human decisions, billing and import commit remain the application service's responsibility. **Native acceptance requires the actual same-SHA CI result; adding this workflow is not evidence of passing native tests.** No production document testing is authorized.

## Current application entry and release handoff (2026-09-14)

For a service account without Docker socket access, use the [restricted sudo launcher](./privileged/README.md),
not Docker group membership. It requires a separate root-owned approved-image config and its CI acceptance.

`api/lib/novel-import/runtime.ts` exports `parseConfiguredNovelImportDocument(buffer, filename, {sourceId, sourceHash?, encoding?, signal?, deadlineAt?})`. The optional absolute Unix-millisecond `deadlineAt` is the persisted job deadline, reused after recovery. Results are `{parsed, report, artifacts}`; artifacts contain bounded sanitized PNG bytes and MUST be stored privately before the machine-only `IMPORT_IMAGE_STORAGE_REQUIRED` check can be cleared. Human review cannot waive storage. IDs and page/member/block evidence stay bound to the source hash; image/cover candidates are never applied automatically.

DOC/PDF, including ZIP members, use the explicitly configured native worker. DOCX/ZIP images receive offline OCR when native is enabled; original paragraphs remain unchanged and OCR text is placed in a visible “unassigned image text” volume for human placement. Native jobs have a 30-minute absolute deadline; TXT/MD remain capped at 120 seconds, converter subprocesses at 120 seconds and regional OCR at a shared 60 seconds per page. The caller must enforce durable leases, fencing and a bounded global claim pool. Runtime also prevents concurrent native jobs in one supervisor.

The separate workflow `.github/workflows/document-import-native.yml` builds **only** `workers/document-import` as its Docker context and runs required Linux native acceptance. Missing Linux/image prerequisites fail required CI instead of silently skipping. Tests include a genuine OLE DOC with converted XML text checks, mixed PDF, PNG OCR, an image-only Chinese PDF with fixed self-authored gold text, the real client protocol/hash/cancel/cleanup path, and dependency health. The Chinese gate is CER ≤2% after removing Unicode whitespace only; raw CER, exact normalization, reference/source/recognized hashes are also emitted. This clean-print corpus does not validate handwriting or all adversarial documents.

Successful CI artifacts for the **same commit**:

- `document-import-native-evidence-<SHA>`: exact `document-import-image.id` and `document-import-native-report.json`.
- `document-import-worker-<SHA>`: `document-import-worker.tar.gz`, saved from the image that passed those tests. This workflow never pushes a registry image or deploys anything.

Authorized operator handoff (instructions only, not commands executed by this task):

1. Require the full application CI and dedicated native workflow for the same SHA to pass. Download both artifacts from that run and keep the evidence with the release.
2. Load the saved tar with `docker load --input <downloaded-document-import-worker.tar.gz>`; **do not rebuild on the server**. Check `docker image inspect --format '{{.Id}}' <ID-from-document-import-image.id>` exactly equals that complete `sha256:...` ID. Never substitute a mutable tag or the base-image digest.
3. Provision `/opt/chevoink/shared/document-import-staging` owned by the API service account with mode `0700`. It is outside uploads/public directories. The approved service account needs controlled access to the local Docker daemon; the container itself never receives that socket.
4. Set operator environment (separate from the main import/overwrite flags):

   ```dotenv
   NOVEL_IMPORT_NATIVE_ENABLED=true
   DOCUMENT_IMPORT_WORKER_IMAGE=sha256:<exact-ID-from-successful-CI>
   DOCUMENT_IMPORT_WORKER_STAGING_ROOT=/opt/chevoink/shared/document-import-staging
   ```

5. From the release checkout, run the internal command with the provisioned service environment: `node --import tsx workers/document-import/health-cli.ts`. Exit 0 plus `ready:true` requires actual sandboxed tool/version/library/language-data self-checks. It performs **zero document conversion, zero OCR and zero synthetic document processing**. Do not expose it as a public HTTP endpoint. Production DOC/OCR document tests remain prohibited.

The Docker client is fixed to `unix:///var/run/docker.sock`, with no inherited remote context/config or credentials. Native disabled returns the deterministic pipeline; configured-but-unhealthy native fails closed rather than silently switching parsers. A health result is dependency readiness, not a substitute for CI quality acceptance. Release-wide archive/restore/Agent/native-client acceptance is separately owned and is not granted by this worker flag.

## Integration

The low-level API-side module is `api/lib/novel-import/worker-client.ts`; application code uses the runtime entry above. Reuse one client instance per supervisor process (one active execution, no hidden queue). API orchestration must enforce global and per-user quotas, ownership, leases/fencing, cancellation and original-source retention.

```ts
const worker = createDocumentImportWorker({
  stagingRoot: '/srv/chevoink-document-worker-staging', // dedicated, API-owned, mode 0700
  image: approvedWorkerImageDigest, // sha256:<64hex> or repository@sha256:<64hex>
})
const result = await worker.run({
  sourceId, sourceHash, // opaque safe ID and SHA256 of original bytes
  format: 'doc', // 'doc' | 'pdf' | 'image' (PNG/JPEG only)
  bytes: uploadedBytes,
  signal,
  timeoutMs: 120_000, // 1,000..1,800,000; defaults to 30 minutes
  ocrLanguages: 'chi_sim+eng', // also chi_tra+eng or eng
})
```

Linux API + local Linux Docker daemon only. Windows/macOS, absent Docker, remote daemon configuration and missing images fail closed; there is no desktop LibreOffice/Python fallback. Configuration is trusted operator input, never request JSON. Configure an absolute Docker executable for a hardened host. Do not expose Docker privileges to ordinary request handlers; use a dedicated supervisor identity/host.

`protocol.ts` exports strict Zod request/response schemas, types, hard limits, `decodeWorkerResponse`. `protocol.py` validates the same fixed request keys; tests detect limit drift. Wire JSON contains no paths, URLs, commands, credentials, user/novel IDs or arbitrary environment. The client snapshots bytes, verifies the source hash, generates a request ID and stages only `source` and `request.json`. Staging is temporary, not the persistent original-source store.

Result contract:

| Field | Meaning / integration rule |
| --- | --- |
| `version`, `parserVersion`, `requestId`, `sourceId`, `sourceHash`, `format` | Validate binding before consuming output; persist these with parser results. Cache also by approved worker image digest, languages/options and authenticated owner. |
| `outcome` | `converted`, `parsed`, `needs_review`, `failed`. A normal return can be `failed`; inspect `error`. Infrastructure/protocol/cancel errors throw `DocumentWorkerError` with stable `code`. |
| `convertedArtifactId` | DOC only: locate returned DOCX bytes and run the existing bounded DOCX parser. Carry both DOC warnings forward. Conversion is not coverage/completeness approval. No fictitious DOC page numbers. |
| `artifacts[]` | `{id, mediaType, sha256, byteLength, bytes, width?, height?}` after client validation. Wire uses canonical base64; client returns bytes, never a worker-selected host path. Store privately with ownership/refcounts and serve with explicit safe MIME/nosniff. Revalidate DOCX archive contents in the parser. PNG header checks do not replace a complete image sanitizer. |
| `pages[]` | Exactly one ordered entry per known page: `{page,width,height,state,warnings,blocks,regions}`. `totalPages=null` means inspection failed, not zero pages. |
| `blocks[]` | `{id,method,text,bbox,confidence,regionId,duplicateOf}`. Original native text retained; OCR text is a recognizer hypothesis. `bbox=[x0,y0,x1,y1]` uses unrotated top-left PDF points. Image mode uses a one-page internal PDF coordinate space. |
| `duplicateOf` | Exact whitespace-insensitive text plus positional overlap evidence pointing to a native block. Retain evidence but exclude the marked OCR duplicate from default body assembly. Do not concatenate native and OCR arrays blindly. |
| `regions[]` | `{id,bbox,status,artifactId,warnings}`. Native text plus image content is never treated as native-only coverage. Artifact may be null on render/limit failure; retain original PDF for page inspection. |
| `coverage` | Mutually exclusive `native/ocr/needs_review/failed/verified_blank` counts sum to known pages. `processedPages=totalPages-failed`. All OCR pages remain `needs_review`; `ocr` auto-approved count is deliberately zero in this prototype. `complete` is processing coverage, never character accuracy or import authorization. |

No OCR warning grants consent to cloud vision. There are zero model calls and no API keys in this worker. The API must independently block incomplete imports or obtain explicit exclusions/review with provenance; never convert `needs_review` into silent success. All original documents must remain available outside transient staging.

## Native behavior

- DOC: checks OLE magic, WordDocument/FIB/table stream and encryption flags, then opens with an isolated LibreOffice profile via local UNO pipe. `NEVER_EXECUTE`, `NO_UPDATE`, read-only/hidden and an abort-only interaction handler disable normal macro/link updates and prompts. Offline container prevents remote templates; no application files or credentials are mounted. Output is DOCX, size/archive checked, not extracted on host. Damaged or unsupported legacy variants can fail.
- PDF: container child preflight checks magic, encryption, repair, embedded files, page count. Each page runs in a separate child with its own finite deadline. Native lines retain source boxes; suspicious characters, columns/overlaps, rotations and annotations/forms create warnings. Images receive regional OCR even with a native header. Overlapping image placements merge; vector-only content receives full-page OCR; mixed vector/image content has an explicit unprocessed-vector warning.
- Tesseract 5.5 CPU LSTM with bundled `chi_sim`, `chi_tra`, `eng`; TSV word confidences aggregate into lines. OCR shares a 60-second budget across a page's regions. No runtime model download, GPU, Paddle runtime or cloud fallback. This is a lower-dependency choice, **not a measured claim of better Chinese accuracy than PaddleOCR**.
- Review images are canonical rendered PNG regions, not bit-identical embedded originals. Original source remains authoritative. No decorative-image auto-exclusion. Blank requires no text/images plus a near-white rendered page; unresolved visible content stays reviewable.
- Per-page failures/limit exhaustion keep earlier completed page results and explicitly fail remaining pages. Whole-container death, malformed protocol, outer deadline or OOM cannot recover in-memory checkpoints: source remains retained by the API, but incremental durable checkpointing is not implemented.

## Resource and invocation contract

`documentWorkerDockerArgs` is the executable contract, tested by the offline suite:

- `--network=none --read-only --user=10001:10001 --cap-drop=ALL --security-opt=no-new-privileges:true`.
- `--cpus=1 --memory=1g --memory-swap=1g --pids-limit=96 --ipc=none --restart=no`, core dumps off, fd/file-size limits, default Docker seccomp retained (never unconfined).
- Only one read-only `/input` bind; no output bind, socket, app directory, device, host PID namespace or credentials. `/work` 256 MiB and `/tmp` 64 MiB are bounded noexec/nosuid/nodev tmpfs.
- 50 MiB source; 1,000 pages; 20 MP decoded/rendered image; 4 MiB per PNG; 128 artifacts / 32 MiB total decoded artifacts; 64 regions/page; 100,000 chars/page; 5 million chars and 100,000 blocks/job; 64 MiB response; 120 seconds/native child, 60 seconds OCR/page, 30 minutes/job. Large source images over 20 MP fail rather than being decoded and silently downsampled.
- Worker entry rejects non-container/root/writable-root/networked invocation. This guard is defense in depth, not an OS isolation proof. Docker/kernel hardening and adversarial testing remain mandatory.
- Abort/deadline kills the CLI and force-removes the exact generated container name, then removes only its random immediate staging child. No raw stderr is retained. Cleanup has an additional bounded allowance (at most two 5-second Docker commands plus filesystem cleanup). Unverifiable cleanup returns `IMPORT_CLEANUP_FAILED`.
- API death/daemon loss/delayed container creation requires an **operator janitor** over the `org.chevoink.document-import=protocol-v1` label, age and persistent job lease. This prototype does not install that janitor. Do not assume client `finally` survives host/API death. Use a private local disk, not an unbounded/blocking network filesystem; filesystem syscalls are not independently cancellable.

## Build and test

Build is networked dependency installation only, without documents or production secrets. Runtime is offline. The Dockerfile pins the official Debian trixie-slim OCI index digest read from Docker Hub on 2026-09-13. Main native packages/models are exact Debian versions in `dependencies.lock`, verified against Debian package pages; apt verifies signed repository/package hashes. Transitive packages are inventoried in `/app/installed-packages.txt`, language-data hashes in `/app/language-data.sha256`. This is not a complete historical apt snapshot lock: capture/SBOM/scan and promote the tested **worker image digest**, not a rebuilt tag. An unavailable exact package must fail the build, not relax the pin.

On an authorized Linux development host, from repository root:

```sh
docker build --platform linux/amd64 -t chevoink-document-import:probe workers/document-import
docker image inspect chevoink-document-import:probe --format '{{.Id}}'
# Use the returned sha256 image ID; the test never pulls or builds implicitly.
DOCUMENT_IMPORT_TEST_IMAGE=sha256:<returned-id> npx --no-install vitest run --config workers/document-import/tests/vitest.config.ts
```

Host-safe tests (no Docker/native document parsing or database):

```sh
python -m unittest discover -s workers/document-import/tests -p 'test_*.py' -v
npx --no-install vitest run --config workers/document-import/tests/vitest.config.ts
npx --no-install tsc --noEmit --skipLibCheck --strict --target ES2022 --module ESNext --moduleResolution bundler --types node api/lib/novel-import/worker-client.ts workers/document-import/protocol.ts
npx --no-install eslint api/lib/novel-import/worker-client.ts workers/document-import/protocol.ts workers/document-import/tests/*.ts
```

Verification record, 2026-09-13: the initial local run used Windows, Python 3.12.10 and Node 24.12.0; 25 TypeScript tests and 11 Python tests passed, along with targeted strict TypeScript and ESLint. The parent subsequently reports the same 25 worker protocol/client TypeScript tests passing under repository-pinned Node 22.23.2; that is the current Node verification evidence, not a native integration result. Docker/soffice are absent here and one native smoke test remains explicitly skipped. **No Docker build, actual LibreOffice/Tesseract worker runtime, sandbox enforcement, memory/CPU benchmark, Chinese CER, macro/adversarial corpus or production deployment was verified.** An optional mapper and the separate whole-parser boundary are being integrated by their owners; this worker test record does not certify complete application integration or six-format completion. Native enablement remains off pending separate verification; full repository gates remain the parent integration responsibility.

The opt-in container smoke authors synthetic fixtures *inside* the sandbox: native PDF, native header plus raster content, PNG OCR, and an actual OLE DOC produced by LibreOffice then converted back to DOCX. It is ready to run, not recorded as passed. It does not replace externally authored authorized DOC, encrypted/corrupt/macro samples, rotated/two-column Chinese gold data or plan32's CER gate.

## Verified upstream references and licenses

- [Docker run isolation/resources](https://docs.docker.com/engine/containers/run/).
- [LibreOffice headless/profile arguments](https://help.libreoffice.org/latest/en-US/text/shared/guide/start_parameters.html), [macro mode](https://api.libreoffice.org/docs/idl/ref/namespacecom_1_1sun_1_1star_1_1document_1_1MacroExecMode.html), [update mode](https://api.libreoffice.org/docs/idl/ref/namespacecom_1_1sun_1_1star_1_1document_1_1UpdateDocMode.html), [licenses](https://www.libreoffice.org/licenses/) (MPL-2.0; bundled components have additional notices).
- [PyMuPDF page extraction/render APIs](https://pymupdf.readthedocs.io/en/latest/page.html), [PyMuPDF project/license](https://github.com/pymupdf/PyMuPDF) (AGPL-3.0/commercial dual licensing; review distribution obligations with the app's AGPL/commercial licensing).
- [Tesseract TSV and language selection](https://tesseract-ocr.github.io/tessdoc/Command-Line-Usage.html), [fast LSTM model family](https://github.com/tesseract-ocr/tessdata_fast) (Apache-2.0). Debian language packages avoid runtime downloads.
- Exact package records: [LibreOffice Writer](https://packages.debian.org/trixie/libreoffice-writer-nogui), [UNO](https://packages.debian.org/trixie/python3-uno), [PyMuPDF](https://packages.debian.org/trixie/python3-pymupdf), [olefile](https://packages.debian.org/trixie/python3-olefile), [Tesseract](https://packages.debian.org/trixie/tesseract-ocr), [simplified Chinese data](https://packages.debian.org/trixie/tesseract-ocr-chi-sim), [traditional Chinese data](https://packages.debian.org/trixie/tesseract-ocr-chi-tra), [English data](https://packages.debian.org/trixie/tesseract-ocr-eng), [Python](https://packages.debian.org/trixie/python3), [Noto CJK](https://packages.debian.org/trixie/fonts-noto-cjk). Preserve `/usr/share/doc/*/copyright` in distributions and generate a full image SBOM; this shortlist is not a transitive license audit.

## Files owned by this change

- `api/lib/novel-import/worker-client.ts`
- `workers/document-import/{protocol.ts,protocol.py,runtime.py,main.py,libreoffice_convert.py,pdf_ocr.py}`
- `workers/document-import/{Dockerfile,dependencies.lock,.dockerignore,.gitignore,README.md,README.zh-CN.md}`
- `workers/document-import/tests/{vitest.config.ts,protocol.test.ts,client.test.ts,native.test.ts,test_protocol.py,container_smoke.py}`
