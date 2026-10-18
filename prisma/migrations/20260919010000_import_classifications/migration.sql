CREATE TABLE "novel_import_classifications" (
  "id" VARCHAR(64) PRIMARY KEY,
  "jobId" VARCHAR(64) NOT NULL REFERENCES "novel_import_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "userId" VARCHAR(64) NOT NULL REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "novelId" VARCHAR(64) NOT NULL REFERENCES "novels"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "manifestRevision" INTEGER NOT NULL CHECK ("manifestRevision" > 0),
  "manifestHash" VARCHAR(64) NOT NULL CHECK ("manifestHash" ~ '^[a-f0-9]{64}$'),
  "snapshotHash" VARCHAR(64) NOT NULL CHECK ("snapshotHash" ~ '^[a-f0-9]{64}$'),
  "fingerprint" VARCHAR(64) NOT NULL CHECK ("fingerprint" ~ '^[a-f0-9]{64}$'),
  "quote" JSONB NOT NULL,
  "status" VARCHAR(24) NOT NULL DEFAULT 'quoted' CHECK ("status" IN ('quoted','pending','succeeded','failed')),
  "result" JSONB,
  "completedBatches" INTEGER NOT NULL DEFAULT 0 CHECK ("completedBatches" BETWEEN 0 AND 4),
  "dispatchedBatches" INTEGER NOT NULL DEFAULT 0 CHECK ("dispatchedBatches" BETWEEN 0 AND 4),
  "errorCode" VARCHAR(128),
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "confirmedAt" TIMESTAMP(3),
  "dispatchedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (("status" = 'quoted' AND "confirmedAt" IS NULL AND "dispatchedAt" IS NULL)
      OR ("status" <> 'quoted' AND "confirmedAt" IS NOT NULL AND "dispatchedAt" IS NOT NULL)),
  CHECK ("status" <> 'succeeded' OR "result" IS NOT NULL)
);
CREATE UNIQUE INDEX "novel_import_classifications_jobId_manifestRevision_key" ON "novel_import_classifications"("jobId", "manifestRevision");
CREATE INDEX "novel_import_classifications_jobId_createdAt_idx" ON "novel_import_classifications"("jobId", "createdAt");
