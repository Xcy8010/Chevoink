import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { afterAll, expect, it } from 'vitest'
import { prisma } from '../../api/lib/prisma.js'
import { assertGovernanceCatalog, governanceMigrations, readGovernanceCatalog } from '../../scripts/verify-release-migration.mjs'
import { verifyTestDatabase } from '../support/database-preflight.js'

await verifyTestDatabase(true)
afterAll(() => prisma.$disconnect())

it('preserves existing bans and verifies all governance DDL, initial rows and legacy writes against a live PostgreSQL catalog', async () => {
  const schema = 'migration_governance_' + randomBytes(6).toString('hex')
  const rollback = Error('isolated governance migration fixture rollback')
  await expect(prisma.$transaction(async tx => {
    await tx.$executeRawUnsafe('CREATE SCHEMA "' + schema + '"')
    await tx.$executeRawUnsafe('SET LOCAL search_path = "' + schema + '"')
    await tx.$executeRaw`CREATE TABLE users (id varchar(64) PRIMARY KEY, banned_at timestamp(3), token_version int NOT NULL DEFAULT 0)`
    await tx.$executeRaw`CREATE TYPE "EmailVerificationPurpose" AS ENUM ('register','login','bind','reset_password','change_password')`
    await tx.$executeRaw`INSERT INTO users(id,banned_at,token_version) VALUES ('old-ban','2025-11-10',7),('ordinary',NULL,4)`
    const before = await readGovernanceCatalog(tx,'before')
    assertGovernanceCatalog(before,'before',undefined)
    await tx.$executeRaw`CREATE INDEX "GovernanceCase_requestKey_key" ON users(id)`
    expect(() => assertGovernanceCatalog({ ...before,objects:[{name:'GovernanceCase_requestKey_key',kind:'i'}] },'before',undefined)).toThrow()
    const conflict = await readGovernanceCatalog(tx,'before')
    expect(() => assertGovernanceCatalog(conflict,'before',undefined)).toThrow()
    await tx.$executeRaw`DROP INDEX "GovernanceCase_requestKey_key"`
    for (const [name] of governanceMigrations) {
      const sql = readFileSync('prisma/migrations/' + name + '/migration.sql','utf8')
      // Prisma accepts one SQL statement per prepared call. Keep PL/pgSQL bodies intact.
      const body = sql.match(/\$\$[\s\S]*?\$\$/)?.[0]
      for (const part of sql.replace(/\$\$[\s\S]*?\$\$/, '__TRIGGER_BODY__').split(';')) {
        const statement = part.trim()
        if (statement && statement !== 'BEGIN' && statement !== 'COMMIT') {
          await tx.$executeRawUnsafe(statement.replace('__TRIGGER_BODY__', () => body ?? ''))
        }
      }
    }
    const after = await readGovernanceCatalog(tx,'after')
    assertGovernanceCatalog(after,'after',before)
    expect(after.mirror.matched).toBe(1)
    expect(() => assertGovernanceCatalog({...after,bans:{...after.bans,fingerprint:'0'.repeat(32)}},'after',before)).toThrow(/backfill/)
    await tx.$executeRaw`ALTER TABLE users DISABLE TRIGGER mirror_legacy_ban`
    const disabled = await readGovernanceCatalog(tx,'after')
    expect(() => assertGovernanceCatalog(disabled,'after',before)).toThrow(/trigger/)
    await tx.$executeRaw`ALTER TABLE users ENABLE TRIGGER mirror_legacy_ban`
    await tx.$executeRaw`UPDATE agent_safety_policy SET mode='enforce'`
    expect(() => assertGovernanceCatalog({...after,policy:[{...after.policy[0],mode:'enforce'}]},'after',before)).toThrow(/policy/)
    await tx.$executeRaw`UPDATE agent_safety_policy SET mode='observe'`
    await tx.$executeRaw`ALTER TABLE governance_mail ALTER COLUMN state SET DEFAULT 'sent'`
    const badDefault = await readGovernanceCatalog(tx,'after')
    expect(() => assertGovernanceCatalog(badDefault,'after',before)).toThrow(/defaults/)
    await tx.$executeRaw`UPDATE users SET banned_at=NULL WHERE id='old-ban'`
    await tx.$executeRaw`UPDATE users SET banned_at=CURRENT_TIMESTAMP WHERE id='ordinary'`
    const legacy = await tx.$queryRaw<Array<{user_id:string;active:boolean}>>`SELECT user_id,revoked_at IS NULL AS active FROM account_restrictions ORDER BY user_id`
    expect(legacy).toEqual([{user_id:'old-ban',active:false},{user_id:'ordinary',active:true}])
    expect(await tx.$queryRaw`SELECT id,token_version FROM users ORDER BY id`).toEqual([{id:'old-ban',token_version:7},{id:'ordinary',token_version:4}])
    throw rollback
  },{timeout:30_000})).rejects.toBe(rollback)
})
