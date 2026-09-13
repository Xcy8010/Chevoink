CREATE TABLE "novel_import_suggestions" (
  "id" VARCHAR(64) PRIMARY KEY,
  "jobId" VARCHAR(64) NOT NULL REFERENCES "novel_import_jobs"("id") ON DELETE CASCADE,
  "userId" VARCHAR(64) NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "manifestRevision" INTEGER NOT NULL,
  "manifestHash" VARCHAR(64) NOT NULL,
  "fingerprint" VARCHAR(64) NOT NULL,
  "volumeIndex" INTEGER NOT NULL,
  "chapterIndex" INTEGER NOT NULL,
  "status" VARCHAR(24) NOT NULL DEFAULT 'pending',
  "result" JSONB,
  "errorCode" VARCHAR(128),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "import_suggestion_indices" CHECK ("manifestRevision" > 0 AND "volumeIndex" >= 0 AND "chapterIndex" >= 0)
);
CREATE UNIQUE INDEX "novel_import_suggestions_jobId_manifestRevision_volumeIndex_chapterIndex_key"
ON "novel_import_suggestions"("jobId", "manifestRevision", "volumeIndex", "chapterIndex");
CREATE INDEX "novel_import_suggestions_jobId_createdAt_idx" ON "novel_import_suggestions"("jobId", "createdAt");
