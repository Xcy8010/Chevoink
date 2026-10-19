import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertCloudRuntime, cloudNpmCommand } from './cloud-setup.mjs'
import { runCommand } from './workspace-sync.mjs'

export const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const json = file => JSON.parse(readFileSync(file, 'utf8'))
const npmEnvironmentKeys = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'HOME', 'USERPROFILE',
  'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE'])

/** No application imports, .env reads, Prisma imports, DB connections or installs. */
export async function checkOfflineReadiness({ root = workspaceRoot, command = runCommand, nodeVersion = process.versions.node,
  platform = process.platform, env = process.env, timeoutMs = 15000 } = {}) {
  const report = { code: false, runtime: false, dependencies: false, prisma: false, readyForLocalChecks: false,
    database: { configPresent: existsSync(path.join(root, 'tests/.env.test')) || env.APP_ENV === 'test' && Boolean(env.DATABASE_URL),
      verified: false, status: 'not_connected_or_verified', next: 'npm run test:db:verify (only after explicitly configuring an isolated test target)' },
    readyForDatabaseWork: false, problems: [] }
  let manifest, lock, pinnedNode
  try {
    manifest = json(path.join(root, 'package.json')); lock = json(path.join(root, 'package-lock.json'))
    pinnedNode = readFileSync(path.join(root, '.node-version'), 'utf8').trim()
    report.code = ['api/server.ts', 'prisma/schema.prisma', 'scripts/cloud-setup.mjs'].every(file => existsSync(path.join(root, file)))
    if (!report.code) report.problems.push('local_source_incomplete')
  } catch { report.problems.push('repository_metadata_missing_or_invalid'); return report }
  const npm = async args => {
    const invocation = cloudNpmCommand(args)
    return command(invocation.program, invocation.args, { cwd: root, shell: invocation.shell, timeoutMs,
      // npm only needs OS/runtime lookup, home and temporary paths. Do not pass
      // database/model credentials or arbitrary NODE_OPTIONS to metadata probes.
      env: { ...Object.fromEntries(Object.entries(env).filter(([key]) => npmEnvironmentKeys.has(key.toUpperCase()))),
        npm_config_offline: 'true', npm_config_ignore_scripts: 'true', npm_config_audit: 'false',
        npm_config_fund: 'false', npm_config_update_notifier: 'false' } })
  }
  try {
    const version = await npm(['--version'])
    if (version.code !== 0 || version.reason) throw new Error('npm_unavailable')
    const npmVersion = version.stdout.trim()
    assertCloudRuntime(nodeVersion, npmVersion, pinnedNode, manifest.engines)
    if (manifest.packageManager !== `npm@${npmVersion}` || lock.packages?.['']?.engines?.node !== pinnedNode
      || lock.packages?.['']?.engines?.npm !== npmVersion) throw new Error('lock_policy_mismatch')
    report.runtime = true
    report.versions = { node: nodeVersion, npm: npmVersion }
  } catch { report.problems.push('pinned_runtime_or_lock_policy_mismatch'); report.requiredRuntime = { node: pinnedNode, npm: manifest.engines?.npm } }
  try {
    // npm's installation lock binds the existing tree to this checkout's lock;
    // npm ls separately detects missing/broken installed dependency edges.
    const installed = json(path.join(root, 'node_modules/.package-lock.json')).packages
    const entries = Object.entries(lock.packages ?? {}).filter(([name]) => name.startsWith('node_modules/'))
    const matches = entries.length > 0 && entries.every(([name, expected]) => {
      const actual = installed?.[name]
      return actual ? ['version', 'integrity', 'link'].every(key => actual[key] === expected[key]) : expected.optional === true
    })
    if (!matches) throw new Error('installed_lock_mismatch')
    const listing = await npm(['ls', '--all', '--offline', '--ignore-scripts', '--json'])
    report.dependencies = listing.code === 0 && !listing.reason
    if (!report.dependencies) report.problems.push(listing.reason === 'timeout' ? 'dependency_check_timed_out' : 'installed_dependencies_incomplete')
  } catch { report.problems.push('installed_dependencies_or_lock_missing') }
  try {
    const generated = path.join(root, 'node_modules/.prisma/client')
    const normalize = bytes => bytes.replace(/\r\n/g, '\n')
    const sameSchema = normalize(readFileSync(path.join(root, 'prisma/schema.prisma'), 'utf8'))
      === normalize(readFileSync(path.join(generated, 'schema.prisma'), 'utf8'))
    const engine = platform === 'win32' ? /^query_engine-windows\.dll\.node$/ : platform === 'darwin'
      ? /^libquery_engine-darwin.*\.dylib\.node$/ : platform === 'linux' ? /^libquery_engine-.*\.so\.node$/ : /$a/
    const files = readdirSync(generated)
    const entriesPresent = ['index.js', 'index.d.ts', 'default.js'].every(file => files.includes(file))
    const enginePresent = files.some(file => engine.test(file))
    report.prisma = sameSchema && entriesPresent && enginePresent
    report.prismaEngineRuntimeVerified = false
    if (!sameSchema) report.problems.push('generated_prisma_schema_mismatch')
    if (!entriesPresent) report.problems.push('generated_prisma_entry_missing')
    if (!enginePresent) report.problems.push('generated_prisma_platform_engine_missing')
  } catch { report.problems.push('generated_prisma_client_missing') }
  report.readyForLocalChecks = report.code && report.runtime && report.dependencies && report.prisma
  return report
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) throw new Error('Usage: node scripts/offline-readiness.mjs')
  const result = await checkOfflineReadiness()
  console.log(JSON.stringify(result, null, 2))
  process.exitCode = result.readyForLocalChecks ? 0 : 1
}
