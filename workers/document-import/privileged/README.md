# Restricted sudo launcher — deployment handoff

This is an additional privileged boundary, **pending its actual remote CI result**. No local
tests or production DOC/OCR tests were run for this change. Do not deploy the rule before the
launcher-specific CI step passes. The existing native image must still be the exact image
saved by successful native CI; the launcher does not build, pull, load or tag images.

## What is allowed

- The application's exact `run` argument vector, for one root-approved `sha256:<64 hex>` image,
  a canonical immediate `job-XXXXXX` child of `/opt/chevoink/shared/document-import-staging`,
  and **only** `/app/main.py` or `/app/health.py`. Every security flag is matched and then
  reconstructed; extra/missing/changed flags, mounts, environment, entrypoints and image tags
  are denied. Native commands are fixed to `/usr/bin/docker` and the local Unix socket.
- `rm --force <canonical-document-import-UUID>` and the exact named `ps` query used by the
  client. A matching name alone never grants control: a root-owned receipt must exist for
  this configured caller, and Docker inspection must match the receipt's image and random
  owner label. Destruction uses the verified immutable container ID, not an unchecked name.
- Internal `create/start/inspect` are implementation details, not public launcher operations.
  Generic Docker, `exec`, shell, build, pull, load, volume operations and arbitrary inspect
  are not allowed by the sudoers entry.

The caller-owned directory is **never directly mounted by root**. Each path component is
pinned using `openat/O_NOFOLLOW`; source and request must be regular, single-link files owned
by the configured caller. Source reads are actually bounded to 50 MiB and hash checked.
Only those two files are copied to a root-owned snapshot, which is what Docker mounts.
Thus a later symlink/rename/source swap cannot turn an allowed path into a privileged bind.
The container retains UID 10001, no network, read-only root, no capabilities, no-new-privileges,
1 CPU/1 GiB, PID/tmpfs/file/output limits and the original fixed environment.

One root launcher run is allowed globally. Root snapshot storage is bounded to 256 MiB and
256 receipts, with bounded retirement of completed receipts older than ten minutes. Original
application source storage remains separate. Cancellation creates a root-owned tombstone;
an in-progress create cannot later start after that tombstone is observed. Uncertain daemon
cleanup is reported as an error and retained for operator investigation, never reported as
successful removal. Cleanup only unlinks exact root-created files; no recursive deletion is
used. A hard alarm bounds blocked source I/O and callers that stop consuming output.

## Install (authorized operator only; not executed by this task)

Install **reviewed CI/release bytes**, not an executable script from a user-writable checkout.
Verify the release SHA/checksums before these root operations. None of these install commands
or generic Docker commands is added to the service account's sudoers permissions.

| Installed path | Source | Owner / mode |
| --- | --- | --- |
| `/usr/local/libexec/chevoink-document-import-launcher` | `root-launcher.py` | `root:root 0755` |
| `/usr/local/bin/chevoink-document-import-docker` | `docker-wrapper.sh` | `root:root 0755` |
| `/etc/chevoink-document-import/launcher.json` | Root-generated config below | `root:root 0600` |
| `/etc/sudoers.d/chevoink-document-import` | Reviewed `sudoers.example` | `root:root 0440` |
| `/var/lib/chevoink-document-import-launcher` | Empty root state directory | `root:root 0700` |
| `/opt/chevoink/shared/document-import-staging` | Existing service staging directory | `ubuntu:<service group> 0700` |

`/usr/local/libexec`, `/usr/local/bin`, `/etc/chevoink-document-import`, the root state directory
and **all their ancestors** must be root-owned, not symlinks and not writable by the service
user/group/others. The launcher and config must never be symlinks into the checkout.
The launcher uses `#!/usr/bin/python3 -I` and stdlib only, so Python does not import modules
or settings from a caller's working directory/environment.

Root configuration has exactly two fields (no environment-selected paths or Docker arguments):

```json
{"image":"sha256:<verified local ID mapped to successful-CI artifact>","uid":1000}
```

Replace `1000` with the **verified numeric UID from `id -u ubuntu`**, not an assumed value.
Replace the placeholder image with the complete local ID verified after `docker load` using
the [static artifact/config identity procedure](../IMAGE-IDENTITY.md). CI manifest/index and
classic Docker config IDs need not be identical, but their payload association must be proven;
use the same verified local ID in this root config and the runtime environment. Do not overwrite
the original CI evidence or relax the exact-image allowlist. The helper compares `SUDO_UID`
with this root-owned numeric value. During a release
upgrade, update this root-owned config to the newly approved image as an operator; the runtime
environment cannot approve a different image. Cleanup of older root-recorded jobs for the same
caller remains possible using their previously approved image/nonce receipts.

Before installing the sudoers file, use `visudo -cf <root-controlled candidate file>` and review
`sudo -l -U ubuntu`. The new entry grants **only** this absolute launcher:

```sudoers
Defaults!/usr/local/libexec/chevoink-document-import-launcher env_reset,!setenv
ubuntu ALL=(root) NOPASSWD: /usr/local/libexec/chevoink-document-import-launcher
```

No Docker group membership or passwordless `/usr/bin/docker`, shell, Python interpreter,
`env`, `install` or wildcard command is granted. This narrow entry does **not** remove any
pre-existing broad sudo permissions: audit those separately, and do not claim the entire
service account is least-privileged if it already has unrelated `NOPASSWD: ALL` permission.

API operator environment:

```dotenv
NOVEL_IMPORT_NATIVE_ENABLED=true
DOCUMENT_IMPORT_WORKER_IMAGE=sha256:<same exact approved image ID>
DOCUMENT_IMPORT_WORKER_STAGING_ROOT=/opt/chevoink/shared/document-import-staging
DOCUMENT_IMPORT_WORKER_EXECUTABLE=/usr/local/bin/chevoink-document-import-docker
```

The absolute executable is passed through `runtime.ts` to `createDocumentImportWorker`.
It is not accepted from HTTP/Agent arguments. The unprivileged shell wrapper only `exec`s
`/usr/bin/sudo -n -- /usr/local/libexec/chevoink-document-import-launcher "$@"`.

The permitted production check remains the existing internal command
`node --import tsx workers/document-import/health-cli.ts`, with the provisioned service env.
Health only imports/checks native library versions, runs tool `--version`, and hashes language
packs. **No document conversion, no OCR, no synthetic document is processed by health.**
Do not expose a launcher or worker health HTTP endpoint. The CI acceptance script is NOT a
production health command and must never be run on the production server.

## CI evidence

The dedicated workflow now installs the launcher/config/sudoers as root for a fresh
`import-launcher-ci` account. That account has neither Docker group membership nor generic
Docker sudo permission. It runs the actual bundled TypeScript client through the wrapper:
health, self-authored PDF, cancellation and caller-staging cleanup. Explicit arbitrary Docker,
generic sudo Docker, unscoped inventory, exec and unknown-container removal must fail.
Python policy cases additionally reject mutated flags/images/paths, symlinks, hardlinks,
FIFOs, wrong ownership and changed source hashes. No local execution is implied by these files.
