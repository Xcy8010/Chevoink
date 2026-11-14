import { afterAll, expect, it } from 'vitest'
import { prisma } from '../../api/lib/prisma.js'
import { assertAgentPersonalizationState, readAgentPersonalizationState } from '../../scripts/verify-release-migration.mjs'
import { verifyTestDatabase } from '../support/database-preflight.js'

await verifyTestDatabase(true)
afterAll(async () => { await prisma.$disconnect() })

it('verifies the personalization migration catalog on isolated PostgreSQL and rejects postflight drift', async () => {
  const actual = await prisma.$transaction(async tx => {
    await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY')
    return readAgentPersonalizationState(tx, 'after')
  })
  const absent = { tables: [], columns: [], indexes: [], constraints: [], rowCount: null }
  const before = { profiles: absent, memories: absent, enums: [] }
  // Application integration workers may be exercising these tables concurrently.
  const state = {
    ...actual, profiles: { ...actual.profiles, rowCount: 0 }, memories: { ...actual.memories, rowCount: 0 },
  }
  expect(actual.profiles.rowCount).toBeGreaterThanOrEqual(0)
  expect(actual.memories.rowCount).toBeGreaterThanOrEqual(0)
  assertAgentPersonalizationState(state, 'after', before)
  expect(() => assertAgentPersonalizationState({ ...state, enums: [] }, 'after', before)).toThrow(/enum catalog/)
  expect(() => assertAgentPersonalizationState({ ...state, profiles: { ...state.profiles, rowCount: 1 } }, 'after', before)).toThrow(/rowCount/)
  expect(() => assertAgentPersonalizationState({ ...state, memories: { ...state.memories, rowCount: 1 } }, 'after', before)).toThrow(/rowCount/)
  expect(() => assertAgentPersonalizationState({ ...state, profiles: { ...state.profiles, columns: [] } }, 'after', before)).toThrow(/columns/)
  expect(() => assertAgentPersonalizationState({ ...state, memories: { ...state.memories, constraints: [] } }, 'after', before)).toThrow(/constraints/)
  const indexes = state.memories.indexes.map(index => ({ ...index, definition: index.definition.replaceAll(' DESC', '') }))
  expect(() => assertAgentPersonalizationState({ ...state, memories: { ...state.memories, indexes } }, 'after', before)).toThrow(/indexes/)
})
