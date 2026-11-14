CREATE TYPE "AgentPersonalizationStyle" AS ENUM ('natural', 'professional', 'direct', 'partner');
CREATE TYPE "AgentPersonalizationDegree" AS ENUM ('less', 'default', 'more');
CREATE TYPE "AgentPersonalizationMemorySource" AS ENUM ('manual', 'conversation');

CREATE TABLE "agent_personalizations" (
    "user_id" VARCHAR(64) NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "memory_revision" INTEGER NOT NULL DEFAULT 0,
    "memory_epoch" INTEGER NOT NULL DEFAULT 0,
    "memory_epoch_changed_at" TIMESTAMP(3),
    "memory_enabled" BOOLEAN NOT NULL DEFAULT true,
    "preferred_name" VARCHAR(80) NOT NULL DEFAULT '',
    "about_me" VARCHAR(2000) NOT NULL DEFAULT '',
    "custom_instructions" VARCHAR(2000) NOT NULL DEFAULT '',
    "style" "AgentPersonalizationStyle" NOT NULL DEFAULT 'natural',
    "warmth" "AgentPersonalizationDegree" NOT NULL DEFAULT 'default',
    "enthusiasm" "AgentPersonalizationDegree" NOT NULL DEFAULT 'default',
    "detail" "AgentPersonalizationDegree" NOT NULL DEFAULT 'default',
    "emoji" "AgentPersonalizationDegree" NOT NULL DEFAULT 'less',
    "format" "AgentPersonalizationDegree" NOT NULL DEFAULT 'default',

    CONSTRAINT "agent_personalizations_pkey" PRIMARY KEY ("user_id")
);

CREATE TABLE "agent_personalization_memories" (
    "id" VARCHAR(64) NOT NULL,
    "user_id" VARCHAR(64) NOT NULL,
    "text" VARCHAR(500) NOT NULL,
    "text_digest" VARCHAR(64) NOT NULL,
    "source" "AgentPersonalizationMemorySource" NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_personalization_memories_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "agent_personalization_memories_user_id_text_digest_key" ON "agent_personalization_memories"("user_id", "text_digest");
CREATE INDEX "agent_personalization_memories_user_id_updated_at_id_idx" ON "agent_personalization_memories"("user_id", "updated_at" DESC, "id" DESC);

ALTER TABLE "agent_personalizations" ADD CONSTRAINT "agent_personalizations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_personalization_memories" ADD CONSTRAINT "agent_personalization_memories_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "agent_personalizations"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;
