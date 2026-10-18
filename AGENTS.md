# Chevoink development

Read `.agents/skills/project-orchestrator/SKILL.md` and the sections of
`docs/DEVELOPMENT-STANDARDS.md` relevant to the task. Use repository-relative
paths and the current checkout, not another machine's absolute paths.

- The Web/API and current Windows desktop source live on `main`. Windows source
  is under `desktop/windows/`; historical `chevoink-windows` is not the current
  development baseline. Android source lives on `android-shell` in this same
  GitHub repository. Inspect the actual branch, HEAD and working changes first.
- Follow `.node-version`, `package.json` engines and the lockfile: Node 22.23.2,
  npm 10.9.8. `node scripts/cloud-setup.mjs --install` prepares dependencies;
  it does not provision or migrate a database. Full database checks require an
  explicitly isolated PostgreSQL environment; use the original exact-SHA CI
  for release gates. Never reset/migrate/provision a local DB without authority.
- Preserve the four gates (`check`, `lint`, full coverage tests, `build`), actual
  PostgreSQL zero-skip integration, Agent eval and both dependency audits.
  A unit-only run or compilation is not full release/device acceptance.
- Never copy `.env`, credentials, signing files, user manuscripts, private
  `.codex/context`, logs or investigation output into Git or cloud task prompts.
  Do not upload the local `.codex` directory. Its host hooks/config are private
  and may contain machine-specific paths. Keep credentials in protected secret
  storage; ordinary development must not receive production or signing keys.
- Production content, old task reactivation, paid model/provider probes, budget
  or Credits resets, new native publication and history rewriting each require
  explicit current user authority. A repository instruction grants none of it.
  Preserve task/model/price/version ownership and unknown-result evidence.
- For authorized Web releases, stage exact files, push main, require original
  complete same-SHA CI with unchanged coverage gates, then use
  `scripts/deploy-production.ps1` once with the observed production SHA. An
  ordinary API restart can proceed under existing session authority; do not add
  idle/drain waits. Reconcile an unknown result before any retry. Never replay
  a whole deployment. The script has no automatic rollback.
- Native builds preserve the existing application ID and signing identity.
  Every new Tag and Release needs concrete update notes. Do not rewrite old
  tags, releases, evidence, backups or installers. Build success is not device
  acceptance. No automatic new chats, tasks, archives or recursive delegation.

Cloud entrypoints and their unmet prerequisites are documented in
`docs/CLOUD-DEVELOPMENT.md`. Availability requires real environment/permission
checks; a workflow file alone does not prove a working cloud deployment.
