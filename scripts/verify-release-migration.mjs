import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, lstatSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const migrationName = '20261009010000_quality_finding_span_identity'
export const migrationChecksum = '27b78febf135faf99d4d611adf60e1f597e92befb6c961c7a5970153d8a7f21e'
export const fetchMigrationName = '20261019120000_web_fetch_tool_config'
export const fetchMigrationChecksum = '2e318f4b0a2004efdccfad7ad7a3962c4e8346a3da1e58c144aa1646dd034191'
export const webToolBillingMigrationName = '20261020120000_web_tool_billing'
export const webToolBillingMigrationChecksum = 'f7797fe83d78f72a07c9c6e4b8a6cc17ff758db54b1709776f9b1dd35b7933f0'
export const adminModelLifecycleMigrationName = '20261101120000_admin_model_lifecycle'
export const adminModelLifecycleMigrationChecksum = 'ced5cef83baa1d9bfe9ebe54e5c39388e85f7e6ea0ee9aa7c2257958e9181baf'
export const adminExperiencePlan = '20261106_admin_model_experience'
export const adminExperienceMigrations = [
  ['20261106120000_site_content', 'e482a56f154bc0207c5a221a823869151518a4ac3253c2d5e7ea6c8f928d4bde'],
  ['20261106121000_tester_app_release', '978cc8ec92106adefdf372583960e7af18f8a8444ae383d682a51aeae9dd4d33'],
  ['20261106122000_image_operation', 'e2875436ca2e5280fe742bcc9c9c2e2bfc6a99a01bff9bb2639a0a621ef0569e'],
  ['20261106123000_app_release_validation', '22fa01d898965c11c356f9f1bb311661c24e75cbd6fd0334190d1f69866bf7bc'],
]
// Frozen bdf8032da9970fdbeafdbbee76dba14886d3a75e -> reviewed admin/model candidate.
const adminExperienceCandidateSchema = '47366b5ecb5d6cd6f4029b9134c8164812349b546f24dfc8551184475810f4db'
// Frozen ae6cd5f7d43e77e1a75ce9c4d2dfe3ce60ee568e -> 8ba827a5029010f4ad87e3c6e59a513edb90ce53 schema pair.
const lifecycleCandidateSchema = 'da62c9651530ce93646848e7be0f0634787ef397317a1e4d321e3242ffca265f'
const billingBaselineSchema = 'e7752d3afe61d9e6172404cf5ea93cec78087dab274743804f3a90fd2b01d774'
const billingCandidateSchema = 'f981e01401a19d5a18e0c28556a12cb2fb0b35eefe6a9be2975980da2ddf5afa'
const reviewed = new Map([[migrationName, migrationChecksum], [fetchMigrationName, fetchMigrationChecksum],
  [webToolBillingMigrationName, webToolBillingMigrationChecksum], [adminModelLifecycleMigrationName, adminModelLifecycleMigrationChecksum]])
reviewed.set(adminExperiencePlan, createHash('sha256').update(JSON.stringify(adminExperienceMigrations)).digest('hex'))
const oldIndex = 'quality_findings_report_id_source_signal_evidence_hash_key'
const newIndex = 'quality_findings_report_source_signal_span_key'
const oldDeclaration = '@@unique([reportId, source, signal, evidenceHash])'
const newDeclaration = '@@unique([reportId, source, signal, startOffset, endOffset, evidenceHash], map: "quality_findings_report_source_signal_span_key")'
const digest = value => createHash('sha256').update(value).digest('hex')
function files(root, relative = '') {
  return readdirSync(path.join(root, relative)).sort().flatMap(name => {
    const key = relative ? `${relative}/${name}` : name
    const stat = lstatSync(path.join(root, key))
    if (stat.isDirectory()) return files(root, key)
    if (!stat.isFile()) throw Error('Unexpected migration filesystem entry')
    return [[key, digest(readFileSync(path.join(root, key)))]]
  })
}

/** Ordinary releases stay byte-identical. These exact reviewed exceptions cannot
 * authorize unrelated schema edits, historical checksum changes or extra SQL. */
export function releaseMigrationPlan(candidate, baseline) {
  const next = readFileSync(path.join(candidate, 'prisma/schema.prisma'), 'utf8')
  const previous = readFileSync(path.join(baseline, 'prisma/schema.prisma'), 'utf8')
  const currentFiles = files(path.join(candidate, 'prisma/migrations'))
  const oldFiles = files(path.join(baseline, 'prisma/migrations'))
  if (next === previous && JSON.stringify(currentFiles) === JSON.stringify(oldFiles)) return 'routine'
  const experienceTargets = new Map(adminExperienceMigrations.map(([name, hash]) => [`${name}/migration.sql`, hash]))
  if (digest(previous.replaceAll('\r\n', '\n')) === lifecycleCandidateSchema
    && digest(next.replaceAll('\r\n', '\n')) === adminExperienceCandidateSchema
    && !oldFiles.some(([name]) => experienceTargets.has(name))
    && JSON.stringify(currentFiles.filter(([name]) => !experienceTargets.has(name))) === JSON.stringify(oldFiles)
    && [...experienceTargets].every(([name, hash]) => currentFiles.find(([file]) => file === name)?.[1] === hash)) return adminExperiencePlan
  const lifecycleTarget = `${adminModelLifecycleMigrationName}/migration.sql`
  if (digest(previous.replaceAll('\r\n', '\n')) === billingCandidateSchema
    && digest(next.replaceAll('\r\n', '\n')) === lifecycleCandidateSchema
    && !oldFiles.some(([name]) => name === lifecycleTarget)
    && JSON.stringify(currentFiles.filter(([name]) => name !== lifecycleTarget)) === JSON.stringify(oldFiles)
    && currentFiles.find(([name]) => name === lifecycleTarget)?.[1] === adminModelLifecycleMigrationChecksum) return adminModelLifecycleMigrationName
  const billingTarget = `${webToolBillingMigrationName}/migration.sql`
  if (digest(previous.replaceAll('\r\n', '\n')) === billingBaselineSchema
    && digest(next.replaceAll('\r\n', '\n')) === billingCandidateSchema
    && !oldFiles.some(([name]) => name === billingTarget)
    && JSON.stringify(currentFiles.filter(([name]) => name !== billingTarget)) === JSON.stringify(oldFiles)
    && currentFiles.find(([name]) => name === billingTarget)?.[1] === webToolBillingMigrationChecksum) return webToolBillingMigrationName
  const fetchTarget = `${fetchMigrationName}/migration.sql`
  if (next === previous && !oldFiles.some(([name]) => name === fetchTarget)
    && JSON.stringify(currentFiles.filter(([name]) => name !== fetchTarget)) === JSON.stringify(oldFiles)
    && currentFiles.find(([name]) => name === fetchTarget)?.[1] === fetchMigrationChecksum) return fetchMigrationName
  if (previous.split(oldDeclaration).length !== 2 || next !== previous.replace(oldDeclaration, newDeclaration)) throw Error('Unapproved schema change')
  const target = `${migrationName}/migration.sql`
  if (oldFiles.some(([name]) => name === target)
    || JSON.stringify(currentFiles.filter(([name]) => name !== target)) !== JSON.stringify(oldFiles)
    || currentFiles.find(([name]) => name === target)?.[1] !== migrationChecksum) throw Error('Unapproved migration change')
  return migrationName
}

export function assertMigrationState(rows, checksums, phase, before, plan = migrationName) {
  if (!reviewed.has(plan)) throw Error('Unapproved migration plan')
  if (!['before', 'after'].includes(phase)) throw Error('Invalid migration verification phase')
  const expected = new Map(checksums)
  const additions = plan === adminExperiencePlan ? new Map(adminExperienceMigrations) : new Map([[plan, reviewed.get(plan)]])
  for (const [name, hash] of additions) {
    if (checksums.find(([key]) => key === name)?.[1] !== hash) throw Error('Approved migration files are missing or changed')
    if (phase === 'before') expected.delete(name)
  }
  if (rows.length !== expected.size) throw Error('Unexpected pending, duplicate or additional migration')
  if (phase === 'after') assertMigrationState(before, checksums, 'before', undefined, plan)
  const previous = new Map((before ?? []).map(row => [row.migration_name, row]))
  for (const row of rows) {
    if (!expected.has(row.migration_name) || !/^[a-f0-9]{64}$/.test(row.checksum)
      || !row.finished_at || row.rolled_back_at || !Number.isInteger(row.applied_steps_count) || row.applied_steps_count < 1) throw Error('Migration history is not fully verified')
    if (plan === adminExperiencePlan && !/^[a-f0-9]{32}$/.test(row.historyHash)) throw Error('Migration history fingerprint missing')
    if (phase === 'after') {
      if (additions.has(row.migration_name)) {
        if (row.checksum !== additions.get(row.migration_name)) throw Error('New migration checksum mismatch')
      } else {
        const old = previous.get(row.migration_name)
        if (!old || row.checksum !== old.checksum || new Date(row.finished_at).toISOString() !== new Date(old.finished_at).toISOString()
          || row.applied_steps_count !== old.applied_steps_count
          || (plan === adminExperiencePlan && row.historyHash !== old.historyHash)) throw Error('Historical migration changed during deployment')
      }
    }
    expected.delete(row.migration_name)
  }
  if (expected.size) throw Error('Historical migration is pending')
}

/** Only a digest of an existing row enters evidence, never its credential. */
export function fetchSeedEvidence(row) {
  return row ? { hash: digest(JSON.stringify(row)), disabledSeed: row.id === 'tool-web-fetch' && row.key === 'tool:web-fetch'
    && row.ownerUserId === null && row.provider === 'unconfigured' && row.modelName === 'unconfigured'
    && row.baseUrl === null && row.apiKeyCiphertext === null && row.tier === 'tool_fetch'
    && row.enabled === false && row.selectable === false && row.isDefault === false
    && row.multiplierBps === 10000 && row.metadata?.modelKind === 'web_fetch' } : null
}
export function assertFetchSeed(after, before) {
  if (!after || (before ? after.hash !== before.hash : !after.disabledSeed)) throw Error('Fetch seed changed existing configuration or is not disabled/keyless')
}

/** Protected catalog hashes are computed inside PostgreSQL; no secret columns leave the DB. */
export function assertWebToolBillingState(after, before) {
  const keys = ['tool:web-fetch', 'tool:web-search']
  if (JSON.stringify(before.targets.map(row => row.key)) !== JSON.stringify(keys)
    || JSON.stringify(after.targets.map(row => row.key)) !== JSON.stringify(keys)
    || JSON.stringify(after.others) !== JSON.stringify(before.others)
    || after.calls !== 0 || after.audit.length !== keys.length) throw Error('Web tool migration scope mismatch')
  for (const row of after.targets) {
    const original = before.targets.find(item => item.key === row.key)
    const audit = after.audit.find(item => item.key === row.key)
    if (!/^[a-f0-9]{32}$/.test(row.protectedHash) || row.protectedHash !== original.protectedHash || row.multiplierBps !== 10000
      || !audit || audit.previousMultiplier !== original.multiplierBps
      || new Date(audit.previousUpdatedAt).toISOString() !== new Date(original.updatedAt).toISOString()
      || new Date(row.updatedAt).toISOString() !== new Date(audit.appliedAt).toISOString()) throw Error('Web tool price or protected configuration changed')
  }
}

const lifecycleTables = ['admin_model_diagnostics', 'ai_model_config_versions', 'ai_model_system_bindings']
const lifecycleRoles = ['basic', 'speed', 'tool:image-generation', 'tool:image-vision', 'tool:web-fetch', 'tool:web-search']
// pg_catalog format_type/default expressions for exactly the reviewed SQL, including nullable additions.
export const lifecycleColumns = [
  ['ai_model_configs', [['revision', 'integer', true, '1'], ['archived_at', 'timestamp(3) without time zone'], ['archived_by_id', 'character varying(64)'], ['archive_reason', 'character varying(1000)']]],
  ['agent_runs', [['model_config_id', 'character varying(64)'], ['model_config_revision', 'integer'], ['model_price_snapshot', 'jsonb']]],
  ['agent_schedules', [['model_config_id', 'character varying(64)']]],
  ['web_tool_calls', [['model_config_id', 'character varying(64)'], ['model_config_revision', 'integer']]],
  ['ai_model_system_bindings', [['role_key', 'character varying(96)', true], ['model_config_id', 'character varying(64)', true], ['revision', 'integer', true, '1'], ['updated_at', 'timestamp(3) without time zone', true, 'CURRENT_TIMESTAMP']]],
  ['admin_model_diagnostics', [['id', 'character varying(64)', true], ['admin_id', 'character varying(64)', true], ['model_config_id', 'character varying(64)', true], ['config_revision', 'character varying(96)', true], ['request_key', 'character varying(100)', true], ['mode', 'character varying(24)', true], ['status', 'character varying(24)', true], ['fee_identity', 'character varying(128)', true], ['fee_owner', 'character varying(24)', true, "'platform'::character varying"], ['fee_status', 'character varying(24)', true, "'not_requested'::character varying"], ['result', 'jsonb', true], ['created_at', 'timestamp(3) without time zone', true, 'CURRENT_TIMESTAMP'], ['updated_at', 'timestamp(3) without time zone', true, 'CURRENT_TIMESTAMP']]],
  ['ai_model_config_versions', [['model_config_id', 'character varying(64)', true], ['revision', 'integer', true], ['tier', 'character varying(24)'], ['provider', 'character varying(40)', true], ['model_name', 'character varying(160)', true], ['base_url', 'character varying(512)'], ['api_key_ciphertext', 'text'], ['multiplier_bps', 'integer', true], ['metadata', 'jsonb'], ['created_at', 'timestamp(3) without time zone', true, 'CURRENT_TIMESTAMP']]],
].flatMap(([table, columns]) => columns.map(([name, type, required = false, defaultValue = null]) => ({ table, name, type, required, defaultValue })))
export const lifecycleIndexes = [
  ['ai_model_system_bindings_pkey', 'ai_model_system_bindings', true, ['role_key']],
  ['ai_model_system_bindings_model_config_id_idx', 'ai_model_system_bindings', false, ['model_config_id']],
  ['admin_model_diagnostics_pkey', 'admin_model_diagnostics', true, ['id']],
  ['admin_model_diagnostics_fee_identity_key', 'admin_model_diagnostics', true, ['fee_identity']],
  ['admin_model_diagnostics_admin_id_request_key_key', 'admin_model_diagnostics', true, ['admin_id', 'request_key']],
  ['admin_model_diagnostics_model_config_id_created_at_idx', 'admin_model_diagnostics', false, ['model_config_id', 'created_at']],
  ['admin_model_diagnostics_admin_id_created_at_idx', 'admin_model_diagnostics', false, ['admin_id', 'created_at']],
  ['ai_model_config_versions_pkey', 'ai_model_config_versions', true, ['model_config_id', 'revision']],
].map(([name, table, unique, columns]) => ({ name, table, unique, columns, valid: true, ready: true, partial: false, expression: false }))
const ordered = rows => [...rows].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
function sameRows(actual, expected) { return JSON.stringify(ordered(actual)) === JSON.stringify(ordered(expected)) }
export function assertAdminModelLifecycleState(state, phase, before) {
  if (!['before', 'after'].includes(phase)) throw Error('Invalid lifecycle phase')
  if (!/^[a-f0-9]{32}$/.test(state.catalog.hash) || !Number.isInteger(state.catalog.count)
    || !sameRows(state.roles.map(row => row.role), lifecycleRoles)
    || new Set(state.roles.map(row => row.id)).size !== 6 || state.roles.some(row => typeof row.id !== 'string' || !row.id)) throw Error('Lifecycle role baseline mismatch')
  if (phase === 'before') {
    if (state.tables.length || state.columns.length) throw Error('Lifecycle objects already exist')
    return
  }
  assertAdminModelLifecycleState(before, 'before')
  if (!sameRows(state.tables, lifecycleTables) || !sameRows(state.columns, lifecycleColumns)
    || !sameRows(state.indexes, lifecycleIndexes)
    || !sameRows(state.foreignKeys, ['ai_model_config_versions', 'ai_model_system_bindings'].map(table => ({ table,
      columns: ['model_config_id'], target: 'ai_model_configs', targetColumns: ['id'], onDelete: 'a', onUpdate: 'a', valid: true })))
    || !sameRows(state.roles, before.roles) || JSON.stringify(state.catalog) !== JSON.stringify(before.catalog)
    || !sameRows(state.bindings.map(({ role, id, revision, hasUpdatedAt }) => ({ role, id, revision, hasUpdatedAt })),
      before.roles.map(row => ({ ...row, revision: 1, hasUpdatedAt: true })))
    || Object.values(state.invalid).some(value => value !== 0)) throw Error('Lifecycle migration objects, bindings or protected configuration mismatch')
}

/** Read-only catalog inspection; credentials are hashed in PostgreSQL and never selected. */
export async function readAdminModelLifecycleState(tx, phase) {
  const tableList = lifecycleTables.map(name => `'${name}'`).join(',')
  const pairs = lifecycleColumns.map(({ table, name }) => `('${table}','${name}')`).join(',')
  const tableRows = await tx.$queryRawUnsafe(`SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=current_schema() AND c.relname IN (${tableList}) AND c.relkind='r' ORDER BY c.relname`)
  const columns = await tx.$queryRawUnsafe(`SELECT c.relname AS table, a.attname AS name, format_type(a.atttypid,a.atttypmod) AS type,
    a.attnotnull AS required, pg_get_expr(d.adbin,d.adrelid) AS "defaultValue"
    FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE n.nspname=current_schema() AND a.attnum>0 AND NOT a.attisdropped
      AND (c.relname IN (${tableList}) OR (c.relname,a.attname) IN (${pairs})) ORDER BY c.relname,a.attnum`)
  const roles = await tx.$queryRawUnsafe(`SELECT CASE WHEN tier IN ('speed','basic') THEN tier ELSE key END AS role, id
    FROM ai_model_configs WHERE owner_user_id IS NULL
      AND key IN ('builtin:speed','builtin:basic','tool:image-generation','tool:image-vision','tool:web-search','tool:web-fetch') ORDER BY role`)
  const [catalog] = await tx.$queryRawUnsafe(`SELECT count(*)::int AS count,
    md5(coalesce(string_agg(md5((to_jsonb(c) - 'revision' - 'archived_at' - 'archived_by_id' - 'archive_reason')::text), '' ORDER BY c.id), '')) AS hash
    FROM ai_model_configs c`)
  const state = { tables: tableRows.map(row => row.name), columns, roles, catalog }
  if (phase === 'before') return state
  const indexes = await tx.$queryRawUnsafe(`SELECT c.relname AS name, t.relname AS table, i.indisunique AS unique,
    ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(num,ord)
      JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.num ORDER BY k.ord) AS columns,
    i.indisvalid AS valid, i.indisready AS ready, i.indpred IS NOT NULL AS partial, i.indexprs IS NOT NULL AS expression
    FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_class t ON t.oid=i.indrelid JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE n.nspname=current_schema() AND t.relname IN (${tableList}) ORDER BY c.relname`)
  const foreignKeys = await tx.$queryRawUnsafe(`SELECT t.relname AS table,
    ARRAY(SELECT a.attname::text FROM unnest(k.conkey) WITH ORDINALITY x(num,ord)
      JOIN pg_attribute a ON a.attrelid=k.conrelid AND a.attnum=x.num ORDER BY x.ord) AS columns,
    r.relname AS target, ARRAY(SELECT a.attname::text FROM unnest(k.confkey) WITH ORDINALITY x(num,ord)
      JOIN pg_attribute a ON a.attrelid=k.confrelid AND a.attnum=x.num ORDER BY x.ord) AS "targetColumns",
    k.confdeltype::text AS "onDelete", k.confupdtype::text AS "onUpdate", k.convalidated AS valid
    FROM pg_constraint k JOIN pg_class t ON t.oid=k.conrelid JOIN pg_class r ON r.oid=k.confrelid JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE n.nspname=current_schema() AND k.contype='f' AND t.relname IN (${tableList}) ORDER BY t.relname`)
  const bindings = await tx.$queryRawUnsafe('SELECT role_key AS role, model_config_id AS id, revision, updated_at IS NOT NULL AS "hasUpdatedAt" FROM ai_model_system_bindings ORDER BY role_key')
  // Only the new fields are inspected. No author, ledger or running-task snapshot is taken.
  const [invalid] = await tx.$queryRawUnsafe(`SELECT
    (SELECT count(*)::int FROM ai_model_configs WHERE revision<>1 OR archived_at IS NOT NULL OR archived_by_id IS NOT NULL OR archive_reason IS NOT NULL) AS configs,
    (SELECT count(*)::int FROM agent_runs WHERE model_config_id IS NOT NULL OR model_config_revision IS NOT NULL OR model_price_snapshot IS NOT NULL) AS runs,
    (SELECT count(*)::int FROM agent_schedules WHERE model_config_id IS NOT NULL) AS schedules,
    (SELECT count(*)::int FROM web_tool_calls WHERE model_config_id IS NOT NULL OR model_config_revision IS NOT NULL) AS calls,
    (SELECT count(*)::int FROM admin_model_diagnostics) AS diagnostics,
    (SELECT count(*)::int FROM ai_model_config_versions) AS versions`)
  return { ...state, indexes, foreignKeys, bindings, invalid }
}

const adminExperienceTables = ['site_contents', 'site_content_versions', 'user_legal_consents', 'tester_entitlements',
  'app_releases', 'app_release_channels', 'app_release_operations', 'image_operations']
// Frozen from the four exact SQL files applied in an isolated PostgreSQL database.
export const adminExperienceCatalogHash = 'ea8e4194253f74a11c51ce775ab5633345fdc724be383ea3c2ba4123ecd2e61b'
export function adminExperienceCatalogDigest(state) {
  return digest(JSON.stringify(['tables', 'columns', 'indexes', 'constraints'].map(key => [key, state[key].map(row => JSON.stringify(row)).sort()])))
}
export function assertAdminExperienceState(state, phase, before) {
  if (!['before', 'after'].includes(phase)) throw Error('Invalid admin experience phase')
  const empty = { tables: [{ name: 'credit_accounts', kind: 'r' }], columns: [], indexes: [], constraints: [] }
  if (phase === 'before') {
    if (adminExperienceCatalogDigest(state) !== adminExperienceCatalogDigest(empty)) throw Error('Admin experience objects already exist or baseline is missing')
    return
  }
  assertAdminExperienceState(before, 'before')
  if (adminExperienceCatalogDigest(state) !== adminExperienceCatalogHash) throw Error('Admin experience catalog mismatch')
}

/** Catalog only: no user rows, balances, content, provider keys or policy snapshots. */
export async function readAdminExperienceState(tx) {
  const tableList = adminExperienceTables.map(name => `'${name}'`).join(',')
  const tables = await tx.$queryRawUnsafe(`SELECT c.relname AS name, c.relkind::text AS kind
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=current_schema() AND c.relname IN (${tableList}, 'credit_accounts') ORDER BY c.relname`)
  const columns = await tx.$queryRawUnsafe(`SELECT c.relname AS table, a.attname AS name, format_type(a.atttypid,a.atttypmod) AS type,
    a.attnotnull AS required, pg_get_expr(d.adbin,d.adrelid) AS "defaultValue"
    FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE n.nspname=current_schema() AND a.attnum>0 AND NOT a.attisdropped
      AND (c.relname IN (${tableList}) OR (c.relname='credit_accounts' AND a.attname='tester_topup_sequence')) ORDER BY c.relname,a.attnum`)
  const indexes = await tx.$queryRawUnsafe(`SELECT t.relname AS table, c.relname AS name, pg_get_indexdef(i.indexrelid) AS definition,
    i.indisvalid AS valid, i.indisready AS ready
    FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_class t ON t.oid=i.indrelid JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE n.nspname=current_schema() AND t.relname IN (${tableList}) ORDER BY t.relname,c.relname`)
  const constraints = await tx.$queryRawUnsafe(`SELECT t.relname AS table, k.conname AS name, k.contype::text AS kind,
    pg_get_constraintdef(k.oid) AS definition, k.convalidated AS valid
    FROM pg_constraint k JOIN pg_class t ON t.oid=k.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE n.nspname=current_schema() AND t.relname IN (${tableList}) ORDER BY t.relname,k.conname`)
  return { tables, columns, indexes, constraints }
}

export function assertMigrationEnvironment(environment, shared) {
  if (environment.APP_ENV !== 'production' || shared.APP_ENV !== 'production'
    || !shared.DATABASE_URL || environment.DATABASE_URL !== shared.DATABASE_URL) throw Error('Production migration environment mismatch')
  const url = new URL(shared.DATABASE_URL)
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || url.pathname.length < 2) throw Error('Invalid production database identity')
  return { database: decodeURIComponent(url.pathname.slice(1)), schema: url.searchParams.get('schema') || 'public' }
}

export function assertDatabaseIdentity(actual, expected) {
  if (actual.database !== expected.database || actual.schema !== expected.schema) throw Error('Production database identity mismatch')
}

export function assertFindingIndex(rows, phase) {
  const name = phase === 'before' ? oldIndex : newIndex
  const columns = ['report_id', 'source', 'signal', ...(phase === 'before' ? [] : ['start_offset', 'end_offset']), 'evidence_hash']
  if (rows.length !== 1 || rows[0].name !== name || rows[0].table_name !== 'quality_findings'
    || !rows[0].is_unique || !rows[0].is_valid || !rows[0].is_ready || rows[0].has_predicate || rows[0].has_expression
    || JSON.stringify(rows[0].columns) !== JSON.stringify(columns)) throw Error('Quality finding index mismatch')
}

async function main() {
  const [phase, candidate, baseline, receipt] = process.argv.slice(2)
  const plan = releaseMigrationPlan(candidate, baseline)
  if (phase === 'plan') { process.stdout.write(`${plan}\n`); return }
  if (!['before', 'after'].includes(phase) || !reviewed.has(plan) || !receipt) throw Error('No authorized migration verification')
  const sharedPath = '/opt/chevoink/shared/app.env'
  if (realpathSync(path.join(candidate, '.env')) !== sharedPath) throw Error('Shared production environment path mismatch')
  const { parse } = await import('dotenv')
  const expectedDatabase = assertMigrationEnvironment(process.env, parse(readFileSync(sharedPath)))
  const { PrismaClient } = await import('@prisma/client')
  const db = new PrismaClient()
  try {
    const evidence = await db.$transaction(async tx => {
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY')
      const [database] = await tx.$queryRawUnsafe('SELECT current_database() AS database, current_schema() AS schema')
      assertDatabaseIdentity(database, expectedDatabase)
      const rows = await tx.$queryRawUnsafe(`SELECT migration_name, checksum, finished_at, rolled_back_at, applied_steps_count
        ${plan === adminExperiencePlan ? ', md5(to_jsonb(m)::text) AS "historyHash"' : ''}
        FROM "_prisma_migrations" m ORDER BY migration_name`)
      const checksums = files(path.join(candidate, 'prisma/migrations')).filter(([name]) => name.endsWith('/migration.sql'))
        .map(([name, hash]) => [name.slice(0, -'/migration.sql'.length), hash])
      const before = phase === 'after' ? JSON.parse(readFileSync(path.join(candidate, '.release-migration-before.json'), 'utf8')) : null
      if (before && (before.migration !== plan || before.checksum !== reviewed.get(plan) || before.phase !== 'before')) throw Error('Migration preflight receipt mismatch')
      if (before) assertDatabaseIdentity(database, before.database)
      assertMigrationState(rows, checksums, phase, before?.migrations, plan)
      if (plan === adminExperiencePlan) {
        const catalog = await readAdminExperienceState(tx)
        assertAdminExperienceState(catalog, phase, before?.catalog)
        return { migration: plan, checksum: reviewed.get(plan), phase, checkedAt: new Date().toISOString(), database, migrations: rows, catalog }
      }
      if (plan === adminModelLifecycleMigrationName) {
        const lifecycle = await readAdminModelLifecycleState(tx, phase)
        assertAdminModelLifecycleState(lifecycle, phase, before?.lifecycle)
        return { migration: plan, checksum: reviewed.get(plan), phase, checkedAt: new Date().toISOString(), database, migrations: rows, lifecycle }
      }
      if (plan === fetchMigrationName) {
        const seed = fetchSeedEvidence(await tx.aiModelConfig.findUnique({ where: { key: 'tool:web-fetch' } }))
        if (phase === 'after') assertFetchSeed(seed, before.seed)
        return { migration: plan, checksum: reviewed.get(plan), phase, checkedAt: new Date().toISOString(), database, migrations: rows, seed }
      }
      if (plan === webToolBillingMigrationName) {
        const targets = await tx.$queryRawUnsafe(`SELECT c.key, c.multiplier_bps AS "multiplierBps", c.updated_at AS "updatedAt",
          md5((to_jsonb(c) - 'multiplier_bps' - 'updated_at')::text) AS "protectedHash"
          FROM ai_model_configs c WHERE c.owner_user_id IS NULL AND c.key IN ('tool:web-search','tool:web-fetch') ORDER BY c.key`)
        const [others] = await tx.$queryRawUnsafe(`SELECT count(*)::int AS count,
          md5(coalesce(string_agg(md5(to_jsonb(c)::text), '' ORDER BY c.id), '')) AS hash FROM ai_model_configs c
          WHERE NOT (c.owner_user_id IS NULL AND c.key IN ('tool:web-search','tool:web-fetch'))`)
        let catalog = { targets, others }
        if (phase === 'before') {
          const [tables] = await tx.$queryRawUnsafe("SELECT to_regclass('web_tool_calls')::text AS calls, to_regclass('web_tool_price_migration_20261020')::text AS audit")
          if (targets.length !== 2 || tables.calls || tables.audit) throw Error('Web tool migration baseline mismatch')
        } else {
          const audit = await tx.$queryRawUnsafe('SELECT key, previous_multiplier AS "previousMultiplier", previous_updated_at AS "previousUpdatedAt", applied_at AS "appliedAt" FROM web_tool_price_migration_20261020 ORDER BY key')
          const [count] = await tx.$queryRawUnsafe('SELECT count(*)::int AS calls FROM web_tool_calls')
          catalog = { ...catalog, audit, calls: count.calls }
          assertWebToolBillingState(catalog, before.catalog)
        }
        return { migration: plan, checksum: reviewed.get(plan), phase, checkedAt: new Date().toISOString(), database, migrations: rows, catalog }
      }
      const indexes = await tx.$queryRawUnsafe(`SELECT c.relname AS name, t.relname AS table_name, i.indisunique AS is_unique,
        i.indisvalid AS is_valid, i.indisready AS is_ready, i.indpred IS NOT NULL AS has_predicate, i.indexprs IS NOT NULL AS has_expression,
        ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
          JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum ORDER BY k.ord) AS columns
        FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_class t ON t.oid=i.indrelid
        JOIN pg_namespace n ON n.oid=t.relnamespace
        WHERE n.nspname=current_schema() AND c.relname IN ('${oldIndex}', '${newIndex}')`)
      assertFindingIndex(indexes, phase)
      return { migration: migrationName, checksum: migrationChecksum, phase, checkedAt: new Date().toISOString(), database, migrations: rows, indexes }
    })
    writeFileSync(receipt, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    process.stdout.write(`[chevoink] migration ${phase} verified\n`)
  } finally { await db.$disconnect() }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
