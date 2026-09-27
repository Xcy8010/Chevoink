-- CreateTable
CREATE TABLE "agent_goals" (
    "id" VARCHAR(64) NOT NULL,
    "user_id" VARCHAR(64) NOT NULL,
    "novel_id" VARCHAR(64) NOT NULL,
    "session_id" VARCHAR(64) NOT NULL,
    "current_revision" INTEGER NOT NULL DEFAULT 1,
    "pending_revision" INTEGER,
    "resume_status" VARCHAR(24),
    "status" VARCHAR(24) NOT NULL DEFAULT 'active',
    "phase" VARCHAR(24) NOT NULL DEFAULT 'queued',
    "state_version" INTEGER NOT NULL DEFAULT 1,
    "epoch" BIGINT NOT NULL DEFAULT 1,
    "current_run_id" VARCHAR(64),
    "execution_options" JSONB NOT NULL,
    "continuation_index" INTEGER NOT NULL DEFAULT 0,
    "reason_code" VARCHAR(96),
    "next_eligible_at" TIMESTAMP(3),
    "block_fingerprint" VARCHAR(64),
    "block_count" INTEGER NOT NULL DEFAULT 0,
    "progress_hash" VARCHAR(64),
    "active_since" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "agent_goals_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "agent_goals_state_check" CHECK (
      "status" IN ('active','updating','paused','blocked','usage_limited','budget_limited','completed','cancelled')
      AND "phase" IN ('idle','queued','executing','awaiting_input','awaiting_approval','awaiting_provider','reconciling','reviewing')
      AND "current_revision" > 0 AND "state_version" > 0 AND "epoch" > 0
      AND "continuation_index" >= 0 AND "block_count" >= 0
      AND ("pending_revision" IS NULL OR "pending_revision" > "current_revision")
    )
);

-- CreateTable
CREATE TABLE "agent_goal_revisions" (
    "goal_id" VARCHAR(64) NOT NULL,
    "revision" INTEGER NOT NULL,
    "objective" TEXT NOT NULL,
    "request" JSONB NOT NULL,
    "authority_hash" VARCHAR(64) NOT NULL,
    "source_action_id" VARCHAR(64) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_goal_revisions_pkey" PRIMARY KEY ("goal_id","revision"),
    CONSTRAINT "agent_goal_revision_content_check" CHECK ("revision" > 0 AND char_length(btrim("objective")) BETWEEN 1 AND 12000)
);

-- CreateTable
CREATE TABLE "agent_goal_executions" (
    "id" VARCHAR(64) NOT NULL,
    "goal_id" VARCHAR(64) NOT NULL,
    "goal_revision" INTEGER NOT NULL,
    "epoch" BIGINT NOT NULL,
    "task_root_id" VARCHAR(64),
    "run_id" VARCHAR(64) NOT NULL,
    "continuation_index" INTEGER NOT NULL,
    "trigger" VARCHAR(32) NOT NULL,
    "source_event_id" VARCHAR(160) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_goal_executions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_goal_budgets" (
    "goal_id" VARCHAR(64) NOT NULL,
    "token_limit" BIGINT NOT NULL,
    "platform_token_cap" BIGINT NOT NULL,
    "tokens_used" BIGINT NOT NULL DEFAULT 0,
    "tokens_reserved" BIGINT NOT NULL DEFAULT 0,
    "credits_used_micros" BIGINT NOT NULL DEFAULT 0,
    "active_time_ms" BIGINT NOT NULL DEFAULT 0,
    "active_time_limit_ms" BIGINT NOT NULL,
    "platform_time_cap_ms" BIGINT NOT NULL,

    CONSTRAINT "agent_goal_budgets_pkey" PRIMARY KEY ("goal_id"),
    CONSTRAINT "agent_goal_budget_nonnegative" CHECK (
      "token_limit" > 0 AND "token_limit" <= "platform_token_cap" AND "tokens_used" >= 0 AND "tokens_reserved" >= 0
      AND "credits_used_micros" >= 0 AND "active_time_ms" >= 0
      AND "active_time_limit_ms" > 0 AND "active_time_limit_ms" <= "platform_time_cap_ms"
    )
);

-- CreateTable
CREATE TABLE "agent_goal_events" (
    "id" VARCHAR(64) NOT NULL,
    "sequence" SERIAL NOT NULL,
    "goal_id" VARCHAR(64) NOT NULL,
    "session_id" VARCHAR(64) NOT NULL,
    "state_version" INTEGER NOT NULL,
    "goal_revision" INTEGER NOT NULL,
    "type" VARCHAR(48) NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_goal_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_goal_commands" (
    "user_id" VARCHAR(64) NOT NULL,
    "request_id" VARCHAR(64) NOT NULL,
    "request_hash" VARCHAR(64) NOT NULL,
    "response" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_goal_commands_pkey" PRIMARY KEY ("user_id","request_id")
);

-- CreateTable
CREATE TABLE "agent_goal_evidence" (
    "id" VARCHAR(64) NOT NULL,
    "goal_id" VARCHAR(64) NOT NULL,
    "revision" INTEGER NOT NULL,
    "criterion_id" VARCHAR(64) NOT NULL,
    "description" TEXT NOT NULL,
    "kind" VARCHAR(32) NOT NULL,
    "target_id" VARCHAR(64),
    "status" VARCHAR(24) NOT NULL DEFAULT 'pending',
    "receipt" JSONB NOT NULL,
    "verified_at" TIMESTAMP(3),

    CONSTRAINT "agent_goal_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_goal_usage" (
    "source_key" VARCHAR(192) NOT NULL,
    "goal_id" VARCHAR(64) NOT NULL,
    "run_id" VARCHAR(64) NOT NULL,
    "reserved_tokens" BIGINT NOT NULL DEFAULT 0,
    "input_tokens" BIGINT NOT NULL DEFAULT 0,
    "output_tokens" BIGINT NOT NULL DEFAULT 0,
    "credits_micros" BIGINT NOT NULL DEFAULT 0,
    "status" VARCHAR(24) NOT NULL DEFAULT 'reserved',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_goal_usage_pkey" PRIMARY KEY ("source_key"),
    CONSTRAINT "agent_goal_usage_nonnegative" CHECK (
      "reserved_tokens" >= 0 AND "input_tokens" >= 0 AND "output_tokens" >= 0 AND "credits_micros" >= 0
      AND "status" IN ('reserved','known','rejected','unknown')
    )
);

-- CreateIndex
CREATE INDEX "agent_goals_status_next_eligible_at_idx" ON "agent_goals"("status", "next_eligible_at");

-- CreateIndex
CREATE INDEX "agent_goals_user_id_session_id_created_at_idx" ON "agent_goals"("user_id", "session_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "agent_goal_executions_run_id_key" ON "agent_goal_executions"("run_id");

-- CreateIndex
CREATE UNIQUE INDEX "agent_goal_executions_source_event_id_key" ON "agent_goal_executions"("source_event_id");

-- CreateIndex
CREATE INDEX "agent_goal_executions_goal_id_goal_revision_idx" ON "agent_goal_executions"("goal_id", "goal_revision");

-- CreateIndex
CREATE UNIQUE INDEX "agent_goal_executions_goal_id_continuation_index_key" ON "agent_goal_executions"("goal_id", "continuation_index");

-- CreateIndex
CREATE UNIQUE INDEX "agent_goal_events_sequence_key" ON "agent_goal_events"("sequence");

-- CreateIndex
CREATE INDEX "agent_goal_events_session_id_sequence_idx" ON "agent_goal_events"("session_id", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "agent_goal_events_goal_id_state_version_key" ON "agent_goal_events"("goal_id", "state_version");

-- CreateIndex
CREATE UNIQUE INDEX "agent_goal_evidence_goal_id_revision_criterion_id_key" ON "agent_goal_evidence"("goal_id", "revision", "criterion_id");

-- CreateIndex
CREATE INDEX "agent_goal_usage_goal_id_status_idx" ON "agent_goal_usage"("goal_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "agent_sessions_id_user_id_novel_id_key" ON "agent_sessions"("id", "user_id", "novel_id");

-- AddForeignKey
ALTER TABLE "agent_goals" ADD CONSTRAINT "agent_goals_session_id_user_id_novel_id_fkey" FOREIGN KEY ("session_id", "user_id", "novel_id") REFERENCES "agent_sessions"("id", "user_id", "novel_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_goal_revisions" ADD CONSTRAINT "agent_goal_revisions_goal_id_fkey" FOREIGN KEY ("goal_id") REFERENCES "agent_goals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_goal_executions" ADD CONSTRAINT "agent_goal_executions_goal_id_fkey" FOREIGN KEY ("goal_id") REFERENCES "agent_goals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_goal_executions" ADD CONSTRAINT "agent_goal_executions_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_goal_budgets" ADD CONSTRAINT "agent_goal_budgets_goal_id_fkey" FOREIGN KEY ("goal_id") REFERENCES "agent_goals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_goal_events" ADD CONSTRAINT "agent_goal_events_goal_id_fkey" FOREIGN KEY ("goal_id") REFERENCES "agent_goals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_goal_evidence" ADD CONSTRAINT "agent_goal_evidence_goal_id_fkey" FOREIGN KEY ("goal_id") REFERENCES "agent_goals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_goal_usage" ADD CONSTRAINT "agent_goal_usage_goal_id_fkey" FOREIGN KEY ("goal_id") REFERENCES "agent_goals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Application CAS complements these database invariants under concurrent admissions.
CREATE UNIQUE INDEX "agent_goals_one_nonterminal_per_session"
ON "agent_goals" ("session_id") WHERE "status" NOT IN ('completed', 'cancelled');

ALTER TABLE "agent_goal_executions" ADD CONSTRAINT "agent_goal_execution_revision_fkey"
FOREIGN KEY ("goal_id", "goal_revision") REFERENCES "agent_goal_revisions" ("goal_id", "revision") ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "agent_goal_evidence" ADD CONSTRAINT "agent_goal_evidence_revision_fkey"
FOREIGN KEY ("goal_id", "revision") REFERENCES "agent_goal_revisions" ("goal_id", "revision") ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "agent_goal_executions" ADD CONSTRAINT "agent_goal_execution_position_check"
CHECK ("goal_revision" > 0 AND "epoch" > 0 AND "continuation_index" > 0
  AND "trigger" IN ('author', 'goal_auto', 'revision', 'steering', 'subagent'));
