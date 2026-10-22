import { describe, expect, it } from 'vitest'
import { intersectChildConfiguration } from '../../api/lib/agent/runtime-child.js'

const configuration = { version: 1 as const, mode: 'build' as const, agentType: 'orchestrator', creativeFreedom: 'balanced' as const, qualityMode: 'premium' as const,
  model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
  tools: [], toolAuthority: [], protectedChapterIds: [], pinnedSkillVersions: [{ id: 'private-original', version: '0.1.0' }], skillRouterVersion: 'original-router' }

describe('child skill inventory ceiling', () => {
  it('intersects exact id/version pairs and preserves the complete parent inventory meaning and router', () => {
    const parent = { ...configuration, skillInventoryVersion: 1 as const }
    const requested = { ...configuration, skillRouterVersion: 'later-router', pinnedSkillVersions: [
      ...configuration.pinnedSkillVersions, { id: 'private-original', version: '0.2.0' }, { id: 'later-private', version: '1.0.0' },
    ] }
    expect(intersectChildConfiguration(parent, requested, '*')).toMatchObject({ skillInventoryVersion: 1, skillRouterVersion: 'original-router',
      pinnedSkillVersions: configuration.pinnedSkillVersions })
    expect(requested.pinnedSkillVersions).toHaveLength(3)
  })
  it('does not let a requested marker certify a selected-only historical parent as a complete inventory', () => {
    const child = intersectChildConfiguration(configuration, { ...configuration, skillInventoryVersion: 1 as const }, '*')
    expect(child).not.toHaveProperty('skillInventoryVersion')
    expect(child.pinnedSkillVersions).toEqual(configuration.pinnedSkillVersions)
    expect(child.skillRouterVersion).toBe(configuration.skillRouterVersion)
  })
  it('preserves a missing frozen router without introducing an undefined JSON field or a requested replacement', () => {
    const { skillRouterVersion: _router, ...parent } = configuration
    const child = intersectChildConfiguration({ ...parent, skillInventoryVersion: 1 }, { ...configuration, pinnedSkillVersions: [] }, '*')
    expect(child).not.toHaveProperty('skillRouterVersion')
    expect(child).toMatchObject({ skillInventoryVersion: 1, pinnedSkillVersions: [] })
  })
})
