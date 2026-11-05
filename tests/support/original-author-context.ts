import { expect } from 'vitest'
import { prisma } from '../../api/lib/prisma.js'
import { readOriginalTaskRequest } from '../../api/lib/agent/original-request.js'
import { assembleContext } from '../../api/lib/agent/context.js'
import { getAgentDefinition } from '../../api/lib/agent/agents.js'
import { taskSpecSchema } from '../../shared/contracts/index.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'

/** Natural-language requirements reach the main Agent verbatim. This is not
 * a claim that a parser can reject every model call violating those words. */
export async function assertOriginalAuthorContext(ctx: Pick<ToolContext, 'userId' | 'novelId' | 'sessionId' | 'runId' | 'chapterId'>, expectedPrompt?: string) {
  const original = await prisma.$transaction(tx => readOriginalTaskRequest(tx, ctx))
  expect(typeof original.prompt).toBe('string')
  const prompt = original.prompt!.trim()
  expect(prompt.length).toBeGreaterThan(0)
  if (expectedPrompt !== undefined) expect(prompt).toBe(expectedPrompt.trim())
  const assembled = await assembleContext({ ...ctx, sessionId: ctx.sessionId!, chapterId: ctx.chapterId ?? null,
    agent: getAgentDefinition('orchestrator'), mode: 'build', prompt: original.prompt!, taskSpec: taskSpecSchema.parse(original.spec), modelTier: 'speed' })
  const intent = assembled.messages.at(-1)!
  expect(intent.role).toBe('user')
  expect(typeof intent.content).toBe('string')
  expect(String(intent.content).slice(0, prompt.length)).toBe(prompt)
  expect(String(intent.content).slice(prompt.length)).toMatch(/^(?:$|\n\n)/)
  expect(runtimeJson(await prisma.$transaction(tx => readOriginalTaskRequest(tx, ctx))).hash).toBe(runtimeJson(original).hash)
}
