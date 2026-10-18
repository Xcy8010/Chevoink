# INFRA — Infrastructure and environment changes

Conditional: infrastructure-as-code, CI/CD environment, provisioning, runtime configuration or platform changes. No cloud, container or orchestrator is required merely by this module.

## INFRA-01 Target and authority

Verify account, project, region, environment, state/backend and identity without exposing secrets. Confirm allowed commands and blast radius. A repository path, environment label, plan file or old deployment ticket does not authorize a different target. Preserve policy/permission controls; separate read/plan from apply/destroy.

## INFRA-02 Plan and state ownership

Review the actual proposed changes and dependent resources. Keep concurrency/state locks and ownership under the existing tool's model. Revalidate if the source, provider, state or plan changed. Avoid blind retries of partially applied work; reconcile reality first. Never run a copied example plan or guessed cleanup command.

## INFRA-03 Recovery and drift

Assess replacement/downtime, data compatibility, drift and recovery before changes. Destructive or irreversible actions require explicit authority and an adequate recovery plan. A rollback in code is not necessarily a rollback in data or external resources. Do not acquire expensive capacity, stop workloads or rotate credentials outside scope.

## INFRA-04 Verify outcome

Check the actual target resources, permissions, artifact/config versions and service behavior as applicable. Capture applied/pending/failed/unknown distinctly with redacted evidence. Tests of a fixture or static configuration do not establish production readiness. Use the project's real policy and approval gates.
