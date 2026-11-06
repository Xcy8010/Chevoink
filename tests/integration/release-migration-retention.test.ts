import { afterAll, it } from 'vitest'
import { prisma } from '../../api/lib/prisma.js'
import { assertAppReleaseRetentionState, readAppReleaseRetentionState } from '../../scripts/verify-release-migration.mjs'
import { verifyTestDatabase } from '../support/database-preflight.js'

// CI applies the exact migration before this read-only test. Never create,
// migrate or reset a DB here. Missing schema or unavailable DB is a failure.
await verifyTestDatabase(true)
afterAll(async () => { await prisma.$disconnect() })
it('verifies actual PostgreSQL retention DDL and initial empty claim table', async () => {
  const state = await prisma.$transaction(async tx => {
    await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY')
    return readAppReleaseRetentionState(tx, 'after')
  })
  // The frozen pre-migration expectation is not an observed CI preflight receipt.
  const before = { tables: [], columns: [], indexes: [], constraints: [], rowCount: null }
  // Let a catalog failure retain its exact per-section diagnostics in CI.
  assertAppReleaseRetentionState(state, 'after', before)
})
