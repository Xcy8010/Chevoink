CREATE TABLE "app_release_retirements" (
    "release_id" VARCHAR(64) NOT NULL,
    "operation_id" VARCHAR(36) NOT NULL,
    "artifact_sha256" VARCHAR(64) NOT NULL,
    "quarantine_name" VARCHAR(128) NOT NULL,
    "trigger_operation_id" VARCHAR(100),
    "state" VARCHAR(24) NOT NULL DEFAULT 'pending',
    "error_code" VARCHAR(80),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "completed_at" TIMESTAMP(3),
    CONSTRAINT "app_release_retirements_pkey" PRIMARY KEY ("release_id"),
    CONSTRAINT "app_release_retirements_release_id_fkey" FOREIGN KEY ("release_id")
      REFERENCES "app_releases"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "app_release_retirements_operation_id_key" ON "app_release_retirements"("operation_id");
CREATE INDEX "app_release_retirements_state_created_at_idx" ON "app_release_retirements"("state", "created_at");
