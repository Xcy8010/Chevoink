-- Restoration has its own durable receipt; never mutate the original import receipt.
ALTER TABLE "novels" ADD COLUMN "manuscript_revision" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "agent_runs" ADD COLUMN "manuscript_revision" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "novel_import_backups"
  ADD COLUMN "restoredApprovalId" VARCHAR(64),
  ADD COLUMN "restoreIdempotencyKey" VARCHAR(128),
  ADD COLUMN "restoreReceipt" JSONB,
  ADD COLUMN "restoreErrorCode" VARCHAR(64);
CREATE UNIQUE INDEX "novel_import_backups_restoredApprovalId_key"
  ON "novel_import_backups" ("restoredApprovalId");

-- Existing AgentRun IDs are VARCHAR(64), not PostgreSQL UUIDs.
ALTER TABLE "novel_import_intents" ADD COLUMN "agentRunId" VARCHAR(64), ADD COLUMN "agentToolCallId" VARCHAR(255);
ALTER TABLE "novel_import_jobs" ADD COLUMN "agentRunId" VARCHAR(64), ADD COLUMN "agentToolCallId" VARCHAR(255);
CREATE UNIQUE INDEX "novel_import_intents_agentRunId_agentToolCallId_key" ON "novel_import_intents" ("agentRunId", "agentToolCallId");
CREATE UNIQUE INDEX "novel_import_jobs_agentRunId_agentToolCallId_key" ON "novel_import_jobs" ("agentRunId", "agentToolCallId");

CREATE TABLE "novel_import_artifacts" (
  "id" UUID PRIMARY KEY, "jobId" VARCHAR(64) NOT NULL, "kind" VARCHAR(24) NOT NULL,
  "logicalId" VARCHAR(255) NOT NULL, "storageKey" VARCHAR(128) NOT NULL,
  "sha256" VARCHAR(64) NOT NULL, "bytes" INTEGER NOT NULL, "mediaType" VARCHAR(128) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "novel_import_artifacts_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "novel_import_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "novel_import_artifact_kind_check" CHECK ("kind" IN ('report', 'image', 'chapter')),
  CONSTRAINT "novel_import_artifact_bytes_check" CHECK ("bytes" >= 0 AND "bytes" <= 268435456)
);
CREATE INDEX "novel_import_artifacts_jobId_idx" ON "novel_import_artifacts" ("jobId");
CREATE UNIQUE INDEX "novel_import_artifacts_jobId_kind_sha256_key" ON "novel_import_artifacts" ("jobId", "kind", "sha256");
CREATE TRIGGER "novel_import_artifact_cleanup" AFTER DELETE ON "novel_import_artifacts"
  FOR EACH ROW EXECUTE FUNCTION "queue_novel_import_blob_cleanup"();
