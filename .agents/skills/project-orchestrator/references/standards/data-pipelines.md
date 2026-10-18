# PIPE — Data, analytics and model pipelines

Conditional: transformed datasets, scheduled/batch/streaming pipelines, analytics or ML artifacts. This module does not require a data platform in other applications.

## PIPE-01 Identity, lineage and scope

Record input dataset/schema/version/time range, transformations/configuration and output identity. Distinguish planned ranges, read records and validated materialized outputs. Preserve ownership, privacy, retention and deletion obligations. Do not copy private datasets into global handoff or skill files.

## PIPE-02 Replays, backfills and partial completion

Define stable operation/partition keys, ordering/watermark expectations, duplicate handling and atomic/compensating publication appropriate to the system. Bound retries/backfills by authorized scope and resources. Unknown or partial output is not a successful complete dataset. Test interruption/restart, schema changes, late/duplicate events and relevant transaction boundaries.

## PIPE-03 Data and evaluation validity

Use the project's adopted completeness, consistency and quality checks. Match reports to the actual input/output/model version. For ML/evaluation, keep training, validation and test boundaries and prevent leakage; do not change splits or remove failures to obtain a better score. Reproducibility/seed constraints, statistical uncertainty and human evaluation follow the actual task, not a universal metric.

## PIPE-04 Safe execution and delivery

Inspect storage and compute targets before running queries/jobs. Do not convert read-only investigation into writes, replace production datasets or publish a model without authority. Use isolated samples where permitted and state coverage limitations. Check materialized artifacts and consumers instead of treating scheduler green status as proof.
