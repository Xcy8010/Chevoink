BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "credit_accounts"
  ADD COLUMN "free_daily_withheld" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "credit_phone_identities" (
  "phone_digest" CHAR(64) PRIMARY KEY,
  "owner_user_id" VARCHAR(64) NOT NULL
);

CREATE TABLE "credit_phone_keys" (
  "id" VARCHAR(16) PRIMARY KEY,
  "ciphertext" TEXT NOT NULL
);

-- Old API processes may still insert already-paid referrals while this migration runs.
ALTER TABLE "referral_redemptions"
  ADD COLUMN "reward_status" VARCHAR(16) NOT NULL DEFAULT 'credited',
  ADD CONSTRAINT "referral_reward_status_check" CHECK ("reward_status" IN ('pending', 'credited', 'ineligible'));

CREATE INDEX "referral_rewards_queue_idx"
  ON "referral_redemptions" ("reward_status", "created_at", "id");

COMMIT;
