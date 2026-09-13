-- Staged import; keep both feature flags OFF. Apply only after isolated DB verification.
BEGIN;
-- Original rows/IDs and dependent references are retained. Prisma 6 cannot model
-- these partial unique indexes: do not use db push to replace this migration.
ALTER TABLE "chapters" ADD COLUMN "archived_at" TIMESTAMP(3), ADD COLUMN "archived_by_import_id" VARCHAR(64);
ALTER TABLE "volumes" ADD COLUMN "archived_at" TIMESTAMP(3), ADD COLUMN "archived_by_import_id" VARCHAR(64);
DROP INDEX "chapters_novel_id_order_index_key";
DROP INDEX "chapters_volume_id_order_in_volume_key";
DROP INDEX "volumes_novel_id_order_index_key";
CREATE UNIQUE INDEX "chapters_active_novel_order_key" ON "chapters" ("novel_id", "order_index") WHERE "archived_at" IS NULL;
CREATE UNIQUE INDEX "chapters_active_volume_order_key" ON "chapters" ("volume_id", "order_in_volume") WHERE "archived_at" IS NULL;
CREATE UNIQUE INDEX "volumes_active_novel_order_key" ON "volumes" ("novel_id", "order_index") WHERE "archived_at" IS NULL;
CREATE INDEX "chapters_novel_id_archived_at_idx" ON "chapters" ("novel_id", "archived_at");
CREATE INDEX "volumes_novel_id_archived_at_idx" ON "volumes" ("novel_id", "archived_at");

-- CreateTable
CREATE TABLE "novel_import_intents" (
    "id" VARCHAR(64) NOT NULL,
    "userId" VARCHAR(64) NOT NULL,
    "novelId" VARCHAR(64) NOT NULL,
    "targetHash" VARCHAR(64) NOT NULL,
    "overwriteRequired" BOOLEAN NOT NULL,
    "confirmationStep" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "novel_import_intents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "novel_import_jobs" (
    "id" VARCHAR(64) NOT NULL,
    "userId" VARCHAR(64) NOT NULL,
    "novelId" VARCHAR(64) NOT NULL,
    "intentId" VARCHAR(64) NOT NULL,
    "status" VARCHAR(32) NOT NULL DEFAULT 'uploading',
    "jobVersion" INTEGER NOT NULL DEFAULT 1,
    "manifestRevision" INTEGER NOT NULL DEFAULT 0,
    "manifestHash" VARCHAR(64),
    "targetHash" VARCHAR(64) NOT NULL,
    "modelSelection" JSONB NOT NULL,
    "parseEncoding" VARCHAR(32),
    "leaseOwner" VARCHAR(64),
    "leaseEpoch" INTEGER NOT NULL DEFAULT 0,
    "leaseUntil" TIMESTAMP(3),
    "errorCode" VARCHAR(64),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "novel_import_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "novel_import_sources" (
    "id" VARCHAR(64) NOT NULL,
    "jobId" VARCHAR(64) NOT NULL,
    "filename" VARCHAR(255) NOT NULL,
    "storageKey" VARCHAR(128) NOT NULL,
    "sha256" VARCHAR(64) NOT NULL,
    "bytes" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "novel_import_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "novel_import_manifests" (
    "id" VARCHAR(64) NOT NULL,
    "jobId" VARCHAR(64) NOT NULL,
    "revision" INTEGER NOT NULL,
    "hash" VARCHAR(64) NOT NULL,
    "storageKey" VARCHAR(128) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "novel_import_manifests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "novel_import_approvals" (
    "id" VARCHAR(64) NOT NULL,
    "jobId" VARCHAR(64) NOT NULL,
    "userId" VARCHAR(64) NOT NULL,
    "kind" VARCHAR(16) NOT NULL,
    "sourceHash" VARCHAR(64) NOT NULL,
    "manifestHash" VARCHAR(64) NOT NULL,
    "manifestRevision" INTEGER NOT NULL,
    "targetHash" VARCHAR(64) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "novel_import_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "novel_import_backups" (
    "id" VARCHAR(64) NOT NULL,
    "jobId" VARCHAR(64) NOT NULL,
    "snapshot" JSONB NOT NULL,
    "beforeHash" VARCHAR(64) NOT NULL,
    "afterHash" VARCHAR(64) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "restoredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "novel_import_backups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "novel_import_commits" (
    "jobId" VARCHAR(64) NOT NULL,
    "approvalId" VARCHAR(64) NOT NULL,
    "idempotencyKey" VARCHAR(128) NOT NULL,
    "receipt" JSONB NOT NULL,
    "effectsPublishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "novel_import_commits_pkey" PRIMARY KEY ("jobId")
);

-- CreateTable
CREATE TABLE "novel_import_garbage" (
    "storageKey" VARCHAR(128) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "novel_import_garbage_pkey" PRIMARY KEY ("storageKey")
);

-- CreateIndex
CREATE INDEX "novel_import_intents_userId_novelId_expiresAt_idx" ON "novel_import_intents"("userId", "novelId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "novel_import_jobs_intentId_key" ON "novel_import_jobs"("intentId");

-- CreateIndex
CREATE INDEX "novel_import_jobs_userId_novelId_createdAt_idx" ON "novel_import_jobs"("userId", "novelId", "createdAt");

-- CreateIndex
CREATE INDEX "novel_import_jobs_status_leaseUntil_idx" ON "novel_import_jobs"("status", "leaseUntil");

-- CreateIndex
CREATE UNIQUE INDEX "novel_import_sources_jobId_key" ON "novel_import_sources"("jobId");

-- CreateIndex
CREATE UNIQUE INDEX "novel_import_manifests_jobId_revision_key" ON "novel_import_manifests"("jobId", "revision");

-- CreateIndex
CREATE INDEX "novel_import_approvals_jobId_kind_idx" ON "novel_import_approvals"("jobId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "novel_import_backups_jobId_key" ON "novel_import_backups"("jobId");

-- CreateIndex
CREATE UNIQUE INDEX "novel_import_commits_approvalId_key" ON "novel_import_commits"("approvalId");

-- CreateIndex
CREATE INDEX "novel_import_commits_effectsPublishedAt_createdAt_idx" ON "novel_import_commits"("effectsPublishedAt", "createdAt");

-- AddForeignKey
ALTER TABLE "novel_import_intents" ADD CONSTRAINT "novel_import_intents_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "novel_import_intents" ADD CONSTRAINT "novel_import_intents_novelId_fkey" FOREIGN KEY ("novelId") REFERENCES "novels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "novel_import_jobs" ADD CONSTRAINT "novel_import_jobs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "novel_import_jobs" ADD CONSTRAINT "novel_import_jobs_novelId_fkey" FOREIGN KEY ("novelId") REFERENCES "novels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "novel_import_jobs" ADD CONSTRAINT "novel_import_jobs_intentId_fkey" FOREIGN KEY ("intentId") REFERENCES "novel_import_intents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "novel_import_sources" ADD CONSTRAINT "novel_import_sources_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "novel_import_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "novel_import_manifests" ADD CONSTRAINT "novel_import_manifests_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "novel_import_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "novel_import_approvals" ADD CONSTRAINT "novel_import_approvals_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "novel_import_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "novel_import_backups" ADD CONSTRAINT "novel_import_backups_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "novel_import_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "novel_import_commits" ADD CONSTRAINT "novel_import_commits_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "novel_import_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "novel_import_intents" ADD CONSTRAINT "import_confirmation_step_check" CHECK ("confirmationStep" BETWEEN 0 AND 2);
ALTER TABLE "novel_import_jobs" ADD CONSTRAINT "import_job_versions_check" CHECK ("jobVersion" > 0 AND "manifestRevision" >= 0 AND "leaseEpoch" >= 0);
ALTER TABLE "novel_import_sources" ADD CONSTRAINT "import_source_bytes_check" CHECK ("bytes" > 0 AND "bytes" <= 52428800);
ALTER TABLE "novel_import_approvals" ADD CONSTRAINT "import_approval_kind_check" CHECK ("kind" IN ('commit', 'restore'));

-- Normal whole-novel/account deletion must not be blocked by preview jobs.
-- Cascades record exact orphan keys; cleanup is a separate bounded private-file
-- operation, never recursive deletion and never uploads/public traversal.
CREATE FUNCTION "queue_novel_import_blob_cleanup"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "novel_import_garbage" ("storageKey") VALUES (OLD."storageKey")
  ON CONFLICT ("storageKey") DO NOTHING;
  RETURN OLD;
END;
$$;
CREATE TRIGGER "novel_import_source_cleanup" AFTER DELETE ON "novel_import_sources"
FOR EACH ROW EXECUTE FUNCTION "queue_novel_import_blob_cleanup"();
CREATE TRIGGER "novel_import_manifest_cleanup" AFTER DELETE ON "novel_import_manifests"
FOR EACH ROW EXECUTE FUNCTION "queue_novel_import_blob_cleanup"();

COMMIT;
