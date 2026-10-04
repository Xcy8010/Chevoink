CREATE TABLE "agent_child_execution_grants" (
  "id" VARCHAR(64) NOT NULL,
  "parent_root_id" VARCHAR(64) NOT NULL,
  "parent_operation_id" VARCHAR(64) NOT NULL,
  "child_index" INTEGER NOT NULL,
  "admission_run_id" VARCHAR(64) NOT NULL,
  "admission_epoch" BIGINT NOT NULL,
  "current_parent_run_id" VARCHAR(64) NOT NULL,
  "generation" BIGINT NOT NULL,
  "child_run_id" VARCHAR(64) NOT NULL,
  "kind" VARCHAR(16) NOT NULL,
  "token_ceiling" INTEGER NOT NULL,
  "snapshot" JSONB NOT NULL,
  "snapshot_hash" VARCHAR(64) NOT NULL,
  "status" VARCHAR(24) NOT NULL DEFAULT 'admitted',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "agent_child_execution_grants_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "agent_child_execution_grants_index_check" CHECK ("child_index" BETWEEN 0 AND 4),
  CONSTRAINT "agent_child_execution_grants_epochs_check" CHECK ("admission_epoch" > 0 AND "generation" > 0),
  CONSTRAINT "agent_child_execution_grants_kind_check" CHECK ("kind" IN ('inline', 'spawned')),
  CONSTRAINT "agent_child_execution_grants_budget_check" CHECK ("token_ceiling" >= 500),
  CONSTRAINT "agent_child_execution_grants_status_check" CHECK ("status" IN ('admitted', 'running', 'paused_parent', 'reconciliation', 'completed', 'failed', 'cancelled')),
  CONSTRAINT "agent_child_execution_grants_parent_root_fkey" FOREIGN KEY ("parent_root_id") REFERENCES "agent_task_roots"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "agent_child_execution_grants_parent_operation_fkey" FOREIGN KEY ("parent_operation_id", "parent_root_id") REFERENCES "agent_operations"("id", "task_root_id") ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT "agent_child_execution_grants_admission_run_fkey" FOREIGN KEY ("admission_run_id") REFERENCES "agent_runs"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "agent_child_execution_grants_current_parent_fkey" FOREIGN KEY ("current_parent_run_id") REFERENCES "agent_runs"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "agent_child_execution_grants_child_run_fkey" FOREIGN KEY ("child_run_id") REFERENCES "agent_runs"("id") ON DELETE NO ACTION ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "agent_child_execution_grants_child_run_id_key" ON "agent_child_execution_grants"("child_run_id");
CREATE UNIQUE INDEX "agent_child_execution_grants_parent_operation_id_child_index_key" ON "agent_child_execution_grants"("parent_operation_id", "child_index");
CREATE INDEX "agent_child_execution_grants_parent_root_id_status_idx" ON "agent_child_execution_grants"("parent_root_id", "status");
CREATE INDEX "agent_child_execution_grants_current_parent_run_id_generation_idx" ON "agent_child_execution_grants"("current_parent_run_id", "generation");

-- The admission contract and sole child identity never change during adoption.
CREATE FUNCTION "agent_child_execution_grant_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id, NEW.parent_root_id, NEW.parent_operation_id, NEW.child_index,
    NEW.admission_run_id, NEW.admission_epoch, NEW.child_run_id, NEW.kind,
    NEW.token_ceiling, NEW.snapshot, NEW.snapshot_hash, NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id, OLD.parent_root_id, OLD.parent_operation_id, OLD.child_index,
    OLD.admission_run_id, OLD.admission_epoch, OLD.child_run_id, OLD.kind,
    OLD.token_ceiling, OLD.snapshot, OLD.snapshot_hash, OLD.created_at) THEN
    RAISE EXCEPTION 'immutable child execution admission cannot change' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "agent_child_execution_grant_immutable_update"
BEFORE UPDATE ON "agent_child_execution_grants"
FOR EACH ROW EXECUTE FUNCTION "agent_child_execution_grant_immutable"();
