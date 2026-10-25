import { describe, expect, it, vi } from 'vitest'
import { Prisma } from '@prisma/client'
import { available, fixture } from '../support/agent-durable-runtime-fixture.js'
import { prisma } from '../../api/lib/prisma.js'
import { executeAgentRun } from '../../api/lib/agent/loop.js'
import * as identity from '../../api/lib/agent/runtime-identity.js'
import * as credits from '../../api/lib/credits.js'
import * as ai from '../../api/lib/ai-service.js'
import { RunEventBus } from '../../api/lib/agent/events.js'
import { deregisterActiveRun, getActiveRun, registerActiveRun } from '../../api/lib/agent/active-runs.js'
import { cancelAllQuestions, resolveQuestionAnswer, waitForQuestionAnswer } from '../../api/lib/agent/permissions.js'
import type { AgentStreamEvent } from '../../shared/contracts/index.js'

const prompt = '修改本章'
const usage = { promptTokens: 13, completionTokens: 7, totalTokens: 20 }

describe.runIf(available)('legacy atomic start and exact owner cleanup', () => {
  it.each(['model-failure', 'unknown-start', 'sequence-conflict', 'invalid-budget', 'budget-read-failure', 'replacement-owner'] as const)(
    '%s preserves the original run and never leaves a newly admitted orphan', scenario => fixture(async f => {
      const resume = scenario === 'invalid-budget' || scenario === 'budget-read-failure'
      const initialUsage = scenario === 'invalid-budget' ? { ...usage, checkpoint: { broken: true } } : usage
      await prisma.agentRun.update({ where: { id: f.runId }, data: { runtimeProtocolVersion: 0, taskRootId: null,
        status: resume ? 'paused' : 'queued', startRequest: { prompt }, currentTurn: resume ? 2 : 0,
        usage: scenario === 'budget-read-failure' ? Prisma.DbNull : initialUsage } })
      const original = await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })
      const network = vi.fn(() => { throw Error('No provider request is authorized') }); vi.stubGlobal('fetch', network)
      const main = vi.spyOn(ai, 'chatWithTools').mockRejectedValue(Error('No main dispatch is authorized'))
      const critic = vi.spyOn(ai, 'generateTextCompletion').mockRejectedValue(Error('No critic dispatch is authorized'))
      const runtime = vi.spyOn(credits, 'getModelTierRuntime').mockRejectedValue(Error('synthetic model configuration failure'))
      const start = identity.startLegacyRuntimeRun
      const admission = vi.spyOn(identity, 'startLegacyRuntimeRun')
      if (scenario === 'unknown-start') admission.mockImplementationOnce(async (...args) => {
        await start(...args)
        throw Error('synthetic lost commit response')
      })
      if (scenario === 'sequence-conflict') await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 1,
        type: 'run.started', payload: { type: 'run.started', runId: f.runId, seq: 1, owner: 'different immutable owner' } } })
      if (scenario === 'budget-read-failure') vi.spyOn(prisma.aiUsageLog, 'findMany').mockRejectedValueOnce(Error('synthetic receipt read failure'))
      let replacement: { controller: AbortController; bus: RunEventBus; sessionId: string; userId: string } | undefined
      let replacementRow: Awaited<ReturnType<typeof prisma.agentRun.findUniqueOrThrow>> | undefined
      let question: ReturnType<typeof waitForQuestionAnswer> | undefined
      if (scenario === 'replacement-owner') runtime.mockImplementationOnce(async () => {
        const latest = await prisma.agentRunEvent.findFirstOrThrow({ where: { runId: f.runId }, orderBy: { seq: 'desc' } })
        const event: Extract<AgentStreamEvent, { type: 'run.started' }> = { seq: latest.seq + 1, runId: f.runId,
          ts: new Date().toISOString(), type: 'run.started', agent: { type: 'writingOrchestrator', title: '写作', model: 'speed' }, mode: 'build', title: '新执行' }
        await prisma.$transaction(async tx => {
          await tx.$queryRaw`SELECT id FROM agent_runs WHERE id = ${f.runId} FOR UPDATE`
          await tx.agentRunEvent.create({ data: { runId: f.runId, seq: event.seq, type: event.type, payload: event } })
          await tx.agentRun.update({ where: { id: f.runId }, data: { status: 'running', usage: { ...usage, totalTokens: 37 }, currentTurn: 5 } })
        })
        replacement = { controller: new AbortController(), bus: new RunEventBus(f.runId, event.seq), sessionId: f.sessionId, userId: f.userId }
        registerActiveRun(f.runId, replacement)
        question = waitForQuestionAnswer(f.runId, 'current-owner-question', 30000, replacement.controller.signal)
        replacementRow = await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })
        throw Error('old execution returns after a new owner starts')
      })
      try {
        await executeAgentRun({ ...f, prompt, mode: 'build', resume, modelTier: 'speed', eventStartSeq: 0 })
        const saved = await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })
        const events = await prisma.agentRunEvent.findMany({ where: { runId: f.runId }, orderBy: { seq: 'asc' } })
        expect(admission).toHaveBeenCalledTimes(1)
        expect(main).not.toHaveBeenCalled(); expect(critic).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled()
        expect(await prisma.aiUsageLog.count({ where: { userId: f.userId } })).toBe(0)
        expect(saved.taskSpec).toEqual(original.taskSpec)
        if (scenario === 'replacement-owner') {
          expect(saved).toEqual(replacementRow)
          expect(getActiveRun(f.runId)).toBe(replacement)
          expect(replacement!.controller.signal.aborted).toBe(false)
          expect(resolveQuestionAnswer(f.runId, 'current-owner-question', '当前作者答复')).toBe(true)
          await expect(question).resolves.toEqual({ answer: '当前作者答复', timedOut: false })
          expect(() => replacement!.bus.publishPersistedStart({ seq: replacement!.bus.lastSeq + 1, runId: f.runId,
            ts: new Date().toISOString(), type: 'run.started', agent: { type: 'writingOrchestrator', title: '写作', model: 'speed' }, mode: 'build', title: '仍可使用' })).not.toThrow()
          expect(events.filter(event => ['run.finished', 'run.paused'].includes(event.type))).toEqual([])
          expect(events.some(event => (event.payload as { code?: string }).code === 'run_status_unconfirmed')).toBe(false)
        } else if (scenario === 'sequence-conflict') {
          expect(saved).toEqual(original)
          expect(events).toHaveLength(1)
          expect(runtime).not.toHaveBeenCalled()
        } else {
          expect(saved.status).toBe(resume ? 'paused' : 'failed')
          expect(events.filter(event => event.type === 'run.started')).toHaveLength(1)
          if (resume) { expect(saved.usage).toEqual(original.usage); expect(saved.currentTurn).toBe(original.currentTurn); expect(runtime).not.toHaveBeenCalled() }
          if (scenario === 'unknown-start') expect(runtime).not.toHaveBeenCalled()
          expect(getActiveRun(f.runId)).toBeUndefined()
        }
      } finally {
        if (replacement) { replacement.controller.abort(); cancelAllQuestions(f.runId); deregisterActiveRun(f.runId); await replacement.bus.close() }
      }
    }), 30000)
})
