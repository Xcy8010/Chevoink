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
  // The later governance migration appends one purpose. Verify the complete current
  // enum before replaying the frozen historical release contract against its prefix.
  const emailPurpose = 'EmailVerificationPurpose'
  const originalPurposes = ['register', 'login', 'bind', 'reset_password', 'change_password']
  const enums = state.enumLabels as Array<{ name: string; labels: string[] }>
  expect(enums.find(row => row.name === emailPurpose)?.labels).toEqual([...originalPurposes, 'appeal'])
  const historical = { ...state, enumLabels: enums.map(row => row.name === emailPurpose ? { ...row, labels: row.labels.slice(0, -1) } : row) }
  assertEmailAccountCatalog(historical, 'after', baseline)
  expect(() => assertEmailAccountCatalog({ ...historical, emailIndexes: [] }, 'after', baseline)).toThrow('Verified email index mismatch')
})
