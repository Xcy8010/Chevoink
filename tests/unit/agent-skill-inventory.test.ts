import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Prisma } from '@prisma/client'
import { skillCatalog, SKILL_ROUTER_VERSION } from '../../api/lib/agent/skills/index.js'
import { buildCustomSkillArtifacts } from '../../api/lib/agent/skills/custom.js'
import { resolveRuntimeSkillContext } from '../../api/lib/agent/skills/service.js'

const mocks = vi.hoisted(() => ({ db: {
  agentSkillRun: { findFirst: vi.fn() }, agentRun: { findFirst: vi.fn() }, agentExecutionState: { findUnique: vi.fn() },
  agentSkillInstallation: { findMany: vi.fn() }, agentSkillVersion: { findUnique: vi.fn() },
}, saved: vi.fn(), inTransaction: vi.fn() }))
vi.mock('../../api/lib/prisma.js', async original => ({ ...await original<object>(), prisma: mocks.db }))
vi.mock('../../api/lib/agent/runtime-state.js', () => ({ loadExecutionState: mocks.saved, readExecutionStateInTransaction: mocks.inTransaction }))
vi.mock('../../api/lib/agent/original-request.js', () => ({ readOriginalTaskRequest: vi.fn(async () => ({ sourceRunId: 'run' })) }))

const draft = { name: 'Explicit private skill', description: 'A private dialogue resource', intents: ['write' as const], modes: ['build' as const],
  phases: ['draft' as const], triggerPhrases: ['write dialogue'], negativeTriggerPhrases: ['only spelling'], instructions: { draft: 'Use the original private instructions.' } }
const artifacts = buildCustomSkillArtifacts(draft, '0.1.0', 'user')
const installation = { skillId: 'custom.frozen', enabled: true, lockedVersion: '0.2.0', skill: { id: 'custom.frozen', source: 'user',
  name: draft.name, description: draft.description, status: 'active', defaultVersion: '0.2.0', license: artifacts.manifest.license,
  versions: [{ version: '0.1.0', status: 'active', manifest: artifacts.manifest, instructions: artifacts.instructions },
    { version: '0.2.0', status: 'active', manifest: { ...artifacts.manifest, version: '0.2.0' }, instructions: { draft: 'Changed instructions.' } }] } }
const configuration = (complete: boolean, versions = [{ id: skillCatalog[0].id, version: skillCatalog[0].version }]) => ({ configuration: {
  skillRouterVersion: SKILL_ROUTER_VERSION, pinnedSkillVersions: versions, ...(complete ? { skillInventoryVersion: 1 } : {}),
} })

beforeEach(() => {
  vi.clearAllMocks()
  mocks.db.agentSkillRun.findFirst.mockResolvedValue(null)
  mocks.db.agentRun.findFirst.mockResolvedValue({ runtimeProtocolVersion: 1, taskRootId: 'root', status: 'running' })
  mocks.db.agentExecutionState.findUnique.mockResolvedValue({ taskRootId: 'root' })
  mocks.db.agentSkillInstallation.findMany.mockResolvedValue([installation])
  mocks.saved.mockResolvedValue(configuration(true))
})

describe('durable frozen skill inventory compatibility', () => {
  it('retains only the complete admitted inventory even when another private skill is now enabled', async () => {
    const result = await resolveRuntimeSkillContext('user', 'novel', 'run')
    expect(result.catalog).toEqual([skillCatalog[0]])
  })
  it('honors an explicitly empty complete inventory instead of loading current built-ins', async () => {
    mocks.saved.mockResolvedValueOnce(configuration(true, []))
    expect((await resolveRuntimeSkillContext('user', 'novel', 'run')).catalog).toEqual([])
  })
  it('keeps historical selected-only built-ins without admitting an unproven later private install', async () => {
    mocks.saved.mockResolvedValueOnce(configuration(false))
    expect((await resolveRuntimeSkillContext('user', 'novel', 'run')).catalog).toEqual(skillCatalog)
  })
  it('loads the exact admitted private version rather than its later active installation version', async () => {
    mocks.saved.mockResolvedValueOnce(configuration(true, [{ id: installation.skillId, version: '0.1.0' }]))
    const result = await resolveRuntimeSkillContext('user', 'novel', 'run')
    expect(result.catalog).toHaveLength(1)
    expect(result.catalog[0]).toMatchObject({ id: installation.skillId, version: '0.1.0', resources: { draft: artifacts.instructions.draft } })
  })
  it('rejects an unavailable pinned private version instead of loading its replacement', async () => {
    mocks.saved.mockResolvedValueOnce(configuration(true, [{ id: installation.skillId, version: 'missing' }]))
    await expect(resolveRuntimeSkillContext('user', 'novel', 'run')).rejects.toMatchObject({ code: 'SKILL_FROZEN_VERSION_UNAVAILABLE' })
  })
  it('uses only the supplied transaction to read a durable snapshot', async () => {
    const tx = { agentSkillRun: { findFirst: vi.fn(async () => null) },
      agentRun: { findFirst: vi.fn(async () => ({ runtimeProtocolVersion: 1, taskRootId: 'root', status: 'running' })) },
      agentExecutionState: { findUnique: vi.fn(async () => ({ taskRootId: 'root' })) }, agentSkillInstallation: { findMany: vi.fn(async () => [installation]) } }
    mocks.inTransaction.mockResolvedValueOnce(configuration(true))
    expect((await resolveRuntimeSkillContext('user', 'novel', 'run', tx as unknown as Prisma.TransactionClient)).catalog).toEqual([skillCatalog[0]])
    expect(mocks.inTransaction).toHaveBeenCalledWith(tx, 'root')
    expect(mocks.saved).not.toHaveBeenCalled()
    expect(mocks.db.agentRun.findFirst).not.toHaveBeenCalled()
    expect(mocks.db.agentSkillInstallation.findMany).not.toHaveBeenCalled()
  })
  it('retains the current enabled catalog for ordinary legacy tasks', async () => {
    mocks.db.agentRun.findFirst.mockResolvedValueOnce({ runtimeProtocolVersion: 0, taskRootId: null, status: 'running' })
    const result = await resolveRuntimeSkillContext('user', 'novel', 'run')
    expect(result.catalog.map(skill => skill.id)).toEqual([...skillCatalog.map(skill => skill.id), installation.skillId])
    expect(mocks.saved).not.toHaveBeenCalled()
  })
})
