import { afterEach, describe, expect, it, vi } from 'vitest'
import { frozenV360BuiltinCatalog, frozenV350BuiltinCatalog, historicalBuiltinCatalog, skillCatalog, loadSkill, routeSkills } from '../../api/lib/agent/skills/index.js'
import { createHash } from 'node:crypto'
import { buildCustomSkillArtifacts } from '../../api/lib/agent/skills/custom.js'
import { resolveEnabledRuntimeSkills, resolveRuntimeSkillContext, syncBuiltinSkillCatalog } from '../../api/lib/agent/skills/service.js'
import { prisma } from '../../api/lib/prisma.js'

afterEach(() => vi.restoreAllMocks())

describe('versioned built-in writing resources', () => {
  it('creates 4.0.0 assets and preserves 3.5.0 without updating any immutable version', async () => {
    vi.spyOn(prisma.agentSkillDefinition, 'upsert').mockResolvedValue({} as never)
    const versions = vi.spyOn(prisma.agentSkillVersion, 'upsert').mockResolvedValue({} as never)
    vi.spyOn(prisma, '$transaction').mockResolvedValue([])
    await syncBuiltinSkillCatalog()
    const changed = ['cn-scene-task.v3', 'cn-webfiction-draft.v3', 'cn-emotion-grounding.v3']
    for (const id of changed) {
      const call = versions.mock.calls.find(([input]) => input.where.skillId_version?.skillId === id && input.where.skillId_version.version === '4.0.0')![0]
      expect(call.where.skillId_version).toEqual({ skillId: id, version: '4.0.0' })
      expect(call.create).toMatchObject({ version: '4.0.0', contentHash: expect.stringMatching(/^[a-f0-9]{64}$/) })
      expect(call.update).toEqual({})
    }
    expect(versions.mock.calls.every(([input]) => Object.keys(input.update).length === 0)).toBe(true)
    // Exact pre-change manifest/instructions hash witnessed in the diagnostic.
    const frozen = versions.mock.calls.find(([input]) => input.where.skillId_version?.skillId === 'cn-webfiction-draft.v3' && input.where.skillId_version.version === '3.5.0')![0]
    expect(frozen.create.contentHash).toBe('7b1046fb8e355b16f1b0d303ae9624e4a820b926f3f642a668664eb7fd5be421')
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
    expect(current.version).toBe('4.0.0')
    expect(current.resources.draft).toContain('低修辞预算只控制无功能修饰，不代表低情绪')
    expect(runtime.some(skill => skill.id === 'cn-scene-task.v3')).toBe(false)
    expect(runtime.find(skill => skill.id === 'custom.fixture')).toMatchObject({ version: '0.1.0', resources: instructions })
  })

  it('a saved 3.7 router retains every 3.6 resource while new tasks use 4.0', async () => {
    vi.spyOn(prisma.agentSkillRun, 'findFirst').mockResolvedValue({ routerVersion: '3.7.0', selected: [], loaded: [] } as never)
    vi.spyOn(prisma.agentRun, 'findFirst').mockResolvedValue(null)
    vi.spyOn(prisma.agentSkillInstallation, 'findMany').mockResolvedValue([])
    const readVersion = vi.spyOn(prisma.agentSkillVersion, 'findUnique')
    const result = await resolveRuntimeSkillContext('u', 'n', 'old-37')
    expect(result.routerVersion).toBe('3.7.0')
    expect(result.catalog).toEqual(frozenV360BuiltinCatalog)
    expect(result.catalog.every(skill => skill.version === '3.6.0')).toBe(true)
    expect(readVersion).not.toHaveBeenCalled()
    for (const old of result.catalog) expect(skillCatalog.find(skill => skill.id === old.id)?.resources).toEqual(old.resources)
    expect(routeSkills({ mode: 'build', intent: 'revise', freedom: 'balanced', prompt: '减少 A I 痕迹，保留原事实。' }).selected.map(s => s.id))
      .toEqual(routeSkills({ mode: 'build', intent: 'revise', freedom: 'balanced', prompt: '减少 A I 痕迹，保留原事实。', routerVersion: '3.7.0', catalog: result.catalog }).selected.map(s => s.id))
  })

  it('a 3.6 router keeps the entire 3.5 pack at later phases, including previously unloaded skills', async () => {
    vi.spyOn(prisma.agentSkillRun, 'findFirst').mockResolvedValue({ routerVersion: '3.6.0', selected: [], loaded: [] } as never)
    vi.spyOn(prisma.agentRun, 'findFirst').mockResolvedValue(null)
    vi.spyOn(prisma.agentSkillInstallation, 'findMany').mockResolvedValue([])
    const readVersion = vi.spyOn(prisma.agentSkillVersion, 'findUnique')
    const before = createHash('sha256').update(JSON.stringify(frozenV350BuiltinCatalog)).digest('hex')
    const runtime = await resolveRuntimeSkillContext('u', 'n', 'old-run')
    expect(runtime.catalog).toEqual(frozenV350BuiltinCatalog)
    expect(runtime.catalog.every(skill => skill.version === '3.5.0')).toBe(true)
    expect(loadSkill('cn-prose-specificity.v3', 'critique', 'balanced', runtime.catalog)).not.toContain('当前表达负担')
    expect(readVersion).not.toHaveBeenCalled()
    expect(createHash('sha256').update(JSON.stringify(frozenV350BuiltinCatalog)).digest('hex')).toBe(before)
  })

  it('new ordinary draft gets contextual guidance without forcing a new specialist slot or changing ranking', () => {
    const input = { mode: 'build' as const, intent: 'write' as const, freedom: 'balanced' as const, prompt: '续写下一章，少解释，完成连续性与人类感检查。' }
    const current = routeSkills(input)
    const old = routeSkills({ ...input, routerVersion: '3.6.0', catalog: frozenV350BuiltinCatalog })
    expect(current.selected.map(skill => skill.id)).toEqual(old.selected.map(skill => skill.id))
    expect(current.reasonCodes).toEqual(old.reasonCodes)
    expect(current.selected.map(skill => skill.id)).toContain('cn-webfiction-draft.v3')
    expect(current.selected.map(skill => skill.id)).not.toContain('cn-prose-specificity.v3')
    expect(loadSkill('cn-webfiction-draft.v3', 'draft', 'balanced')).toContain('同句或跨句释因前')
    expect(loadSkill('cn-prose-specificity.v3', 'critique', 'balanced')).toContain('证据必须包含拟修改对象')
  })

  it('resumes an owned old run with its saved router and exact immutable resource, without changing stored records', async () => {
    const saved = { routerVersion: '3.1.0', selected: [{ id: 'cn-webfiction-draft.v3', name: '正文', version: '3.0.1' }], loaded: [] }
    const read = vi.spyOn(prisma.agentSkillRun, 'findFirst').mockResolvedValue(saved as never)
    vi.spyOn(prisma.agentRun, 'findFirst').mockResolvedValue(null)
    vi.spyOn(prisma.agentSkillInstallation, 'findMany').mockResolvedValue([])
    const version = vi.spyOn(prisma.agentSkillVersion, 'findUnique').mockResolvedValue({ status: 'active', instructions: { draft: '合成的冻结原资源' } } as never)
    const result = await resolveRuntimeSkillContext('fixture-user', 'fixture-novel', 'fixture-run')
    expect(read).toHaveBeenCalledWith({ where: { runId: 'fixture-run', userId: 'fixture-user', novelId: 'fixture-novel' } })
    expect(result.routerVersion).toBe('3.1.0')
    expect(result.catalog.find(skill => skill.id === 'cn-webfiction-draft.v3')).toMatchObject({ version: '3.0.1', resources: { draft: '合成的冻结原资源' } })
    expect(result.catalog.find(skill => skill.id === 'cn-scene-task.v3')).toBe(historicalBuiltinCatalog.find(skill => skill.id === 'cn-scene-task.v3'))
    expect(version).toHaveBeenCalledOnce()
    version.mockResolvedValue(null)
    await expect(resolveRuntimeSkillContext('fixture-user', 'fixture-novel', 'fixture-run')).rejects.toMatchObject({ code: 'SKILL_FROZEN_VERSION_UNAVAILABLE' })
  })
})
