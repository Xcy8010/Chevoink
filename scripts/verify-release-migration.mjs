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
export const appReleaseRetentionMigrationName = '20261107010000_app_release_retention'
export const appReleaseRetentionMigrationChecksum = '04c0397ce2534083461e58030b7cb8c169ea3e215e2a3d83164481b2d759ccca'
const appReleaseRetentionCandidateSchema = '7873d4e27151613e878436c3323c13dbeff337411e1eb42c7b8b344dfd014c18'
export const announcementReadsMigrationName = '20261108120000_site_announcement_reads'
export const announcementReadsMigrationChecksum = '36096e6622d4f68947252897d15a4a91f5f3c07ffd14dcc0daa8315afdd3dd3c'
const announcementReadsCandidateSchema = '1e33e41db6208c87ff874b522328f301dfabfe3f4ecab0bbff115173e161c856'
const announcementReadsTable = 'site_announcement_reads'
export const userNotificationsMigrationName = '20261108140000_user_notifications'
export const userNotificationsMigrationChecksum = '312ba252d6159c02696f9b60d2eaa31a855f7fc53912479f0ebcaaf643a8f03a'
const userNotificationsCandidateSchema = '19f4edd40b6bc2fb8012a823f0f5581f92ca05258ab38ffb86ae682ef0d1833f'
const userNotificationsTable = 'user_notifications'
export const emailAccountMigrationName = '20261112090000_email_account_auth'
export const emailAccountMigrationChecksum = '07112bd97b8b5163f951d748df6d6681be343b9456866f2329235d9f07b48740'
const emailAccountCandidateSchema = '8d8b27d023654f0330e35f81a12ee1894f0017dce1f31d663a3fd93d77dc1ecc'
export const agentPersonalizationMigrationName = '20261114090000_agent_personalization'
export const agentPersonalizationMigrationChecksum = 'bfdb011141b5fd5a447e6e896aef12e48203b2d199d23ec390629480e1fe6892'
const agentPersonalizationCandidateSchema = 'b55c24ace244e9695ffa4d6733554fa16aa384907e8085766b12922ef12a8302'
export const personalizationRulesMigrationName = '20261114150000_personalization_memory_rules'
export const personalizationRulesMigrationChecksum = 'd41574f1cce335e0046ea6c18a59407a34523a409dd8c1689ceb65e6660f91ba'
const personalizationRulesCandidateSchema = 'fc3dfaaaf9c3d9bc4515e7ac380817bf87b6333a56e9945318393672f58c34d4'
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
reviewed.set(appReleaseRetentionMigrationName, appReleaseRetentionMigrationChecksum)
reviewed.set(announcementReadsMigrationName, announcementReadsMigrationChecksum)
reviewed.set(userNotificationsMigrationName, userNotificationsMigrationChecksum)
reviewed.set(emailAccountMigrationName, emailAccountMigrationChecksum)
reviewed.set(agentPersonalizationMigrationName, agentPersonalizationMigrationChecksum)
reviewed.set(personalizationRulesMigrationName, personalizationRulesMigrationChecksum)
const fullHistoryPlans = new Set([adminExperiencePlan, appReleaseRetentionMigrationName, announcementReadsMigrationName, userNotificationsMigrationName, emailAccountMigrationName, agentPersonalizationMigrationName, personalizationRulesMigrationName])
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
  const rulesTarget = `${personalizationRulesMigrationName}/migration.sql`
  if (digest(previous.replaceAll('\r\n', '\n')) === agentPersonalizationCandidateSchema
    && digest(next.replaceAll('\r\n', '\n')) === personalizationRulesCandidateSchema
    && !oldFiles.some(([name]) => name === rulesTarget)
    && JSON.stringify(currentFiles.filter(([name]) => name !== rulesTarget)) === JSON.stringify(oldFiles)
    && currentFiles.find(([name]) => name === rulesTarget)?.[1] === personalizationRulesMigrationChecksum) return personalizationRulesMigrationName
  const personalizationTarget = `${agentPersonalizationMigrationName}/migration.sql`
  if (digest(previous.replaceAll('\r\n', '\n')) === emailAccountCandidateSchema
    && digest(next.replaceAll('\r\n', '\n')) === agentPersonalizationCandidateSchema
    && !oldFiles.some(([name]) => name === personalizationTarget)
    && JSON.stringify(currentFiles.filter(([name]) => name !== personalizationTarget)) === JSON.stringify(oldFiles)
    && currentFiles.find(([name]) => name === personalizationTarget)?.[1] === agentPersonalizationMigrationChecksum) return agentPersonalizationMigrationName
  const emailTarget = `${emailAccountMigrationName}/migration.sql`
  if (digest(previous.replaceAll('\r\n', '\n')) === userNotificationsCandidateSchema
    && digest(next.replaceAll('\r\n', '\n')) === emailAccountCandidateSchema
    && !oldFiles.some(([name]) => name === emailTarget)
    && JSON.stringify(currentFiles.filter(([name]) => name !== emailTarget)) === JSON.stringify(oldFiles)
    && currentFiles.find(([name]) => name === emailTarget)?.[1] === emailAccountMigrationChecksum) return emailAccountMigrationName
  const notificationTarget = `${userNotificationsMigrationName}/migration.sql`
  if (digest(previous.replaceAll('\r\n', '\n')) === announcementReadsCandidateSchema
    && digest(next.replaceAll('\r\n', '\n')) === userNotificationsCandidateSchema
    && !oldFiles.some(([name]) => name === notificationTarget)
    && JSON.stringify(currentFiles.filter(([name]) => name !== notificationTarget)) === JSON.stringify(oldFiles)
    && currentFiles.find(([name]) => name === notificationTarget)?.[1] === userNotificationsMigrationChecksum) return userNotificationsMigrationName
  const announcementTarget = `${announcementReadsMigrationName}/migration.sql`
  if (digest(previous.replaceAll('\r\n', '\n')) === appReleaseRetentionCandidateSchema
    && digest(next.replaceAll('\r\n', '\n')) === announcementReadsCandidateSchema
    && !oldFiles.some(([name]) => name === announcementTarget)
    && JSON.stringify(currentFiles.filter(([name]) => name !== announcementTarget)) === JSON.stringify(oldFiles)
    && currentFiles.find(([name]) => name === announcementTarget)?.[1] === announcementReadsMigrationChecksum) return announcementReadsMigrationName
  const retentionTarget = `${appReleaseRetentionMigrationName}/migration.sql`
  if (digest(previous.replaceAll('\r\n', '\n')) === adminExperienceCandidateSchema
    && digest(next.replaceAll('\r\n', '\n')) === appReleaseRetentionCandidateSchema
    && !oldFiles.some(([name]) => name === retentionTarget)
    && JSON.stringify(currentFiles.filter(([name]) => name !== retentionTarget)) === JSON.stringify(oldFiles)
    && currentFiles.find(([name]) => name === retentionTarget)?.[1] === appReleaseRetentionMigrationChecksum) return appReleaseRetentionMigrationName
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
    if (fullHistoryPlans.has(plan) && !/^[a-f0-9]{32}$/.test(row.historyHash)) throw Error('Migration history fingerprint missing')
    if (phase === 'after') {
      if (additions.has(row.migration_name)) {
        if (row.checksum !== additions.get(row.migration_name)) throw Error('New migration checksum mismatch')
      } else {
        const old = previous.get(row.migration_name)
        if (!old || row.checksum !== old.checksum || new Date(row.finished_at).toISOString() !== new Date(old.finished_at).toISOString()
          || row.applied_steps_count !== old.applied_steps_count
          || (fullHistoryPlans.has(plan) && row.historyHash !== old.historyHash)) throw Error('Historical migration changed during deployment')
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

// Exact additive retention-claim DDL. No claim writer runs until the API restart.
export const retentionColumns = [
  ['release_id', 'character varying(64)', true], ['operation_id', 'character varying(36)', true],
  ['artifact_sha256', 'character varying(64)', true], ['quarantine_name', 'character varying(128)', true],
  ['trigger_operation_id', 'character varying(100)'], ['state', 'character varying(24)', true, "'pending'::character varying"],
  ['error_code', 'character varying(80)'], ['created_at', 'timestamp(3) without time zone', true, 'CURRENT_TIMESTAMP'],
  ['updated_at', 'timestamp(3) without time zone', true], ['completed_at', 'timestamp(3) without time zone'],
].map(([name, type, required = false, defaultValue = null]) => ({ name, type, required, defaultValue }))
export const retentionIndexes = [
  ['app_release_retirements_pkey', true, ['release_id']],
  ['app_release_retirements_operation_id_key', true, ['operation_id']],
  ['app_release_retirements_state_created_at_idx', false, ['state', 'created_at']],
].map(([name, unique, columns]) => ({ name, unique, columns, definition: `CREATE ${unique ? 'UNIQUE ' : ''}INDEX ${name} ON public.app_release_retirements USING btree (${columns.join(', ')})`, valid: true, ready: true, partial: false, expression: false }))
export const retentionConstraints = [
  { name: 'app_release_retirements_pkey', kind: 'p', definition: 'PRIMARY KEY (release_id)', valid: true },
  { name: 'app_release_retirements_release_id_fkey', kind: 'f', definition: 'FOREIGN KEY (release_id) REFERENCES app_releases(id) ON UPDATE CASCADE ON DELETE RESTRICT', valid: true },
]
const retentionState = { tables: [{ name: 'app_release_retirements', kind: 'r' }], columns: retentionColumns,
  indexes: retentionIndexes, constraints: retentionConstraints, rowCount: 0 }
const announcementReadsState = {
  tables: [{ name: announcementReadsTable, kind: 'r' }],
  columns: ['user_id', 'version_id'].map(name => ({ name, type: 'character varying(64)', required: true, defaultValue: null })),
  indexes: [
    ['site_announcement_reads_pkey', true, ['user_id', 'version_id']],
    ['site_announcement_reads_version_id_idx', false, ['version_id']],
  ].map(([name, unique, columns]) => ({
    name, unique, columns, definition: `CREATE ${unique ? 'UNIQUE ' : ''}INDEX ${name} ON public.site_announcement_reads USING btree (${columns.join(', ')})`,
    valid: true, ready: true, partial: false, expression: false,
  })),
  constraints: [
    { name: 'site_announcement_reads_pkey', kind: 'p', definition: 'PRIMARY KEY (user_id, version_id)', valid: true },
    { name: 'site_announcement_reads_user_id_fkey', kind: 'f', definition: 'FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE', valid: true },
    { name: 'site_announcement_reads_version_id_fkey', kind: 'f', definition: 'FOREIGN KEY (version_id) REFERENCES site_content_versions(id) ON UPDATE CASCADE ON DELETE CASCADE', valid: true },
  ],
  rowCount: 0,
}
const userNotificationsState = {
  tables: [{ name: userNotificationsTable, kind: 'r' }],
  columns: [
    ['id', 'character varying(64)'],
    ['user_id', 'character varying(64)'],
    ['title', 'character varying(160)'],
    ['body', 'text'],
    ['created_at', 'timestamp(3) without time zone', true, 'CURRENT_TIMESTAMP'],
    ['read_at', 'timestamp(3) without time zone', false],
  ].map(([name, type, required = true, defaultValue = null]) => ({ name, type, required, defaultValue })),
  indexes: [
    ['user_notifications_pkey', true, ['id']],
    ['user_notifications_user_id_created_at_idx', false, ['user_id', 'created_at']],
  ].map(([name, unique, columns]) => ({
    name, unique, columns, definition: `CREATE ${unique ? 'UNIQUE ' : ''}INDEX ${name} ON public.user_notifications USING btree (${columns.join(', ')})`,
    valid: true, ready: true, partial: false, expression: false,
  })),
  constraints: [
    { name: 'user_notifications_pkey', kind: 'p', definition: 'PRIMARY KEY (id)', valid: true },
    { name: 'user_notifications_user_id_fkey', kind: 'f', definition: 'FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE', valid: true },
  ],
  rowCount: 0,
}
function assertAddedTableState(state, phase, before, expected, label) {
  if (!['before', 'after'].includes(phase)) throw Error(`Invalid ${label.toLowerCase()} phase`)
  if (phase === 'before') {
    if (state.tables.length || state.columns.length || state.indexes.length || state.constraints.length || state.rowCount !== null) throw Error(`${label} objects already exist`)
    return
  }
  assertAddedTableState(before, 'before', undefined, expected, label)
  // PostgreSQL/Prisma object key insertion order is not DDL. Preserve every
  // field and value, index-column array order and duplicate catalog rows.
  const catalogRows = rows => rows.map(row => JSON.stringify(Object.fromEntries(Object.entries(row).sort(([left], [right]) => left.localeCompare(right))))).sort()
  const differences = {}
  for (const key of ['tables', 'columns', 'indexes', 'constraints']) {
    if (JSON.stringify(catalogRows(state[key])) !== JSON.stringify(catalogRows(expected[key]))) differences[key] = { actual: state[key], expected: expected[key] }
  }
  if (state.rowCount !== 0) differences.rowCount = { actual: state.rowCount, expected: 0 }
  // Only this new table's catalog definitions and count appear in diagnostics;
  // no claim rows, users, content, environment or connection strings are read.
  if (Object.keys(differences).length) throw Error(`${label} migration catalog or initial rows mismatch: ` + JSON.stringify(differences))
}
export function assertAppReleaseRetentionState(state, phase, before) {
  assertAddedTableState(state, phase, before, retentionState, 'Retention')
}
export function assertAnnouncementReadsState(state, phase, before) {
  assertAddedTableState(state, phase, before, announcementReadsState, 'Announcement reads')
}

export function assertUserNotificationsState(state, phase, before) {
  assertAddedTableState(state, phase, before, userNotificationsState, 'User notifications')
}

/** Only PostgreSQL metadata and a count of the new table are read.
 * table comes exclusively from the fixed, reviewed call sites below. */
async function readAddedTableState(tx, phase, table) {
  const tables = await tx.$queryRawUnsafe(`SELECT c.relname AS name, c.relkind::text AS kind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=current_schema() AND c.relname='${table}' ORDER BY c.relname`)
  const columns = await tx.$queryRawUnsafe(`SELECT a.attname AS name, format_type(a.atttypid,a.atttypmod) AS type,
    a.attnotnull AS required, pg_get_expr(d.adbin,d.adrelid) AS "defaultValue"
    FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE n.nspname=current_schema() AND c.relname='${table}' AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`)
  const indexes = await tx.$queryRawUnsafe(`SELECT c.relname AS name, i.indisunique AS unique, pg_get_indexdef(i.indexrelid) AS definition,
    ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(num,ord)
      JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.num ORDER BY k.ord) AS columns,
    i.indisvalid AS valid, i.indisready AS ready, i.indpred IS NOT NULL AS partial, i.indexprs IS NOT NULL AS expression
    FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_class t ON t.oid=i.indrelid JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE n.nspname=current_schema() AND t.relname='${table}' ORDER BY c.relname`)
  const constraints = await tx.$queryRawUnsafe(`SELECT k.conname AS name, k.contype::text AS kind, pg_get_constraintdef(k.oid) AS definition, k.convalidated AS valid
    FROM pg_constraint k JOIN pg_class t ON t.oid=k.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE n.nspname=current_schema() AND t.relname='${table}' ORDER BY k.conname`)
  const rowCount = phase === 'after' ? (await tx.$queryRawUnsafe(`SELECT count(*)::int AS count FROM ${table}`))[0].count : null
  return { tables, columns, indexes, constraints, rowCount }
}
export function readAppReleaseRetentionState(tx, phase) {
  return readAddedTableState(tx, phase, 'app_release_retirements')
}
export function readAnnouncementReadsState(tx, phase) {
  return readAddedTableState(tx, phase, announcementReadsTable)
}

export function readUserNotificationsState(tx, phase) {
  return readAddedTableState(tx, phase, userNotificationsTable)
}

const personalizationTable = 'agent_personalizations'
const memoriesTable = 'agent_personalization_memories'
const personalizationEnums = [
  { name: 'AgentPersonalizationDegree', labels: ['less', 'default', 'more'] },
  { name: 'AgentPersonalizationMemorySource', labels: ['manual', 'conversation'] },
  { name: 'AgentPersonalizationStyle', labels: ['natural', 'professional', 'direct', 'partner'] },
]
const personalizationTimestamp = 'timestamp(3) without time zone'
const personalizationDegree = '"AgentPersonalizationDegree"'

function addedPersonalizationTable(table, columnSpecs, indexSpecs, primaryKey, foreignTable, foreignKey) {
  return {
    tables: [{ name: table, kind: 'r' }],
    columns: columnSpecs.map(([name, type, required = true, defaultValue = null]) => ({ name, type, required, defaultValue })),
    indexes: indexSpecs.map(([suffix, unique, columns, indexColumns = columns]) => ({
      name: `${table}_${suffix}`, unique, columns,
      definition: `CREATE ${unique ? 'UNIQUE ' : ''}INDEX ${table}_${suffix} ON public.${table} USING btree (${indexColumns.join(', ')})`,
      valid: true, ready: true, partial: false, expression: false,
    })),
    constraints: [
      { name: `${table}_pkey`, kind: 'p', definition: `PRIMARY KEY (${primaryKey})`, valid: true },
      { name: `${table}_user_id_fkey`, kind: 'f',
        definition: `FOREIGN KEY (user_id) REFERENCES ${foreignTable}(${foreignKey}) ON UPDATE CASCADE ON DELETE CASCADE`, valid: true },
    ],
    rowCount: 0,
  }
}

const personalizationState = addedPersonalizationTable(personalizationTable, [
  ['user_id', 'character varying(64)'],
  ['revision', 'integer', true, '0'],
  ['memory_revision', 'integer', true, '0'],
  ['memory_epoch', 'integer', true, '0'],
  ['memory_epoch_changed_at', personalizationTimestamp, false],
  ['memory_enabled', 'boolean', true, 'true'],
  ['preferred_name', 'character varying(80)', true, "''::character varying"],
  ['about_me', 'character varying(2000)', true, "''::character varying"],
  ['custom_instructions', 'character varying(2000)', true, "''::character varying"],
  ['style', '"AgentPersonalizationStyle"', true, `'natural'::"AgentPersonalizationStyle"`],
  ...['warmth', 'enthusiasm', 'detail', 'format'].map(name => [name, personalizationDegree, true, `'default'::${personalizationDegree}`]),
  ['emoji', personalizationDegree, true, `'less'::${personalizationDegree}`],
], [['pkey', true, ['user_id']]], 'user_id', 'users', 'id')

const memoriesState = addedPersonalizationTable(memoriesTable, [
  ['id', 'character varying(64)'],
  ['user_id', 'character varying(64)'],
  ['text', 'character varying(500)'],
  ['text_digest', 'character varying(64)'],
  ['source', '"AgentPersonalizationMemorySource"'],
  ['revision', 'integer', true, '1'],
  ['created_at', personalizationTimestamp, true, 'CURRENT_TIMESTAMP'],
  ['updated_at', personalizationTimestamp],
], [
  ['pkey', true, ['id']],
  ['user_id_text_digest_key', true, ['user_id', 'text_digest']],
  ['user_id_updated_at_id_idx', false, ['user_id', 'updated_at', 'id'], ['user_id', 'updated_at DESC', 'id DESC']],
], 'id', personalizationTable, 'user_id')

export function assertAgentPersonalizationState(state, phase, before) {
  assertAddedTableState(state.profiles, phase, before?.profiles, personalizationState, 'Agent personalization profiles')
  assertAddedTableState(state.memories, phase, before?.memories, memoriesState, 'Agent personalization memories')
  const expectedEnums = phase === 'after' ? personalizationEnums : []
  if (!sameRows(state.enums.map(({ name, labels }) => [name, labels]), expectedEnums.map(({ name, labels }) => [name, labels]))
    || (phase === 'after' && before.enums.length)) throw Error('Agent personalization enum catalog mismatch')
}

export async function readAgentPersonalizationState(tx, phase, schema = 'public') {
  // This optional isolated-test schema is an identifier, never SQL input.
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(schema)) throw Error('Unexpected personalization schema')
  const [profiles, memories, enums] = await Promise.all([
    readAddedTableState(tx, phase, personalizationTable),
    readAddedTableState(tx, phase, memoriesTable),
    tx.$queryRaw`SELECT t.typname AS name, array_agg(e.enumlabel::text ORDER BY e.enumsortorder) AS labels
      FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace LEFT JOIN pg_enum e ON e.enumtypid=t.oid
      WHERE n.nspname=current_schema() AND t.typname IN ('AgentPersonalizationDegree','AgentPersonalizationMemorySource','AgentPersonalizationStyle')
      GROUP BY t.typname ORDER BY t.typname`,
  ])
  if (schema !== 'public') {
    const indexSchema = ` ON ${schema}.`
    const normalizeIndexSchema = table => ({ ...table,
      indexes: table.indexes.map(index => ({ ...index, definition: index.definition.replace(indexSchema, ' ON public.') })) })
    return { profiles: normalizeIndexSchema(profiles), memories: normalizeIndexSchema(memories), enums }
  }
  return { profiles, memories, enums }
}

const smsPurposeBefore = ['login', 'register', 'reset_password', 'admin_login', 'admin_bind']
const emailPurposeAfter = ['register', 'login', 'bind', 'reset_password', 'change_password']
const verificationStates = ['pending', 'accepted', 'rejected', 'unknown', 'suppressed']
const emailUserColumns = [
  ['email_verified_at', 'timestamp(3) without time zone'],
  ['phone_verified_at', 'timestamp(3) without time zone'],
  ['account_setup_step', 'integer'],
  ['account_setup_skipped_steps', 'integer[]', true, 'ARRAY[]::integer[]'],
  ['account_setup_finished_at', 'timestamp(3) without time zone'],
]
const smsStateColumn = ['send_state', '"AccountVerificationSendState"']
const emailCodeTable = 'email_verification_codes'
const emailCodeCatalog = {
  tables: [{ name: emailCodeTable, kind: 'r' }],
  columns: [
    ['id', 'character varying(64)'], ['email', 'character varying(255)'],
    ['purpose', '"EmailVerificationPurpose"'], ['user_id', 'character varying(64)', false],
    ['requester_key', 'character varying(64)'], ['code_hash', 'character varying(64)'],
    ['expires_at', 'timestamp(3) without time zone'], ['consumed_at', 'timestamp(3) without time zone', false],
    ['attempts', 'integer', true, '0'], ['send_state', '"AccountVerificationSendState"', true, "'pending'::\"AccountVerificationSendState\""],
    ['provider_request_id', 'character varying(128)', false],
    ['created_at', 'timestamp(3) without time zone', true, 'CURRENT_TIMESTAMP'],
  ].map(([name, type, required = true, defaultValue = null]) => ({ name, type, required, defaultValue })),
  indexes: [
    ['pkey', true, ['id']], ['email_created_at_idx', false, ['email', 'created_at']],
    ['requester_key_created_at_idx', false, ['requester_key', 'created_at']],
    ['expires_at_idx', false, ['expires_at']], ['user_id_idx', false, ['user_id']],
  ].map(([suffix, unique, columns]) => ({
    name: `${emailCodeTable}_${suffix}`, unique, columns,
    definition: `CREATE ${unique ? 'UNIQUE ' : ''}INDEX ${emailCodeTable}_${suffix} ON public.${emailCodeTable} USING btree (${columns.join(', ')})`,
    valid: true, ready: true, partial: false, expression: false,
  })),
  constraints: [
    { name: 'email_verification_codes_pkey', kind: 'p', definition: 'PRIMARY KEY (id)', valid: true },
    { name: 'email_verification_codes_user_id_fkey', kind: 'f', definition: 'FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE', valid: true },
  ],
  rowCount: 0,
}
const emailIndexName = 'users_verified_email_ci_key'
const setupConstraintName = 'users_account_setup_step_check'
const columnTuples = columns => columns.map(({ name, type, required, defaultValue }) => [name, type, required, defaultValue])
const expectedColumns = tuples => tuples.map(([name, type, required = false, defaultValue = null]) => [name, type, required, defaultValue])
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right)

export function assertEmailAccountCatalog(state, phase, before) {
  if (!['before', 'after'].includes(phase)) throw Error('Invalid email account migration phase')
  const after = phase === 'after'
  const { codeTable, userColumns, smsColumns, emailIndexes, setupConstraints, enumLabels } = state
  if (after) assertEmailAccountCatalog(before, 'before')
  assertAddedTableState({ ...codeTable, rowCount: after ? 0 : null }, phase, before?.codeTable, emailCodeCatalog, 'Email verification')
  if (!same(columnTuples(userColumns), expectedColumns(after ? emailUserColumns : []))
    || !same(columnTuples(smsColumns), expectedColumns(after ? [smsStateColumn] : []))) {
    throw Error('Email account column catalog mismatch')
  }
  const labels = name => enumLabels.find(row => row.name === name)?.labels ?? null
  if (!same(labels('SmsVerificationPurpose'), after ? [...smsPurposeBefore, 'bind_phone', 'change_password'] : smsPurposeBefore)
    || !same(labels('EmailVerificationPurpose'), after ? emailPurposeAfter : null)
    || !same(labels('AccountVerificationSendState'), after ? verificationStates : null)
    || enumLabels.length !== (after ? 3 : 1)) throw Error('Email account enum catalog mismatch')
  if (!after) {
    if (emailIndexes.length || setupConstraints.length || codeTable.rowCount !== null) throw Error('Email account objects already exist')
    return
  }
  const [index] = emailIndexes, [constraint] = setupConstraints
  if (emailIndexes.length !== 1 || !index.valid || !index.ready || !index.unique || !index.expression || !index.partial
    || index.definition !== 'CREATE UNIQUE INDEX users_verified_email_ci_key ON public.users USING btree (lower((email)::text)) WHERE (email_verified_at IS NOT NULL)') {
    throw Error('Verified email index mismatch')
  }
  if (setupConstraints.length !== 1 || constraint.kind !== 'c' || !constraint.valid
    || constraint.definition.replace(/[()]/g, '').replace(/\s+/g, ' ').trim() !== 'CHECK account_setup_step >= 1 AND account_setup_step <= 3') {
    throw Error('Account setup constraint mismatch')
  }
}

export async function readEmailAccountCatalog(tx, phase) {
  const [codeTable, users, sms, enumLabels] = await Promise.all([
    readAddedTableState(tx, phase, emailCodeTable),
    readAddedTableState(tx, 'before', 'users'),
    readAddedTableState(tx, 'before', 'sms_verification_codes'),
    tx.$queryRaw`SELECT t.typname AS name, array_agg(e.enumlabel::text ORDER BY e.enumsortorder) AS labels
      FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace JOIN pg_enum e ON e.enumtypid=t.oid
      WHERE n.nspname=current_schema() AND t.typname IN ('SmsVerificationPurpose','EmailVerificationPurpose','AccountVerificationSendState')
      GROUP BY t.typname ORDER BY t.typname`,
  ])
  return { codeTable, enumLabels,
    userColumns: users.columns.filter(row => emailUserColumns.some(([name]) => name === row.name)),
    smsColumns: sms.columns.filter(row => row.name === smsStateColumn[0]),
    emailIndexes: users.indexes.filter(row => row.name === emailIndexName),
    setupConstraints: users.constraints.filter(row => row.name === setupConstraintName),
  }
}

async function readEmailAccountMigrationState(tx, phase, before) {
  const catalog = await readEmailAccountCatalog(tx, phase)
  assertEmailAccountCatalog(catalog, phase, before?.catalog)
  if (phase === 'before') {
    const [{ proofCutoff }] = await tx.$queryRaw`SELECT statement_timestamp() AS "proofCutoff"`
    return { catalog, proofCutoff, verification: null }
  }
  const proofCutoff = new Date(before.proofCutoff)
  if (!Number.isFinite(+proofCutoff)) throw Error('Missing email migration proof cutoff')
  const [verification] = await tx.$queryRaw`WITH evidence AS (
    SELECT u.id,
      max(c.consumed_at) FILTER (WHERE c.consumed_at <= ${proofCutoff}::timestamptz AT TIME ZONE 'UTC') AS latest_before,
      bool_or(c.consumed_at = u.phone_verified_at) AS matches_mark
    FROM users u JOIN sms_verification_codes c ON c.phone=u.phone
    WHERE c.consumed_at IS NOT NULL AND (
      (c.user_id=u.id AND c.purpose IN ('login','admin_login','reset_password')) OR
      (c.user_id IS NULL AND c.purpose='register' AND c.consumed_at BETWEEN u.created_at AND u.created_at + interval '5 seconds')
    ) GROUP BY u.id
  )
  SELECT count(*) FILTER (WHERE u.phone_verified_at IS NOT NULL)::int AS "verifiedPhones",
    count(*) FILTER (WHERE u.email_verified_at IS NOT NULL OR u.account_setup_step IS NOT NULL
      OR cardinality(u.account_setup_skipped_steps) <> 0 OR u.account_setup_finished_at IS NOT NULL)::int AS "legacyAccountChanges",
    count(*) FILTER (WHERE u.phone_verified_at IS NOT NULL AND NOT coalesce(evidence.matches_mark, false))::int AS "unprovenPhones",
    count(*) FILTER (WHERE evidence.latest_before IS NOT NULL AND
      (u.phone_verified_at IS NULL OR u.phone_verified_at < evidence.latest_before))::int AS "missingPhoneProofs",
    (SELECT count(*)::int FROM sms_verification_codes WHERE send_state IS NOT NULL) AS "legacySmsStateChanges"
  FROM users u LEFT JOIN evidence ON evidence.id=u.id`
  if (catalog.codeTable.rowCount !== 0 || verification.legacyAccountChanges !== 0 || verification.unprovenPhones !== 0
    || verification.missingPhoneProofs !== 0 || verification.legacySmsStateChanges !== 0) {
    throw Error('Email account migration initial state or phone evidence mismatch')
  }
  return { catalog, proofCutoff, verification }
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

export async function readPersonalizationRulesMigrationState(tx, phase) {
  const [catalog] = await tx.$queryRaw`
    SELECT
      to_regclass('agent_personalization_memory_hits') IS NOT NULL AS hits,
      EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'agent_personalizations'::regclass
        AND attname = 'tool_rules' AND atttypid = 'jsonb'::regtype AND attnotnull AND NOT attisdropped) AS rules,
      EXISTS (SELECT 1 FROM pg_index WHERE indrelid = 'agent_personalization_memories'::regclass
        AND indexrelid = to_regclass('agent_personalization_memories_user_id_active_slot_key')
        AND indisunique AND indisvalid AND indisready AND indpred IS NULL
        AND pg_get_indexdef(indexrelid) LIKE '%(user_id, active_slot)') AS slots,
      EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'agent_personalization_memories'::regclass
        AND conname = 'agent_personalization_memories_slot_state' AND convalidated) AS "slotState",
      EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'agent_personalization_memories'::regclass
        AND tgname = 'agent_personalization_fill_active_slot' AND tgenabled = 'O') AS trigger,
      EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'agent_personalizations'::regclass
        AND conname = 'agent_personalizations_legacy_fields_retired' AND convalidated) AS "legacyRetired"`
  const expected = phase === 'after'
  if (!catalog || Object.values(catalog).some(value => value !== expected)) throw Error('Personalization memory and rules catalog mismatch')
  if (!expected) return catalog
  const [invariants] = await tx.$queryRaw`
    SELECT
      EXISTS (SELECT 1 FROM agent_personalizations WHERE preferred_name <> '' OR about_me <> ''
        OR jsonb_typeof(tool_rules) <> 'array') AS "invalidProfiles",
      EXISTS (SELECT 1 FROM agent_personalization_memories
        WHERE active_slot IS NOT NULL GROUP BY user_id HAVING count(*) > 50) AS "excessActive"`
  if (!invariants || Object.values(invariants).some(Boolean)) throw Error('Personalization memory migration invariants failed')
  return { ...catalog, ...invariants }
}

async function main() {
  const [phase, candidate, baseline, receipt] = process.argv.slice(2)
  const plan = releaseMigrationPlan(candidate, baseline)
  if (phase === 'plan') { process.stdout.write(`${plan}\n`); return }
  if (!['before', 'after'].includes(phase) || !reviewed.has(plan) || !receipt) throw Error('No authorized migration verification')
  const sharedPath = '/opt/chevoink/shared/app.env'
  if (realpathSync(path.join(candidate, '.env')) !== sharedPath) throw Error('Shared production environment path mismatch')
  const { parse } = await import('dotenv')
  const shared = parse(readFileSync(sharedPath))
  const expectedDatabase = assertMigrationEnvironment(process.env, shared)
  const emailAuthOff = value => value == null || /^(?:false|0|off|no)?$/i.test(value.trim())
  if (plan === emailAccountMigrationName
    && (!emailAuthOff(shared.ACCOUNT_EMAIL_AUTH_ENABLED) || !emailAuthOff(process.env.ACCOUNT_EMAIL_AUTH_ENABLED))) {
    throw Error('The shared email auth switch must be off for this migration')
  }
  const { PrismaClient } = await import('@prisma/client')
  const db = new PrismaClient()
  try {
    const evidence = await db.$transaction(async tx => {
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY')
      const [database] = await tx.$queryRawUnsafe('SELECT current_database() AS database, current_schema() AS schema')
      assertDatabaseIdentity(database, expectedDatabase)
      const rows = await tx.$queryRawUnsafe(`SELECT migration_name, checksum, finished_at, rolled_back_at, applied_steps_count
        ${fullHistoryPlans.has(plan) ? ', md5(to_jsonb(m)::text) AS "historyHash"' : ''}
        FROM "_prisma_migrations" m ORDER BY migration_name`)
      const checksums = files(path.join(candidate, 'prisma/migrations')).filter(([name]) => name.endsWith('/migration.sql'))
        .map(([name, hash]) => [name.slice(0, -'/migration.sql'.length), hash])
      const before = phase === 'after' ? JSON.parse(readFileSync(path.join(candidate, '.release-migration-before.json'), 'utf8')) : null
      if (before && (before.migration !== plan || before.checksum !== reviewed.get(plan) || before.phase !== 'before')) throw Error('Migration preflight receipt mismatch')
      if (before) assertDatabaseIdentity(database, before.database)
      assertMigrationState(rows, checksums, phase, before?.migrations, plan)
      if (plan === personalizationRulesMigrationName) {
        const personalization = await readPersonalizationRulesMigrationState(tx, phase)
        return { migration: plan, checksum: reviewed.get(plan), phase, checkedAt: new Date().toISOString(), database, migrations: rows, personalization }
      }
      if (plan === agentPersonalizationMigrationName) {
        const personalization = await readAgentPersonalizationState(tx, phase)
        assertAgentPersonalizationState(personalization, phase, before?.personalization)
        return { migration: plan, checksum: reviewed.get(plan), phase, checkedAt: new Date().toISOString(), database, migrations: rows, personalization }
      }
      if (plan === emailAccountMigrationName) {
        const emailAccounts = await readEmailAccountMigrationState(tx, phase, before?.emailAccounts)
        return { migration: plan, checksum: reviewed.get(plan), phase, checkedAt: new Date().toISOString(), database, migrations: rows, emailAccounts }
      }
      if (plan === userNotificationsMigrationName) {
        const userNotifications = await readUserNotificationsState(tx, phase)
        assertUserNotificationsState(userNotifications, phase, before?.userNotifications)
        return { migration: plan, checksum: reviewed.get(plan), phase, checkedAt: new Date().toISOString(), database, migrations: rows, userNotifications }
      }
      if (plan === announcementReadsMigrationName) {
        const announcementReads = await readAnnouncementReadsState(tx, phase)
        assertAnnouncementReadsState(announcementReads, phase, before?.announcementReads)
        return { migration: plan, checksum: reviewed.get(plan), phase, checkedAt: new Date().toISOString(), database, migrations: rows, announcementReads }
      }
      if (plan === appReleaseRetentionMigrationName) {
        const retention = await readAppReleaseRetentionState(tx, phase)
        assertAppReleaseRetentionState(retention, phase, before?.retention)
        return { migration: plan, checksum: reviewed.get(plan), phase, checkedAt: new Date().toISOString(), database, migrations: rows, retention }
      }
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
