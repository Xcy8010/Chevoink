import { z } from 'zod'

// Same length accepted by the ordinary web_search tool.
export const PUBLIC_WEB_QUESTION_LIMIT = 120
export const publicWebQuestionSchema = z.string().trim().min(1).max(PUBLIC_WEB_QUESTION_LIMIT)
