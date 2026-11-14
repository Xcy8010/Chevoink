BEGIN;

CREATE TYPE "AgentPersonalizationMemoryChange" AS ENUM ('saved', 'edited', 'merged', 'corrected', 'capacity', 'restored', 'migrated');

ALTER TABLE agent_personalizations ADD COLUMN tool_rules JSONB NOT NULL DEFAULT '[]';
ALTER TABLE agent_personalizations ADD CONSTRAINT agent_personalizations_rules_array CHECK (jsonb_typeof(tool_rules) = 'array');
ALTER TABLE agent_personalization_memories
    ADD COLUMN active_slot INTEGER,
    ADD COLUMN recovery_until TIMESTAMP(3),
    ADD COLUMN pinned BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN topic VARCHAR(40),
    ADD COLUMN last_change "AgentPersonalizationMemoryChange" NOT NULL DEFAULT 'saved',
    ADD COLUMN hit_count INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN last_hit_at TIMESTAMP(3);

-- Move both legacy fields into owner-managed memories. Numbered chunks preserve
-- the entire background, including paragraph breaks, within the per-item limit.
WITH legacy AS (
    SELECT user_id, '以后请叫我' || preferred_name AS text, 'address' AS topic, 0 AS ordinal
    FROM agent_personalizations WHERE preferred_name <> ''
    UNION ALL
    SELECT p.user_id, '创作背景' || CASE WHEN char_length(p.about_me) > 480 THEN '（' || i || '）' ELSE '' END || '：' ||
        substring(p.about_me FROM ((i - 1) * 480 + 1) FOR 480), NULL, i
    FROM agent_personalizations p
    CROSS JOIN LATERAL generate_series(1, (char_length(p.about_me) + 479) / 480) i
), normalized AS (
    SELECT *, encode(sha256(convert_to(btrim(regexp_replace(lower(normalize(text, NFKC)), '\s+', ' ', 'g')), 'UTF8')), 'hex') AS digest
    FROM legacy
)
INSERT INTO agent_personalization_memories (id, user_id, text, text_digest, source, pinned, topic, last_change, updated_at)
SELECT 'v2_' || md5(user_id || ':' || ordinal), user_id, text, digest, 'manual', true, topic, 'migrated', CURRENT_TIMESTAMP
FROM normalized
ON CONFLICT (user_id, text_digest) DO UPDATE SET
    pinned = true, topic = EXCLUDED.topic, last_change = 'migrated', revision = agent_personalization_memories.revision + 1;

-- Existing conversational entries can already contain core preferences.
WITH statements AS (
    SELECT id, regexp_replace(regexp_replace(btrim(regexp_replace(lower(normalize(text, NFKC)), '\s+', ' ', 'g')),
        '[。.!！]+$', ''), '^(更正|纠正|改一下|correction|update)[:：,，] *', '') AS statement
    FROM agent_personalization_memories WHERE topic IS NULL
), identified AS (
    SELECT id, CASE
        WHEN statement ~ '^(((以后|今后|从今以后|从现在起)(请)?|请)(叫我|称呼我)(为)?|(please )?call me )[^，,。!?！？:：;；]{1,80}$' THEN 'address'
        WHEN statement ~ '^(以后|今后|从现在起)(请)?(用|使用)(简体中文|繁体中文|普通话|中文|英语|英文|日语|日文)(回答(我)?|回复(我)?|交流)$' THEN 'language'
        WHEN statement ~ '^(以后|今后|请一直|我明确要求) *(请)?(不要|别|禁止|避免)' THEN 'boundary'
    END AS topic
    FROM statements
)
UPDATE agent_personalization_memories m SET topic = i.topic FROM identified i WHERE m.id = i.id AND i.topic IS NOT NULL;

WITH ranked AS (
    SELECT id, row_number() OVER (PARTITION BY user_id ORDER BY pinned DESC, (topic IS NOT NULL) DESC, (source = 'manual') DESC, updated_at DESC, id DESC) AS slot
    FROM agent_personalization_memories
)
UPDATE agent_personalization_memories AS m
SET active_slot = CASE WHEN r.slot <= 50 THEN r.slot::INTEGER END,
    recovery_until = CASE WHEN r.slot > 50 THEN (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') + INTERVAL '30 days' END,
    last_change = CASE WHEN r.slot > 50 THEN 'capacity'::"AgentPersonalizationMemoryChange" ELSE m.last_change END,
    revision = m.revision + CASE WHEN r.slot > 50 THEN 1 ELSE 0 END
FROM ranked r WHERE m.id = r.id;

-- Keep the old columns for compatibility with the running binary during the
-- switch. The actual values now have one owner and are not left behind on deletion.
UPDATE agent_personalizations p
SET preferred_name = '', about_me = '', revision = revision + 1, memory_revision = memory_revision + 1,
    memory_epoch = memory_epoch + 1, memory_epoch_changed_at = CURRENT_TIMESTAMP AT TIME ZONE 'UTC'
WHERE EXISTS (SELECT 1 FROM agent_personalization_memories m WHERE m.user_id = p.user_id);

ALTER TABLE agent_personalizations ADD CONSTRAINT agent_personalizations_legacy_fields_retired
    CHECK (preferred_name = '' AND about_me = '');

CREATE UNIQUE INDEX agent_personalization_memories_user_id_active_slot_key ON agent_personalization_memories(user_id, active_slot);
ALTER TABLE agent_personalization_memories ADD CONSTRAINT agent_personalization_memories_slot_state CHECK (
    (active_slot IS NOT NULL AND active_slot BETWEEN 1 AND 50 AND recovery_until IS NULL)
    OR (active_slot IS NULL AND recovery_until IS NOT NULL)
);
ALTER TABLE agent_personalization_memories ADD CONSTRAINT agent_personalization_memories_hit_count CHECK (hit_count >= 0);

-- The previous server can still insert during the deploy's migration/switch
-- interval. It already serializes on agent_personalizations. Choose a slot
-- for that insert too, and reject it when full instead of exceeding 50.
CREATE FUNCTION agent_personalization_fill_active_slot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.active_slot IS NULL AND NEW.recovery_until IS NULL THEN
        SELECT s INTO NEW.active_slot FROM generate_series(1, 50) s
        WHERE NOT EXISTS (
            SELECT 1 FROM agent_personalization_memories m WHERE m.user_id = NEW.user_id AND m.active_slot = s
        ) ORDER BY s LIMIT 1;
    END IF;
    RETURN NEW;
END
$$;
CREATE TRIGGER agent_personalization_fill_active_slot BEFORE INSERT ON agent_personalization_memories
FOR EACH ROW EXECUTE FUNCTION agent_personalization_fill_active_slot();

CREATE TABLE agent_personalization_memory_hits (
    memory_id VARCHAR(64) NOT NULL REFERENCES agent_personalization_memories(id) ON DELETE CASCADE ON UPDATE CASCADE,
    run_id VARCHAR(64) NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT agent_personalization_memory_hits_pkey PRIMARY KEY (memory_id, run_id)
);
CREATE INDEX agent_personalization_memory_hits_run_id_idx ON agent_personalization_memory_hits(run_id);

COMMIT;
