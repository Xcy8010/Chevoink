# Stack adaptation: evidence, not presets

This is not a project generator. Do not select frameworks, databases, folder layouts, package managers, mandatory infrastructure or checks by habit. Optional Node scripts automate this skill; they never require a target Python, Go, Java, native, mobile or other project to adopt Node.

## Bounded discovery

Use `scripts/inspect-project.mjs --root <repo>` only when orientation is needed. It performs bounded local file inventory and Git metadata reads, not semantic architectural detection, repository commands, network requests or test execution. It excludes common dependencies/build outputs and does not read secrets. A truncated scan cannot prove absence. Arbitrary document names, deep subprojects and uncommon build tools require targeted agent reads.

Use observed manifests/toolchain pins/locks/build definitions to identify candidate components. Inspect actual implementation, relevant docs, dependency direction, communication protocols, deployment definitions and CI to establish architecture and ownership. A workspace may be a monolith, services, a library collection or a hybrid; a Dockerfile is not proof of distributed architecture.

## Per-component adaptation

Record the affected component's location, responsibility, runtime/framework if verified, build/test tool, supported target and evidence. In a mixed repository, use each component's native checks and the necessary cross-component contract checks; never substitute one package manager for the entire repository. Existing subdirectory instructions apply in their scope.

Select checks from the actual declared project workflow. Examples of evidence categories—not commands to run—include language manifests, build files, toolchain pins, CI jobs, make/task targets, device build settings, infrastructure plans and dataset validation definitions. Unknown tools or a non-Git export remain unknown until examined; there is no fallback npm project.

## Gates and applicability

For a relevant gate record its ID, intent, exact reviewed command/check, working directory, stage, source, execution location and authorization, expected behavior and required/conditional status. A script in a repository is not automatically safe to execute: inspect its targets and effects, including dependencies and generated files.

Map generic rule IDs to real local invariants. Select conditional modules only for the changed surface. Missing optional capabilities mean UNKNOWN until resolved for the current task, not a requirement to add them. A library has no mandatory production server; a CLI has no assumed UI; an offline application has no assumed billing; native code has no automatic React or SQL conventions.

## Evidence profile

PROJECT-PROFILE is repository-local evidence metadata, not a named-project preset system. The new `profile` label is always generic. Old labels are accepted as inert strings; the checker never loads any project-specific file from them. Recorded Git origin identities are drift evidence only, not rule selectors; non-Git or offline evidence can be used without inventing a remote.

`profile-check.mjs --repo <repo>` validates structure and previously recorded source-file fingerprints. Changed or missing sources require reviewing affected assumptions. Hash equality is not semantic completeness, passing tests, permission or deployed identity. New files outside the inventory may still matter. A draft is an orientation checklist; a reviewed record is still not release approval.

Read `architecture-adaptation.md` when boundaries/communication/deployment change, and `local-standards.md` when interpreting project-specific requirements. Keep only source pointers and necessary local conclusions, not copies of the global library or whole repository standards.
