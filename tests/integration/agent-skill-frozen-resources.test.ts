import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { prisma } from '../../api/lib/prisma.js'
import { historicalBuiltinCatalog, skillCatalog } from '../../api/lib/agent/skills/index.js'
import { resolveRuntimeSkillContext, syncBuiltinSkillCatalog } from '../../api/lib/agent/skills/service.js'
import { initializeExecutionState, loadExecutionState } from '../../api/lib/agent/runtime-state.js'
import { available, claim, fixture } from '../support/agent-durable-runtime-fixture.js'

describe.runIf(available)('frozen skill release resources (isolated PostgreSQL)', () => {
  it.each(['old', 'new'] as const)('%s durable configuration keeps exact resources/hash and unselected phase versions', async release => {
    await syncBuiltinSkillCatalog()
    await fixture(async f => {
      const catalog = release === 'old' ? historicalBuiltinCatalog : skillCatalog
      const pinned = (release === 'old' ? [catalog[3]] : catalog).map(({ id, version }) => ({ id, version }))
      await initializeExecutionState(await claim(f), {
        configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
          model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
          tools: [], toolAuthority: [], protectedChapterIds: [], pinnedSkillVersions: pinned,
          ...(release === 'new' ? { skillRouterVersion: '3.5.0' } : {}) },
        snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
          messages: [{ role: 'user', content: '修改本章' }], successfulToolSignatures: [] },
      })
      expect(await prisma.agentSkillRun.count({ where: { runId: f.runId } })).toBe(0)
      const before = await loadExecutionState(f.userId, f.runId)
      const context = await resolveRuntimeSkillContext(f.userId, f.novelId, f.runId)
      expect(context.routerVersion).toBe(release === 'old' ? '3.1.0' : '3.5.0')
      for (const skill of catalog) {
        expect(context.catalog.find(item => item.id === skill.id)).toMatchObject({ version: skill.version, resources: skill.resources })
      }
      const after = await loadExecutionState(f.userId, f.runId)
      expect(after.head).toEqual(before.head)
      expect(after.frame).toEqual(before.frame)
      await expect(resolveRuntimeSkillContext('other-user', f.novelId, f.runId)).rejects.toMatchObject({ code: 'SKILL_RUN_SCOPE_MISMATCH' })
      expect(await prisma.agentProviderAttempt.count({ where: { operation: { taskRootId: f.rootId } } })).toBe(0)
    })
  })

  it('legacy continuation keeps original task router/resources despite a new runId', async () => {
    await fixture(async f => {
      await prisma.agentSkillRun.create({ data: { runId: f.runId, userId: f.userId, novelId: f.novelId, phase: 'draft', routerVersion: '3.1.0',
        candidates: [], selected: [{ id: historicalBuiltinCatalog[3].id, name: historicalBuiltinCatalog[3].name, version: historicalBuiltinCatalog[3].version }],
        loaded: [], reasonCodes: [], confidence: 1 } })
      const old = await prisma.agentSkillRun.findUniqueOrThrow({ where: { runId: f.runId } })
      const continued = await prisma.agentRun.create({ data: { id: randomUUID(), userId: f.userId, novelId: f.novelId, sessionId: f.sessionId,
        mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', engine: 'loop', taskSpec: JSON.parse(JSON.stringify(f.spec)),
        startRequest: { prompt: '继续' }, createdAt: new Date(Date.now() + 1000) } })
      const context = await resolveRuntimeSkillContext(f.userId, f.novelId, continued.id)
      expect(context.routerVersion).toBe('3.1.0')
      expect(context.catalog.find(item => item.id === historicalBuiltinCatalog[3].id)).toMatchObject(historicalBuiltinCatalog[3])
      expect(await prisma.agentSkillRun.findUniqueOrThrow({ where: { runId: f.runId } })).toEqual(old)
      expect(await prisma.agentSkillRun.findUnique({ where: { runId: continued.id } })).toBeNull()
    })
  })
})
