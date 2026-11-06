ALTER TABLE "app_releases" ALTER COLUMN "verified_at" DROP NOT NULL;
ALTER TABLE "app_releases" ADD COLUMN "validation_state" VARCHAR(24) NOT NULL DEFAULT 'draft' CHECK ("validation_state" IN ('draft','verified'));
ALTER TABLE "app_release_channels" ADD COLUMN "enabled" BOOLEAN NOT NULL DEFAULT true;