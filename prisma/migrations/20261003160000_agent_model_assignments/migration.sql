CREATE TABLE "agent_model_assignments" (
  "id" VARCHAR(64) NOT NULL,
  "user_id" VARCHAR(64) NOT NULL,
  "scope_key" VARCHAR(64) NOT NULL,
  "novel_id" VARCHAR(64),
  "revision" INTEGER NOT NULL DEFAULT 1,
  "assignments" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "agent_model_assignments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "agent_model_assignments_scope_check" CHECK (("scope_key" = '' AND "novel_id" IS NULL) OR ("novel_id" IS NOT NULL AND "scope_key" = "novel_id")),
  CONSTRAINT "agent_model_assignments_revision_check" CHECK ("revision" > 0),
  CONSTRAINT "agent_model_assignments_user_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "agent_model_assignments_novel_fkey" FOREIGN KEY ("novel_id") REFERENCES "novels"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "agent_model_assignments_user_id_scope_key_key" ON "agent_model_assignments"("user_id", "scope_key");
CREATE INDEX "agent_model_assignments_novel_id_idx" ON "agent_model_assignments"("novel_id");
CREATE TABLE "agent_configuration_changes" (
  "id" VARCHAR(64) NOT NULL PRIMARY KEY,
  "run_id" VARCHAR(64) NOT NULL,
  "call_id" VARCHAR(160) NOT NULL,
  "request_hash" VARCHAR(64) NOT NULL,
  "response" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "agent_configuration_changes_run_fkey" FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "agent_configuration_changes_run_id_call_id_key" ON "agent_configuration_changes"("run_id", "call_id");
