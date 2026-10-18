# Chevoink Android development

Before substantive development and before any authorized commit, push or merge,
read `docs/GIT-SYNC.md` and follow its local Windows / cloud Linux procedure.
Inspect the actual checkout, branch, upstream, dirty/untracked state and unfinished
Git operations, then fetch the verified GitHub remote. Only a clean, strictly
behind branch with a known upstream permits a fast-forward. Stop automatic sync
on dirty state, divergence, conflicts, unknown upstream or fetch failure; never
automatically stash/reset/clean/force-push/rebase or resolve conflicts.

- Android source uses `android-shell` in `Xcy8010/Chevoink`. Web/API and current
  Windows source use `main`; historical `chevoink-windows` is not the Windows
  baseline. Do not merge these business branches as a synchronization shortcut.
- Read `README.md` and the maintained build/preparation scripts for this branch.
  Preserve application ID, version ownership and the existing signing identity.
  Build or signature success is not device acceptance or publication authority.
- Keep `.env`, credentials, signing files, user content and private `.codex/`
  out of Git and cloud prompts. Ordinary development receives no production or
  signing keys. Do not upload local `.codex` or change system security settings.
- Prefer an independent work branch per task; cloud workspaces exchange through
  GitHub. An offline computer's unpushed work cannot be claimed as inspected.
  These instructions are not an enforcing hook or a conflict-free guarantee.
  Synchronization grants no unrelated commit, push, merge or deployment authority.
  New native tags, releases and publication require current explicit authority
  and concrete update notes. No automatic new chats/tasks or recursive delegation.
