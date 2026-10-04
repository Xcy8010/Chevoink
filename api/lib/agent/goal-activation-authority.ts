import { z } from 'zod'
import { startAgentLoopRunSchema, type StartAgentLoopRunRequest } from '../../../shared/contracts/index.js'
import { runtimeJson } from './runtime-common.js'

/** Deliberately conservative command grammar. Quoted/code/discussion text is
 * never promoted to consent. This parses the HTTP author's text, not model output. */
export function goalActivationObjective(prompt: string): string | null {
  if (isCurrentTaskGoalConsent(prompt)) return null
  const command = '(?:(?:请|帮我|给我)\\s*)?(?:启用|开启|打开|使用|切换到)\\s*目标(?:模式|任务)'
  const english = '(?:please\\s+)?(?:enable|activate|turn on|use|switch to)\\s+(?:the\\s+)?goal mode'
  const prefix = new RegExp(`^(?:${command}|${english})[，,。.!！:：;；\\s]+(.+)$`, 'isu').exec(prompt.trim())
  const suffix = new RegExp(`^(.+?)[，,。.!！;；\\n]+[\\t ]*(?:${command}|${english})[。.!！\\s]*$`, 'isu').exec(prompt.trim())
  const objective = (prefix?.[1] ?? suffix?.[1])?.trim()
  // For suffix commands the segment before the command must not be an
  // example/discussion/negation lead-in. Constraints inside the task survive.
  if (suffix && /(?:不要|别|不必|无需|禁止|不能|未要求|不想|例如|比如|假如|假设|如果|don't|do not|never|example|if)\s*[，,。.!！;；\s]*$/iu.test(suffix[1])) return null
  if (!objective || Array.from(objective).length < 3 || /^(?:当前任务|这个任务|继续|接着做|照旧|current task|continue)[。.!！\s]*$/iu.test(objective)) return null
  return objective
}

/** A control request has no new objective; its scope must come from an exact
 * server-bound, still-live author task. No attachment or model text is parsed. */
export function isCurrentTaskGoalConsent(prompt: string): boolean {
  return /^(?:(?:请|帮我)\s*)?(?:(?:给|为)\s*当前任务\s*(?:启用|开启|使用)\s*目标(?:模式|任务)|(?:启用|开启|使用)\s*目标(?:模式|任务)(?:[，,\s]*(?:(?:继续|用于|处理)\s*)?当前任务)?)[。.!！\s]*$/iu.test(prompt.trim())
    || /^(?:please\s+)?(?:enable|activate|turn on|use)\s+(?:the\s+)?goal mode\s+(?:for|to continue)\s+(?:the\s+)?current task[.!\s]*$/iu.test(prompt.trim())
}

export const humanAdmissionSchema = z.object({ version: z.literal(1), origin: z.literal('http'),
  requestHash: z.string().regex(/^[a-f0-9]{64}$/), objective: z.string().min(1).max(12_000).nullable() }).strict()

/** Server-only metadata is never in startAgentLoopRunSchema. */
export function withHumanAdmission(input: StartAgentLoopRunRequest) {
  const request = startAgentLoopRunSchema.parse(input)
  return { ...request, ...(input.modelAssignments ? { modelAssignments: input.modelAssignments } : {}), humanAdmission: { version: 1 as const, origin: 'http' as const,
    requestHash: runtimeJson(JSON.parse(JSON.stringify(request))).hash, objective: goalActivationObjective(request.prompt) } }
}

export function readHumanAdmission(saved: unknown) {
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return null
  const envelope = saved as Record<string, unknown>
  const grant = humanAdmissionSchema.safeParse(envelope.humanAdmission)
  const request = startAgentLoopRunSchema.safeParse(envelope)
  if (!grant.success || !request.success
    || grant.data.requestHash !== runtimeJson(JSON.parse(JSON.stringify(request.data))).hash
    || grant.data.objective !== goalActivationObjective(request.data.prompt)) return null
  return { request: request.data, grant: grant.data }
}
