ALTER TABLE "ai_model_configs"
  ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "archived_at" TIMESTAMP(3),
  ADD COLUMN "archived_by_id" VARCHAR(64),
  ADD COLUMN "archive_reason" VARCHAR(1000);
ALTER TABLE "agent_runs" ADD COLUMN "model_config_id" VARCHAR(64), ADD COLUMN "model_config_revision" INTEGER, ADD COLUMN "model_price_snapshot" JSONB;
ALTER TABLE "agent_schedules" ADD COLUMN "model_config_id" VARCHAR(64);
CREATE TABLE "ai_model_system_bindings" (
  "role_key" VARCHAR(96) PRIMARY KEY,
  "model_config_id" VARCHAR(64) NOT NULL REFERENCES "ai_model_configs"("id") ON DELETE NO ACTION,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "ai_model_system_bindings_model_config_id_idx" ON "ai_model_system_bindings"("model_config_id");
INSERT INTO "ai_model_system_bindings" ("role_key", "model_config_id")
SELECT CASE WHEN "tier" IN ('speed','basic') THEN "tier" ELSE "key" END, "id"
FROM "ai_model_configs" WHERE "owner_user_id" IS NULL
  AND ("key" IN ('builtin:speed','builtin:basic','tool:image-generation','tool:image-vision','tool:web-search','tool:web-fetch'));
CREATE TABLE "admin_model_diagnostics" (
  "id" VARCHAR(64) PRIMARY KEY, "admin_id" VARCHAR(64) NOT NULL,
  "model_config_id" VARCHAR(64) NOT NULL, "config_revision" VARCHAR(96) NOT NULL,
  "request_key" VARCHAR(100) NOT NULL, "mode" VARCHAR(24) NOT NULL, "status" VARCHAR(24) NOT NULL,
  "fee_identity" VARCHAR(128) NOT NULL, "fee_owner" VARCHAR(24) NOT NULL DEFAULT 'platform',
  "fee_status" VARCHAR(24) NOT NULL DEFAULT 'not_requested', "result" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "admin_model_diagnostics_fee_identity_key" ON "admin_model_diagnostics"("fee_identity");
CREATE UNIQUE INDEX "admin_model_diagnostics_admin_id_request_key_key" ON "admin_model_diagnostics"("admin_id","request_key");
CREATE INDEX "admin_model_diagnostics_model_config_id_created_at_idx" ON "admin_model_diagnostics"("model_config_id","created_at");
CREATE INDEX "admin_model_diagnostics_admin_id_created_at_idx" ON "admin_model_diagnostics"("admin_id","created_at");

CREATE TABLE "ai_model_config_versions" (
  "model_config_id" VARCHAR(64) NOT NULL REFERENCES "ai_model_configs"("id") ON DELETE NO ACTION,
  "revision" INTEGER NOT NULL, "tier" VARCHAR(24), "provider" VARCHAR(40) NOT NULL,
  "model_name" VARCHAR(160) NOT NULL, "base_url" VARCHAR(512), "api_key_ciphertext" TEXT,
  "multiplier_bps" INTEGER NOT NULL, "metadata" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("model_config_id", "revision")
);

ALTER TABLE "web_tool_calls" ADD COLUMN "model_config_id" VARCHAR(64), ADD COLUMN "model_config_revision" INTEGER;
