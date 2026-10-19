-- Independent opt-in Fetch credentials. Existing direct-reader behavior stays the default.
INSERT INTO "ai_model_configs"
  ("id", "key", "provider", "display_name", "model_name", "base_url", "tier", "multiplier_bps", "enabled", "selectable", "is_default", "metadata", "created_at", "updated_at")
VALUES
  ('tool-web-fetch', 'tool:web-fetch', 'unconfigured', '网页抓取', 'unconfigured', NULL, 'tool_fetch', 10000, false, false, false, '{"modelKind":"web_fetch","reasoningEfforts":["high"],"defaultReasoningEffort":"high","visionEnabled":false}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;
