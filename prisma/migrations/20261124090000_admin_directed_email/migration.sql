-- CreateEnum
CREATE TYPE "AdminEmailBatchState" AS ENUM ('preview', 'confirmed', 'cancelled');

-- CreateEnum
CREATE TYPE "AdminEmailMode" AS ENUM ('mock', 'tencent');

-- CreateEnum
CREATE TYPE "AdminEmailRecipientState" AS ENUM ('preview', 'queued', 'sending', 'accepted', 'deferred', 'delivered', 'rejected', 'bounced', 'unknown', 'skipped', 'cancelled');

-- CreateEnum
CREATE TYPE "AdminEmailSuppression" AS ENUM ('unsubscribed', 'hard_bounce', 'complained');

-- CreateTable
CREATE TABLE "admin_email_permissions" (
    "purpose" VARCHAR(32) NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "user_id" VARCHAR(64),
    "consented_at" TIMESTAMP(3),
    "source" VARCHAR(128),
    "suppression" "AdminEmailSuppression",
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "admin_email_permissions_pkey" PRIMARY KEY ("purpose","email")
);

-- CreateTable
CREATE TABLE "admin_email_batches" (
    "id" UUID NOT NULL,
    "admin_id" VARCHAR(64) NOT NULL,
    "purpose" VARCHAR(32) NOT NULL,
    "mode" "AdminEmailMode" NOT NULL,
    "template" JSONB NOT NULL,
    "template_hash" VARCHAR(64) NOT NULL,
    "selection" JSONB NOT NULL,
    "sampling" JSONB,
    "exclusions" JSONB NOT NULL,
    "candidate_count" INTEGER NOT NULL,
    "eligible_count" INTEGER NOT NULL,
    "recipient_count" INTEGER NOT NULL,
    "blocker" VARCHAR(24),
    "preview_hash" VARCHAR(64) NOT NULL,
    "replaced_by_id" UUID,
    "state" "AdminEmailBatchState" NOT NULL DEFAULT 'preview',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmed_at" TIMESTAMP(3),

    CONSTRAINT "admin_email_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_email_recipients" (
    "batch_id" UUID NOT NULL,
    "user_id" VARCHAR(64) NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "nickname" VARCHAR(64) NOT NULL,
    "weight" INTEGER,
    "state" "AdminEmailRecipientState" NOT NULL DEFAULT 'preview',
    "reason" VARCHAR(48),
    "attempt_id" UUID,
    "attempted_at" TIMESTAMP(3),
    "provider_message_id" VARCHAR(128),
    "provider_request_id" VARCHAR(128),
    "next_check_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "admin_email_recipients_pkey" PRIMARY KEY ("batch_id","user_id")
);

-- CreateIndex
CREATE INDEX "admin_email_batches_admin_id_mode_created_at_id_idx" ON "admin_email_batches"("admin_id", "mode", "created_at", "id");

-- CreateIndex
CREATE INDEX "admin_email_batches_mode_state_expires_at_idx" ON "admin_email_batches"("mode", "state", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "admin_email_recipients_attempt_id_key" ON "admin_email_recipients"("attempt_id");

-- CreateIndex
CREATE UNIQUE INDEX "admin_email_recipients_provider_message_id_key" ON "admin_email_recipients"("provider_message_id");

-- CreateIndex
CREATE INDEX "admin_email_recipients_state_updated_at_idx" ON "admin_email_recipients"("state", "updated_at");

-- CreateIndex
CREATE INDEX "admin_email_recipients_state_next_check_at_idx" ON "admin_email_recipients"("state", "next_check_at");

-- CreateIndex
CREATE UNIQUE INDEX "admin_email_recipients_batch_id_email_key" ON "admin_email_recipients"("batch_id", "email");

-- AddForeignKey
ALTER TABLE "admin_email_recipients" ADD CONSTRAINT "admin_email_recipients_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "admin_email_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
