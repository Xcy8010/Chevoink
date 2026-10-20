BEGIN;
CREATE TABLE "web_tool_calls" (
  "id" VARCHAR(64) PRIMARY KEY,
  "run_id" VARCHAR(64) NOT NULL REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "request_hash" VARCHAR(64) NOT NULL,
  "kind" VARCHAR(16) NOT NULL CHECK ("kind" IN ('search', 'fetch')),
  "amount_milli" INTEGER NOT NULL CHECK ("amount_milli" >= 0),
  "multiplier_bps" INTEGER NOT NULL CHECK ("multiplier_bps" BETWEEN 0 AND 1000000),
  "status" VARCHAR(24) NOT NULL DEFAULT 'dispatched' CHECK ("status" IN ('dispatched', 'completed', 'failed')),
  "outcome" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "web_tool_calls_run_id_idx" ON "web_tool_calls"("run_id");
CREATE TABLE "web_tool_price_migration_20261020" (
  "key" VARCHAR(64) PRIMARY KEY,
  "previous_multiplier" INTEGER NOT NULL,
  "previous_updated_at" TIMESTAMP(3) NOT NULL,
  "applied_at" TIMESTAMP(3) NOT NULL
);
-- Explicitly authorized initial prices: 2 Credits x 1.0 for these two platform tools only.
-- Preserve providers, URLs, secrets, metadata, enabled/selectable flags and every other model.
INSERT INTO "web_tool_price_migration_20261020"
  ("key", "previous_multiplier", "previous_updated_at", "applied_at")
SELECT "key", "multiplier_bps", "updated_at", CURRENT_TIMESTAMP
FROM "ai_model_configs" WHERE "owner_user_id" IS NULL AND "key" IN ('tool:web-search', 'tool:web-fetch') FOR UPDATE;
UPDATE "ai_model_configs" SET "multiplier_bps" = 10000, "updated_at" = backup."applied_at"
FROM "web_tool_price_migration_20261020" backup
WHERE "ai_model_configs"."key" = backup."key" AND "ai_model_configs"."owner_user_id" IS NULL;
COMMIT;
