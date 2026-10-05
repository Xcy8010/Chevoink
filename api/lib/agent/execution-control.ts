import { z } from 'zod'

/** Required positive storage value in existing budget rows; never a task limit. */
export const COMPATIBILITY_TOKEN_LIMIT = 500

export type EffectiveExecutionControl = {
  version: 3
  controlPolicy: 'until_completion'
  origin: 'system_default' | 'unknown_legacy' | 'user'
  limits: { tokens: bigint | null; turns: number | null; activeTimeMs: bigint | null }
}

const decimal = z.string().regex(/^[1-9][0-9]*$/)
const metadataSchema = z.object({ version: z.literal(3), controlPolicy: z.literal('until_completion'),
  origin: z.enum(['system_default', 'unknown_legacy', 'user']),
  limits: z.object({ tokens: decimal.nullable(), turns: z.number().int().positive().safe().nullable(), activeTimeMs: decimal.nullable() }).strict(),
}).strict().refine(value => value.origin === 'user' || Object.values(value.limits).every(limit => limit === null))
export type SerializedExecutionControl = z.infer<typeof metadataSchema>

export function untilCompletionControl(origin: 'system_default' | 'unknown_legacy' = 'system_default'): EffectiveExecutionControl {
  if (origin !== 'system_default' && origin !== 'unknown_legacy') throw new TypeError('Unverified execution-control origin')
  return { version: 3, controlPolicy: 'until_completion', origin, limits: { tokens: null, turns: null, activeTimeMs: null } }
}

/** Pure numerical validation only. The caller must first verify the authenticated
 * immutable request and its receipts; metadata bearing origin:user is not authority. */
export function verifiedUserExecutionControl(limits: EffectiveExecutionControl['limits']): EffectiveExecutionControl {
  for (const key of ['tokens', 'activeTimeMs'] as const) {
    if (limits[key] !== null && (typeof limits[key] !== 'bigint' || limits[key] <= 0n)) throw new TypeError(`Invalid ${key} limit`)
  }
  if (limits.turns !== null && (!Number.isSafeInteger(limits.turns) || limits.turns <= 0)) throw new TypeError('Invalid turn limit')
  return { version: 3, controlPolicy: 'until_completion', origin: 'user', limits: { ...limits } }
}

export function serializeExecutionControl(control: EffectiveExecutionControl): SerializedExecutionControl {
  return metadataSchema.parse({ ...control, limits: { tokens: control.limits.tokens?.toString() ?? null,
    turns: control.limits.turns, activeTimeMs: control.limits.activeTimeMs?.toString() ?? null } })
}

/** Parsed metadata remains untrusted data, with decimal strings rather than
 * effective bigint limits. Provenance validation belongs to the owned reader. */
export function parseExecutionControl(value: unknown): SerializedExecutionControl {
  return metadataSchema.parse(value)
}

/** Dispatch checks actual consumption. Reservation projections use > separately:
 * reserving exactly the remaining opt-in allowance is valid. Missing measurements
 * for an applicable explicit limit are unknown, never silently treated as zero. */
export function executionLimitReached(control: EffectiveExecutionControl,
  usage: { tokens?: bigint; turns?: number; activeTimeMs?: bigint }): 'tokens' | 'turns' | 'active_time' | null {
  for (const key of ['tokens', 'activeTimeMs'] as const) {
    const value = usage[key]
    if (value !== undefined && (typeof value !== 'bigint' || value < 0n)) throw new TypeError(`Invalid measured ${key}`)
    if (control.limits[key] !== null && value === undefined) throw new TypeError(`Unknown measured ${key}`)
  }
  if (usage.turns !== undefined && (!Number.isSafeInteger(usage.turns) || usage.turns < 0)) throw new TypeError('Invalid measured turns')
  if (control.limits.turns !== null && usage.turns === undefined) throw new TypeError('Unknown measured turns')
  if (control.limits.tokens !== null && usage.tokens! >= control.limits.tokens) return 'tokens'
  if (control.limits.turns !== null && usage.turns! >= control.limits.turns) return 'turns'
  if (control.limits.activeTimeMs !== null && usage.activeTimeMs! >= control.limits.activeTimeMs) return 'active_time'
  return null
}
