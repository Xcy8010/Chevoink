ALTER TABLE "credit_system_settings" ADD COLUMN "public_beta_enabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "public_beta_revision" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ai_model_configs" ADD COLUMN "sort_order" INTEGER NOT NULL DEFAULT 1000;
UPDATE "ai_model_configs" SET "sort_order" = CASE "tier"
  WHEN 'lite' THEN 0 WHEN 'speed' THEN 1 WHEN 'standard' THEN 2 WHEN 'performance' THEN 3 WHEN 'ultimate' THEN 4 ELSE 1000 END
  WHERE "owner_user_id" IS NULL;
CREATE UNIQUE INDEX "ai_model_configs_dynamic_platform_tier_key" ON "ai_model_configs" ("tier")
  WHERE "owner_user_id" IS NULL AND "tier" ~ '^builtin_[0-9a-f]{16}$';
