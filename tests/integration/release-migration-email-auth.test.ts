import { afterAll, expect, it } from 'vitest'
import { prisma } from '../../api/lib/prisma.js'
import { assertEmailAccountCatalog, readEmailAccountCatalog } from '../../scripts/verify-release-migration.mjs'
import { verifyTestDatabase } from '../support/database-preflight.js'

await verifyTestDatabase(true)
afterAll(async () => { await prisma.$disconnect() })

it('verifies the applied email account migration catalog on isolated PostgreSQL', async () => {
  const state = await prisma.$transaction(async tx => {
    await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY')
    return readEmailAccountCatalog(tx, 'after')
  })
  const baseline = {
    codeTable: { tables: [], columns: [], indexes: [], constraints: [], rowCount: null },
    userColumns: [], smsColumns: [], emailIndexes: [], setupConstraints: [],
    enumLabels: [{ name: 'SmsVerificationPurpose', labels: ['login', 'register', 'reset_password', 'admin_login', 'admin_bind'] }],
  }
  assertEmailAccountCatalog(state, 'after', baseline)
  expect(() => assertEmailAccountCatalog({ ...state, emailIndexes: [] }, 'after', baseline)).toThrow('Verified email index mismatch')
})
