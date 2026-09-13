CREATE TABLE "novel_import_events" (
  "id" UUID PRIMARY KEY,
  "jobId" VARCHAR(64) NOT NULL,
  "kind" VARCHAR(16) NOT NULL CHECK ("kind" IN ('imported', 'restored')),
  "payload" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "novel_import_events_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "novel_import_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "novel_import_events_jobId_kind_key" ON "novel_import_events" ("jobId", "kind");
