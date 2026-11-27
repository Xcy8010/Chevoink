BEGIN;

CREATE TABLE "account_restrictions" (
  "legacy_ban" BOOLEAN NOT NULL DEFAULT false,
  "id" VARCHAR(64) PRIMARY KEY,
  "user_id" VARCHAR(64) NOT NULL,
  "scope" VARCHAR(80) NOT NULL,
  "reason" TEXT NOT NULL,
  "clause" TEXT NOT NULL,
  "source_id" VARCHAR(64),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMP(3),
  "revoked_at" TIMESTAMP(3),
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "account_restrictions_user_id_scope_revoked_at_expires_at_idx" ON "account_restrictions" ("user_id", "scope", "revoked_at", "expires_at");

CREATE TABLE "agent_safety_events" (
  "id" VARCHAR(64) PRIMARY KEY,
  "user_id" VARCHAR(64) NOT NULL,
  "action_key" VARCHAR(180) NOT NULL,
  "source" VARCHAR(80) NOT NULL,
  "policy_version" VARCHAR(80) NOT NULL,
  "category" VARCHAR(80) NOT NULL,
  "status" VARCHAR(80) NOT NULL,
  "evasion" VARCHAR(80) NOT NULL,
  "evidence_ref" TEXT,
  "review_reason" TEXT,
  "reviewer_id" VARCHAR(64),
  "reviewed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "agent_safety_events_user_id_status_created_at_idx" ON "agent_safety_events" ("user_id", "status", "created_at");
CREATE UNIQUE INDEX "agent_safety_events_user_id_action_key_key" ON "agent_safety_events" ("user_id", "action_key");

CREATE TABLE "agent_safety_escalations" (
  "window_days" INTEGER NOT NULL,
  "event_ids" TEXT[] NOT NULL,
  "id" VARCHAR(64) PRIMARY KEY,
  "user_id" VARCHAR(64) NOT NULL,
  "event_id" VARCHAR(64) NOT NULL,
  "level" VARCHAR(80) NOT NULL,
  "restriction_id" VARCHAR(64),
  "corrected_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "agent_safety_escalations_user_id_level_created_at_idx" ON "agent_safety_escalations" ("user_id", "level", "created_at");
CREATE UNIQUE INDEX "agent_safety_escalations_event_id_level_key" ON "agent_safety_escalations" ("event_id", "level") WHERE "corrected_at" IS NULL;

CREATE TABLE "agent_safety_policy" (
  "id" VARCHAR(64) PRIMARY KEY,
  "mode" VARCHAR(80) NOT NULL,
  "window_days" INTEGER NOT NULL,
  "ban_days" INTEGER NOT NULL,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO "agent_safety_policy" ("id", "mode", "window_days", "ban_days") VALUES ('active', 'observe', 30, 7);


-- Legacy clients and maintenance commands still own users.banned_at. Mirror
-- only that original ban, leaving overlapping scoped or timed decisions intact.
CREATE FUNCTION mirror_legacy_governance_ban() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.banned_at IS NULL AND NEW.banned_at IS NOT NULL THEN
    INSERT INTO account_restrictions (id,user_id,scope,reason,clause,source_id,created_at,legacy_ban)
    VALUES ('legacy-' || md5(NEW.id || clock_timestamp()::text),NEW.id,'platform','账号封禁','历史全站封禁入口','legacy-ban',NEW.banned_at,true);
  ELSIF OLD.banned_at IS NOT NULL AND NEW.banned_at IS NULL THEN
    UPDATE account_restrictions SET revoked_at=CURRENT_TIMESTAMP WHERE user_id=NEW.id AND legacy_ban AND revoked_at IS NULL;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER mirror_legacy_ban AFTER UPDATE OF banned_at ON users
FOR EACH ROW EXECUTE FUNCTION mirror_legacy_governance_ban();

INSERT INTO account_restrictions (id,user_id,scope,reason,clause,source_id,created_at,legacy_ban)
 SELECT 'legacy-' || md5(id || banned_at::text),id,'platform','历史账号封禁','历史处置记录','legacy-ban',banned_at,true FROM users WHERE banned_at IS NOT NULL;

COMMIT;
