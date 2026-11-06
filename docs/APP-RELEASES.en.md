# Application releases and tester routing

This feature uses one deployed API binary and separate immutable frontend artifacts. It does not run two API versions, change Agent environment flags or the native updater, or alter model/price/version bindings of admitted tasks. These instructions describe the release mechanism and controlled maintenance steps. Actual deployment and channel activation require their own observed receipts.

## Identity and storage

The existing `scripts/deploy-production.ps1` continues to own `/opt/chevoink/app/current`. Front artifacts remain at `/srv/chevoink-data/beta-releases/<releaseId>` after promotion: channel status changes, bytes do not. Every file has a SHA256 and the protected manifest binds source SHA, compatibility, public notes and original CI evidence. Historical artifacts are never overwritten or deleted. Existing full-application archives under `/srv/chevoink-data/release-archives` are independent; this feature does not duplicate them or change old archives, databases or native installers.

`/api/app-releases/bootstrap` chooses a channel using the verified session and server-owned tester qualification. A URL, header or client Boolean cannot grant access. Every artifact request checks the current assignment and the requested file hash. Responses are private/no-store; manifests and CI diagnostics are not public files. Builds use an immutable Vite base. A hashed external entry script restores a validated canonical SPA route before modules run, keeping old BrowserRouter layouts and the existing `script-src 'self'` CSP. The current launcher loads application code only after selection.

The current `/admin/app-releases` control plane remains reachable after selecting an older front; operations still require a fresh super-administrator check. Public `/version` and bootstrap expose labels and features/fixes/changes, never source SHA, provider configuration or engineering diagnostics. Already open interfaces show a refresh action on change instead of automatically discarding edits. New feature requests use current server eligibility; admitted tasks are not repriced or cancelled by these gates.

## Controlled preparation

Use Node22.23.2/npm10.9.8, a clean exact candidate checkout and the original complete same-SHA CI. Preparation reuses `release-ci-read.mjs` and `release-ci.mjs`, additionally requiring `run_attempt=1`. It accepts no local CI-success override. Without evidence, `--draft true` produces an explicitly unverified, ineligible artifact.

Examples confer no production write, channel, commit or deployment authority:

```sh
node scripts/prepare-app-release.mjs prepare --revision <exact-40-character-SHA> --id <unique-id> --label <public-label> --notes <public-notes-json> --capabilities siteContent,testerManagement,imageQuality,modelPromotions,imageWeightedRoutes,publicModelDetails --out <new-output-directory>
node scripts/prepare-app-release.mjs verify --source <prepared-directory>
```

Notes contain only public `features`, `fixes` and `changes`, for example `{"features":["Specific new feature"],"fixes":[],"changes":[]}`. Do not include credentials, investigations, signing materials or user content. Preparation builds the precise candidate frontend; it does not package private context, `.env`, logs or databases.

Under separate maintenance authorization, install the prepared artifact:

```sh
node scripts/prepare-app-release.mjs install --source <prepared-directory>
```

Installation refuses existing IDs and changes neither DB schema, API processes, source directories nor channel pointers. Reconcile interrupted installation with `verify` before retrying anything. The admin API imports only a release ID and verifies the protected manifest and files itself; request paths, SHAs, compatibility claims or verification Booleans are not proof. To validate a previous draft later, prepare a new unique ID; old draft evidence remains immutable. Backend deployment retains the original exact-SHA gates and existing deployment entrypoint.

## Compatibility and activation

The manifest declares the API, additive-schema and admitted-task protocols, exact candidate and original CI. Preparation checks current legal-consent submission fields; actual runtime compatibility still needs same-SHA regression and browser acceptance. An older front without explicit current terms/privacy IDs is rejected as incompatible instead of being counted as successful gray acceptance.

Both official policies must already be published/effective. Missing official text is never manufactured, and no historical consent is backfilled. `/api/auth/legal-policies` reads only the canonical current pair from the same content store, independently of optional content capability. Existing login remains available.

Server guards map `siteContent` to new announcement/settings/help routes, `testerManagement` to new tester-management APIs, and `imageQuality`, `modelPromotions`, `imageWeightedRoutes` and `publicModelDetails` to their actual new model configuration keys. Optional public details are projected accordingly. Existing text weights and admitted Agent execution remain outside these incremental guards. Runtime billing still follows the globally authorized model/activity/frozen-price contracts; this is not a second pricing API.

No channel preserves the existing application. A configured missing, corrupted, unverified or incompatible artifact fails explicitly, without hidden fallback. Initial enrollment explicitly activates a verified compatible stable artifact; only then may a separate test artifact be assigned.

## Changes and unknown results

Preview binds the exact version, public notes, artifact identity, impact, blockers and both channel revisions. Execution rechecks super-admin authority, expected revision, preview digest and current policies. Channel changes, stable operation ID, receipt and audit commit together.

- Assign test: effective testers and super administrators receive that exact artifact; other accounts retain stable.
- Full release: assign the selected verified compatible artifact to stable and atomically disable test routing, preserving both revisions and the disabled test pointer/history.
- App rollback: select a previously published compatible stable artifact; preview states whether independent test routing continues. Never restore the database or change task bindings.
- Withdraw test: disable gray routing using a verified stable fallback, even when the test artifact is broken. This is separate from application rollback.

On a disconnected response, retain the operation ID and reconcile `/api/admin/app-releases/operations/<operationId>`. Only `applied` proves completion. An unreadable DB leaves the result unknown; never replay a whole deployment. A confirmed absent operation permits a fresh preview. Reusing an ID with different content is rejected; a committed identical request returns its receipt.

This document is not a deployment or acceptance receipt. Real PostgreSQL, original same-SHA CI, deployment and browser/device acceptance must be recorded separately by the primary task.