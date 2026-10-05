import { afterEach, describe, expect, it, vi } from 'vitest'
import { skillCatalog } from '../../api/lib/agent/skills/index.js'
import { buildCustomSkillArtifacts } from '../../api/lib/agent/skills/custom.js'
import { resolveEnabledRuntimeSkills, syncBuiltinSkillCatalog } from '../../api/lib/agent/skills/service.js'
import { prisma } from '../../api/lib/prisma.js'

afterEach(() => vi.restoreAllMocks())

describe('versioned built-in writing resources', () => {
  it('creates 3.0.1 assets without updating any existing immutable version', async () => {
    vi.spyOn(prisma.agentSkillDefinition, 'upsert').mockResolvedValue({} as never)
    const versions = vi.spyOn(prisma.agentSkillVersion, 'upsert').mockResolvedValue({} as never)
    vi.spyOn(prisma, '$transaction').mockResolvedValue([])
    await syncBuiltinSkillCatalog()
    const changed = ['cn-long-outline.v3', 'cn-scene-task.v3', 'cn-webfiction-draft.v3', 'cn-emotion-grounding.v3']
    for (const id of changed) {
      const call = versions.mock.calls.find(([input]) => input.where.skillId_version?.skillId === id)![0]
      expect(call.where.skillId_version).toEqual({ skillId: id, version: '3.0.1' })
      expect(call.create).toMatchObject({ version: '3.0.1', contentHash: expect.stringMatching(/^[a-f0-9]{64}$/) })
      expect(call.update).toEqual({})
    }
    expect(versions.mock.calls.every(([input]) => Object.keys(input.update).length === 0)).toBe(true)
  })

  it('keeps the existing code-asset policy for built-ins and respects disabled and custom locked versions', async () => {
    const instructions = { draft: '合成角色用短句表达兴奋，不回避关键问题。' }
    const artifacts = buildCustomSkillArtifacts({ name: '合成声口', description: '声口', intents: ['write'], modes: ['build'], phases: ['draft'],
      triggerPhrases: ['合成角色'], negativeTriggerPhrases: [], instructions, tokenBudget: 300, priority: 70 }, '0.1.0', 'user')
    vi.spyOn(prisma.agentSkillInstallation, 'findMany').mockResolvedValue([
      { skillId: 'cn-webfiction-draft.v3', enabled: true, lockedVersion: '3.0.0', skill: { source: 'builtin', status: 'active', versions: [{ version: '3.0.0', instructions: { draft: '合成旧版资源' } }] } },
      { skillId: 'cn-scene-task.v3', enabled: false, lockedVersion: '3.0.0', skill: { source: 'builtin' } },
      { skillId: 'custom.fixture', enabled: true, lockedVersion: '0.1.0', skill: { id: 'custom.fixture', name: '合成声口', description: '声口', source: 'user', status: 'active',
        license: 'Proprietary-Author-Owned', defaultVersion: '0.2.0', versions: [
          { version: '0.1.0', status: 'active', instructions: artifacts.instructions, manifest: artifacts.manifest },
          { version: '0.2.0', status: 'active', instructions: { draft: '不可误用的新版本' }, manifest: artifacts.manifest },
        ] } },
    ] as never)
    const runtime = await resolveEnabledRuntimeSkills('fixture-user', 'fixture-novel')
    const current = runtime.find(skill => skill.id === 'cn-webfiction-draft.v3')!
    expect(current).toBe(skillCatalog.find(skill => skill.id === current.id))
    expect(current.version).toBe('3.0.1')
    expect(current.resources.draft).toContain('低修辞预算只控制无功能修饰，不代表低情绪')
    expect(runtime.some(skill => skill.id === 'cn-scene-task.v3')).toBe(false)
    expect(runtime.find(skill => skill.id === 'custom.fixture')).toMatchObject({ version: '0.1.0', resources: instructions })
  })
})
