CREATE TABLE "account_device_sessions" (
  "id" VARCHAR(64) PRIMARY KEY,
  "user_id" VARCHAR(64) NOT NULL REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "token_version" INTEGER NOT NULL,
  "device_name" TEXT NOT NULL,
  "location" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_active_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "revoked_at" TIMESTAMP(3)
);
CREATE INDEX "account_device_sessions_user_id_token_version_idx" ON "account_device_sessions" ("user_id", "token_version");
