import { z } from 'zod'
import { storyStateSchema } from '../../../shared/contracts/story-compiler-contracts.js'

/** Shared plain literary value. Keep independent of provider, cursor and
 * review execution modules so schema construction cannot start that cycle. */
export const terminalCandidateSchema = z.object({
  exitState: storyStateSchema,
  lastUnfinishedAction: z.string().max(1000).default(''),
}).strict()
export type TerminalCandidate = z.infer<typeof terminalCandidateSchema>
