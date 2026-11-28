export const NEXT_PROMPT_MAX_LENGTH = 80
export const NOVEL_SETUP_PREDICTION_STATES = ['missing', 'candidate', 'applied', 'general'] as const
export type NovelSetupPredictionState = typeof NOVEL_SETUP_PREDICTION_STATES[number]

export function readNovelSetupPredictionPayload(raw: string) {
  try {
    const value = JSON.parse(raw) as { cover?: NovelSetupPredictionState; text?: unknown } | null
    if (value?.cover && NOVEL_SETUP_PREDICTION_STATES.includes(value.cover)) return value
  } catch { /* A model can return incomplete JSON. */ }
}

export function readPlainNextPrompt(value: unknown): string | undefined {
  if (typeof value !== 'string') return
  const text = value.trim()
  if (text && text.length <= NEXT_PROMPT_MAX_LENGTH && !text.startsWith('{')
    && !/[\r\n\p{Cc}]|\[\[(?:CHEVOINK_|NP:)/u.test(text)) return text
}

/** Earlier completions can contain the setup envelope in the public text field. */
export function readNextPromptText(value: unknown): string | undefined {
  if (typeof value !== 'string') return
  return readPlainNextPrompt(value.trimStart().startsWith('{') ? readNovelSetupPredictionPayload(value)?.text : value)
}
