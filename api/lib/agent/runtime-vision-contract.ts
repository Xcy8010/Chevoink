import { z } from 'zod'
import { prisma } from '../prisma.js'
import { withoutGoalEffects } from './goal-context.js'
import { runtimeJson } from './runtime-common.js'

const hash = z.string().regex(/^[a-f0-9]{64}$/)
const count = z.number().int().nonnegative().max(2147483647).nullable()
const routeSchema = z.object({ provider: z.string().min(1), modelName: z.string().min(1), baseUrl: z.string().min(1),
  providerMode: z.string(), options: z.record(z.string(), z.unknown()) }).strict()
export const visionWorkSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('unavailable'), result: z.object({ output: z.string() }).passthrough() }).strict(),
  z.object({ kind: z.literal('vision'), version: z.literal(1), route: routeSchema, pixelHash: hash, mime: z.string(),
    displayUrl: z.string(), question: z.string(), maxOutputTokens: z.literal(4096), billingPolicy: z.literal('platform_vision_v1') }).strict(),
])
type Work = Extract<z.infer<typeof visionWorkSchema>, { kind: 'vision' }>
export const visionResponseSchema = z.object({ httpStatus: z.number().int().min(100).max(599), description: z.string().nullable(),
  promptTokens: count, completionTokens: count, invalid: z.boolean() }).strict()
export const visionRawResponseSchema = z.object({ httpStatus: z.number().int().min(100).max(599), body: z.string() }).strict()
type Observation = z.infer<typeof visionResponseSchema>
export const visionProofSchema = z.object({ operationId: z.string(), attemptId: z.string(), parentOperationId: z.string(), parentInputHash: hash,
  requestHash: hash, policy: z.literal('platform_vision_v1'), chargedMilli: z.literal(0) }).strict()
/** A completed HTTP response is evidence even when its JSON/description is bad.
 * Transport/body-read failures never enter this function as known responses. */
export function inspectVisionResponse(httpStatus: number, body: string): Observation {
  let decoded: unknown
  try { decoded = JSON.parse(body) } catch { return visionResponseSchema.parse({ httpStatus, description: null, promptTokens: null, completionTokens: null, invalid: true }) }
  const value = z.object({ usage: z.unknown().optional(), choices: z.unknown().optional() }).passthrough().safeParse(decoded)
  const usage = z.object({ prompt_tokens: z.unknown().optional(), completion_tokens: z.unknown().optional() }).passthrough().safeParse(value.success ? value.data.usage : undefined)
  const choices = z.array(z.object({ message: z.object({ content: z.unknown().optional() }).passthrough().optional() }).nullable()).safeParse(value.success ? value.data.choices : undefined)
  const tokens = (input: unknown) => count.safeParse(input).success && input !== undefined ? input as number | null : null
  const content = choices.success ? choices.data[0]?.message?.content : undefined
  const description = typeof content === 'string' ? content.trim() : null
  // Retain an explicit bounded invalid result rather than silently truncating a
  // purported successful description or redispatching an oversized paid result.
  return visionResponseSchema.parse({ httpStatus, description: description && description.length <= 300000 ? description : null,
    promptTokens: tokens(usage.success ? usage.data.prompt_tokens : undefined),
    completionTokens: tokens(usage.success ? usage.data.completion_tokens : undefined), invalid: !description || description.length > 300000 })
}

export function visionRequest(work: Work) {
  return runtimeJson({ endpoint: `${work.route.baseUrl.replace(/\/$/, '')}/chat/completions`, body: { model: work.route.modelName,
    ...work.route.options, ...('max_completion_tokens' in work.route.options ? { max_completion_tokens: work.maxOutputTokens } : { max_tokens: work.maxOutputTokens }),
    image: { pixelHash: work.pixelHash, mime: work.mime }, question: work.question } }).value
}


export async function readVisionExemption(attemptId: string, event: { type: string; payload: unknown }) {
  if (event.type !== 'credit.exempt') return false
  const proof = visionProofSchema.safeParse(event.payload)
  if (!proof.success || proof.data.attemptId !== attemptId) return false
  const operation = await withoutGoalEffects(() => prisma.agentOperation.findUnique({ where: { id: proof.data.operationId }, include: { parent: true, attempts: true } }))
  if (!operation || operation.kind !== 'provider' || operation.action !== 'view_image_vision' || operation.parentOperationId !== proof.data.parentOperationId
    || runtimeJson(operation.inputSnapshot).hash !== operation.inputHash || operation.attempts.length !== 1
    || operation.attempts[0].id !== attemptId || operation.attempts[0].requestHash !== proof.data.requestHash
    || !operation.parent || operation.parent.kind !== 'tool' || operation.parent.action !== 'view_image'
    || operation.parent.taskRootId !== operation.taskRootId || operation.parent.inputHash !== proof.data.parentInputHash
    || runtimeJson(operation.parent.inputSnapshot).hash !== proof.data.parentInputHash) return false
  const parent = z.object({ input: z.object({ work: visionWorkSchema }) }).safeParse(operation.parent.inputSnapshot)
  const child = z.object({ input: z.object({ workHash: hash, parentInputHash: hash, request: z.unknown() }) }).safeParse(operation.inputSnapshot)
  return parent.success && parent.data.input.work.kind === 'vision' && child.success
    && operation.attempts[0].requestSnapshot !== null && runtimeJson(operation.attempts[0].requestSnapshot).hash === proof.data.requestHash
    && runtimeJson(operation.attempts[0].requestSnapshot).hash === runtimeJson({ provider: parent.data.input.work.route.provider,
      model: parent.data.input.work.route.modelName, request: child.data.input.request }).hash
    && child.data.input.parentInputHash === proof.data.parentInputHash && child.data.input.workHash === runtimeJson(parent.data.input.work).hash
    && runtimeJson(child.data.input.request).hash === runtimeJson(visionRequest(parent.data.input.work)).hash
}
