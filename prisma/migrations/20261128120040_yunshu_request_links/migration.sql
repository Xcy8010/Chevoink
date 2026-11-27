CREATE TABLE "yunshu_request_links" (
  "kind" VARCHAR(12) NOT NULL, "localId" VARCHAR(64) NOT NULL, "requestId" VARCHAR(64) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("kind","localId","requestId")
);
CREATE INDEX "yunshu_request_links_requestId_idx" ON "yunshu_request_links"("requestId");
