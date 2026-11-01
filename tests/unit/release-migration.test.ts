import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertMigrationEnvironment, assertDatabaseIdentity, assertFindingIndex, assertMigrationState, migrationChecksum, migrationName, releaseMigrationPlan,
  fetchMigrationName, fetchMigrationChecksum, fetchSeedEvidence, assertFetchSeed,
  webToolBillingMigrationName, webToolBillingMigrationChecksum, assertWebToolBillingState,
  adminModelLifecycleMigrationName, adminModelLifecycleMigrationChecksum, lifecycleColumns, lifecycleIndexes, assertAdminModelLifecycleState } from '../../scripts/verify-release-migration.mjs'

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
  const lifecycleFixture = () => {
    const f = fixture()
    writeFileSync(path.join(f.baseline, 'prisma/schema.prisma'), readFileSync(new URL('../fixtures/release-web-tool-billing.schema.prisma', import.meta.url)))
    writeFileSync(path.join(f.candidate, 'prisma/schema.prisma'), readFileSync(new URL('../fixtures/release-admin-model-lifecycle.schema.prisma', import.meta.url)))
    mkdirSync(path.join(f.candidate, `prisma/migrations/${adminModelLifecycleMigrationName}`))
    writeFileSync(path.join(f.candidate, `prisma/migrations/${adminModelLifecycleMigrationName}/migration.sql`), readFileSync(`prisma/migrations/${adminModelLifecycleMigrationName}/migration.sql`))
    return f
  }
  it('permits only the frozen lifecycle schema pair and exact SQL', () => {
    const f = lifecycleFixture()
    expect(releaseMigrationPlan(f.candidate, f.baseline)).toBe(adminModelLifecycleMigrationName)
    const old = { migration_name: 'old', checksum: 'a'.repeat(64), finished_at: new Date(), rolled_back_at: null, applied_steps_count: 1 }
    const complete = { ...old, migration_name: adminModelLifecycleMigrationName, checksum: adminModelLifecycleMigrationChecksum }
    const checksums = [['old', 'b'.repeat(64)], [adminModelLifecycleMigrationName, adminModelLifecycleMigrationChecksum]]
    expect(() => assertMigrationState([old], checksums, 'before', undefined, adminModelLifecycleMigrationName)).not.toThrow()
    expect(() => assertMigrationState([old, complete], checksums, 'after', [old], adminModelLifecycleMigrationName)).not.toThrow()
    expect(() => assertMigrationState([old, { ...complete, checksum: 'c'.repeat(64) }], checksums, 'after', [old], adminModelLifecycleMigrationName)).toThrow()
  })
  it.each(['schema', 'baseline', 'history', 'sql', 'extra', 'already-present'])('rejects lifecycle %s outside the frozen approval', kind => {
    const f = lifecycleFixture()
    if (kind === 'schema') writeFileSync(path.join(f.candidate, 'prisma/schema.prisma'), '// unrelated')
    if (kind === 'baseline') writeFileSync(path.join(f.baseline, 'prisma/schema.prisma'), '// unrelated')
    if (kind === 'history') writeFileSync(path.join(f.candidate, 'prisma/migrations/old/migration.sql'), 'SELECT 2;')
    if (kind === 'sql') writeFileSync(path.join(f.candidate, `prisma/migrations/${adminModelLifecycleMigrationName}/migration.sql`), 'SELECT 2;')
    if (kind === 'extra') writeFileSync(path.join(f.candidate, `prisma/migrations/${adminModelLifecycleMigrationName}/extra.sql`), 'SELECT 2;')
    if (kind === 'already-present') {
      mkdirSync(path.join(f.baseline, `prisma/migrations/${adminModelLifecycleMigrationName}`))
      writeFileSync(path.join(f.baseline, `prisma/migrations/${adminModelLifecycleMigrationName}/migration.sql`), 'SELECT 1;')
    }
    expect(() => releaseMigrationPlan(f.candidate, f.baseline)).toThrow()
  })
  it('verifies lifecycle schema defaults, initial nulls, six ID bindings and protected catalog preservation', () => {
    const roles = ['basic', 'speed', 'tool:image-generation', 'tool:image-vision', 'tool:web-fetch', 'tool:web-search'].map((role, i) => ({ role, id: `config-${i}` }))
    const before = { tables: [], columns: [], roles, catalog: { count: 8, hash: 'a'.repeat(32) } }
    const after = { ...before, tables: ['admin_model_diagnostics', 'ai_model_config_versions', 'ai_model_system_bindings'], columns: lifecycleColumns, indexes: lifecycleIndexes,
      foreignKeys: ['ai_model_config_versions', 'ai_model_system_bindings'].map(table => ({ table, columns: ['model_config_id'], target: 'ai_model_configs', targetColumns: ['id'], onDelete: 'a', onUpdate: 'a', valid: true })),
      bindings: roles.map(row => ({ ...row, revision: 1, hasUpdatedAt: true })), invalid: { configs: 0, runs: 0, schedules: 0, calls: 0, diagnostics: 0, versions: 0 } }
    expect(() => assertAdminModelLifecycleState(before, 'before')).not.toThrow()
    expect(() => assertAdminModelLifecycleState(after, 'after', JSON.parse(JSON.stringify(before)))).not.toThrow()
    expect(() => assertAdminModelLifecycleState({ ...before, roles: roles.slice(1) }, 'before')).toThrow()
    expect(() => assertAdminModelLifecycleState({ ...before, tables: after.tables }, 'before')).toThrow()
    for (const changed of [
      { ...after, tables: after.tables.slice(1) }, { ...after, catalog: { ...after.catalog, hash: 'b'.repeat(32) } },
      { ...after, columns: after.columns.map(row => row.name === 'revision' ? { ...row, defaultValue: '2' } : row) },
      { ...after, columns: after.columns.map(row => row.name === 'model_config_id' ? { ...row, required: !row.required } : row) },
      { ...after, indexes: after.indexes.map(row => ({ ...row, valid: false })) },
      { ...after, foreignKeys: after.foreignKeys.map(row => ({ ...row, onDelete: 'c' })) },
      { ...after, bindings: after.bindings.map((row, i) => i === 0 ? { ...row, id: 'wrong-config' } : row) },
      { ...after, invalid: { ...after.invalid, runs: 1 } }, { ...after, invalid: { ...after.invalid, versions: 1 } },
    ]) expect(() => assertAdminModelLifecycleState(changed, 'after', before)).toThrow()
  })
  const billingFixture = () => {
    const f = fixture()
    // This approval is historical and must not follow newer application schema.
    const schema = readFileSync(new URL('../fixtures/release-web-tool-billing.schema.prisma', import.meta.url), 'utf8').replaceAll('\r\n', '\n')
    const begin = schema.indexOf('/// Frozen fixed-price dispatch receipt.')
    const end = schema.indexOf('model ReferralCode {', begin)
    expect(begin).toBeGreaterThan(0)
    const baseline = (schema.slice(0, begin) + schema.slice(end)).replace('  webToolCalls       WebToolCall[]\n', '')
    writeFileSync(path.join(f.baseline, 'prisma/schema.prisma'), baseline)
    writeFileSync(path.join(f.candidate, 'prisma/schema.prisma'), schema)
    mkdirSync(path.join(f.candidate, `prisma/migrations/${webToolBillingMigrationName}`))
    writeFileSync(path.join(f.candidate, `prisma/migrations/${webToolBillingMigrationName}/migration.sql`), readFileSync(`prisma/migrations/${webToolBillingMigrationName}/migration.sql`))
    return f
  }
  it('permits only the frozen billing schema and exact SQL with unchanged historical files', () => {
    const f = billingFixture()
    expect(releaseMigrationPlan(f.candidate, f.baseline)).toBe(webToolBillingMigrationName)
    const old = { migration_name: 'old', checksum: 'a'.repeat(64), finished_at: new Date(), rolled_back_at: null, applied_steps_count: 1 }
    const sums = [['old', 'b'.repeat(64)], [webToolBillingMigrationName, webToolBillingMigrationChecksum]]
    const completed = { ...old, migration_name: webToolBillingMigrationName, checksum: webToolBillingMigrationChecksum }
    expect(() => assertMigrationState([old], sums, 'before', undefined, webToolBillingMigrationName)).not.toThrow()
    expect(() => assertMigrationState([old, completed], sums, 'after', [old], webToolBillingMigrationName)).not.toThrow()
    expect(() => assertMigrationState([old, { ...completed, checksum: 'c'.repeat(64) }], sums, 'after', [old], webToolBillingMigrationName)).toThrow()
  })
  it('does not reuse historical billing approval for the current model-lifecycle schema', () => {
    const f = billingFixture()
    writeFileSync(path.join(f.candidate, 'prisma/schema.prisma'), readFileSync('prisma/schema.prisma'))
    expect(() => releaseMigrationPlan(f.candidate, f.baseline)).toThrow('Unapproved schema change')
  })
  it.each(['schema', 'baseline', 'history', 'sql', 'extra'])('rejects unrelated %s in billing release', kind => {
    const f = billingFixture()
    if (kind === 'schema') writeFileSync(path.join(f.candidate, 'prisma/schema.prisma'), '// unrelated')
    if (kind === 'baseline') writeFileSync(path.join(f.baseline, 'prisma/schema.prisma'), '// unrelated')
    if (kind === 'history') writeFileSync(path.join(f.candidate, 'prisma/migrations/old/migration.sql'), 'SELECT 2;')
    if (kind === 'sql') writeFileSync(path.join(f.candidate, `prisma/migrations/${webToolBillingMigrationName}/migration.sql`), 'SELECT 2;')
    if (kind === 'extra') writeFileSync(path.join(f.candidate, `prisma/migrations/${webToolBillingMigrationName}/extra.sql`), 'SELECT 2;')
    expect(() => releaseMigrationPlan(f.candidate, f.baseline)).toThrow()
  })
  it('requires two initial 1.0 prices, protected config preservation, exact audit and no unrelated catalog changes', () => {
    const before = { targets: ['tool:web-fetch', 'tool:web-search'].map(key => ({ key, multiplierBps: 20000, protectedHash: 'a'.repeat(32), updatedAt: '2026-01-01T00:00:00Z' })), others: { count: 5, hash: 'b'.repeat(32) } }
    const after = { targets: before.targets.map(row => ({ ...row, multiplierBps: 10000, updatedAt: '2026-10-20T00:00:00Z' })), others: before.others, calls: 0,
      audit: before.targets.map(row => ({ key: row.key, previousMultiplier: row.multiplierBps, previousUpdatedAt: row.updatedAt, appliedAt: '2026-10-20T00:00:00Z' })) }
    expect(() => assertWebToolBillingState(after, before)).not.toThrow()
    for (const changed of [{ ...after, others: { count: 4, hash: 'c'.repeat(32) } }, { ...after, calls: 1 }, { ...after, audit: [] },
      { ...after, targets: [{ ...after.targets[0], multiplierBps: 20000 }, after.targets[1]] },
      { ...after, targets: [{ ...after.targets[0], protectedHash: 'd'.repeat(32) }, after.targets[1]] }]) {
      expect(() => assertWebToolBillingState(changed, before)).toThrow()
    }
  })
  const fetchFixture = () => {
    const f = fixture()
    mkdirSync(path.join(f.candidate, `prisma/migrations/${fetchMigrationName}`))
    writeFileSync(path.join(f.candidate, `prisma/migrations/${fetchMigrationName}/migration.sql`), readFileSync(`prisma/migrations/${fetchMigrationName}/migration.sql`))
    return f
  }
  it('permits the exact disabled Fetch seed only with unchanged schema and history', () => {
    const f = fetchFixture()
    expect(releaseMigrationPlan(f.candidate, f.baseline)).toBe(fetchMigrationName)
    const old = { migration_name: 'old', checksum: 'a'.repeat(64), finished_at: new Date(), rolled_back_at: null, applied_steps_count: 1 }
    const seeded = { ...old, migration_name: fetchMigrationName, checksum: fetchMigrationChecksum }
    const sums = [['old', 'b'.repeat(64)], [fetchMigrationName, fetchMigrationChecksum]]
    expect(() => assertMigrationState([old], sums, 'before', undefined, fetchMigrationName)).not.toThrow()
    expect(() => assertMigrationState([old, seeded], sums, 'after', [old], fetchMigrationName)).not.toThrow()
    expect(() => assertMigrationState([old, { ...seeded, checksum: 'c'.repeat(64) }], sums, 'after', [old], fetchMigrationName)).toThrow()
    expect(() => assertMigrationState([old], sums, 'after', [old], fetchMigrationName)).toThrow()
  })
  it.each(['schema', 'history', 'sql', 'extra'])('rejects unrelated %s with Fetch seed', kind => {
    const f = fetchFixture()
    if (kind === 'schema') writeFileSync(path.join(f.candidate, 'prisma/schema.prisma'), '// unrelated')
    if (kind === 'history') writeFileSync(path.join(f.candidate, 'prisma/migrations/old/migration.sql'), 'SELECT 2;')
    if (kind === 'sql') writeFileSync(path.join(f.candidate, `prisma/migrations/${fetchMigrationName}/migration.sql`), 'SELECT 2;')
    if (kind === 'extra') writeFileSync(path.join(f.candidate, `prisma/migrations/${fetchMigrationName}/extra.sql`), 'SELECT 2;')
    expect(() => releaseMigrationPlan(f.candidate, f.baseline)).toThrow()
  })
  it('requires disabled keyless insertion or exact preservation of a preexisting Fetch configuration', () => {
    const row = { id: 'tool-web-fetch', key: 'tool:web-fetch', ownerUserId: null, provider: 'unconfigured', modelName: 'unconfigured',
      baseUrl: null, apiKeyCiphertext: null, tier: 'tool_fetch', enabled: false, selectable: false, isDefault: false,
      multiplierBps: 10000, metadata: { modelKind: 'web_fetch' } }
    expect(() => assertFetchSeed(fetchSeedEvidence(row), null)).not.toThrow()
    expect(() => assertFetchSeed(null, null)).toThrow()
    for (const changed of [{ enabled: true }, { apiKeyCiphertext: 'secret' }, { ownerUserId: 'user' }, { selectable: true }]) {
      const evidence = fetchSeedEvidence({ ...row, ...changed })
      expect(() => assertFetchSeed(evidence, null)).toThrow()
      expect(JSON.stringify(evidence)).not.toContain('secret')
    }
    const existing = fetchSeedEvidence({ ...row, enabled: true, apiKeyCiphertext: 'protected-existing-key' })
    expect(() => assertFetchSeed(existing, existing)).not.toThrow()
    expect(() => assertFetchSeed(fetchSeedEvidence(row), existing)).toThrow()
  })
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
    expect(script).toContain('node scripts/production-process-snapshot.mjs')
    expect(script).not.toContain('pm2 jlist')
  })
})
