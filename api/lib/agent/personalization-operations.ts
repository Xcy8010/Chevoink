export const PERSONALIZATION_WRITE_ACTIONS: readonly string[] = [
  'account_preferences_update', 'account_memory_save', 'account_memory_update', 'account_memory_delete',
  'account_memory_restore', 'account_memory_clear', 'account_rule_set', 'account_rule_remove',
]
export const PERSONALIZATION_READ_ACTIONS = [
  'account_profile', 'creation_settings_get', 'account_preferences_get', 'account_memory_list', 'account_rule_operations',
] as const
export const PERSONALIZATION_TOOL_NAMES = new Set<string>([...PERSONALIZATION_READ_ACTIONS, ...PERSONALIZATION_WRITE_ACTIONS])
