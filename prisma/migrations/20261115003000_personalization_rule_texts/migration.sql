BEGIN;

ALTER TABLE agent_personalizations ADD COLUMN tool_rule_texts JSONB NOT NULL DEFAULT '{}';
ALTER TABLE agent_personalizations ADD CONSTRAINT agent_personalizations_tool_rule_texts_object
  CHECK (jsonb_typeof(tool_rule_texts) = 'object');

-- Older servers can change permissions without replacing their associated text.
CREATE FUNCTION agent_personalization_prune_rule_texts() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.tool_rule_texts <> '{}'::jsonb THEN
    SELECT COALESCE(jsonb_object_agg(texts.key, texts.value), '{}'::jsonb)
    INTO NEW.tool_rule_texts
    FROM jsonb_each(NEW.tool_rule_texts) AS texts
    WHERE EXISTS (
      SELECT 1 FROM jsonb_array_elements(NEW.tool_rules) AS rule
      WHERE rule->>'toolName' = texts.key
        AND (
          (OLD.tool_rule_texts -> texts.key) IS DISTINCT FROM texts.value
          OR EXISTS (
            SELECT 1 FROM jsonb_array_elements(OLD.tool_rules) AS prior_rule
            WHERE prior_rule = rule
          )
        )
    );
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER agent_personalization_prune_rule_texts
  BEFORE UPDATE OF tool_rules ON agent_personalizations
  FOR EACH ROW WHEN (OLD.tool_rules IS DISTINCT FROM NEW.tool_rules)
  EXECUTE FUNCTION agent_personalization_prune_rule_texts();

COMMIT;
