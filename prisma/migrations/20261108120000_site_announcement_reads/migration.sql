CREATE TABLE "site_announcement_reads" (
  "user_id" VARCHAR(64) NOT NULL,
  "version_id" VARCHAR(64) NOT NULL,
  CONSTRAINT "site_announcement_reads_pkey" PRIMARY KEY ("user_id", "version_id"),
  CONSTRAINT "site_announcement_reads_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "site_announcement_reads_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "site_content_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "site_announcement_reads_version_id_idx" ON "site_announcement_reads"("version_id");
