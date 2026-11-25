import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { afterAll, expect, it } from 'vitest'
import { prisma } from '../../api/lib/prisma.js'
import { assertVerifiedCreditCatalog, readVerifiedCreditCatalog, verifiedCreditMigrationName } from '../../scripts/verify-release-migration.mjs'
import { verifyTestDatabase } from '../support/database-preflight.js'

await verifyTestDatabase(true)
afterAll(async () => { await prisma.$disconnect() })

it('admits only the additive credit schema and preserves balances and payouts through the old API overlap', async () => {
  const schema = 'verified_credit_' + randomBytes(6).toString('hex')
  const sql = readFileSync(`prisma/migrations/${verifiedCreditMigrationName}/migration.sql`, 'utf8')
  const rollback = new Error('rollback isolated credit catalog fixture')
  await expect(prisma.$transaction(async tx => {
    await tx.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`)
    await tx.$executeRawUnsafe(`SET LOCAL search_path = "${schema}"`)
    await tx.$executeRaw`CREATE TABLE credit_accounts (user_id varchar(64) PRIMARY KEY, daily_used_milli integer NOT NULL, bonus_balance_milli integer NOT NULL)`
    await tx.$executeRaw`CREATE TABLE referral_redemptions (id varchar(64) PRIMARY KEY, created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP)`
    await tx.$executeRaw`INSERT INTO credit_accounts VALUES ('existing', 123456, 78901)`
    await tx.$executeRaw`INSERT INTO referral_redemptions(id) VALUES ('already-paid')`
    const before = await readVerifiedCreditCatalog(tx, 'before')
    assertVerifiedCreditCatalog(before, 'before')
    await tx.$executeRaw`CREATE INDEX credit_phone_identities_pkey ON credit_accounts(user_id)`
    await expect(readVerifiedCreditCatalog(tx, 'before')).rejects.toThrow(/index names already exist/)
    await tx.$executeRaw`DROP INDEX credit_phone_identities_pkey`
    for (const ddl of sql.split(';').map(part => part.trim()).filter(part => part && part !== 'BEGIN' && part !== 'COMMIT')) {
      await tx.$executeRawUnsafe(ddl)
    }
    const after = await readVerifiedCreditCatalog(tx, 'after')
    assertVerifiedCreditCatalog(after, 'after', before, schema)
    expect(() => assertVerifiedCreditCatalog(after, 'before')).toThrow(/already exist/)
    expect(() => assertVerifiedCreditCatalog({ ...after, identities: { ...after.identities, rowCount: 1 } }, 'after', before, schema)).toThrow(/mismatch/)
    expect(() => assertVerifiedCreditCatalog({ ...after, referralConstraints: [] }, 'after', before, schema)).toThrow(/mismatch/)
    expect(await tx.$queryRaw`SELECT daily_used_milli, bonus_balance_milli, free_daily_withheld FROM credit_accounts`).toEqual([
      { daily_used_milli: 123456, bonus_balance_milli: 78901, free_daily_withheld: false },
    ])
    await tx.$executeRaw`INSERT INTO referral_redemptions(id) VALUES ('old-api-paid-after-ddl')`
    await tx.$executeRaw`INSERT INTO referral_redemptions(id, reward_status) VALUES ('new-api-pending', 'pending')`
    expect(await tx.$queryRaw`SELECT id,reward_status FROM referral_redemptions ORDER BY id`).toEqual([
      { id: 'already-paid', reward_status: 'credited' },
      { id: 'new-api-pending', reward_status: 'pending' },
      { id: 'old-api-paid-after-ddl', reward_status: 'credited' },
    ])
    await tx.$executeRaw`ALTER TABLE referral_redemptions ALTER COLUMN reward_status SET DEFAULT 'pending'`
    const wrongDefault = await readVerifiedCreditCatalog(tx, 'after')
    expect(() => assertVerifiedCreditCatalog(wrongDefault, 'after', before, schema)).toThrow(/mismatch/)
    throw rollback
  })).rejects.toBe(rollback)
})
