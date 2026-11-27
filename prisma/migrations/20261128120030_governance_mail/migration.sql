CREATE TABLE "governance_mail" (
  "id" TEXT PRIMARY KEY, "eventId" TEXT NOT NULL, "userId" TEXT NOT NULL, "kind" TEXT NOT NULL,
  "reason" TEXT NOT NULL, "measure" TEXT, "recipient" TEXT, "state" TEXT NOT NULL DEFAULT 'pending',
  "mode" TEXT, "attemptedAt" TIMESTAMP(3), "requestId" TEXT, "messageId" TEXT, "detail" TEXT,
  "nextCheckAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "governance_mail_eventId_kind_userId_key" ON "governance_mail" ("eventId","kind","userId");
CREATE INDEX "governance_mail_state_nextCheckAt_createdAt_idx" ON "governance_mail" ("state","nextCheckAt","createdAt");
