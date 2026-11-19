BEGIN;

ALTER TYPE "ProjectMemoryType" ADD VALUE 'itemCard';
ALTER TYPE "ProjectMemoryType" ADD VALUE 'locationCard';
ALTER TYPE "ProjectMemoryType" ADD VALUE 'sceneCard';
ALTER TABLE "project_memory_entries"
  ADD COLUMN "identity_key" VARCHAR(160),
  ADD COLUMN "aliases" TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN "profile_tracked" BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX "project_memory_entries_novel_id_memory_type_identity_key_key"
  ON "project_memory_entries" ("novel_id", "memory_type", "identity_key");

CREATE TABLE "story_profile_changes" (
  "id" BIGSERIAL PRIMARY KEY,
  "memory_id" VARCHAR(64) NOT NULL REFERENCES "project_memory_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "chapter_id" VARCHAR(64) REFERENCES "chapters"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "section" TEXT NOT NULL,
  "body" TEXT,
  "restricted" BOOLEAN NOT NULL DEFAULT false,
  "manual" BOOLEAN NOT NULL DEFAULT false,
  "known_by" TEXT[] NOT NULL DEFAULT '{}'
);
CREATE INDEX "story_profile_changes_memory_id_id_idx" ON "story_profile_changes" ("memory_id", "id");
CREATE INDEX "story_profile_changes_chapter_id_idx" ON "story_profile_changes" ("chapter_id");

COMMIT;
