BEGIN;

CREATE UNIQUE INDEX "quality_findings_report_source_signal_span_key"
ON "quality_findings"("report_id", "source", "signal", "start_offset", "end_offset", "evidence_hash");

DROP INDEX "quality_findings_report_id_source_signal_evidence_hash_key";

COMMIT;
