CREATE TABLE "site_contents" (
 "id" VARCHAR(64) PRIMARY KEY, "kind" VARCHAR(24) NOT NULL, "key" VARCHAR(80) NOT NULL,
 "revision" INTEGER NOT NULL DEFAULT 1 CHECK ("revision" > 0), "draft" JSONB NOT NULL,
 "withdrawn" BOOLEAN NOT NULL DEFAULT false, "deleted_at" TIMESTAMP(3), "published_version_id" VARCHAR(64),
 "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "site_contents_kind_key_key" ON "site_contents"("kind", "key");
CREATE TABLE "site_content_versions" (
 "id" VARCHAR(64) PRIMARY KEY, "content_id" VARCHAR(64) NOT NULL REFERENCES "site_contents"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "content_version" INTEGER NOT NULL CHECK ("content_version" > 0), "payload" JSONB NOT NULL, "hash" VARCHAR(64) NOT NULL,
 "published_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "effective_at" TIMESTAMP(3)
);
CREATE UNIQUE INDEX "site_content_versions_content_id_content_version_key" ON "site_content_versions"("content_id", "content_version");
CREATE INDEX "site_content_versions_effective_at_idx" ON "site_content_versions"("effective_at");
CREATE TABLE "user_legal_consents" (
 "id" VARCHAR(64) PRIMARY KEY, "user_id" VARCHAR(64) NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "version_id" VARCHAR(64) NOT NULL REFERENCES "site_content_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "kind" VARCHAR(24) NOT NULL CHECK ("kind" IN ('terms','privacy')), "hash" VARCHAR(64) NOT NULL,
 "accepted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "user_legal_consents_user_id_kind_key" ON "user_legal_consents"("user_id", "kind");