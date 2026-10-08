import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertMigrationEnvironment, assertDatabaseIdentity, assertFindingIndex, assertMigrationState, migrationChecksum, migrationName, releaseMigrationPlan } from '../../scripts/verify-release-migration.mjs'

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'chevoink-release-migration-'))
  const candidate = path.join(root, 'candidate'), baseline = path.join(root, 'baseline')
  const schema = readFileSync('prisma/schema.prisma', 'utf8')
  const oldSchema = schema.replace('@@unique([reportId, source, signal, startOffset, endOffset, evidenceHash], map: "quality_findings_report_source_signal_span_key")', '@@unique([reportId, source, signal, evidenceHash])')
  for (const folder of [candidate, baseline]) {
    mkdirSync(path.join(folder, 'prisma/migrations/old'), { recursive: true })
    writeFileSync(path.join(folder, 'prisma/schema.prisma'), oldSchema)
    writeFileSync(path.join(folder, 'prisma/migrations/old/migration.sql'), 'SELECT 1;\n')
  }
  const allow = () => {
    writeFileSync(path.join(candidate, 'prisma/schema.prisma'), schema)
    mkdirSync(path.join(candidate, `prisma/migrations/${migrationName}`))
    writeFileSync(path.join(candidate, `prisma/migrations/${migrationName}/migration.sql`), readFileSync(`prisma/migrations/${migrationName}/migration.sql`))
  }
  return { candidate, baseline, allow }
}

describe('exact reviewed production migration', () => {
  it('keeps unchanged releases routine and permits only the exact index migration', () => {
    const f = fixture()
    expect(releaseMigrationPlan(f.candidate, f.baseline)).toBe('routine')
    f.allow()
    expect(releaseMigrationPlan(f.candidate, f.baseline)).toBe(migrationName)
  })
  it.each(['schema', 'history', 'sql', 'extra'])('rejects unapproved %s changes', kind => {
    const f = fixture(); f.allow()
    if (kind === 'schema') writeFileSync(path.join(f.candidate, 'prisma/schema.prisma'), readFileSync(path.join(f.candidate, 'prisma/schema.prisma'), 'utf8') + '\n// unrelated\n')
    if (kind === 'history') writeFileSync(path.join(f.candidate, 'prisma/migrations/old/migration.sql'), 'SELECT 2;\n')
    if (kind === 'sql') writeFileSync(path.join(f.candidate, `prisma/migrations/${migrationName}/migration.sql`), 'DELETE FROM quality_findings;')
    if (kind === 'extra') writeFileSync(path.join(f.candidate, `prisma/migrations/${migrationName}/extra.sql`), 'SELECT 2;')
    expect(() => releaseMigrationPlan(f.candidate, f.baseline)).toThrow()
  })
  const history = { migration_name: 'old', checksum: 'a'.repeat(64), finished_at: new Date(), rolled_back_at: null, applied_steps_count: 1 }
  const target = { ...history, migration_name: migrationName, checksum: migrationChecksum }
  const checksums = [['old', 'b'.repeat(64)], [migrationName, migrationChecksum]]
  it('requires exactly the target pending before and completed afterwards', () => {
    expect(() => assertMigrationState([history], checksums, 'before')).not.toThrow()
    expect(() => assertMigrationState([history, target], checksums, 'after', [history])).not.toThrow()
    for (const rows of [[], [history, target], [history, history], [{ ...history, checksum: 'changed' }], [{ ...history, finished_at: null }], [{ ...history, rolled_back_at: new Date() }], [{ ...history, applied_steps_count: undefined }]])
      expect(() => assertMigrationState(rows, checksums, 'before')).toThrow()
    expect(() => assertMigrationState([history], checksums, 'after', [history])).toThrow()
    expect(() => assertMigrationState([{ ...history, checksum: 'c'.repeat(64) }, target], checksums, 'after', [history])).toThrow()
    expect(() => assertMigrationState([history, { ...target, checksum: 'd'.repeat(64) }], checksums, 'after', [history])).toThrow()
    expect(() => assertMigrationState([history, target], checksums, 'after', JSON.parse(JSON.stringify([history])))).not.toThrow()
  })
  it('verifies real unique index columns and validity rather than migration success text', () => {
    const old = { name: 'quality_findings_report_id_source_signal_evidence_hash_key', table_name: 'quality_findings',
      is_unique: true, is_valid: true, is_ready: true, has_predicate: false, has_expression: false,
      columns: ['report_id', 'source', 'signal', 'evidence_hash'] }
    const current = { ...old, name: 'quality_findings_report_source_signal_span_key', columns: ['report_id', 'source', 'signal', 'start_offset', 'end_offset', 'evidence_hash'] }
    expect(() => assertFindingIndex([old], 'before')).not.toThrow()
    expect(() => assertFindingIndex([current], 'after')).not.toThrow()
    for (const rows of [[old], [old, current], [{ ...current, is_valid: false }], [{ ...current, has_predicate: true }], [{ ...current, columns: old.columns }]])
      expect(() => assertFindingIndex(rows, 'after')).toThrow()
  })
  it('pins inherited CLI environment and actual database to the shared production file without exposing its URL', () => {
    const shared = { APP_ENV: 'production', DATABASE_URL: 'postgresql://user:secret@db.example/chevoink?schema=public' }
    expect(assertMigrationEnvironment(shared, shared)).toEqual({ database: 'chevoink', schema: 'public' })
    for (const environment of [{ ...shared, DATABASE_URL: 'postgresql://user:secret@other/chevoink' },
      { ...shared, APP_ENV: 'test' }, { APP_ENV: 'production' }]) expect(() => assertMigrationEnvironment(environment, shared)).toThrow()
    expect(() => assertDatabaseIdentity({ database: 'other', schema: 'public' }, { database: 'chevoink', schema: 'public' })).toThrow()
    expect(() => assertDatabaseIdentity({ database: 'chevoink', schema: 'other' }, { database: 'chevoink', schema: 'public' })).toThrow()
    expect(() => assertDatabaseIdentity({ database: 'chevoink', schema: 'public' }, { database: 'chevoink', schema: 'public' })).not.toThrow()
  })
  it('runs one migration after the build and verification but before stopping the live process', () => {
    const script = readFileSync('deploy/deploy-production.sh', 'utf8')
    const migrate = script.indexOf('npx prisma migrate deploy')
    expect(script.match(/npx prisma migrate deploy/g)).toHaveLength(1)
    expect(script.indexOf('npm run build:client')).toBeLessThan(migrate)
    expect(script.indexOf('verify-release-migration.mjs before')).toBeLessThan(migrate)
    expect(script.indexOf('verify-release-migration.mjs after')).toBeGreaterThan(migrate)
    expect(script.indexOf('pm2 stop 0')).toBeGreaterThan(migrate)
  })
})
