import { afterAll, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { prisma } from '../../api/lib/prisma.js'
import { assertAgentPersonalizationState, readAgentPersonalizationState, readPersonalizationRulesMigrationState, readPersonalizationRuleTextsState } from '../../scripts/verify-release-migration.mjs'
import { verifyTestDatabase } from '../support/database-preflight.js'

await verifyTestDatabase(true)
afterAll(async () => { await prisma.$disconnect() })

it('verifies the frozen v1 catalog before applying the new personalization migration', async () => {
  // Isolated in a transaction-scoped fixture schema, so the old schema is
  // checked strictly even though the normal CI public schema is already v2.
  const schema = 'personalization_v1_' + randomBytes(6).toString('hex')
  const sql = readFileSync('prisma/migrations/20261114090000_agent_personalization/migration.sql', 'utf8')
  const rollback = new Error('rollback exact fixture schema')
  await expect(prisma.$transaction(async tx => {
    await tx.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`)
    await tx.$executeRawUnsafe(`SET LOCAL search_path = "${schema}"`)
    await tx.$executeRaw`CREATE TABLE users (id VARCHAR(64) PRIMARY KEY)`
    const before = await readAgentPersonalizationState(tx, 'before', schema)
    assertAgentPersonalizationState(before, 'before')
    for (const statement of sql.split(';').map(text => text.trim()).filter(Boolean)) await tx.$executeRawUnsafe(statement)
    const state = await readAgentPersonalizationState(tx, 'after', schema)
    assertAgentPersonalizationState(state, 'after', before)
    expect(() => assertAgentPersonalizationState({ ...state, enums: [] }, 'after', before)).toThrow(/enum catalog/)
    expect(() => assertAgentPersonalizationState({ ...state, profiles: { ...state.profiles, rowCount: 1 } }, 'after', before)).toThrow(/rowCount/)
    expect(() => assertAgentPersonalizationState({ ...state, memories: { ...state.memories, rowCount: 1 } }, 'after', before)).toThrow(/rowCount/)
    expect(() => assertAgentPersonalizationState({ ...state, profiles: { ...state.profiles, columns: [] } }, 'after', before)).toThrow(/columns/)
    expect(() => assertAgentPersonalizationState({ ...state, memories: { ...state.memories, constraints: [] } }, 'after', before)).toThrow(/constraints/)
    const indexes = state.memories.indexes.map(index => ({ ...index, definition: index.definition.replaceAll(' DESC', '') }))
    expect(() => assertAgentPersonalizationState({ ...state, memories: { ...state.memories, indexes } }, 'after', before)).toThrow(/indexes/)
    throw rollback
  })).rejects.toBe(rollback)
})

it('checks the actual upgraded catalog and verifies that the former v1 readback cannot pass as v2', async () => {
  await prisma.$transaction(async tx => {
    await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY')
    await expect(readPersonalizationRulesMigrationState(tx, 'after')).resolves.toMatchObject({ slots: true, trigger: true, rules: true,
      legacyRetired: true, invalidProfiles: false, excessActive: false })
    await expect(readPersonalizationRulesMigrationState(tx, 'before')).rejects.toThrow(/catalog mismatch/)
    await expect(readPersonalizationRuleTextsState(tx, 'after')).resolves.toEqual({ column: true, constraint: true, trigger: true })
    await expect(readPersonalizationRuleTextsState(tx, 'before')).rejects.toThrow(/catalog mismatch/)
  })
})
