ALTER TYPE "EmailVerificationPurpose" ADD VALUE 'appeal';
CREATE TABLE "GovernanceCase" (
  "id" TEXT PRIMARY KEY, "requestKey" TEXT NOT NULL UNIQUE, "kind" TEXT NOT NULL,
  "targetKind" TEXT NOT NULL, "targetId" TEXT NOT NULL, "subjectId" TEXT, "reporterId" TEXT,
  "requesterKey" TEXT NOT NULL, "category" TEXT NOT NULL, "statement" TEXT, "snapshot" TEXT,
  "status" TEXT NOT NULL DEFAULT 'pending', "relatedId" TEXT, "conclusion" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  "acknowledgeBy" TIMESTAMP(3) NOT NULL, "feedbackBy" TIMESTAMP(3), "materialsAt" TIMESTAMP(3),
  "acknowledgedAt" TIMESTAMP(3), "publicProgress" TEXT, "evidenceUntil" TIMESTAMP(3)
);
CREATE INDEX "GovernanceCase_status_acknowledgeBy_idx" ON "GovernanceCase" ("status","acknowledgeBy");
CREATE INDEX "GovernanceCase_reporterId_createdAt_idx" ON "GovernanceCase" ("reporterId","createdAt");
CREATE INDEX "GovernanceCase_requesterKey_createdAt_idx" ON "GovernanceCase" ("requesterKey","createdAt");
CREATE INDEX "GovernanceCase_targetKind_targetId_idx" ON "GovernanceCase" ("targetKind","targetId");
CREATE INDEX "GovernanceCase_evidenceUntil_idx" ON "GovernanceCase" ("evidenceUntil");
CREATE TABLE "GovernanceCaseEvent" (
  "id" TEXT PRIMARY KEY, "caseId" TEXT NOT NULL REFERENCES "GovernanceCase"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "actorId" TEXT, "action" TEXT NOT NULL, "prior" TEXT, "result" TEXT, "reason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "GovernanceCaseEvent_caseId_createdAt_idx" ON "GovernanceCaseEvent" ("caseId","createdAt");
