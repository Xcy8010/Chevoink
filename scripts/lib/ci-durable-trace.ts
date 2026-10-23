import { z } from 'zod'

const milliseconds = z.number().finite().min(0).max(1_000_000_000)
const ordinal = z.number().int().nonnegative().max(1_000_000_000)
const phase = z.enum(['fixture.setup', 'fixture.work', 'fixture.cleanup', 'step', 'memory', 'verification', 'append',
  'lease', 'chapter.seed', 'compiler.prepare', 'compiler.tasks', 'baseline', 'runtime.seed', 'credit.seed'])
const cpu = { cpuUserMs: milliseconds, cpuSystemMs: milliseconds }
const traceSchema = z.object({ event: z.enum(['start', 'finish', 'abort', 'mock']), elapsedMs: milliseconds, mockOrdinal: ordinal, ...cpu,
  phase: phase.optional(), ordinal: ordinal.optional(), durationMs: milliseconds.optional(), outcome: z.enum(['fulfilled', 'rejected']).optional(),
  pending: z.array(z.object({ phase, ordinal, durationMs: milliseconds, ...cpu })).max(10).optional() })

/** Fixed counters only. Never forward arbitrary captured console/error content
 * into public diagnostics, even when it uses the known tracing prefix. */
export function parseCiDurableTrace(content: string) {
  const prefix = '[durable-quality-stage] '
  if (!content.startsWith(prefix) || content.length > 8192) return null
  try {
    const parsed = traceSchema.safeParse(JSON.parse(content.slice(prefix.length)))
    return parsed.success ? parsed.data : null
  } catch { return null }
}
export type CiDurableTrace = NonNullable<ReturnType<typeof parseCiDurableTrace>>

const cpuFrame = z.object({ file: z.string().max(160).regex(/^(?:(?:api|scripts|tests|node_modules)\/[A-Za-z0-9_./@-]+|node:[A-Za-z0-9_/-]+|\[(?:runtime|v8)\])$/).refine(value => !value.split('/').includes('..')),
  name: z.string().max(80).regex(/^[A-Za-z0-9_$ .<>()[\]:-]*$/), selfMs: milliseconds, inclusiveMs: milliseconds })
const cpuSchema = z.object({ samples: ordinal, totalMs: milliseconds, idleMs: milliseconds, self: z.array(cpuFrame).max(8), own: z.array(cpuFrame).max(8) })
export function parseCiDurableCpu(content: string) {
  const prefix = '[durable-quality-cpu] '
  if (!content.startsWith(prefix) || content.length > 8192) return null
  try {
    const parsed = cpuSchema.safeParse(JSON.parse(content.slice(prefix.length)))
    return parsed.success ? parsed.data : null
  } catch { return null }
}
export type CiDurableCpu = NonNullable<ReturnType<typeof parseCiDurableCpu>>
