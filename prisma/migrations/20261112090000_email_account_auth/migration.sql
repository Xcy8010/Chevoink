BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TYPE "SmsVerificationPurpose" ADD VALUE 'bind_phone';
ALTER TYPE "SmsVerificationPurpose" ADD VALUE 'change_password';

ALTER TABLE "users"
  ADD COLUMN "email_verified_at" TIMESTAMP(3),
  ADD COLUMN "phone_verified_at" TIMESTAMP(3),
  ADD COLUMN "account_setup_step" INTEGER,
  ADD COLUMN "account_setup_skipped_steps" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[],
  ADD COLUMN "account_setup_finished_at" TIMESTAMP(3),
  ADD CONSTRAINT "users_account_setup_step_check" CHECK ("account_setup_step" BETWEEN 1 AND 3);

-- A verified address is unique without case differences. Historical unverified
-- addresses are kept as-is and cannot be taken over by a different account.
CREATE UNIQUE INDEX "users_verified_email_ci_key"
  ON "users" (lower("email")) WHERE "email_verified_at" IS NOT NULL;

-- Preserve proof for the currently stored phone. Registration inserts the
-- account in the same transaction that consumes the previously anonymous code.
WITH verified AS (
  SELECT u."id", max(c."consumed_at") AS "verified_at"
  FROM "users" u
  JOIN "sms_verification_codes" c ON c."phone" = u."phone"
  WHERE c."consumed_at" IS NOT NULL AND (
    (c."user_id" = u."id" AND c."purpose" IN ('login', 'admin_login', 'reset_password'))
    OR (c."user_id" IS NULL AND c."purpose" = 'register'
      AND c."consumed_at" BETWEEN u."created_at" AND u."created_at" + interval '5 seconds')
  )
  GROUP BY u."id"
)
UPDATE "users" u SET "phone_verified_at" = v."verified_at"
FROM verified v WHERE u."id" = v."id";

CREATE TYPE "EmailVerificationPurpose" AS ENUM ('register', 'login', 'bind', 'reset_password', 'change_password');
CREATE TYPE "AccountVerificationSendState" AS ENUM ('pending', 'accepted', 'rejected', 'unknown', 'suppressed');

ALTER TABLE "sms_verification_codes" ADD COLUMN "send_state" "AccountVerificationSendState";

CREATE TABLE "email_verification_codes" (
  "id" VARCHAR(64) PRIMARY KEY,
  "email" VARCHAR(255) NOT NULL,
  "purpose" "EmailVerificationPurpose" NOT NULL,
  "user_id" VARCHAR(64),
  "requester_key" VARCHAR(64) NOT NULL,
  "code_hash" VARCHAR(64) NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "consumed_at" TIMESTAMP(3),
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "send_state" "AccountVerificationSendState" NOT NULL DEFAULT 'pending',
  "provider_request_id" VARCHAR(128),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "email_verification_codes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "email_verification_codes_email_created_at_idx" ON "email_verification_codes" ("email", "created_at");
CREATE INDEX "email_verification_codes_requester_key_created_at_idx" ON "email_verification_codes" ("requester_key", "created_at");
CREATE INDEX "email_verification_codes_expires_at_idx" ON "email_verification_codes" ("expires_at");
CREATE INDEX "email_verification_codes_user_id_idx" ON "email_verification_codes" ("user_id");

COMMIT;
